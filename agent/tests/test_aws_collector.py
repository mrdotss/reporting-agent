"""The AWS collector: CloudWatch planning and folding, the provider, and replay.

Every account id is AWS's documentation placeholder, and every client is a fake: nothing
here reaches AWS. The one test that matters most is the last section's round trip — a
collection through the real pipeline, replayed from its own archive to the same digest.
"""

from __future__ import annotations

import asyncio
import gzip
import json
import os
import re
from collections.abc import Mapping
from datetime import UTC, datetime, timedelta
from decimal import Decimal
from typing import Any

import pytest
from botocore.exceptions import ClientError

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from fakes.object_store import InMemoryObjectStore
from reporting_agent.aws.metrics import (
    MAX_QUERIES_PER_CALL,
    build_document,
    dimension_value,
    fold_cloudwatch_document,
    plan_queries,
)
from reporting_agent.aws.provider import AwsProvider, normalize_aws_state
from reporting_agent.catalog.evidence import check_catalog_evidence, evidence_filename
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.accumulate import new_accumulator
from reporting_agent.collect.archive import ARCHIVE_KIND_CLOUDWATCH
from reporting_agent.collect.pipeline import CollectionSink, run_collection
from reporting_agent.main import StepTracker
from reporting_agent.providers import registry
from reporting_agent.providers.base import is_excluded_from_averages
from reporting_agent.verify.replay import plan_from_snapshot, replay

ACCOUNT = "123456789012"
INSTANCE = f"arn:aws:ec2:us-east-1:{ACCOUNT}:instance/i-0123456789abcdef0"
STOPPED = f"arn:aws:ec2:us-east-1:{ACCOUNT}:instance/i-0fedcba9876543210"
VOLUME = f"arn:aws:ec2:us-east-1:{ACCOUNT}:volume/vol-0123456789abcdef0"
DATABASE = f"arn:aws:rds:ap-southeast-3:{ACCOUNT}:db:orders"
ALL = ("Total", "Count", "Minimum", "Maximum")
VPC = f"arn:aws:ec2:us-east-1:{ACCOUNT}:vpc/vpc-0example"
SUBNET = f"{VPC}/subnet/subnet-0example"
EIP = f"arn:aws:ec2:us-east-1:{ACCOUNT}:elastic-ip/eipalloc-0example"
GROUP = f"arn:aws:ec2:us-east-1:{ACCOUNT}:security-group/sg-0inuse"
RULE_IN = f"{GROUP}/security-group-rule/sgr-0https"
RULE_OUT = f"{GROUP}/security-group-rule/sgr-0egress"


def denied(code: str = "AccessDenied") -> ClientError:
    return ClientError({"Error": {"Code": code, "Message": "no"}}, "Describe")


# --- planning -------------------------------------------------------------------------


def test_the_dimension_comes_from_the_arn() -> None:
    assert dimension_value("AWS::EC2::Instance", INSTANCE) == "i-0123456789abcdef0"
    assert dimension_value("AWS::EC2::Volume", VOLUME) == "vol-0123456789abcdef0"
    assert dimension_value("AWS::RDS::DBInstance", DATABASE) == "orders"
    assert dimension_value("AWS::EC2::Instance", VOLUME) is None
    assert dimension_value("AWS::S3::Bucket", INSTANCE) is None


def test_calls_hold_at_most_500_queries_and_never_split_a_resource() -> None:
    ids = [f"arn:aws:ec2:us-east-1:{ACCOUNT}:instance/i-{n:017x}" for n in range(60)]
    metrics = ["CPUUtilization", "NetworkIn"]
    calls = plan_queries(
        resource_type="AWS::EC2::Instance",
        resource_ids=ids,
        metric_names=metrics,
        aggregations_by_metric=dict.fromkeys(metrics, ALL),
    )
    assert sum(len(call) for call in calls) == 60 * 2 * 4
    assert all(len(call) <= MAX_QUERIES_PER_CALL for call in calls)
    per_resource = {}
    for index, call in enumerate(calls):
        for query in call:
            per_resource.setdefault(query.resource_id, set()).add(index)
            assert re.fullmatch(r"[a-z][a-z0-9_]*", query.id)
    assert all(len(indices) == 1 for indices in per_resource.values())
    ids_seen = [query.id for call in calls for query in call]
    assert len(ids_seen) == len(set(ids_seen))
    # The plan is a function of the inventory, not of its order.
    assert plan_queries(
        resource_type="AWS::EC2::Instance",
        resource_ids=list(reversed(ids)),
        metric_names=metrics,
        aggregations_by_metric=dict.fromkeys(metrics, ALL),
    ) == calls


