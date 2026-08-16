"""Task 11.1 — the four `azure/ports.py` protocols, the recorded-response fixtures,
and the fakes that replay them.

These tests exist to prove the seam itself before anything in `azure/` is built
against it: every fake actually satisfies its `Protocol` (`runtime_checkable`, so this
is a real `isinstance` check, not a structural hope), every new fixture loads and
explains itself under the existing convention, and the fixtures carry the specific
values Req 20.3/20.4/20.14, 23.8, 23.12/23.13, 21.2/21.9 and 31.6 are actually about —
so a later task that gets one of those requirements wrong fails here first rather than
inside whichever integration test replays the same recording for a different purpose.

No Azure SDK, no network, no subscription — the whole point of the port boundary
(Req 18.3, 18.4, 18.7).
"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from decimal import Decimal

import pytest

from fakes.azure_ports import (
    DNS_REACHABLE_LOCATIONS,
    DNS_UNREACHABLE_LOCATIONS,
    ExhaustedScriptError,
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    raw_response_from_recorded,
)
from fakes.object_store import InMemoryObjectStore, StoredObject
from fixtures import load_response
from reporting_agent.azure.ports import (
    DefinitionsPort,
    DnsResolutionError,
    InventoryPort,
    MetricsPort,
    RawHttpResponse,
    SkuPort,
)
from reporting_agent.storage.base import ObjectNotFoundError, ObjectStore, ObjectStoreError

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
ACTOR = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"


def run(coro):
    return asyncio.run(coro)


# --------------------------------------------------------------------------- #
# RawHttpResponse
# --------------------------------------------------------------------------- #


def test_raw_http_response_header_lookup_is_case_insensitive() -> None:
    response = RawHttpResponse(
        status=429, headers={"Retry-After": "30"}, body={"error": "throttled"}
    )

    assert response.header("retry-after") == "30"
    assert response.header("RETRY-AFTER") == "30"
    assert response.header("x-ms-user-quota-remaining") is None


def test_raw_http_response_ok_reflects_the_2xx_range() -> None:
    assert RawHttpResponse(status=200, headers={}, body={}).ok is True
    assert RawHttpResponse(status=299, headers={}, body={}).ok is True
    assert RawHttpResponse(status=300, headers={}, body={}).ok is False
    assert RawHttpResponse(status=403, headers={}, body={}).ok is False


def test_raw_http_response_from_recorded_carries_status_headers_and_body() -> None:
    recorded = load_response("azure", "metrics_batch_per_resource_403")
    response = raw_response_from_recorded(recorded)

    assert response.status == recorded.status
    assert response.headers == dict(recorded.headers)
    assert response.body == recorded.body


def test_dns_resolution_error_names_the_location() -> None:
    error = DnsResolutionError("norwayeast")
    assert error.location == "norwayeast"
    assert "norwayeast" in str(error)


# --------------------------------------------------------------------------- #
# every fake satisfies its Protocol (Req 18.4)
# --------------------------------------------------------------------------- #


def test_the_fake_inventory_port_satisfies_inventory_port() -> None:
    assert isinstance(FakeInventoryPort([]), InventoryPort)


def test_the_fake_sku_port_satisfies_sku_port() -> None:
    assert isinstance(FakeSkuPort([]), SkuPort)


def test_the_fake_definitions_port_satisfies_definitions_port() -> None:
    assert isinstance(FakeDefinitionsPort([]), DefinitionsPort)


def test_the_fake_metrics_port_satisfies_metrics_port() -> None:
    assert isinstance(FakeMetricsPort(), MetricsPort)


# --------------------------------------------------------------------------- #
# FakeInventoryPort — skip_token paging, a duplicated resource across the boundary
# --------------------------------------------------------------------------- #


def test_the_inventory_fake_replays_a_paged_sequence_in_order() -> None:
    page_1 = raw_response_from_recorded(load_response("azure", "resource_graph_page_1_of_2"))
    page_2 = raw_response_from_recorded(
        load_response("azure", "resource_graph_page_2_of_2_duplicate_boundary")
    )
    port = FakeInventoryPort([page_1, page_2])

    first = run(
        port.query_resources(
            subscription_id=SUBSCRIPTION,
            resource_types=("Microsoft.Compute/virtualMachines",),
            skip_token=None,
        )
    )
    assert first is page_1
    assert first.body["skipToken"] is not None

    second = run(
        port.query_resources(
            subscription_id=SUBSCRIPTION,
            resource_types=("Microsoft.Compute/virtualMachines",),
            skip_token=first.body["skipToken"],
        )
    )
    assert second is page_2
    assert second.body["skipToken"] is None

    # The duplicated resource id really is present at the tail of page 1 and the
    # head of page 2 -- the fixture's own claim, checked rather than assumed.
    assert page_1.body["data"][-1]["id"] == page_2.body["data"][0]["id"]

    assert [call["skip_token"] for call in port.calls] == [None, first.body["skipToken"]]


def test_the_inventory_fake_raises_when_called_past_its_script() -> None:
    port = FakeInventoryPort([])

    with pytest.raises(ExhaustedScriptError):
        run(
            port.query_resources(
                subscription_id=SUBSCRIPTION, resource_types=(), skip_token=None
            )
        )


@pytest.mark.parametrize(
    ("fixture_name", "expected_remaining"),
    [
        ("resource_graph_quota_remaining_1", "1"),
        ("resource_graph_quota_remaining_0_with_reset", "0"),
        ("resource_graph_quota_remaining_0_without_reset", "0"),
        ("resource_graph_quota_remaining_0_unparseable_reset", "0"),
    ],
)
def test_every_quota_header_fixture_carries_the_documented_remaining_value(
    fixture_name: str, expected_remaining: str
) -> None:
    recorded = load_response("azure", fixture_name)
    assert recorded.header("x-ms-user-quota-remaining") == expected_remaining


def test_the_unparseable_reset_header_fixture_is_not_a_duration_string() -> None:
    recorded = load_response("azure", "resource_graph_quota_remaining_0_unparseable_reset")
    header = recorded.header("x-ms-user-quota-resets-after")
    assert header == "unknown"
    # A d.hh:mm:ss duration never starts with a letter; this recording's whole point
    # is that a collector must not treat it as one.
    assert not header[0].isdigit()


def test_the_absent_reset_header_fixture_really_has_none() -> None:
    recorded = load_response("azure", "resource_graph_quota_remaining_0_without_reset")
    assert recorded.header("x-ms-user-quota-resets-after") is None


# --------------------------------------------------------------------------- #
# FakeSkuPort — always location-filtered
# --------------------------------------------------------------------------- #


def test_the_sku_fake_records_the_location_every_call_was_made_with() -> None:
    response = raw_response_from_recorded(
        load_response("azure", "resource_skus_with_vcpus_available")
    )
    port = FakeSkuPort([response])

    result = run(port.list_skus(subscription_id=SUBSCRIPTION, location="southeastasia"))

    assert result is response
    assert port.calls == [{"subscription_id": SUBSCRIPTION, "location": "southeastasia"}]


def test_vcpus_available_and_vcpus_fixture_carries_both_capabilities_with_different_values() -> None:
    """Pins the fixture's own claim: vCPUs (32, the parent SKU) and vCPUsAvailable (8,
    what Standard_E32-8s_v5 actually exposes) must differ, or the fixture would not be
    able to catch a `vCPUs` fallback (Req 21.2, 21.3, 21.9)."""
    recorded = load_response("azure", "resource_skus_with_vcpus_available")
    capabilities = {
        c["name"]: c["value"] for c in recorded.body["value"][0]["capabilities"]
    }

    assert capabilities["vCPUs"] == "32"
    assert capabilities["vCPUsAvailable"] == "8"
    assert capabilities["vCPUs"] != capabilities["vCPUsAvailable"]
    assert Decimal(capabilities["vCPUsAvailable"]) == 8


def test_the_missing_vcpus_available_fixture_really_omits_it() -> None:
    recorded = load_response("azure", "resource_skus_without_vcpus_available")
    capabilities = {
        c["name"] for c in recorded.body["value"][0]["capabilities"]
    }
    assert "vCPUs" in capabilities
    assert "vCPUsAvailable" not in capabilities


# --------------------------------------------------------------------------- #
# FakeDefinitionsPort
# --------------------------------------------------------------------------- #


def test_the_definitions_fake_counts_probes_by_call_not_by_cache() -> None:
    """The fake performs no caching of its own (that is `azure/definitions.py`'s job,
    Req 22.1, 22.2) -- calling it 3 times with 3 scripted responses records 3 calls,
    proving there is nothing here that would silently make a caching bug look like it
    passed."""
    ok = RawHttpResponse(status=200, headers={}, body={"value": []})
    port = FakeDefinitionsPort([ok, ok, ok])

    for _ in range(3):
        run(
            port.list_metric_definitions(
                resource_id="/subscriptions/x/resourceGroups/y/.../vm-1",
                metric_namespace="Microsoft.Compute/virtualMachines",
            )
        )

    assert len(port.calls) == 3


# --------------------------------------------------------------------------- #
# FakeMetricsPort — batch, DNS failure -> fallback, per-resource 403, Retry-After
# --------------------------------------------------------------------------- #


def test_the_metrics_fake_replays_a_per_resource_403_inside_an_http_200() -> None:
    response = raw_response_from_recorded(load_response("azure", "metrics_batch_per_resource_403"))
    port = FakeMetricsPort(batch_responses=[response])

    result = run(
        port.query_batch(
            location="southeastasia",
            subscription_id=SUBSCRIPTION,
            resource_ids=("vm-1", "vm-2"),
            metric_namespace="Microsoft.Compute/virtualMachines",
            metric_names=("Percentage CPU",),
            aggregations=("Total", "Count", "Minimum", "Maximum"),
            start_time="2026-07-01T00:00:00Z",
            end_time="2026-07-01T01:00:00Z",
            interval="PT1H",
        )
    )

    assert result.ok
    entries = {entry["resourceid"]: entry for entry in result.body["values"]}
    forbidden = entries[
        "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/rg-prod-sea"
        "/providers/Microsoft.Compute/virtualMachines/prod-sql-01"
    ]
    assert forbidden["value"][0]["errorCode"] == "Forbidden"
    succeeded = entries[
        "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/rg-prod-sea"
        "/providers/Microsoft.Compute/virtualMachines/prod-web-01"
    ]
    assert succeeded["value"][0]["errorCode"] == "Success"


def test_a_dns_resolution_error_in_the_batch_script_is_raised_not_returned() -> None:
    port = FakeMetricsPort(batch_responses=[DnsResolutionError("norwayeast")])

    with pytest.raises(DnsResolutionError) as caught:
        run(
            port.query_batch(
                location="norwayeast",
                subscription_id=SUBSCRIPTION,
                resource_ids=("vm-1",),
                metric_namespace="Microsoft.Compute/virtualMachines",
                metric_names=("Percentage CPU",),
                aggregations=("Total", "Count", "Minimum", "Maximum"),
                start_time="2026-07-01T00:00:00Z",
                end_time="2026-07-01T01:00:00Z",
                interval="PT1H",
            )
        )
    assert caught.value.location == "norwayeast"


def test_a_dns_failure_can_be_followed_by_a_successful_fallback_call() -> None:
    """The scripted shape of Req 24.2: the batch path fails DNS, and the caller (a
    later task's `azure/regions.py` + `azure/metrics.py`) is expected to route the
    same request to `query_resource_fallback` instead. This fake supports exactly that
    two-method sequence because the two are independently scripted."""
    port = FakeMetricsPort(
        batch_responses=[DnsResolutionError("norwayeast")],
        fallback_responses=[
            RawHttpResponse(
                status=200,
                headers={},
                body={"value": [{"timeseries": [{"data": [{"timeStamp": "t", "total": 1, "count": 1}]}]}]},
            )
        ],
    )

    with pytest.raises(DnsResolutionError):
        run(
            port.query_batch(
                location="norwayeast",
                subscription_id=SUBSCRIPTION,
                resource_ids=("vm-1",),
                metric_namespace="Microsoft.Compute/virtualMachines",
                metric_names=("Percentage CPU",),
                aggregations=("Total", "Count", "Minimum", "Maximum"),
                start_time="2026-07-01T00:00:00Z",
                end_time="2026-07-01T01:00:00Z",
                interval="PT1H",
            )
        )

    fallback = run(
        port.query_resource_fallback(
            resource_id="vm-1",
            metric_namespace="Microsoft.Compute/virtualMachines",
            metric_names=("Percentage CPU",),
            aggregations=("Total", "Count", "Minimum", "Maximum"),
            start_time="2026-07-01T00:00:00Z",
            end_time="2026-07-01T01:00:00Z",
            interval="PT1H",
        )
    )
    assert fallback.ok
    assert port.fallback_calls == [
        {
            "resource_id": "vm-1",
            "metric_namespace": "Microsoft.Compute/virtualMachines",
            "metric_names": ("Percentage CPU",),
            "aggregations": ("Total", "Count", "Minimum", "Maximum"),
            "start_time": "2026-07-01T00:00:00Z",
            "end_time": "2026-07-01T01:00:00Z",
            "interval": "PT1H",
        }
    ]


@pytest.mark.parametrize(
    "fixture_name",
    ["metrics_batch_429_retry_after_seconds", "metrics_batch_429_retry_after_http_date"],
)
def test_both_retry_after_forms_are_recorded_as_429_with_the_header_present(
    fixture_name: str,
) -> None:
    recorded = load_response("azure", fixture_name)
    assert recorded.status == 429
    assert recorded.header("retry-after") is not None


def test_the_seconds_form_of_retry_after_parses_as_an_integer() -> None:
    recorded = load_response("azure", "metrics_batch_429_retry_after_seconds")
    header = recorded.header("retry-after")
    assert header is not None
    assert int(header) == 30


def test_the_http_date_form_of_retry_after_parses_as_a_future_instant() -> None:
    recorded = load_response("azure", "metrics_batch_429_retry_after_http_date")
    header = recorded.header("retry-after")
    assert header is not None
    parsed = datetime.strptime(header, "%a, %d %b %Y %H:%M:%S %Z").replace(tzinfo=UTC)
    assert parsed > datetime(2026, 1, 1, tzinfo=UTC)


def test_the_response_too_large_fixtures_carry_no_values_and_the_error_header() -> None:
    for fixture_name in (
        "metrics_batch_response_too_large",
        "metrics_batch_response_too_large_single_resource",
    ):
        recorded = load_response("azure", fixture_name)
        assert not recorded.ok
        assert recorded.header("x-ms-error-code") == "ResponseTooLarge"
        assert "values" not in recorded.body


def test_the_resource_absent_fixture_answers_for_only_one_of_two_resources() -> None:
    recorded = load_response("azure", "metrics_batch_resource_absent_from_response")
    resource_ids = {entry["resourceid"] for entry in recorded.body["values"]}
    assert resource_ids == {
        "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/rg-prod-sea"
        "/providers/Microsoft.Compute/virtualMachines/prod-web-01"
    }


def test_the_interval_missing_count_fixture_has_one_complete_and_one_incomplete_interval() -> None:
    recorded = load_response("azure", "metrics_batch_interval_missing_count")
    intervals = recorded.body["values"][0]["value"][0]["timeseries"][0]["data"]
    assert len(intervals) == 2
    assert "count" in intervals[0]
    assert "count" not in intervals[1]
    assert "total" in intervals[1]  # the interval is malformed, not simply empty


def test_the_logs_fake_replays_an_instance_name_collapsed_row() -> None:
    response = raw_response_from_recorded(
        load_response("azure", "logs_logical_disk_instance_name_collapsed")
    )
    port = FakeMetricsPort(logs_responses=[response])

    result = run(
        port.query_logical_disk_free_space(
            workspace_id="9c8b7a65-4321-4321-4321-0123456789ab",
            resource_id="/subscriptions/x/.../prod-sql-01",
            start_time="2026-06-30T17:00:00Z",
            end_time="2026-07-31T17:00:00Z",
        )
    )

    rows = result.body["tables"][0]["rows"]
    instance_name_index = 4  # column order: TimeGenerated, Computer, ObjectName, CounterName, InstanceName
    assert all(row[instance_name_index] == "_Total" for row in rows)
    assert len(rows) >= 2, "at least two collapsed rows, ruling out a first-row-only check"


def test_the_instance_name_absent_fixture_carries_an_empty_string_not_total() -> None:
    recorded = load_response("azure", "logs_logical_disk_instance_name_absent")
    rows = recorded.body["tables"][0]["rows"]
    assert rows[0][4] == ""


def test_the_dns_unreachable_and_reachable_location_sets_are_disjoint() -> None:
    """A DNS resolution failure (Req 24.2) never produces an HTTP envelope, so this
    case is not a `tests/fixtures/azure/` recording -- it is these two plain constants
    in `fakes.azure_ports`, which a test scripts as a `DnsResolutionError` (unreachable)
    or an ordinary successful call (reachable)."""
    assert "norwayeast" in DNS_UNREACHABLE_LOCATIONS
    assert "southeastasia" in DNS_REACHABLE_LOCATIONS
    assert set(DNS_UNREACHABLE_LOCATIONS).isdisjoint(DNS_REACHABLE_LOCATIONS)


# --------------------------------------------------------------------------- #
# InMemoryObjectStore — conditional-put semantics (Req 34.9)
# --------------------------------------------------------------------------- #


def test_the_in_memory_store_satisfies_the_object_store_protocol() -> None:
    assert isinstance(InMemoryObjectStore(), ObjectStore)


def test_put_bytes_writes_unconditionally_and_overwrites() -> None:
    store = InMemoryObjectStore()
    key = f"{ACTOR}/snapshots/run_1/raw/000001-southeastasia.json.gz"

    run(store.put_bytes(key, b"first", content_type="application/gzip"))
    run(store.put_bytes(key, b"second", content_type="application/gzip"))

    stored = store.get(key)
    assert isinstance(stored, StoredObject)
    assert stored.body == b"second"
    assert stored.content_type == "application/gzip"


def test_a_conditional_put_writes_and_reports_true_when_the_key_is_absent() -> None:
    store = InMemoryObjectStore()
    key = f"{ACTOR}/snapshots/run_1/snapshot.json"

    written = run(store.put_bytes_if_absent(key, b'{"snapshot_id":"a"}'))

    assert written is True
    assert key in store
    assert store.get(key).body == b'{"snapshot_id":"a"}'


def test_a_second_conditional_put_at_the_same_key_reports_false_and_leaves_bytes_untouched() -> None:
    """Req 34.9's whole point: the existing bytes are left unchanged and no second
    object is written."""
    store = InMemoryObjectStore()
    key = f"{ACTOR}/snapshots/run_1/snapshot.json"

    first = run(store.put_bytes_if_absent(key, b'{"snapshot_id":"first"}'))
    second = run(store.put_bytes_if_absent(key, b'{"snapshot_id":"second"}'))

    assert first is True
    assert second is False
    assert store.get(key).body == b'{"snapshot_id":"first"}'
    assert len(store) == 1


def test_conditional_puts_at_different_keys_both_succeed() -> None:
    store = InMemoryObjectStore()

    a = run(store.put_bytes_if_absent("a", b"1"))
    b = run(store.put_bytes_if_absent("b", b"2"))

    assert a is True and b is True
    assert store.keys() == ("a", "b")


def test_concurrent_conditional_puts_at_one_key_produce_exactly_one_writer() -> None:
    """A property this fake must hold for `archive.py`'s write-once guarantee to mean
    anything under concurrency: of N racing conditional puts at the same key, exactly
    one reports True."""
    store = InMemoryObjectStore()
    key = "one-key"

    async def race() -> list[bool]:
        return await asyncio.gather(
            *(store.put_bytes_if_absent(key, f"writer-{i}".encode()) for i in range(16))
        )

    results = run(race())

    assert sum(results) == 1
    assert results.count(False) == 15


def test_get_json_round_trips_a_decimal_never_a_float() -> None:
    store = InMemoryObjectStore()
    run(store.put_bytes("k", b'{"value": 12.48}'))

    parsed = run(store.get_json("k"))

    assert parsed["value"] == Decimal("12.48")
    assert isinstance(parsed["value"], Decimal)


def test_get_json_raises_object_not_found_for_a_missing_key() -> None:
    store = InMemoryObjectStore()

    with pytest.raises(ObjectNotFoundError) as caught:
        run(store.get_json("absent"))

    assert caught.value.key == "absent"


def test_get_json_rejects_a_stored_document_that_is_not_a_json_object() -> None:
    store = InMemoryObjectStore()
    run(store.put_bytes("k", b"[1, 2, 3]"))

    with pytest.raises(ObjectStoreError, match="not an object"):
        run(store.get_json("k"))


def test_tags_and_content_type_are_recorded_and_retrievable() -> None:
    store = InMemoryObjectStore()
    run(
        store.put_bytes(
            "k", b"body", content_type="application/gzip", tags={"owner-actor-id": ACTOR}
        )
    )

    stored = store.get("k")
    assert stored.content_type == "application/gzip"
    assert stored.tags == {"owner-actor-id": ACTOR}


def test_calls_are_recorded_in_order_with_the_operation_and_outcome() -> None:
    store = InMemoryObjectStore()
    run(store.put_bytes("a", b"1"))
    run(store.put_bytes_if_absent("b", b"2"))
    run(store.put_bytes_if_absent("b", b"3"))

    assert store.calls == [
        {"op": "put_bytes", "key": "a", "conditional": False, "wrote": True},
        {"op": "put_bytes_if_absent", "key": "b", "conditional": True, "wrote": True},
        {"op": "put_bytes_if_absent", "key": "b", "conditional": True, "wrote": False},
    ]


def test_a_store_constructed_with_seed_objects_treats_them_as_already_present() -> None:
    store = InMemoryObjectStore(objects={"seeded": b"already here"})

    written = run(store.put_bytes_if_absent("seeded", b"new"))

    assert written is False
    assert store.get("seeded").body == b"already here"
