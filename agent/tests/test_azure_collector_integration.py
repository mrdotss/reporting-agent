"""Task 11.10 — the collector's behaviours asserted through the **provider** seam.

Every requirement exercised here already has a unit test against the module that owns
it (`tests/test_azure_inventory.py`, `test_azure_skus.py`, `test_azure_definitions.py`,
`test_azure_regions.py`, `test_azure_metrics.py`, `test_collect_archive.py`). What is
different here is the width of the seam: each scenario is driven through
`azure/provider.py`'s `discover` and `collect` — assembled by the production
`provider_over_ports` over `tests/fakes/azure_ports.py` and `InMemoryObjectStore` — so a
behaviour that holds inside its own module and then breaks once wired is caught.

**That width is the point, and it is not cosmetic.** A per-resource 403 that
`azure/metrics.py` records as a gap still has to arrive at the boundary as *no
statistic for that resource* — the unit test can only assert the accumulator finalizes
to `None`, which is one wiring mistake away from a zero-valued `StatValue` reaching the
snapshot anyway. Likewise a `sku_capability_missing` gap is only worth recording if
`memory_used_pct` is genuinely absent from `CollectResult.statistics`, and a definitions
cache is only worth having if *a collection* probes once rather than if a `DefinitionProbe`
called directly does. Those are the assertions below.

Several scenarios are driven `discover` → `collect`, feeding `collect` the inventory
`discover` itself returned rather than records hand-written to match. The two speak
different field vocabularies (Resource Graph's `id` / `powerState` versus the protocol's
`resource_id` / `power_state_raw`, and a `type` Resource Graph lowercases), so a handoff
built from a literal would keep passing after either side drifted.

**Recorded responses drive every scenario that has one.** `tests/fixtures/azure/` holds
the paging pair with the duplicated boundary id, all four quota-header variants, the
per-resource 403 inside a 200, the resource absent from a response, the interval missing
its `count`, both response-too-large rejections, both `Retry-After` forms and both SKU
listings. A body is hand-built here only where no recording exists — the *successful*
answers a halving or retry sequence ends in, and a listing missing `MemoryGB` (whose
sibling fixture the recorded set names but does not contain).

**What is deliberately not here.** Req 31.6's `_Total` / absent `InstanceName` collapse
is already asserted through the pipeline — a seam wider than this one — by
`tests/test_collect_pipeline.py::test_a_collapsed_instance_name_emits_no_free_space_value_at_all`,
over both recorded Log Analytics fixtures. Re-asserting it here would add a third copy of
one fact. The pure parsers (`parse_retry_after`, `parse_reset_after`,
`classify_metric_error_code`, `plan_batches`) stay unit-tested where they are: a parser
has no wiring to get wrong.

No Azure SDK, no credential, no subscription, no network, and no real waiting: every
scenario that waits runs against an injected `sleep` that records instead of sleeping.
"""

from __future__ import annotations

import asyncio
import gzip
import json
from datetime import UTC, datetime
from typing import Any, Final

import pytest

from fakes.azure_ports import (
    DNS_UNREACHABLE_LOCATIONS,
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    facts_port_answering_nothing,
    raw_response_from_recorded,
)
from fakes.object_store import InMemoryObjectStore
from fixtures import RecordedResponse, load_response
from reporting_agent.azure.inventory import (
    DEALLOCATED_POWER_STATE_CODES,
    FALLBACK_WAIT_S,
    MAX_CONSECUTIVE_FALLBACK_WAITS,
    parse_reset_after,
)
from reporting_agent.azure.metrics import AGGREGATIONS
from reporting_agent.azure.ports import DnsResolutionError, RawHttpResponse
from reporting_agent.azure.provider import (
    FIDELITY_BASELINE,
    AzureProvider,
    provider_over_ports,
)
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.archive import ARCHIVE_KIND_METRICS, archive_kind_of
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_DUPLICATE_INVENTORY_ROW,
    GAP_TYPE_INTERVAL_COUNTS_MISSING,
    GAP_TYPE_PERMISSION_DENIED,
    GAP_TYPE_REGION_UNREACHABLE,
    GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE,
    GAP_TYPE_RESPONSE_TOO_LARGE,
    GAP_TYPE_SKU_CAPABILITY_MISSING,
)
from reporting_agent.errors import ErrorCode, ThrottledError
from reporting_agent.providers.base import (
    CollectRequest,
    CollectResult,
    DiscoverResult,
    GapRecord,
    ResourceRecord,
    ScopeSpec,
    assert_inventory_sorted,
    find_non_plain,
)

# The subscription every recorded fixture names. Spelled once, so a fixture edited to a
# different subscription fails on a missing resource rather than on a mismatched string
# buried in a body.
SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
RESOURCE_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
WIRE_TYPE: Final[str] = "microsoft.compute/virtualmachines"
LOCATION: Final[str] = "southeastasia"
OTHER_LOCATION: Final[str] = "australiaeast"
UNREACHABLE_LOCATION: Final[str] = DNS_UNREACHABLE_LOCATIONS[0]
GROUP: Final[str] = "rg-prod-sea"
ACTOR_ID: Final[str] = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID: Final[str] = "run_01HQZX8QW9K7YB4T2C3M5N6P7Q"

CPU: Final[str] = "Percentage CPU"
MEMORY: Final[str] = "Available Memory Bytes"
MEMORY_USED_PCT: Final[str] = "memory_used_pct"

# The constrained-core SKU the recorded listing carries: vCPUs=32, vCPUsAvailable=8,
# MemoryGB=256 (Req 21.2, 21.3).
CONSTRAINED_SKU: Final[str] = "Standard_E32-8s_v5"
# The recorded listing that carries vCPUs but no vCPUsAvailable (Req 21.9).
LEGACY_SKU: Final[str] = "Standard_Legacy_A2"

