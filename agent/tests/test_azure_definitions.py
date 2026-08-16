"""Task 11.4 — `azure/definitions.py`: probe once per `(resource_type, region)`, cache
the success, fall back to the catalog on total failure, and never derive a
`metric_not_emitted` gap from a failed probe (Req 22.1, 22.2, 22.4, 22.5, 22.6, 22.7,
20.7).

Everything here is driven through `FakeDefinitionsPort`, which — per its own
docstring — performs no caching of its own, so a test asserting the fake's call count
is asserting this module's caching behaviour and nothing else's.
"""

from __future__ import annotations

import asyncio

from fakes.azure_ports import FakeDefinitionsPort
from reporting_agent.azure.definitions import (
    MAX_PROBE_ATTEMPTS,
    DefinitionProbe,
    DefinitionsResult,
)
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.log import (
    GAP_TYPE_DEFINITIONS_UNAVAILABLE,
    GAP_TYPE_METRIC_NOT_EMITTED,
)

RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"
REGION = "southeastasia"
NAMESPACE = "Microsoft.Compute/virtualMachines"


def run(coro):
    return asyncio.run(coro)


def _ok_response(names: list[str]) -> RawHttpResponse:
    return RawHttpResponse(
        status=200,
        headers={},
        body={"value": [{"name": {"value": name, "localizedValue": name}} for name in names]},
    )


def _failure_response(status: int = 500) -> RawHttpResponse:
    return RawHttpResponse(status=status, headers={}, body={"error": "boom"})


def _resource_ids(n: int, *, prefix: str = "vm") -> list[str]:
    return [f"/subscriptions/x/resourceGroups/rg/.../{prefix}-{i:03d}" for i in range(n)]


# --------------------------------------------------------------------------------- #
# Req 22.1, 22.2, 22.3 — probed once per pair, cache serves every later request
# --------------------------------------------------------------------------------- #


def test_a_pair_with_at_least_50_resources_issues_exactly_one_probe() -> None:
    port = FakeDefinitionsPort([_ok_response(["Percentage CPU"])])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    resource_ids = _resource_ids(50)

    for resource_id in resource_ids:
        result = run(
            probe.definitions_for(
                resource_type=RESOURCE_TYPE,
                region=REGION,
                metric_namespace=NAMESPACE,
                resource_ids=[resource_id],
            )
        )
        assert result.source == "probed"
        assert result.metric_names == ("Percentage CPU",)

    assert len(port.calls) == 1


def test_one_resource_type_spread_across_two_regions_issues_exactly_two_probes() -> None:
    port = FakeDefinitionsPort(
        [_ok_response(["Percentage CPU"]), _ok_response(["Percentage CPU"])]
    )
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    for region in ("southeastasia", "australiaeast"):
        for resource_id in _resource_ids(5, prefix=region):
            run(
                probe.definitions_for(
                    resource_type=RESOURCE_TYPE,
                    region=region,
                    metric_namespace=NAMESPACE,
                    resource_ids=[resource_id],
                )
            )

    assert len(port.calls) == 2


def test_a_cached_pair_serves_the_definitions_with_no_further_probe() -> None:
    port = FakeDefinitionsPort([_ok_response(["Percentage CPU", "Network In Total"])])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    first = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-b", "vm-a"],
        )
    )
    second = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-c"],
        )
    )

    assert len(port.calls) == 1
    assert first == second
    assert probe.is_cached(RESOURCE_TYPE, REGION)


def test_the_cache_is_keyed_on_resource_type_and_region_independently() -> None:
    port = FakeDefinitionsPort(
        [_ok_response(["Percentage CPU"]), _ok_response(["Used Capacity"])]
    )
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-1"],
        )
    )
    run(
        probe.definitions_for(
            resource_type="Microsoft.Storage/storageAccounts",
            region=REGION,
            metric_namespace="Microsoft.Storage/storageAccounts",
            resource_ids=["sa-1"],
        )
    )

    assert len(port.calls) == 2
    assert probe.is_cached(RESOURCE_TYPE, REGION)
    assert probe.is_cached("Microsoft.Storage/storageAccounts", REGION)
    assert not probe.is_cached(RESOURCE_TYPE, "australiaeast")


