"""Who created each AWS resource, read from CloudTrail's event history. **Pure.**

The weekly ownership report names, for every live resource, the IAM user or role that
created it. CloudTrail's `LookupEvents` keeps 90 days of management events in every region
at no cost and with no setup, so that is the primary source; it is asked once per creation
event name per region (`RunInstances`, `CreateVolume`, …), never once per resource, because
the API allows two calls a second per region and an account's creation events are far fewer
than its resources' events.

When no creation event is found, three fallbacks are tried in order, each named in the
`creator_source` fact so a reader can weigh it:

1. **Inherited.** A root volume is created by `RunInstances`, not `CreateVolume`, so a volume
   created within minutes of the instance it is attached to takes that instance's creator.
   A VPC's `default` security group is created by `CreateVpc` and takes the VPC's creator.
2. **A tag** — `CreatedBy`, `Creator` or `Owner`, in any of their usual spellings. A tag is
   what someone wrote, not what AWS recorded, and the source says so.
3. **Unknown**, with the creation date when the describe call states one (volumes and
   databases do) and otherwise "before" the first day CloudTrail could still answer for.

Every resource gets every key, `Unknown` included: a resource whose creator was not found is
an answer the report prints, not a gap in it.

This module turns already-fetched events into fact items. The calls are made in
`aws/provider.py`, archived with these items, and the replay folds the archived body.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta, tzinfo
from typing import Any, Final

__all__ = [
    "CREATION_EVENTS",
    "LOOKBACK_DAYS",
    "LOOKUP_DENIED",
    "LOOKUP_FAILED",
    "LOOKUP_OK",
    "OWNERSHIP_KINDS",
    "OWNERSHIP_SOURCE",
    "STATUS_ACTIVE",
    "STATUS_DELETED",
    "STATUS_NOT_APPLICABLE",
    "STATUS_NOT_CHECKED",
    "UNKNOWN",
    "Creation",
    "Principal",
    "creation_index",
    "creations_from_events",
    "lookback_start_of",
    "ownership_items",
    "principal_of",
    "principals_to_check",
    "short_id",
]

OWNERSHIP_SOURCE: Final[str] = "aws_ownership"
LOOKBACK_DAYS: Final[int] = 90
"""How far back CloudTrail's event history answers, in every region, without a trail."""

UNKNOWN: Final[str] = "Unknown"

LOOKUP_OK: Final[str] = "ok"
LOOKUP_DENIED: Final[str] = "denied"
LOOKUP_FAILED: Final[str] = "failed"

STATUS_ACTIVE: Final[str] = "Active"
STATUS_DELETED: Final[str] = "Deleted"
STATUS_NOT_CHECKED: Final[str] = "Not checked"
STATUS_NOT_APPLICABLE: Final[str] = "Not applicable"

SOURCE_CLOUDTRAIL: Final[str] = "CloudTrail"
SOURCE_WITH_INSTANCE: Final[str] = "Launched with its instance"
SOURCE_WITH_VPC: Final[str] = "Created with its VPC"
SOURCE_TAG: Final[str] = "Tag"
SOURCE_NOT_FOUND: Final[str] = "No event in 90 days"
SOURCE_DENIED: Final[str] = "No CloudTrail access"
SOURCE_FAILED: Final[str] = "CloudTrail unavailable"

INHERIT_WINDOW: Final[timedelta] = timedelta(minutes=10)
"""How close a volume's creation must be to its instance's launch to count as launched with it."""

MAX_LABEL: Final[int] = 120

CREATION_EVENTS: Final[Mapping[str, tuple[str, ...]]] = {
    "instance": ("RunInstances",),
    "volume": ("CreateVolume",),
    "database": (
        "CreateDBInstance",
        "CreateDBInstanceReadReplica",
        "RestoreDBInstanceFromDBSnapshot",
        "RestoreDBInstanceToPointInTime",
        "RestoreDBInstanceFromS3",
    ),
    "vpc": ("CreateVpc", "CreateDefaultVpc"),
    "eip": ("AllocateAddress",),
    "security_group": ("CreateSecurityGroup",),
}
"""Discovery's `_kind` for each resource the report covers, and the events that create one."""

