"""The provider protocol: `discover`, `collect`, `capabilities` (Req 18.1, 18.2, 18.6).

Every structure in this module is built **only** from `str`, `bool`, `int`, `Decimal`,
`None`, `list` and `dict` (Req 18.3). No value in any signature has a type defined by a
cloud provider SDK, which is what makes everything downstream of `discover`/`collect` —
`collect/`, and later `compile/`, `render/` and `verify/` — unit-testable without a
subscription. `azure/provider.py` implements this protocol and lives inside `azure/`, so
the SDK-import guard (Req 18.5, 18.7) has nothing to except.

The runtime reaches a provider only through this protocol (Req 18.4), so adding AWS or
VMware later changes no caller.

`assert_plain_data` makes Req 18.3 checkable rather than merely stated: a provider that
lets an SDK model, a `datetime`, a `float` or a `set` leak into a result fails at the
boundary instead of at the JCS canonicalizer, several phases later, with no clue which
provider produced it.
"""

from __future__ import annotations

import itertools
from collections.abc import Iterable
from decimal import Decimal
from typing import Final, Protocol, TypedDict, runtime_checkable

__all__ = [
    "GUEST_COUNTER_STATUSES",
    "GUEST_STATUS_EMPTY",
    "GUEST_STATUS_FAILED",
    "GUEST_STATUS_OK",
    "PLAIN_SCALARS",
    "Capabilities",
    "CollectRequest",
    "CollectResult",
    "DiscoverResult",
    "GapRecord",
    "GuestCounterOutcome",
    "GuestCounterProvider",
    "GuestCounterRequest",
    "GuestCounterResult",
    "GuestCounterRow",
    "GuestCounterSpec",
    "LocationRouting",
    "PlainData",
    "Provider",
    "RawArchiveState",
    "ResourceRecord",
    "ScopeSpec",
    "SkuCapacityRecord",
    "StatValue",
    "Window",
    "assert_inventory_sorted",
    "assert_plain_data",
    "find_non_plain",
    "is_plain_data",
    "is_sorted_by_resource_id",
    "sort_inventory",
]


# --- The plain-data universe (Req 18.3) --------------------------------------------

type PlainData = (
    str | bool | int | Decimal | list["PlainData"] | dict[str, "PlainData"] | None
)
"""The only value types this protocol admits.

`Decimal` and not `float`: every metric value travels as an exact decimal so one
snapshot hashes identically in two processes. A `float` on this path is a determinism
bug, so it is not in the union and `assert_plain_data` rejects it.
"""

PLAIN_SCALARS: tuple[type, ...] = (str, bool, int, Decimal)
"""The scalar leaves of `PlainData`. `bool` precedes `int` for readability only —
`isinstance(True, int)` is already true, and both are admitted."""


def find_non_plain(value: object, path: str = "$") -> str | None:
    """Return the path of the first value that is not plain data, or `None`.

    Traversal is deterministic: dictionary keys are visited in sorted order, so the
    path reported for a structure carrying two offending values does not depend on
    insertion order. A non-`str` dictionary key is itself a violation — JSON object
    keys are strings, and an `int` key would serialize differently across runs.
    """
    stack: list[tuple[str, object]] = [(path, value)]
    while stack:
        current_path, current = stack.pop()
        if current is None or isinstance(current, PLAIN_SCALARS):
            continue
        if isinstance(current, dict):
            for key in sorted(current, key=_key_sort_key, reverse=True):
                if not isinstance(key, str):
                    return f"{current_path}.<{type(key).__name__} key>"
                stack.append((f"{current_path}.{key}", current[key]))
            continue
        if isinstance(current, list):
            for index in range(len(current) - 1, -1, -1):
                stack.append((f"{current_path}[{index}]", current[index]))
            continue
        return current_path
    return None


