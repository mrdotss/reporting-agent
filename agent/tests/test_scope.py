"""`compile/scope.py` — the plain-data builder, and the edges a generator reaches rarely.

Property 7 (`tests/property/test_scope_property.py`) owns determinism, the case rules, the
four top-N steps and the union's width. This module pins the boundary between a validated
definition object and a `ScopeRules`, plus the handful of shapes worth naming explicitly.
"""

from __future__ import annotations

import pytest

import snapshot_factory as sf
from reporting_agent.compile.scope import (
    DEFAULT_SORT,
    SORT_ASCENDING,
    SORT_DESCENDING,
    ScopeRules,
    TagFilter,
    TopNRule,
    matches,
    resolve,
    scope_rules_from_plain,
    union_scope,
)
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.errors import CompileFailedError

VM = sf.VM_TYPE


@pytest.fixture(scope="module")
def view():
    return build_snapshot_view(sf.two_vm_snapshot())


# --------------------------------------------------------------------------- #
# The plain-data builder
# --------------------------------------------------------------------------- #


def test_a_full_scope_object_round_trips() -> None:
    rules = scope_rules_from_plain(
        {
            "resource_types": [VM],
            "tag_filters": [{"key": "env", "value": "prod"}],
            "resource_groups": ["rg-prod"],
            "top_n": {"count": 10, "metric": sf.CPU, "statistic": "avg"},
            "sort": SORT_ASCENDING,
        }
    )
    assert rules.resource_types == (VM,)
    assert rules.tag_filters == (TagFilter(key="env", value="prod"),)
    assert rules.resource_groups == ("rg-prod",)
    assert rules.top_n == TopNRule(count=10, metric=sf.CPU, statistic="avg")
    assert rules.direction == SORT_ASCENDING


def test_an_absent_dimension_reads_as_unconstrained() -> None:
    """The definition schema requires every dimension to be present, so a caller reaching
    here with one absent is a compare command or a preflight probe assembling a scope by
    hand — and "unconstrained" is the right reading of "not mentioned"."""
    assert scope_rules_from_plain({}).is_unconstrained
    assert scope_rules_from_plain(None).is_unconstrained
    assert ScopeRules().is_unconstrained


def test_a_scope_with_a_top_n_is_not_unconstrained() -> None:
    """A ranking narrows the result even with every dimension empty, so it counts."""
    rules = ScopeRules(top_n=TopNRule(count=1, metric=sf.CPU, statistic="avg"))
    assert not rules.is_unconstrained


def test_the_direction_defaults_to_descending() -> None:
    """"Top N by CPU" means the busiest, which is what every block type carrying a top-N is
    for."""
    assert ScopeRules().direction == DEFAULT_SORT == SORT_DESCENDING
    assert ScopeRules(sort=SORT_ASCENDING).direction == SORT_ASCENDING


@pytest.mark.parametrize(
    "raw",
    [
        [],
        "scope",
        42,
        {"resource_types": "not-an-array"},
        {"resource_types": [""]},
        {"resource_types": [None]},
        {"tag_filters": "no"},
        {"tag_filters": [{"key": "env"}]},
        {"tag_filters": [{"value": "prod"}]},
        {"tag_filters": [{"key": "env", "value": 1}]},
        {"tag_filters": ["env=prod"]},
        {"resource_groups": {"rg": True}},
        {"top_n": "10"},
        {"top_n": {"count": 10}},
        {"top_n": {"count": "10", "metric": "m", "statistic": "avg"}},
        {"top_n": {"count": True, "metric": "m", "statistic": "avg"}},
        {"sort": 1},
    ],
)
def test_an_unusable_scope_object_is_refused(raw: object) -> None:
    with pytest.raises(CompileFailedError):
        scope_rules_from_plain(raw)


@pytest.mark.parametrize("sort", ["asc", "DESCENDING", "", "random"])
def test_an_undeclared_sort_direction_is_refused(sort: str) -> None:
    with pytest.raises(CompileFailedError, match="sort"):
        ScopeRules(sort=sort)


@pytest.mark.parametrize("count", [0, -1, True, 1.5, "10"])
def test_a_top_n_count_that_is_not_a_positive_integer_is_refused(count: object) -> None:
    with pytest.raises(CompileFailedError, match="count"):
        TopNRule(count=count, metric=sf.CPU, statistic="avg")  # type: ignore[arg-type]


