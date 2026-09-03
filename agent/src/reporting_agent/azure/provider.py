"""The Azure provider: `discover`, `collect`, `capabilities` over the five collectors.

This is the one place the runtime's provider-shaped view of Azure
(`providers.base.Provider`) is satisfied, and it lives **inside** `azure/` so the
SDK-import guard (Req 18.5, 18.7) has nothing to except. Everything above it —
`collect/pipeline.py`, and later `compile/`, `render/` and `verify/` — reaches Azure
only through the three methods below (Req 18.4), over structures built only from
`str`, `bool`, `int`, `Decimal`, `None`, `list` and `dict` (Req 18.3).

**It orchestrates; it does not re-implement.** Every behaviour Req 20-31 asks for
already lives in one of five modules, each already tested against the fake ports:

| module | what it owns |
|---|---|
| `azure/inventory.py` | Resource Graph paging, quota waits, power-state gaps |
| `azure/definitions.py` | one metric-definitions probe per `(resource_type, region)` |
| `azure/skus.py` | location-filtered `resource_skus.list`, `vCPUsAvailable` only |
| `azure/regions.py` | the regional endpoint and its DNS-failure fallback memo |
| `azure/metrics.py` | points-budget batching, halving, 429 waits, per-resource errors |

So what is actually written here is the *sequencing* and the *plain-data conversion*:
which group is requested when, which accumulator each folded interval lands in, and
how a finalized accumulator becomes a `StatValue` every downstream phase can read
without importing anything from `azure/`.

**The five modules are injected, never constructed here** (except by
:func:`build_provider`). :func:`provider_over_ports` assembles them from the four
ports, so the entire provider — `discover`, `collect` and `capabilities` — runs in a
unit test against `tests/fakes/azure_ports.py` and an in-memory object store, with no
SDK, no credential and no subscription anywhere in the path. :func:`build_provider`
is the **only** function that reaches for a real Azure client, and it is registered
lazily (`providers/registry.py` already names
`reporting_agent.azure.provider:build_provider`), so an invocation that never
collects never pays the SDK import.

**An exception is not translated here** (Req 18.8). `main.run_invocation` already owns
the single egress: it catches `AgentError` and everything else, emits one terminal
`error` carrying the scrubbed text, closes every open step and emits `done` last. A
second translation inside the provider would have to invent an error code, would
swallow the traceback the router logs, and would let a *partial* result look like a
successful one. So this module raises cleanly and never suppresses — there is no bare
`except` in it — and `main.py` is where a raised exception becomes `error` + `done`.

**Statistics are built by `collect/snapshot.py`'s own builders**, not by a second
formatter here. `exact_statistics`, `percentile_statistics` and `derived_statistics`
own the estimator vocabulary, the catalog-declared serialization scale, the
pre-formatted percentile label and Req 30.6's forbidden-term check; re-deriving any
of that here would be a second spelling of a string the verifier has to match
exactly. Each `StatValue` this module returns is therefore precisely one
`StatisticEntry.to_plain_data()` — the same object the snapshot document carries.

**What this module deliberately does not do**, because it belongs to
`collect/pipeline.py` (task 11.9), which sees the whole run rather than one call:
the empty-scope and no-statistics gates (Req 33.1, 33.7), the all-locations-unreachable
escalation (Req 24.5), the `PARTIAL_COVERAGE` event (Req 29.5), the `tool` and
`progress` events, the phase callbacks, the enhanced-tier Log Analytics queries
(Req 31.5, 31.6) and the snapshot write.
"""

from __future__ import annotations

import asyncio
import logging
import math
from collections.abc import Awaitable, Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Final, cast

from reporting_agent.azure.definitions import DefinitionProbe
from reporting_agent.azure.facts import FactArchiveContext, FactCollector
from reporting_agent.azure.inventory import (
    InventoryArchiveContext,
    InventoryCollector,
)
from reporting_agent.azure.metrics import MetricsCollector
from reporting_agent.azure.ports import (
    DefinitionsPort,
    FactsPort,
    InventoryPort,
    MetricsPort,
    SkuPort,
)
from reporting_agent.azure.regions import RegionResolver
from reporting_agent.azure.skus import (
    CAPABILITY_MEMORY_GB,
    CAPABILITY_VCPUS_AVAILABLE,
    SkuCapacity,
    SkuCatalog,
)
from reporting_agent.catalog.loader import (
    LoadedCatalog,
    MetricEntry,
    ResourceTypeCatalog,
    child_type_names,
    load_catalog,
)
from reporting_agent.collect.accumulate import (
    MetricAccumulator,
    new_accumulator,
)
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.buckets import (
    BASE_GRAIN,
    FALLBACK_GRAIN,
    resolve_timezone,
)
from reporting_agent.collect.dayfold import DayFold
from reporting_agent.collect.finalize import finalize_resource
from reporting_agent.collect.log import GAP_TYPE_METRIC_NOT_EMITTED, record_gap
from reporting_agent.collect.snapshot import (
    SkuCapacity as SnapshotSkuCapacity,
)
from reporting_agent.collect.snapshot import (
    StatisticEntry,
)
from reporting_agent.providers.base import (
    GUEST_STATUS_EMPTY,
    GUEST_STATUS_FAILED,
    GUEST_STATUS_OK,
    Capabilities,
    CollectRequest,
    CollectResult,
    DiscoverResult,
    FactRequest,
    FactResult,
    GapRecord,
    GuestCounterOutcome,
    GuestCounterRequest,
    GuestCounterResult,
    GuestCounterRow,
    GuestCounterSpec,
    LocationRouting,
    PlainData,
    Provider,
    RawArchiveState,
    ResourceRecord,
    ScopeSpec,
    SkuCapacityRecord,
    StatValue,
    assert_inventory_sorted,
    assert_plain_data,
    is_excluded_from_averages,
    sort_inventory,
)
from reporting_agent.storage.base import ObjectStore

__all__ = [
    "FIDELITY_BASELINE",
    "FIDELITY_ENHANCED",
    "FIDELITY_TIERS",
    "SUPPORTED_GRAINS",
    "AzureProvider",
    "build_provider",
    "interval_count_for",
    "is_excluded_from_averages",
    "provider_over_ports",
]

logger = logging.getLogger(__name__)

# --- the two vocabularies `capabilities()` reports (Req 18.6) ------------------------

SUPPORTED_GRAINS: Final[tuple[str, str]] = (BASE_GRAIN, FALLBACK_GRAIN)
"""`PT1H` and `PT15M`, imported from `collect/buckets.py` rather than spelled again:
those two are the only grains the Bucketer will ever choose (Req 25.1, 25.5, 25.8), so
a provider claiming a third would be claiming something no caller can ask for."""

FIDELITY_BASELINE: Final[str] = "baseline"
FIDELITY_ENHANCED: Final[str] = "enhanced"

_CHILD_RESOURCE_PARENT_TYPES: Final[frozenset[str]] = frozenset(
    {"microsoft.network/virtualnetworks", "microsoft.network/networksecuritygroups"}
)
"""The parent types whose scope presence triggers `discover_child_resources` (task
6.1, 6.3), matched case-insensitively against a run's requested scope. Growing to a
third child type's parent is one more entry here, never a new gate."""

FIDELITY_TIERS: Final[tuple[str, str]] = (FIDELITY_BASELINE, FIDELITY_ENHANCED)
"""The two tiers this provider can report.

Mirrored **by value** from `azure/preflight.py`'s `FIDELITY_BASELINE` /
`FIDELITY_ENHANCED` rather than imported from it — the same deliberate non-coupling
`collect/accumulate.py` draws against the catalog's statistic names. Importing
`azure/preflight.py` here would pull `azure-identity` into every import of this
module, including the ones that only want `capabilities()` over the fakes.
`tests/test_azure_provider.py` asserts the two spellings agree, so the mirror cannot
drift silently."""

