"""The AWS connector's runtime half: the role, the preflight and the region scan.

Every account id here is AWS's documentation placeholder, never a real account.
"""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from botocore.exceptions import ClientError

from reporting_agent.aws import inventory as inv
from reporting_agent.aws.inventory import AwsInventory, RegionScan, summarize
from reporting_agent.aws.preflight import (
    FIDELITY_BASELINE,
    FIDELITY_ENHANCED,
    AwsPreflight,
    denied_actions,
)
from reporting_agent.aws.session import (
    ROLE_NAME,
    ROLE_PATH,
    assume_reader_role,
    reader_policy,
    reader_role_arn,
    required_actions,
    validate_role_arn,
)
from reporting_agent.errors import AuthFailedError, ScopeUnverifiedError

ACCOUNT = "123456789012"
OTHER_ACCOUNT = "210987654321"
ROLE = f"arn:aws:iam::{ACCOUNT}:role/reporting-agent/ReportingAgentReader"
EXTERNAL_ID = "rpt-5c1e9b7a2f8d4c36a0e4b91d7f2a6c58"


def denied(operation: str, code: str = "AccessDenied", status: int = 403) -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "no"}, "ResponseMetadata": {"HTTPStatusCode": status}}, operation)


# --- the role ------------------------------------------------------------------


def test_the_role_arn_is_fixed_by_the_policy_file() -> None:
    assert (ROLE_PATH, ROLE_NAME) == ("/reporting-agent/", "ReportingAgentReader")
    assert reader_role_arn(ACCOUNT) == ROLE
    assert validate_role_arn(ROLE, ACCOUNT) == ROLE


@pytest.mark.parametrize(
    ("role_arn", "account_id"),
    [
        (f"arn:aws:iam::{ACCOUNT}:role/Admin", ACCOUNT),
        (f"arn:aws:iam::{ACCOUNT}:role/ReportingAgentReader", ACCOUNT),
        (ROLE, OTHER_ACCOUNT),
        (ROLE, "12345"),
        (None, ACCOUNT),
    ],
)
def test_any_other_role_is_refused_before_a_request(role_arn: object, account_id: str) -> None:
    with pytest.raises(AuthFailedError):
        validate_role_arn(role_arn, account_id)


def test_required_actions_split_into_account_wide_and_self_only() -> None:
    everything = required_actions()
    assert set(required_actions(self_only=False)) | set(required_actions(self_only=True)) == set(everything)
    assert required_actions(self_only=True) == ("iam:SimulatePrincipalPolicy",)
    assert len(everything) == len(set(everything))
    assert "cloudwatch:GetMetricData" in everything
    # Read-only by construction: no action in the grant can change anything.
    verbs = {action.split(":", 1)[1] for action in everything}
    assert all(verb.startswith(("Describe", "Get", "List", "Simulate")) for verb in verbs)


def test_the_policy_file_is_json_the_app_can_import() -> None:
    policy = reader_policy()
    json.dumps(policy)
    assert policy["max_session_seconds"] == 3600
    assert [statement["sid"] for statement in policy["statements"]] == [
        "Inventory",
        "Metrics",
        "BackupsAndRecommendations",
        "CheckOwnPermissions",
    ]


