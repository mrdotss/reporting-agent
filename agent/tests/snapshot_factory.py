"""Small, real snapshot documents for the compile-stage tests.

**Built through `collect/snapshot.py`'s `build_snapshot`, never hand-written as a
dict.** That coupling is the point: `compile/snapshot_view.py` reads what the
Snapshot_Builder writes, and a hand-written fixture would let the two drift — the view
would keep passing against a shape the collector no longer produces, which is exactly
the failure a compile stage cannot afford, since it would surface as a report with
missing figures rather than as a broken test.

So these helpers assemble `ResourceSnapshot` / `StatisticEntry` / `ResourceDayBucket`
values and hand them to the real builder, which scrubs, orders, canonicalizes and
hashes the document. The returned `dict` is a genuine snapshot: `snapshot_id` equals
its own content hash, every value is a decimal string at its declared scale, and every
array order was produced rather than inherited.

Not a test module — a helper `tests/` modules import. `tests/` is on `sys.path`, the
same convention `fakes/` and `fixtures/` already use.
"""

from __future__ import annotations

from datetime import UTC, date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from reporting_agent.collect.accumulate import DerivedSourceRef
from reporting_agent.collect.buckets import resolve_window
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_METRIC_NOT_EMITTED,
    GAP_TYPE_PERMISSION_DENIED,
    record_gap,
)
from reporting_agent.collect.snapshot import (
    ESTIMATOR_DERIVED_COUNT_WEIGHTED,
    ESTIMATOR_EXACT_COUNT_WEIGHTED,
    ESTIMATOR_EXACT_INTERVAL_MAXIMUM,
    ESTIMATOR_EXACT_INTERVAL_MINIMUM,
    FactEntry,
    ResourceDayBucket,
    ResourceSnapshot,
    SkuCapacity,
    StatisticEntry,
    build_snapshot,
)
from reporting_agent.providers.base import GapRecord, ResourceRecord, ScopeSpec

JAKARTA = ZoneInfo("Asia/Jakarta")
SUBSCRIPTION_ID = "11111111-2222-3333-4444-555555555555"
VM_TYPE = "Microsoft.Compute/virtualMachines"
CPU = "Percentage CPU"
AVAILABLE_MEMORY = "Available Memory Bytes"
MEMORY_USED_PCT = "memory_used_pct"
GRAIN = "PT1H"
CATALOG_VERSION = "1.0.0"

# Two local days, so a day-bucket lookup and a day series have something to order.
WINDOW_START = date(2026, 7, 1)
WINDOW_END = date(2026, 7, 2)
DAY_ONE = "2026-07-01"
DAY_TWO = "2026-07-02"


def resource_record(
    *,
    resource_id: str,
    name: str,
    resource_type: str = VM_TYPE,
    location: str = "southeastasia",
    resource_group: str = "rg-prod",
    tags: dict[str, str] | None = None,
    sku_name: str = "Standard_D2s_v5",
    power_state: str = "running",
    fidelity_tier: str = "baseline",
) -> ResourceRecord:
    return ResourceRecord(
        resource_id=resource_id,
        name=name,
        resource_type=resource_type,
        location=location,
        resource_group=resource_group,
        tags=dict(tags or {}),
        sku_name=sku_name,
        power_state_raw=f"PowerState/{power_state}",
        power_state=power_state,
        fidelity_tier=fidelity_tier,
    )


def exact(
    metric: str,
    statistic: str,
    value: str,
    *,
    unit: str = "percent",
    scale: int = 2,
    fidelity_tier: str = "baseline",
    sample_count: int = 48,
) -> StatisticEntry:
    """One exact statistic. `avg` is count-weighted; `min`/`max` roll up exactly."""
    estimator = {
        "avg": ESTIMATOR_EXACT_COUNT_WEIGHTED,
        "min": ESTIMATOR_EXACT_INTERVAL_MINIMUM,
        "max": ESTIMATOR_EXACT_INTERVAL_MAXIMUM,
    }[statistic]
    return StatisticEntry(
        metric=metric,
        statistic=statistic,
        value=Decimal(value),
        unit=unit,
        estimator=estimator,
        fidelity_tier=fidelity_tier,
        sample_count=sample_count,
        scale=scale,
    )


