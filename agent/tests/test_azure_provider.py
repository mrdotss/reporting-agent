"""Task 11.8 — `azure/provider.py` and `azure/clients.py` (Req 18.1-18.6, 18.8, 18.9).

Two halves, and neither one touches Azure.

**The provider, over the fake ports.** `AzureProvider` is assembled by
`provider_over_ports` from `tests/fakes/azure_ports.py` and `InMemoryObjectStore`, so
`discover`, `collect` and `capabilities` run end to end with no SDK, no credential and
no subscription. What is asserted is the provider's own contribution — the ordering
guarantee, the plain-data boundary, the nested statistics shape, the exclusion of a
deallocated resource, and that every stage's gaps arrive in one list — rather than the
behaviours the five collector modules already own and already have suites for.

**The SDK-backed ports, over a recording sender.** Each adapter in `azure/clients.py`
takes a `RequestSender`, so the request it builds — method, URL, query parameters and
body — is assertable against a stub that returns a scripted response. That is the whole
of what those adapters do: build one request, send it through an SDK client's pipeline,
wrap the answer. The one thing they *decide* is Req 24.2's DNS classification, which
gets its own tests either side of the line.
"""

from __future__ import annotations

import asyncio
import json
from decimal import Decimal
from typing import Any

import pytest
from azure.core.exceptions import HttpResponseError, ServiceRequestError
from azure.core.rest import HttpRequest

from fakes.azure_ports import (
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
)
from fakes.object_store import InMemoryObjectStore
from reporting_agent.azure.clients import (
    ARM_ENDPOINT,
    ArmDefinitionsPort,
    ArmInventoryPort,
    ArmSkuPort,
    AzureMetricsPort,
    envelope_from_response,
    inventory_query,
    is_dns_resolution_failure,
    pipeline_sender,
)
from reporting_agent.azure.metrics import AGGREGATIONS
from reporting_agent.azure.ports import (
    DefinitionsPort,
    DnsResolutionError,
    InventoryPort,
    MetricsPort,
    RawHttpResponse,
    SkuPort,
)
from reporting_agent.azure.provider import (
    FIDELITY_BASELINE,
    FIDELITY_ENHANCED,
    FIDELITY_TIERS,
    SUPPORTED_GRAINS,
    AzureProvider,
    build_provider,
    interval_count_for,
    is_excluded_from_averages,
    provider_over_ports,
)
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_DEFINITIONS_UNAVAILABLE,
    GAP_TYPE_METRIC_NOT_EMITTED,
    GAP_TYPE_NO_SAMPLES,
    GAP_TYPE_PERMISSION_DENIED,
    GAP_TYPE_SKU_UNKNOWN,
)
from reporting_agent.providers import registry
from reporting_agent.providers.base import (
    CollectRequest,
    Provider,
    ScopeSpec,
    assert_inventory_sorted,
    assert_plain_data,
    find_non_plain,
)

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
LOCATION = "southeastasia"
OTHER_LOCATION = "australiaeast"
RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"
WIRE_TYPE = "microsoft.compute/virtualmachines"
NAMESPACE = RESOURCE_TYPE
ACTOR_ID = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID = "run_01HQZX8QW9K7YB4T2C3M5N6P7Q"
SKU_NAME = "Standard_D4s_v5"

CPU = "Percentage CPU"
MEMORY = "Available Memory Bytes"
DISK_READ = "Disk Read Bytes"

WINDOW = {
    "start": "2026-07-01",
    "end": "2026-07-01",
    "start_utc": "2026-07-01T00:00:00Z",
    "end_utc": "2026-07-01T02:00:00Z",
}

# 16 GiB, the capacity the recorded SKU listing below declares, in bytes.
SKU_MEMORY_BYTES = Decimal(16) * Decimal(1073741824)
# The average available memory the recorded batch response folds to: exactly half.
AVAILABLE_MEMORY_BYTES = SKU_MEMORY_BYTES / 2


def resource_id(name: str, *, group: str = "rg-prod-sea") -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{group}"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


WEB_01 = resource_id("prod-web-01")
WEB_02 = resource_id("prod-web-02")
DEV_01 = resource_id("dev-web-01", group="rg-dev-sea")


def run(coro: Any) -> Any:
    return asyncio.run(asyncio.wait_for(coro, timeout=10.0))


# --------------------------------------------------------------------------- #
# Recorded-shaped responses, built here rather than added to tests/fixtures/:
# these describe a whole collection rather than one requirement's edge case,
# which is what the files in tests/fixtures/azure/ are for.
# --------------------------------------------------------------------------- #


def raw(body: object, *, status: int = 200, headers: dict[str, str] | None = None) -> RawHttpResponse:
    return RawHttpResponse(status=status, headers=headers or {}, body=body)


def inventory_row(
    name: str,
    *,
    group: str = "rg-prod-sea",
    location: str = LOCATION,
    power_state: str = "PowerState/running",
    tags: dict[str, str] | None = None,
) -> dict[str, Any]:
    return {
        "id": resource_id(name, group=group),
        "name": name,
        "type": WIRE_TYPE,
        "location": location,
        "resourceGroup": group,
        "tags": tags if tags is not None else {"env": "prod"},
        "sku": SKU_NAME,
        "powerState": power_state,
    }


def resource_record(
    name: str,
    *,
    group: str = "rg-prod-sea",
    location: str = LOCATION,
    power_state: str = "PowerState/running",
    resource_type: str = RESOURCE_TYPE,
    sku_name: str = SKU_NAME,
    tags: dict[str, str] | None = None,
    fidelity_tier: str = FIDELITY_BASELINE,
) -> dict[str, Any]:
    """One `providers.base.ResourceRecord` — what `discover` returns and `collect` takes.

    Distinct from :func:`inventory_row`, which is the **wire** row a Resource Graph page
    carries: the port speaks Azure's field names (`id`, `powerState`) and the protocol
    speaks the record's (`resource_id`, `power_state_raw`). Conflating the two is
    exactly the kind of shape drift the plain-data boundary exists to make visible.
    """
    return {
        "resource_id": resource_id(name, group=group),
        "name": name,
        "resource_type": resource_type,
        "location": location,
        "resource_group": group,
        "tags": tags if tags is not None else {"env": "prod"},
        "sku_name": sku_name,
        "power_state_raw": power_state,
        "power_state": power_state.removeprefix("PowerState/").casefold() or "unknown",
        "fidelity_tier": fidelity_tier,
    }


def inventory_page(rows: list[dict[str, Any]], *, skip_token: str | None = None) -> RawHttpResponse:
    body: dict[str, Any] = {"totalRecords": len(rows), "count": len(rows), "data": rows}
    if skip_token is not None:
        body["skipToken"] = skip_token
    return raw(body, headers={"x-ms-user-quota-remaining": "9"})


def definitions_response(*names: str) -> RawHttpResponse:
    return raw({"value": [{"name": {"value": name}} for name in names]})


def sku_listing(*, memory_gb: str = "16", vcpus: str = "4") -> RawHttpResponse:
    return raw(
        {
            "value": [
                {
                    "resourceType": "virtualMachines",
                    "name": SKU_NAME,
                    "locations": [LOCATION],
                    "capabilities": [
                        {"name": "vCPUs", "value": "8"},
                        {"name": "vCPUsAvailable", "value": vcpus},
                        {"name": "MemoryGB", "value": memory_gb},
                    ],
                }
            ]
        }
    )