@pytest.mark.parametrize(("metric", "statistic"), [("", "avg"), (sf.CPU, ""), ("", "")])
def test_a_top_n_missing_its_metric_or_statistic_is_refused(
    metric: str, statistic: str
) -> None:
    """Req 3.10 — a count with no metric is an unanswerable request rather than a narrower
    scope."""
    with pytest.raises(CompileFailedError, match="metric and a statistic"):
        TopNRule(count=10, metric=metric, statistic=statistic)


# --------------------------------------------------------------------------- #
# Matching
# --------------------------------------------------------------------------- #


def test_dimensions_are_anded_and_entries_within_one_are_any_of(view) -> None:
    prod_sql, prod_web = view.resources  # sorted by resource id

    # Any-of within the resource-type dimension.
    both_types = ScopeRules(resource_types=(VM, "Microsoft.Storage/storageAccounts"))
    assert matches(both_types, prod_web)

    # ANDed across dimensions: the type matches, the group does not.
    assert not matches(
        ScopeRules(resource_types=(VM,), resource_groups=("rg-nowhere",)), prod_web
    )

    # Any-of within the tag dimension: prod-web-01 has env=prod, prod-sql-01 has env=Prod.
    either = ScopeRules(
        tag_filters=(TagFilter("env", "prod"), TagFilter("env", "Prod"))
    )
    assert matches(either, prod_web)
    assert matches(either, prod_sql)


def test_a_resource_missing_the_filtered_tag_entirely_does_not_match(view) -> None:
    resource = view.resources[0]
    assert "cost-centre" not in resource.tags
    assert not matches(ScopeRules(tag_filters=(TagFilter("cost-centre", "x"),)), resource)


def test_an_empty_tag_value_is_matched_exactly_not_treated_as_absent() -> None:
    """An empty tag value is a value. Treating it as "no filter" would widen the scope."""
    document = sf.build(
        resources=[
            sf.vm(resource_id="/vm/a", name="a", tags={"env": ""}),
            sf.vm(resource_id="/vm/b", name="b", tags={"env": "prod"}),
        ]
    )
    view = build_snapshot_view(document)
    resolved = resolve(ScopeRules(tag_filters=(TagFilter("env", ""),)), view)
    assert [resource.name for resource in resolved] == ["a"]


# --------------------------------------------------------------------------- #
# Resolution
# --------------------------------------------------------------------------- #


def test_resolution_without_a_top_n_preserves_the_snapshots_order(view) -> None:
    resolved = resolve(ScopeRules(), view)
    assert [resource.resource_id for resource in resolved] == [
        resource.resource_id for resource in view.resources
    ]


def test_a_top_n_orders_by_the_named_metric_even_when_the_cap_does_not_bite(view) -> None:
    """A top-N block shows its rows ranked whether or not the cap cut anything, so the
    order comes from the ranking rather than from the snapshot's array order."""
    resolved = resolve(
        ScopeRules(top_n=TopNRule(count=99, metric=sf.CPU, statistic="avg")), view
    )
    assert [resource.name for resource in resolved] == ["prod-sql-01", "prod-web-01"]
    assert len(resolved) == 2


def test_a_top_n_over_a_metric_no_resource_carries_falls_back_to_id_order(view) -> None:
    """Every resource is unranked, so all of them are ordered by resource id ascending —
    not dropped, and not ordered arbitrarily."""
    resolved = resolve(
        ScopeRules(top_n=TopNRule(count=99, metric="Network In Total", statistic="avg")),
        view,
    )
    assert [resource.resource_id for resource in resolved] == sorted(
        resource.resource_id for resource in view.resources
    )


def test_a_top_n_can_rank_by_a_sku_capacity(view) -> None:
    """SKU capacities are indexed as values with their own pointers, so a scope can rank by
    one exactly as it ranks by a metric."""
    resolved = resolve(
        ScopeRules(top_n=TopNRule(count=1, metric="sku.memory_bytes", statistic="capacity")),
        view,
    )
    assert len(resolved) == 1


