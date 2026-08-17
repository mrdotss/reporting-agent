"""Property 7: scope resolution is deterministic and snapshot-only.

**Validates: Req 3.3, 3.4, 3.5, 3.6, 3.11, 3.12, 5.4, 45.1**

What this property is built to kill, stated before the code so the assertions have a
target:

* **A resolver whose output depends on response arrival order.** Every case is resolved
  twice, once against a snapshot built from the resources in the drawn order and once from
  a permutation of it, and the two must be identical.
* **A resolver treating a missing metric value as zero.** That sorts unmeasured resources
  *into* the ranking — at the bottom under `descending`, at the **top** under `ascending` —
  and under `ascending` it silently changes which ten appear in a "Top 10 by CPU" table.
  Asserted directly: every ranked resource precedes every unranked one, in both
  directions.
* **A resolver folding tag-value case.** `env=Prod` and `env=prod` are two values a
  customer may use to mean two different things, and merging them widens the report's own
  scope in silence.
* **A resolver raising on an empty match.** That would turn an ordinary empty block — "Storage
  Accounts tagged `env=prod`" in a subscription with none — into a failed run.
* **A pipeline requesting only the template default.** Its override resources are then
  absent from the snapshot and fail the coverage gate on a run that was entirely correct.
  Asserted behaviourally: every block scope resolves identically against a snapshot
  collected from the union as against one collected from everything.
"""

from __future__ import annotations

import socket
from collections.abc import Iterator
from contextlib import contextmanager
from decimal import Decimal

from hypothesis import example, given
from hypothesis import strategies as st

import snapshot_factory as sf
from reporting_agent.collect.snapshot import ResourceSnapshot, SkuCapacity
from reporting_agent.compile.scope import (
    DEFAULT_SORT,
    SORT_ASCENDING,
    SORT_DESCENDING,
    RequestedCollection,
    ScopeRules,
    TagFilter,
    TopNRule,
    matches,
    resolve,
    union_scope,
)
from reporting_agent.compile.snapshot_view import ResourceView, build_snapshot_view

# One resource, as the generator describes it: `(suffix, resource_type, resource_group,
# tags, cpu_avg)`. `cpu_avg` of `None` means the snapshot holds **no** value for the
# ranking metric — a recorded gap, not a zero.
type ResourceSpec = tuple[str, str, str, dict[str, str], str | None]

VM = sf.VM_TYPE
STORAGE = "Microsoft.Storage/storageAccounts"
RESOURCE_TYPES = (VM, STORAGE, "Microsoft.Web/sites")
RESOURCE_GROUPS = ("rg-prod", "rg-staging", "RG-Prod", "rg-shared")

# Keys and values that differ only by case, which is where the asymmetry lives: keys fold,
# values do not.
TAG_KEYS = ("env", "ENV", "Env", "tier")
TAG_VALUES = ("prod", "Prod", "PROD", "web")


@contextmanager
def no_network() -> Iterator[None]:
    """A network double. Any attempt to open a socket inside this block fails the test.

    Req 3.3's "no client, no network, no clock" asserted rather than reviewed. It is what
    keeps replay clean: `verify/replay.py` re-runs `compile/` over a stored snapshot and
    must produce a bit-identical ledger, which is impossible if resolution can ask Azure
    anything.
    """
    original = socket.socket

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError(
            "scope resolution opened a socket; a scope resolves against the snapshot only"
        )

    socket.socket = refuse  # type: ignore[assignment, misc]
    try:
        yield
    finally:
        socket.socket = original  # type: ignore[misc]


MAX_RESOURCES = 500
"""Criterion 3.1's top-N ceiling, and the size the collector was measured at.

The flagship property draws up to this many. The narrower properties below draw up to
:data:`MAX_SMALL_RESOURCES`, because each of them builds **two** snapshots per example
through the real Snapshot_Builder — which canonicalizes and hashes — and none of them is
about scale. Where scale itself is the point, there is an explicit test at exactly this
size rather than a rare draw."""

MAX_SMALL_RESOURCES = 60