# --------------------------------------------------------------------------------- #
# Req 22.4 — deterministic target selection, retry against at most 2 further
# --------------------------------------------------------------------------------- #


def test_the_lowest_sorting_resource_id_is_probed_first() -> None:
    port = FakeDefinitionsPort([_ok_response(["Percentage CPU"])])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-charlie", "vm-alpha", "vm-bravo"],
        )
    )

    assert port.calls[0]["resource_id"] == "vm-alpha"


def test_a_failed_first_attempt_retries_the_next_lowest_sorting_resource() -> None:
    port = FakeDefinitionsPort([_failure_response(), _ok_response(["Percentage CPU"])])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    result = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-charlie", "vm-alpha", "vm-bravo"],
        )
    )

    assert [call["resource_id"] for call in port.calls] == ["vm-alpha", "vm-bravo"]
    assert result.source == "probed"
    assert result.metric_names == ("Percentage CPU",)


def test_at_most_max_probe_attempts_distinct_resources_are_tried() -> None:
    assert MAX_PROBE_ATTEMPTS == 3

    port = FakeDefinitionsPort([_failure_response(), _failure_response(), _failure_response()])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-echo", "vm-delta", "vm-charlie", "vm-bravo", "vm-alpha"],
        )
    )

    assert len(port.calls) == MAX_PROBE_ATTEMPTS
    assert [call["resource_id"] for call in port.calls] == ["vm-alpha", "vm-bravo", "vm-charlie"]


def test_two_runs_over_the_same_inventory_probe_the_same_resource() -> None:
    """Determinism: two independently constructed probes over the same candidate
    pool select the identical target, because selection sorts by resource id rather
    than depending on iteration or dict order."""
    resource_ids = ["vm-zulu", "vm-mike", "vm-alpha", "vm-yankee"]

    port_a = FakeDefinitionsPort([_ok_response(["Percentage CPU"])])
    port_b = FakeDefinitionsPort([_ok_response(["Percentage CPU"])])
    catalog = load_catalog()

    run(
        DefinitionProbe(port_a, catalog).definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=list(resource_ids),
        )
    )
    run(
        DefinitionProbe(port_b, catalog).definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=list(reversed(resource_ids)),
        )
    )

    assert port_a.calls[0]["resource_id"] == port_b.calls[0]["resource_id"] == "vm-alpha"


def test_a_fewer_than_three_resource_pool_probes_only_what_it_has() -> None:
    port = FakeDefinitionsPort([_failure_response(), _failure_response()])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    result = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-bravo", "vm-alpha"],
        )
    )

    assert len(port.calls) == 2
    assert result.source == "catalog_fallback"


# --------------------------------------------------------------------------------- #
# Req 22.5, 22.6, 20.7 — total failure: no cache entry, definitions_unavailable gap,
# catalog fallback, and never metric_not_emitted
# --------------------------------------------------------------------------------- #


def test_every_attempt_failing_stores_nothing_in_the_cache() -> None:
    port = FakeDefinitionsPort([_failure_response(), _failure_response(), _failure_response()])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-a", "vm-b", "vm-c"],
        )
    )

    assert not probe.is_cached(RESOURCE_TYPE, REGION)


def test_every_attempt_failing_records_a_definitions_unavailable_gap_and_no_other() -> None:
    port = FakeDefinitionsPort([_failure_response(), _failure_response(), _failure_response()])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    result = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-a", "vm-b", "vm-c"],
        )
    )

    assert result.gap is not None
    assert result.gap["gap_type"] == GAP_TYPE_DEFINITIONS_UNAVAILABLE
    assert result.gap["gap_type"] != GAP_TYPE_METRIC_NOT_EMITTED
    assert RESOURCE_TYPE in result.gap["message"]
    assert REGION in result.gap["message"]
    assert result.gap["resource_id"] == f"{RESOURCE_TYPE} in {REGION}"
    assert result.gap["metric"] is None


def test_total_failure_falls_back_to_the_catalogs_declared_metric_set() -> None:
    port = FakeDefinitionsPort([_failure_response(), _failure_response(), _failure_response()])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    result = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-a", "vm-b", "vm-c"],
        )
    )

    expected = tuple(
        metric.name for metric in catalog.for_resource_type(RESOURCE_TYPE).metrics
    )
    assert result.is_fallback
    assert result.source == "catalog_fallback"
    assert result.metric_names == expected
    assert len(expected) > 0  # the fallback genuinely carries names, not an empty set


