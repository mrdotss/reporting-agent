"""The Scope_Resolver: a snapshot view and a scope specification in, resources out.

    resolve(scope: ScopeRules, view: SnapshotView) -> tuple[ResourceView, ...]

**The signature is the requirement.** No client, no network, no clock, no catalog — a
scope resolves against the snapshot **only** (Req 3.3). That is what keeps replay clean:
`verify/replay.py` re-runs `compile/` over the same stored snapshot and must produce a
bit-identical ledger, which is impossible if resolution can ask Azure anything. It is also
why the collector fetches the **union** of every block's scope exactly once
(:func:`union_scope`) and the compiler narrows from there rather than each block fetching
its own.

## Matching (Req 3.4, 3.5)

Three dimensions — resource types, tag filters, resource groups — and three rules:

* **Every *populated* dimension must be satisfied.** Dimensions are ANDed.
* **Multiple entries *within* a dimension are any-of.** Two resource types match either;
  two tag filters match either. This is uniform across all three dimensions, which is what
  makes :func:`union_scope` a plain widening rather than a special case per dimension.
* **An empty dimension is unconstrained**, and therefore *wider* than any populated one.

## Case sensitivity is not uniform, and the asymmetry is the point (Req 3.5)

**Resource types, resource groups and tag *keys* fold case. Tag *values* do not.**

Resource types and resource group names are Azure identifiers, and Azure treats them
case-insensitively: Resource Graph lowercases `type` in its response body, so an inventory
row arrives as `microsoft.compute/virtualmachines` while every document in this product
writes `Microsoft.Compute/virtualMachines`. An exact comparison would match nothing, and
the failure would present as a scope that mysteriously resolves to zero rather than as a
spelling mismatch. Azure also forbids two resource groups in one subscription differing
only by case, so folding cannot merge two distinct groups. Tag keys are likewise
case-insensitive in Azure.

A tag **value** is arbitrary user data. Folding it would silently merge `env=Prod` with
`env=prod` — two values a customer may well use to mean two different things — and a
report that quietly widened its own scope is exactly the confidently-wrong artifact this
product exists to prevent.

## Top-N is four explicit steps, and the third is the one that matters (Req 3.6)

1. **Partition** the matched resources into those the snapshot holds a value for at the
   named `(metric, statistic)` and those it does not.
2. **Sort the first** by that value in the scope's direction, defaulting to `descending`,
   breaking ties by resource id ascending in **Unicode code-point order**.
3. **Append the second, ordered by resource id, *after every ranked resource*.**
4. **Take the first N**, retaining everything when the matched count is below N.

Step 3 is the one a plausible implementation gets wrong. Treating a missing metric value
as zero sorts those resources *into* the ranking — at the bottom under `descending`, at the
top under `ascending` — and under `ascending` that silently changes which ten appear in a
"Top 10 by CPU" table. A resource with no value is not a resource measured at zero; it is
a resource with a recorded gap, and it must never be able to displace a measured one.

## Zero matches is not a failure (Req 3.7)

An empty tuple, and nothing raised. The explicit "No resources matched this scope" row is
the block compiler's job, and the `EMPTY_SCOPE` gate is the pipeline's — and that gate is
about the **run's union**, not one block's scope. A report can legitimately ask for
"Storage Accounts tagged `env=prod`" in a subscription that has none; raising here would
turn an ordinary empty block into a failed run.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Final

from reporting_agent.compile.snapshot_view import ResourceView, SnapshotView
from reporting_agent.errors import CompileFailedError

__all__ = [
    "DEFAULT_SORT",
    "SORT_ASCENDING",
    "SORT_DESCENDING",
    "SORT_DIRECTIONS",
    "RequestedCollection",
    "ScopeRules",
    "TagFilter",
    "TopNRule",
    "matches",
    "resolve",
    "scope_rules_from_plain",
    "union_scope",
]

SORT_DESCENDING: Final[str] = "descending"
SORT_ASCENDING: Final[str] = "ascending"
SORT_DIRECTIONS: Final[tuple[str, ...]] = (SORT_DESCENDING, SORT_ASCENDING)
DEFAULT_SORT: Final[str] = SORT_DESCENDING
"""Req 3.6 — the direction a top-N takes when the scope declares none.