GIB: Final[int] = 1073741824

# The run's half-open window: two `PT1H` intervals, which is what every recorded metrics
# body is shaped against.
WINDOW: Final[dict[str, str]] = {
    "start": "2026-07-01",
    "end": "2026-07-01",
    "start_utc": "2026-07-01T00:00:00Z",
    "end_utc": "2026-07-01T02:00:00Z",
}

# A real-time watchdog. Every scenario finishes in milliseconds — nothing here waits for
# real — so this only fires when something stopped producing, and then it fails a test
# rather than hanging the suite. The same guard `tests/test_azure_integration.py` takes.
WATCHDOG_S: Final[float] = 10.0


def resource_id(name: str, *, group: str = GROUP) -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{group}"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


WEB_01: Final[str] = resource_id("prod-web-01")
WEB_02: Final[str] = resource_id("prod-web-02")
WEB_03: Final[str] = resource_id("prod-web-03")
SQL_01: Final[str] = resource_id("prod-sql-01")


def run(coro: Any) -> Any:
    return asyncio.run(asyncio.wait_for(coro, timeout=WATCHDOG_S))


# --------------------------------------------------------------------------- #
# Response builders. Only for the shapes tests/fixtures/azure/ does not record:
# the successful answers a halving, retry or fallback sequence ends in.
# --------------------------------------------------------------------------- #


def raw(
    body: object, *, status: int = 200, headers: dict[str, str] | None = None
) -> RawHttpResponse:
    return RawHttpResponse(status=status, headers=headers or {}, body=body)


def wire_row(
    name: str,
    *,
    group: str = GROUP,
    location: str = LOCATION,
    power_state: str = "PowerState/running",
    sku: str = CONSTRAINED_SKU,
) -> dict[str, Any]:
    """One Resource Graph row, in Azure's own field vocabulary.

    `type` is lowercased exactly as Resource Graph returns it, so the collections below
    exercise the case folding `discover` -> `collect` depends on rather than handing the
    provider the catalog's own spelling.
    """
    return {
        "id": resource_id(name, group=group),
        "name": name,
        "type": WIRE_TYPE,
        "location": location,
        "resourceGroup": group,
        "tags": {"env": "prod"},
        "sku": sku,
        "powerState": power_state,
    }


def inventory_page(
    rows: list[dict[str, Any]], *, skip_token: str | None = None
) -> RawHttpResponse:
    body: dict[str, Any] = {"totalRecords": len(rows), "count": len(rows), "data": rows}
    if skip_token is not None:
        body["skipToken"] = skip_token
    return raw(body, headers={"x-ms-user-quota-remaining": "9"})


def definitions_response(*names: str) -> RawHttpResponse:
    return raw({"value": [{"name": {"value": name}} for name in names]})


def metric_entry(
    name: str, intervals: list[dict[str, Any]], *, error_code: str = "Success"
) -> dict[str, Any]:
    entry: dict[str, Any] = {
        "name": {"value": name, "localizedValue": name},
        "errorCode": error_code,
    }
    if error_code == "Success":
        entry["timeseries"] = [{"metadatavalues": [], "data": intervals}]
    return entry


def cpu_intervals(*, total: float = 720.0, count: int = 60) -> list[dict[str, Any]]:
    return [
        {
            "timeStamp": WINDOW["start_utc"],
            "total": total,
            "count": count,
            "minimum": 5.0,
            "maximum": 30.0,
        }
    ]


def memory_intervals(bytes_available: int) -> list[dict[str, Any]]:
    return [
        {
            "timeStamp": WINDOW["start_utc"],
            "total": bytes_available,
            "count": 1,
            "minimum": bytes_available,
            "maximum": bytes_available,
        }
    ]


def batch_response(resource_metrics: dict[str, list[dict[str, Any]]]) -> RawHttpResponse:
    """A `MetricsClient.query_resources` answer for the resources it names."""
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
        }
    )


def cpu_batch(resource_ids: list[str], *, total: float = 720.0) -> RawHttpResponse:
    return batch_response(
        {rid: [metric_entry(CPU, cpu_intervals(total=total))] for rid in resource_ids}
    )


def fallback_response(entries: list[dict[str, Any]]) -> RawHttpResponse:
    """A per-resource `MonitorManagementClient.metrics.list` answer.

    Its metric entries sit under `value` rather than under `values[].value`: the ARM
    control-plane operation answers for one resource, so there is no per-resource level
    in its envelope at all.
    """
    return raw({"value": entries})


# --------------------------------------------------------------------------- #
# One assembled provider over the four fakes plus the archive store
# --------------------------------------------------------------------------- #