def metric_entry(
    name: str,
    intervals: list[dict[str, Any]],
    *,
    error_code: str = "Success",
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "name": {"value": name, "localizedValue": name},
        "errorCode": error_code,
    }
    if error_code == "Success":
        entry["timeseries"] = [{"metadatavalues": [], "data": intervals}]
    return entry


CPU_INTERVALS = [
    {"timeStamp": "2026-07-01T00:00:00Z", "total": 1200, "count": 60, "minimum": 10, "maximum": 30},
    {"timeStamp": "2026-07-01T01:00:00Z", "total": 600, "count": 60, "minimum": 5, "maximum": 15},
]
"""Folds to a count-weighted average of exactly 15% over 120 samples, a minimum of 5
and a maximum of 30. The two intervals carry equal counts here only because what this
suite asserts is the wiring; `test_azure_metrics.py` and the accumulator's own property
own count weighting itself."""

MEMORY_INTERVALS = [
    {
        "timeStamp": "2026-07-01T00:00:00Z",
        "total": int(AVAILABLE_MEMORY_BYTES),
        "count": 1,
        "minimum": int(AVAILABLE_MEMORY_BYTES),
        "maximum": int(AVAILABLE_MEMORY_BYTES),
    }
]
"""Exactly half the SKU's 16 GiB, so `memory_used_pct` derives to exactly 50.00 in
every direction and a wrong GiB-versus-bytes conversion would be off by 2**30 rather
than by a rounding step."""


def batch_response(
    resource_metrics: dict[str, list[dict[str, Any]]],
    *,
    status: int = 200,
    headers: dict[str, str] | None = None,
) -> RawHttpResponse:
    return raw(
        {
            "values": [
                {
                    "starttime": WINDOW["start_utc"],
                    "endtime": WINDOW["end_utc"],
                    "interval": "PT1H",
                    "namespace": WIRE_TYPE,
                    "resourceregion": LOCATION,
                    "resourceid": rid,
                    "value": entries,
                }
                for rid, entries in resource_metrics.items()
            ]
        },
        status=status,
        headers=headers,
    )


def both_metrics() -> list[dict[str, Any]]:
    return [
        metric_entry(CPU, CPU_INTERVALS),
        metric_entry(MEMORY, MEMORY_INTERVALS),
    ]


# --------------------------------------------------------------------------- #
# Assembly helper
# --------------------------------------------------------------------------- #


class Harness:
    """One provider over the four fakes, with the fakes kept reachable."""

    def __init__(
        self,
        *,
        inventory: list[RawHttpResponse] | None = None,
        skus: list[RawHttpResponse] | None = None,
        definitions: list[RawHttpResponse] | None = None,
        batches: list[Any] | None = None,
        fallbacks: list[RawHttpResponse] | None = None,
        fidelity_tier: str = FIDELITY_BASELINE,
    ) -> None:
        self.inventory_port = FakeInventoryPort(inventory or [])
        self.sku_port = FakeSkuPort(skus or [])
        self.definitions_port = FakeDefinitionsPort(definitions or [])
        self.metrics_port = FakeMetricsPort(
            batch_responses=batches or [], fallback_responses=fallbacks or []
        )
        self.store = InMemoryObjectStore()
        self.provider = provider_over_ports(
            inventory_port=self.inventory_port,
            sku_port=self.sku_port,
            definitions_port=self.definitions_port,
            metrics_port=self.metrics_port,
            object_store=self.store,
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            fidelity_tier=fidelity_tier,
            catalog=load_catalog(),
        )


def scope(
    *,
    resource_groups: list[str] | None = None,
    tag_filters: dict[str, str] | None = None,
) -> ScopeSpec:
    return ScopeSpec(
        subscription_id=SUBSCRIPTION,
        resource_types=[RESOURCE_TYPE],
        resource_groups=resource_groups or [],
        tag_filters=tag_filters or {},
    )


def collect_request(
    resources: list[dict[str, Any]],
    *,
    metric_names: list[str] | None = None,
    grain: str = "PT1H",
) -> CollectRequest:
    return CollectRequest(
        scope=scope(),
        resources=resources,  # type: ignore[typeddict-item]
        metrics_by_resource_type={RESOURCE_TYPE: metric_names or [CPU, MEMORY]},
        grain=grain,
        window=WINDOW,  # type: ignore[typeddict-item]
        timezone="Asia/Jakarta",
        utc_offset="+07:00",
    )


def gap_types(gaps: list[dict[str, Any]]) -> list[str]:
    return [gap["gap_type"] for gap in gaps]


# --------------------------------------------------------------------------- #
# The protocol itself (Req 18.1, 18.4)
# --------------------------------------------------------------------------- #


def test_the_azure_provider_satisfies_the_provider_protocol() -> None:
    """Req 18.1, 18.4 — the runtime reaches a provider only through this protocol, so
    conformance is what makes a second cloud a registration rather than a caller
    change."""
    harness = Harness()
    assert isinstance(harness.provider, AzureProvider)
    assert isinstance(harness.provider, Provider)


def test_the_registry_resolves_the_azure_id_to_build_provider() -> None:
    """Req 18.4 — `providers/registry.py` registers the lazy import target
    `reporting_agent.azure.provider:build_provider`; this is the test that the target
    actually resolves, without an Azure subscription anywhere near it.

    An `ImportError` behind that string would otherwise surface for the first time on a
    real run, as a `ProviderFactoryUnavailableError` several minutes into a report.
    """
    assert registry.get_factory(registry.AZURE_PROVIDER_ID) is build_provider
    assert registry.AZURE_PROVIDER_ID in registry.provider_ids()


def real_context(**overrides: Any) -> dict[str, Any]:
    context = {
        "actor_id": ACTOR_ID,
        "run_id": RUN_ID,
        "subscription_id": SUBSCRIPTION,
        "tenant_id": "11111111-1111-1111-1111-111111111111",
        "client_id": "22222222-2222-2222-2222-222222222222",
        "client_secret": "Zq7~client.secret[with]regex*chars",
        "fidelity_tier": FIDELITY_ENHANCED,
    }
    context.update(overrides)
    return context


def test_build_provider_assembles_the_real_sdk_clients_without_reaching_azure() -> None:
    """The factory the registry resolves, exercised for real: one
    `ClientSecretCredential` from the context, four SDK-backed ports over it, and the
    provider assembled on top.

    No network and no tenant are involved — constructing a credential resolves no
    token and constructing a client opens no connection — so this is the wiring test
    for the one path the fakes cannot cover. It is also where a mistake in a client's
    own constructor signature (`ComputeManagementClient` takes a subscription id;
    `ResourceGraphClient` does not) surfaces at test time rather than minutes into a
    run.
    """
    provider = build_provider(real_context(), object_store=InMemoryObjectStore())

    assert isinstance(provider, Provider)
    assert isinstance(provider, AzureProvider)
    assert provider.fidelity_tier == FIDELITY_ENHANCED
    assert provider.capabilities()["resource_types"] == [RESOURCE_TYPE]
    provider.close()  # closes every client, then the credential; never raises