OWNERSHIP_KINDS: Final[frozenset[str]] = frozenset(CREATION_EVENTS)

_EVENT_KIND: Final[Mapping[str, str]] = {name: kind for kind, names in CREATION_EVENTS.items() for name in names}

_CREATOR_TAGS: Final[tuple[str, ...]] = ("createdby", "created-by", "created_by", "creator", "owner")
"""Tag keys read as a creator, compared case-insensitively, in this order of preference."""


@dataclass(frozen=True, slots=True)
class Principal:
    """Who made a call, as the report prints it."""

    label: str
    """`user/alice`, `role/DeployRole/github-actions`, `sso/alice@example.com`, `root`."""
    kind: str
    """`IAM user`, `IAM role`, `SSO user`, `Root user`, `AWS service`, `Federated user`."""
    iam: tuple[str, str] | None = None
    """`("user", name)` or `("role", name)` when IAM can say whether it still exists."""


@dataclass(frozen=True, slots=True)
class Creation:
    """One resource's creation event."""

    kind: str
    resource: str
    """The short id: `i-0abc…`, `vol-…`, `vpc-…`, `eipalloc-…`, `sg-…`, or a database identifier."""
    at: datetime
    principal: Principal


_DIGIT_LEADING: Final[re.Pattern[str]] = re.compile(r"(^|[\s/(])(?=\d)")


def _bounded(text: str) -> str:
    """A creator label, bounded, with no part that starts with a digit.

    The creator is the key column of the "who created what" table, plain text the verifier
    reads for numerals: `role/Deploy/1700000000` would leave a bare number it can match to
    nothing, and the report would be withheld. A part that starts with a digit is prefixed
    `id-`, which reads as the identifier it is.
    """
    text = _DIGIT_LEADING.sub(lambda match: f"{match.group(1)}id-", text)
    return text if len(text) <= MAX_LABEL else text[: MAX_LABEL - 1] + "…"


def principal_of(identity: Mapping[str, Any] | None) -> Principal:
    """A CloudTrail `userIdentity`, as the creator the report prints."""
    if not isinstance(identity, Mapping):
        return Principal(UNKNOWN, UNKNOWN)
    kind = str(identity.get("type") or "")
    if kind == "IAMUser":
        name = str(identity.get("userName") or "")
        return Principal(_bounded(f"user/{name}"), "IAM user", ("user", name)) if name else Principal(UNKNOWN, UNKNOWN)
    if kind == "AssumedRole":
        issuer = ((identity.get("sessionContext") or {}).get("sessionIssuer") or {})
        role = str(issuer.get("userName") or "")
        arn = str(identity.get("arn") or "")
        session = arn.rsplit("/", 1)[-1] if arn.count("/") >= 2 else ""
        if not role and arn.count("/") >= 2:
            role = arn.split("/")[-2]
        if not role:
            return Principal(UNKNOWN, UNKNOWN)
        if role.startswith("AWSReservedSSO_"):
            return Principal(_bounded(f"sso/{session or role}"), "SSO user")
        label = f"role/{role}/{session[:40]}" if session else f"role/{role}"
        return Principal(_bounded(label), "IAM role", ("role", role))
    if kind == "Root":
        return Principal("root", "Root user")
    if kind == "AWSService":
        service = str(identity.get("invokedBy") or "")
        return Principal(_bounded(f"service/{service}"), "AWS service") if service else Principal(UNKNOWN, UNKNOWN)
    if kind == "FederatedUser":
        arn = str(identity.get("arn") or "")
        name = arn.rsplit("/", 1)[-1] if "/" in arn else ""
        return Principal(_bounded(f"federated/{name}"), "Federated user") if name else Principal(UNKNOWN, UNKNOWN)
    return Principal(UNKNOWN, UNKNOWN)


