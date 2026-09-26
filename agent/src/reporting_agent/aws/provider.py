"""`providers.base.Provider` for AWS: discover by region, collect from CloudWatch.

The same contract the Azure provider keeps, so `collect/pipeline.py`, the snapshot and the
verifier do not know which cloud they are reading:

* **discover** calls each service's describe API in every region the run covers — the
  scope's `regions`, or every region the account has enabled — and returns
  `ResourceRecord`s keyed by ARN, `location` the region and `resource_group` empty, since AWS
  has none. A stopped instance or database stays in the inventory with a `deallocated` gap,
  and `providers.base.is_excluded_from_averages` keeps it out of every average.
* **collect** groups by `(region, resource type)`, builds one accumulator per
  `(resource, metric)` from the catalog, and hands the group to `aws/metrics.py`, which
  requests, archives and folds. Finalization is `collect/finalize.py`'s, exactly as Azure's.
* **capabilities** names only the catalog's AWS types (`AWS::…`).

Resource types covered today: EC2 instances, EBS volumes and RDS instances — the ones the
catalog has metrics for. Networks, security groups and addresses are facts, not metrics,
and arrive with the AWS report sections.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, Final

from reporting_agent.aws.facts import (
    AWS_BACKUP_SOURCE,
    AWS_FACT_SOURCE,
    COMPUTE_OPTIMIZER_SOURCE,
    backup_items,
    fact_items,
    instance_types_needed,
    optimizer_items,
)
from reporting_agent.aws.metrics import DIMENSION_BY_TYPE, CloudWatchCollector
from reporting_agent.catalog.loader import (
    FactDeclaration,
    LoadedCatalog,
    ResourceTypeFacts,
    load_catalog,
)
from reporting_agent.collect.accumulate import MetricAccumulator, new_accumulator
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.buckets import BASE_GRAIN, FALLBACK_GRAIN, resolve_timezone
from reporting_agent.collect.dayfold import DayFold
from reporting_agent.collect.factfold import FACT_KIND_FACTS, fold_fact_response
from reporting_agent.collect.finalize import finalize_resource
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_REGION_UNREACHABLE,
    record_gap,
)
from reporting_agent.collect.snapshot import rfc3339_utc
from reporting_agent.providers.base import (
    AWS_STOPPED_STATE_CODES,
    Capabilities,
    CollectRequest,
    CollectResult,
    DiscoverResult,
    FactRequest,
    FactResult,
    GapRecord,
    LocationRouting,
    PlainData,
    Provider,
    RawArchiveState,
    ResourceRecord,
    ScopeSpec,
    StatValue,
    assert_plain_data,
    is_aws_resource_type,
    is_excluded_from_averages,
    sort_inventory,
)
from reporting_agent.storage.base import ObjectStore

__all__ = ["AwsProvider", "build_provider", "normalize_aws_state"]

logger = logging.getLogger(__name__)

FIDELITY_BASELINE: Final[str] = "baseline"
FIDELITY_ENHANCED: Final[str] = "enhanced"

TYPE_INSTANCE: Final[str] = "AWS::EC2::Instance"
TYPE_VOLUME: Final[str] = "AWS::EC2::Volume"
TYPE_RDS_INSTANCE: Final[str] = "AWS::RDS::DBInstance"
TYPE_VPC: Final[str] = "AWS::EC2::VPC"
TYPE_SUBNET: Final[str] = "AWS::EC2::Subnet"
TYPE_EIP: Final[str] = "AWS::EC2::EIP"
TYPE_SECURITY_GROUP: Final[str] = "AWS::EC2::SecurityGroup"
TYPE_SECURITY_GROUP_RULE: Final[str] = "AWS::EC2::SecurityGroupRule"

CHILD_OF: Final[Mapping[str, str]] = {
    TYPE_SUBNET: TYPE_VPC,
    TYPE_SECURITY_GROUP_RULE: TYPE_SECURITY_GROUP,
}
"""A child type and its parent's, as `facts.v1.json` declares `child_of`.