@pytest.mark.parametrize("missing", ["subscription_id", "actor_id", "run_id"])
def test_build_provider_refuses_a_context_missing_a_required_field(missing: str) -> None:
    """A subscription has no scope to collect, and the other two are the artifact key's
    own prefix (Req 26.8, 35.6) — there is no safe default for any of them. The message
    names the field and excludes its value."""
    context = real_context(**{missing: "   "})

    with pytest.raises(ValueError) as caught:
        build_provider(context, object_store=InMemoryObjectStore())

    assert missing in str(caught.value)
    assert context["client_secret"] not in str(caught.value)


def test_build_provider_falls_back_to_baseline_for_an_unrecognised_tier() -> None:
    """The tier is a ceiling on what the run may claim (Req 31.1), so the safe reading
    of a value nobody recognises is the lower one."""
    provider = build_provider(
        real_context(fidelity_tier="platinum"), object_store=InMemoryObjectStore()
    )
    try:
        assert provider.fidelity_tier == FIDELITY_BASELINE
    finally:
        provider.close()


def test_the_fidelity_tier_spelling_matches_the_preflight_that_decides_it() -> None:
    """`azure/provider.py` mirrors the two tier strings by value rather than importing
    `azure/preflight.py`, which would pull `azure-identity` into every import of the
    provider. This is the test that keeps the mirror honest."""
    from reporting_agent.azure.preflight import FIDELITY_BASELINE as PREFLIGHT_BASELINE
    from reporting_agent.azure.preflight import FIDELITY_ENHANCED as PREFLIGHT_ENHANCED

    assert FIDELITY_BASELINE == PREFLIGHT_BASELINE
    assert FIDELITY_ENHANCED == PREFLIGHT_ENHANCED


# --------------------------------------------------------------------------- #
# capabilities (Req 18.6)
# --------------------------------------------------------------------------- #


def test_capabilities_reports_the_catalog_the_provider_was_built_over() -> None:
    """Req 18.6 — resource types, metric names per type, grains and fidelity tiers."""
    catalog = load_catalog()
    harness = Harness()

    capabilities = harness.provider.capabilities()

    assert capabilities["resource_types"] == [RESOURCE_TYPE]
    assert capabilities["metrics"][RESOURCE_TYPE] == sorted(
        metric.name
        for metric in catalog.for_resource_type(RESOURCE_TYPE).metrics  # type: ignore[union-attr]
    )
    assert capabilities["grains"] == list(SUPPORTED_GRAINS)
    assert capabilities["fidelity_tiers"] == list(FIDELITY_TIERS)
    assert_plain_data(capabilities)


def test_capabilities_names_platform_metrics_only() -> None:
    """A derived statistic id and an enhanced-tier counter id are not names that can be
    requested from the metrics endpoint, and this map is what a caller populates
    `metrics_by_resource_type` from — so claiming them would invite a request Azure
    cannot answer."""
    harness = Harness()
    names = harness.provider.capabilities()["metrics"][RESOURCE_TYPE]

    assert CPU in names
    assert "memory_used_pct" not in names  # derived
    assert "disk_free_pct" not in names  # enhanced-tier counter


def test_capabilities_lists_every_declared_grain_and_no_other() -> None:
    """`P1D` is UTC-aligned and `PT1M` is a ~6 GB month; neither is ever requested."""
    harness = Harness()
    grains = harness.provider.capabilities()["grains"]

    assert grains == ["PT1H", "PT15M"]
    assert "P1D" not in grains and "PT1M" not in grains


# --------------------------------------------------------------------------- #
# discover (Req 18.2, 18.9)
# --------------------------------------------------------------------------- #


def test_discover_returns_plain_data_ordered_by_resource_id() -> None:
    """Req 18.3, 18.9 — the array order is part of what the snapshot hashes, so two
    collections over one estate must present it identically whatever order the rows
    arrived in."""
    harness = Harness(
        inventory=[
            inventory_page(
                [
                    inventory_row("prod-web-02"),
                    inventory_row("dev-web-01", group="rg-dev-sea", tags={"env": "dev"}),
                    inventory_row("prod-web-01"),
                ]
            )
        ]
    )

    result = run(harness.provider.discover(scope()))

    assert [item["resource_id"] for item in result["resources"]] == sorted(
        [WEB_01, WEB_02, DEV_01]
    )
    assert_inventory_sorted(result["resources"])
    assert find_non_plain(result) is None


def test_discover_stamps_the_subscriptions_fidelity_tier_on_every_resource() -> None:
    """Req 20.9, 31.2 — the tier travels with the resource, and therefore with every
    statistic derived from it."""
    harness = Harness(
        inventory=[inventory_page([inventory_row("prod-web-01")])],
        fidelity_tier=FIDELITY_ENHANCED,
    )

    result = run(harness.provider.discover(scope()))

    assert [item["fidelity_tier"] for item in result["resources"]] == [FIDELITY_ENHANCED]


def test_discover_narrows_the_inventory_to_the_requested_resource_groups() -> None:
    """The Resource Graph query is scoped to the subscription and the resource types
    (Req 20.11); the group filter is applied here, because a provider returning an
    inventory wider than the requested scope would make the snapshot's
    `requested_scope` (Req 35.9) a claim the collection did not honour.

    Compared case-insensitively: Resource Graph lowercases `resourceGroup`, and a
    consultant types `RG-Prod-SEA`.
    """
    harness = Harness(
        inventory=[
            inventory_page(
                [
                    inventory_row("prod-web-01"),
                    inventory_row("dev-web-01", group="rg-dev-sea", tags={"env": "dev"}),
                ]
            )
        ]
    )

    result = run(harness.provider.discover(scope(resource_groups=["RG-Prod-SEA"])))

    assert [item["resource_id"] for item in result["resources"]] == [WEB_01]


def test_discover_narrows_the_inventory_to_the_requested_tag_filters() -> None:
    """Every filter must match, tag names case-insensitively and values exactly — which
    is how Azure itself treats them."""
    harness = Harness(
        inventory=[
            inventory_page(
                [
                    inventory_row("prod-web-01", tags={"env": "prod", "tier": "web"}),
                    inventory_row("prod-web-02", tags={"env": "prod"}),
                    inventory_row("dev-web-01", group="rg-dev-sea", tags={"env": "dev"}),
                ]
            )
        ]
    )

    result = run(harness.provider.discover(scope(tag_filters={"ENV": "prod", "tier": "web"})))

    assert [item["resource_id"] for item in result["resources"]] == [WEB_01]


def test_discover_retains_every_gap_including_one_a_filter_excluded() -> None:
    """A gap is a record of what the collection observed. Dropping the ones naming a
    filtered-out resource would make the gap count a function of the filter rather than
    of what Azure answered — and Req 29.9 ties that count to `snapshot_ready`."""
    harness = Harness(
        inventory=[
            inventory_page(
                [
                    inventory_row("prod-web-01"),
                    inventory_row(
                        "dev-web-01",
                        group="rg-dev-sea",
                        tags={"env": "dev"},
                        power_state="PowerState/deallocated",
                    ),
                ]
            )
        ]
    )

    result = run(harness.provider.discover(scope(resource_groups=["rg-prod-sea"])))

    assert [item["resource_id"] for item in result["resources"]] == [WEB_01]
    deallocated = [gap for gap in result["gaps"] if gap["gap_type"] == GAP_TYPE_DEALLOCATED]
    assert [gap["resource_id"] for gap in deallocated] == [DEV_01]