# --- the document and the fold ----------------------------------------------------------


def stamp(hour: int) -> datetime:
    return datetime(2026, 9, 1, tzinfo=UTC) + timedelta(hours=hour)


def one_pair_queries() -> list[Any]:
    (call,) = plan_queries(
        resource_type="AWS::EC2::Instance",
        resource_ids=[INSTANCE],
        metric_names=["CPUUtilization"],
        aggregations_by_metric={"CPUUtilization": ALL},
    )
    return call


def page(series: Mapping[str, tuple[list[int], list[float]]], status: str = "Complete") -> dict[str, Any]:
    return {
        "MetricDataResults": [
            {"Id": query_id, "StatusCode": status, "Timestamps": [stamp(h) for h in hours], "Values": values}
            for query_id, (hours, values) in series.items()
        ]
    }


def ids_by_stat(queries: list[Any]) -> dict[str, str]:
    return {query.stat: query.id for query in queries}


def document_for(pages: list[dict[str, Any]], queries: list[Any]) -> dict[str, Any]:
    return build_document(
        account_id=ACCOUNT,
        region="us-east-1",
        resource_type="AWS::EC2::Instance",
        grain="PT1H",
        window={"start_utc": "2026-09-01T00:00:00Z", "end_utc": "2026-09-01T03:00:00Z"},
        metric_names=["CPUUtilization"],
        queries=queries,
        pages=pages,
    )


def test_pages_merge_sort_and_keep_exact_digits() -> None:
    queries = one_pair_queries()
    ids = ids_by_stat(queries)
    first = page({ids["Sum"]: ([1], [0.1 + 0.2])})
    second = page({ids["Sum"]: ([0], [12.5])})
    document = document_for([first, second], queries)
    assert document["kind"] == ARCHIVE_KIND_CLOUDWATCH
    (result,) = document["results"]
    assert result["timestamps"] == ["2026-09-01T00:00:00Z", "2026-09-01T01:00:00Z"]
    # `repr` is the float's shortest round-tripping spelling, so the digits are the float's.
    assert result["values"] == ["12.5", "0.30000000000000004"]
    assert json.loads(json.dumps(document)) == document


def test_four_statistics_fold_into_one_exact_average() -> None:
    queries = one_pair_queries()
    ids = ids_by_stat(queries)
    document = document_for(
        [
            page(
                {
                    ids["Sum"]: ([0, 1], [120.0, 60.0]),
                    ids["SampleCount"]: ([0, 1], [12.0, 12.0]),
                    ids["Minimum"]: ([0, 1], [2.0, 1.0]),
                    ids["Maximum"]: ([0, 1], [40.0, 9.0]),
                }
            )
        ],
        queries,
    )
    accumulator, _ = new_accumulator("percentage", resource_id=INSTANCE, metric="CPUUtilization", aggregations=ALL)
    gaps = fold_cloudwatch_document(document, {(INSTANCE, "CPUUtilization"): accumulator})
    assert gaps == []
    result, gap = accumulator.finalize(INSTANCE, "CPUUtilization")
    assert gap is None and result is not None
    # (120 + 60) / (12 + 12): the sample-weighted mean, exactly as Azure's Total / Count.
    assert result.average == Decimal("7.5")
    assert (result.minimum, result.maximum) == (Decimal("1.0"), Decimal("40.0"))


def test_an_interval_without_a_sample_count_is_excluded_and_recorded() -> None:
    queries = one_pair_queries()
    ids = ids_by_stat(queries)
    document = document_for(
        [
            page(
                {
                    ids["Sum"]: ([0, 1], [120.0, 60.0]),
                    ids["SampleCount"]: ([0], [12.0]),
                    ids["Minimum"]: ([0, 1], [2.0, 1.0]),
                    ids["Maximum"]: ([0, 1], [40.0, 9.0]),
                }
            )
        ],
        queries,
    )
    accumulator, _ = new_accumulator("percentage", resource_id=INSTANCE, metric="CPUUtilization", aggregations=ALL)
    gaps = fold_cloudwatch_document(document, {(INSTANCE, "CPUUtilization"): accumulator})
    assert [(gap["gap_type"], gap["interval_start"]) for gap in gaps] == [
        ("interval_counts_missing", "2026-09-01T01:00:00Z")
    ]