class Collector:
    """`provider_over_ports` over the four scripted fakes and an in-memory store.

    The assembly is the production one, so what the ports see is what the five collector
    modules send. `sleep` is the recorder every wait lands in — one instance shared by
    `azure/inventory.py`'s quota waits and `azure/metrics.py`'s 429 waits, exactly as
    `provider_over_ports` threads it — so a scenario that waits runs instantly and the
    waits it applied are assertable.
    """

    def __init__(
        self,
        *,
        inventory: list[RawHttpResponse] | None = None,
        skus: list[RawHttpResponse] | None = None,
        definitions: list[RawHttpResponse] | None = None,
        batches: list[Any] | None = None,
        fallbacks: list[RawHttpResponse] | None = None,
        fidelity_tier: str = FIDELITY_BASELINE,
        now: datetime | None = None,
    ) -> None:
        self.waits: list[float] = []
        self.inventory_port = FakeInventoryPort(inventory or [])
        self.sku_port = FakeSkuPort(skus or [])
        self.definitions_port = FakeDefinitionsPort(definitions or [])
        self.metrics_port = FakeMetricsPort(
            batch_responses=batches or [], fallback_responses=fallbacks or []
        )
        self.store = InMemoryObjectStore()
        self.provider: AzureProvider = provider_over_ports(
            inventory_port=self.inventory_port,
            sku_port=self.sku_port,
            definitions_port=self.definitions_port,
            metrics_port=self.metrics_port,
            facts_port=facts_port_answering_nothing(),
            object_store=self.store,
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            fidelity_tier=fidelity_tier,
            catalog=load_catalog(),
            sleep=self._sleep,
        )
        if now is not None:
            # `provider_over_ports` threads `sleep` but not the collector's clock, and
            # `Retry-After` as an HTTP-date is a wait *relative to now* — read against a
            # real clock the recorded 2026 date would silently clamp to zero once that
            # date passes. The clock is replaced rather than the wiring re-done, so this
            # still exercises the collector the assembly helper built.
            self.provider.metrics.now = lambda: now

    async def _sleep(self, seconds: float) -> None:
        self.waits.append(seconds)

    def scope(self) -> ScopeSpec:
        return ScopeSpec(
            subscription_id=SUBSCRIPTION,
            resource_types=[RESOURCE_TYPE],
            resource_groups=[],
            tag_filters={},
        )

    def request(
        self, resources: list[ResourceRecord], *, metric_names: list[str]
    ) -> CollectRequest:
        return CollectRequest(
            scope=self.scope(),
            resources=list(resources),
            metrics_by_resource_type={RESOURCE_TYPE: metric_names},
            grain="PT1H",
            window=WINDOW,  # type: ignore[typeddict-item]
            timezone="Asia/Jakarta",
            utc_offset="+07:00",
        )

    def discover(self) -> DiscoverResult:
        return run(self.provider.discover(self.scope()))

    def collect(
        self, resources: list[ResourceRecord], *, metric_names: list[str]
    ) -> CollectResult:
        return run(self.provider.collect(self.request(resources, metric_names=metric_names)))

    def discover_then_collect(
        self, *, metric_names: list[str]
    ) -> tuple[DiscoverResult, CollectResult]:
        """One run's two protocol calls, in order, over one event loop.

        `collect` is handed the inventory `discover` returned — never records written to
        match it — so the two halves of the provider protocol are checked against each
        other rather than against a literal.
        """

        async def go() -> tuple[DiscoverResult, CollectResult]:
            discovered = await self.provider.discover(self.scope())
            collected = await self.provider.collect(
                self.request(list(discovered["resources"]), metric_names=metric_names)
            )
            return discovered, collected

        return run(go())


def gap_types(gaps: list[GapRecord]) -> list[str]:
    return [gap["gap_type"] for gap in gaps]


def of_type(gaps: list[GapRecord], gap_type: str) -> list[GapRecord]:
    return [gap for gap in gaps if gap["gap_type"] == gap_type]


def recorded(name: str) -> RecordedResponse:
    return load_response("azure", name)


def replay(name: str) -> RawHttpResponse:
    return raw_response_from_recorded(recorded(name))


def every_value(statistics: Any) -> list[str]:
    """Every `value` string in a `CollectResult.statistics` tree.

    Used to assert Req 29.3's "no code path converts a per-resource error into a zero"
    positively at the boundary: not "the accumulator finalized to None", but "no zero
    reached the structure the snapshot is built from".
    """
    return [
        stat["value"]
        for by_metric in statistics.values()
        for by_statistic in by_metric.values()
        for stat in by_statistic.values()
    ]


# =========================================================================== #
# Inventory, through `discover` (Req 20.2, 20.3, 20.4, 20.5, 20.10, 20.12, 20.14)
# =========================================================================== #


def test_a_paged_discover_folds_a_boundary_duplicate_and_keeps_the_stopped_vm() -> None:
    """Req 20.2, 20.12, 20.5, 20.10 — the whole recorded page pair, through `discover`.

    Three facts at once, because they are one collection's facts: the `skipToken` is
    followed exactly once and with the value page 1 carried, the resource id repeated
    across the boundary yields one entry plus one `duplicate_inventory_row` gap, and the
    deallocated VM on page 2 is *present* in the inventory carrying its own power state.

    The count assertion is the load-bearing one. Both recorded pages declare
    `totalRecords: 3`, so a collector that appended rows instead of folding by id would
    return 4 resources — a resource count that depends on where Azure happened to put a
    page boundary, in a document whose whole claim is that it is reproducible.
    """
    page_1 = replay("resource_graph_page_1_of_2")
    page_2 = replay("resource_graph_page_2_of_2_duplicate_boundary")
    collector = Collector(inventory=[page_1, page_2])

    result = collector.discover()

    ids = [resource["resource_id"] for resource in result["resources"]]
    assert ids == [WEB_01, WEB_02, WEB_03]
    assert len(ids) == page_1.body["totalRecords"]  # type: ignore[index]
    assert len(ids) == len(set(ids))
    assert_inventory_sorted(result["resources"])
    assert find_non_plain(result) is None

    # Exactly two requests: the first unpaged, the second carrying page 1's own token.
    assert [call["skip_token"] for call in collector.inventory_port.calls] == [
        None,
        page_1.body["skipToken"],  # type: ignore[index]
    ]
    assert collector.waits == [], "quota-remaining 9 and 8 leave nothing to wait for"

    duplicates = of_type(result["gaps"], GAP_TYPE_DUPLICATE_INVENTORY_ROW)
    assert [gap["resource_id"] for gap in duplicates] == [WEB_02]

    # Req 20.5, 20.10 — retained, and labelled with the exact projected code.
    stopped = next(r for r in result["resources"] if r["resource_id"] == WEB_03)
    assert stopped["power_state_raw"] in DEALLOCATED_POWER_STATE_CODES
    assert stopped["power_state"] == "deallocated"
    assert stopped["resource_type"] == WIRE_TYPE
    assert stopped["location"] == LOCATION
    assert stopped["resource_group"] == GROUP
    assert stopped["tags"] == {"env": "prod"}
    assert stopped["fidelity_tier"] == FIDELITY_BASELINE

    deallocated = of_type(result["gaps"], GAP_TYPE_DEALLOCATED)
    assert [gap["resource_id"] for gap in deallocated] == [WEB_03]
    assert stopped["power_state_raw"] in deallocated[0]["message"]


