"""Unit tests for the provider protocol (Req 18.1, 18.2, 18.3, 18.6, 18.9).

The design classifies Requirement 18 as example and static assertions rather than a
numbered property: the statements are about *shape* and about one ordering rule, and 100
generated cases would find nothing an example does not.
"""

from __future__ import annotations

import asyncio
import datetime as dt
import inspect
from decimal import Decimal

import pytest

from reporting_agent.providers.base import (
    Capabilities,
    CollectRequest,
    CollectResult,
    DiscoverResult,
    GapRecord,
    Provider,
    ResourceRecord,
    ScopeSpec,
    Window,
    assert_inventory_sorted,
    assert_plain_data,
    find_non_plain,
    is_plain_data,
    is_sorted_by_resource_id,
    sort_inventory,
)

SUBSCRIPTION = "/subscriptions/3f2b0000-0000-0000-0000-000000000000"


def resource(resource_id: str, **overrides: object) -> ResourceRecord:
    record: ResourceRecord = {
        "resource_id": resource_id,
        "name": resource_id.rsplit("/", 1)[-1],
        "resource_type": "Microsoft.Compute/virtualMachines",
        "location": "southeastasia",
        "resource_group": "rg-prod",
        "tags": {"env": "prod"},
        "sku_name": "Standard_E32-8s_v5",
        "power_state_raw": "PowerState/running",
        "power_state": "running",
        "fidelity_tier": "baseline",
    }
    record.update(overrides)  # type: ignore[typeddict-item]
    return record