def test_discover_scopes_the_query_to_the_subscription_and_resource_types() -> None:
    """Req 20.11, observed on the call the provider actually made."""
    harness = Harness(inventory=[inventory_page([inventory_row("prod-web-01")])])

    run(harness.provider.discover(scope()))

    assert harness.inventory_port.calls == [
        {
            "subscription_id": SUBSCRIPTION,
            "resource_types": (RESOURCE_TYPE,),
            "skip_token": None,
        }
    ]


# --------------------------------------------------------------------------- #
# collect (Req 18.2, 18.3)
# --------------------------------------------------------------------------- #


def one_resource_collection(**overrides: Any) -> tuple[Harness, dict[str, Any]]:
    """A collection over one running VM, both requested metrics answered."""
    harness = Harness(
        skus=[sku_listing()],
        definitions=[definitions_response(CPU, MEMORY)],
        batches=[batch_response({WEB_01: both_metrics()})],
        **overrides,
    )
    result = run(
        harness.provider.collect(collect_request([resource_record("prod-web-01")]))
    )
    return harness, result


def test_collect_returns_plain_data_keyed_resource_then_metric_then_statistic() -> None:
    """Req 18.2, 18.3 — `statistics[resource][metric][statistic]`, every leaf plain.

    A `Decimal` would be admissible plain data, but each `StatValue` here is exactly
    one `StatisticEntry.to_plain_data()`, so the value is already the decimal **string**
    the snapshot and the verifier both match on.
    """
    _harness, result = one_resource_collection()

    assert find_non_plain(result) is None
    assert set(result["statistics"]) == {WEB_01}

    cpu = result["statistics"][WEB_01][CPU]
    assert set(cpu) >= {"avg", "min", "max", "p50", "p90", "p95", "p99"}
    assert cpu["avg"]["value"] == "15.00"  # 1800 / 120, at the catalog's scale of 2
    assert cpu["min"]["value"] == "5.00"
    assert cpu["max"]["value"] == "30.00"
    assert cpu["avg"]["unit"] == "percent"
    assert cpu["avg"]["metric"] == CPU
    assert cpu["avg"]["statistic"] == "avg"
    assert cpu["avg"]["sample_count"] == 120
    assert cpu["avg"]["fidelity_tier"] == FIDELITY_BASELINE
    assert isinstance(cpu["avg"]["value"], str)


def test_collect_labels_every_percentile_as_an_estimate_from_the_sketch() -> None:
    """Req 28.7, 28.8 — the percentile comes from the sketch folded during collection
    and carries a pre-formatted label naming the source grain, so no renderer can print
    a bare `p95`."""
    _harness, result = one_resource_collection()

    p95 = result["statistics"][WEB_01][CPU]["p95"]
    assert p95["estimated"] is True
    assert "p95" in p95["label"]
    assert "hourly" in p95["label"]
    assert p95["estimator"].startswith("histogram_sketch_pt1h")


def test_collect_derives_the_catalog_declared_statistic_from_the_sku_capacity() -> None:
    """Req 30.1, 30.2, 30.3 — `memory_used_pct` from `Available Memory Bytes` and the
    SKU's `MemoryGB`, converted to **bytes**: half of a 16 GiB SKU is exactly 50.00%,
    and a GiB-versus-bytes mistake would be wrong by 2**30 rather than by a rounding
    step."""
    _harness, result = one_resource_collection()

    derived = result["statistics"][WEB_01]["memory_used_pct"]
    assert derived["avg"]["value"] == "50.00"
    assert derived["avg"]["unit"] == "percent"
    assert derived["avg"]["formula"] == (
        "(sku_memory_bytes - available_memory_bytes) / sku_memory_bytes * 100"
    )
    assert derived["avg"]["derived_from"], "a derived value emits its derivation (Req 30.9)"
    assert derived["avg"]["observation"] == "host_observed"
    # Req 30.1's inversion: the `max` direction reads the source metric's minimum.
    assert derived["max"]["estimator"] == "derived_from_source_minimum"


def test_collect_requests_one_definitions_probe_and_one_sku_listing_per_pair() -> None:
    """Req 22.1, 22.2, 21.1, 21.6 — the caching belongs to those two modules; what this
    asserts is that the provider asks once per pair rather than once per resource."""
    harness = Harness(
        skus=[sku_listing()],
        definitions=[definitions_response(CPU, MEMORY)],
        batches=[
            batch_response({WEB_01: both_metrics(), WEB_02: both_metrics()})
        ],
    )

    run(
        harness.provider.collect(
            collect_request([resource_record("prod-web-01"), resource_record("prod-web-02")])
        )
    )

    assert len(harness.definitions_port.calls) == 1
    assert len(harness.sku_port.calls) == 1
    assert harness.sku_port.calls[0]["location"] == LOCATION


def test_collect_groups_by_subscription_location_and_resource_type() -> None:
    """Req 23.1 — one `metric_namespace` per call and a regional data plane, so two
    locations are two groups: two definitions probes, two SKU listings, two batches."""
    harness = Harness(
        skus=[sku_listing(), sku_listing()],
        definitions=[definitions_response(CPU, MEMORY), definitions_response(CPU, MEMORY)],
        batches=[
            batch_response({WEB_01: both_metrics()}),
            batch_response({WEB_01: both_metrics()}),
        ],
    )

    run(
        harness.provider.collect(
            collect_request(
                [
                    resource_record("prod-web-01"),
                    resource_record("prod-web-01", location=OTHER_LOCATION),
                ]
            )
        )
    )

    assert len(harness.definitions_port.calls) == 2
    assert {call["location"] for call in harness.metrics_port.batch_calls} == {
        LOCATION,
        OTHER_LOCATION,
    }
    assert {call["metric_namespace"] for call in harness.metrics_port.batch_calls} == {
        NAMESPACE
    }
    assert {call["aggregations"] for call in harness.metrics_port.batch_calls} == {
        AGGREGATIONS
    }


def test_collect_archives_every_folded_response_in_the_same_pass() -> None:
    """Req 26.3, 26.8, 26.9 — the archive is written during the fold, under the run's
    own prefix. The provider's contribution is passing the invocation's `actor_id` and
    `run_id` down; `collect/archive.py` owns the key and the body."""
    harness, _result = one_resource_collection()

    keys = harness.store.keys()
    assert len(keys) == 1
    assert keys[0].startswith(f"{ACTOR_ID}/snapshots/{RUN_ID}/raw/")
    assert keys[0].endswith(".json.gz")