A child's id nests under its parent's ARN — `…:vpc/vpc-1/subnet/subnet-9`,
`…:security-group/sg-1/security-group-rule/sgr-2` — because a report finds a parent's
children by id containment, which is how Azure's ids already read. These ids name records
in the snapshot; nothing ever sends one to AWS, where a subnet's own ARN does not nest.
"""

_STATE_NORMAL: Final[Mapping[str, str]] = {
    "ec2:pending": "starting",
    "ec2:running": "running",
    "ec2:stopping": "stopping",
    "ec2:stopped": "stopped",
    "rds:starting": "starting",
    "rds:available": "running",
    "rds:backing-up": "running",
    "rds:modifying": "running",
    "rds:storage-optimization": "running",
    "rds:stopping": "stopping",
    "rds:stopped": "stopped",
}

_REFUSALS: Final[frozenset[str]] = frozenset(
    {"AccessDenied", "AccessDeniedException", "UnauthorizedOperation", "AuthFailure"}
)


def normalize_aws_state(raw: str) -> str:
    """`running`, `stopped`, `stopping`, `starting` or `unknown` — the Azure vocabulary."""
    return _STATE_NORMAL.get(raw, "unknown")


def _tags(raw: Iterable[Mapping[str, Any]] | None) -> dict[str, str]:
    return {str(tag["Key"]): str(tag.get("Value", "")) for tag in raw or () if tag.get("Key")}


def _paged(client: Any, operation: str, key: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    for page in client.get_paginator(operation).paginate():
        items.extend(page.get(key, []))
    return items


def _record(
    *, resource_id: str, name: str, resource_type: str, region: str, tags: dict[str, str], sku: str, state: str, tier: str
) -> ResourceRecord:
    return ResourceRecord(
        resource_id=resource_id,
        name=name,
        resource_type=resource_type,
        location=region,
        resource_group="",
        tags=tags,
        sku_name=sku,
        power_state_raw=state,
        power_state=normalize_aws_state(state) if state else "unknown",
        fidelity_tier=tier,
    )


def _instances(ec2: Any, *, account: str, region: str, tier: str, raw: dict[str, dict[str, Any]]) -> list[ResourceRecord]:
    records = []
    for reservation in _paged(ec2, "describe_instances", "Reservations"):
        for instance in reservation.get("Instances", []):
            state = instance.get("State", {}).get("Name", "")
            if state in ("terminated", "shutting-down"):
                continue
            tags = _tags(instance.get("Tags"))
            instance_id = instance["InstanceId"]
            resource_id = f"arn:aws:ec2:{region}:{account}:instance/{instance_id}"
            raw[resource_id] = {**instance, "_kind": "instance", "_region": region}
            records.append(
                _record(
                    resource_id=resource_id,
                    name=tags.get("Name") or instance_id,
                    resource_type=TYPE_INSTANCE,
                    region=region,
                    tags=tags,
                    sku=instance.get("InstanceType", ""),
                    state=f"ec2:{state}",
                    tier=tier,
                )
            )
    return records


def _volumes(ec2: Any, *, account: str, region: str, tier: str, raw: dict[str, dict[str, Any]]) -> list[ResourceRecord]:
    records = []
    for volume in _paged(ec2, "describe_volumes", "Volumes"):
        tags = _tags(volume.get("Tags"))
        volume_id = volume["VolumeId"]
        resource_id = f"arn:aws:ec2:{region}:{account}:volume/{volume_id}"
        raw[resource_id] = {**volume, "_kind": "volume", "_region": region}
        records.append(
            _record(
                resource_id=resource_id,
                name=tags.get("Name") or volume_id,
                resource_type=TYPE_VOLUME,
                region=region,
                tags=tags,
                sku=volume.get("VolumeType", ""),
                state="",
                tier=tier,
            )
        )
    return records


def _databases(rds: Any, *, account: str, region: str, tier: str, raw: dict[str, dict[str, Any]]) -> list[ResourceRecord]:
    del account  # RDS returns its own ARN
    databases = _paged(rds, "describe_db_instances", "DBInstances")
    for db in databases:
        raw[db["DBInstanceArn"]] = {**db, "_kind": "database", "_region": region}
    return [
        _record(
            resource_id=db["DBInstanceArn"],
            name=db["DBInstanceIdentifier"],
            resource_type=TYPE_RDS_INSTANCE,
            region=region,
            tags=_tags(db.get("TagList")),
            sku=db.get("DBInstanceClass", ""),
            state=f"rds:{db.get('DBInstanceStatus', '')}",
            tier=tier,
        )
        for db in databases
    ]


def _vpcs(ec2: Any, *, account: str, region: str, tier: str, raw: dict[str, dict[str, Any]]) -> list[ResourceRecord]:
    """Every VPC, and each one's subnets nested under it."""
    records = []
    by_vpc: dict[str, str] = {}
    for vpc in _paged(ec2, "describe_vpcs", "Vpcs"):
        tags = _tags(vpc.get("Tags"))
        resource_id = f"arn:aws:ec2:{region}:{account}:vpc/{vpc['VpcId']}"
        by_vpc[vpc["VpcId"]] = resource_id
        raw[resource_id] = {**vpc, "_kind": "vpc", "_region": region}
        records.append(_record(resource_id=resource_id, name=tags.get("Name") or vpc["VpcId"], resource_type=TYPE_VPC,
                               region=region, tags=tags, sku="", state="", tier=tier))
    for subnet in _paged(ec2, "describe_subnets", "Subnets"):
        parent = by_vpc.get(subnet.get("VpcId", ""))
        if parent is None:
            continue
        tags = _tags(subnet.get("Tags"))
        resource_id = f"{parent}/subnet/{subnet['SubnetId']}"
        raw[resource_id] = {**subnet, "_kind": "subnet", "_region": region}
        records.append(_record(resource_id=resource_id, name=tags.get("Name") or subnet["SubnetId"],
                               resource_type=TYPE_SUBNET, region=region, tags=tags, sku="", state="", tier=tier))
    return records