def _key_sort_key(key: object) -> tuple[int, str]:
    """Order `str` keys among themselves and keep non-`str` keys comparable, so a
    dictionary carrying a mixture of key types still sorts without raising."""
    return (1, key) if isinstance(key, str) else (0, "")


def is_plain_data(value: object) -> bool:
    """Whether `value` is built only from `str`, `bool`, `int`, `Decimal`, `None`,
    `list` and `dict` (Req 18.3)."""
    return find_non_plain(value) is None


def assert_plain_data(value: object, *, path: str = "$") -> None:
    """Raise `TypeError` naming the offending path and type if `value` is not plain data.

    Used at the provider boundary. The message carries the path rather than the value,
    because an Azure error object can quote a request that contains a credential.
    """
    offender = find_non_plain(value, path)
    if offender is None:
        return
    raise TypeError(
        f"{offender} is not plain data: a provider result may contain only "
        f"str, bool, int, Decimal, None, list and dict (Req 18.3)"
    )


# --- The records that cross the boundary -------------------------------------------


class ResourceRecord(TypedDict):
    """One resource in an inventory.

    A resource carrying a `deallocated`, `power_state_unknown` or `permission_denied`
    gap stays in the inventory with all of these fields populated (Req 20.10): a
    stopped resource is present and labelled, never absent.
    """

    resource_id: str
    name: str
    resource_type: str
    location: str
    resource_group: str
    tags: dict[str, str]
    sku_name: str
    power_state_raw: str
    power_state: str  # normalized, includes "unknown"
    fidelity_tier: str


class GapRecord(TypedDict):
    """One typed `collection_log` entry.

    A gap is recorded, never zero-filled: a swallowed 403 averages into the report as
    measured idleness. `metric` is `None` for a resource-level gap. `interval_start` is
    `None` for a gap that is not about one interval — a permission denial, an unknown
    SKU or a whole-catalog failure did not happen at a point in time, and `None` is the
    honest answer rather than a timestamp borrowed from the run.

    `interval_start` is the interval's own `timeStamp` as the response carried it,
    passed through as a string and never reparsed or reformatted here: a gap is a record
    of what arrived, and normalising the instant would make the record disagree with the
    document it was read from. It is what makes a **contiguous stretch** of gaps
    observable at all — the 64-hour run of timestamp-only intervals across all eight of
    one VM's metrics that `.kiro/steering/azure-integration.md` records is a statement
    about interval starts, and without them the same 512 entries are indistinguishable
    from 512 unrelated ones.
    """

    gap_type: str
    resource_id: str
    metric: str | None
    message: str
    interval_start: str | None


type StatValue = dict[str, PlainData]
"""One statistic and its provenance — statistic name, decimal-string value, unit,
estimator, fidelity tier, sample count, and the derivation fields a derived value
carries. Left as plain data here rather than pinned to a `TypedDict`, because the
statistic vocabulary belongs to `collect/accumulate.py` and the catalog; what this
protocol fixes is that every leaf is plain data (Req 18.3)."""


class Window(TypedDict):
    """The collection window. Half-open `[start_utc, end_utc)` (Req 25.7); `start` and
    `end` are the requested **local** dates in the run's timezone."""

    start: str
    end: str
    start_utc: str
    end_utc: str


class ScopeSpec(TypedDict):
    """The run's requested scope — the union of every block scope, resolved once."""

    subscription_id: str
    resource_types: list[str]
    resource_groups: list[str]
    tag_filters: dict[str, str]


class CollectRequest(TypedDict):
    """What `collect` needs: the scope, the inventory `discover` returned, the metric
    names per resource type, the grain, the half-open window and the run's timezone."""

    scope: ScopeSpec
    resources: list[ResourceRecord]
    metrics_by_resource_type: dict[str, list[str]]
    grain: str
    window: Window
    timezone: str
    utc_offset: str