def test_collect_excludes_a_deallocated_resource_and_records_no_statistic_for_it() -> None:
    """Req 20.5, 20.6, 20.10 — a stopped VM is present in the inventory and absent from
    every average, even when the response carried data for it. And **no** `no_samples`
    gap: the `deallocated` gap already says why, and a second classification of one
    fact would double the count `snapshot_ready` reports."""
    harness = Harness(
        skus=[sku_listing()],
        definitions=[definitions_response(CPU, MEMORY)],
        batches=[batch_response({WEB_01: both_metrics(), WEB_02: both_metrics()})],
    )

    result = run(
        harness.provider.collect(
            collect_request(
                [
                    resource_record("prod-web-01"),
                    resource_record("prod-web-02", power_state="PowerState/deallocated"),
                ]
            )
        )
    )

    assert set(result["statistics"]) == {WEB_01}
    assert GAP_TYPE_NO_SAMPLES not in gap_types(result["gaps"])
    # And no SKU listing was resolved on the excluded resource's behalf, so it collects
    # no sku_unknown / sku_capability_missing gap either.
    assert GAP_TYPE_SKU_UNKNOWN not in gap_types(result["gaps"])


def test_collect_merges_the_gaps_every_stage_produced() -> None:
    """Req 18.2 — one collection_log out, whichever stage recorded an entry.

    Three stages contribute here: the definitions probe (a metric the platform does not
    emit), the SKU catalog (a SKU absent from the location's listing) and the metrics
    collector (a per-resource 403 inside an HTTP 200).
    """
    harness = Harness(
        skus=[raw({"value": []})],  # the SKU is absent from this location's listing
        definitions=[definitions_response(CPU, MEMORY)],  # Disk Read Bytes is not emitted
        batches=[
            batch_response(
                {
                    WEB_01: [
                        metric_entry(CPU, [], error_code="Forbidden"),
                        metric_entry(MEMORY, MEMORY_INTERVALS),
                    ]
                }
            )
        ],
    )

    result = run(
        harness.provider.collect(
            collect_request(
                [resource_record("prod-web-01")], metric_names=[CPU, MEMORY, DISK_READ]
            )
        )
    )

    recorded = gap_types(result["gaps"])
    assert GAP_TYPE_METRIC_NOT_EMITTED in recorded
    assert GAP_TYPE_SKU_UNKNOWN in recorded
    assert GAP_TYPE_PERMISSION_DENIED in recorded
    assert find_non_plain(result) is None

    # The 403'd metric folded nothing, and the one that answered still produced values.
    assert CPU not in result["statistics"][WEB_01]
    assert MEMORY in result["statistics"][WEB_01]


def test_a_metric_absent_from_a_successful_probe_is_never_requested() -> None:
    """Req 20.7 — a metric the platform does not emit for this type in this region is a
    `metric_not_emitted` gap per resource, and is left out of the request rather than
    asked for and quietly answered with nothing."""
    harness = Harness(
        skus=[sku_listing()],
        definitions=[definitions_response(CPU, MEMORY)],
        batches=[batch_response({WEB_01: both_metrics()})],
    )

    result = run(
        harness.provider.collect(
            collect_request(
                [resource_record("prod-web-01")], metric_names=[CPU, MEMORY, DISK_READ]
            )
        )
    )

    not_emitted = [
        gap for gap in result["gaps"] if gap["gap_type"] == GAP_TYPE_METRIC_NOT_EMITTED
    ]
    assert [(gap["resource_id"], gap["metric"]) for gap in not_emitted] == [
        (WEB_01, DISK_READ)
    ]
    assert harness.metrics_port.batch_calls[0]["metric_names"] == (CPU, MEMORY)


def test_a_failed_definitions_probe_falls_back_without_a_metric_not_emitted_gap() -> None:
    """Req 22.5, 22.6 — an unanswered probe must stay distinguishable from a metric the
    platform does not emit, so the catalog's declared set is requested and **no**
    `metric_not_emitted` gap is derived from the failure."""
    harness = Harness(
        skus=[sku_listing()],
        definitions=[raw(None, status=403), raw(None, status=403)],
        batches=[batch_response({WEB_01: both_metrics()})],
    )

    result = run(
        harness.provider.collect(
            collect_request(
                [resource_record("prod-web-01"), resource_record("prod-web-02")],
                metric_names=[CPU, MEMORY, DISK_READ],
            )
        )
    )

    recorded = gap_types(result["gaps"])
    assert GAP_TYPE_DEFINITIONS_UNAVAILABLE in recorded
    assert GAP_TYPE_METRIC_NOT_EMITTED not in recorded
    assert harness.metrics_port.batch_calls[0]["metric_names"] == (CPU, MEMORY, DISK_READ)


def test_collect_requests_the_window_and_grain_it_was_given() -> None:
    """The batch request carries the half-open window's UTC instants and the run's
    grain — not a window this module recomputed."""
    harness, _result = one_resource_collection()

    call = harness.metrics_port.batch_calls[0]
    assert call["start_time"] == WINDOW["start_utc"]
    assert call["end_time"] == WINDOW["end_utc"]
    assert call["interval"] == "PT1H"


def test_collect_over_an_empty_resource_list_collects_nothing() -> None:
    """An empty resource list is not this module's failure to report: `EMPTY_SCOPE`
    (Req 33.1) is a whole-run judgement `collect/pipeline.py` makes after inventory,
    and a provider that raised here would pre-empt it with the wrong code."""
    harness = Harness()

    result = run(harness.provider.collect(collect_request([])))

    assert result["statistics"] == {}
    assert result["gaps"] == []
    assert result["sku_capacities"] == {}
    # The three optional keys are reported even for an empty collection, and each says
    # "nothing happened" rather than being absent: an absent `raw_archive` reads as "this
    # provider writes no archive" and an absent `locations` as "no regional routing",
    # neither of which is true of this provider (Req 24.5, 26.12).
    assert result["raw_archive"] == {"complete": True, "object_count": 0}
    assert result["locations"] == {"requested": [], "unreachable": []}
    assert harness.metrics_port.batch_calls == []


def test_collect_lets_an_exception_cross_the_protocol_untranslated() -> None:
    """Req 18.8 — the translation into a terminal `error` plus `done` belongs to
    `main.run_invocation`, which already owns the single egress. A provider that
    swallowed this would have to invent a code and would let a partial result look
    like a complete one, so the exception propagates instead.

    Driven by exhausting the fake's scripted responses, which is the cheapest way to
    make a port fail from inside the provider's own call.
    """
    harness = Harness(skus=[sku_listing()], definitions=[])

    with pytest.raises(Exception) as caught:
        run(harness.provider.collect(collect_request([resource_record("prod-web-01")])))

    assert "list_metric_definitions" in str(caught.value)


def test_close_discards_the_sku_cache_and_calls_the_release_hook() -> None:
    """Req 21.11, 22.7 — SKU restrictions are subscription-scoped, so one run's cache
    must not answer another's questions inside the same long-lived container."""
    released: list[str] = []
    cpu_only = batch_response({WEB_01: [metric_entry(CPU, CPU_INTERVALS)]})
    harness = Harness(
        skus=[sku_listing(), sku_listing()],
        definitions=[definitions_response(CPU), definitions_response(CPU)],
        batches=[cpu_only, cpu_only],
    )
    harness.provider.on_close = lambda: released.append("released")
    request = collect_request([resource_record("prod-web-01")], metric_names=[CPU])

    run(harness.provider.collect(request))
    assert len(harness.sku_port.calls) == 1

    harness.provider.close()
    assert released == ["released"]

    # A second collection through the same instance re-lists rather than serving a
    # cache the run boundary was supposed to have discarded.
    run(harness.provider.collect(request))
    assert len(harness.sku_port.calls) == 2