def _addresses(ec2: Any, *, account: str, region: str, tier: str, raw: dict[str, dict[str, Any]]) -> list[ResourceRecord]:
    records = []
    for address in ec2.describe_addresses().get("Addresses", []):
        allocation = address.get("AllocationId") or address.get("PublicIp", "")
        tags = _tags(address.get("Tags"))
        resource_id = f"arn:aws:ec2:{region}:{account}:elastic-ip/{allocation}"
        raw[resource_id] = {**address, "_kind": "eip", "_region": region}
        records.append(_record(resource_id=resource_id, name=tags.get("Name") or address.get("PublicIp", allocation),
                               resource_type=TYPE_EIP, region=region, tags=tags, sku="", state="", tier=tier))
    return records


def _security_groups(ec2: Any, *, account: str, region: str, tier: str, raw: dict[str, dict[str, Any]]) -> list[ResourceRecord]:
    """The security groups attached to a network interface, and each one's rules.

    Only groups **in use**: an account accumulates groups nothing references — left behind
    by stacks, clusters and wizards — and a report listing every rule of every one of them
    buries the ones that guard something. The scan still counts them all.
    """
    in_use = {
        group["GroupId"]
        for interface in _paged(ec2, "describe_network_interfaces", "NetworkInterfaces")
        for group in interface.get("Groups", [])
    }
    records = []
    by_group: dict[str, str] = {}
    for group in _paged(ec2, "describe_security_groups", "SecurityGroups"):
        if group["GroupId"] not in in_use:
            continue
        tags = _tags(group.get("Tags"))
        resource_id = f"arn:aws:ec2:{region}:{account}:security-group/{group['GroupId']}"
        by_group[group["GroupId"]] = resource_id
        raw[resource_id] = {**group, "_kind": "security_group", "_region": region}
        records.append(_record(resource_id=resource_id, name=group.get("GroupName") or group["GroupId"],
                               resource_type=TYPE_SECURITY_GROUP, region=region, tags=tags, sku="", state="", tier=tier))
    for rule in _paged(ec2, "describe_security_group_rules", "SecurityGroupRules"):
        parent = by_group.get(rule.get("GroupId", ""))
        if parent is None:
            continue
        resource_id = f"{parent}/security-group-rule/{rule['SecurityGroupRuleId']}"
        raw[resource_id] = {**rule, "_kind": "security_group_rule", "_region": region}
        records.append(_record(resource_id=resource_id, name=rule["SecurityGroupRuleId"],
                               resource_type=TYPE_SECURITY_GROUP_RULE, region=region, tags=_tags(rule.get("Tags")),
                               sku="", state="", tier=tier))
    return records