class DiscoverResult(TypedDict):
    """A resource inventory and a collection_log (Req 18.2).

    `resources` is ordered by `resource_id` ascending in Unicode code-point order
    (Req 18.9) — see `sort_inventory`.
    """

    resources: list[ResourceRecord]
    gaps: list[GapRecord]


class _SkuCapacityCapabilities(TypedDict, total=False):
    """The two capabilities that may be absent from a resolved capacity.

    A separate `total=False` base rather than `NotRequired[...]` on the fields, and that is
    not a style choice: this module carries `from __future__ import annotations`, so every
    annotation is a string at runtime and `TypedDict` cannot see a `NotRequired` wrapper
    inside one — `__required_keys__` would report every field as required. Class-level
    totality is a flag rather than an annotation, so it survives the stringification.
    """

    vcpus_available: str
    memory_bytes: str


class SkuCapacityRecord(_SkuCapacityCapabilities):
    """The SKU capacity a provider resolved for one resource, as plain data.

    Exactly the shape `collect/snapshot.py`'s `SkuCapacity.to_plain_data()` emits: the
    SKU name, and each capacity as a **decimal string** rather than a JSON number
    (Req 21.12, 34.2). A capability the provider could not resolve is **omitted**, not
    emitted as zero — `sku_unknown` / `sku_capability_missing` is already in `gaps`, and
    a zero here would read as a measured capacity of nothing (Req 21.8, 21.9).
    """

    name: str


class RawArchiveState(TypedDict):
    """Whether this run's raw archive can be replayed in full (Req 26.12).

    `complete` is `False` once any archive write failed; `object_count` is how many
    objects actually landed. The Snapshot_Builder records both, so a run whose
    aggregation can be replayed from the archive is distinguishable from one whose
    archive has a hole in it.
    """

    complete: bool
    object_count: int


class LocationRouting(TypedDict):
    """Which locations received a metric request, and which answered through neither
    the batch endpoint nor the per-resource fallback (Req 24.3, 24.4).

    Carried as plain data because Req 24.5's escalation — terminal only when **every**
    requested location resolved unreachable — is the pipeline's decision, and the
    pipeline may not import `azure/` to ask the region resolver directly.
    """

    requested: list[str]
    unreachable: list[str]


class _CollectResultExtras(TypedDict, total=False):
    """The three optional facts a provider may report alongside its statistics.

    A `total=False` base for the same reason `_SkuCapacityCapabilities` is one: under
    `from __future__ import annotations` a `NotRequired[...]` wrapper is invisible to
    `TypedDict` at runtime, and `CollectResult.__required_keys__` is a contract the
    protocol's own tests assert on.
    """

    sku_capacities: dict[str, SkuCapacityRecord]
    raw_archive: RawArchiveState
    locations: LocationRouting
    day_statistics: dict[str, dict[str, list[StatValue]]]


class CollectResult(_CollectResultExtras):
    """Accumulated per-resource statistics and a collection_log (Req 18.2).

    `statistics` is keyed resource id -> metric name -> statistic name.

    The three inherited keys are **optional**: they carry facts a provider **may** know
    that the pipeline needs and cannot otherwise reach, and a provider that has no such
    fact simply omits the key rather than inventing a value for it. `statistics` and
    `gaps` stay the only required keys, so every provider written against the original
    two-key result still satisfies this type.

    * `sku_capacities` — the capacity actually used per resource (Req 35.3). Not
      derivable from `statistics`: a derived value's `derived_from` names the capacity
      it consumed, but a resource with no derived value still has a SKU the snapshot
      must record.
    * `raw_archive` — Req 26.12's completeness marker, known only to whatever wrote the
      archive during the fold pass.
    * `locations` — Req 24.3/24.5's routing facts, known only to whatever resolved the
      regional endpoints.
    * `day_statistics` — resource id -> local day -> that day's statistics, for a provider
      that folds a day dimension alongside the window one. `timeseries_chart` plots one
      figure per local day and addresses each by `snapshot_path`, so the address has to
      resolve to something the snapshot carries. Optional because a provider without a
      per-day fold should report no day values rather than an array of zeros, and because
      the day *geometry* comes from the run's window either way — a provider that omits
      this leaves every bucket present with an empty `statistics` array.

    All three stay plain data (Req 18.3), so nothing about them widens what crosses this
    boundary; `assert_plain_data` covers them with no change.
    """

    statistics: dict[str, dict[str, dict[str, StatValue]]]
    gaps: list[GapRecord]


