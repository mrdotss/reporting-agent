"""Task 1.2 — `run_collection` and the `CollectionOutcome` it reports (Req 41.1, 41.4).

`collect/pipeline.py` now has two entry points over one driver, and the split exists for a
single reason: the report pipeline has compile, render, verify and upload still ahead of it
when collection ends, so it needs the **non-terminal** `PARTIAL_COVERAGE` raise deferred
past all four. `run_collection` therefore records `partial` and raises nothing;
`run_generate_report` drives it and raises at the end, which is where a snapshot-only run
ends anyway.

So the claims worth asserting are the seam's, not the collector's:

* the two entry points yield the **same events, in the same order** — a report pipeline
  built on `run_collection` must produce the stream `tests/test_ordering.py` already pins;
* the outcome **agrees with the artifact**: its `snapshot_id`, resource count and gap list
  are the stored snapshot's and the `snapshot_ready` event's, not a second reading;
* the **only** behavioural difference between the two is the raise;
* a gate still raises from inside `run_collection`, and an abandoned or failed collection
  records **no** outcome rather than a half-true one.

Deliberately not an Azure conversation. What the collector does with a batch response has
its own suites; this file is about which function owns the end of a run. The provider here
is the smallest one the protocol permits — the same approach the gate matrix in
`tests/test_collect_pipeline.py` takes, and for the same reason.

`main` reads its configuration at import (Req 14.12), so the required variables are set
before importing it, the same contract the container satisfies with its environment.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from fakes.object_store import InMemoryObjectStore
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.collect.log import GAP_TYPE_NO_SAMPLES
from reporting_agent.collect.pipeline import (
    FIDELITY_BASELINE,
    FIDELITY_ENHANCED,
    CollectionOutcome,
    CollectionSink,
    run_collection,
    run_generate_report,
)
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.errors import EmptyScopeError, ErrorCode, PartialCoverageError
from reporting_agent.main import StepTracker
from reporting_agent.providers.base import (
    Capabilities,
    CollectRequest,
    CollectResult,
    DiscoverResult,
    GapRecord,
    ResourceRecord,
    ScopeSpec,
    StatValue,
)

Event = dict[str, Any]

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
LOCATION = "southeastasia"
RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"
ACTOR_ID = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID = "run_01HQZX8QW9K7YB4T2C3M5N6P7Q"
SKU_NAME = "Standard_D4s_v5"
CPU = "Percentage CPU"
BUCKET = "rpt-artifacts-test"
WATCHDOG_S = 10.0

CATALOG = load_catalog()


def resource_id(name: str) -> str:
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-prod-sea"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


def payload() -> dict[str, Any]:
    return {
        "command": "generate_report",
        "period": {"start": "2026-07-01", "end": "2026-07-01"},
        "scope": {
            "resource_types": [RESOURCE_TYPE],
            "resource_groups": [],
            "tag_filters": {},
        },
    }


def context() -> dict[str, Any]:
    return {
        "actor_id": ACTOR_ID,
        "run_id": RUN_ID,
        "subscription_id": SUBSCRIPTION,
        "timezone": "Asia/Jakarta",
        "fidelity_tier": FIDELITY_BASELINE,
        "log_analytics_workspace_id": None,
    }


class TinyProvider:
    """One measurable resource per name, with a chosen number of gaps.

    `archive` is threaded through because `raw_archive_complete` is a fact only the
    collector knows and the outcome has to carry (Req 26.12) — a verifier handed an
    archive with a hole in it must be able to tell that from a run that wrote none.
    """

    def __init__(
        self,
        *,
        names: tuple[str, ...] = ("prod-web-01",),
        gaps: int = 0,
        archive: dict[str, Any] | None = None,
    ) -> None:
        self.gaps = gaps
        self.archive = archive
        self.resources = [
            ResourceRecord(
                resource_id=resource_id(name),
                name=name,
                resource_type=RESOURCE_TYPE,
                location=LOCATION,
                resource_group="rg-prod-sea",
                tags={"env": "prod"},
                sku_name=SKU_NAME,
                power_state_raw="PowerState/running",
                power_state="running",
                fidelity_tier=FIDELITY_BASELINE,
            )
            for name in names
        ]

    async def discover(self, scope: ScopeSpec) -> DiscoverResult:
        first = self.resources[0]["resource_id"] if self.resources else ""
        return DiscoverResult(
            resources=list(self.resources),
            gaps=[
                GapRecord(
                    gap_type=GAP_TYPE_NO_SAMPLES,
                    resource_id=first,
                    metric=CPU,
                    message=f"a recorded gap, number {index + 1}",
                )
                for index in range(self.gaps)
            ],
        )

    async def collect(self, request: CollectRequest) -> CollectResult:
        statistics: dict[str, dict[str, dict[str, StatValue]]] = {
            resource["resource_id"]: {
                CPU: {
                    "avg": {
                        "metric": CPU,
                        "statistic": "avg",
                        "value": "15.00",
                        "unit": "percent",
                        "estimator": "exact_count_weighted",
                        "fidelity_tier": FIDELITY_BASELINE,
                        "sample_count": 60,
                    }
                }
            }
            for resource in self.resources
        }
        result = CollectResult(statistics=statistics, gaps=[])
        if self.archive is not None:
            result["raw_archive"] = {  # type: ignore[typeddict-item]
                "complete": bool(self.archive["complete"]),
                "object_count": int(self.archive["object_count"]),
            }
        return result

    def capabilities(self) -> Capabilities:
        return Capabilities(
            resource_types=[RESOURCE_TYPE],
            metrics={RESOURCE_TYPE: [CPU]},
            grains=["PT1H", "PT15M"],
            fidelity_tiers=[FIDELITY_BASELINE, FIDELITY_ENHANCED],
        )


class Harness:
    """One run, drivable through either entry point against the same store and tracker."""

    def __init__(self, **provider_kwargs: Any) -> None:
        self.provider = TinyProvider(**provider_kwargs)
        self.store = InMemoryObjectStore()
        self.steps = StepTracker()
        self.sink = CollectionSink()

    def _drain(self, generator: Any) -> tuple[list[Event], Exception | None]:
        """Drain one entry point under a watchdog, returning its events **and** how it
        ended — the events yielded before an exception are the claim in half of these
        tests, and an `async for` that raises discards them."""
        events: list[Event] = []

        async def go() -> None:
            async for event in generator:
                events.append(event)

        try:
            asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))
        except Exception as exc:
            return events, exc
        return events, None

    def collect(self) -> tuple[list[Event], Exception | None]:
        return self._drain(
            run_collection(
                payload=payload(),
                context=context(),
                steps=self.steps,
                artifact_bucket=BUCKET,
                sink=self.sink,
                provider=self.provider,
                object_store=self.store,
                catalog=CATALOG,
            )
        )

    def generate(self) -> tuple[list[Event], Exception | None]:
        return self._drain(
            run_generate_report(
                payload=payload(),
                context=context(),
                steps=self.steps,
                artifact_bucket=BUCKET,
                provider=self.provider,
                object_store=self.store,
                catalog=CATALOG,
            )
        )

    def stored_snapshot(self) -> dict[str, Any]:
        return asyncio.run(self.store.get_json(snapshot_key(ACTOR_ID, RUN_ID)))


def types_of(events: list[Event]) -> list[str]:
    return [event["type"] for event in events]


def one(events: list[Event], kind: str) -> Event:
    matches = [event for event in events if event["type"] == kind]
    assert len(matches) == 1, f"expected exactly one {kind}, got {types_of(events)}"
    return matches[0]


# --------------------------------------------------------------------------- #
# The two entry points emit one stream (Req 41.1)
# --------------------------------------------------------------------------- #


def test_both_entry_points_yield_the_same_events_in_the_same_order() -> None:
    """Req 41.1 — the report pipeline composes over `run_collection`, so the collecting
    phase's stream has to be the one the snapshot-only run already emits. Asserted as an
    equality between two real runs rather than against a written-down list, so a change to
    the sequence cannot be absorbed by updating a literal in one place."""
    collected, collect_error = Harness().collect()
    generated, generate_error = Harness().generate()

    assert collect_error is None
    assert generate_error is None
    assert types_of(collected) == types_of(generated)
    assert types_of(collected) == [
        "tool",
        "progress",
        "tool",
        "tool",
        "progress",
        "progress",
        "tool",
        "snapshot_ready",
    ]


def test_run_collection_closes_every_step_it_opened() -> None:
    """Req 14.7 — the new entry point drives the same tracker to the same place. A step
    left open here would surface as `main.run_invocation` closing it on the way to `done`,
    which is the backstop rather than the contract."""
    harness = Harness()

    _, error = harness.collect()

    assert error is None
    assert harness.steps.open_ids == ()


# --------------------------------------------------------------------------- #
# The outcome agrees with the artifact (Req 41.1)
# --------------------------------------------------------------------------- #


def test_the_outcome_reports_the_snapshot_that_was_written_and_announced() -> None:
    """The outcome is a reading of the document this run wrote, not a second computation:
    every field is checked against the stored object and the `snapshot_ready` event, which
    is what lets a later phase quote the snapshot id without re-reading S3."""
    harness = Harness(names=("prod-web-01", "prod-web-02"))

    events, error = harness.collect()

    assert error is None
    outcome = harness.sink.require()
    assert isinstance(outcome, CollectionOutcome)
    stored = harness.stored_snapshot()
    ready = one(events, "snapshot_ready")

    assert outcome.snapshot_id == stored["snapshot_id"] == ready["snapshot_id"]
    assert outcome.resource_count == ready["resource_count"] == 2
    assert outcome.document["snapshot_id"] == stored["snapshot_id"]
    assert list(outcome.gaps) == list(ready["gaps"]) == list(stored["gaps"])


def test_a_clean_run_is_not_partial_and_carries_a_replayable_archive() -> None:
    """No gap recorded means `partial` is `False`, which is what keeps the wrapper's raise
    conditional. A provider reporting no archive at all is complete rather than
    incomplete — it wrote nothing to have a hole in."""
    harness = Harness()

    _, error = harness.collect()

    assert error is None
    outcome = harness.sink.require()
    assert outcome.partial is False
    assert outcome.gap_count == 0
    assert outcome.gaps == ()
    assert outcome.raw_archive_complete is True


def test_gaps_make_the_outcome_partial_without_raising() -> None:
    """Req 41.4 — the whole point of the extraction. Three recorded gaps, a written and
    announced snapshot, and **no exception**: the decision about what a gap means belongs
    to whoever owns the end of the run."""
    harness = Harness(gaps=3)

    events, error = harness.collect()

    assert error is None, "a gapped collection is a completed collection here"
    outcome = harness.sink.require()
    assert outcome.partial is True
    assert outcome.gap_count == 3
    assert len(outcome.gaps) == 3
    assert len(one(events, "snapshot_ready")["gaps"]) == 3
    assert len(harness.stored_snapshot()["gaps"]) == 3


def test_an_incomplete_raw_archive_travels_on_the_outcome() -> None:
    """Req 26.12 — replay needs to know the archive has a hole in it, and the marker is
    decided during collection. Carried on the outcome so the verifier reads it from the
    run rather than inferring it from an object count."""
    harness = Harness(archive={"complete": False, "object_count": 2})

    _, error = harness.collect()

    assert error is None
    outcome = harness.sink.require()
    assert outcome.raw_archive_complete is False
    assert harness.stored_snapshot()["raw_archive"]["complete"] is False


# --------------------------------------------------------------------------- #
# The raise is the only difference (Req 29.5, 41.4)
# --------------------------------------------------------------------------- #


def test_the_wrapper_raises_partial_coverage_where_run_collection_records_it() -> None:
    """The same run shape through both entry points: identical events, identical snapshot,
    and exactly one difference — `run_generate_report` ends by raising the non-terminal
    `PartialCoverageError` (Req 29.5) and `run_collection` does not.

    Both are asserted in one test on purpose. "The wrapper raises" and "the collection
    does not" are the two halves of one claim, and splitting them lets a change satisfy
    each separately while breaking the seam."""
    collecting = Harness(gaps=2)
    generating = Harness(gaps=2)

    collected, collect_error = collecting.collect()
    generated, generate_error = generating.generate()

    assert collect_error is None
    assert isinstance(generate_error, PartialCoverageError)
    assert generate_error.terminal is False, "a report with recorded gaps is honest"
    assert generate_error.code is ErrorCode.PARTIAL_COVERAGE
    # The count the wrapper reports is the count the outcome recorded, so the app is told
    # the same number the snapshot carries.
    assert str(collecting.sink.require().gap_count) in generate_error.message
    assert types_of(collected) == types_of(generated)
    assert types_of(generated)[-1] == "snapshot_ready", (
        "the raise comes after the last event, so the stream is unchanged by it"
    )
    assert collecting.stored_snapshot()["snapshot_id"] == (
        generating.stored_snapshot()["snapshot_id"]
    )


# --------------------------------------------------------------------------- #
# No outcome without a completed collection
# --------------------------------------------------------------------------- #


def test_a_gate_still_raises_from_inside_run_collection_and_records_no_outcome() -> None:
    """Req 33.1 — a gate is a fact about whether a usable collection happened at all, so
    there is nothing for a later phase to defer. It raises here as it always has, no
    `snapshot_ready` is emitted, and the sink stays empty rather than describing a
    snapshot that was never written."""
    harness = Harness(names=())

    events, error = harness.collect()

    assert isinstance(error, EmptyScopeError)
    assert error.terminal is True
    assert "snapshot_ready" not in types_of(events)
    assert harness.sink.outcome is None
    with pytest.raises(RuntimeError):
        harness.sink.require()


def test_an_abandoned_collection_records_no_outcome() -> None:
    """The deposit is the driver's last act, after the final event, so a consumer that
    stops early gets no outcome. That is the honest reading — it abandoned the run — and
    `require()` says so loudly rather than handing back a `None` that surfaces minutes
    later as a missing artifact."""
    harness = Harness()

    async def go() -> None:
        async for _ in run_collection(
            payload=payload(),
            context=context(),
            steps=harness.steps,
            artifact_bucket=BUCKET,
            sink=harness.sink,
            provider=harness.provider,
            object_store=harness.store,
            catalog=CATALOG,
        ):
            break

    asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))

    assert harness.sink.outcome is None
    with pytest.raises(RuntimeError):
        harness.sink.require()