_READERS: Final[tuple[tuple[str, str, Callable[..., list[ResourceRecord]]], ...]] = (
    (TYPE_INSTANCE, "ec2", _instances),
    (TYPE_VOLUME, "ec2", _volumes),
    (TYPE_RDS_INSTANCE, "rds", _databases),
    (TYPE_VPC, "ec2", _vpcs),
    (TYPE_EIP, "ec2", _addresses),
    (TYPE_SECURITY_GROUP, "ec2", _security_groups),
)


def _source_declaration(declaration: FactDeclaration, source: str) -> FactDeclaration:
    """The declaration narrowed to one source, the only one a response answers for."""
    return FactDeclaration(
        resource_types=tuple(
            ResourceTypeFacts(
                resource_type=declared.resource_type,
                facts=tuple(entry for entry in declared.facts if entry.source == source),
            )
            for declared in declaration.resource_types
        )
    )


def _unique_names(resources: list[ResourceRecord]) -> list[ResourceRecord]:
    """Names that identify one resource each. **Pure.**

    An Azure name is unique within its resource group; an AWS `Name` tag is free text, and two
    instances launched from one template commonly share it — as does the volume the launch
    tagged alongside them. A report addresses a row by the resource's name, and the backups
    table lists instances, volumes and databases together, so a name repeated **anywhere**
    gains the resource's own id — `web (i-0abc…)` — and a name nobody else holds is left
    exactly as it was.
    """
    counts: dict[str, int] = {}
    for resource in resources:
        counts[resource["name"]] = counts.get(resource["name"], 0) + 1
    unique: list[ResourceRecord] = []
    for resource in resources:
        if counts[resource["name"]] > 1:
            own_id = resource["resource_id"].rsplit("/", 1)[-1].rsplit(":", 1)[-1]
            if own_id != resource["name"]:
                resource = ResourceRecord(**{**resource, "name": f"{resource['name']} ({own_id})"})
        unique.append(resource)
    return unique


def _in_scope(resource: ResourceRecord, scope: ScopeSpec) -> bool:
    types = scope.get("resource_types") or []
    parent_type = CHILD_OF.get(resource["resource_type"])
    if parent_type is not None:
        # A subnet or a rule follows its parent: in scope when its parent's type is, and
        # dropped below with a parent that did not survive the scope.
        return not types or parent_type in types
    if types and resource["resource_type"] not in types:
        return False
    ids = scope.get("resource_ids") or []
    if ids and resource["resource_id"] not in ids:
        return False
    tags = resource["tags"]
    return all(tags.get(key) == value for key, value in (scope.get("tag_filters") or {}).items())


