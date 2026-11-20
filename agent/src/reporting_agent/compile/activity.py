"""Whether each AWS resource is used or idle, derived from the snapshot by fixed rules. **Pure.**

The weekly ownership report needs an answer per resource — *Idle*, *Low use*, *Active* — that
no API gives. It is derived here, at compile time, from what the snapshot already holds: the
window statistics the run collected and the `housekeeping` fact. Derived rather than collected
because the fact pass runs before the metrics are read, and derived **in the view** because
`compile/snapshot_view.build_snapshot_view` is what the verifier rebuilds from the stored
document: a re-verification a year from now applies these same rules to the same numbers and
gets the same words, so every derived value is re-resolvable like a collected one.

The rules, over the report's own period:

* **EC2 instance** — stopped is *Stopped*. CPU p95 under 5% with network in and out under
  5 MB a day is *Idle*; CPU p95 under 20% is *Low use*; anything else is *Active*. No CPU p95
  in the snapshot is *Not measured*: the rule needs it and a guess would be worse than saying so.
* **RDS instance** — stopped is *Stopped*. CPU p95 under 5% with average read IOPS under 1 is
  *Idle*; CPU p95 under 20% is *Low use*; else *Active*.
* **EBS volume, Elastic IP** — the housekeeping rules: unattached, or attached only to a
  stopped instance, is *Idle*; otherwise *In use*.
* **VPC, security group** — *Not measured*: nothing here measures whether a network is used.

Three more derived values ride on the same walk: `attention` (the activity when it is Idle,
Low use or Stopped, else `none`, so a table can keep only those), `created_in_period`
(`yes` when the `created_on` fact falls in the report's period) and, for the totals, the
`est_monthly_usd` estimates read as decimals.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import date
from decimal import Decimal, InvalidOperation
from typing import Final

__all__ = [
    "ACTIVITY_ACTIVE",
    "ACTIVITY_FACT_KEY",
    "ACTIVITY_IDLE",
    "ACTIVITY_IN_USE",
    "ACTIVITY_LOW_USE",
    "ACTIVITY_NOT_MEASURED",
    "ACTIVITY_STOPPED",
    "ACTIVITY_VALUES",
    "ATTENTION_FACT_KEY",
    "ATTENTION_VALUES",
    "COST_FACT_KEY",
    "CREATED_IN_PERIOD_FACT_KEY",
    "CREATOR_FACT_KEY",
    "DERIVED_FACT_SOURCE",
    "OWNED_TYPES",
    "Derived",
    "derive",
    "monthly_cost",
]

DERIVED_FACT_SOURCE: Final[str] = "derived"
ACTIVITY_FACT_KEY: Final[str] = "activity"
ATTENTION_FACT_KEY: Final[str] = "attention"
CREATED_IN_PERIOD_FACT_KEY: Final[str] = "created_in_period"
CREATOR_FACT_KEY: Final[str] = "created_by"
CREATED_ON_FACT_KEY: Final[str] = "created_on"
COST_FACT_KEY: Final[str] = "est_monthly_usd"
HOUSEKEEPING_FACT_KEY: Final[str] = "housekeeping"
HOUSEKEEPING_CLEAR: Final[str] = "none"

ACTIVITY_IDLE: Final[str] = "Idle"
ACTIVITY_LOW_USE: Final[str] = "Low use"
ACTIVITY_ACTIVE: Final[str] = "Active"
ACTIVITY_STOPPED: Final[str] = "Stopped"
ACTIVITY_IN_USE: Final[str] = "In use"
ACTIVITY_NOT_MEASURED: Final[str] = "Not measured"
ACTIVITY_VALUES: Final[tuple[str, ...]] = (
    ACTIVITY_IDLE, ACTIVITY_LOW_USE, ACTIVITY_STOPPED, ACTIVITY_ACTIVE, ACTIVITY_IN_USE, ACTIVITY_NOT_MEASURED,
)
"""Every activity, in the order a reader acts on them. Each is counted, at zero too."""
ATTENTION_VALUES: Final[frozenset[str]] = frozenset({ACTIVITY_IDLE, ACTIVITY_LOW_USE, ACTIVITY_STOPPED})
NO_ATTENTION: Final[str] = "none"

IDLE_CPU_P95: Final[Decimal] = Decimal(5)
LOW_USE_CPU_P95: Final[Decimal] = Decimal(20)
IDLE_NETWORK_BYTES_PER_DAY: Final[Decimal] = Decimal(5_000_000)
IDLE_READ_IOPS: Final[Decimal] = Decimal(1)

INSTANCE: Final[str] = "aws::ec2::instance"
DATABASE: Final[str] = "aws::rds::dbinstance"
VOLUME: Final[str] = "aws::ec2::volume"
ADDRESS: Final[str] = "aws::ec2::eip"
OWNED_TYPES: Final[frozenset[str]] = frozenset(
    {INSTANCE, DATABASE, VOLUME, ADDRESS, "aws::ec2::vpc", "aws::ec2::securitygroup"}
)
"""The resource types the ownership report covers, compared case-insensitively."""

_STOPPED: Final[frozenset[str]] = frozenset({"stopped", "stopping", "deallocated", "deallocating"})

Stat = Callable[[str, str], Decimal | None]
"""`(metric, statistic) -> value` for one resource over the report's window."""