class Capabilities(TypedDict):
    """What a provider can collect (Req 18.6): the resource types it collects, the
    metric names available per resource type, the grains it supports, and the fidelity
    tiers it can report."""

    resource_types: list[str]
    metrics: dict[str, list[str]]
    grains: list[str]
    fidelity_tiers: list[str]


# --- the enhanced tier's guest-observed counters (Req 31.4, 31.6, 31.7) -------------
#
# Deliberately **not** part of `Provider`. Req 18.1 fixes that protocol at `discover`,
# `collect` and `capabilities`, and a fourth required method would make every existing
# implementation — including the plain-data one in `tests/test_providers_base.py` — stop
# satisfying it. A guest-observed counter also is not something every cloud has: it
# needs an in-guest agent, a collection rule and a log workspace. So it is a *separate,
# optional* protocol a provider may additionally satisfy, and the pipeline asks with
# `isinstance` before it queries anything.
#
# **The split of responsibility is the point.** A provider returns the **rows**; the
# pipeline decides what they mean. That is what keeps Req 31.6's `_Total` classification
# — the AMA regression that collapses every drive's `InstanceName` into one — inside
# `collect/`, where it is unit-testable over plain data, while the Log-Analytics response
# shape stays inside `azure/`.


GUEST_STATUS_OK: Final[str] = "ok"
"""The query answered and returned at least one row."""

GUEST_STATUS_EMPTY: Final[str] = "empty"
"""The query answered with zero rows inside the window — Req 31.7's downgrade to
`baseline` plus a `no_samples` gap. Distinct from `failed`, because "the agent is not
delivering this counter" and "the query did not run" are different facts."""

GUEST_STATUS_FAILED: Final[str] = "failed"
"""The query failed or was rejected — Req 31.7's downgrade plus a `metric_error` gap."""

GUEST_COUNTER_STATUSES: Final[tuple[str, str, str]] = (
    GUEST_STATUS_OK,
    GUEST_STATUS_EMPTY,
    GUEST_STATUS_FAILED,
)


class GuestCounterSpec(TypedDict):
    """One guest-observed counter to query, as the Metric_Catalog declares it.

    `per_instance` is what makes Req 31.6 applicable at all: a per-instance counter was
    asked for per volume, so a row that cannot name its volume has nothing it can
    honestly be attributed to.
    """

    statistic_id: str
    object: str
    counter: str
    per_instance: bool
    unit: str
    scale: int


class GuestCounterRow(TypedDict):
    """One returned counter sample.

    `instance_name` is the value **as returned**, including `"_Total"` and `""` — the two
    shapes of the AMA regression — and `None` when the column was absent altogether. It is
    never normalised or repaired here: the pipeline has to be able to tell those apart
    from a real drive letter, and a provider that tidied them would erase the evidence.

    `value` is a decimal string (Req 34.2). `timestamp` is the sample instant as returned.
    """

    instance_name: str | None
    value: str
    timestamp: str


class GuestCounterOutcome(TypedDict):
    """One `(resource, counter)` query's outcome.

    `workspace_id` travels on the outcome because Req 31.4 requires every resulting value
    to record the workspace it came from, and the value is built from this outcome.
    """

    resource_id: str
    statistic_id: str
    counter: str
    workspace_id: str
    status: str
    message: str | None
    rows: list[GuestCounterRow]