def percentile(
    metric: str,
    statistic: str,
    value: str,
    *,
    unit: str = "percent",
    scale: int = 2,
    fidelity_tier: str = "baseline",
) -> StatisticEntry:
    """One sketch-derived percentile: marked estimated, carrying the collector's own
    pre-formatted label and an estimator naming the sketch and the source grain."""
    return StatisticEntry(
        metric=metric,
        statistic=statistic,
        value=Decimal(value),
        unit=unit,
        estimator="histogram_sketch_pt1h_interval_average",
        fidelity_tier=fidelity_tier,
        sample_count=48,
        scale=scale,
        estimated=True,
        label=f"{value}% ({statistic}, est. from hourly averages)",
    )


def derived(value: str, *, statistic: str = "avg", scale: int = 2) -> StatisticEntry:
    """`memory_used_pct` — a derived value carrying both `formula` and `derived_from`
    (Req 30.9) plus the host-observed caveat on the value object (Req 30.4)."""
    return StatisticEntry(
        metric=MEMORY_USED_PCT,
        statistic=statistic,
        value=Decimal(value),
        unit="percent",
        estimator=ESTIMATOR_DERIVED_COUNT_WEIGHTED,
        fidelity_tier="baseline",
        sample_count=48,
        scale=scale,
        observation="host_observed",
        note="Host-observed; typically 1-3% below what the guest reports.",
        formula="(sku_memory_bytes - available_memory_bytes) / sku_memory_bytes * 100",
        derived_from=(
            DerivedSourceRef(
                kind="metric", name=AVAILABLE_MEMORY, statistic="avg", unit="bytes"
            ),
            DerivedSourceRef(kind="sku_capability", name="MemoryGB", unit="bytes"),
        ),
    )


def build(
    *,
    resources: list[ResourceSnapshot],
    gaps: list[GapRecord] | None = None,
    resource_types: list[str] | None = None,
    raw_archive_complete: bool = True,
    raw_archive_object_count: int = 4,
    collected_at: datetime | None = None,
    invocation_started_at: datetime | None = None,
) -> dict:
    """One real snapshot document over `resources`.

    `invocation_started_at` defaults to `None` — no lower bound on a fact's `collected_at` —
    because most fixtures here carry no fact at all and the ones that do are asserting a shape
    rather than a clock. `tests/test_snapshot_facts.py` passes a real instant where the bound
    itself is under test.
    """
    window = resolve_window(WINDOW_START, WINDOW_END, JAKARTA)
    declared_types = resource_types or [VM_TYPE]
    scope = ScopeSpec(
        subscription_id=SUBSCRIPTION_ID,
        resource_types=list(declared_types),
        resource_groups=[],
        tag_filters={},
    )
    return build_snapshot(
        invocation_started_at=invocation_started_at,
        run_id="run-compile-fixture",
        scope=scope,
        scope_verified=True,
        collected_at=collected_at or datetime(2026, 7, 3, 1, 30, tzinfo=UTC),
        timezone_name="Asia/Jakarta",
        tz=JAKARTA,
        window=window,
        grain=GRAIN,
        metrics_by_resource_type={
            resource_type: [CPU, AVAILABLE_MEMORY] for resource_type in declared_types
        },
        resources=resources,
        gaps=gaps or [],
        catalog_version=CATALOG_VERSION,
        raw_archive_complete=raw_archive_complete,
        raw_archive_object_count=raw_archive_object_count,
    )


def vm(
    *,
    resource_id: str,
    name: str,
    cpu_avg: str = "12.48",
    cpu_min: str = "0.51",
    cpu_max: str = "88.20",
    cpu_p95: str | None = "68.40",
    memory_pct: str | None = "42.10",
    day_cpu: dict[str, str] | None = None,
    tags: dict[str, str] | None = None,
    resource_group: str = "rg-prod",
    location: str = "southeastasia",
    resource_type: str = VM_TYPE,
    fidelity_tier: str = "baseline",
    power_state: str = "running",
    vcpus_available: int | None = 2,
    memory_bytes: str | None = "8589934592",
    statistics: list[StatisticEntry] | None = None,
    facts: tuple[FactEntry, ...] = (),
) -> ResourceSnapshot:
    """One resource with a small, realistic statistic set and two day buckets."""
    if statistics is None:
        statistics = [
            exact(CPU, "avg", cpu_avg, fidelity_tier=fidelity_tier),
            exact(CPU, "min", cpu_min, fidelity_tier=fidelity_tier),
            exact(CPU, "max", cpu_max, fidelity_tier=fidelity_tier),
        ]
        if cpu_p95 is not None:
            statistics.append(percentile(CPU, "p95", cpu_p95, fidelity_tier=fidelity_tier))
        if memory_pct is not None:
            statistics.append(derived(memory_pct))

    per_day = day_cpu if day_cpu is not None else {DAY_ONE: "10.00", DAY_TWO: "14.96"}
    buckets = tuple(
        ResourceDayBucket(
            local_day=date.fromisoformat(local_day),
            slot_count=24,
            statistics=(exact(CPU, "avg", value, fidelity_tier=fidelity_tier),),
        )
        for local_day, value in sorted(per_day.items())
    )

    return ResourceSnapshot(
        record=resource_record(
            resource_id=resource_id,
            name=name,
            resource_type=resource_type,
            location=location,
            resource_group=resource_group,
            tags=tags,
            fidelity_tier=fidelity_tier,
            power_state=power_state,
        ),
        sku=SkuCapacity(
            name="Standard_D2s_v5",
            vcpus_available=vcpus_available,
            memory_bytes=Decimal(memory_bytes) if memory_bytes is not None else None,
        ),
        statistics=tuple(statistics),
        day_buckets=buckets,
        facts=facts,
    )