def test_the_stopped_vm_discover_kept_produces_no_statistic_when_collected() -> None:
    """Req 20.6, 20.10 — retained by `discover`, excluded by `collect`.

    The batch answers for **all three** resources, the stopped one included, so the
    exclusion has to come from the power state `discover` recorded rather than from an
    absence of data. That is the case that matters: Azure does sometimes return a
    trailing bucket for a machine that has just been stopped, and folding it would report
    a deallocated VM as measured idle — the precise error Req 20.5 exists to prevent.

    Driven `discover` -> `collect` over the same recorded pages, so the exclusion is read
    off the record the inventory collector actually wrote.
    """
    collector = Collector(
        inventory=[
            replay("resource_graph_page_1_of_2"),
            replay("resource_graph_page_2_of_2_duplicate_boundary"),
        ],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU)],
        batches=[cpu_batch([WEB_01, WEB_02, WEB_03])],
    )

    discovered, collected = collector.discover_then_collect(metric_names=[CPU])

    assert WEB_03 in {r["resource_id"] for r in discovered["resources"]}
    assert set(collected["statistics"]) == {WEB_01, WEB_02}
    assert WEB_03 not in collected["statistics"]
    assert "0.00" not in every_value(collected["statistics"])
    # The two running resources still collected normally: 720 / 60 at the catalog's
    # scale of 2, so the exclusion is not a whole-group failure wearing a gap.
    assert collected["statistics"][WEB_01][CPU]["avg"]["value"] == "12.00"


def test_a_paged_discover_waits_only_for_the_pages_whose_quota_header_says_zero() -> None:
    """Req 20.3, 20.4, 20.14 — all four recorded quota variants in one paged collection.

    Four page transitions, three waits: the `remaining: 1` page is followed immediately
    (Req 20.3's boundary value), and the three exhausted pages each interpose exactly one
    wait — the header's own duration for the parseable one (Req 20.4), the 5-second
    fallback for the absent and the unparseable ones (Req 20.14).

    The first wait is compared against `parse_reset_after` of the recording's own header
    rather than against a literal, because that fixture's `00:00:05` happens to equal
    `FALLBACK_WAIT_S`: hard-coding `5.0` here would pass just as well for a collector
    that ignored the header entirely and always applied its own backoff.
    """
    with_reset = recorded("resource_graph_quota_remaining_0_with_reset")
    header_wait = parse_reset_after(with_reset.header("x-ms-user-quota-resets-after"))
    assert header_wait is not None

    collector = Collector(
        inventory=[
            replay("resource_graph_quota_remaining_1"),
            raw_response_from_recorded(with_reset),
            replay("resource_graph_quota_remaining_0_without_reset"),
            replay("resource_graph_quota_remaining_0_unparseable_reset"),
            inventory_page([]),  # no skipToken: paging stops here
        ]
    )

    result = collector.discover()

    assert len(collector.inventory_port.calls) == 5
    assert collector.waits == [header_wait, FALLBACK_WAIT_S, FALLBACK_WAIT_S]
    assert len(collector.waits) == 3, (
        "four transitions and three waits: the remaining-1 page is followed immediately"
    )
    assert [r["name"] for r in result["resources"]] == [
        "prod-app-01",
        "prod-app-02",
        "prod-app-03",
        "prod-app-04",
    ]


def test_a_fourth_consecutive_quota_fallback_fails_the_whole_discover_as_throttled() -> None:
    """Req 20.14 — the 4th consecutive fallback wait is refused, and the run is over.

    The escalation is checked at the provider seam because that is where it has to be
    survivable: `discover` neither swallows it into a gap nor returns a partial inventory
    that would look like a small subscription. Three waits were applied, the 4th was
    refused, and the code is the **retryable** `THROTTLED` rather than anything that
    reads as the customer's configuration being wrong.
    """
    exhausted = replay("resource_graph_quota_remaining_0_without_reset")
    collector = Collector(inventory=[exhausted] * (MAX_CONSECUTIVE_FALLBACK_WAITS + 1))

    with pytest.raises(ThrottledError) as caught:
        collector.discover()

    assert caught.value.code is ErrorCode.THROTTLED
    assert collector.waits == [FALLBACK_WAIT_S] * MAX_CONSECUTIVE_FALLBACK_WAITS
    assert len(collector.inventory_port.calls) == MAX_CONSECUTIVE_FALLBACK_WAITS + 1


# =========================================================================== #
# Metrics, through `collect`
# (Req 23.3, 23.8, 23.12, 23.13, 23.14, 29.1, 29.2, 29.3, 29.6, 20.8)
# =========================================================================== #