def test_zero_matches_returns_an_empty_tuple_and_raises_nothing(view) -> None:
    """Req 3.7 — a report can legitimately ask for Storage Accounts in a subscription with
    none. Raising would turn an ordinary empty block into a failed run."""
    assert resolve(ScopeRules(resource_types=("Microsoft.Sql/servers",)), view) == ()
    assert resolve(ScopeRules(resource_groups=("rg-absent",)), view) == ()
    assert resolve(ScopeRules(tag_filters=(TagFilter("env", "nope"),)), view) == ()


# --------------------------------------------------------------------------- #
# The union
# --------------------------------------------------------------------------- #


def test_the_union_of_no_scopes_is_unconstrained() -> None:
    requested = union_scope([])
    assert requested.resource_types == ()
    assert requested.resource_groups == ()
    assert dict(requested.tag_filters) == {}


def test_an_unconstrained_scope_widens_the_whole_union() -> None:
    """Empty means unconstrained, so it wins. Intersecting instead would leave a block's
    override resources absent from the snapshot and fail the coverage gate on a correct
    run."""
    requested = union_scope(
        [ScopeRules(), ScopeRules(resource_types=(VM,), resource_groups=("rg-prod",))]
    )
    assert requested.resource_types == ()
    assert requested.resource_groups == ()


def test_populated_dimensions_union() -> None:
    requested = union_scope(
        [
            ScopeRules(resource_types=(VM,), resource_groups=("rg-a",)),
            ScopeRules(
                resource_types=("Microsoft.Storage/storageAccounts",),
                resource_groups=("rg-b",),
            ),
        ]
    )
    assert requested.resource_types == (
        "Microsoft.Compute/virtualMachines",
        "Microsoft.Storage/storageAccounts",
    )
    assert requested.resource_groups == ("rg-a", "rg-b")


def test_one_tag_filter_shared_by_every_scope_is_pushed_down() -> None:
    shared = (TagFilter("env", "prod"),)
    requested = union_scope([ScopeRules(tag_filters=shared), ScopeRules(tag_filters=shared)])
    assert dict(requested.tag_filters) == {"env": "prod"}


@pytest.mark.parametrize(
    "scopes",
    [
        # Different values for one key: an all-of dict cannot express "either".
        [
            ScopeRules(tag_filters=(TagFilter("env", "prod"),)),
            ScopeRules(tag_filters=(TagFilter("env", "staging"),)),
        ],
        # The same key spelled two ways, with two values — one key demanding two strings.
        [
            ScopeRules(tag_filters=(TagFilter("env", "Prod"),)),
            ScopeRules(tag_filters=(TagFilter("ENV", "prod"),)),
        ],
        # Different keys: the dict would demand both, missing a resource carrying only one.
        [
            ScopeRules(tag_filters=(TagFilter("env", "prod"),)),
            ScopeRules(tag_filters=(TagFilter("tier", "web"),)),
        ],
        # More than one filter in a scope: any-of, which an all-of dict cannot express.
        [ScopeRules(tag_filters=(TagFilter("env", "prod"), TagFilter("env", "staging")))],
        # One scope unconstrained.
        [ScopeRules(), ScopeRules(tag_filters=(TagFilter("env", "prod"),))],
    ],
)
def test_a_tag_filter_the_request_cannot_express_widens_to_nothing(
    scopes: list[ScopeRules],
) -> None:
    assert dict(union_scope(scopes).tag_filters) == {}


def test_every_ranking_metric_is_requested_for_every_requested_resource_type() -> None:
    """A ranking cannot be resolved against a snapshot that does not carry the metric it
    ranks by."""
    requested = union_scope(
        [
            ScopeRules(resource_types=(VM,)),
            ScopeRules(
                resource_types=("Microsoft.Storage/storageAccounts",),
                top_n=TopNRule(count=5, metric="UsedCapacity", statistic="avg"),
            ),
        ],
        metrics_by_resource_type={VM: [sf.CPU]},
    )
    for resource_type in requested.resource_types:
        assert "UsedCapacity" in requested.metrics_by_resource_type[resource_type]
    assert sf.CPU in requested.metrics_by_resource_type[VM]


def test_the_requested_metrics_are_sorted_and_deduplicated() -> None:
    requested = union_scope(
        [ScopeRules(resource_types=(VM,))],
        metrics_by_resource_type={VM: [sf.CPU, sf.AVAILABLE_MEMORY, sf.CPU]},
    )
    names = requested.metrics_by_resource_type[VM]
    assert list(names) == sorted(set(names))