_SLOT_SECONDS: Final[dict[str, int]] = {BASE_GRAIN: 3600, FALLBACK_GRAIN: 900}
"""How many seconds one interval of each supported grain covers — the divisor
:func:`interval_count_for` turns a window into an interval count with, which is what
`azure/metrics.py`'s points-budget sizing (Req 23.2, 23.4) is computed from."""

_SKU_CAPABILITY_READERS: Final[
    tuple[tuple[str, Callable[[SkuCapacity], Decimal | None]], ...]
] = (
    (CAPABILITY_VCPUS_AVAILABLE, lambda capacity: capacity.vcpus_available),
    (CAPABILITY_MEMORY_GB, lambda capacity: capacity.memory_bytes),
)
"""How a catalog-declared SKU capability name reads off a resolved `SkuCapacity`.

`MemoryGB` reads `memory_bytes`, **already converted from GiB** (Req 21.5), because
the catalog's own `sources` entry binds that capability with `"unit": "bytes"` — the
formula `(sku_memory_bytes - available_memory_bytes) / sku_memory_bytes * 100`
subtracts a byte-valued metric from it. Handing the GiB figure to that formula would
produce a plausible-looking percentage that is wrong by a factor of 2**30.

A tuple of pairs, so nothing here iterates a hash-ordered container. A capability the
catalog declares that this table does not know reads as `None`, which is exactly the
input `collect/accumulate.py`'s `derive_statistic` turns into a
`sku_capability_missing` gap (Req 30.7) rather than a derived value computed from a
capacity nobody resolved."""


# --- small pure helpers --------------------------------------------------------------


def _parse_instant(value: object, field_name: str) -> datetime:
    """One RFC 3339 UTC instant from a `Window` field. **Pure.**

    `datetime.fromisoformat` accepts the trailing `Z` on 3.11+, and this package pins
    3.12, so no manual `Z` rewriting is needed. Raises `ValueError` naming the field
    rather than defaulting: a window whose instants cannot be read has no interval
    count, and inventing one would silently mis-size every batch in the run.
    """
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"window.{field_name} must be an RFC 3339 instant, got {value!r}")
    try:
        return datetime.fromisoformat(value)
    except ValueError as exc:
        raise ValueError(
            f"window.{field_name} is not a readable RFC 3339 instant: {value!r}"
        ) from exc


def interval_count_for(window: Mapping[str, str], grain: str) -> int:
    """How many `grain`-sized intervals the half-open window covers. **Pure.**

    This is the `interval_count` `azure/metrics.py` sizes a batch by (Req 23.2, 23.4):
    estimated points are `resource_count * metric_count * interval_count`, so an
    interval count that is too small plans batches that are too large and gets them
    rejected, and one that is too large plans more requests than the budget needs.

    Rounded **up**, so a window that is not a whole number of intervals is sized for
    the partial interval Azure will still return rather than one short of it. At least
    1 for any non-empty window, since a request covering less than one interval still
    returns one bucket.

    Raises `ValueError` for a grain outside :data:`SUPPORTED_GRAINS` — `P1D` and `PT1M`
    are not grains this runtime requests (Req 25.2, 25.8) — and for an end instant at
    or before the start.
    """
    slot = _SLOT_SECONDS.get(grain)
    if slot is None:
        raise ValueError(
            f"grain must be one of {SUPPORTED_GRAINS}, got {grain!r}: neither P1D "
            f"(UTC-aligned buckets) nor PT1M (a ~6 GB month) is ever requested"
        )
    start = _parse_instant(window.get("start_utc"), "start_utc")
    end = _parse_instant(window.get("end_utc"), "end_utc")
    seconds = (end - start).total_seconds()
    if seconds <= 0:
        raise ValueError(
            f"the collection window is empty or inverted: start_utc={start.isoformat()} "
            f"end_utc={end.isoformat()}"
        )
    return max(1, math.ceil(seconds / slot))


def _non_child_projections(
    catalog: LoadedCatalog,
) -> tuple[tuple[str, str], ...]:
    """Every projectable fact declared by a **non**-child resource type, as `(key,
    projection)` pairs ordered by key (Req 4.7). **Pure.**

    `FactDeclaration.projectable()` with no `resource_type` argument returns the union
    across every declared type, and that union is what `inventory_query`'s own
    `project` clause needs — except for a child type's own facts. A child type's
    projection expression names an identifier that exists only inside its own
    `mv-expand`-based query (`subnet`, for `Microsoft.Network/virtualNetworks/subnets`);
    `inventory_query` never runs that `mv-expand`, so the identifier is unbound there
    and the whole query would fail — for every resource type, on every run — the moment
    a child type declares even one projectable fact.

    Filtered per resource type rather than once over the flattened union, because two
    resource types can legitimately declare the identical `(key, projection)` pair
    (`sku_name`, say) and `projectable()`'s own de-duplication already handles that; this
    function only has to remove entries whose **owning type** is a child type, which
    `FactDeclaration.for_resource_type` already answers per type.
    """
    child_types = {name.casefold() for name in child_type_names(catalog)}
    excluded_keys: set[str] = set()
    for declared in catalog.facts.resource_types:
        if declared.resource_type.casefold() in child_types:
            excluded_keys.update(entry.key for entry in declared.facts)
    return tuple(
        pair for pair in catalog.facts.projectable() if pair[0] not in excluded_keys
    )


def _matches_resource_groups(resource: ResourceRecord, groups: Sequence[str]) -> bool:
    """Whether the resource is in one of the requested resource groups.

    Compared case-insensitively: Azure resource group names are case-insensitive, and
    Resource Graph lowercases `resourceGroup` in its response body, so a case-sensitive
    comparison against a name a consultant typed as `RG-Prod-SEA` would match nothing.
    An empty request list means "every group", not "no group".
    """
    if not groups:
        return True
    actual = (resource.get("resource_group") or "").casefold()
    return any(actual == group.casefold() for group in groups)


def _matches_tag_filters(resource: ResourceRecord, filters: Mapping[str, str]) -> bool:
    """Whether the resource carries every requested tag.

    Tag **names** are compared case-insensitively and tag **values** exactly, which is
    how Azure itself treats them: `Env` and `env` are one tag, `Prod` and `prod` are
    two values. Every filter must match (an `and`, not an `or`) — a scope asking for
    `env=prod` *and* `tier=db` means both.
    """
    if not filters:
        return True
    tags = {
        key.casefold(): value
        for key, value in (resource.get("tags") or {}).items()
        if isinstance(key, str) and isinstance(value, str)
    }
    return all(tags.get(name.casefold()) == value for name, value in filters.items())


def _requested_for(
    metrics_by_type: Mapping[str, Sequence[str]], resource_type: str
) -> tuple[str, ...]:
    """The metric names requested for `resource_type`, matched case-insensitively.

    The caller builds this map from `capabilities()`, which is keyed by the **catalog's**
    declared spelling (`Microsoft.Compute/virtualMachines`), while a resource's
    `resource_type` arrives from Resource Graph **lowercased**
    (`microsoft.compute/virtualmachines`). An exact lookup would miss for every real
    inventory row and present as a resource type nobody asked for any metric about — the
    same mismatch `LoadedCatalog.for_resource_type` folds for the same reason.

    An exact match is preferred when one exists, so a caller using the catalog's spelling
    pays no scan at all.
    """
    exact = metrics_by_type.get(resource_type)
    if exact is not None:
        return tuple(exact)
    folded = resource_type.casefold()
    for key, names in metrics_by_type.items():
        if key.casefold() == folded:
            return tuple(names)
    return ()


def _group_key(resource: ResourceRecord) -> tuple[str, str]:
    """`(resource_type, location)` — the grouping key minus the subscription, which is
    constant for one call. Completed with the subscription id when
    `azure/metrics.py` is asked for a group (Req 23.1)."""
    return (resource.get("resource_type") or "", resource.get("location") or "")