`descending` because "top N by CPU" means the busiest, which is what every block type that
carries a top-N is for. Declared as a constant rather than inlined so the default and the
document that explains it cannot drift."""


@dataclass(frozen=True, slots=True)
class TagFilter:
    """One tag filter. `key` folds case; `value` does not — see the module docstring."""

    key: str
    value: str

    @property
    def folded_key(self) -> str:
        return self.key.casefold()


@dataclass(frozen=True, slots=True)
class TopNRule:
    """A ranking: how many, by which metric, at which statistic (Req 3.1, 3.10).

    All three together, always. A count with no metric is an unanswerable request rather
    than a narrower scope, which is why the definition schema rejects one on both sides of
    the mirror and why this shape has no optional field.
    """

    count: int
    metric: str
    statistic: str

    def __post_init__(self) -> None:
        if isinstance(self.count, bool) or not isinstance(self.count, int) or self.count < 1:
            raise CompileFailedError(
                f"a top-N count must be a positive integer, got {self.count!r}"
            )
        if not self.metric or not self.statistic:
            raise CompileFailedError(
                "a top-N names both a metric and a statistic; a count with neither is "
                "an unanswerable request rather than a narrower scope"
            )


@dataclass(frozen=True, slots=True)
class ScopeRules:
    """A scope: the template default, or one block's override (Req 3.1, 3.2).

    Every dimension defaults to empty, which means **unconstrained** rather than "matches
    nothing". That is the only sensible reading — a template that names no resource type
    wants every resource type — and it is what makes :func:`union_scope`'s widening rule
    uniform.
    """

    resource_types: tuple[str, ...] = ()
    tag_filters: tuple[TagFilter, ...] = ()
    resource_groups: tuple[str, ...] = ()
    top_n: TopNRule | None = None
    sort: str | None = None

    def __post_init__(self) -> None:
        if self.sort is not None and self.sort not in SORT_DIRECTIONS:
            raise CompileFailedError(
                f"a scope's sort must be one of {list(SORT_DIRECTIONS)} or absent, got "
                f"{self.sort!r}"
            )

    @property
    def direction(self) -> str:
        """The declared direction, or :data:`DEFAULT_SORT`."""
        return self.sort or DEFAULT_SORT

    @property
    def is_unconstrained(self) -> bool:
        """Whether this scope narrows nothing — every dimension empty and no top-N."""
        return not (
            self.resource_types or self.tag_filters or self.resource_groups or self.top_n
        )


def scope_rules_from_plain(raw: object, *, at: str = "scope") -> ScopeRules:
    """Build a :class:`ScopeRules` from a validated definition's scope object.

    Reads the shape `compile/definition.py` already accepted, so this function validates
    types rather than policy — the bounds (0-20 resource types, 0-10 tag filters, and the
    rest) were checked at the boundary, on both sides of the mirror, before a version was
    ever written.

    A missing dimension reads as empty, which is unconstrained. That is deliberate rather
    than lenient: the definition schema requires every dimension to be *present*, so a
    caller reaching here with one absent is a compare command or a preflight probe
    assembling a scope by hand, and "unconstrained" is the right reading of "not
    mentioned".
    """
    if raw is None:
        return ScopeRules()
    if not isinstance(raw, Mapping):
        raise CompileFailedError(f"{at} must be an object, got {type(raw).__name__}")

    top_n_raw = raw.get("top_n")
    top_n: TopNRule | None = None
    if top_n_raw is not None:
        if not isinstance(top_n_raw, Mapping):
            raise CompileFailedError(f"{at}.top_n must be an object or null")
        top_n = TopNRule(
            count=_require_int(top_n_raw.get("count"), f"{at}.top_n.count"),
            metric=_require_str(top_n_raw.get("metric"), f"{at}.top_n.metric"),
            statistic=_require_str(top_n_raw.get("statistic"), f"{at}.top_n.statistic"),
        )

    sort = raw.get("sort")
    if sort is not None and not isinstance(sort, str):
        raise CompileFailedError(f"{at}.sort must be a string or null")

    return ScopeRules(
        resource_types=_string_tuple(raw.get("resource_types"), f"{at}.resource_types"),
        tag_filters=_tag_filters(raw.get("tag_filters"), f"{at}.tag_filters"),
        resource_groups=_string_tuple(raw.get("resource_groups"), f"{at}.resource_groups"),
        top_n=top_n,
        sort=sort,
    )


def _require_str(value: object, at: str) -> str:
    if not isinstance(value, str) or not value:
        raise CompileFailedError(f"{at} must be a non-empty string, got {value!r}")
    return value


def _require_int(value: object, at: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise CompileFailedError(f"{at} must be an integer, got {value!r}")
    return value


def _string_tuple(raw: object, at: str) -> tuple[str, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        raise CompileFailedError(f"{at} must be an array of strings")
    return tuple(_require_str(entry, f"{at}[{index}]") for index, entry in enumerate(raw))


def _tag_filters(raw: object, at: str) -> tuple[TagFilter, ...]:
    if raw is None:
        return ()
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        raise CompileFailedError(f"{at} must be an array of objects")
    filters: list[TagFilter] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, Mapping):
            raise CompileFailedError(f"{at}[{index}] must be an object")
        key = _require_str(entry.get("key"), f"{at}[{index}].key")
        value = entry.get("value")
        if not isinstance(value, str):
            raise CompileFailedError(f"{at}[{index}].value must be a string")
        filters.append(TagFilter(key=key, value=value))
    return tuple(filters)


# --- matching -----------------------------------------------------------------------


def _matches_any_type(scope: ScopeRules, resource: ResourceView) -> bool:
    if not scope.resource_types:
        return True
    folded = resource.resource_type.casefold()
    return any(declared.casefold() == folded for declared in scope.resource_types)


def _matches_any_group(scope: ScopeRules, resource: ResourceView) -> bool:
    if not scope.resource_groups:
        return True
    folded = resource.resource_group.casefold()
    return any(declared.casefold() == folded for declared in scope.resource_groups)


def _matches_any_tag(scope: ScopeRules, resource: ResourceView) -> bool:
    """Any-of across the tag-filter dimension, with a folded key and an exact value.

    The value comparison is exact on purpose: folding it would merge `env=Prod` with
    `env=prod`, two values a customer may use to mean two different things, and silently
    widen the report's own scope.
    """
    if not scope.tag_filters:
        return True

    folded_tags = {key.casefold(): value for key, value in resource.tags.items()}
    return any(
        folded_tags.get(declared.folded_key) == declared.value
        for declared in scope.tag_filters
    )


def matches(scope: ScopeRules, resource: ResourceView) -> bool:
    """Whether `resource` satisfies every populated dimension of `scope` (Req 3.4).

    Exposed for the property test and for a caller that wants the predicate without the
    ordering — the top-N steps in :func:`resolve` are a separate concern from membership,
    and keeping them separable is what lets each be tested for the specific way it goes
    wrong.
    """
    return (
        _matches_any_type(scope, resource)
        and _matches_any_group(scope, resource)
        and _matches_any_tag(scope, resource)
    )


# --- resolution ---------------------------------------------------------------------


def _ranking_value(
    view: SnapshotView, resource: ResourceView, top_n: TopNRule
) -> Decimal | None:
    """The value a resource is ranked by, or `None` when the snapshot holds none.

    `None` is **not** zero. See step 3 in the module docstring: a resource with no value
    has a recorded gap, and letting it into the ranking changes which resources appear in
    a "Top 10" table.
    """
    found = view.stat(resource.resource_id, top_n.metric, top_n.statistic)
    return None if found is None else found.value


def resolve(scope: ScopeRules, view: SnapshotView) -> tuple[ResourceView, ...]:
    """The resources `scope` selects from `view`, in the order the block renders them.

    Pure and total: a snapshot view and a scope specification in, an ordered tuple out. No
    client, no network, no clock (Req 3.3). Zero matches returns `()` and raises nothing
    (Req 3.7).

    Deterministic for one `(scope, view)` pair, and **invariant under the order the
    snapshot's resource array happens to be in**: matching preserves the view's order,
    which the Snapshot_Builder itself produced by sorting on resource id, and every
    tie-break here is on resource id rather than on position.
    """
    matched = tuple(resource for resource in view.resources if matches(scope, resource))

    if scope.top_n is None:
        return matched
    if len(matched) <= scope.top_n.count:
        # Step 4's "retaining everything when the matched count is below N" — but the
        # ORDER still comes from the ranking, because a top-N block shows its rows ranked
        # whether or not the cap bit.
        return _ranked(matched, view, scope)

    return _ranked(matched, view, scope)[: scope.top_n.count]


def _ranked(
    matched: tuple[ResourceView, ...], view: SnapshotView, scope: ScopeRules
) -> tuple[ResourceView, ...]:
    """Steps 1 to 3: partition, sort the ranked, append the unranked behind them."""
    top_n = scope.top_n
    assert top_n is not None  # narrowed by the caller

    ranked: list[tuple[Decimal, str, ResourceView]] = []
    unranked: list[tuple[str, ResourceView]] = []

    for resource in matched:
        value = _ranking_value(view, resource, top_n)
        if value is None:
            unranked.append((resource.resource_id, resource))
        else:
            ranked.append((value, resource.resource_id, resource))

    descending = scope.direction == SORT_DESCENDING

    # Ties break on resource id ASCENDING in both directions. Reversing the whole key
    # would reverse the tie-break too, which would make the order depend on the sort
    # direction in a way nothing asked for — so the value is negated instead and the id
    # is left ascending.
    if descending:
        ranked.sort(key=lambda entry: (-entry[0], entry[1]))
    else:
        ranked.sort(key=lambda entry: (entry[0], entry[1]))

    unranked.sort(key=lambda entry: entry[0])

    return (*(entry[2] for entry in ranked), *(entry[1] for entry in unranked))


# --- the requested collection: the union of every block scope ------------------------


@dataclass(frozen=True, slots=True)
class RequestedCollection:
    """What the collector is asked to fetch, **once**, for a whole run (Req 3.8, 3.12).

    The union of the template default and every block override. Wider than any single
    block's scope by construction, which is what makes the snapshot scope-agnostic — it
    holds the union and knows nothing about blocks, so `compile/scope.py` can narrow from
    it deterministically and replay stays clean.

    `tag_filters` is a mapping rather than a list because that is the shape
    `providers.base.ScopeSpec` carries. See :func:`union_scope` for what happens to a key
    two scopes disagree about.
    """

    resource_types: tuple[str, ...] = ()
    resource_groups: tuple[str, ...] = ()
    tag_filters: Mapping[str, str] = field(default_factory=dict)
    metrics_by_resource_type: Mapping[str, tuple[str, ...]] = field(default_factory=dict)


def _widened(dimensions: Sequence[tuple[str, ...]]) -> tuple[str, ...]:
    """The widest of a set of any-of dimensions.

    An **empty** dimension is unconstrained and therefore widest, so if any scope leaves
    the dimension empty the union is empty. Otherwise it is the set union, sorted for
    determinism.

    This is the rule that keeps the collected set a superset of every block's matched set.
    Intersecting instead — or taking only the template default — would leave a block's
    override resources absent from the snapshot, and the coverage gate would then fail a
    run that was entirely correct.
    """
    if any(not dimension for dimension in dimensions):
        return ()
    return tuple(sorted({entry for dimension in dimensions for entry in dimension}))


def _widened_tag_filters(scopes: Sequence[ScopeRules]) -> dict[str, str]:
    """The tag filter the collector may safely push down, or `{}` for none.

    This one is not the same shape as the other two dimensions, and the difference is worth
    spelling out because getting it wrong **under-collects** — which surfaces as a coverage
    failure on a run that was entirely correct.

    A scope's `tag_filters` are **any-of**: a resource matches if *any* filter matches. But
    `providers.base.ScopeSpec.tag_filters` is a `dict[str, str]`, which the collector
    applies as **all-of**. So the requested dict has to be a filter that accepts every
    resource any scope accepts, and an all-of dict can only do that when there is exactly
    one pair to require and every scope requires precisely it.

    Two ways that fails, both of which produce `{}`:

    * **Different keys.** Scope A wants `env=prod`, scope B wants `tier=web`. The dict
      `{env: prod, tier: web}` demands *both*, so it would miss a resource carrying only
      `env=prod` — which scope A matches.
    * **Different values, or more than one filter.** `env=prod` and `env=staging` cannot be
      expressed as one required value, and folding the key does not help: the pair
      `{env: Prod}` and `{ENV: prod}` looks like two keys and is one, demanding a tag equal
      to two different strings at once.

    Keys are compared **case-folded** for exactly that last reason, and the surviving pair
    is emitted with the first spelling in sorted order — arbitrary but deterministic, and
    harmless because keys fold anyway.
    """
    if any(not scope.tag_filters for scope in scopes):
        return {}

    required: set[frozenset[tuple[str, str]]] = set()
    spellings: dict[str, set[str]] = {}
    for scope in scopes:
        required.add(
            frozenset((declared.folded_key, declared.value) for declared in scope.tag_filters)
        )
        for declared in scope.tag_filters:
            spellings.setdefault(declared.folded_key, set()).add(declared.key)

    if len(required) != 1:
        return {}
    only = next(iter(required))
    if len(only) != 1:
        return {}

    folded_key, value = next(iter(only))
    return {min(spellings[folded_key]): value}


def union_scope(
    scopes: Iterable[ScopeRules],
    *,
    metrics_by_resource_type: Mapping[str, Iterable[str]] | None = None,
) -> RequestedCollection:
    """The union of `scopes` — the template default plus every block override.

    Widening, dimension by dimension. For resource types and resource groups the rule is
    one line: an empty dimension wins, because empty means unconstrained. Tag filters need
    a stricter rule for a structural reason — see :func:`_widened_tag_filters`.

    The direction of every decision here is the same: **over-collecting costs time,
    under-collecting produces a coverage failure on a correct run.** So where the requested
    shape cannot express the union exactly, this widens rather than guesses.

    `metrics_by_resource_type` is the definition's own metric selection. Every top-N
    metric in every scope is folded in as well, because a ranking cannot be resolved
    against a snapshot that does not carry the metric it ranks by — and the resource types
    it is folded into are the ones the union actually requests.
    """
    collected = list(scopes)
    if not collected:
        collected = [ScopeRules()]

    resource_types = _widened([scope.resource_types for scope in collected])
    resource_groups = _widened([scope.resource_groups for scope in collected])

    tag_filters = _widened_tag_filters(collected)

    metrics: dict[str, set[str]] = {}
    for resource_type, names in (metrics_by_resource_type or {}).items():
        metrics.setdefault(resource_type, set()).update(names)

    ranking_metrics = {scope.top_n.metric for scope in collected if scope.top_n is not None}
    if ranking_metrics:
        targets = resource_types or tuple(sorted(metrics))
        for resource_type in targets:
            metrics.setdefault(resource_type, set()).update(ranking_metrics)

    return RequestedCollection(
        resource_types=resource_types,
        resource_groups=resource_groups,
        tag_filters=tag_filters,
        metrics_by_resource_type={
            resource_type: tuple(sorted(names))
            for resource_type, names in sorted(metrics.items())
        },
    )