# --------------------------------------------------------------------------- #
# The two pure helpers
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("start", "end", "grain", "expected"),
    [
        ("2026-07-01T00:00:00Z", "2026-07-01T02:00:00Z", "PT1H", 2),
        ("2026-07-01T00:00:00Z", "2026-07-02T00:00:00Z", "PT1H", 24),
        ("2026-06-30T17:00:00Z", "2026-07-31T17:00:00Z", "PT1H", 744),
        ("2026-07-01T00:00:00Z", "2026-07-01T01:00:00Z", "PT15M", 4),
        # Rounded up: a partial interval is still an interval Azure returns.
        ("2026-07-01T00:00:00Z", "2026-07-01T00:30:00Z", "PT1H", 1),
        ("2026-07-01T00:00:00Z", "2026-07-01T01:20:00Z", "PT1H", 2),
    ],
)
def test_interval_count_for_counts_the_grain_slots_in_the_window(
    start: str, end: str, grain: str, expected: int
) -> None:
    """The count `azure/metrics.py` sizes a batch by (Req 23.2, 23.4). Too small plans
    batches that get rejected; too large plans more requests than the budget needs."""
    assert interval_count_for({"start_utc": start, "end_utc": end}, grain) == expected


@pytest.mark.parametrize("grain", ["P1D", "PT1M", "", "PT5M"])
def test_interval_count_for_refuses_a_grain_this_runtime_never_requests(grain: str) -> None:
    """Req 25.2, 25.8 — `P1D` buckets are UTC-aligned and `PT1M` is a ~6 GB month."""
    with pytest.raises(ValueError):
        interval_count_for(
            {"start_utc": "2026-07-01T00:00:00Z", "end_utc": "2026-07-02T00:00:00Z"}, grain
        )


@pytest.mark.parametrize(
    ("start", "end"),
    [
        ("2026-07-02T00:00:00Z", "2026-07-01T00:00:00Z"),
        ("2026-07-01T00:00:00Z", "2026-07-01T00:00:00Z"),
        ("not-an-instant", "2026-07-01T00:00:00Z"),
    ],
)
def test_interval_count_for_refuses_a_window_it_cannot_size(start: str, end: str) -> None:
    with pytest.raises(ValueError):
        interval_count_for({"start_utc": start, "end_utc": end}, "PT1H")


@pytest.mark.parametrize(
    ("power_state", "resource_type", "excluded"),
    [
        ("PowerState/running", RESOURCE_TYPE, False),
        ("PowerState/deallocated", RESOURCE_TYPE, True),
        ("PowerState/stopped", RESOURCE_TYPE, True),
        ("PowerState/starting", RESOURCE_TYPE, False),
        # Req 20.13 — an absent code on a VM is an unknown power state, excluded.
        ("", WIRE_TYPE, True),
        ("   ", RESOURCE_TYPE, True),
        # A resource type with no power state at all is not a VM and is not excluded.
        ("", "Microsoft.Storage/storageAccounts", False),
    ],
)
def test_is_excluded_from_averages_reads_the_two_fields_inventory_wrote(
    power_state: str, resource_type: str, excluded: bool
) -> None:
    """Req 20.6, 20.13 — derived from the record rather than from the gap list, which is
    what lets `collect` apply the exclusion without `discover`'s gaps being handed back
    to it through the protocol."""
    resource = resource_record(
        "prod-web-01", power_state=power_state, resource_type=resource_type
    )
    assert is_excluded_from_averages(resource) is excluded  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# azure/clients.py — the SDK-backed ports, over a recording sender
# --------------------------------------------------------------------------- #


class StubResponse:
    """What an SDK pipeline hands back: a status, headers, and a readable body."""

    def __init__(
        self,
        *,
        status: int = 200,
        headers: dict[str, str] | None = None,
        body: object = None,
    ) -> None:
        self.status_code = status
        self.headers = headers or {"content-type": "application/json"}
        # `HttpResponseError` reads both off whatever response it is handed, so a stub
        # standing in for one has to carry them.
        self.reason = "stubbed"
        self.content_type = "application/json"
        self._body = body

    def text(self, encoding: str | None = None) -> str:
        return "" if self._body is None else json.dumps(self._body)

    def json(self) -> object:
        return self._body


class RecordingSender:
    """A `RequestSender` that records each request and replays a scripted response."""

    def __init__(self, responses: list[Any] | None = None) -> None:
        self.requests: list[HttpRequest] = []
        self.responses = list(responses or [])

    def __call__(self, request: HttpRequest) -> Any:
        self.requests.append(request)
        if not self.responses:
            return StubResponse(body={})
        answer = self.responses.pop(0)
        if isinstance(answer, BaseException):
            raise answer
        return answer

    def params_of(self, index: int = 0) -> dict[str, str]:
        from urllib.parse import parse_qsl, urlsplit

        return dict(parse_qsl(urlsplit(self.requests[index].url).query))

    def body_of(self, index: int = 0) -> Any:
        content = self.requests[index].content
        if isinstance(content, bytes):
            content = content.decode()
        return json.loads(content)


def test_the_sdk_backed_ports_satisfy_the_port_protocols() -> None:
    """The four adapters are interchangeable with the fakes by construction, which is
    what makes every module above them testable without a subscription (Req 18.7)."""
    sender = RecordingSender()
    assert isinstance(ArmInventoryPort(sender=sender), InventoryPort)
    assert isinstance(ArmSkuPort(sender=sender), SkuPort)
    assert isinstance(ArmDefinitionsPort(sender=sender), DefinitionsPort)
    assert isinstance(
        AzureMetricsPort(arm_sender=sender), MetricsPort
    )


def test_the_inventory_query_projects_power_state_and_orders_by_id() -> None:
    """Req 20.1, 20.11 — without `powerState.code`, a deallocated VM, a metric the SKU
    does not emit and a 403 all collapse into the same '0% CPU'."""
    query = inventory_query([RESOURCE_TYPE], subscription_id=SUBSCRIPTION)

    assert "properties.extended.instanceView.powerState.code" in query
    assert "order by id asc" in query
    assert f"subscriptionId == '{SUBSCRIPTION}'" in query
    assert "type in~ ('Microsoft.Compute/virtualMachines')" in query


def test_the_inventory_query_escapes_a_quote_in_an_interpolated_value() -> None:
    """The subscription id arrives from the invocation `context` and the type names from
    the catalog; neither is quoted into a query unescaped, whatever its provenance."""
    query = inventory_query(["Micro'soft/x"], subscription_id="sub'1")

    assert "'sub''1'" in query
    assert "'Micro''soft/x'" in query


def test_the_inventory_port_sends_the_documented_request_and_carries_the_skip_token() -> None:
    sender = RecordingSender([StubResponse(body={"data": [], "$skipToken": "tok"})])
    port = ArmInventoryPort(sender=sender)

    response = run(
        port.query_resources(
            subscription_id=SUBSCRIPTION, resource_types=[RESOURCE_TYPE], skip_token="tok"
        )
    )

    request = sender.requests[0]
    assert request.method == "POST"
    assert request.url.startswith(
        f"{ARM_ENDPOINT}/providers/Microsoft.ResourceGraph/resources"
    )
    body = sender.body_of()
    assert body["subscriptions"] == [SUBSCRIPTION]
    assert body["options"]["$skipToken"] == "tok"
    assert body["options"]["resultFormat"] == "objectArray"
    assert response.status == 200