@st.composite
def resource_specs(
    draw: st.DrawFn, *, max_resources: int = MAX_RESOURCES
) -> list[ResourceSpec]:
    """0 to `max_resources` resources, with ids unique by construction."""
    count = draw(st.integers(min_value=0, max_value=max_resources))
    specs: list[ResourceSpec] = []
    for index in range(count):
        tag_count = draw(st.integers(min_value=0, max_value=2))
        tags = {
            draw(st.sampled_from(TAG_KEYS)): draw(st.sampled_from(TAG_VALUES))
            for _ in range(tag_count)
        }
        specs.append(
            (
                f"{index:04d}",
                draw(st.sampled_from(RESOURCE_TYPES)),
                draw(st.sampled_from(RESOURCE_GROUPS)),
                tags,
                draw(
                    st.one_of(
                        st.none(),
                        st.sampled_from(["0.00", "12.48", "50.00", "88.20", "99.90"]),
                    )
                ),
            )
        )
    return specs


@st.composite
def scope_rules(draw: st.DrawFn, *, allow_top_n: bool = True) -> ScopeRules:
    """A scope across every bound of criterion 3.1, with both sort directions."""
    top_n: TopNRule | None = None
    if allow_top_n and draw(st.booleans()):
        top_n = TopNRule(
            count=draw(st.integers(min_value=1, max_value=500)),
            metric=draw(st.sampled_from([sf.CPU, "Network In Total"])),
            statistic=draw(st.sampled_from(["avg", "max"])),
        )
    return ScopeRules(
        resource_types=tuple(
            draw(st.lists(st.sampled_from(RESOURCE_TYPES), max_size=3, unique=True))
        ),
        tag_filters=tuple(
            TagFilter(key=key, value=value)
            for key, value in draw(
                st.lists(
                    st.tuples(st.sampled_from(TAG_KEYS), st.sampled_from(TAG_VALUES)),
                    max_size=3,
                    unique=True,
                )
            )
        ),
        resource_groups=tuple(
            draw(st.lists(st.sampled_from(RESOURCE_GROUPS), max_size=3, unique=True))
        ),
        top_n=top_n,
        sort=draw(st.sampled_from([None, SORT_DESCENDING, SORT_ASCENDING])),
    )


@st.composite
def cases(
    draw: st.DrawFn, *, max_resources: int = MAX_RESOURCES
) -> tuple[list[ResourceSpec], list[ScopeRules]]:
    """A snapshot's resources plus a template default and 0-4 block overrides."""
    return (
        draw(resource_specs(max_resources=max_resources)),
        [draw(scope_rules()) for _ in range(draw(st.integers(min_value=1, max_value=5)))],
    )


def _snapshot(specs: list[ResourceSpec]) -> dict:
    """One real snapshot document over `specs`, through the real Snapshot_Builder."""
    resources = [
        ResourceSnapshot(
            record=sf.resource_record(
                resource_id=f"/vm/{suffix}",
                name=f"vm-{suffix}",
                resource_type=resource_type,
                resource_group=resource_group,
                tags=tags,
            ),
            sku=SkuCapacity(name="Standard_D2s_v5", vcpus_available=2),
            statistics=() if cpu_avg is None else (sf.exact(sf.CPU, "avg", cpu_avg),),
        )
        for suffix, resource_type, resource_group, tags, cpu_avg in specs
    ]
    return sf.build(resources=resources, resource_types=list(RESOURCE_TYPES))


def _ids(resources: tuple[ResourceView, ...]) -> list[str]:
    return [resource.resource_id for resource in resources]


# The three declared examples, spelled as concrete cases.
_HALF_MISSING: tuple[list[ResourceSpec], list[ScopeRules]] = (
    [
        ("0000", VM, "rg-prod", {}, "10.00"),
        ("0001", VM, "rg-prod", {}, None),
        ("0002", VM, "rg-prod", {}, "90.00"),
        ("0003", VM, "rg-prod", {}, None),
    ],
    [ScopeRules(top_n=TopNRule(count=3, metric=sf.CPU, statistic="avg"))],
)

_VALUE_CASE_DIFFERS: tuple[list[ResourceSpec], list[ScopeRules]] = (
    [("0000", VM, "rg-prod", {"env": "prod"}, "10.00")],
    [ScopeRules(tag_filters=(TagFilter(key="env", value="Prod"),))],
)