@pytest.mark.parametrize(("status", "gap_type"), [("Forbidden", "permission_denied"), ("InternalError", "metric_error")])
def test_a_refused_series_records_its_gap_and_folds_nothing(status: str, gap_type: str) -> None:
    queries = one_pair_queries()
    ids = ids_by_stat(queries)
    document = document_for([page({ids["Sum"]: ([0], [1.0])}, status=status)], queries)
    accumulator, _ = new_accumulator("percentage", resource_id=INSTANCE, metric="CPUUtilization", aggregations=ALL)
    gaps = fold_cloudwatch_document(document, {(INSTANCE, "CPUUtilization"): accumulator})
    assert [gap["gap_type"] for gap in gaps] == [gap_type]


# --- the provider -----------------------------------------------------------------------


class Pages:
    def __init__(self, key: str, items: list[dict[str, Any]]) -> None:
        self.key, self.items = key, items

    def paginate(self, **_: Any) -> list[dict[str, Any]]:
        half = len(self.items) // 2
        return [{self.key: self.items[:half]}, {self.key: self.items[half:]}]


class FakeEc2:
    def __init__(self, region: str, *, refuse: bool = False) -> None:
        self.region, self.refuse = region, refuse

    def describe_regions(self, **_: Any) -> dict[str, Any]:
        return {"Regions": [{"RegionName": "us-east-1"}, {"RegionName": "ap-southeast-3"}]}

    def describe_addresses(self) -> dict[str, Any]:
        if self.refuse:
            raise denied("UnauthorizedOperation")
        return {"Addresses": [{"AllocationId": "eipalloc-0example", "PublicIp": "203.0.113.10",
                               "InstanceId": "i-0123456789abcdef0", "PrivateIpAddress": "10.0.0.4",
                               "Domain": "vpc"}] if self.region == "us-east-1" else []}

    def describe_instance_types(self, **kwargs: Any) -> dict[str, Any]:
        specs = {"t3.micro": (2, 1024), "t3.small": (2, 2048)}
        return {
            "InstanceTypes": [
                {"InstanceType": name, "VCpuInfo": {"DefaultVCpus": specs[name][0]}, "MemoryInfo": {"SizeInMiB": specs[name][1]}}
                for name in kwargs["InstanceTypes"]
                if name in specs
            ]
        }

    def get_paginator(self, operation: str) -> Pages:
        if self.refuse:
            raise denied("UnauthorizedOperation")
        if operation == "describe_instances":
            instances = []
            if self.region == "us-east-1":
                instances = [
                    {"InstanceId": "i-0123456789abcdef0", "InstanceType": "t3.micro", "State": {"Name": "running"},
                     "Tags": [{"Key": "Name", "Value": "web"}, {"Key": "Environment", "Value": "prod"}],
                     "PlatformDetails": "Linux/UNIX", "PrivateIpAddress": "10.0.0.4", "VpcId": "vpc-0example",
                     "SubnetId": "subnet-0example", "Placement": {"AvailabilityZone": "us-east-1a"},
                     "SecurityGroups": [{"GroupName": "web-sg"}, {"GroupName": "admin-sg"}],
                     "LaunchTime": datetime(2026, 8, 19, 3, 0, tzinfo=UTC)},
                    {"InstanceId": "i-0fedcba9876543210", "InstanceType": "t3.small", "State": {"Name": "stopped"}},
                    {"InstanceId": "i-0000000000000dead", "InstanceType": "t3.small", "State": {"Name": "terminated"}},
                ]
            return Pages("Reservations", [{"Instances": instances}])
        if operation == "describe_volumes":
            volumes = (
                [{"VolumeId": "vol-0123456789abcdef0", "VolumeType": "gp3", "Size": 8, "Iops": 3000,
                  "Encrypted": False, "State": "in-use", "AvailabilityZone": "us-east-1a",
                  "Attachments": [{"InstanceId": "i-0123456789abcdef0"}]}]
                if self.region == "us-east-1"
                else []
            )
            return Pages("Volumes", volumes)
        east = self.region == "us-east-1"
        if operation == "describe_vpcs":
            return Pages("Vpcs", [{"VpcId": "vpc-0example", "CidrBlock": "10.0.0.0/16", "IsDefault": False,
                                   "State": "available", "Tags": [{"Key": "Name", "Value": "main"}]}] if east else [])
        if operation == "describe_subnets":
            return Pages("Subnets", [{"SubnetId": "subnet-0example", "VpcId": "vpc-0example", "CidrBlock": "10.0.1.0/24",
                                      "AvailabilityZone": "us-east-1a", "AvailableIpAddressCount": 250,
                                      "MapPublicIpOnLaunch": False}] if east else [])
        if operation == "describe_network_interfaces":
            return Pages("NetworkInterfaces", [{"Groups": [{"GroupId": "sg-0inuse"}]}] if east else [])
        if operation == "describe_security_groups":
            return Pages("SecurityGroups", [
                {"GroupId": "sg-0inuse", "GroupName": "web-sg", "VpcId": "vpc-0example", "Description": "web tier"},
                {"GroupId": "sg-0unused", "GroupName": "leftover", "VpcId": "vpc-0example", "Description": "unused"},
            ] if east else [])
        if operation == "describe_security_group_rules":
            return Pages("SecurityGroupRules", [
                {"SecurityGroupRuleId": "sgr-0https", "GroupId": "sg-0inuse", "IsEgress": False, "IpProtocol": "tcp",
                 "FromPort": 443, "ToPort": 443, "CidrIpv4": "0.0.0.0/0", "Description": "public https"},
                {"SecurityGroupRuleId": "sgr-0egress", "GroupId": "sg-0inuse", "IsEgress": True, "IpProtocol": "-1",
                 "FromPort": -1, "ToPort": -1, "CidrIpv4": "0.0.0.0/0"},
                {"SecurityGroupRuleId": "sgr-0other", "GroupId": "sg-0unused", "IsEgress": False, "IpProtocol": "tcp",
                 "FromPort": 22, "ToPort": 22, "CidrIpv4": "10.0.0.0/8"},
            ] if east else [])
        raise AssertionError(operation)


