"""Who created each AWS resource (`aws/ownership.py`) and what it costs at list price (`aws/costs.py`)."""

from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime, timedelta
from typing import Any

from reporting_agent.aws.costs import NOT_PRICED, NOT_RUNNING, parse_rate, price_items, price_query
from reporting_agent.aws.ownership import (
    LOOKUP_DENIED,
    LOOKUP_OK,
    creation_index,
    creations_from_events,
    ownership_items,
    principal_of,
    principals_to_check,
)

ACCOUNT = "123456789012"
REGION = "ap-southeast-1"
NOW = datetime(2026, 11, 23, 1, 0, tzinfo=UTC)
START = NOW - timedelta(days=90)


def arn(kind: str, name: str) -> str:
    return f"arn:aws:ec2:{REGION}:{ACCOUNT}:{kind}/{name}"


def event(name: str, at: datetime, identity: dict[str, Any], response: dict[str, Any] | None = None,
          request: dict[str, Any] | None = None, error: str | None = None) -> dict[str, Any]:
    detail: dict[str, Any] = {"userIdentity": identity, "responseElements": response, "requestParameters": request}
    if error:
        detail["errorCode"] = error
    return {"EventName": name, "EventTime": at, "CloudTrailEvent": json.dumps(detail)}


def role(name: str, session: str) -> dict[str, Any]:
    return {"type": "AssumedRole", "arn": f"arn:aws:sts::{ACCOUNT}:assumed-role/{name}/{session}",
            "sessionContext": {"sessionIssuer": {"type": "Role", "userName": name}}}


def test_each_kind_of_caller_reads_as_the_report_prints_it() -> None:
    assert principal_of({"type": "IAMUser", "userName": "alice"}).label == "user/alice"
    assert principal_of({"type": "IAMUser", "userName": "alice"}).iam == ("user", "alice")
    deploy = principal_of(role("GitHubDeploy", "gha-1234"))
    assert (deploy.label, deploy.kind, deploy.iam) == ("role/GitHubDeploy/gha-1234", "IAM role", ("role", "GitHubDeploy"))
    sso = principal_of(role("AWSReservedSSO_Admin_0123abcd", "budi@example.com"))
    assert (sso.label, sso.kind, sso.iam) == ("sso/budi@example.com", "SSO user", None)
    assert principal_of({"type": "Root"}).label == "root"
    assert principal_of({"type": "AWSService", "invokedBy": "autoscaling.amazonaws.com"}).label == (
        "service/autoscaling.amazonaws.com"
    )
    assert principal_of({"type": "Unrecognized"}).label == "Unknown"
    assert principal_of(None).kind == "Unknown"


def test_a_failed_call_creates_nothing_and_a_reused_name_takes_its_latest_creation() -> None:
    alice, bob = {"type": "IAMUser", "userName": "alice"}, {"type": "IAMUser", "userName": "bob"}
    creations = creations_from_events([
        event("RunInstances", NOW - timedelta(days=3), alice, error="UnauthorizedOperation"),
        event("CreateDBInstance", NOW - timedelta(days=40), alice, {"dBInstanceIdentifier": "Orders"}),
        event("CreateDBInstance", NOW - timedelta(days=4), bob, {"dBInstanceIdentifier": "orders"}),
        event("RestoreDBInstanceToPointInTime", NOW - timedelta(days=2), bob, None, {"targetDBInstanceIdentifier": "copy"}),
        event("RunInstances", NOW - timedelta(days=1), bob,
              {"instancesSet": {"items": [{"instanceId": "i-1"}, {"instanceId": "i-2"}]}}),
    ])
    index = creation_index(creations)
    assert index[("database", "orders")].principal.label == "user/bob"
    assert ("database", "copy") in index
    assert {key for key in index if key[0] == "instance"} == {("instance", "i-1"), ("instance", "i-2")}
    assert principals_to_check(creations) == [("user", "alice"), ("user", "bob")]


def test_fallbacks_are_named_and_every_resource_answers_every_key() -> None:
    vpc, default_group, tagged, untouched = arn("vpc", "vpc-1"), arn("security-group", "sg-default"), \
        arn("security-group", "sg-tagged"), arn("volume", "vol-old")
    raw = {
        vpc: {"_kind": "vpc", "_region": REGION, "VpcId": "vpc-1"},
        default_group: {"_kind": "security_group", "_region": REGION, "GroupName": "default", "VpcId": "vpc-1"},
        tagged: {"_kind": "security_group", "_region": REGION, "GroupName": "app", "VpcId": "vpc-1",
                 "Tags": [{"Key": "Owner", "Value": "platform-team"}]},
        untouched: {"_kind": "volume", "_region": REGION, "CreateTime": datetime(2025, 1, 5, 20, tzinfo=UTC)},
        arn("subnet", "subnet-1"): {"_kind": "subnet", "_region": REGION},
    }
    index = creation_index(creations_from_events([
        event("CreateVpc", NOW - timedelta(days=10), role("Terraform", "plan"), {"vpc": {"vpcId": "vpc-1"}}),
    ]))
    items = {item["resource_id"]: item for item in ownership_items(
        sorted(raw), raw, index=index, lookups={REGION: LOOKUP_OK}, statuses={("role", "Terraform"): "Active"},
        lookback_start=START, tz=UTC,
    )}
    assert set(items) == {vpc, default_group, tagged, untouched}, "a subnet is not an owned resource"
    assert items[default_group]["created_by"] == "role/Terraform/plan"
    assert items[default_group]["creator_source"] == "Created with its VPC"
    assert items[tagged]["created_by"] == "platform-team" and items[tagged]["creator_source"] == "Tag"
    assert items[untouched] == {
        "resource_id": untouched, "created_by": "Unknown", "creator_type": "Unknown",
        "created_on": "2025-01-05", "creator_source": "No event in 90 days", "creator_status": "Unknown",
    }
    for item in items.values():
        assert set(item) == {"resource_id", "created_by", "creator_type", "created_on", "creator_source",
                             "creator_status"}

    denied = ownership_items([vpc], raw, index={}, lookups={REGION: LOOKUP_DENIED}, statuses={},
                             lookback_start=START, tz=UTC)
    assert denied[0]["creator_source"] == "No CloudTrail access" and denied[0]["created_on"] == "Unknown"