_KEY_CASE_DIFFERS: tuple[list[ResourceSpec], list[ScopeRules]] = (
    [("0000", VM, "rg-prod", {"env": "prod"}, "10.00")],
    [ScopeRules(tag_filters=(TagFilter(key="ENV", value="prod"),))],
)


@given(cases())
@example(_HALF_MISSING)
@example(_VALUE_CASE_DIFFERS)
@example(_KEY_CASE_DIFFERS)
def test_property_7_scope_resolution_is_deterministic_and_snapshot_only(
    case: tuple[list[ResourceSpec], list[ScopeRules]],
) -> None:
    specs, scopes = case
    view = build_snapshot_view(_snapshot(specs))

    # Req 3.3 — a scope resolves against the snapshot only. Asserted with a double, not
    # reviewed.
    with no_network():
        for scope in scopes:
            first = resolve(scope, view)
            second = resolve(scope, view)

            # Idempotent per (scope, view) pair.
            assert _ids(first) == _ids(second)

            # Zero matches is an empty tuple and nothing raised (Req 3.7).
            assert isinstance(first, tuple)

            # Membership is exactly the predicate, and every dimension is ANDed while
            # entries within one are any-of (Req 3.4).
            expected = {
                resource.resource_id
                for resource in view.resources
                if matches(scope, resource)
            }
            if scope.top_n is None:
                assert set(_ids(first)) == expected
                # Order preserved from the view, which the Snapshot_Builder sorted by id.
                assert _ids(first) == sorted(_ids(first))
            else:
                # At most N (Req 3.6, step 4).
                assert len(first) <= scope.top_n.count
                assert set(_ids(first)) <= expected
                if len(expected) <= scope.top_n.count:
                    assert set(_ids(first)) == expected
                _assert_ranking_order(first, view, scope)

            _assert_case_rules(scope, view)


@given(cases(max_resources=MAX_SMALL_RESOURCES))
@example(_HALF_MISSING)
def test_resolution_is_invariant_under_the_snapshots_array_order(
    case: tuple[list[ResourceSpec], list[ScopeRules]],
) -> None:
    """Req 3.11 — the resolver's output does not depend on the order responses arrived in.

    The Snapshot_Builder *produces* every array order rather than inheriting it, so the two
    documents are byte-identical — asserted here as well, because if they ever were not,
    this property would be checking something weaker than it claims.
    """
    specs, scopes = case
    view = build_snapshot_view(_snapshot(specs))
    reversed_view = build_snapshot_view(_snapshot(list(reversed(specs))))

    assert reversed_view.snapshot_id == view.snapshot_id
    with no_network():
        for scope in scopes:
            assert _ids(resolve(scope, reversed_view)) == _ids(resolve(scope, view))


@given(cases(max_resources=MAX_SMALL_RESOURCES))
def test_the_requested_collection_is_the_union_of_every_block_scope(
    case: tuple[list[ResourceSpec], list[ScopeRules]],
) -> None:
    specs, scopes = case
    _assert_union_is_wide_enough(specs, scopes)


def test_resolution_holds_at_the_declared_five_hundred_resource_ceiling() -> None:
    """Criterion 3.1's ceiling, as an explicit case rather than a rare draw.

    Both directions, a mixture of measured and unmeasured resources, and a cap below the
    matched count — the combination where the ranking and the cap interact.
    """
    specs: list[ResourceSpec] = [
        (
            f"{index:04d}",
            VM,
            "rg-prod",
            {"env": "prod"},
            None if index % 3 == 0 else f"{index % 100}.00",
        )
        for index in range(MAX_RESOURCES)
    ]
    view = build_snapshot_view(_snapshot(specs))
    assert len(view.resources) == MAX_RESOURCES

    for direction in (SORT_DESCENDING, SORT_ASCENDING):
        scope = ScopeRules(
            tag_filters=(TagFilter(key="ENV", value="prod"),),
            top_n=TopNRule(count=10, metric=sf.CPU, statistic="avg"),
            sort=direction,
        )
        resolved = resolve(scope, view)
        assert len(resolved) == 10
        # The cap cut into the ranked resources, so no unmeasured one can be present.
        for resource in resolved:
            assert view.stat(resource.resource_id, sf.CPU, "avg") is not None
        _assert_ranking_order(resolved, view, scope)