class FakeRds:
    def __init__(self, region: str) -> None:
        self.region = region

    def get_paginator(self, operation: str) -> Pages:
        databases = (
            [{"DBInstanceArn": DATABASE, "DBInstanceIdentifier": "orders", "DBInstanceClass": "db.t4g.micro",
              "DBInstanceStatus": "available", "TagList": [{"Key": "Environment", "Value": "prod"}],
              "Engine": "postgres", "EngineVersion": "16.10", "MultiAZ": False, "StorageType": "gp3",
              "AllocatedStorage": 20, "BackupRetentionPeriod": 0, "AvailabilityZone": "ap-southeast-3a",
              "PubliclyAccessible": True}]
            if self.region == "ap-southeast-3"
            else []
        )
        return Pages("DBInstances", databases)


class FakeCloudWatch:
    """Answers every query with three hours of data derived from its id, in two pages."""

    def __init__(self) -> None:
        self.calls = 0

    def get_metric_data(self, **kwargs: Any) -> dict[str, Any]:
        self.calls += 1
        results = []
        for query in kwargs["MetricDataQueries"]:
            stat = query["MetricStat"]["Stat"]
            seed = sum(map(ord, query["Id"])) % 17 + 1
            values = {"Sum": [seed * 12.5, seed * 6.25, seed * 3.1], "SampleCount": [12.0, 12.0, 12.0],
                      "Minimum": [seed * 0.5, seed * 0.25, 0.1], "Maximum": [seed * 3.0, seed * 1.5, seed * 1.1]}[stat]
            start = kwargs["StartTime"]
            results.append({"Id": query["Id"], "StatusCode": "Complete",
                            "Timestamps": [start + timedelta(hours=h) for h in range(3)], "Values": values})
        if "NextToken" not in kwargs:
            return {"MetricDataResults": results[: len(results) // 2], "NextToken": "page-2"}
        return {"MetricDataResults": results[len(results) // 2 :]}


class FakeBackup:
    def __init__(self, region: str) -> None:
        self.region = region

    def get_paginator(self, operation: str) -> Pages:
        assert operation == "list_protected_resources"
        protected = (
            [{"ResourceArn": DATABASE, "ResourceType": "RDS", "LastBackupTime": datetime(2026, 9, 1, 2, tzinfo=UTC),
              "LastBackupVaultArn": f"arn:aws:backup:ap-southeast-3:{ACCOUNT}:backup-vault:Default"}]
            if self.region == "ap-southeast-3"
            else []
        )
        return Pages("Results", protected)


class FakeOptimizer:
    def __init__(self, enrolled: bool) -> None:
        self.enrolled = enrolled

    def get_ec2_instance_recommendations(self, **_: Any) -> dict[str, Any]:
        if not self.enrolled:
            raise ClientError({"Error": {"Code": "OptInRequiredException", "Message": "not registered"}}, "Get")
        return {"instanceRecommendations": [
            {"instanceArn": INSTANCE, "finding": "Overprovisioned", "currentInstanceType": "t3.micro",
             "recommendationOptions": [{"instanceType": "t4g.nano", "rank": 1}, {"instanceType": "t3.nano", "rank": 2}]}
        ]}


def fake_clients(refused: set[str] = frozenset(), *, enrolled: bool = False) -> Any:
    cloudwatch = FakeCloudWatch()

    def clients(service: str, region: str) -> Any:
        if service == "ec2":
            return FakeEc2(region, refuse=region in refused)
        if service == "rds":
            return FakeRds(region)
        if service == "cloudwatch":
            return cloudwatch
        if service == "backup":
            return FakeBackup(region)
        if service == "compute-optimizer":
            return FakeOptimizer(enrolled)
        raise AssertionError(service)

    clients.cloudwatch = cloudwatch  # type: ignore[attr-defined]
    return clients


def provider(store: InMemoryObjectStore, clients: Any) -> AwsProvider:
    return AwsProvider(
        clients=clients,
        catalog=load_catalog(),
        object_store=store,
        account_id=ACCOUNT,
        actor_id="actor-1",
        run_id="run-1",
        home_region="us-east-1",
    )


def test_discovery_reads_every_region_and_records_stopped_resources() -> None:
    aws = provider(InMemoryObjectStore(), fake_clients())
    result = asyncio.run(aws.discover({"subscription_id": ACCOUNT, "resource_types": [], "resource_groups": [], "tag_filters": {}}))
    ids = [resource["resource_id"] for resource in result["resources"]]
    assert ids == sorted([INSTANCE, STOPPED, VOLUME, DATABASE, VPC, SUBNET, EIP, GROUP, RULE_IN, RULE_OUT])
    by_id = {resource["resource_id"]: resource for resource in result["resources"]}
    assert by_id[INSTANCE]["name"] == "web"
    assert by_id[INSTANCE]["sku_name"] == "t3.micro"
    assert by_id[INSTANCE]["resource_group"] == ""
    assert by_id[DATABASE]["power_state"] == "running"
    assert is_excluded_from_averages(by_id[STOPPED])
    assert not is_excluded_from_averages(by_id[INSTANCE])
    assert [(gap["gap_type"], gap["resource_id"]) for gap in result["gaps"]] == [("deallocated", STOPPED)]


def test_scope_regions_tags_and_types_narrow_discovery() -> None:
    aws = provider(InMemoryObjectStore(), fake_clients())
    scope = {
        "subscription_id": ACCOUNT,
        "resource_types": ["AWS::EC2::Instance", "AWS::RDS::DBInstance"],
        "resource_groups": [],
        "tag_filters": {"Environment": "prod"},
        "regions": ["us-east-1"],
    }
    result = asyncio.run(aws.discover(scope))  # type: ignore[arg-type]
    assert [resource["resource_id"] for resource in result["resources"]] == [INSTANCE]


def test_a_refused_region_is_a_gap_not_an_empty_region() -> None:
    aws = provider(InMemoryObjectStore(), fake_clients(refused={"us-east-1"}))
    result = asyncio.run(aws.discover({"subscription_id": ACCOUNT, "resource_types": [], "resource_groups": [], "tag_filters": {}}))
    assert [resource["resource_id"] for resource in result["resources"]] == [DATABASE]
    assert {gap["gap_type"] for gap in result["gaps"]} == {"region_unreachable"}


def test_states_normalize_to_the_shared_vocabulary() -> None:
    assert normalize_aws_state("ec2:pending") == "starting"
    assert normalize_aws_state("rds:backing-up") == "running"
    assert normalize_aws_state("rds:storage-full") == "unknown"


def test_capabilities_name_only_aws_types_and_azure_names_none() -> None:
    aws = provider(InMemoryObjectStore(), fake_clients())
    types = aws.capabilities()["resource_types"]
    assert types == ["AWS::EC2::Instance", "AWS::EC2::Volume", "AWS::RDS::DBInstance"]
    from reporting_agent.azure.provider import AzureProvider

    azure_types = AzureProvider.capabilities(type("P", (), {"catalog": load_catalog()})())  # type: ignore[arg-type]
    assert not [t for t in azure_types["resource_types"] if t.startswith("AWS::")]


def test_the_registry_builds_aws_by_id() -> None:
    assert registry.AWS_PROVIDER_ID in registry.provider_ids()


def test_the_aws_catalog_entries_are_evidenced() -> None:
    assert evidence_filename("AWS::EC2::Instance") == "aws__ec2__instance.json"
    catalog = load_catalog()
    findings = [f for f in check_catalog_evidence(catalog) if f.resource_type.startswith("AWS::")]
    assert findings == []


# --- the round trip ----------------------------------------------------------------------


def test_a_collection_replays_to_the_same_digest() -> None:
    """Collect through the real pipeline over fake AWS, then replay the archive it wrote."""
    store = InMemoryObjectStore()
    clients = fake_clients()
    aws = provider(store, clients)
    catalog = load_catalog()
    sink = CollectionSink()

    async def collect() -> None:
        async for _ in run_collection(
            payload={
                "period": {"start": "2026-09-01", "end": "2026-09-01"},
                "scope": {"resource_types": [], "resource_groups": [], "tag_filters": {}, "regions": ["us-east-1", "ap-southeast-3"]},
            },
            context={"actor_id": "actor-1", "run_id": "run-1", "subscription_id": ACCOUNT, "timezone": "UTC", "provider": "aws"},
            steps=StepTracker(),
            artifact_bucket="unused",
            sink=sink,
            provider=aws,
            object_store=store,
            catalog=catalog,
        ):
            pass

    asyncio.run(collect())
    outcome = sink.outcome
    assert outcome is not None
    document = outcome.document
    assert document["requested_scope"]["regions"] == ["ap-southeast-3", "us-east-1"]
    assert clients.cloudwatch.calls >= 2  # paged

    stats = {resource["resource_id"]: resource.get("statistics") or [] for resource in document["resources"]}
    assert stats[INSTANCE] and stats[DATABASE] and stats[VOLUME]
    assert stats[STOPPED] == []  # stopped: excluded, never zero

    keys = sorted(key for key in store.keys() if "/raw/" in key)
    archived = [(index, asyncio.run(store.get_bytes(key))) for index, key in enumerate(keys)]
    kinds = sorted(json.loads(gzip.decompress(body))["kind"] for _, body in archived)
    # Every CloudWatch call, and one facts object per source: describe, AWS Backup, Compute Optimizer.
    assert set(kinds) == {ARCHIVE_KIND_CLOUDWATCH, "facts"} and kinds.count("facts") == 3

    facts = {
        resource["resource_id"]: {fact["key"]: fact["value"] for fact in resource.get("facts") or []}
        for resource in document["resources"]
    }
    assert facts[INSTANCE] == {
        "availability_zone": "us-east-1a", "instance_type": "t3.micro", "launch_date": "2026-08-19",
        "memory": "1 GiB", "platform": "Linux/UNIX", "private_ip": "10.0.0.4", "public_ip": "none",
        "security_groups": "admin-sg, web-sg", "subnet": "subnet-0example", "vcpus": "2", "vpc": "vpc-0example",
    }
    assert facts[VOLUME]["size"] == "8 GiB" and facts[VOLUME]["attached_to"] == "i-0123456789abcdef0"
    assert facts[DATABASE]["backup_retention_days"] == "0" and facts[DATABASE]["publicly_accessible"] == "yes"
    # AWS Backup protects the database only; Compute Optimizer is not enrolled.
    assert facts[DATABASE]["last_backup"] == "2026-09-01" and facts[DATABASE]["backup_vault"] == "Default"
    assert "last_backup" not in facts[INSTANCE] and "rightsizing_finding" not in facts[INSTANCE]
    gap_pairs = {(gap["gap_type"], gap["resource_id"], gap["metric"]) for gap in outcome.gaps}
    assert ("backup_not_configured", INSTANCE, "last_backup") in gap_pairs
    assert ("optimizer_not_available", INSTANCE, "rightsizing_finding") in gap_pairs
    assert ("backup_not_configured", DATABASE, "last_backup") not in gap_pairs
    # The network: a VPC and its subnet, an address, the one group in use and its rules.
    assert facts[VPC] == {"cidr": "10.0.0.0/16", "is_default": "no", "vpc_state": "available"}
    assert facts[SUBNET]["available_ips"] == "250" and facts[SUBNET]["public_on_launch"] == "no"
    assert facts[EIP] == {"public_ip": "203.0.113.10", "attached_to": "i-0123456789abcdef0",
                          "private_ip": "10.0.0.4", "domain": "vpc"}
    assert facts[GROUP]["inbound_rules"] == "1" and facts[GROUP]["outbound_rules"] == "1"
    assert facts[RULE_IN] == {"direction": "inbound", "protocol": "tcp", "ports": "443",
                              "peer": "0.0.0.0/0", "description": "public https"}
    assert facts[RULE_OUT]["protocol"] == "all" and facts[RULE_OUT]["ports"] == "all"
    assert not [rid for rid in facts if "sg-0unused" in rid]

    result = replay(archived, plan=plan_from_snapshot(document, catalog=catalog, objects_named=len(archived)))
    assert result.outcome["possible"] is True
    assert result.outcome["recomputed_sha256"] == result.outcome["stored_sha256"] == outcome.snapshot_id
    assert result.findings == ()

    # A tampered value is caught.
    slot = next(
        position
        for position, (_, body) in enumerate(archived)
        if json.loads(gzip.decompress(body))["kind"] == ARCHIVE_KIND_CLOUDWATCH
    )
    index, body = archived[slot]
    tampered = json.loads(gzip.decompress(body))
    tampered["results"][0]["values"][0] = str(Decimal(tampered["results"][0]["values"][0]) + 1)
    archived[slot] = (index, gzip.compress(json.dumps(tampered).encode()))
    mismatch = replay(archived, plan=plan_from_snapshot(document, catalog=catalog, objects_named=len(archived)))
    assert mismatch.outcome["recomputed_sha256"] != outcome.snapshot_id


def test_a_repeated_name_gains_the_resource_id() -> None:
    from reporting_agent.aws.provider import _unique_names

    def record(resource_id: str, name: str, resource_type: str = "AWS::EC2::Instance") -> dict[str, Any]:
        return {"resource_id": resource_id, "name": name, "resource_type": resource_type, "location": "us-east-1",
                "resource_group": "", "tags": {}, "sku_name": "", "power_state_raw": "", "power_state": "unknown",
                "fidelity_tier": "baseline"}

    named = _unique_names([
        record(f"arn:aws:ec2:us-east-1:{ACCOUNT}:instance/i-01", "web"),
        record(f"arn:aws:ec2:us-east-1:{ACCOUNT}:instance/i-02", "web"),
        record(f"arn:aws:ec2:us-east-1:{ACCOUNT}:instance/i-03", "db"),
        # The same name on another type is a repeat too: the backups table lists both.
        record(f"arn:aws:ec2:us-east-1:{ACCOUNT}:volume/vol-01", "web", "AWS::EC2::Volume"),
    ])  # type: ignore[arg-type]
    assert [r["name"] for r in named] == ["web (i-01)", "web (i-02)", "db", "web (vol-01)"]


def test_an_enrolled_account_carries_its_rightsizing_findings() -> None:
    store = InMemoryObjectStore()
    aws = provider(store, fake_clients(enrolled=True))
    scope = {"subscription_id": ACCOUNT, "resource_types": ["AWS::EC2::Instance"], "resource_groups": [],
             "tag_filters": {}, "regions": ["us-east-1"]}
    discovered = asyncio.run(aws.discover(scope))  # type: ignore[arg-type]
    result = asyncio.run(aws.collect_facts({"resources": discovered["resources"], "inventory_pages": [],
                                            "subscription_id": ACCOUNT}))
    by_key = {(fact["resource_id"], fact["key"]): fact["value"] for fact in result["facts"]}
    assert by_key[(INSTANCE, "rightsizing_finding")] == "Overprovisioned"
    assert by_key[(INSTANCE, "recommended_type")] == "t4g.nano"
    # The stopped instance has no recommendation: an answer, recorded as that.
    assert {(g["gap_type"], g["resource_id"]) for g in result["gaps"]} >= {("optimizer_not_available", STOPPED)}
