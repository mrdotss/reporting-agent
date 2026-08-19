"""`timeseries_chart` over a **collected** snapshot (Req 35.11, 16.14).

The block existed, was offered in the wizard palette, shipped in a starter template, and
could not draw a chart on any real run: it reads per-day statistics, and `collect/` wrote
`day_buckets[].statistics` empty on every snapshot it ever produced. Every test that
exercised it built its snapshot with `snapshot_factory`, which fills that array — so the
whole compile, render and verify stack was green over a shape the collector never emitted.

These tests close that loop. Nothing here constructs a snapshot: the fixture drives the
production assembly over the Azure fakes, and the assertions read what came out of it.
"""

from __future__ import annotations

import json
from typing import Any, Final

import pytest

# Imported first: it performs the `os.environ` bootstrap `reporting_agent.main` reads at
# import, so nothing under `reporting_agent` may be imported above it.
from negatives import Negative
from pipeline_harness import definition, df, report_objects, types_of

TWO_VMS: Final[tuple[str, ...]] = ("prod-web-01", "prod-sql-01")

# Three local days, so the chart has an axis rather than a point.
PERIOD: Final[dict[str, str]] = {"start": "2026-07-01", "end": "2026-07-03"}

WITH_TIMESERIES: Final[dict[str, Any]] = definition(
    blocks=[
        df.block("res", "resource_table", {"columns": [df.CPU_AVG]}),
        df.block("trend", "timeseries_chart", {"metrics": [df.CPU_AVG]}),
    ]
)


@pytest.fixture(scope="module")
def run() -> Negative:
    harness = Negative(
        resources=TWO_VMS, definition=WITH_TIMESERIES, days=3, period=PERIOD
    )
    harness.run()
    return harness


def snapshot(harness: Negative) -> dict[str, Any]:
    key = next(
        key for key in harness.pipeline.store.keys() if key.endswith("snapshot.json")
    )
    stored = harness.pipeline.store.get(key)
    assert stored is not None
    return json.loads(stored.body.decode("utf-8"))


# --------------------------------------------------------------------------- #
# The snapshot carries the dimension
# --------------------------------------------------------------------------- #


def test_the_collected_snapshot_carries_per_day_statistics(run) -> None:
    """The gap this closes, asserted at the artifact rather than at the fold."""
    resources = snapshot(run)["resources"]
    assert len(resources) == len(TWO_VMS)

    for resource in resources:
        buckets = resource["day_buckets"]
        assert len(buckets) == 3, buckets
        assert all(bucket["statistics"] for bucket in buckets), resource["resource_id"]


def test_every_day_bucket_keeps_its_geometry(run) -> None:
    """The statistics are attached to the window's own day geometry, not derived from what
    happened to be measured — so `slot_count` still records the partial edge day Req 25.11
    asks for, and a day with no value would still be present."""
    for resource in snapshot(run)["resources"]:
        days = [bucket["local_day"] for bucket in resource["day_buckets"]]
        assert days == ["2026-07-01", "2026-07-02", "2026-07-03"]
        assert all(bucket["slot_count"] == 24 for bucket in resource["day_buckets"])


def test_a_day_carries_avg_min_and_max_and_no_percentile(run) -> None:
    for resource in snapshot(run)["resources"]:
        for bucket in resource["day_buckets"]:
            statistics = {entry["statistic"] for entry in bucket["statistics"]}
            assert statistics == {"avg", "min", "max"}, statistics


def test_the_days_differ_from_each_other_and_from_the_window(run) -> None:
    """A day's value is its own. If the fold were emitting the window's average under each
    date the chart would be a flat line and every assertion above would still pass."""
    for resource in snapshot(run)["resources"]:
        per_day = [
            next(
                entry["value"]
                for entry in bucket["statistics"]
                if entry["metric"] == "Percentage CPU" and entry["statistic"] == "avg"
            )
            for bucket in resource["day_buckets"]
        ]
        assert len(set(per_day)) == len(per_day), per_day

        window = next(
            entry["value"]
            for entry in resource["statistics"]
            if entry["metric"] == "Percentage CPU" and entry["statistic"] == "avg"
        )
        assert window not in per_day or len(set(per_day)) > 1


# --------------------------------------------------------------------------- #
# And the block draws a chart from it
# --------------------------------------------------------------------------- #


def test_the_timeseries_block_emits_a_chart_rather_than_a_notice(run) -> None:
    """The whole point. Before the fold this block compiled to a notice row on every real
    run, and the chart verification gates had never seen a timeseries chart at all."""
    assert run.pipeline.outcome.verification is not None
    assert run.pipeline.outcome.verification["status"] == "pass", (
        run.pipeline.outcome.verification["findings"]
    )
    assert run.pipeline.outcome.verification["counts"]["charts_checked"] == 1
    assert types_of(run.events).count("report_file") == 2


def test_the_chart_is_verified_by_both_of_its_gates(run) -> None:
    """Req 30.5 — the companion table and the data hash, over a chart the collector's own
    data produced rather than a fixture's."""
    counts = run.pipeline.outcome.verification["counts"]  # type: ignore[index]

    assert counts["chart_hashes_matched"] == 1
    assert counts["charts_checked"] == 1


def test_the_plotted_figures_trace_to_the_day_buckets(run) -> None:
    """Every point addresses a `day_buckets` position by `snapshot_path`, which is the
    claim the design makes when it justifies re-running the foundation's local-day
    property. An address into a bucket with no statistics could not resolve."""
    key = next(key for key in report_objects(run.pipeline.store) if key.endswith("ledger.json"))
    stored = run.pipeline.store.get(key)
    assert stored is not None
    ledger = json.loads(stored.body.decode("utf-8"))

    plotted = [
        entry
        for path, entry in ledger["entries"].items()
        if path.startswith("trend:")
    ]
    assert plotted, sorted(ledger["entries"])
    for entry in plotted:
        assert "day_buckets" in entry["snapshot_path"], entry["snapshot_path"]
        assert entry["formatted"]