def test_the_inventory_port_normalizes_the_wire_skip_token_key() -> None:
    """Resource Graph names the continuation token `$skipToken`; `azure/inventory.py`
    and the recorded fixtures read `skipToken`. The adapter adds the second spelling
    without removing the first, so an archived body is still the body Azure sent."""
    sender = RecordingSender([StubResponse(body={"data": [], "$skipToken": "tok"})])
    port = ArmInventoryPort(sender=sender)

    response = run(
        port.query_resources(
            subscription_id=SUBSCRIPTION, resource_types=[], skip_token=None
        )
    )

    assert isinstance(response.body, dict)
    assert response.body["skipToken"] == "tok"
    assert response.body["$skipToken"] == "tok"
    assert "options" in sender.body_of()
    assert "$skipToken" not in sender.body_of()["options"]


def test_the_sku_port_always_filters_by_location(monkeypatch: pytest.MonkeyPatch) -> None:
    """Req 21.1 — an unfiltered listing returns every SKU in every region."""
    sender = RecordingSender([StubResponse(body={"value": [{"name": SKU_NAME}]})])
    port = ArmSkuPort(sender=sender)

    run(port.list_skus(subscription_id=SUBSCRIPTION, location=LOCATION))

    params = sender.params_of()
    assert params["$filter"] == f"location eq '{LOCATION}'"
    assert f"/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Compute/skus" in (
        sender.requests[0].url
    )


def test_the_sku_port_concatenates_every_page_of_one_locations_listing() -> None:
    """`azure/skus.py` parses one `{"value": [...]}` body into the whole location's
    catalog, so a listing spread over `nextLink` pages is joined here rather than
    leaving the parser to discover half its SKUs are missing."""
    sender = RecordingSender(
        [
            StubResponse(body={"value": [{"name": "a"}], "nextLink": "https://arm/next"}),
            StubResponse(body={"value": [{"name": "b"}]}),
        ]
    )
    port = ArmSkuPort(sender=sender)

    response = run(port.list_skus(subscription_id=SUBSCRIPTION, location=LOCATION))

    assert isinstance(response.body, dict)
    assert [entry["name"] for entry in response.body["value"]] == ["a", "b"]
    assert sender.requests[1].url == "https://arm/next"


def test_the_sku_port_returns_a_failed_page_as_it_arrived() -> None:
    """A non-2xx listing is returned unchanged: `azure/skus.py` already reads it as
    'treat this location's listing as empty', and every SKU that would have resolved
    against it records `sku_unknown` from the input side (Req 21.7)."""
    sender = RecordingSender([StubResponse(status=403, body={"error": {"code": "Denied"}})])
    port = ArmSkuPort(sender=sender)

    response = run(port.list_skus(subscription_id=SUBSCRIPTION, location=LOCATION))

    assert response.status == 403
    assert not response.ok
    assert len(sender.requests) == 1


def test_the_definitions_port_probes_one_resource_with_its_namespace() -> None:
    """Req 22.1 — one probe against one resource; the caching is
    `azure/definitions.py`'s."""
    sender = RecordingSender([StubResponse(body={"value": []})])
    port = ArmDefinitionsPort(sender=sender)

    run(port.list_metric_definitions(resource_id=WEB_01, metric_namespace=NAMESPACE))

    assert sender.requests[0].url.startswith(f"{ARM_ENDPOINT}{WEB_01}")
    assert "microsoft.insights/metricDefinitions" in sender.requests[0].url
    assert sender.params_of()["metricnamespace"] == NAMESPACE


def test_the_batch_metrics_port_targets_the_regional_data_plane() -> None:
    """Req 23.1, 23.5, 23.10 — one metric namespace per call, against
    `https://{location}.metrics.monitor.azure.com`, with the resource ids in the body."""
    sender = RecordingSender([StubResponse(body={"values": []})])
    port = AzureMetricsPort(
        arm_sender=RecordingSender(),
        metrics_client_factory=lambda location: _StubClient(sender),
    )

    run(
        port.query_batch(
            location=LOCATION,
            subscription_id=SUBSCRIPTION,
            resource_ids=[WEB_01, WEB_02],
            metric_namespace=NAMESPACE,
            metric_names=[CPU, MEMORY],
            aggregations=AGGREGATIONS,
            start_time=WINDOW["start_utc"],
            end_time=WINDOW["end_utc"],
            interval="PT1H",
        )
    )

    assert sender.requests[0].url.startswith(
        f"https://{LOCATION}.metrics.monitor.azure.com/subscriptions/{SUBSCRIPTION}"
    )
    assert "metrics:getBatch" in sender.requests[0].url
    params = sender.params_of()
    assert params["starttime"] == WINDOW["start_utc"]
    assert params["endtime"] == WINDOW["end_utc"]
    assert params["interval"] == "PT1H"
    assert params["metricnames"] == f"{CPU},{MEMORY}"
    assert params["aggregation"] == ",".join(AGGREGATIONS)
    assert sender.body_of()["resourceids"] == [WEB_01, WEB_02]


def test_the_batch_metrics_port_reuses_one_client_per_location() -> None:
    """The endpoint is regional and the audience is not, so one client per location
    over the one credential — not one per request."""
    built: list[str] = []
    sender = RecordingSender([StubResponse(body={"values": []}), StubResponse(body={"values": []})])

    def factory(location: str) -> Any:
        built.append(location)
        return _StubClient(sender)

    port = AzureMetricsPort(
        arm_sender=RecordingSender(),
        metrics_client_factory=factory,
    )
    for _ in range(2):
        run(
            port.query_batch(
                location=LOCATION,
                subscription_id=SUBSCRIPTION,
                resource_ids=[WEB_01],
                metric_namespace=NAMESPACE,
                metric_names=[CPU],
                aggregations=AGGREGATIONS,
                start_time=WINDOW["start_utc"],
                end_time=WINDOW["end_utc"],
                interval="PT1H",
            )
        )

    assert built == [LOCATION]


def test_a_dns_resolution_failure_raises_the_one_exception_a_port_defines() -> None:
    """Req 24.2 — a region with no metrics data-plane host never reaches a server, so
    there is no envelope to return. `azure/regions.py` catches this to memoise the
    location as fallback-only for the rest of the run."""
    sender = RecordingSender(
        [ServiceRequestError("Failed to resolve 'norwayeast.metrics.monitor.azure.com'")]
    )
    port = AzureMetricsPort(
        arm_sender=RecordingSender(),
        metrics_client_factory=lambda location: _StubClient(sender),
    )

    with pytest.raises(DnsResolutionError) as caught:
        run(
            port.query_batch(
                location="norwayeast",
                subscription_id=SUBSCRIPTION,
                resource_ids=[WEB_01],
                metric_namespace=NAMESPACE,
                metric_names=[CPU],
                aggregations=AGGREGATIONS,
                start_time=WINDOW["start_utc"],
                end_time=WINDOW["end_utc"],
                interval="PT1H",
            )
        )

    assert caught.value.location == "norwayeast"