def _assert_ranking_order(
    resolved: tuple[ResourceView, ...], view, scope: ScopeRules
) -> None:
    """Req 3.6, steps 2 and 3.

    Every ranked resource precedes every unranked one — in **both** directions. That is
    the assertion a resolver treating a missing value as zero fails: under `ascending` it
    would put the unmeasured resources first.
    """
    top_n = scope.top_n
    assert top_n is not None

    values = [
        view.stat(resource.resource_id, top_n.metric, top_n.statistic)
        for resource in resolved
    ]
    ranked = [
        (found.value, resource.resource_id)
        for resource, found in zip(resolved, values, strict=True)
        if found is not None
    ]
    unranked_ids = [
        resource.resource_id
        for resource, found in zip(resolved, values, strict=True)
        if found is None
    ]

    # No unranked resource appears before a ranked one.
    seen_unranked = False
    for found in values:
        if found is None:
            seen_unranked = True
        else:
            assert not seen_unranked, (
                "a resource with no value for the ranking metric appeared before a "
                "measured one; a missing value is a recorded gap, not a zero"
            )

    # Unranked resources are ordered by resource id ascending.
    assert unranked_ids == sorted(unranked_ids)

    # Ranked resources are ordered by value in the declared direction, ties by id
    # ascending in BOTH directions.
    descending = scope.direction == SORT_DESCENDING
    expected_keys = (
        sorted(ranked, key=lambda entry: (-entry[0], entry[1]))
        if descending
        else sorted(ranked, key=lambda entry: (entry[0], entry[1]))
    )
    assert ranked == expected_keys


def _assert_case_rules(scope: ScopeRules, view) -> None:
    """Req 3.5 — resource types, resource groups and tag keys fold; tag values do not."""
    for resource in view.resources:
        if not scope.tag_filters:
            continue
        folded_tags = {key.casefold(): value for key, value in resource.tags.items()}
        expected = any(
            folded_tags.get(declared.key.casefold()) == declared.value
            for declared in scope.tag_filters
        )
        actual = (
            matches(
                ScopeRules(tag_filters=scope.tag_filters),
                resource,
            )
        )
        assert actual is expected


def _assert_union_is_wide_enough(
    specs: list[ResourceSpec], scopes: list[ScopeRules]
) -> None:
    """Req 3.8, 3.12 — the collection scope is the union of the default and every override.

    Asserted **behaviourally**, which is what has teeth: a snapshot collected from the
    union must resolve every block scope identically to a snapshot collected from
    everything. A pipeline requesting only the template default passes an equality check
    on lists and fails this one, because its override resources are simply absent.
    """
    requested = union_scope(scopes, metrics_by_resource_type={VM: [sf.CPU]})

    # The union is the widest of every dimension: an empty dimension is unconstrained and
    # therefore wins. Computed here independently of the module under test.
    if any(not scope.resource_types for scope in scopes):
        assert requested.resource_types == ()
    else:
        assert requested.resource_types == tuple(
            sorted({entry for scope in scopes for entry in scope.resource_types})
        )
    if any(not scope.resource_groups for scope in scopes):
        assert requested.resource_groups == ()
    else:
        assert requested.resource_groups == tuple(
            sorted({entry for scope in scopes for entry in scope.resource_groups})
        )

    # Requested metrics are the union per resource type, and every ranking metric is in
    # there — a ranking cannot resolve against a snapshot that lacks the metric it ranks by.
    ranking_metrics = {scope.top_n.metric for scope in scopes if scope.top_n is not None}
    if requested.resource_types:
        for resource_type in requested.resource_types:
            names = set(requested.metrics_by_resource_type.get(resource_type, ()))
            assert names >= ranking_metrics, (
                f"{resource_type} is requested but its metric set {sorted(names)} omits a "
                f"ranking metric; a top-N cannot resolve against a snapshot that lacks "
                f"the metric it ranks by"
            )
    elif ranking_metrics:
        # An unconstrained union requests every resource type, so the ranking metric is
        # folded into every type the selection already names.
        for names in requested.metrics_by_resource_type.values():
            assert set(names) >= ranking_metrics

    full_view = build_snapshot_view(_snapshot(specs))
    collected = [spec for spec in specs if _in_requested(spec, requested)]
    union_view = (
        full_view
        if len(collected) == len(specs)
        else build_snapshot_view(_snapshot(collected))
    )

    for scope in scopes:
        assert _ids(resolve(scope, union_view)) == _ids(resolve(scope, full_view)), (
            "a block scope resolves differently against the union-collected snapshot; the "
            "union is not wide enough, and the coverage gate would fail a correct run"
        )