def test_a_per_resource_403_inside_a_200_yields_a_gap_and_no_statistic_at_all() -> None:
    """Req 29.1, 29.2, 29.3, 20.8 — the denial reaches the boundary as *nothing*.

    The recorded response is HTTP **200**: the call succeeded and `prod-sql-01`'s entry
    inside it carries `errorCode: Forbidden`. What the unit test can assert is that the
    accumulator finalizes to `None`; what has to be true at the boundary is that no
    `StatValue` exists for that resource at all, so `every_value` is checked for a zero
    across the whole tree rather than for `prod-sql-01` alone. A folded zero here would
    average a permission failure into the report as measured idleness.

    `prod-web-01`, whose entry says `Success`, still collects: one resource's denial is
    not the group's.
    """
    collector = Collector(
        inventory=[inventory_page([wire_row("prod-web-01"), wire_row("prod-sql-01")])],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU)],
        batches=[replay("metrics_batch_per_resource_403")],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU])

    denied = of_type(collected["gaps"], GAP_TYPE_PERMISSION_DENIED)
    assert [(gap["resource_id"], gap["metric"]) for gap in denied] == [(SQL_01, CPU)]

    assert SQL_01 not in collected["statistics"]
    assert set(collected["statistics"]) == {WEB_01}
    assert "0.00" not in every_value(collected["statistics"])
    # 1284.5 / 60 = 21.4083..., quantized to the catalog's scale of 2.
    assert collected["statistics"][WEB_01][CPU]["avg"]["value"] == "21.41"


def test_a_requested_resource_absent_from_the_response_yields_a_gap_and_no_statistic() -> None:
    """Req 23.12, 29.6 — matched by resource id, so an absence is recorded, not inferred.

    The recorded body answers for `prod-web-01` only, while the collection requested two
    resources. Positional matching would hand `prod-web-01`'s series to whichever
    resource sat at index 0 of the request; there is nothing at index 1 to mismatch into,
    so the *only* observable difference is whether `prod-web-02` is named in a gap and
    absent from the statistics, which is what is asserted.
    """
    collector = Collector(
        inventory=[inventory_page([wire_row("prod-web-01"), wire_row("prod-web-02")])],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU)],
        batches=[replay("metrics_batch_resource_absent_from_response")],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU])

    absent = of_type(collected["gaps"], GAP_TYPE_RESOURCE_ABSENT_FROM_RESPONSE)
    assert [gap["resource_id"] for gap in absent] == [WEB_02]
    assert set(collected["statistics"]) == {WEB_01}
    assert collected["statistics"][WEB_01][CPU]["avg"]["value"] == "12.00"


def test_an_interval_missing_its_count_is_excluded_from_the_average_at_the_boundary() -> None:
    """Req 23.13 — the average reported is the one the complete intervals support.

    The recorded body's second interval carries `total: 850` and no `count`. A
    count-weighted average has no weight to apply to it, so it is excluded and the
    reported average is 720 / 60 = 12.00 over 60 samples. An implementation that folded
    the total anyway and kept the count would report 26.17, and an implementation that
    guessed a count would report something plausible and unverifiable — both wrong in a
    way no reader could see.
    """
    collector = Collector(
        inventory=[inventory_page([wire_row("prod-web-01")])],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU)],
        batches=[replay("metrics_batch_interval_missing_count")],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU])

    missing = of_type(collected["gaps"], GAP_TYPE_INTERVAL_COUNTS_MISSING)
    assert [(gap["resource_id"], gap["metric"]) for gap in missing] == [(WEB_01, CPU)]

    cpu = collected["statistics"][WEB_01][CPU]
    assert cpu["avg"]["value"] == "12.00"
    assert cpu["avg"]["sample_count"] == 60
    assert cpu["avg"]["value"] != "26.17", "the incomplete interval was folded anyway"


def test_a_response_too_large_halves_to_one_resource_and_then_splits_by_metric() -> None:
    """Req 23.3, 23.14 — the whole rejection ladder, in one collection.

    Both recorded rejections drive it. The two-resource batch rejects, so the resource
    ids halve by integer division into two single-resource requests. The first of those
    *still* rejects, and a batch of one cannot halve — so it splits by metric name, and
    both single-metric requests answer. The second single-resource request answers
    directly.

    Five requests, and every resource ends up with a value: no `response_too_large` gap,
    because nothing was ever abandoned. The request sequence is asserted, not just the
    outcome, because "halve and drop the other half" would produce the same *absence* of
    a gap while silently losing a resource.
    """
    collector = Collector(
        inventory=[inventory_page([wire_row("prod-web-01"), wire_row("prod-web-02")])],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU, MEMORY)],
        batches=[
            replay("metrics_batch_response_too_large"),
            replay("metrics_batch_response_too_large_single_resource"),
            cpu_batch([WEB_01]),
            batch_response({WEB_01: [metric_entry(MEMORY, memory_intervals(128 * GIB))]}),
            batch_response(
                {
                    WEB_02: [
                        metric_entry(CPU, cpu_intervals()),
                        metric_entry(MEMORY, memory_intervals(128 * GIB)),
                    ]
                }
            ),
        ],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU, MEMORY])

    calls = collector.metrics_port.batch_calls
    assert [call["resource_ids"] for call in calls] == [
        (WEB_01, WEB_02),  # the planned batch, rejected
        (WEB_01,),  # halved by integer division, rejected again
        (WEB_01,),  # split by metric name
        (WEB_01,),
        (WEB_02,),  # the other half, requested rather than dropped
    ]
    assert [call["metric_names"] for call in calls] == [
        (CPU, MEMORY),
        (CPU, MEMORY),
        (CPU,),
        (MEMORY,),
        (CPU, MEMORY),
    ]

    assert GAP_TYPE_RESPONSE_TOO_LARGE not in gap_types(collected["gaps"])
    assert set(collected["statistics"]) == {WEB_01, WEB_02}
    for rid in (WEB_01, WEB_02):
        assert collected["statistics"][rid][CPU]["avg"]["value"] == "12.00"
        assert MEMORY in collected["statistics"][rid]

    # Req 26.10 — only the three *accepted* batch responses were archived; neither of the
    # two rejections was. The fourth object is the one Resource Graph page, archived
    # because the inventory query projects facts (Req 7.1) — written as a sum so the
    # claim being made stays "3 of the 5 batch requests, plus the inventory page" rather
    # than a bare 4 that any accounting could satisfy.
    accepted_batch_responses = 3
    inventory_pages = 1
    assert collected["raw_archive"] == {
        "complete": True,
        "object_count": accepted_batch_responses + inventory_pages,
    }