def test_a_transient_connection_failure_is_not_routed_to_the_fallback() -> None:
    """The fallback memo lasts for the rest of the run (Req 24.6), so a reset or a TLS
    failure must not trigger it: those are transient, and a whole location would be
    demoted to per-resource requests over a blip."""
    sender = RecordingSender([ServiceRequestError("Connection reset by peer")])
    port = AzureMetricsPort(
        arm_sender=RecordingSender(),
        metrics_client_factory=lambda location: _StubClient(sender),
    )

    with pytest.raises(ServiceRequestError):
        run(
            port.query_batch(
                location=LOCATION,
                subscription_id=SUBSCRIPTION,
                resource_ids=[WEB_01],
                metric_namespace=NAMESPACE,
                metric_names=[CPU],
                aggregations=AGGREGATIONS,
                start_time=WINDOW["start_utc"],
                end_time=WINDOW["end_utc"],
                interval="PT1H",
            )
        )


@pytest.mark.parametrize(
    "message",
    [
        "Failed to resolve 'norwayeast.metrics.monitor.azure.com'",
        "[Errno -2] Name or service not known",
        "nodename nor servname provided, or not known",
        "Temporary failure in name resolution",
        "getaddrinfo failed",
    ],
)
def test_is_dns_resolution_failure_recognises_a_resolver_failure(message: str) -> None:
    assert is_dns_resolution_failure(ServiceRequestError(message))


@pytest.mark.parametrize(
    "message",
    ["Connection reset by peer", "certificate verify failed", "Read timed out", ""],
)
def test_is_dns_resolution_failure_ignores_every_other_transport_failure(
    message: str,
) -> None:
    assert not is_dns_resolution_failure(ServiceRequestError(message))


def test_is_dns_resolution_failure_reads_the_whole_exception_chain() -> None:
    """The transport nests the resolver's own message inside its wrapper."""
    inner = OSError("[Errno -2] Name or service not known")
    outer = ServiceRequestError("request failed")
    outer.__cause__ = inner
    assert is_dns_resolution_failure(outer)


def test_the_per_resource_fallback_carries_the_batch_paths_own_parameters() -> None:
    """Req 24.7 — the same grain, window, metric names and aggregations, against the
    ARM control plane, which has no regional endpoint and therefore resolves."""
    arm = RecordingSender([StubResponse(body={"value": []})])
    port = AzureMetricsPort(arm_sender=arm)

    run(
        port.query_resource_fallback(
            resource_id=WEB_01,
            metric_namespace=NAMESPACE,
            metric_names=[CPU],
            aggregations=AGGREGATIONS,
            start_time=WINDOW["start_utc"],
            end_time=WINDOW["end_utc"],
            interval="PT1H",
        )
    )

    assert arm.requests[0].url.startswith(f"{ARM_ENDPOINT}{WEB_01}")
    assert "microsoft.insights/metrics" in arm.requests[0].url
    params = arm.params_of()
    assert params["timespan"] == f"{WINDOW['start_utc']}/{WINDOW['end_utc']}"
    assert params["interval"] == "PT1H"
    assert params["aggregation"] == ",".join(AGGREGATIONS)


def test_the_logical_disk_query_is_scoped_to_one_resource_and_the_window() -> None:
    """Req 31.4, 31.6 — bounded to the **run's own window** and to this VM, projecting
    `InstanceName` so an AMA regression collapsing it to `_Total` is visible rather
    than mis-attributed.

    The timespan is the window's own `start/end` interval, not a trailing duration: a July
    report generated in August is about July, and `PT744H` measured from now would read the
    wrong month while looking entirely plausible.
    """
    logs = RecordingSender([StubResponse(body={"tables": []})])
    port = AzureMetricsPort(
        arm_sender=RecordingSender(),
        logs_sender_factory=lambda: logs,
    )

    run(
        port.query_logical_disk_free_space(
            workspace_id="9c8b7a65-4321-4321-4321-0123456789ab",
            resource_id=WEB_01,
            start_time=WINDOW["start_utc"],
            end_time=WINDOW["end_utc"],
        )
    )

    body = logs.body_of()
    assert "9c8b7a65-4321-4321-4321-0123456789ab" in logs.requests[0].url
    assert body["timespan"] == f"{WINDOW['start_utc']}/{WINDOW['end_utc']}"
    assert "PT" not in body["timespan"], "a trailing duration would read the wrong period"
    assert "% Free Space" in body["query"]
    assert "InstanceName" in body["query"]
    assert "prod-web-01" in body["query"]


def test_an_envelope_keeps_every_number_exact() -> None:
    """A metric interval's `total` ends up in a snapshot value that must hash
    identically in two processes (Req 27.5, 34.1), so the body is parsed with
    `parse_float=Decimal` and never through a `float`."""
    response = StubResponse(body={"total": 1284.5, "count": 60})

    envelope = envelope_from_response(response)

    assert isinstance(envelope.body, dict)
    assert envelope.body["total"] == Decimal("1284.5")
    assert isinstance(envelope.body["total"], Decimal)
    assert envelope.body["count"] == 60


def test_an_envelope_treats_an_unreadable_body_as_absent() -> None:
    """The same defensive convention `azure/skus.py` and `azure/inventory.py` already
    apply to a malformed page: no rows, rather than an exception three frames up."""

    class NotJson(StubResponse):
        def text(self, encoding: str | None = None) -> str:
            return "<html>502</html>"

        def json(self) -> object:
            raise ValueError("not json")

    envelope = envelope_from_response(NotJson(status=502))

    assert envelope.status == 502
    assert envelope.body is None
    assert not envelope.ok


def test_an_http_response_error_is_rebuilt_into_an_envelope() -> None:
    """`azure/ports.py`'s own contract: a concrete port catches the SDK's
    `HttpResponseError` and rebuilds the envelope rather than letting it cross."""
    sender = RecordingSender(
        [HttpResponseError(response=StubResponse(status=429, headers={"Retry-After": "7"}))]
    )
    port = ArmDefinitionsPort(sender=sender)

    response = run(
        port.list_metric_definitions(resource_id=WEB_01, metric_namespace=NAMESPACE)
    )

    assert response.status == 429
    assert response.header("retry-after") == "7"


class _StubClient:
    """Stands in for an SDK client exposing the public `send_request`."""

    def __init__(self, sender: RecordingSender) -> None:
        self.send_request = sender


def test_pipeline_sender_prefers_the_public_accessor_each_client_exposes() -> None:
    """The pinned clients disagree about the spelling of the same operation:
    `send_request` on the two data-plane clients, `_send_request` on
    `MonitorManagementClient`, and `_client.send_request` on the two older ARM
    clients."""
    sender = RecordingSender()

    class Public:
        send_request = sender

    class Generated:
        _send_request = sender

    class Older:
        class _Inner:
            send_request = sender

        _client = _Inner()

    assert pipeline_sender(Public()) is sender
    assert pipeline_sender(Generated()) is sender
    assert pipeline_sender(Older()) is sender


def test_pipeline_sender_refuses_a_client_it_cannot_send_through() -> None:
    """Rather than falling back to a hand-built pipeline, which would authenticate
    outside the invocation's single credential (Req 19.1)."""
    with pytest.raises(TypeError):
        pipeline_sender(object())
