"""AWS facts: what each resource *is*, from the describe calls discovery already made.

A fact answers "what is this resource" — its instance type, its subnet, its engine — where a
metric answers "how much did it do". Discovery already holds every describe item it read, so
the fact pass costs one extra call per region (`DescribeInstanceTypes`, for vCPUs and
memory) and nothing else.

**Pure.** :func:`fact_items` turns the cached describe items into the per-resource item shape
`collect/factfold.py` reads — `{"resource_id": …, "<key>": value}` — and that list is what is
archived and what is folded, live and in replay alike, through the one fold every source uses.
A key a resource genuinely lacks is simply left out, so the fold records `fact_unavailable`
for it rather than this module inventing a value; a key whose absence *is* the answer — no
public address, attached to nothing — is written as that answer.

Values are bounded: a text value longer than :data:`MAX_TEXT` is cut and marked, so one
instance with forty security groups costs a cell rather than the run.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from datetime import datetime
from decimal import Decimal
from typing import Any, Final

__all__ = [
    "AWS_BACKUP_SOURCE",
    "AWS_FACT_SOURCE",
    "COMPUTE_OPTIMIZER_SOURCE",
    "MAX_TEXT",
    "backup_items",
    "fact_items",
    "instance_types_needed",
    "optimizer_items",
]

AWS_FACT_SOURCE: Final[str] = "aws"
AWS_BACKUP_SOURCE: Final[str] = "aws_backup"
COMPUTE_OPTIMIZER_SOURCE: Final[str] = "compute_optimizer"
MAX_TEXT: Final[int] = 240


def _bounded(value: str) -> str:
    return value if len(value) <= MAX_TEXT else value[: MAX_TEXT - 1] + "…"


def _gib(value: Decimal) -> str:
    """A capacity as the console shows it — `16 GiB`, `0.5 GiB` — a label, not a figure.

    Text rather than a numeric fact: a numeric fact renders its bare digits, and
    `17179869184` in a table is a number nobody reads. The describe APIs state these sizes
    in GiB (MiB for memory), so the text is their own unit, not a conversion.
    """
    text = format(value.normalize(), "f")
    return f"{text} GiB"


def _yes_no(value: object) -> str | None:
    return None if value is None else ("yes" if bool(value) else "no")


def _date(value: object) -> str | None:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, str) and len(value) >= 10:
        return value[:10]
    return None


def _put(item: dict[str, Any], key: str, value: object) -> None:
    """Keep a value only when there is one; the fold turns an omitted key into a gap."""
    if value is None:
        return
    if isinstance(value, str):
        if not value.strip():
            return
        value = _bounded(value)
    item[key] = value


def instance_types_needed(raw: Mapping[str, Mapping[str, Any]]) -> dict[str, set[str]]:
    """Every instance type discovery saw, by region — what `DescribeInstanceTypes` is asked."""
    needed: dict[str, set[str]] = {}
    for record in raw.values():
        if record.get("_kind") == "instance" and record.get("InstanceType"):
            needed.setdefault(record["_region"], set()).add(record["InstanceType"])
    return needed


def _instance(item: dict[str, Any], raw: Mapping[str, Any], types: Mapping[str, Mapping[str, Any]]) -> None:
    _put(item, "instance_type", raw.get("InstanceType"))
    platform = raw.get("PlatformDetails") or ("Windows" if raw.get("Platform") == "windows" else None)
    _put(item, "platform", platform)
    _put(item, "availability_zone", (raw.get("Placement") or {}).get("AvailabilityZone"))
    _put(item, "private_ip", raw.get("PrivateIpAddress"))
    _put(item, "public_ip", raw.get("PublicIpAddress") or "none")
    _put(item, "vpc", raw.get("VpcId"))
    _put(item, "subnet", raw.get("SubnetId"))
    groups = sorted(str(g.get("GroupName")) for g in raw.get("SecurityGroups") or [] if g.get("GroupName"))
    _put(item, "security_groups", ", ".join(groups) if groups else "none")
    _put(item, "launch_date", _date(raw.get("LaunchTime")))
    spec = types.get(str(raw.get("InstanceType")))
    if spec:
        vcpus = (spec.get("VCpuInfo") or {}).get("DefaultVCpus")
        memory = (spec.get("MemoryInfo") or {}).get("SizeInMiB")
        if isinstance(vcpus, int):
            item["vcpus"] = str(vcpus)
        if isinstance(memory, int):
            item["memory"] = _gib(Decimal(memory) / 1024)


def _volume(item: dict[str, Any], raw: Mapping[str, Any]) -> None:
    _put(item, "volume_type", raw.get("VolumeType"))
    if isinstance(raw.get("Size"), int):
        item["size"] = _gib(Decimal(raw["Size"]))
    if isinstance(raw.get("Iops"), int):
        item["iops"] = str(raw["Iops"])
    _put(item, "encrypted", _yes_no(raw.get("Encrypted")))
    attached = sorted(str(a.get("InstanceId")) for a in raw.get("Attachments") or [] if a.get("InstanceId"))
    _put(item, "attached_to", ", ".join(attached) if attached else "not attached")
    _put(item, "availability_zone", raw.get("AvailabilityZone"))
    _put(item, "volume_state", raw.get("State"))


def _database(item: dict[str, Any], raw: Mapping[str, Any]) -> None:
    _put(item, "engine", raw.get("Engine"))
    _put(item, "engine_version", raw.get("EngineVersion"))
    _put(item, "instance_class", raw.get("DBInstanceClass"))
    _put(item, "multi_az", _yes_no(raw.get("MultiAZ")))
    _put(item, "storage_type", raw.get("StorageType"))
    if isinstance(raw.get("AllocatedStorage"), int):
        item["allocated_storage"] = _gib(Decimal(raw["AllocatedStorage"]))
    if isinstance(raw.get("BackupRetentionPeriod"), int):
        item["backup_retention_days"] = str(raw["BackupRetentionPeriod"])
    _put(item, "availability_zone", raw.get("AvailabilityZone"))
    _put(item, "publicly_accessible", _yes_no(raw.get("PubliclyAccessible")))


def _vpc(item: dict[str, Any], raw: Mapping[str, Any]) -> None:
    _put(item, "cidr", raw.get("CidrBlock"))
    _put(item, "is_default", _yes_no(raw.get("IsDefault")))
    _put(item, "vpc_state", raw.get("State"))


def _subnet(item: dict[str, Any], raw: Mapping[str, Any]) -> None:
    _put(item, "cidr", raw.get("CidrBlock"))
    _put(item, "availability_zone", raw.get("AvailabilityZone"))
    if isinstance(raw.get("AvailableIpAddressCount"), int):
        item["available_ips"] = str(raw["AvailableIpAddressCount"])
    _put(item, "public_on_launch", _yes_no(raw.get("MapPublicIpOnLaunch")))


def _address(item: dict[str, Any], raw: Mapping[str, Any]) -> None:
    _put(item, "public_ip", raw.get("PublicIp"))
    _put(item, "attached_to", raw.get("InstanceId") or raw.get("NetworkInterfaceId") or "not attached")
    _put(item, "private_ip", raw.get("PrivateIpAddress") or "none")
    _put(item, "domain", raw.get("Domain"))


def _security_group(item: dict[str, Any], raw: Mapping[str, Any], rules: Sequence[Mapping[str, Any]]) -> None:
    _put(item, "vpc", raw.get("VpcId"))
    _put(item, "description", raw.get("Description"))
    own = [rule for rule in rules if rule.get("GroupId") == raw.get("GroupId")]
    item["inbound_rules"] = str(sum(1 for rule in own if not rule.get("IsEgress")))
    item["outbound_rules"] = str(sum(1 for rule in own if rule.get("IsEgress")))


def _ports(raw: Mapping[str, Any]) -> str:
    low, high = raw.get("FromPort"), raw.get("ToPort")
    if not isinstance(low, int) or not isinstance(high, int) or low == -1:
        return "all"
    return str(low) if low == high else f"{low}-{high}"


def _rule(item: dict[str, Any], raw: Mapping[str, Any]) -> None:
    item["direction"] = "outbound" if raw.get("IsEgress") else "inbound"
    protocol = str(raw.get("IpProtocol") or "")
    _put(item, "protocol", "all" if protocol == "-1" else protocol)
    _put(item, "ports", _ports(raw))
    referenced = (raw.get("ReferencedGroupInfo") or {}).get("GroupId")
    peer = raw.get("CidrIpv4") or raw.get("CidrIpv6") or referenced or raw.get("PrefixListId")
    _put(item, "peer", peer)
    _put(item, "description", raw.get("Description") or "none")


def fact_items(
    resource_ids: Sequence[str],
    raw: Mapping[str, Mapping[str, Any]],
    instance_types: Mapping[str, Mapping[str, Any]],
) -> list[dict[str, Any]]:
    """One item per resource, in resource-id order: the body archived and folded. **Pure.**

    `raw` is discovery's describe item per resource id, tagged with `_kind` and `_region`;
    `instance_types` is `DescribeInstanceTypes`' answer keyed by type name.
    """
    rules = [record for record in raw.values() if record.get("_kind") == "security_group_rule"]
    items: list[dict[str, Any]] = []
    for resource_id in sorted(resource_ids):
        record = raw.get(resource_id)
        if record is None:
            continue
        item: dict[str, Any] = {"resource_id": resource_id}
        kind = record.get("_kind")
        if kind == "instance":
            _instance(item, record, instance_types)
        elif kind == "volume":
            _volume(item, record)
        elif kind == "database":
            _database(item, record)
        elif kind == "vpc":
            _vpc(item, record)
        elif kind == "subnet":
            _subnet(item, record)
        elif kind == "eip":
            _address(item, record)
        elif kind == "security_group":
            _security_group(item, record, rules)
        elif kind == "security_group_rule":
            _rule(item, record)
        items.append(item)
    return items


def backup_items(protected: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """AWS Backup's protected resources as fact items. **Pure.**

    A resource AWS Backup does not list is simply absent here, which the fold records as
    `backup_not_configured` — an answer about the estate, not a failed request.
    """
    items = []
    for entry in sorted(protected, key=lambda e: str(e.get("ResourceArn"))):
        arn = entry.get("ResourceArn")
        if not isinstance(arn, str) or not arn:
            continue
        item: dict[str, Any] = {"resource_id": arn}
        _put(item, "last_backup", _date(entry.get("LastBackupTime")))
        vault = entry.get("LastBackupVaultArn")
        _put(item, "backup_vault", vault.rsplit(":", 1)[-1] if isinstance(vault, str) else None)
        items.append(item)
    return items


def optimizer_items(recommendations: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    """Compute Optimizer's EC2 findings as fact items. **Pure.**

    An instance with no recommendation — or every instance, in an account that has not
    enrolled — is absent here and becomes `optimizer_not_available`.
    """
    items = []
    for entry in sorted(recommendations, key=lambda e: str(e.get("instanceArn"))):
        arn = entry.get("instanceArn")
        if not isinstance(arn, str) or not arn:
            continue
        item: dict[str, Any] = {"resource_id": arn}
        _put(item, "rightsizing_finding", entry.get("finding"))
        options = sorted(entry.get("recommendationOptions") or [], key=lambda o: o.get("rank", 99))
        _put(item, "recommended_type", options[0].get("instanceType") if options else None)
        items.append(item)
    return items
