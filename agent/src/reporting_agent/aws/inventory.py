"""The AWS scan: what each enabled region holds, in the shape the Azure scan returns.

`list_inventory` answers the scan page and the preset pickers with five dimensions (resource
types, resource groups, tag keys, tag values, regions), a partitioned count and one route
probe per region. AWS has no resource groups, so that dimension is empty; the regions are the
scope instead.

Each service's describe API is called once per region — not Resource Explorer or AWS Config,
which need customer setup and silently miss resources when it is off. Resource types use
CloudFormation's names (`AWS::EC2::Instance`), AWS's own stable vocabulary.

**AWS-created defaults.** Every region of every account starts with a default VPC, one
default subnet per zone and a `default` security group per VPC. Counting them would make
every enabled region look occupied. They are counted only in a region that holds something
else — an instance, a volume, a database or an Elastic IP — where they may actually be in
use; a region with nothing else in it is empty.

**A refused region is stated, not hidden.** An `AccessDenied` — typically an SCP that blocks
the region — marks that region `refused` with status 403. Whatever the other services in it
answered is still counted.
"""

from __future__ import annotations

import asyncio
from collections import Counter
from collections.abc import Callable, Iterable, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final

from reporting_agent.aws.session import ClientFactory

__all__ = [
    "CHILD_TYPES",
    "TYPE_EIP",
    "TYPE_INSTANCE",
    "TYPE_RDS_INSTANCE",
    "TYPE_SECURITY_GROUP",
    "TYPE_SUBNET",
    "TYPE_VOLUME",
    "TYPE_VPC",
    "AwsInventory",
    "Found",
    "RegionScan",
    "summarize",
]

TYPE_INSTANCE: Final[str] = "AWS::EC2::Instance"
TYPE_VOLUME: Final[str] = "AWS::EC2::Volume"
TYPE_RDS_INSTANCE: Final[str] = "AWS::RDS::DBInstance"
TYPE_VPC: Final[str] = "AWS::EC2::VPC"
TYPE_SUBNET: Final[str] = "AWS::EC2::Subnet"
TYPE_SECURITY_GROUP: Final[str] = "AWS::EC2::SecurityGroup"
TYPE_EIP: Final[str] = "AWS::EC2::EIP"

CHILD_TYPES: Final[frozenset[str]] = frozenset({TYPE_SUBNET})
"""Addressable, but not deployed things — the Azure scan counts subnets the same way."""

WORKLOAD_TYPES: Final[frozenset[str]] = frozenset({TYPE_INSTANCE, TYPE_VOLUME, TYPE_RDS_INSTANCE, TYPE_EIP})
DISTINCT_VALUE_LIMIT: Final[int] = 2000

VERDICT_REACHABLE: Final[str] = "reachable"
VERDICT_REFUSED: Final[str] = "refused"
VERDICT_UNKNOWN: Final[str] = "unknown"
_REFUSAL_CODES: Final[frozenset[str]] = frozenset(
    {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "AuthFailure"}
)


@dataclass(frozen=True, slots=True)
class Found:
    """One resource the scan saw. `default` marks an AWS-created default."""

    resource_type: str
    tags: tuple[tuple[str, str], ...] = ()
    default: bool = False


@dataclass(slots=True)
class RegionScan:
    region: str
    found: list[Found] = field(default_factory=list)
    status_code: int = 200
    verdict: str = VERDICT_REACHABLE


def _tags(raw: Iterable[dict[str, Any]] | None) -> tuple[tuple[str, str], ...]:
    return tuple(
        (str(tag.get("Key", "")), str(tag.get("Value", "")))
        for tag in raw or ()
        if tag.get("Key")
    )