# --- the provider ---------------------------------------------------------------------


@dataclass(slots=True, kw_only=True)
class AzureProvider:
    """`providers.base.Provider` for Azure, over the five injected collectors.

    One instance per invocation. Every collaborator is a constructor argument, so the
    whole class is exercised against `tests/fakes/azure_ports.py` with no SDK anywhere
    — :func:`provider_over_ports` is the assembly helper both the tests and
    :func:`build_provider` go through, and only the latter hands it ports backed by
    real Azure clients.

    `actor_id` and `run_id` are here rather than on `CollectRequest` because they are
    facts about the *invocation* (`context.actor_id`, `context.run_id`), not about a
    scope: they prefix the raw archive's object keys (Req 26.8), which is a per-run
    property the provider protocol has no business restating per call.

    `fidelity_tier` is the **subscription's** tier as the preflight established it, and
    is stamped onto every resource `discover` returns and every statistic `collect`
    produces (Req 20.9, 31.2). Req 31.1's per-resource ceiling — a resource may be
    downgraded from the subscription's tier by this run's own evidence, never upgraded
    — is `collect/pipeline.py`'s to apply; this provider carries the ceiling and does
    not raise anything above it.
    """

    catalog: LoadedCatalog
    inventory: InventoryCollector
    skus: SkuCatalog
    definitions: DefinitionProbe
    metrics: MetricsCollector
    facts: FactsPort
    logs: MetricsPort
    """The run's `MetricsPort`, held directly for the one operation on it that has no
    collector module of its own: the enhanced tier's Log Analytics counter query
    (Req 31.4). It is the same port instance `metrics` reaches Azure through, so the
    guest query shares that port's client and credential rather than opening a second
    path to the same workspace."""
    actor_id: str
    run_id: str
    fidelity_tier: str = FIDELITY_BASELINE
    fact_clock: Callable[[], datetime] | None = None
    """Each fact response's receipt instant, or `None` for the wall clock.

    A seam rather than a hard-coded `datetime.now`, because `collected_at` enters the
    snapshot's canonical form and therefore its digest: a test that compares two digests over
    identical inputs is otherwise comparing two instants. See :func:`provider_over_ports`."""
    on_close: Callable[[], None] | None = field(default=None, repr=False)

    # --- discover (Req 18.2, 18.9, 20.x) --------------------------------------------

    async def discover(self, scope: ScopeSpec) -> DiscoverResult:
        """Enumerate the in-scope inventory, ordered by resource id (Req 18.2, 18.9).

        Delegates the whole Resource Graph interaction — paging, the quota waits, the
        power-state and duplicate-row gaps — to `azure/inventory.py`, then applies the
        two scope filters the Resource Graph query itself does not carry:
        `resource_groups` and `tag_filters`. The query is scoped to the subscription
        and to the resource types (Req 20.11); the other two components of `ScopeSpec`
        are narrowed here, over plain data, because a provider that ignored them would
        return an inventory wider than the scope the snapshot records as requested
        (Req 35.9).

        **Every gap the collection recorded is returned, including one naming a
        resource a group or tag filter then excluded.** A gap is a record of what the
        collection observed, and dropping observations to match a filter would make the
        gap count depend on the filter rather than on what Azure answered.

        The ordering is asserted, not assumed: `inventory.py` already sorts through
        `sort_inventory`, and this call re-sorts after filtering and then asserts —
        cheap, and it means a future filter that reordered rows fails here rather than
        producing a snapshot whose array order differs from a second identical run's.
        """
        result = await self.inventory.discover(
            subscription_id=scope["subscription_id"],
            resource_types=tuple(scope["resource_types"]),
            fidelity_tier=self.fidelity_tier,
            # Every projectable fact the catalog declares, as `(key, projection)` pairs
            # ordered by key (Req 4.7). The **union across every declared type**, not this
            # scope's types: one Resource Graph query serves the whole scope, a projected
            # column that does not apply to a row comes back empty rather than failing the
            # query, and narrowing per type would mean one query per type — which is the
            # cost the projection exists to avoid. `FactDeclaration.projectable`
            # de-duplicates, so the several types declaring `sku_name` identically project
            # it once.
            #
            # **Except a child type's own facts (task 6.1).** A child type's projection
            # expression (`tostring(subnet.name)`, say) refers to an identifier —
            # `subnet` — that exists only inside `subnet_inventory_query`'s own
            # `mv-expand subnet = properties.subnets`. `inventory_query` never runs that
            # `mv-expand`, so appending a child type's projection to its `project` clause
            # would reference an unbound identifier and fail the query for every run,
            # for every resource type, the instant a child type's facts are declared.
            # `_non_child_projections` is what keeps the union exactly what it was before
            # any child type existed.
            fact_projections=_non_child_projections(self.catalog),
            # The **same** writer the metrics collector uses, not a second one: the
            # snapshot records one `raw_archive.object_count`, and a replay refuses to
            # proceed when the objects supplied and the objects the sequence names differ.
            # Two writers would keep two sequences and two counts, and one of them would
            # be wrong (Req 26.12, 7.1).
            archive=InventoryArchiveContext(
                writer=self.metrics.archive_writer,
                actor_id=self.actor_id,
                run_id=self.run_id,
                catalog_version=self.catalog.catalog_version,
            ),
        )

        groups = tuple(scope.get("resource_groups") or ())
        filters = dict(scope.get("tag_filters") or {})
        resources: list[ResourceRecord] = [
            resource
            for resource in result["resources"]
            if _matches_resource_groups(resource, groups)
            and _matches_tag_filters(resource, filters)
        ]
        if len(resources) != len(result["resources"]):
            logger.info(
                "%d of %d discovered resources fall outside the requested resource "
                "groups or tag filters and were excluded from the inventory; every "
                "recorded gap is retained.",
                len(result["resources"]) - len(resources),
                len(result["resources"]),
            )

        gaps = list(result["gaps"])

        # --- child resources (task 6.1) --------------------------------------------
        #
        # Issued only when the scope actually requests a resource type that has a
        # synthetic child type — today, `Microsoft.Network/virtualNetworks` for
        # subnets and `Microsoft.Network/networkSecurityGroups` for security rules
        # (task 6.3). Gating on either parent type rather than issuing this
        # unconditionally on every run is what keeps a scope with neither in it from
        # paying for a query that could only ever answer "no rows" for both of its
        # legs: `child_resources_query` (task 6.1, 6.3) unions the subnet and
        # security-rule queries into one request, so one gate covers both — a run
        # whose scope names only one of the two parents still issues the combined
        # query, and the other leg's `where type =~ ...` filter simply contributes
        # zero rows for it, which is honest and costs nothing extra. Deliberately
        # gated on the same scope test the section catalogue's own
        # `needs_resource_types` entries already apply — section 3 declares
        # `["Microsoft.Network/virtualNetworks"]` and section 6 declares
        # `["Microsoft.Network/networkSecurityGroups"]`, so "either section is
        # offerable" and "this query is worth issuing" are one condition, not two
        # that could disagree.
        #
        # **An empty `resource_types` is unconstrained, and this gate has to read it the
        # same way the query does.** `inventory_query` applies its `| where type in~ (...)`
        # only `if resource_types`, so an empty list collects every type — which is how the
        # Enesis run collected three network security groups and a virtual network in the
        # first place. This gate read the same empty list as "names neither parent",
        # because `any()` over nothing is false, and issued no child query at all. Every
        # security rule and every subnet was therefore missing from every report whose
        # profile did not enumerate resource types by hand, with **no gap recorded** —
        # nothing had been asked for, so nothing was reported absent. The section printed
        # "None of these facts were collected" and looked like a collection failure.
        requested = scope["resource_types"]
        if not requested or any(
            name.casefold() in _CHILD_RESOURCE_PARENT_TYPES for name in requested
        ):
            child_result = await self.inventory.discover_child_resources(
                subscription_id=scope["subscription_id"],
                fidelity_tier=self.fidelity_tier,
                archive=InventoryArchiveContext(
                    writer=self.metrics.archive_writer,
                    actor_id=self.actor_id,
                    run_id=self.run_id,
                    catalog_version=self.catalog.catalog_version,
                ),
            )
            # No group/tag filter applied to a child resource: it inherits its
            # parent's own resource group (the query reads that column off the
            # parent's row, not the child's), and a filter that excluded the parent
            # would already have excluded the parent from `resources` above — a
            # child whose own resource-group column matches would then be the only
            # remaining trace of a parent the scope asked to exclude, which is the
            # opposite of what the filter means. Filtering child resources by the
            # SAME resource_group/tag test the parent already passed keeps that
            # consistent, regardless of which parent type produced the child.
            filtered_children = [
                child
                for child in child_result["resources"]
                if _matches_resource_groups(child, groups)
                and _matches_tag_filters(child, filters)
            ]
            resources.extend(filtered_children)
            gaps.extend(child_result["gaps"])

        discovered = DiscoverResult(
            resources=sort_inventory(resources),
            gaps=gaps,
            # Passed through **unfiltered**, exactly as the gaps are: the pages are what
            # Azure answered, and `collect_facts` folds a page against the resource ids that
            # page names. A row a group or tag filter excluded contributes a fact for a
            # resource the snapshot does not carry, which the Snapshot_Builder ignores —
            # whereas trimming the pages here would mean two derivations of one filter.
            inventory_pages=list(result.get("inventory_pages") or ()),
        )
        assert_inventory_sorted(discovered["resources"])
        assert_plain_data(discovered)
        return discovered

    # --- facts (Req 4.7, 4.8, 4.9, 5.1-5.5) ------------------------------------------

    async def collect_facts(self, request: FactRequest) -> FactResult:
        """The fact pass: the projected columns plus the three subscription-scoped lists.

        Constructed per call rather than held on this provider, because a `FactCollector` is
        cheap and holding one would mean holding the semaphore lookup's answer across a run
        whose subscription is fixed anyway — state with no second reader.

        `semaphore_for` returns the **same** object the metrics collector acquires, so a fact
        request and a metric request share one budget of eight (Req 4.9).
        """
        collector = FactCollector(
            self.facts,
            self.metrics.archive_writer,
            declaration=self.catalog.facts,
            semaphore=self.metrics.semaphore_for(request["subscription_id"]),
            **({} if self.fact_clock is None else {"clock": self.fact_clock}),
            # Req 7.1 — every fact-producing response is archived in the pass that folds it.
            # The **same** writer the metrics pass and the inventory pass use, so one run has
            # one sequence and one `object_count`; a second writer would produce a second
            # count and the replay refuses when the count and the objects disagree.
            archive_context=FactArchiveContext(
                actor_id=self.actor_id,
                run_id=self.run_id,
                catalog_version=self.catalog.catalog_version,
            ),
        )
        result = await collector.collect(
            resources=request["resources"],
            inventory_pages=request["inventory_pages"],
            subscription_id=request["subscription_id"],
        )
        collected = FactResult(facts=list(result.facts), gaps=list(result.gaps))
        assert_plain_data(collected)
        return collected

    # --- collect (Req 18.2, 18.3, 21.x-30.x) -----------------------------------------

    async def collect(self, request: CollectRequest) -> CollectResult:
        """Fold every in-scope metric response into per-resource statistics.

        One `(subscription, location, resource_type)` group at a time (Req 23.1), in
        sorted key order so two runs over one inventory request the same groups in the
        same sequence. Per group:

        1. **Definitions**, once per `(resource_type, region)` and cached
           (Req 22.1, 22.2). A pair whose probe failed carries its own
           `definitions_unavailable` gap and falls back to the catalog's declared set
           (Req 22.5); a metric absent from a *successful* probe records
           `metric_not_emitted` per resource (Req 20.7) and is not requested.
        2. **SKU capacity** per resource, from the location-filtered listing
           (Req 21.1, 21.6), for the capabilities this resource type declares.
        3. **Accumulators** per `(resource, metric)`, built from the catalog's declared
           unit family so the right sketch is selected (Req 28.13), and marked
           `excluded` for a resource whose power state disqualifies it from every
           average (Req 20.6, 20.13).
        4. **The request**, through `azure/metrics.py`, which plans the batches, halves
           on rejection, waits out 429s, archives each accepted response in the same
           pass and folds it (Req 23.x, 26.x, 29.x).
        5. **Finalize**, into `StatValue` objects built by `collect/snapshot.py`'s own
           builders — exact avg/min/max, every catalog-declared percentile from the
           folded sketch, and every derived statistic the catalog declares.

        Returns `statistics` keyed resource id -> metric name -> statistic name, and
        every gap every stage produced. Raises rather than swallowing: `main.py` turns
        an exception into one terminal `error` plus `done` (Req 18.8).
        """
        scope = request["scope"]
        subscription_id = scope["subscription_id"]
        grain = request["grain"]
        window = dict(request["window"])
        interval_count = interval_count_for(window, grain)
        metrics_by_type = request["metrics_by_resource_type"]

        gaps: list[GapRecord] = []
        statistics: dict[str, dict[str, dict[str, StatValue]]] = {}
        day_statistics: dict[str, dict[str, list[StatValue]]] = {}
        capacities: dict[str, SkuCapacityRecord] = {}

        # One fold for the whole run, across every group. Keyed by resource id, so a
        # per-group fold would work too — but the timezone belongs to the run and giving
        # each group its own would be one more place for two of them to differ.
        day_fold = DayFold(tz=resolve_timezone(request["timezone"]))

        for key, group in self._groups(request["resources"]):
            resource_type, location = key
            group_gaps, group_statistics, group_days, group_capacities = (
                await self._collect_group(
                    subscription_id=subscription_id,
                    resource_type=resource_type,
                    location=location,
                    resources=group,
                    requested_metric_names=_requested_for(metrics_by_type, resource_type),
                    grain=grain,
                    window=window,
                    interval_count=interval_count,
                    day_fold=day_fold,
                )
            )
            gaps.extend(group_gaps)
            statistics.update(group_statistics)
            day_statistics.update(group_days)
            capacities.update(group_capacities)

        resolver = self.metrics.region_resolver
        archive = self.metrics.archive_writer

        collected = CollectResult(
            statistics=statistics,
            gaps=gaps,
            # The day dimension `timeseries_chart` addresses by `snapshot_path`. Optional
            # on the protocol, so a provider with no per-day fold simply omits it and the
            # snapshot keeps the day geometry with no statistics under it.
            day_statistics=day_statistics,
            # Req 35.3 — the capacity actually used, per resource. Reported here because
            # nothing downstream of this boundary can ask the SKU catalog itself.
            sku_capacities=capacities,
            # Req 26.12 — known only to whatever wrote the archive during the fold pass.
            raw_archive=RawArchiveState(
                complete=not archive.archive_incomplete,
                object_count=archive.object_count,
            ),
            # Req 24.3, 24.5 — the routing facts, as plain data, so the pipeline can
            # apply the all-locations-unreachable escalation without reaching into
            # `azure/regions.py` (which it may not import at all).
            locations=LocationRouting(
                requested=sorted(resolver.requested_locations),
                unreachable=sorted(resolver.unreachable_locations),
            ),
        )
        assert_plain_data(collected)
        return collected

    def _groups(
        self, resources: Iterable[ResourceRecord]
    ) -> list[tuple[tuple[str, str], list[ResourceRecord]]]:
        """The run's resources grouped by `(resource_type, location)` (Req 23.1).

        Groups are returned in sorted key order and each group's resources in sorted
        resource-id order, so the batch plan `azure/metrics.py` produces is a function
        of the inventory alone rather than of the order rows happened to arrive in —
        which is what Property 4's determinism clause asserts of the planner.
        """
        grouped: dict[tuple[str, str], list[ResourceRecord]] = {}
        for resource in resources:
            grouped.setdefault(_group_key(resource), []).append(resource)
        return [
            (key, sorted(grouped[key], key=lambda item: item["resource_id"]))
            for key in sorted(grouped)
        ]

    async def _collect_group(
        self,
        *,
        subscription_id: str,
        resource_type: str,
        location: str,
        resources: Sequence[ResourceRecord],
        requested_metric_names: Sequence[str],
        grain: str,
        window: Mapping[str, str],
        interval_count: int,
        day_fold: DayFold,
    ) -> tuple[
        list[GapRecord],
        dict[str, dict[str, dict[str, StatValue]]],
        dict[str, dict[str, list[StatValue]]],
        dict[str, SkuCapacityRecord],
    ]:
        """One `(subscription, location, resource_type)` group, start to finish."""
        gaps: list[GapRecord] = []
        resource_catalog = self.catalog.for_resource_type(resource_type)

        if resource_catalog is None:
            # The pipeline derives its metric names from `capabilities()`, which is
            # this same catalog, so a resource type with no catalog entry cannot be
            # requested through a correctly-wired caller. Logged rather than turned
            # into a gap: inventing a `collection_log` entry for a caller bug would
            # report it as a fact about the customer's subscription.
            logger.warning(
                "resource type %r has no Metric_Catalog entry; no metric was "
                "requested for its %d resource(s) in %s.",
                resource_type,
                len(resources),
                location,
            )
            return gaps, {}, {}, {}

        declared = {metric.name: metric for metric in resource_catalog.metrics}
        resource_ids = tuple(resource["resource_id"] for resource in resources)

        selected, definition_gaps = await self._select_metric_names(
            resource_catalog=resource_catalog,
            location=location,
            resource_ids=resource_ids,
            requested_metric_names=requested_metric_names,
            declared=declared,
        )
        gaps.extend(definition_gaps)

        if not selected:
            logger.info(
                "no requested metric is collectable for %s in %s; %d resource(s) "
                "produce no statistic and carry their recorded gaps instead.",
                resource_type,
                location,
                len(resources),
            )
            return gaps, {}, {}, {}

        capacities: dict[str, SkuCapacity | None] = {}
        accumulators: dict[tuple[str, str], MetricAccumulator] = {}
        excluded_ids: set[str] = set()

        for resource in resources:
            resource_id = resource["resource_id"]
            excluded = is_excluded_from_averages(resource)
            if excluded:
                excluded_ids.add(resource_id)
            else:
                capacity, sku_gaps = await self._resolve_capacity(
                    resource_catalog=resource_catalog,
                    subscription_id=subscription_id,
                    location=location,
                    resource=resource,
                )
                capacities[resource_id] = capacity
                gaps.extend(sku_gaps)

            for name in selected:
                accumulator, gap = new_accumulator(
                    declared[name].unit_family,
                    resource_id=resource_id,
                    metric=name,
                    excluded=excluded,
                    aggregations=declared[name].aggregations,
                )
                accumulators[(resource_id, name)] = accumulator
                if gap is not None:
                    gaps.append(gap)

        gaps.extend(
            await self.metrics.collect_group(
                actor_id=self.actor_id,
                run_id=self.run_id,
                subscription_id=subscription_id,
                location=location,
                resource_type=resource_type,
                resource_ids=resource_ids,
                metric_namespace=resource_catalog.metric_namespace,
                metric_names=selected,
                accumulators=accumulators,
                day_fold=day_fold,
                grain=grain,
                window=window,
                start_time=window["start_utc"],
                end_time=window["end_utc"],
                interval_count=interval_count,
                # One `aggregation` parameter per call, so the collector partitions by
                # this mapping. Taken from the same `declared` entries the accumulators
                # above were built from, so the set that is requested and the set the
                # fold classifies against cannot disagree.
                aggregations_by_metric={
                    name: declared[name].aggregations for name in selected
                },
            )
        )

        statistics: dict[str, dict[str, dict[str, StatValue]]] = {}
        days: dict[str, dict[str, list[StatValue]]] = {}
        for resource in resources:
            resource_id = resource["resource_id"]
            tier = resource.get("fidelity_tier") or self.fidelity_tier
            entries, finalize_gaps = self._finalize_resource(
                resource=resource,
                resource_catalog=resource_catalog,
                declared=declared,
                selected=selected,
                accumulators=accumulators,
                capacity=capacities.get(resource_id),
                grain=grain,
            )
            gaps.extend(finalize_gaps)
            if entries:
                statistics[resource_id] = _statistics_by_metric(entries)

            # The day dimension, over the window's own geometry rather than over the days
            # that happened to carry a value: a day the collection found nothing for is
            # still a day of the window, and dropping it would make a gap in the data look
            # like a gap in the calendar.
            by_day = {
                local_day: [entry.to_plain_data() for entry in entries]
                for local_day, entries in day_fold.statistics_for(
                    resource_id,
                    declared=declared,
                    selected=selected,
                    fidelity_tier=tier,
                    grain=grain,
                ).items()
            }
            if by_day:
                days[resource_id] = by_day

        return gaps, statistics, days, _capacity_records(capacities)

    async def _select_metric_names(
        self,
        *,
        resource_catalog: ResourceTypeCatalog,
        location: str,
        resource_ids: Sequence[str],
        requested_metric_names: Sequence[str],
        declared: Mapping[str, MetricEntry],
    ) -> tuple[tuple[str, ...], list[GapRecord]]:
        """The metric names to request for one pair, and the gaps that decision made.

        Requested names are first narrowed to the ones the Metric_Catalog declares for
        this resource type — an undeclared name has no unit family to select a sketch
        with and no scale to serialize at, so there is nothing this runtime could
        honestly do with a value for it.

        The definitions probe then decides the rest (Req 22.1, 22.5, 22.6, 20.7):

        * **probed successfully** — a requested metric absent from the answer is one
          the platform does not emit for this type in this region, so it records a
          `metric_not_emitted` gap per resource (Req 20.7) and is not requested.
        * **catalog fallback** — the probe never landed, so *nothing* is known about
          which metrics are emitted. Every requested name is requested and **no**
          `metric_not_emitted` gap is recorded (Req 22.6): an unanswered probe must
          stay distinguishable from a metric the platform genuinely does not emit.
        """
        gaps: list[GapRecord] = []
        catalog_names = tuple(name for name in requested_metric_names if name in declared)

        undeclared = [name for name in requested_metric_names if name not in declared]
        if undeclared:
            logger.warning(
                "metric name(s) %r are not declared for %s in the Metric_Catalog and "
                "were not requested; the caller's metric set should come from "
                "capabilities().",
                sorted(undeclared),
                resource_catalog.resource_type,
            )

        if not catalog_names:
            return (), gaps

        definitions = await self.definitions.definitions_for(
            resource_type=resource_catalog.resource_type,
            region=location,
            metric_namespace=resource_catalog.metric_namespace,
            resource_ids=resource_ids,
        )
        if definitions.gap is not None:
            gaps.append(definitions.gap)

        if definitions.is_fallback:
            return catalog_names, gaps

        available = frozenset(definitions.metric_names)
        selected = tuple(name for name in catalog_names if name in available)

        for name in catalog_names:
            if name in available:
                continue
            for resource_id in resource_ids:
                gaps.append(
                    record_gap(
                        GAP_TYPE_METRIC_NOT_EMITTED,
                        resource_id,
                        name,
                        f"metric {name!r} is absent from the metric definitions "
                        f"Azure reports for {resource_catalog.resource_type!r} in "
                        f"{location!r}, so this platform does not emit it for this "
                        f"resource; no value is requested and none is recorded.",
                    )
                )

        return selected, gaps

    async def _resolve_capacity(
        self,
        *,
        resource_catalog: ResourceTypeCatalog,
        subscription_id: str,
        location: str,
        resource: ResourceRecord,
    ) -> tuple[SkuCapacity | None, list[GapRecord]]:
        """This resource's SKU capacity, or `(None, [])` if its type declares none.

        A resource type declaring no `sku_capabilities` has no derived statistic that
        could depend on a capacity, so no listing is requested for it at all — which
        keeps a future non-VM resource type from paying for a `resource_skus.list` it
        has no use for.
        """
        if not resource_catalog.sku_capabilities:
            return None, []
        return await self.skus.resolve(
            subscription_id=subscription_id,
            location=location,
            sku_name=resource.get("sku_name") or "",
            resource_id=resource["resource_id"],
        )

    def _finalize_resource(
        self,
        *,
        resource: ResourceRecord,
        resource_catalog: ResourceTypeCatalog,
        declared: Mapping[str, MetricEntry],
        selected: Sequence[str],
        accumulators: Mapping[tuple[str, str], MetricAccumulator],
        capacity: SkuCapacity | None,
        grain: str,
    ) -> tuple[list[StatisticEntry], list[GapRecord]]:
        """One resource's finalized statistics, exact then percentile then derived.

        The sequence itself lives in `collect/finalize.py` and is called from here rather
        than written here, because `verify/replay.py` has to run **the same** code (Req
        31.1) — a second implementation would make a replay mismatch mean "the two
        implementations disagree" rather than "the aggregation is not deterministic".

        What stays here is the one provider-specific step: reading this cloud's capacity
        object into the capability values the catalog's derivations bind to.
        """
        return finalize_resource(
            resource_id=resource["resource_id"],
            fidelity_tier=resource.get("fidelity_tier") or self.fidelity_tier,
            grain=grain,
            declared=declared,
            selected=selected,
            accumulators=accumulators,
            derived_entries=resource_catalog.derived,
            sku_capability_values=_sku_capability_values(
                resource_catalog.sku_capabilities, capacity
            ),
        )

    # --- capabilities (Req 18.6) -----------------------------------------------------

    def capabilities(self) -> Capabilities:
        """What this provider collects, read entirely from the loaded catalog.

        `resource_types` and `metrics` name only resource types with at least one valid
        entry after catalog validation (Req 32.4): a type whose every entry failed
        validation cannot be collected, so claiming it would invite a caller to request
        it. `metrics` carries **platform metric names only** — a derived statistic id
        (`memory_used_pct`) and an enhanced-tier counter id (`disk_free_pct`) are not
        names that can be requested from the metrics endpoint, and this map is what a
        caller populates `CollectRequest.metrics_by_resource_type` from.

        Every list is sorted here rather than inherited from file order, the same
        produced-not-inherited discipline the snapshot path holds (Req 34.8).
        """
        collectable = [
            resource_type
            for resource_type in self.catalog.resource_types
            if resource_type.has_valid_entries
        ]
        return Capabilities(
            resource_types=sorted(
                resource_type.resource_type for resource_type in collectable
            ),
            metrics={
                resource_type.resource_type: sorted(
                    metric.name for metric in resource_type.metrics
                )
                for resource_type in collectable
            },
            grains=list(SUPPORTED_GRAINS),
            fidelity_tiers=list(FIDELITY_TIERS),
        )

    # --- the enhanced tier's guest-observed counters (Req 31.4, 31.6, 31.7) ---------

    async def collect_guest_counters(
        self, request: GuestCounterRequest
    ) -> GuestCounterResult:
        """Query each declared guest counter for each resource (Req 31.4).

        Satisfies `providers.base.GuestCounterProvider`, which is deliberately a
        *separate* protocol from `Provider` — see that module's note. What this method
        returns is **rows**, not figures: the `_Total` / absent / empty `InstanceName`
        classification (Req 31.6) and the downgrade decision (Req 31.7) belong to
        `collect/pipeline.py`, which sees the whole run and owns the fidelity tier. A
        provider that repaired or filtered those rows would erase the evidence the gap is
        recorded from.

        One query per `(resource, counter)` pair, bounded to the run's own half-open
        window (Req 31.4) — never a trailing duration, which for a report about a past
        month would read the wrong period while looking entirely plausible.

        **A failed query is an outcome, not an exception.** This is the one place in this
        module that catches broadly, and Req 31.7 is why: an enhanced resource whose query
        fails downgrades to `baseline` and the run *continues*, so raising here would cost
        the outcomes of every resource after it in the loop as well as the run itself.
        The exception text is carried on the outcome for the caller to record as a
        `metric_error` gap; it is not swallowed.
        """
        workspace_id = (request.get("workspace_id") or "").strip()
        window = request["window"]
        outcomes: list[GuestCounterOutcome] = []

        if not workspace_id:
            # Nothing to query against. Reported as one `failed` outcome per pair rather
            # than as an empty result, so the caller downgrades and records a gap for
            # each affected resource instead of silently emitting no guest value.
            for resource in request["resources"]:
                for spec in request["counters"]:
                    outcomes.append(
                        _guest_outcome(
                            resource_id=resource["resource_id"],
                            spec=spec,
                            workspace_id="",
                            status=GUEST_STATUS_FAILED,
                            message=(
                                "the invocation carries no log_analytics_workspace_id, "
                                "so no guest-observed counter could be read"
                            ),
                        )
                    )
            return GuestCounterResult(outcomes=outcomes)

        for resource in request["resources"]:
            for spec in request["counters"]:
                outcomes.append(
                    await self._one_guest_counter(
                        resource_id=resource["resource_id"],
                        spec=spec,
                        workspace_id=workspace_id,
                        window=window,
                    )
                )

        result = GuestCounterResult(outcomes=outcomes)
        assert_plain_data(result)
        return result

    async def _one_guest_counter(
        self,
        *,
        resource_id: str,
        spec: GuestCounterSpec,
        workspace_id: str,
        window: Mapping[str, str],
    ) -> GuestCounterOutcome:
        """One `(resource, counter)` query, as an outcome. Never raises."""
        try:
            response = await self.logs.query_logical_disk_free_space(
                workspace_id=workspace_id,
                resource_id=resource_id,
                start_time=window["start_utc"],
                end_time=window["end_utc"],
            )
        except Exception as exc:  # see `collect_guest_counters` — Req 31.7
            logger.warning(
                "the guest-observed %s query for %s failed; this resource collects at "
                "the baseline tier and the run continues: %s",
                spec["counter"],
                resource_id,
                exc,
            )
            return _guest_outcome(
                resource_id=resource_id,
                spec=spec,
                workspace_id=workspace_id,
                status=GUEST_STATUS_FAILED,
                message=f"the guest-observed counter query failed: {exc}",
            )

        if not response.ok:
            return _guest_outcome(
                resource_id=resource_id,
                spec=spec,
                workspace_id=workspace_id,
                status=GUEST_STATUS_FAILED,
                message=(
                    f"the guest-observed counter query was rejected with HTTP "
                    f"{response.status}"
                ),
            )

        rows = _guest_rows(response.body)
        if not rows:
            return _guest_outcome(
                resource_id=resource_id,
                spec=spec,
                workspace_id=workspace_id,
                status=GUEST_STATUS_EMPTY,
                message=(
                    "the guest-observed counter query returned no row inside the "
                    "collection window"
                ),
            )

        return _guest_outcome(
            resource_id=resource_id,
            spec=spec,
            workspace_id=workspace_id,
            status=GUEST_STATUS_OK,
            message=None,
            rows=rows,
        )

    # --- teardown --------------------------------------------------------------------

    def close(self) -> None:
        """Discard this run's caches and release whatever built this provider.

        Not part of `providers.base.Provider`: the protocol is about collecting, and a
        caller that never calls this leaks nothing beyond the instance's own lifetime.
        It exists so the SKU listing cache (Req 21.11) and the credential
        (`build_provider`'s `InvocationCredential`) are released deliberately at run
        end rather than whenever the garbage collector notices — SKU restrictions are
        subscription-scoped, and a long-lived container serves more than one customer.

        The definitions cache needs no explicit discard: it is an attribute of the
        `DefinitionProbe` this instance holds, so it goes when the provider does
        (Req 22.7).
        """
        self.skus.discard()
        if self.on_close is not None:
            self.on_close()