def vm(name: str) -> ResourceRecord:
    return resource(
        f"{SUBSCRIPTION}/resourceGroups/rg-prod"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


class PlainDataProvider:
    """A provider built entirely from plain data — no SDK type anywhere (Req 18.3)."""

    def __init__(self, resources: list[ResourceRecord]) -> None:
        self._resources = resources

    async def discover(self, scope: ScopeSpec) -> DiscoverResult:
        return {
            "resources": sort_inventory(
                r
                for r in self._resources
                if r["resource_type"] in scope["resource_types"]
            ),
            "gaps": [],
        }

    async def collect(self, request: CollectRequest) -> CollectResult:
        return {
            "statistics": {
                r["resource_id"]: {
                    "Percentage CPU": {
                        "avg": {
                            "statistic": "avg",
                            "value": "12.480000",
                            "unit": "percent",
                            "estimator": "exact_count_weighted",
                            "fidelity_tier": r["fidelity_tier"],
                            "sample_count": 744,
                        }
                    }
                }
                for r in request["resources"]
            },
            "gaps": [
                {
                    "gap_type": "deallocated",
                    "resource_id": self._resources[0]["resource_id"],
                    "metric": None,
                    "message": "PowerState/deallocated",
                }
            ],
        }

    def capabilities(self) -> Capabilities:
        return {
            "resource_types": ["Microsoft.Compute/virtualMachines"],
            "metrics": {
                "Microsoft.Compute/virtualMachines": ["Percentage CPU"],
            },
            "grains": ["PT1H", "PT15M"],
            "fidelity_tiers": ["baseline", "enhanced"],
        }


def scope_spec() -> ScopeSpec:
    return {
        "subscription_id": "3f2b0000-0000-0000-0000-000000000000",
        "resource_types": ["Microsoft.Compute/virtualMachines"],
        "resource_groups": [],
        "tag_filters": {},
    }


def window() -> Window:
    return {
        "start": "2026-07-01",
        "end": "2026-07-31",
        "start_utc": "2026-06-30T17:00:00Z",
        "end_utc": "2026-07-31T17:00:00Z",
    }


def collect_request(resources: list[ResourceRecord]) -> CollectRequest:
    return {
        "scope": scope_spec(),
        "resources": resources,
        "metrics_by_resource_type": {
            "Microsoft.Compute/virtualMachines": ["Percentage CPU"]
        },
        "grain": "PT1H",
        "window": window(),
        "timezone": "Asia/Jakarta",
        "utc_offset": "+07:00",
    }


# --- The protocol surface (Req 18.1, 18.6) -----------------------------------------


def test_protocol_declares_exactly_discover_collect_and_capabilities() -> None:
    declared = {
        name
        for name in Provider.__protocol_attrs__  # type: ignore[attr-defined]
        if not name.startswith("_")
    }
    assert declared == {"discover", "collect", "capabilities"}


def test_discover_and_collect_are_coroutines_and_capabilities_is_not() -> None:
    assert inspect.iscoroutinefunction(Provider.discover)
    assert inspect.iscoroutinefunction(Provider.collect)
    assert not inspect.iscoroutinefunction(Provider.capabilities)


def test_a_plain_data_implementation_satisfies_the_protocol() -> None:
    assert isinstance(PlainDataProvider([vm("prod-web-01")]), Provider)


def test_an_implementation_missing_capabilities_does_not_satisfy_the_protocol() -> None:
    class HalfProvider:
        async def discover(self, scope: ScopeSpec) -> DiscoverResult:
            return {"resources": [], "gaps": []}

        async def collect(self, request: CollectRequest) -> CollectResult:
            return {"statistics": {}, "gaps": []}

    assert not isinstance(HalfProvider(), Provider)


def test_capabilities_reports_types_metrics_grains_and_fidelity_tiers() -> None:
    capabilities = PlainDataProvider([vm("prod-web-01")]).capabilities()

    assert set(capabilities) == {
        "resource_types",
        "metrics",
        "grains",
        "fidelity_tiers",
    }
    assert set(Capabilities.__required_keys__) == set(capabilities)
    assert is_plain_data(capabilities)


def test_discover_returns_an_inventory_and_a_collection_log() -> None:
    result = asyncio.run(PlainDataProvider([vm("prod-web-01")]).discover(scope_spec()))

    assert set(result) == set(DiscoverResult.__required_keys__) == {"resources", "gaps"}
    assert is_plain_data(result)


def test_collect_returns_statistics_and_a_collection_log() -> None:
    resources = [vm("prod-web-01")]
    result = asyncio.run(
        PlainDataProvider(resources).collect(collect_request(resources))
    )

    assert set(result) == set(CollectResult.__required_keys__) == {"statistics", "gaps"}
    assert is_plain_data(result)
    assert result["gaps"][0]["metric"] is None


def test_record_shapes_match_the_design() -> None:
    assert set(ResourceRecord.__required_keys__) == {
        "resource_id",
        "name",
        "resource_type",
        "location",
        "resource_group",
        "tags",
        "sku_name",
        "power_state_raw",
        "power_state",
        "fidelity_tier",
    }
    assert set(GapRecord.__required_keys__) == {
        "gap_type",
        "resource_id",
        "metric",
        "message",
    }
    assert not ResourceRecord.__optional_keys__
    assert not GapRecord.__optional_keys__


# --- Plain data only (Req 18.3) ----------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        "a string",
        True,
        0,
        -12,
        Decimal("12.480000"),
        None,
        [],
        {},
        {"resources": [{"tags": {"env": "prod"}, "sample_count": 744}]},
        [[[[Decimal("0")]]]],
    ],
)
def test_plain_data_is_accepted(value: object) -> None:
    assert is_plain_data(value)
    assert find_non_plain(value) is None


@pytest.mark.parametrize(
    "value",
    [
        12.48,  # a float is a determinism bug, not a value
        0.0,
        {"value": 12.48},
        {"resources": [{"tags": {"env": {"nested": 1.0}}}]},
        (1, 2),  # a tuple serializes as a JSON array and compares unequal to one
        {"seen"},  # a set iterates in PYTHONHASHSEED order
        b"bytes",
        dt.datetime(2026, 7, 1, tzinfo=dt.UTC),
        object(),
    ],
)
def test_non_plain_data_is_rejected(value: object) -> None:
    assert not is_plain_data(value)


def test_find_non_plain_reports_the_path_of_the_offending_value() -> None:
    document = {"resources": [{"statistics": {"Percentage CPU": {"avg": 12.48}}}]}

    assert (
        find_non_plain(document)
        == "$.resources[0].statistics.Percentage CPU.avg"
    )