def _created_ids(name: str, detail: Mapping[str, Any]) -> list[str]:
    response = detail.get("responseElements")
    request = detail.get("requestParameters")
    response = response if isinstance(response, Mapping) else {}
    request = request if isinstance(request, Mapping) else {}
    found: list[object]
    if name == "RunInstances":
        found = [item.get("instanceId") for item in ((response.get("instancesSet") or {}).get("items") or [])
                 if isinstance(item, Mapping)]
    elif name == "CreateVolume":
        found = [response.get("volumeId")]
    elif name in ("CreateVpc", "CreateDefaultVpc"):
        found = [(response.get("vpc") or {}).get("vpcId")]
    elif name == "AllocateAddress":
        found = [response.get("allocationId")]
    elif name == "CreateSecurityGroup":
        found = [response.get("groupId")]
    else:
        found = [
            response.get("dBInstanceIdentifier")
            or request.get("dBInstanceIdentifier")
            or request.get("targetDBInstanceIdentifier")
        ]
    return [str(value) for value in found if isinstance(value, str) and value]


def _event_time(event: Mapping[str, Any]) -> datetime | None:
    raw = event.get("EventTime")
    if isinstance(raw, datetime):
        return raw if raw.tzinfo else raw.replace(tzinfo=UTC)
    if isinstance(raw, str):
        try:
            parsed = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)
    return None


def creations_from_events(events: Sequence[Mapping[str, Any]]) -> list[Creation]:
    """Each successful creation event's resources, with who created them."""
    found: list[Creation] = []
    for event in events:
        name = str(event.get("EventName") or "")
        kind = _EVENT_KIND.get(name)
        at = _event_time(event)
        if kind is None or at is None:
            continue
        try:
            detail = json.loads(str(event.get("CloudTrailEvent") or "{}"))
        except ValueError:
            continue
        if not isinstance(detail, Mapping) or detail.get("errorCode"):
            continue
        principal = principal_of(detail.get("userIdentity"))
        for resource in _created_ids(name, detail):
            found.append(Creation(kind=kind, resource=resource, at=at, principal=principal))
    return found


def creation_index(creations: Sequence[Creation]) -> dict[tuple[str, str], Creation]:
    """The latest creation of each `(kind, short id)`: a database name can be used again."""
    index: dict[tuple[str, str], Creation] = {}
    for creation in creations:
        key = (creation.kind, creation.resource.casefold() if creation.kind == "database" else creation.resource)
        held = index.get(key)
        if held is None or creation.at > held.at:
            index[key] = creation
    return index


def short_id(resource_id: str, kind: str) -> str:
    """The id a creation event names, from the resource's ARN."""
    if kind == "database":
        return resource_id.rsplit(":db:", 1)[-1].casefold()
    return resource_id.rsplit("/", 1)[-1]


def _tag_creator(record: Mapping[str, Any]) -> str | None:
    tags = record.get("Tags") or record.get("TagList") or []
    by_key = {
        str(tag.get("Key") or "").casefold(): str(tag.get("Value") or "").strip()
        for tag in tags
        if isinstance(tag, Mapping)
    }
    for key in _CREATOR_TAGS:
        if by_key.get(key):
            return _bounded(by_key[key])
    return None


def _described_date(record: Mapping[str, Any], tz: tzinfo) -> str | None:
    for key in ("CreateTime", "InstanceCreateTime"):
        value = record.get(key)
        if isinstance(value, datetime):
            return (value if value.tzinfo else value.replace(tzinfo=UTC)).astimezone(tz).date().isoformat()
        if isinstance(value, str) and len(value) >= 10:
            return value[:10]
    return None


def _as_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=UTC)
    return None


def principals_to_check(creations: Sequence[Creation]) -> list[tuple[str, str]]:
    """Each IAM user and role a creation names, once, in a stable order."""
    return sorted({creation.principal.iam for creation in creations if creation.principal.iam is not None})