def _in_requested(spec: ResourceSpec, requested: RequestedCollection) -> bool:
    """Whether the collector would have fetched `spec` under `requested`."""
    _, resource_type, resource_group, tags, _ = spec
    if requested.resource_types and resource_type.casefold() not in {
        entry.casefold() for entry in requested.resource_types
    }:
        return False
    if requested.resource_groups and resource_group.casefold() not in {
        entry.casefold() for entry in requested.resource_groups
    }:
        return False
    folded = {key.casefold(): value for key, value in tags.items()}
    return all(
        folded.get(key.casefold()) == value for key, value in requested.tag_filters.items()
    )


@given(
    specs=resource_specs(max_resources=MAX_SMALL_RESOURCES),
    count=st.integers(min_value=1, max_value=MAX_RESOURCES),
    direction=st.sampled_from([None, SORT_DESCENDING, SORT_ASCENDING]),
)
def test_a_missing_ranking_value_never_displaces_a_measured_one(
    specs: list[ResourceSpec], count: int, direction: str | None
) -> None:
    """The declared example, generalized: a top-N metric missing for some of the matched
    resources.

    Stated as its own property because it is the single behaviour a plausible
    implementation gets wrong, and it is worth a generator that always produces the
    mixture rather than one that stumbles onto it.
    """
    view = build_snapshot_view(_snapshot(specs))
    scope = ScopeRules(
        top_n=TopNRule(count=count, metric=sf.CPU, statistic="avg"), sort=direction
    )

    resolved = resolve(scope, view)
    measured = [
        resource
        for resource in view.resources
        if view.stat(resource.resource_id, sf.CPU, "avg") is not None
    ]

    # Every measured resource is taken before any unmeasured one, so the cap can only cut
    # into the unmeasured tail.
    taken_measured = [
        resource
        for resource in resolved
        if view.stat(resource.resource_id, sf.CPU, "avg") is not None
    ]
    assert len(taken_measured) == min(count, len(measured))
    assert scope.direction == (direction or DEFAULT_SORT)


def _expected_requested_tags(scopes: list[ScopeRules]) -> dict[str, str]:
    """What the collector may safely push down, recomputed independently.

    A scope's tag filters are **any-of** while `ScopeSpec.tag_filters` is applied as
    **all-of**, so a pushed-down dict is only safe when there is exactly one pair to require
    and every scope requires precisely it. Anything else — different keys, different values,
    more than one filter — has to widen to nothing.
    """
    if any(not scope.tag_filters for scope in scopes):
        return {}

    required = {
        frozenset((declared.key.casefold(), declared.value) for declared in scope.tag_filters)
        for scope in scopes
    }
    if len(required) != 1:
        return {}
    only = next(iter(required))
    if len(only) != 1:
        return {}

    folded_key, value = next(iter(only))
    spellings = {
        declared.key
        for scope in scopes
        for declared in scope.tag_filters
        if declared.key.casefold() == folded_key
    }
    return {min(spellings): value}


@given(scopes=st.lists(scope_rules(allow_top_n=False), min_size=1, max_size=4))
def test_a_pushed_down_tag_filter_is_only_kept_when_every_scope_requires_exactly_it(
    scopes: list[ScopeRules],
) -> None:
    """The failure this property found: `{env: Prod}` and `{ENV: prod}` look like two keys
    and are one, so keeping both would demand a tag equal to two different strings at once
    and the collector would fetch nothing.

    Widening to `{}` over-collects, which is the only safe direction — under-collecting
    surfaces as a coverage failure on a run that was entirely correct.
    """
    assert dict(union_scope(scopes).tag_filters) == _expected_requested_tags(scopes)