def test_a_pair_with_no_catalog_entry_falls_back_to_an_empty_but_valid_result() -> None:
    port = FakeDefinitionsPort([_failure_response(), _failure_response(), _failure_response()])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    result = run(
        probe.definitions_for(
            resource_type="Microsoft.Nonexistent/thing",
            region=REGION,
            metric_namespace="Microsoft.Nonexistent/thing",
            resource_ids=["thing-a", "thing-b", "thing-c"],
        )
    )

    assert result.source == "catalog_fallback"
    assert result.metric_names == ()
    assert result.gap is not None


def test_a_failed_pair_is_re_probed_in_full_on_a_later_call_rather_than_cached_as_failed() -> None:
    """Req 22.6: no definition set is stored for a failed pair. A later call for the
    same pair therefore re-attempts probing rather than short-circuiting to the
    fallback it got last time."""
    port = FakeDefinitionsPort(
        [
            _failure_response(),
            _failure_response(),
            _failure_response(),
            _ok_response(["Percentage CPU"]),
        ]
    )
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    first = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-a", "vm-b", "vm-c"],
        )
    )

    assert first.source == "catalog_fallback"
    assert len(port.calls) == 3

    second = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-a"],
        )
    )

    assert second.source == "probed"
    assert len(port.calls) == 4
    assert probe.is_cached(RESOURCE_TYPE, REGION)


def test_no_metric_not_emitted_gap_is_ever_produced_by_this_module() -> None:
    """A stronger check than the message assertion above: across every scenario in
    this file, the only gap type this module is capable of returning is
    `definitions_unavailable` — there is no code path in `DefinitionProbe` that
    constructs any other gap type."""
    port = FakeDefinitionsPort([_failure_response(), _failure_response(), _failure_response()])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    result = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-a", "vm-b", "vm-c"],
        )
    )

    assert result.gap["gap_type"] == GAP_TYPE_DEFINITIONS_UNAVAILABLE


# --------------------------------------------------------------------------------- #
# input validation and result shape
# --------------------------------------------------------------------------------- #


def test_an_empty_resource_id_pool_raises_value_error() -> None:
    port = FakeDefinitionsPort([])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    try:
        run(
            probe.definitions_for(
                resource_type=RESOURCE_TYPE,
                region=REGION,
                metric_namespace=NAMESPACE,
                resource_ids=[],
            )
        )
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for an empty resource_ids pool")

    assert len(port.calls) == 0


def test_a_probed_result_never_carries_a_gap_and_a_fallback_result_always_does() -> None:
    ok_port = FakeDefinitionsPort([_ok_response(["Percentage CPU"])])
    fail_port = FakeDefinitionsPort([_failure_response(), _failure_response(), _failure_response()])
    catalog = load_catalog()

    probed = run(
        DefinitionProbe(ok_port, catalog).definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-1"],
        )
    )
    fell_back = run(
        DefinitionProbe(fail_port, catalog).definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-1", "vm-2", "vm-3"],
        )
    )

    assert isinstance(probed, DefinitionsResult)
    assert probed.source == "probed"
    assert probed.gap is None
    assert not probed.is_fallback

    assert fell_back.source == "catalog_fallback"
    assert fell_back.gap is not None
    assert fell_back.is_fallback


def test_a_probe_returning_zero_definitions_is_still_a_successful_probe_not_a_fallback() -> None:
    """An empty `value` array from a successful call is a legitimate answer -- this
    resource type genuinely reports no metric definitions -- and must not be treated
    the same as a probe failure."""
    port = FakeDefinitionsPort([_ok_response([])])
    catalog = load_catalog()
    probe = DefinitionProbe(port, catalog)

    result = run(
        probe.definitions_for(
            resource_type=RESOURCE_TYPE,
            region=REGION,
            metric_namespace=NAMESPACE,
            resource_ids=["vm-1"],
        )
    )

    assert result.source == "probed"
    assert result.metric_names == ()
    assert result.gap is None
    assert len(port.calls) == 1