def two_vm_snapshot() -> dict:
    """The default document: two running VMs, one gap, two local days.

    Used by most compile-stage tests, so a change to it is visible everywhere at once
    rather than in one test's private fixture.
    """
    return build(
        resources=[
            vm(
                resource_id=f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-prod"
                f"/providers/Microsoft.Compute/virtualMachines/prod-web-01",
                name="prod-web-01",
                tags={"env": "prod", "tier": "web"},
            ),
            vm(
                resource_id=f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-prod"
                f"/providers/Microsoft.Compute/virtualMachines/prod-sql-01",
                name="prod-sql-01",
                cpu_avg="64.20",
                cpu_min="21.00",
                cpu_max="99.90",
                cpu_p95="95.10",
                memory_pct="81.40",
                tags={"env": "Prod", "tier": "data"},
                day_cpu={DAY_ONE: "60.00", DAY_TWO: "68.40"},
            ),
        ],
        gaps=[
            record_gap(
                GAP_TYPE_METRIC_NOT_EMITTED,
                f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-prod"
                f"/providers/Microsoft.Compute/virtualMachines/prod-web-01",
                "Network In Total",
                "the SKU does not emit this counter",
            )
        ],
    )


def snapshot_with_every_gap_type() -> dict:
    """One VM plus three gap types, for the `gaps_and_coverage` grouping order."""
    resource_id = (
        f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-prod"
        f"/providers/Microsoft.Compute/virtualMachines/prod-web-01"
    )
    other_id = (
        f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-prod"
        f"/providers/Microsoft.Compute/virtualMachines/prod-web-02"
    )
    return build(
        resources=[vm(resource_id=resource_id, name="prod-web-01")],
        gaps=[
            record_gap(GAP_TYPE_PERMISSION_DENIED, other_id, None, "403 on the resource"),
            record_gap(GAP_TYPE_DEALLOCATED, other_id, None, "the VM is deallocated"),
            record_gap(
                GAP_TYPE_METRIC_NOT_EMITTED, resource_id, CPU, "not emitted for this SKU"
            ),
        ],
    )


def two_vm_snapshot_with_child_resources() -> dict:
    """`two_vm_snapshot` plus two security rules that share a name.

    Two different network security groups each carry a rule called `default-allow-ssh`,
    which is ordinary in Azure — a rule name is unique inside its own group and nowhere
    else. It is also the shape that refused a whole document once the child-resource query
    started working: a table keyed on the resource name had two rows it could not tell
    apart. A fixture with one child resource, or with two differently named ones, cannot
    express that.
    """
    from reporting_agent.collect.snapshot import ResourceSnapshot

    document = two_vm_snapshot()
    base = f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-net/providers"
    children = []
    for nsg in ("nsg-web", "nsg-app"):
        rule_id = f"{base}/Microsoft.Network/networkSecurityGroups/{nsg}/securityRules/default-allow-ssh"
        children.append(
            {
                "resource_id": rule_id,
                "name": "default-allow-ssh",
                "resource_type": "Microsoft.Network/networkSecurityGroups/securityRules",
                "location": "southeastasia",
                "resource_group": "rg-net",
                "tags": {},
                # `unknown`, as the collector records for a resource with no power
                # state — the field is required non-empty and a child resource has none.
                "power_state": "unknown",
                "power_state_raw": "",
                "fidelity_tier": "baseline",
                "sku": {"name": ""},
                "statistics": [],
                "day_buckets": [],
                "facts": [],
            }
        )
    document["resources"] = [*document["resources"], *children]
    return document