def _guest_outcome(
    *,
    resource_id: str,
    spec: GuestCounterSpec,
    workspace_id: str,
    status: str,
    message: str | None,
    rows: list[GuestCounterRow] | None = None,
) -> GuestCounterOutcome:
    """One `GuestCounterOutcome`, built in one place so no field is forgotten.

    `counter` is the catalog's `object`/`counter` pair rendered as the name a value
    records (Req 31.4) — `LogicalDisk \\ % Free Space`, the spelling Windows performance
    counters use — rather than the bare counter name, because `% Free Space` alone does
    not say what it is free space *of*.
    """
    return GuestCounterOutcome(
        resource_id=resource_id,
        statistic_id=spec["statistic_id"],
        counter=f"{spec['object']} \\ {spec['counter']}",
        workspace_id=workspace_id,
        status=status,
        message=message,
        rows=list(rows or ()),
    )


_LOGS_TIME_COLUMN: Final[str] = "TimeGenerated"
_LOGS_INSTANCE_COLUMN: Final[str] = "InstanceName"
_LOGS_VALUE_COLUMN: Final[str] = "CounterValue"


def _guest_rows(body: object) -> list[GuestCounterRow]:
    """A Log Analytics query answer as plain counter rows. **Pure.**

    The response shape — `{"tables": [{"columns": [...], "rows": [[...]]}]}` — is read by
    **column name**, never by position: the projection's column order is not something a
    figure should depend on, and a row read positionally against a reordered projection
    would attribute one column's value to another.

    `instance_name` is carried through exactly as returned, including `"_Total"` and
    `""`, and is `None` when the projection carried no `InstanceName` column at all.
    Those three are the shapes of the AMA regression Req 31.6 names, and normalising any
    of them here would destroy the distinction the caller has to make.

    `value` becomes a decimal string through `Decimal(str(...))` — the digit string the
    JSON decoder produced, never the nearest binary fraction (Req 27.6, 34.2). A row whose
    value is not numeric is **dropped**, not zero-filled: a row that carries no reading is
    not a reading of zero.
    """
    if not isinstance(body, Mapping):
        return []
    tables = body.get("tables")
    if not isinstance(tables, Sequence) or isinstance(tables, (str, bytes)):
        return []

    rows: list[GuestCounterRow] = []
    for table in tables:
        if not isinstance(table, Mapping):
            continue
        columns = table.get("columns")
        raw_rows = table.get("rows")
        if not isinstance(columns, Sequence) or not isinstance(raw_rows, Sequence):
            continue
        index_of = {
            column["name"]: position
            for position, column in enumerate(columns)
            if isinstance(column, Mapping) and isinstance(column.get("name"), str)
        }
        value_at = index_of.get(_LOGS_VALUE_COLUMN)
        if value_at is None:
            continue
        instance_at = index_of.get(_LOGS_INSTANCE_COLUMN)
        time_at = index_of.get(_LOGS_TIME_COLUMN)

        for raw_row in raw_rows:
            if not isinstance(raw_row, Sequence) or isinstance(raw_row, (str, bytes)):
                continue
            if value_at >= len(raw_row):
                continue
            value = _as_guest_decimal(raw_row[value_at])
            if value is None:
                continue
            instance = (
                raw_row[instance_at]
                if instance_at is not None and instance_at < len(raw_row)
                else None
            )
            timestamp = (
                raw_row[time_at]
                if time_at is not None and time_at < len(raw_row)
                else None
            )
            rows.append(
                GuestCounterRow(
                    instance_name=instance if isinstance(instance, str) else None,
                    value=str(value),
                    timestamp=timestamp if isinstance(timestamp, str) else "",
                )
            )
    return rows