@dataclass(slots=True)
class AwsProvider:
    """One invocation's AWS provider, over a client factory (tests hand it fakes)."""

    clients: Callable[[str, str], Any]
    catalog: LoadedCatalog
    object_store: ObjectStore
    account_id: str
    actor_id: str
    run_id: str
    home_region: str
    fidelity_tier: str = FIDELITY_BASELINE
    concurrency: int = 4
    clock: Callable[[], datetime] = field(default=lambda: datetime.now(UTC), repr=False)
    """Each fact response's receipt instant; a seam, because it enters the snapshot's digest."""
    _archive: ArchiveWriter | None = field(default=None, repr=False)
    _raw: dict[str, dict[str, Any]] = field(default_factory=dict, repr=False)
    """Discovery's describe item per resource id, kept for the fact pass."""

    @property
    def archive(self) -> ArchiveWriter:
        if self._archive is None:
            self._archive = ArchiveWriter(store=self.object_store)
        return self._archive

    # --- discover -------------------------------------------------------------------

    async def _regions(self, scope: ScopeSpec) -> list[str]:
        named = scope.get("regions") or []
        if named:
            return sorted(set(named))
        ec2 = self.clients("ec2", self.home_region)
        answer = await asyncio.to_thread(ec2.describe_regions, AllRegions=False)
        return sorted(region["RegionName"] for region in answer.get("Regions", []))

    async def discover(self, scope: ScopeSpec) -> DiscoverResult:
        from botocore.exceptions import BotoCoreError, ClientError

        regions = await self._regions(scope)
        wanted = set(scope.get("resource_types") or []) or {t for t, _, _ in _READERS}
        gaps: list[GapRecord] = []
        found: list[ResourceRecord] = []

        async def read(region: str, service: str, reader: Callable[..., list[ResourceRecord]]) -> None:
            try:
                client = self.clients(service, region)
                records = await asyncio.to_thread(
                    reader, client, account=self.account_id, region=region, tier=self.fidelity_tier, raw=self._raw
                )
            except (ClientError, BotoCoreError) as exc:
                code = exc.response.get("Error", {}).get("Code", "") if isinstance(exc, ClientError) else type(exc).__name__
                logger.warning("aws discover: %s in %s failed (%s)", service, region, code)
                gaps.append(
                    record_gap(
                        GAP_TYPE_REGION_UNREACHABLE,
                        f"arn:aws:{service}:{region}:{self.account_id}:region",
                        None,
                        f"listing {service} resources in {region} failed ({code})"
                        + ("; the role or an organization policy refuses this region." if code in _REFUSALS else "."),
                    )
                )
                return
            found.extend(records)

        await asyncio.gather(
            *(read(region, service, reader) for region in regions for t, service, reader in _READERS if t in wanted)
        )

        kept = [resource for resource in found if _in_scope(resource, scope)]
        parents = {resource["resource_id"] for resource in kept if resource["resource_type"] not in CHILD_OF}
        kept = [
            resource
            for resource in kept
            if resource["resource_type"] not in CHILD_OF or resource["resource_id"].rsplit("/", 2)[0] in parents
        ]
        resources = sort_inventory(_unique_names(kept))
        for resource in resources:
            if resource["power_state_raw"] in AWS_STOPPED_STATE_CODES:
                gaps.append(record_gap(GAP_TYPE_DEALLOCATED, resource["resource_id"], None, resource["power_state_raw"]))
        result = DiscoverResult(resources=resources, gaps=gaps)
        assert_plain_data(result)
        return result

    # --- facts ----------------------------------------------------------------------

    async def collect_facts(self, request: FactRequest) -> FactResult:
        """What each resource is, in three passes, one per source (`aws/facts.py`).

        * **`aws`** — discovery's own describe items, plus `DescribeInstanceTypes` once per
          region for vCPUs and memory.
        * **`aws_backup`** — `ListProtectedResources` per region: the last backup and its
          vault for each EC2 instance, EBS volume and RDS database AWS Backup protects.
        * **`compute_optimizer`** — `GetEC2InstanceRecommendations` per region. An account
          that has not enrolled answers `OptInRequiredException`, which is an answer — no
          finding exists — rather than a failed request.

        Each pass is archived before it is folded, with only its own source's keys, so the
        replay narrows to exactly what that response could have answered.
        """
        resources = request["resources"]
        types_by_id = {resource["resource_id"]: resource["resource_type"] for resource in resources}
        resource_ids = sorted(types_by_id)
        if not resource_ids:
            return FactResult(facts=[], gaps=[])
        regions = sorted({resource["location"] for resource in resources})

        instance_types: dict[str, dict[str, Any]] = {}

        async def describe_types(region: str, names: set[str]) -> None:
            answer = await self._optional_call("ec2", region, "describe_instance_types", InstanceTypes=sorted(names))
            for spec in (answer or {}).get("InstanceTypes", []):
                instance_types[str(spec.get("InstanceType"))] = spec

        needed = instance_types_needed({rid: self._raw[rid] for rid in resource_ids if rid in self._raw})
        await asyncio.gather(*(describe_types(region, names) for region, names in sorted(needed.items())))

        facts: list[Any] = []
        gaps: list[GapRecord] = []

        async def fold(source: str, covered: Sequence[str], body: PlainData) -> None:
            declaration = _source_declaration(self.catalog.facts, source)
            if not covered or not declaration.entries:
                return
            received_at = rfc3339_utc(self.clock())
            written = await self.archive.write_facts(
                actor_id=self.actor_id,
                run_id=self.run_id,
                source=source,
                request_target=source,
                fact_keys=sorted({entry.key for entry in declaration.entries}),
                received_at=received_at,
                catalog_version=self.catalog.catalog_version,
                resource_ids=list(covered),
                raw_body=body,
            )
            folded, fold_gaps = fold_fact_response(
                body,
                kind=FACT_KIND_FACTS,
                source=source,
                resource_ids=list(covered),
                declaration=declaration,
                resource_types=types_by_id,
                received_at=received_at,
            )
            facts.extend(folded)
            gaps.extend((*written.gaps, *fold_gaps))

        await fold(AWS_FACT_SOURCE, resource_ids, {"value": fact_items(resource_ids, self._raw, instance_types)})

        backed_up = [rid for rid in resource_ids if types_by_id[rid] in (TYPE_INSTANCE, TYPE_VOLUME, TYPE_RDS_INSTANCE)]
        if backed_up:
            answers = await asyncio.gather(
                *(self._optional_call("backup", region, "list_protected_resources", paged="Results") for region in regions)
            )
            body: PlainData = (
                None if any(answer is None for answer in answers)
                else {"value": backup_items([entry for answer in answers for entry in answer["Results"]])}
            )
            await fold(AWS_BACKUP_SOURCE, backed_up, body)

        instances = [rid for rid in resource_ids if types_by_id[rid] == TYPE_INSTANCE]
        if instances:
            answers = await asyncio.gather(
                *(
                    self._optional_call(
                        "compute-optimizer", region, "get_ec2_instance_recommendations",
                        not_enrolled_is_empty=True, list_key="instanceRecommendations",
                    )
                    for region in regions
                )
            )
            body = (
                None if any(answer is None for answer in answers)
                else {"value": optimizer_items([entry for answer in answers for entry in answer["instanceRecommendations"]])}
            )
            await fold(COMPUTE_OPTIMIZER_SOURCE, instances, body)

        result = FactResult(facts=facts, gaps=gaps)
        assert_plain_data(result)
        return result

    async def _optional_call(
        self,
        service: str,
        region: str,
        operation: str,
        *,
        paged: str | None = None,
        not_enrolled_is_empty: bool = False,
        list_key: str = "",
        **kwargs: Any,
    ) -> dict[str, Any] | None:
        """One call's answer, or `None` when it failed — which the fold records as
        `fact_unavailable`, never as an absence."""
        from botocore.exceptions import BotoCoreError, ClientError

        def call() -> dict[str, Any]:
            client = self.clients(service, region)
            if paged:
                return {paged: _paged(client, operation, paged)}
            return getattr(client, operation)(**kwargs)

        try:
            return await asyncio.to_thread(call)
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            if not_enrolled_is_empty and code == "OptInRequiredException":
                return {list_key: []}
            logger.warning("aws facts: %s.%s in %s failed (%s)", service, operation, region, code)
            return None
        except BotoCoreError as exc:
            logger.warning("aws facts: %s.%s in %s failed (%s)", service, operation, region, type(exc).__name__)
            return None

    # --- collect --------------------------------------------------------------------

    async def collect(self, request: CollectRequest) -> CollectResult:
        grain = request["grain"]
        window = dict(request["window"])
        metrics_by_type = request["metrics_by_resource_type"]
        day_fold = DayFold(tz=resolve_timezone(request["timezone"]))
        archive = self.archive if request.get("archive", True) is not False else ArchiveWriter(
            store=self.object_store, records=False
        )
        collector = CloudWatchCollector(
            clients=self.clients,
            archive_writer=archive,
            account_id=self.account_id,
            semaphore=asyncio.Semaphore(self.concurrency),
        )

        groups: dict[tuple[str, str], list[ResourceRecord]] = {}
        for resource in request["resources"]:
            groups.setdefault((resource["location"], resource["resource_type"]), []).append(resource)

        gaps: list[GapRecord] = []
        statistics: dict[str, dict[str, dict[str, StatValue]]] = {}
        day_statistics: dict[str, dict[str, list[StatValue]]] = {}
        unreachable: set[str] = set()

        async def one(key: tuple[str, str], members: list[ResourceRecord]) -> None:
            region, resource_type = key
            group_gaps, reachable = await self._collect_group(
                collector=collector,
                region=region,
                resource_type=resource_type,
                resources=sorted(members, key=lambda r: r["resource_id"]),
                requested=metrics_by_type.get(resource_type) or [],
                grain=grain,
                window=window,
                day_fold=day_fold,
                statistics=statistics,
                day_statistics=day_statistics,
            )
            gaps.extend(group_gaps)
            if not reachable:
                unreachable.add(region)

        await asyncio.gather(*(one(key, groups[key]) for key in sorted(groups)))

        collected = CollectResult(
            statistics=statistics,
            gaps=gaps,
            day_statistics=day_statistics,
            sku_capacities={},
            raw_archive=RawArchiveState(complete=not archive.archive_incomplete, object_count=archive.object_count),
            locations=LocationRouting(requested=sorted({region for region, _ in groups}), unreachable=sorted(unreachable)),
        )
        assert_plain_data(collected)
        return collected

    async def _collect_group(
        self,
        *,
        collector: CloudWatchCollector,
        region: str,
        resource_type: str,
        resources: Sequence[ResourceRecord],
        requested: Sequence[str],
        grain: str,
        window: Mapping[str, str],
        day_fold: DayFold,
        statistics: dict[str, dict[str, dict[str, StatValue]]],
        day_statistics: dict[str, dict[str, list[StatValue]]],
    ) -> tuple[list[GapRecord], bool]:
        resource_catalog = self.catalog.for_resource_type(resource_type)
        if resource_catalog is None or resource_type not in DIMENSION_BY_TYPE:
            return [], True
        declared = {metric.name: metric for metric in resource_catalog.metrics}
        selected = tuple(name for name in requested if name in declared)
        if not selected:
            return [], True

        gaps: list[GapRecord] = []
        accumulators: dict[tuple[str, str], MetricAccumulator] = {}
        for resource in resources:
            excluded = is_excluded_from_averages(resource)
            for name in selected:
                accumulator, gap = new_accumulator(
                    declared[name].unit_family,
                    resource_id=resource["resource_id"],
                    metric=name,
                    excluded=excluded,
                    aggregations=declared[name].aggregations,
                )
                accumulators[(resource["resource_id"], name)] = accumulator
                if gap is not None:
                    gaps.append(gap)

        group_gaps, reachable = await collector.collect_group(
            actor_id=self.actor_id,
            run_id=self.run_id,
            region=region,
            resource_type=resource_type,
            namespace=resource_catalog.metric_namespace,
            resource_ids=[resource["resource_id"] for resource in resources],
            metric_names=selected,
            aggregations_by_metric={name: declared[name].aggregations for name in selected},
            accumulators=accumulators,
            day_fold=day_fold,
            grain=grain,
            window=window,
        )
        gaps.extend(group_gaps)

        for resource in resources:
            resource_id = resource["resource_id"]
            tier = resource.get("fidelity_tier") or self.fidelity_tier
            entries, finalize_gaps = finalize_resource(
                resource_id=resource_id,
                fidelity_tier=tier,
                grain=grain,
                declared=declared,
                selected=selected,
                accumulators=accumulators,
                derived_entries=resource_catalog.derived,
                sku_capability_values={},
            )
            gaps.extend(finalize_gaps)
            if entries:
                by_metric: dict[str, dict[str, StatValue]] = {}
                for entry in entries:
                    by_metric.setdefault(entry.metric, {})[entry.statistic] = entry.to_plain_data()
                statistics[resource_id] = by_metric
            by_day = {
                local_day: [entry.to_plain_data() for entry in day_entries]
                for local_day, day_entries in day_fold.statistics_for(
                    resource_id, declared=declared, selected=selected, fidelity_tier=tier, grain=grain
                ).items()
            }
            if by_day:
                day_statistics[resource_id] = by_day
        return gaps, reachable

    # --- capabilities ---------------------------------------------------------------

    def capabilities(self) -> Capabilities:
        collectable = [
            entry
            for entry in self.catalog.resource_types
            if entry.has_valid_entries and is_aws_resource_type(entry.resource_type)
        ]
        return Capabilities(
            resource_types=sorted(entry.resource_type for entry in collectable),
            metrics={entry.resource_type: sorted(m.name for m in entry.metrics) for entry in collectable},
            grains=[BASE_GRAIN, FALLBACK_GRAIN],
            fidelity_tiers=[FIDELITY_BASELINE, FIDELITY_ENHANCED],
        )

    def close(self) -> None:
        """Nothing to release: the session's credentials expire on their own."""