def test_a_single_metric_request_that_still_rejects_records_the_gap_and_no_value() -> None:
    """Req 23.14 — the floor of the ladder: recorded, never zero-filled.

    One resource, one metric, and the rejection repeats after the metric split has
    nothing left to split. The resource keeps no statistic for that metric and carries a
    `response_too_large` gap instead, so the report says "this could not be read" rather
    than "this read as nothing".
    """
    rejection = "metrics_batch_response_too_large_single_resource"
    collector = Collector(
        inventory=[inventory_page([wire_row("prod-web-01")])],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU)],
        batches=[replay(rejection), replay(rejection)],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU])

    too_large = of_type(collected["gaps"], GAP_TYPE_RESPONSE_TOO_LARGE)
    assert [(gap["resource_id"], gap["metric"]) for gap in too_large] == [(WEB_01, CPU)]
    assert collected["statistics"] == {}
    # No batch response was ever accepted, so the only archived object is the one Resource
    # Graph page — the inventory query projects the catalog's facts, so its page is a
    # fact-bearing response and is archived as it arrives (Req 7.1).
    assert collected["raw_archive"] == {"complete": True, "object_count": 1}


@pytest.mark.parametrize(
    ("fixture_name", "expected_wait"),
    [
        ("metrics_batch_429_retry_after_seconds", 30.0),
        ("metrics_batch_429_retry_after_http_date", 300.0),
    ],
)
def test_a_429_retry_after_is_honoured_in_both_recorded_forms_and_the_retry_folds(
    fixture_name: str, expected_wait: float
) -> None:
    """Req 23.8 — seconds and HTTP-date, both waited exactly, both retried and folded.

    The two forms are one requirement and two recordings, so they are one parametrized
    test. The date form is read against an injected clock pinned to the recording's own
    hour; against a real clock the 2026 instant clamps to zero the moment that date
    passes, which would turn "the header was honoured" into a test that quietly stops
    checking anything.

    The wait is asserted **and** so is the value the retry produced, because a collector
    that waited correctly and then dropped the retried batch would satisfy the first
    assertion alone.
    """
    collector = Collector(
        inventory=[inventory_page([wire_row("prod-web-01")])],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU)],
        batches=[replay(fixture_name), cpu_batch([WEB_01])],
        now=datetime(2026, 7, 1, 0, 0, 0, tzinfo=UTC),
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU])

    assert collector.waits == [expected_wait]
    assert len(collector.metrics_port.batch_calls) == 2
    assert collected["statistics"][WEB_01][CPU]["avg"]["value"] == "12.00"
    # The rejected 429 was not archived; the accepted retry was (Req 26.10). Plus the one
    # Resource Graph page, archived because the inventory query projects facts (Req 7.1).
    accepted_retries = 1
    inventory_pages = 1
    assert collected["raw_archive"] == {
        "complete": True,
        "object_count": accepted_retries + inventory_pages,
    }


# =========================================================================== #
# SKU capacity, through `collect` (Req 21.2, 21.3, 21.6, 21.9, 21.10, 30.7)
# =========================================================================== #


def test_the_capacity_that_reaches_the_boundary_is_vcpus_available_never_vcpus() -> None:
    """Req 21.2, 21.3 — `Standard_E32-8s_v5` exposes 8 of the 32 vCPUs it advertises.

    Asserted on `CollectResult.sku_capacities`, which is the only place downstream of
    this boundary that can learn what capacity a figure was computed against — nothing
    past the provider may ask the SKU catalog. A `vCPUs` fallback would overstate this
    SKU fourfold and every derived per-core figure built on it would be wrong by the same
    factor, which is precisely the mistake that looks reasonable in a delivered document.

    `memory_used_pct` is checked alongside it because it is the one figure that consumes
    a capacity today: the recorded 256 GiB, converted to bytes, against a folded average
    of exactly half. A GiB-versus-bytes slip would be out by 2**30, not by a rounding
    step.
    """
    collector = Collector(
        inventory=[inventory_page([wire_row("prod-web-01")])],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU, MEMORY)],
        batches=[
            batch_response(
                {
                    WEB_01: [
                        metric_entry(CPU, cpu_intervals()),
                        metric_entry(MEMORY, memory_intervals(128 * GIB)),
                    ]
                }
            )
        ],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU, MEMORY])

    capacity = collected["sku_capacities"][WEB_01]
    assert capacity == {
        "name": CONSTRAINED_SKU,
        "vcpus_available": "8",
        "memory_bytes": str(256 * GIB),
    }
    assert capacity["vcpus_available"] != "32"

    assert collected["statistics"][WEB_01][MEMORY_USED_PCT]["avg"]["value"] == "50.00"
    assert GAP_TYPE_SKU_CAPABILITY_MISSING not in gap_types(collected["gaps"])
    # Req 21.6 — one listing for the whole group, and it was location-filtered.
    assert [call["location"] for call in collector.sku_port.calls] == [LOCATION]