def _paged(client: Any, operation: str, key: str, **kwargs: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for page in client.get_paginator(operation).paginate(**kwargs):
        items.extend(page.get(key, []))
    return items


def _instances(ec2: Any) -> list[Found]:
    found: list[Found] = []
    for reservation in _paged(ec2, "describe_instances", "Reservations"):
        for instance in reservation.get("Instances", []):
            if instance.get("State", {}).get("Name") in ("terminated", "shutting-down"):
                continue
            found.append(Found(TYPE_INSTANCE, _tags(instance.get("Tags"))))
    return found


def _volumes(ec2: Any) -> list[Found]:
    return [Found(TYPE_VOLUME, _tags(v.get("Tags"))) for v in _paged(ec2, "describe_volumes", "Volumes")]


def _addresses(ec2: Any) -> list[Found]:
    answer = ec2.describe_addresses()
    return [Found(TYPE_EIP, _tags(a.get("Tags"))) for a in answer.get("Addresses", [])]


def _network(ec2: Any) -> list[Found]:
    found = [
        Found(TYPE_VPC, _tags(v.get("Tags")), default=bool(v.get("IsDefault")))
        for v in _paged(ec2, "describe_vpcs", "Vpcs")
    ]
    found.extend(
        Found(TYPE_SUBNET, _tags(s.get("Tags")), default=bool(s.get("DefaultForAz")))
        for s in _paged(ec2, "describe_subnets", "Subnets")
    )
    # Every VPC gets a security group named `default` that cannot be deleted.
    found.extend(
        Found(TYPE_SECURITY_GROUP, _tags(g.get("Tags")), default=g.get("GroupName") == "default")
        for g in _paged(ec2, "describe_security_groups", "SecurityGroups")
    )
    return found


def _databases(rds: Any) -> list[Found]:
    return [
        Found(TYPE_RDS_INSTANCE, _tags(db.get("TagList")))
        for db in _paged(rds, "describe_db_instances", "DBInstances")
    ]


class AwsInventory:
    """Scans regions concurrently; each region's services concurrently within it."""

    def __init__(self, clients: ClientFactory) -> None:
        self._clients = clients

    async def scan(self, regions: Sequence[str]) -> list[RegionScan]:
        return list(await asyncio.gather(*(self._region(region) for region in regions)))

    async def _region(self, region: str) -> RegionScan:
        from botocore.exceptions import BotoCoreError, ClientError

        scan = RegionScan(region)
        readers: list[tuple[str, Callable[[Any], list[Found]]]] = [
            ("ec2", _instances),
            ("ec2", _volumes),
            ("ec2", _addresses),
            ("ec2", _network),
            ("rds", _databases),
        ]

        async def run(service: str, reader: Callable[[Any], list[Found]]) -> list[Found] | Exception:
            try:
                client = self._clients(service, region)
                return await asyncio.to_thread(reader, client)
            except (ClientError, BotoCoreError) as exc:
                return exc

        for outcome in await asyncio.gather(*(run(service, reader) for service, reader in readers)):
            if isinstance(outcome, list):
                scan.found.extend(outcome)
                continue
            code = outcome.response.get("Error", {}).get("Code", "") if isinstance(outcome, ClientError) else ""
            if code in _REFUSAL_CODES:
                scan.status_code, scan.verdict = 403, VERDICT_REFUSED
            elif scan.verdict != VERDICT_REFUSED:
                status = outcome.response.get("ResponseMetadata", {}).get("HTTPStatusCode", 0) if isinstance(outcome, ClientError) else 0
                scan.status_code, scan.verdict = int(status or 0), VERDICT_UNKNOWN
        return scan


def _counted(scan: RegionScan) -> list[Found]:
    """The region's resources, dropping AWS-created defaults from a region with no workload."""
    occupied = any(found.resource_type in WORKLOAD_TYPES for found in scan.found)
    return [found for found in scan.found if occupied or not found.default]


def _dimension(values: Iterable[str]) -> dict[str, Any]:
    distinct = sorted({value for value in values if value})
    return {"values": distinct[:DISTINCT_VALUE_LIMIT], "truncated": len(distinct) > DISTINCT_VALUE_LIMIT}


def summarize(scans: Sequence[RegionScan], *, probed_at: datetime | None = None) -> dict[str, Any]:
    """The `list_inventory` outcome for AWS. **Pure.**

    The same keys the Azure scan writes, so the app reads one shape for both providers.
    """
    when = (probed_at or datetime.now(UTC)).isoformat(timespec="seconds").replace("+00:00", "Z")
    types: Counter[str] = Counter()
    children: Counter[str] = Counter()
    regions: Counter[str] = Counter()
    tag_keys: set[str] = set()
    tag_values: set[str] = set()

    for scan in scans:
        for found in _counted(scan):
            if found.resource_type in CHILD_TYPES:
                children[found.resource_type] += 1
            else:
                types[found.resource_type] += 1
                regions[scan.region] += 1
            for key, value in found.tags:
                tag_keys.add(key)
                tag_values.add(value)

    return {
        "resource_types": _dimension([*types, *children]),
        "resource_groups": _dimension(()),
        "tag_keys": _dimension(tag_keys),
        "tag_values": _dimension(tag_values),
        "regions": _dimension(regions),
        "resource_count": sum(types.values()),
        "type_counts": dict(sorted(types.items())),
        "child_type_counts": dict(sorted(children.items())),
        "region_counts": dict(sorted(regions.items())),
        "region_probes": [
            {"region": scan.region, "status_code": scan.status_code, "verdict": scan.verdict, "probed_at": when}
            for scan in sorted(scans, key=lambda scan: scan.region)
        ],
    }