def build_provider(
    context: Mapping[str, PlainData],
    *,
    object_store: ObjectStore | None = None,
    catalog: LoadedCatalog | None = None,
) -> Provider:
    """The AWS provider for one invocation, assuming the connector's reader role."""
    from reporting_agent.aws.session import assume_reader_role, client_factory
    from reporting_agent.config import Config

    config = Config.from_env()

    def text(name: str) -> str:
        value = context.get(name)
        if not isinstance(value, str) or not value.strip():
            raise ValueError(f"the invocation context carries no usable {name}; its value is excluded")
        return value

    account_id = text("subscription_id")
    actor_id = text("actor_id")
    session = assume_reader_role(
        role_arn=text("role_arn"),
        external_id=text("external_id"),
        account_id=account_id,
        actor_id=actor_id,
        region=config.aws_region,
    )
    if object_store is None:
        object_store = _default_object_store()
    tier = context.get("fidelity_tier")
    return AwsProvider(
        clients=client_factory(session),
        catalog=catalog if catalog is not None else load_catalog(),
        object_store=object_store,
        account_id=account_id,
        actor_id=actor_id,
        run_id=text("run_id"),
        home_region=config.aws_region,
        fidelity_tier=tier if tier in (FIDELITY_BASELINE, FIDELITY_ENHANCED) else FIDELITY_BASELINE,
    )


def _default_object_store() -> ObjectStore:
    """An `S3ObjectStore` over the configured artifact bucket, for a provider built straight
    from a context. `collect/pipeline.py` passes the run's own store instead."""
    from reporting_agent.config import Config
    from reporting_agent.storage.s3 import S3ObjectStore

    config = Config.from_env()
    return S3ObjectStore(config.artifact_bucket, region=config.aws_region)