@dataclass(frozen=True, slots=True)
class Derived:
    """One resource's derived values: `(key, value)` facts, in a fixed order."""

    facts: tuple[tuple[str, str], ...]


def monthly_cost(value: str | None) -> Decimal | None:
    """An `est_monthly_usd` value as a decimal, or `None` for `not priced` / `not running`."""
    if value is None:
        return None
    try:
        parsed = Decimal(value)
    except InvalidOperation:
        return None
    return parsed if parsed.is_finite() and parsed >= 0 else None


def _activity(resource_type: str, power_state: str, facts: Mapping[str, str], stat: Stat, days: int) -> str:
    kind = resource_type.casefold()
    if kind in (VOLUME, ADDRESS):
        housekeeping = facts.get(HOUSEKEEPING_FACT_KEY)
        if housekeeping is None:
            return ACTIVITY_NOT_MEASURED
        return ACTIVITY_IN_USE if housekeeping.strip().casefold() == HOUSEKEEPING_CLEAR else ACTIVITY_IDLE
    if kind not in (INSTANCE, DATABASE):
        return ACTIVITY_NOT_MEASURED
    if power_state.casefold() in _STOPPED:
        return ACTIVITY_STOPPED
    cpu = stat("CPUUtilization", "p95")
    if cpu is None:
        return ACTIVITY_NOT_MEASURED
    if cpu < IDLE_CPU_P95:
        if kind == INSTANCE:
            received, sent = stat("NetworkIn", "sum"), stat("NetworkOut", "sum")
            quiet = received is None or sent is None or (received + sent) < IDLE_NETWORK_BYTES_PER_DAY * days
        else:
            reads = stat("ReadIOPS", "avg")
            quiet = reads is None or reads < IDLE_READ_IOPS
        if quiet:
            return ACTIVITY_IDLE
    return ACTIVITY_LOW_USE if cpu < LOW_USE_CPU_P95 else ACTIVITY_ACTIVE


def _in_period(created_on: str | None, start: date, end: date) -> str | None:
    if created_on is None:
        return None
    try:
        created = date.fromisoformat(created_on.strip()[:10])
    except ValueError:
        return "no"
    return "yes" if start <= created <= end else "no"


def derive(
    *,
    resource_type: str,
    power_state: str,
    facts: Mapping[str, str],
    stat: Stat,
    period_start: str,
    period_end: str,
) -> Derived | None:
    """The derived facts for one resource, or `None` when it is not one the report covers."""
    if resource_type.casefold() not in OWNED_TYPES:
        return None
    try:
        start, end = date.fromisoformat(period_start), date.fromisoformat(period_end)
    except ValueError:
        return None
    days = max((end - start).days + 1, 1)
    activity = _activity(resource_type, power_state, facts, stat, days)
    found: list[tuple[str, str]] = [
        (ACTIVITY_FACT_KEY, activity),
        (ATTENTION_FACT_KEY, activity if activity in ATTENTION_VALUES else NO_ATTENTION),
    ]
    created = _in_period(facts.get(CREATED_ON_FACT_KEY), start, end)
    if created is not None:
        found.append((CREATED_IN_PERIOD_FACT_KEY, created))
    return Derived(facts=tuple(found))