def product(usage: str, unit: str, usd: str) -> str:
    return json.dumps({"product": {"attributes": {"usagetype": usage}},
                       "terms": {"OnDemand": {"t": {"priceDimensions": {"d": {"unit": unit, "pricePerUnit": {"USD": usd}}}}}}})


def test_each_priced_kind_is_estimated_from_its_own_rate() -> None:
    running = {"_kind": "instance", "_region": REGION, "InstanceType": "t3.micro", "PlatformDetails": "Linux/UNIX",
               "State": {"Name": "running"}}
    stopped = {**running, "State": {"Name": "stopped"}}
    rhel = {**running, "PlatformDetails": "Red Hat Enterprise Linux"}
    volume = {"_kind": "volume", "_region": REGION, "VolumeType": "gp3", "Size": 50}
    idle_ip = {"_kind": "eip", "_region": REGION}
    oracle = {"_kind": "database", "_region": REGION, "DBInstanceClass": "db.t3.small", "Engine": "oracle-se2"}
    raw = {"i-run": running, "i-off": stopped, "i-rhel": rhel, "vol": volume, "eip": idle_ip, "db": oracle}

    assert price_query(rhel) is None and price_query(oracle) is None
    assert price_query(idle_ip)[3] == "PublicIPv4:IdleAddress"  # type: ignore[index]
    assert price_query({**idle_ip, "AssociationId": "eipassoc-1"})[3] == "PublicIPv4:InUseAddress"  # type: ignore[index]

    rates = {price_query(running): "0.0132000000", price_query(volume): "0.0960000000",
             price_query(idle_ip): "0.0050000000"}
    found = {item["resource_id"]: item["est_monthly_cost"] for item in price_items(sorted(raw), raw, rates)}
    assert found == {"i-run": "9.64", "i-off": NOT_RUNNING, "i-rhel": NOT_PRICED, "vol": "4.80",
                     "eip": "3.65", "db": NOT_PRICED}


def test_a_rate_is_the_first_non_zero_one_in_the_asked_unit() -> None:
    query = price_query({"_kind": "eip", "_region": REGION})
    assert query is not None
    listed = [product("APS1-PublicIPv4:InUseAddress", "Hrs", "0.0050000000"),
              product("APS1-PublicIPv4:IdleAddress", "Hrs", "0.0000000000"),
              product("APS1-PublicIPv4:IdleAddress", "Hrs", "0.0050000000")]
    assert parse_rate(query, listed) == "0.0050000000"
    assert parse_rate(query, ["not json", product("APS1-PublicIPv4:IdleAddress", "GB-Mo", "1")]) is None


def test_the_provider_asks_each_distinct_price_once_and_archives_the_rates() -> None:
    from fakes.object_store import InMemoryObjectStore
    from reporting_agent.aws.provider import AwsProvider
    from reporting_agent.catalog.loader import load_catalog

    asked: list[str] = []

    def get_products(**kwargs: Any) -> dict[str, Any]:
        asked.append(kwargs["ServiceCode"])
        if kwargs["ServiceCode"] == "AmazonEC2":
            return {"PriceList": [product("APS1-BoxUsage:t3.micro", "Hrs", "0.0132000000")]}
        raise RuntimeError("throttled")

    first, second = arn("instance", "i-1"), arn("instance", "i-2")
    aws = AwsProvider(clients=lambda *_: None, catalog=load_catalog(), object_store=InMemoryObjectStore(),
                      account_id=ACCOUNT, actor_id="actor-1", run_id="run-1", home_region="us-east-1",
                      get_products=get_products)
    machine = {"_kind": "instance", "_region": REGION, "InstanceType": "t3.micro", "PlatformDetails": "Linux/UNIX",
               "State": {"Name": "running"}}
    aws._raw.update({first: machine, second: machine, arn("elastic-ip", "eipalloc-1"): {"_kind": "eip", "_region": REGION}})
    body = asyncio.run(aws._price_body(sorted(aws._raw)))
    assert asked.count("AmazonEC2") == 1
    values = {item["resource_id"]: item["est_monthly_cost"] for item in body["value"]}  # type: ignore[index]
    assert values[first] == values[second] == "9.64"
    assert values[arn("elastic-ip", "eipalloc-1")] == NOT_PRICED, "a failed price is an answer, not a failed run"
    assert {rate["usd"] for rate in body["rates"]} == {"0.0132000000", None}  # type: ignore[index]