class FakeSts:
    def __init__(self, error: Exception | None = None) -> None:
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def assume_role(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return {
            "Credentials": {
                "AccessKeyId": "ASIAEXAMPLE",
                "SecretAccessKey": "secret",
                "SessionToken": "token",
                "Expiration": datetime.now(UTC) + timedelta(hours=1),
            }
        }


def test_the_role_is_assumed_once_with_the_external_id() -> None:
    sts = FakeSts()
    session = assume_reader_role(
        role_arn=ROLE, external_id=EXTERNAL_ID, account_id=ACCOUNT, actor_id="user/1", region="us-east-1", sts_client=sts
    )
    assert len(sts.calls) == 1
    call = sts.calls[0]
    assert call["ExternalId"] == EXTERNAL_ID
    assert call["DurationSeconds"] == 3600
    assert call["RoleSessionName"] == "reporting-agent-user-1"
    frozen = session.get_credentials().get_frozen_credentials()
    assert frozen.access_key == "ASIAEXAMPLE"
    assert session.region_name == "us-east-1"


def test_a_refused_assume_is_auth_failed_and_never_echoes_the_external_id() -> None:
    sts = FakeSts(error=denied("AssumeRole"))
    with pytest.raises(AuthFailedError) as caught:
        assume_reader_role(
            role_arn=ROLE, external_id=EXTERNAL_ID, account_id=ACCOUNT, actor_id="u", region="us-east-1", sts_client=sts
        )
    assert "AccessDenied" in str(caught.value)
    assert EXTERNAL_ID not in str(caught.value)


def test_a_missing_external_id_is_refused_without_a_request() -> None:
    sts = FakeSts()
    with pytest.raises(AuthFailedError):
        assume_reader_role(role_arn=ROLE, external_id=" ", account_id=ACCOUNT, actor_id="u", region="us-east-1", sts_client=sts)
    assert sts.calls == []


# --- the preflight -------------------------------------------------------------


def allowed(action: str) -> dict[str, Any]:
    return {"EvalActionName": action, "EvalDecision": "allowed"}


def test_denied_actions_reads_the_decision_and_the_organization() -> None:
    results = [
        allowed("ec2:DescribeInstances"),
        {"EvalActionName": "cloudwatch:GetMetricData", "EvalDecision": "implicitDeny"},
        {
            "EvalActionName": "rds:DescribeDBInstances",
            "EvalDecision": "allowed",
            "OrganizationsDecisionDetail": {"AllowedByOrganizations": False},
        },
    ]
    assert denied_actions(results) == ["cloudwatch:GetMetricData", "rds:DescribeDBInstances"]


class FakeIam:
    def __init__(self, deny: set[str] = frozenset(), error: Exception | None = None) -> None:
        self.deny = deny
        self.error = error
        self.calls: list[dict[str, Any]] = []

    def simulate_principal_policy(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return {
            "EvaluationResults": [
                {"EvalActionName": a, "EvalDecision": "implicitDeny" if a in self.deny else "allowed"}
                for a in kwargs["ActionNames"]
            ]
        }


class FakeRegional:
    """`describe_regions`, `get_caller_identity` and `list_metrics` in one fake."""

    def __init__(self, *, account: str = ACCOUNT, agent_regions: set[str] = frozenset(), region: str = "") -> None:
        self.account = account
        self.agent_regions = agent_regions
        self.region = region

    def get_caller_identity(self) -> dict[str, Any]:
        return {"Account": self.account}

    def describe_regions(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs == {"AllRegions": False}
        return {"Regions": [{"RegionName": "us-east-1"}, {"RegionName": "ap-southeast-3"}]}

    def list_metrics(self, **kwargs: Any) -> dict[str, Any]:
        assert kwargs["Namespace"] == "CWAgent"
        if self.region == "broken":
            raise denied("ListMetrics")
        return {"Metrics": [{"MetricName": "mem_used_percent"}] if self.region in self.agent_regions else []}


def preflight(iam: FakeIam, *, account: str = ACCOUNT, agent_regions: set[str] = frozenset()) -> AwsPreflight:
    def clients(service: str, region: str) -> Any:
        if service == "iam":
            return iam
        return FakeRegional(account=account, agent_regions=agent_regions, region=region)

    return AwsPreflight(clients=clients, account_id=ACCOUNT, role_arn=ROLE, home_region="us-east-1")


def test_a_full_grant_verifies_and_self_only_actions_are_simulated_on_the_role() -> None:
    iam = FakeIam()
    assert asyncio.run(preflight(iam).assert_account_read()) is True
    wide, own = iam.calls
    assert "ResourceArns" not in wide
    assert own["ResourceArns"] == [ROLE]
    assert own["ActionNames"] == ["iam:SimulatePrincipalPolicy"]
    assert set(wide["ActionNames"]) | set(own["ActionNames"]) == set(required_actions())


def test_a_role_in_another_account_is_refused() -> None:
    with pytest.raises(AuthFailedError, match=OTHER_ACCOUNT):
        asyncio.run(preflight(FakeIam(), account=OTHER_ACCOUNT).assert_account_read())


def test_a_missing_action_is_scope_unverified_and_named() -> None:
    iam = FakeIam(deny={"cloudwatch:GetMetricData", "rds:DescribeDBInstances"})
    with pytest.raises(ScopeUnverifiedError) as caught:
        asyncio.run(preflight(iam).assert_account_read())
    assert "cloudwatch:GetMetricData, rds:DescribeDBInstances" in str(caught.value)


def test_a_role_that_cannot_simulate_is_scope_unverified() -> None:
    with pytest.raises(ScopeUnverifiedError, match="CheckOwnPermissions"):
        asyncio.run(preflight(FakeIam(error=denied("SimulatePrincipalPolicy"))).assert_account_read())


def test_regions_are_sorted_and_fidelity_follows_the_agent_metric() -> None:
    check = preflight(FakeIam(), agent_regions={"ap-southeast-3"})
    regions = asyncio.run(check.enabled_regions())
    assert regions == ["ap-southeast-3", "us-east-1"]
    assert asyncio.run(check.probe_fidelity(regions)) == FIDELITY_ENHANCED
    assert asyncio.run(preflight(FakeIam()).probe_fidelity(regions)) == FIDELITY_BASELINE
    # A region that refuses the probe is baseline, never a failed preflight.
    assert asyncio.run(preflight(FakeIam()).probe_fidelity(["broken"])) == FIDELITY_BASELINE


# --- the scan ------------------------------------------------------------------


class Pages:
    def __init__(self, pages: list[dict[str, Any]]) -> None:
        self.pages = pages

    def paginate(self, **_: Any) -> list[dict[str, Any]]:
        return self.pages


class FakeEc2:
    def __init__(self, data: dict[str, list[dict[str, Any]]], error: Exception | None = None) -> None:
        self.data = data
        self.error = error

    def get_paginator(self, operation: str) -> Pages:
        if self.error:
            raise self.error
        key = {
            "describe_instances": "Reservations",
            "describe_volumes": "Volumes",
            "describe_vpcs": "Vpcs",
            "describe_subnets": "Subnets",
            "describe_security_groups": "SecurityGroups",
        }[operation]
        items = self.data.get(key, [])
        # Two pages, so a reader that ignored pagination would lose half.
        return Pages([{key: items[: len(items) // 2]}, {key: items[len(items) // 2 :]}])

    def describe_addresses(self) -> dict[str, Any]:
        if self.error:
            raise self.error
        return {"Addresses": self.data.get("Addresses", [])}


class FakeRds:
    def __init__(self, databases: list[dict[str, Any]], error: Exception | None = None) -> None:
        self.databases = databases
        self.error = error

    def get_paginator(self, operation: str) -> Pages:
        assert operation == "describe_db_instances"
        if self.error:
            raise self.error
        return Pages([{"DBInstances": self.databases}])


DEFAULT_NETWORK = {
    "Vpcs": [{"VpcId": "vpc-1", "IsDefault": True}],
    "Subnets": [{"SubnetId": f"subnet-{n}", "DefaultForAz": True} for n in range(3)],
    "SecurityGroups": [{"GroupName": "default", "VpcId": "vpc-1"}],
}

BUSY = {
    **DEFAULT_NETWORK,
    "Reservations": [
        {
            "Instances": [
                {"State": {"Name": "running"}, "Tags": [{"Key": "Environment", "Value": "prod"}]},
                {"State": {"Name": "stopped"}},
                {"State": {"Name": "terminated"}, "Tags": [{"Key": "Gone", "Value": "yes"}]},
            ]
        }
    ],
    "Volumes": [{"VolumeId": "vol-1"}, {"VolumeId": "vol-2", "Tags": [{"Key": "Name", "Value": "data"}]}],
    "Addresses": [{"AllocationId": "eipalloc-1"}],
}


def scan(ec2_by_region: dict[str, FakeEc2], rds_by_region: dict[str, FakeRds]) -> list[RegionScan]:
    def clients(service: str, region: str) -> Any:
        return ec2_by_region[region] if service == "ec2" else rds_by_region[region]

    return asyncio.run(AwsInventory(clients).scan(sorted(ec2_by_region)))


def test_the_scan_counts_workloads_and_drops_defaults_from_empty_regions() -> None:
    scans = scan(
        {"ap-southeast-3": FakeEc2(BUSY), "eu-west-1": FakeEc2(DEFAULT_NETWORK)},
        {
            "ap-southeast-3": FakeRds([{"DBInstanceIdentifier": "db", "TagList": [{"Key": "Environment", "Value": "dev"}]}]),
            "eu-west-1": FakeRds([]),
        },
    )
    out = summarize(scans, probed_at=datetime(2026, 9, 25, tzinfo=UTC))

    assert out["type_counts"] == {
        inv.TYPE_EIP: 1,
        inv.TYPE_INSTANCE: 2,
        inv.TYPE_RDS_INSTANCE: 1,
        inv.TYPE_SECURITY_GROUP: 1,
        inv.TYPE_VPC: 1,
        inv.TYPE_VOLUME: 2,
    }
    assert out["child_type_counts"] == {inv.TYPE_SUBNET: 3}
    assert out["resource_count"] == 8
    # A region holding only AWS's own defaults is empty.
    assert out["region_counts"] == {"ap-southeast-3": 8}
    assert out["regions"] == {"values": ["ap-southeast-3"], "truncated": False}
    assert out["resource_groups"] == {"values": [], "truncated": False}
    assert out["tag_keys"]["values"] == ["Environment", "Name"]
    assert out["tag_values"]["values"] == ["data", "dev", "prod"]
    assert out["region_probes"] == [
        {"region": region, "status_code": 200, "verdict": "reachable", "probed_at": "2026-09-25T00:00:00Z"}
        for region in ("ap-southeast-3", "eu-west-1")
    ]


def test_a_refused_region_is_stated_and_what_answered_still_counts() -> None:
    scans = scan(
        {"me-central-1": FakeEc2({}, error=denied("DescribeInstances", "UnauthorizedOperation"))},
        {"me-central-1": FakeRds([{"DBInstanceIdentifier": "db"}])},
    )
    out = summarize(scans)
    assert out["region_probes"][0]["verdict"] == "refused"
    assert out["region_probes"][0]["status_code"] == 403
    assert out["type_counts"] == {inv.TYPE_RDS_INSTANCE: 1}


def test_a_failure_that_is_not_a_refusal_is_unknown() -> None:
    scans = scan(
        {"us-east-1": FakeEc2({}, error=denied("DescribeInstances", "InternalError", 500))},
        {"us-east-1": FakeRds([])},
    )
    probe = summarize(scans)["region_probes"][0]
    assert (probe["verdict"], probe["status_code"]) == ("unknown", 500)


def test_the_outcome_has_the_azure_scan_keys() -> None:
    from reporting_agent.azure.inventory import INVENTORY_DIMENSIONS, ResourceCounts

    out = summarize([])
    counts = ResourceCounts(resource_count=0, type_counts={}, child_type_counts={}, region_counts={})
    assert set(out) == {*INVENTORY_DIMENSIONS, *counts.to_plain_data(), "region_probes"}


# --- the entrypoint ------------------------------------------------------------


def test_an_aws_context_routes_to_aws_and_hides_the_external_id(monkeypatch: pytest.MonkeyPatch) -> None:
    # `main` reads its configuration at import, as `tests/test_main.py` sets it up.
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.setenv("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
    monkeypatch.setenv("RPT_PROSE_MODEL_ID", "test.prose-model")
    from reporting_agent.main import describe_invocation, is_aws, parse_invocation
    from reporting_agent.redaction import scrub

    context = {
        "actor_id": "user-1",
        "provider": "aws",
        "subscription_id": ACCOUNT,
        "role_arn": ROLE,
        "external_id": EXTERNAL_ID,
    }
    invocation = parse_invocation({"command": "preflight", "context": context})
    assert is_aws(invocation.context)
    assert not is_aws({"subscription_id": "x"})
    described = describe_invocation(invocation)
    assert described["provider"] == "aws"
    assert EXTERNAL_ID not in json.dumps(described)
    assert EXTERNAL_ID not in (scrub(f"trust names {EXTERNAL_ID}") or "")