@given(specs=resource_specs(max_resources=MAX_SMALL_RESOURCES))
def test_an_unconstrained_scope_resolves_to_every_resource(
    specs: list[ResourceSpec],
) -> None:
    view = build_snapshot_view(_snapshot(specs))
    with no_network():
        assert _ids(resolve(ScopeRules(), view)) == _ids(view.resources)


@given(scope=scope_rules())
def test_a_scope_over_an_empty_snapshot_resolves_to_nothing_without_raising(
    scope: ScopeRules,
) -> None:
    """Req 3.7 — zero matches returns an empty tuple. Raising here would turn an ordinary
    empty block into a failed run."""
    view = build_snapshot_view(_snapshot([]))
    with no_network():
        assert resolve(scope, view) == ()


@given(
    value=st.sampled_from(["prod", "Prod", "PROD"]),
    filter_value=st.sampled_from(["prod", "Prod", "PROD"]),
    key=st.sampled_from(["env", "ENV", "Env"]),
    filter_key=st.sampled_from(["env", "ENV", "Env"]),
)
def test_tag_keys_fold_and_tag_values_do_not(
    value: str, filter_value: str, key: str, filter_key: str
) -> None:
    """The asymmetry, exhaustively over three spellings each way.

    A resolver folding the value would merge `env=Prod` with `env=prod` — two values a
    customer may use to mean two different things — and silently widen the report's scope.
    """
    view = build_snapshot_view(_snapshot([("0000", VM, "rg-prod", {key: value}, "1.00")]))
    scope = ScopeRules(tag_filters=(TagFilter(key=filter_key, value=filter_value),))

    resolved = resolve(scope, view)
    assert bool(resolved) is (value == filter_value)


@given(
    declared=st.sampled_from(
        [VM, VM.casefold(), VM.upper(), "microsoft.compute/virtualMachines"]
    ),
    group=st.sampled_from(["rg-prod", "RG-PROD", "Rg-Prod"]),
)
def test_resource_types_and_resource_groups_fold_case(declared: str, group: str) -> None:
    """Resource Graph lowercases `type` in its response body while every document in this
    product writes `Microsoft.Compute/virtualMachines`, so an exact comparison would match
    nothing and the failure would look like an empty scope rather than a spelling
    mismatch."""
    view = build_snapshot_view(
        _snapshot([("0000", VM, "rg-prod", {}, "1.00")])
    )
    assert resolve(ScopeRules(resource_types=(declared,)), view)
    assert resolve(ScopeRules(resource_groups=(group,)), view)


@given(count=st.integers(min_value=1, max_value=MAX_RESOURCES))
def test_the_cap_retains_everything_when_fewer_resources_match(count: int) -> None:
    specs: list[ResourceSpec] = [
        (f"{index:04d}", VM, "rg-prod", {}, f"{index}.00") for index in range(5)
    ]
    view = build_snapshot_view(_snapshot(specs))
    resolved = resolve(
        ScopeRules(top_n=TopNRule(count=count, metric=sf.CPU, statistic="avg")), view
    )
    assert len(resolved) == min(count, 5)


@given(
    values=st.lists(
        st.sampled_from(["10.00", "20.00", "30.00"]), min_size=2, max_size=8
    )
)
def test_ties_break_on_resource_id_ascending_in_both_directions(
    values: list[str],
) -> None:
    """Ties break ascending whichever way the values sort. Reversing the whole sort key
    would reverse the tie-break too, which nothing asked for and which would make two runs
    over one snapshot order equal values differently if the direction ever changed."""
    specs: list[ResourceSpec] = [
        (f"{index:04d}", VM, "rg-prod", {}, value) for index, value in enumerate(values)
    ]
    view = build_snapshot_view(_snapshot(specs))

    for direction in (SORT_DESCENDING, SORT_ASCENDING):
        resolved = resolve(
            ScopeRules(
                top_n=TopNRule(count=len(values), metric=sf.CPU, statistic="avg"),
                sort=direction,
            ),
            view,
        )
        grouped: dict[Decimal, list[str]] = {}
        for resource in resolved:
            found = view.stat(resource.resource_id, sf.CPU, "avg")
            assert found is not None
            grouped.setdefault(found.value, []).append(resource.resource_id)
        for ids in grouped.values():
            assert ids == sorted(ids), direction