def ownership_items(
    resource_ids: Sequence[str],
    raw: Mapping[str, Mapping[str, Any]],
    *,
    index: Mapping[tuple[str, str], Creation],
    lookups: Mapping[str, str],
    statuses: Mapping[tuple[str, str], str],
    lookback_start: datetime,
    tz: tzinfo,
) -> list[dict[str, Any]]:
    """One item per covered resource, every key written. **Pure.**

    `lookups` is each region's lookup outcome (`ok`, `denied`, `failed`); `statuses` is IAM's
    answer for each `(user|role, name)`: `Active`, `Deleted` or `Not checked`.
    """

    def found(resource_id: str) -> Creation | None:
        record = raw.get(resource_id) or {}
        kind = str(record.get("_kind") or "")
        return index.get((kind, short_id(resource_id, kind)))

    instance_arns = {
        str(record.get("InstanceId")): resource_id
        for resource_id, record in raw.items()
        if record.get("_kind") == "instance"
    }
    vpc_arns = {
        str(record.get("VpcId")): resource_id for resource_id, record in raw.items() if record.get("_kind") == "vpc"
    }

    def inherited(record: Mapping[str, Any]) -> tuple[Creation, str] | None:
        kind = record.get("_kind")
        if kind == "volume":
            created = _as_datetime(record.get("CreateTime"))
            for attachment in record.get("Attachments") or []:
                parent = instance_arns.get(str(attachment.get("InstanceId")))
                launch = found(parent) if parent else None
                if launch is not None and created is not None and abs(created - launch.at) <= INHERIT_WINDOW:
                    return launch, SOURCE_WITH_INSTANCE
        if kind == "security_group" and record.get("GroupName") == "default":
            parent = vpc_arns.get(str(record.get("VpcId")))
            vpc = found(parent) if parent else None
            if vpc is not None:
                return vpc, SOURCE_WITH_VPC
        return None

    def status_of(principal: Principal) -> str:
        if principal.iam is not None:
            return statuses.get(principal.iam, STATUS_NOT_CHECKED)
        if principal.kind in ("Root user", "AWS service"):
            return STATUS_NOT_APPLICABLE
        if principal.kind == UNKNOWN:
            return UNKNOWN
        return STATUS_NOT_CHECKED

    before = f"before {lookback_start.astimezone(tz).date().isoformat()}"
    items: list[dict[str, Any]] = []
    for resource_id in sorted(resource_ids):
        record = raw.get(resource_id)
        if record is None or record.get("_kind") not in OWNERSHIP_KINDS:
            continue
        creation = found(resource_id)
        source = SOURCE_CLOUDTRAIL
        if creation is None:
            parent = inherited(record)
            if parent is not None:
                creation, source = parent
        if creation is not None:
            items.append({
                "resource_id": resource_id,
                "created_by": creation.principal.label,
                "creator_type": creation.principal.kind,
                "created_on": creation.at.astimezone(tz).date().isoformat(),
                "creator_source": source,
                "creator_status": status_of(creation.principal),
            })
            continue

        lookup = lookups.get(str(record.get("_region") or ""), LOOKUP_FAILED)
        described = _described_date(record, tz)
        tagged = _tag_creator(record)
        if tagged is not None:
            items.append({
                "resource_id": resource_id,
                "created_by": tagged,
                "creator_type": "Tag",
                "created_on": described or (before if lookup == LOOKUP_OK else UNKNOWN),
                "creator_source": SOURCE_TAG,
                "creator_status": STATUS_NOT_CHECKED,
            })
            continue
        items.append({
            "resource_id": resource_id,
            "created_by": UNKNOWN,
            "creator_type": UNKNOWN,
            "created_on": described or (before if lookup == LOOKUP_OK else UNKNOWN),
            "creator_source": {LOOKUP_OK: SOURCE_NOT_FOUND, LOOKUP_DENIED: SOURCE_DENIED}.get(lookup, SOURCE_FAILED),
            "creator_status": UNKNOWN,
        })
    return items


def lookback_start_of(now: datetime) -> datetime:
    return now - timedelta(days=LOOKBACK_DAYS)