def test_a_non_string_dictionary_key_is_not_plain_data() -> None:
    assert find_non_plain({1: "one"}) == "$.<int key>"


def test_assert_plain_data_names_the_path_and_not_the_value() -> None:
    secret = "a-client-secret-value"
    offending = {"context": {"client_secret": secret, "handle": object()}}

    with pytest.raises(TypeError) as caught:
        assert_plain_data(offending)

    message = str(caught.value)
    assert "$.context.handle" in message
    # An Azure error object can quote a request carrying a credential, so the message
    # names the path and never the surrounding values.
    assert secret not in message


def test_assert_plain_data_accepts_a_full_provider_result() -> None:
    resources = [vm("prod-web-01"), vm("prod-sql-01")]
    provider = PlainDataProvider(resources)

    assert_plain_data(asyncio.run(provider.discover(scope_spec())))
    assert_plain_data(asyncio.run(provider.collect(collect_request(resources))))
    assert_plain_data(provider.capabilities())


# --- Inventory ordering (Req 18.9) -------------------------------------------------


def test_inventory_is_ordered_by_resource_id_in_code_point_order() -> None:
    unordered = [vm("prod-web-01"), vm("dev-web-01"), vm("prod-sql-01")]

    ordered = [r["resource_id"] for r in sort_inventory(unordered)]

    assert ordered == sorted(ordered)
    assert [r.rsplit("/", 1)[-1] for r in ordered] == [
        "dev-web-01",
        "prod-sql-01",
        "prod-web-01",
    ]


def test_uppercase_sorts_before_lowercase_because_the_order_is_by_code_point() -> None:
    # A case-insensitive or locale-aware sort puts "alpha" first. Code-point order does
    # not: "Z" is U+005A and "a" is U+0061.
    ordered = [r["resource_id"] for r in sort_inventory([resource("a"), resource("Z")])]

    assert ordered == ["Z", "a"]


def test_non_ascii_ids_sort_after_ascii_ones() -> None:
    # "\u00c4" (Ä) is U+00C4, above every ASCII letter. A locale collation would file it
    # next to "A", and two runs under different locales would then disagree on array
    # order — which changes the snapshot hash.
    unordered = [resource("\u00c4-vm"), resource("z-vm"), resource("A-vm")]

    ordered = [r["resource_id"] for r in sort_inventory(unordered)]

    assert ordered == ["A-vm", "z-vm", "\u00c4-vm"]


def test_sorting_is_idempotent_and_stable() -> None:
    once = sort_inventory([vm("b"), vm("a"), vm("c")])
    twice = sort_inventory(once)

    assert [r["resource_id"] for r in once] == [r["resource_id"] for r in twice]

    first = resource("same", name="first")
    second = resource("same", name="second")
    assert [r["name"] for r in sort_inventory([first, second])] == ["first", "second"]


def test_sort_inventory_accepts_any_iterable_and_returns_a_list() -> None:
    ordered = sort_inventory(iter([vm("b"), vm("a")]))

    assert isinstance(ordered, list)
    assert [r["resource_id"] for r in ordered] == sorted(
        r["resource_id"] for r in ordered
    )


def test_is_sorted_by_resource_id_agrees_with_sort_inventory() -> None:
    unordered = [vm("prod-web-01"), vm("dev-web-01")]

    assert not is_sorted_by_resource_id(unordered)
    assert is_sorted_by_resource_id(sort_inventory(unordered))
    assert is_sorted_by_resource_id([])
    assert is_sorted_by_resource_id([vm("only")])


def test_assert_inventory_sorted_names_the_first_out_of_order_pair() -> None:
    with pytest.raises(ValueError, match="index 2"):
        assert_inventory_sorted([resource("a"), resource("b"), resource("a")])

    assert_inventory_sorted(sort_inventory([resource("b"), resource("a")]))


def test_discover_returns_a_sorted_inventory() -> None:
    provider = PlainDataProvider(
        [vm("prod-web-01"), vm("dev-web-01"), vm("prod-sql-01")]
    )

    result = asyncio.run(provider.discover(scope_spec()))

    assert_inventory_sorted(result["resources"])