def test_a_sku_missing_vcpus_available_omits_it_and_still_derives_from_the_memory_it_has() -> None:
    """Req 21.9 — the gap is recorded, the field is omitted, and `vCPUs` is not read.

    The recorded listing carries `vCPUs: 2` and no `vCPUsAvailable`. What the boundary
    must show is a capacity record with **no** `vcpus_available` key at all, rather than
    one carrying `2`: an omitted field reads as unknown, while a present `2` reads as a
    measurement and would silently become the denominator of a per-core figure.

    `MemoryGB` is present in the same listing, so `memory_used_pct` still derives — one
    missing capability disables the figures that depend on it and nothing else.
    """
    collector = Collector(
        inventory=[inventory_page([wire_row("prod-web-01", sku=LEGACY_SKU)])],
        skus=[replay("resource_skus_without_vcpus_available")],
        definitions=[definitions_response(CPU, MEMORY)],
        batches=[
            batch_response(
                {
                    WEB_01: [
                        metric_entry(CPU, cpu_intervals()),
                        # Half of the listing's 3.5 GiB, so the derivation is 50.00%.
                        metric_entry(MEMORY, memory_intervals(int(GIB * 7 // 4))),
                    ]
                }
            )
        ],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU, MEMORY])

    capacity = collected["sku_capacities"][WEB_01]
    assert "vcpus_available" not in capacity
    assert "2" not in capacity.values()
    assert capacity["memory_bytes"] == str(int(GIB * 7 // 2))

    missing = of_type(collected["gaps"], GAP_TYPE_SKU_CAPABILITY_MISSING)
    assert [gap["metric"] for gap in missing] == ["vCPUsAvailable"]
    assert LEGACY_SKU in missing[0]["message"]

    assert collected["statistics"][WEB_01][MEMORY_USED_PCT]["avg"]["value"] == "50.00"


def test_a_sku_missing_memory_gb_emits_no_memory_percentage_and_records_the_gap() -> None:
    """Req 21.10, 30.7 — no capacity, therefore no percentage. Not a zero, not a guess.

    The listing body is hand-built: the recorded set names a missing-`MemoryGB` sibling
    fixture in its comments but does not contain one, and the *only* thing this scenario
    needs is one capability removed.

    `Percentage CPU` still collects, which is what makes the absence meaningful — the run
    continues and reports what it could read, and the one figure that needed the missing
    capacity is simply not there.
    """
    collector = Collector(
        inventory=[inventory_page([wire_row("prod-web-01", sku="Standard_NoMemory")])],
        skus=[
            raw(
                {
                    "value": [
                        {
                            "resourceType": "virtualMachines",
                            "name": "Standard_NoMemory",
                            "locations": [LOCATION],
                            "capabilities": [{"name": "vCPUsAvailable", "value": "4"}],
                        }
                    ]
                }
            )
        ],
        definitions=[definitions_response(CPU, MEMORY)],
        batches=[
            batch_response(
                {
                    WEB_01: [
                        metric_entry(CPU, cpu_intervals()),
                        metric_entry(MEMORY, memory_intervals(8 * GIB)),
                    ]
                }
            )
        ],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU, MEMORY])

    missing = of_type(collected["gaps"], GAP_TYPE_SKU_CAPABILITY_MISSING)
    assert missing, "a missing capability is recorded, never inferred later"
    assert {gap["metric"] for gap in missing} == {"MemoryGB"}

    statistics = collected["statistics"][WEB_01]
    assert MEMORY_USED_PCT not in statistics
    assert CPU in statistics and MEMORY in statistics
    assert "memory_bytes" not in collected["sku_capacities"][WEB_01]


# =========================================================================== #
# Metric definitions, through `collect` (Req 22.1, 22.2, 22.3)
# =========================================================================== #


def test_a_collection_over_fifty_resources_in_one_pair_issues_exactly_one_probe() -> None:
    """Req 22.3, first clause, stated in the requirement's own numbers.

    Fifty resources sharing one `(resource_type, region)` pair. Definitions are identical
    across resources of one type in one region, so fifty probes would burn the request
    quota the metric values need and add minutes to a run for no information. The count is
    asserted on the *port*, which caches nothing of its own, so what is measured is the
    collection's behaviour.

    Fifty rather than a handful because the requirement names 50, and because a
    per-resource probe is indistinguishable from a cached one at a sample size of two.
    """
    names = [f"prod-web-{index:02d}" for index in range(1, 51)]
    ids = sorted(resource_id(name) for name in names)
    collector = Collector(
        inventory=[inventory_page([wire_row(name) for name in names])],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU)],
        batches=[cpu_batch(ids)],
    )

    discovered, collected = collector.discover_then_collect(metric_names=[CPU])

    assert len(discovered["resources"]) == 50
    assert len(collector.definitions_port.calls) == 1
    assert len(collected["statistics"]) == 50
    # Req 21.6 — the SKU listing is cached on the same terms, over the same 50 resources.
    assert len(collector.sku_port.calls) == 1


def test_a_collection_of_one_type_across_two_regions_issues_exactly_two_probes() -> None:
    """Req 22.3, second clause — the cache key is the pair, so a region is not free.

    One resource type in two regions: two probes, one per region, and each probe goes to
    the lowest-sorting resource id of its own region (Req 22.4), never to one region's
    resource on another region's behalf. A metric emitted in one region is not thereby
    emitted in the other, so a cache keyed on resource type alone would answer for a
    region it never asked about.

    The two batch calls are also asserted, in sorted group order, because that ordering is
    the provider's determinism guarantee: two runs over one inventory request the same
    groups in the same sequence.
    """
    sea = sorted(resource_id(f"sea-vm-{index:02d}") for index in range(1, 4))
    aue = sorted(resource_id(f"aue-vm-{index:02d}") for index in range(1, 4))
    rows = [wire_row(f"sea-vm-{index:02d}") for index in range(1, 4)]
    rows += [
        wire_row(f"aue-vm-{index:02d}", location=OTHER_LOCATION) for index in range(1, 4)
    ]

    collector = Collector(
        inventory=[inventory_page(rows)],
        skus=[
            replay("resource_skus_with_vcpus_available"),
            replay("resource_skus_with_vcpus_available"),
        ],
        definitions=[definitions_response(CPU), definitions_response(CPU)],
        # Sorted group order: australiaeast before southeastasia.
        batches=[cpu_batch(aue), cpu_batch(sea)],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU])

    assert len(collector.definitions_port.calls) == 2
    assert [call["resource_id"] for call in collector.definitions_port.calls] == [
        aue[0],
        sea[0],
    ]
    assert [call["location"] for call in collector.metrics_port.batch_calls] == [
        OTHER_LOCATION,
        LOCATION,
    ]
    assert len(collected["statistics"]) == 6
    assert {call["location"] for call in collector.sku_port.calls} == {
        LOCATION,
        OTHER_LOCATION,
    }