def _as_guest_decimal(value: object) -> Decimal | None:
    """One counter reading as a `Decimal`, or `None` if it is not numeric. **Pure.**

    `Decimal(str(value))` for a `float`, matching `azure/metrics.py`'s `_as_decimal`
    exactly: it round-trips the digit string the JSON decoder saw rather than the value's
    nearest binary fraction, which is the difference between `37.2` and
    `37.19999999999999928945726423989981412887573242188` reaching a snapshot.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return Decimal(str(value))
    if isinstance(value, str) and value.strip():
        try:
            return Decimal(value)
        except InvalidOperation:
            return None
    return None


def _statistics_by_metric(
    entries: Iterable[StatisticEntry],
) -> dict[str, dict[str, StatValue]]:
    """`metric name -> statistic name -> StatValue` for one resource (Req 18.2).

    Each `StatValue` is exactly `StatisticEntry.to_plain_data()`: the same plain-data
    object the snapshot document carries, with its value already rendered as a decimal
    string at the catalog-declared scale (Req 34.1) and its estimator, label and
    derivation fields already produced by `collect/snapshot.py`. There is no second
    formatter here, deliberately — the verifier matches document tokens against these
    strings, so a second spelling would be a verification failure on a correct report.

    A `(metric, statistic)` pair emitted twice keeps the last entry, which cannot
    happen for input this module produces: the exact directions, the declared
    percentiles and the derived directions are disjoint by construction.
    """
    by_metric: dict[str, dict[str, StatValue]] = {}
    for entry in entries:
        by_metric.setdefault(entry.metric, {})[entry.statistic] = entry.to_plain_data()
    return by_metric


def _capacity_records(
    capacities: Mapping[str, SkuCapacity | None],
) -> dict[str, SkuCapacityRecord]:
    """Each resolved SKU capacity as the plain-data record `CollectResult` carries.

    Built through `collect/snapshot.py`'s own `SkuCapacity.to_plain_data()` rather than
    formatted here, for the same reason every statistic is: the snapshot document is
    where these strings are read back, so producing them anywhere but in the class that
    defines their shape would be a second spelling of one contract. A capability that
    did not resolve is omitted by that method, never zero-filled (Req 21.8, 21.9).

    A resource whose capacity is `None` — its type declares no `sku_capabilities`, or it
    was excluded from every average — contributes no entry at all; the caller falls back
    to the SKU name on the inventory record, which is the only fact known about it.
    """
    records: dict[str, SkuCapacityRecord] = {}
    for resource_id, capacity in capacities.items():
        if capacity is None:
            continue
        vcpus = capacity.vcpus_available
        records[resource_id] = cast(
            "SkuCapacityRecord",
            SnapshotSkuCapacity(
                name=capacity.sku_name,
                vcpus_available=int(vcpus) if vcpus is not None else None,
                memory_bytes=capacity.memory_bytes,
            ).to_plain_data(),
        )
    return records


def _sku_capability_values(
    capability_names: Sequence[str], capacity: SkuCapacity | None
) -> dict[str, Decimal | None]:
    """Each declared SKU capability's resolved value, or `None`.

    `None` for every capability when the SKU itself did not resolve (`sku_unknown`),
    and `None` for one capability that resolved as absent or unparseable
    (`sku_capability_missing`) — `azure/skus.py` recorded the gap for either case
    already, and `derive_statistic` reads the `None` as "derive nothing that depends on
    this capacity" (Req 21.8, 30.7).
    """
    values: dict[str, Decimal | None] = dict.fromkeys(capability_names)
    if capacity is None:
        return values
    for name, read in _SKU_CAPABILITY_READERS:
        if name in values:
            values[name] = read(capacity)
    return values


# --- assembly -------------------------------------------------------------------------


def provider_over_ports(
    *,
    inventory_port: InventoryPort,
    sku_port: SkuPort,
    definitions_port: DefinitionsPort,
    metrics_port: MetricsPort,
    facts_port: FactsPort,
    object_store: ObjectStore,
    actor_id: str,
    run_id: str,
    fidelity_tier: str = FIDELITY_BASELINE,
    catalog: LoadedCatalog | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    fact_clock: Callable[[], datetime] | None = None,
    inventory_clock: Callable[[], datetime] | None = None,
    on_close: Callable[[], None] | None = None,
) -> AzureProvider:
    """Assemble an :class:`AzureProvider` over five ports and one object store.

    The one place the five collector modules are wired together, so the wiring is
    identical whether the ports are the recorded-response fakes or the SDK-backed
    adapters :func:`build_provider` constructs. `sleep` is threaded through to the two
    modules that wait — `azure/inventory.py`'s quota waits and `azure/metrics.py`'s
    429 waits — so a test drives both over simulated time.

    `catalog` defaults to `load_catalog()`, the file shipped in the image (Req 32.8);
    a test supplying its own passes it explicitly rather than patching a module.

    `fact_clock` supplies each fact response's receipt instant, and it is a seam for the same
    reason `sleep` is. A fact's `collected_at` is **part of the snapshot's canonical form**, so
    with the wall clock deciding it two runs over identical inputs produce different digests —
    which is correct in production, where the instants genuinely differ, and makes any test
    that compares one digest to another depend on how long the test took. `None` keeps the wall
    clock, which is what a deployed run wants.

    `inventory_clock` is the same seam for the inventory pass, and it exists for a sharper
    reason than symmetry: a **projected** fact's `collected_at` is the instant its inventory
    page was received, so this clock — not `fact_clock` — decides a value inside the hashed
    document. The two used to be one thing by accident, because `azure/facts.py` re-read its
    own clock at fold time; a test that pins only `fact_clock` therefore could not tell a
    receipt instant from a fold instant, and the defect that put them a second apart was
    invisible to it. Pinning both is what lets a test drive them **apart** on purpose.
    """
    loaded = catalog if catalog is not None else load_catalog()
    # One writer for the whole run, shared by the inventory pages and the metric
    # responses. See `AzureProvider.discover` on why it cannot be two.
    archive_writer = ArchiveWriter(store=object_store)
    return AzureProvider(
        catalog=loaded,
        inventory=InventoryCollector(
            inventory_port,
            sleep=sleep,
            **({} if inventory_clock is None else {"now": inventory_clock}),
        ),
        skus=SkuCatalog(sku_port),
        definitions=DefinitionProbe(definitions_port, loaded),
        metrics=MetricsCollector(
            region_resolver=RegionResolver(port=metrics_port),
            archive_writer=archive_writer,
            sleep=sleep,
        ),
        facts=facts_port,
        fact_clock=fact_clock,
        logs=metrics_port,
        actor_id=actor_id,
        run_id=run_id,
        fidelity_tier=fidelity_tier,
        on_close=on_close,
    )


def build_provider(
    context: Mapping[str, PlainData],
    *,
    object_store: ObjectStore | None = None,
    catalog: LoadedCatalog | None = None,
) -> Provider:
    """Build the Azure provider for one invocation's `context` (Req 18.4, 19.1).

    The factory `providers/registry.py` resolves for the `"azure"` id. Registration is
    lazy by import target, so this module — and therefore the Azure SDK — is imported
    the first time an invocation actually builds a provider, and never for one that
    does not.

    **Exactly one `ClientSecretCredential`**, built here from the context's
    `tenant_id`, `client_id` and `client_secret` and from nothing else, and reused by
    every client every port adapter holds (Req 19.1, 19.2, 19.7). The credential and
    the SDK-backed adapters are imported **inside** this function, matching
    `main.handle_preflight`'s own reason for a local import: an invocation that never
    reaches Azure pays for neither.

    `object_store` is the raw archive's sink (Req 26.3) and `catalog` the loaded
    Metric_Catalog (Req 32.8). Both are passed explicitly by `collect/pipeline.py`, which
    already holds the run's store and the process's catalog; the fallbacks exist so a
    provider built straight from a context still writes its archive to the right bucket
    and collects against the shipped catalog.

    Raises `ValueError` naming the missing field — never its value — for an absent
    `subscription_id`, `actor_id` or `run_id`: the first has no scope to collect, and
    the other two are the artifact key's own prefix (Req 26.8, 35.6), so there is no
    safe default for any of them. A credential field that is missing raises
    `AuthFailedError` from `azure/credential.py`, which is the code that says "the
    credentials are wrong" rather than "the runtime is broken".
    """
    from reporting_agent.azure.clients import build_azure_ports  # local: SDK import
    from reporting_agent.azure.credential import InvocationCredential

    subscription_id = _required_text(context, "subscription_id")
    actor_id = _required_text(context, "actor_id")
    run_id = _required_text(context, "run_id")
    fidelity_tier = _resolve_fidelity_tier(context.get("fidelity_tier"))

    credential = InvocationCredential(
        tenant_id=context.get("tenant_id"),  # type: ignore[arg-type]
        client_id=context.get("client_id"),  # type: ignore[arg-type]
        client_secret=context.get("client_secret"),  # type: ignore[arg-type]
    )
    ports = build_azure_ports(credential=credential, subscription_id=subscription_id)

    store = object_store if object_store is not None else _default_object_store()

    def release() -> None:
        """Close every transport this build opened, then the credential itself.

        Ports first: a client closed after its credential is a client whose auth policy
        can no longer refresh, which would turn a teardown into a failed request if one
        were still in flight.
        """
        ports.close()
        credential.close()

    return provider_over_ports(
        inventory_port=ports.inventory,
        sku_port=ports.skus,
        definitions_port=ports.definitions,
        metrics_port=ports.metrics,
        facts_port=ports.facts,
        object_store=store,
        actor_id=actor_id,
        run_id=run_id,
        fidelity_tier=fidelity_tier,
        catalog=catalog,
        on_close=release,
    )


def _default_object_store() -> ObjectStore:
    """An `S3ObjectStore` over the configured artifact bucket.

    Reads the configuration here rather than importing `main.CONFIG`, which would pull
    the whole entrypoint — `BedrockAgentCoreApp` included — into a provider build. A
    caller that already holds the process's store passes it instead, which is the path
    `collect/pipeline.py` takes.
    """
    from reporting_agent.config import Config
    from reporting_agent.storage.s3 import S3ObjectStore

    config = Config.from_env()
    return S3ObjectStore(config.artifact_bucket, region=config.aws_region)


def _required_text(context: Mapping[str, PlainData], field_name: str) -> str:
    value = context.get(field_name)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(
            f"the invocation context carries no usable {field_name}; the offending "
            f"value is excluded from this message"
        )
    return value


def _resolve_fidelity_tier(value: object) -> str:
    """The context's `fidelity_tier`, or `baseline`.

    An unrecognised value resolves to `baseline` rather than raising: the tier is a
    ceiling on what this run may claim (Req 31.1), and the safe reading of a tier
    nobody recognises is the lower one. Logged, because a context sending something
    else is a bug in the caller worth seeing.
    """
    if isinstance(value, str) and value in FIDELITY_TIERS:
        return value
    if value is not None:
        logger.warning(
            "the invocation context carries fidelity_tier=%r, which is not one of %r; "
            "collecting at %s.",
            value,
            FIDELITY_TIERS,
            FIDELITY_BASELINE,
        )
    return FIDELITY_BASELINE


# Contradictions worth catching at import rather than at the first collection.
assert set(_SLOT_SECONDS) == set(SUPPORTED_GRAINS), _SLOT_SECONDS
assert FIDELITY_BASELINE != FIDELITY_ENHANCED
assert len({name for name, _ in _SKU_CAPABILITY_READERS}) == len(_SKU_CAPABILITY_READERS)