class GuestCounterRequest(TypedDict):
    """What to query: the enhanced-tier resources, the catalog's declared counters, the
    run's half-open window and the workspace to read from.

    `window` is the run's own collection window (Req 31.4's "bound that query to the run's
    collection window") — not a trailing period, which would silently read a different
    month than the report is about.
    """

    resources: list[ResourceRecord]
    counters: list[GuestCounterSpec]
    window: Window
    workspace_id: str


class GuestCounterResult(TypedDict):
    """Every outcome, one per `(resource, counter)` pair asked for.

    A failure is an **outcome**, not an exception: Req 31.7 requires the run to continue,
    and one resource's rejected query must not cost the outcomes of the resources after
    it in the loop.
    """

    outcomes: list[GuestCounterOutcome]


# --- Inventory ordering (Req 18.9) -------------------------------------------------


def _resource_id_of(resource: ResourceRecord) -> str:
    return resource["resource_id"]


def sort_inventory(resources: Iterable[ResourceRecord]) -> list[ResourceRecord]:
    """Order resources by `resource_id` ascending in Unicode code-point order (Req 18.9).

    Python's default `str` comparison **is** code-point order, so the key is the raw
    id. Deliberately absent from this function: `str.lower`, `str.casefold`,
    `locale.strxfrm` and `unicodedata.normalize`. Each of them would reorder ids that
    differ only in case or in normalization form, and two collections over identical
    input must present identical array order to the snapshot builder — the array order
    is part of what is hashed.

    Note this is a different ordering from the UTF-16 code-unit order RFC 8785 applies
    to object **keys**. They do not conflict: we order arrays, JCS orders keys.

    `sorted` is stable, so two records sharing a resource id keep their relative order.
    De-duplication is the inventory collector's job (`duplicate_inventory_row`).
    """
    return sorted(resources, key=_resource_id_of)


def is_sorted_by_resource_id(resources: Iterable[ResourceRecord]) -> bool:
    """Whether `resources` is already in the order `sort_inventory` produces."""
    ids = [resource["resource_id"] for resource in resources]
    return all(left <= right for left, right in itertools.pairwise(ids))


def assert_inventory_sorted(resources: Iterable[ResourceRecord]) -> None:
    """Raise `ValueError` naming the first out-of-order pair (Req 18.9)."""
    previous: str | None = None
    for index, resource in enumerate(resources):
        current = resource["resource_id"]
        if previous is not None and current < previous:
            raise ValueError(
                f"inventory is not ordered by resource id at index {index}: "
                f"{current!r} sorts before {previous!r} (Req 18.9)"
            )
        previous = current


# --- The protocol itself -----------------------------------------------------------


@runtime_checkable
class Provider(Protocol):
    """The only surface through which the runtime reaches a cloud (Req 18.4)."""

    async def discover(self, scope: ScopeSpec) -> DiscoverResult:
        """Enumerate the in-scope inventory, ordered by resource id (Req 18.9)."""
        ...

    async def collect(self, request: CollectRequest) -> CollectResult:
        """Fold metric responses into per-resource statistics, recording every gap."""
        ...

    def capabilities(self) -> Capabilities:
        """Resource types, metrics per type, grains and fidelity tiers (Req 18.6)."""
        ...


@runtime_checkable
class GuestCounterProvider(Protocol):
    """The optional second surface: guest-observed counters for the enhanced tier.

    Separate from :class:`Provider` on purpose — see the note above
    :class:`GuestCounterSpec`. A pipeline asks `isinstance(provider,
    GuestCounterProvider)` and, when the answer is no, every resource stays `baseline`
    with no query issued, which is exactly Req 31.3's requirement for a baseline resource
    anyway.
    """

    async def collect_guest_counters(
        self, request: GuestCounterRequest
    ) -> GuestCounterResult:
        """Query each counter for each resource. Returns one outcome per pair and does
        not raise for a failed query (Req 31.7)."""
        ...