# =========================================================================== #
# Regional routing, through `collect` (Req 24.2, 24.6, 24.7, 24.8, 26.3)
# =========================================================================== #


def test_a_dns_failure_routes_to_the_per_resource_fallback_and_archives_its_responses() -> None:
    """Req 24.2, 24.7, 24.8 — the slow path is collected *and* archived, in one pass.

    A region with no metrics data-plane host fails in DNS, so the batch call raises before
    any server sees it and every resource in that location is collected through the ARM
    control-plane per-resource operation instead. Req 24.8 is what is asserted through the
    store: each fallback response is written to the raw archive during the same pass that
    folds it, so a fallback location is as replayable as a batched one.

    That has to be checked here rather than trusted, because the archive is what makes
    replay verification possible at all: the points are discarded after folding, so a
    fallback response that was folded but not archived is a hole in the evidence trail
    that nothing later can fill.
    """
    collector = Collector(
        inventory=[
            inventory_page(
                [
                    wire_row("prod-web-01", location=UNREACHABLE_LOCATION),
                    wire_row("prod-web-02", location=UNREACHABLE_LOCATION),
                ]
            )
        ],
        skus=[replay("resource_skus_with_vcpus_available")],
        definitions=[definitions_response(CPU)],
        batches=[DnsResolutionError(UNREACHABLE_LOCATION)],
        fallbacks=[
            fallback_response([metric_entry(CPU, cpu_intervals())]),
            fallback_response([metric_entry(CPU, cpu_intervals(total=1200.0))]),
        ],
    )

    _discovered, collected = collector.discover_then_collect(metric_names=[CPU])

    # One batch attempt, which never reached a server; then one request per resource.
    assert len(collector.metrics_port.batch_calls) == 1
    fallback_calls = collector.metrics_port.fallback_calls
    assert [call["resource_id"] for call in fallback_calls] == [WEB_01, WEB_02]
    # Req 24.7 — the fallback asks for what the batch path would have asked for.
    for call in fallback_calls:
        assert call["metric_names"] == (CPU,)
        assert call["aggregations"] == AGGREGATIONS
        assert call["interval"] == "PT1H"
        assert call["start_time"] == WINDOW["start_utc"]
        assert call["end_time"] == WINDOW["end_utc"]

    # The location was collected, not dropped, and is not reported unreachable.
    assert collected["locations"] == {
        "requested": [UNREACHABLE_LOCATION],
        "unreachable": [],
    }
    assert GAP_TYPE_REGION_UNREACHABLE not in gap_types(collected["gaps"])
    assert collected["statistics"][WEB_01][CPU]["avg"]["value"] == "12.00"
    assert collected["statistics"][WEB_02][CPU]["avg"]["value"] == "20.00"

    # Req 24.8, 26.3, 26.8 — one gzip archive object per fallback response, in the fold
    # pass, under the run's own prefix.
    keys = collector.store.keys()
    fallback_responses = 2
    inventory_pages = 1
    assert len(keys) == fallback_responses + inventory_pages
    assert collected["raw_archive"] == {
        "complete": True,
        "object_count": fallback_responses + inventory_pages,
    }
    for key in keys:
        assert key.startswith(f"{ACTOR_ID}/snapshots/{RUN_ID}/raw/")
        assert key.endswith(".json.gz")

    everything = [
        json.loads(gzip.decompress(collector.store.get(key).body))  # type: ignore[union-attr]
        for key in keys
    ]
    # Narrowed by the object's **declared kind**, not by which keys happen to sort first:
    # the inventory page is archived alongside these and carries a different body shape.
    archived = [
        document
        for document in everything
        if archive_kind_of(document) == ARCHIVE_KIND_METRICS
    ]
    assert len(archived) == fallback_responses
    assert [document["resource_ids"] for document in archived] == [[WEB_01], [WEB_02]]
    for document in archived:
        assert document["grouping_key"]["location"] == UNREACHABLE_LOCATION
        assert document["grain"] == "PT1H"
        assert document["metric_names"] == [CPU]
        # The response as it arrived, so replay re-folds Azure's own answer.
        assert document["raw_response"]["value"][0]["name"]["value"] == CPU
