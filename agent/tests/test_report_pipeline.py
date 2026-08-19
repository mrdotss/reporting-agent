"""The report pipeline, end to end (Req 41, 42).

Every scenario drives the **real** path: the production provider assembly over the scripted
Azure fakes, a real compile, a real `python-docx` render, a real LibreOffice conversion and
the real verifier. Nothing about the document phases is stubbed, because the thing under test
is an *ordering* — collect, compile, render, verify, upload, and the upload last — and an
ordering asserted over stubs is an ordering between stubs.

The two that carry the module:

* :func:`test_the_artifacts_are_written_only_after_the_verification_passes` — the delivery
  gate, asserted as an absence: on a failing verification no report object exists at all, so
  there is no window in which a `report_file` could name one.
* :func:`test_the_theme_is_asserted_before_a_single_azure_call` — the refusal that costs
  nothing when it fires and four minutes of somebody's money when it does not.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, Final

import pytest

# Imported first: the harness performs the `os.environ` bootstrap that `reporting_agent.main`
# reads at import time, so nothing under `reporting_agent` may be imported above it.
from pipeline_harness import (
    ACTOR_ID,
    BUCKET,
    CPU,
    MEMORY,
    RESOURCE_TYPE,
    RUN_ID,
    WATCHDOG_S,
    Pipeline,
    StubProse,
    definition,
    df,
    empty_batch,
    load_catalog,
    report_objects,
    run_generate_report,
    types_of,
)
from reporting_agent.errors import (
    PartialCoverageError,
    RenderFailedError,
    VerificationFailedError,
)


@pytest.fixture(scope="module")
def completed():
    """One full run, shared — a real LibreOffice conversion is the expensive part."""
    pipeline = Pipeline()
    events, error = pipeline.run()
    return pipeline, events, error


def test_a_full_run_reaches_a_passing_verification_and_two_report_files(completed) -> None:
    """The whole path, and the partial-coverage deferral with it (Req 41.4).

    This run carries gaps — the fake answers two of the catalog's metrics — so it ends by
    raising the **non-terminal** `PartialCoverageError`. That is the designed outcome and
    the interesting half of it is the ordering: the raise comes *after* both `report_file`
    events, because a run with recorded gaps is a complete run whose gaps are on its
    snapshot. Raising at the collection boundary would abandon the document phases over a
    non-terminal condition and turn a delivered report into no report at all.
    """
    pipeline, events, error = completed

    assert isinstance(error, PartialCoverageError)
    assert error.terminal is False
    assert pipeline.outcome.verification is not None
    assert pipeline.outcome.verification["status"] == "pass", (
        pipeline.outcome.verification["findings"]
    )
    assert types_of(events).count("report_file") == 2
    assert {ref.kind for ref in pipeline.outcome.artifacts} == {"docx", "pdf"}


def test_the_phases_run_in_order_and_every_step_is_closed(completed) -> None:
    """Req 41.1, 14.14. The `tool` stream is the timeline a consultant watches, and a step
    left open is a spinner that never resolves."""
    _, events, _ = completed
    tools = [
        (event["name"], event["phase"]) for event in events if event["type"] == "tool"
    ]

    started = [name for name, phase in tools if phase == "start"]
    ended = [name for name, phase in tools if phase == "end"]

    assert started == [
        "collect_inventory",
        "collect_metrics",
        "compile_figures",
        "render_document",
        "verify_document",
        "upload_artifact",
    ]
    assert ended == started


def test_snapshot_ready_precedes_the_verification_and_done_is_last(completed) -> None:
    """Req 25.9 — the ordering guarantee, at the source."""
    _, events, _ = completed
    kinds = types_of(events)

    assert kinds.index("snapshot_ready") < kinds.index("verification")
    assert kinds.index("verification") < kinds.index("report_file")
    assert "done" not in kinds, "the router emits `done`; the pipeline never does"


def test_the_verification_event_carries_the_values_written_to_the_store(completed) -> None:
    """Req 42.2 — a client that received no event renders the identical panel from the
    stored result, which is only true if the two are one object rather than two
    constructions of "the same" payload."""
    pipeline, events, _ = completed
    event = next(e for e in events if e["type"] == "verification")

    key = next(k for k in pipeline.store.keys() if "verification-" in k)
    stored = pipeline.store.get(key)
    assert stored is not None

    import json

    written = json.loads(stored.body)
    assert written["status"] == event["status"]
    assert written["figure_count"] == event["figure_count"]
    assert written["counts"] == event["counts"]
    assert written["ledger_sha256"] == event["ledger_sha256"]


def test_every_declared_artifact_is_written_under_the_actor_prefix(completed) -> None:
    """Req 43.1 — the actor id is the **first** segment, so download authorization stays an
    exact first-segment comparison rather than a prefix test."""
    pipeline, _, _ = completed
    keys = report_objects(pipeline.store)

    for name in (
        "report.docx",
        "report.pdf",
        "ledger.json",
        "ast.json",
        "prose.json",
        "document.html",
    ):
        assert f"{ACTOR_ID}/reports/{RUN_ID}/{name}" in keys, name
    assert any("verification-" in key for key in keys)
    assert all(key.split("/")[0] == ACTOR_ID for key in keys)
    assert all(key.split("/")[1] == "reports" for key in keys)


def test_the_stored_ledger_is_the_one_the_verification_digests(completed) -> None:
    """Req 17.6 — serialized once.

    The digest the verification records is `FigureLedger.digest()`, taken over the ledger's
    RFC 8785 canonical form; the bytes written are `FigureLedger.serialize()`, the same
    form. Re-deriving the digest from the artifact is what proves they are one
    serialization rather than two that happen to agree today — a later re-verification
    reads these bytes and asserts the recompiled ledger is byte-identical to them.
    """
    import hashlib

    pipeline, _, _ = completed
    stored = pipeline.store.get(f"{ACTOR_ID}/reports/{RUN_ID}/ledger.json")

    assert stored is not None and stored.body
    assert (
        hashlib.sha256(stored.body).hexdigest()
        == pipeline.outcome.verification["ledger_sha256"]  # type: ignore[index]
    )


def test_the_stored_html_is_the_emitter_over_the_same_compilation(completed) -> None:
    """Req 14.1 — one AST, two emissions, and **no third layout definition**.

    The app has `ast.json`, so it could walk the tree and produce its own markup — and
    then a heading's markup would be decided in two languages by two people who never
    compared them. The `Html_Emitter` emits once, in the pipeline, over the same
    `compiled.document` the `.docx` came from, and the app injects the result.

    Asserted by figure count rather than by markup: the emitter's own suite covers what
    it produces, and what this file is placed to catch is the two artifacts describing
    **different compilations** — an HTML rendering emitted from a re-compile, or from a
    tree assembled after the ledger was closed, would show a consultant a page that is
    not the page that was delivered.
    """
    pipeline, _, _ = completed

    stored = pipeline.store.get(f"{ACTOR_ID}/reports/{RUN_ID}/document.html")
    assert stored is not None and stored.body

    html = stored.body.decode("utf-8")

    # Every figure the ledger holds appears in the rendering, by its formatted string,
    # read from the **stored ledger artifact** rather than from an attribute this test
    # hopes exists. A loop over an empty list passes and proves nothing, which is the
    # one failure mode a test like this actually has.
    import json

    ledger = pipeline.store.get(f"{ACTOR_ID}/reports/{RUN_ID}/ledger.json")
    assert ledger is not None

    document = json.loads(ledger.body.decode("utf-8"))
    formatted = sorted(
        {
            entry["formatted"]
            for entry in document["entries"].values()
            if isinstance(entry.get("formatted"), str)
        }
    )

    assert formatted, "the fixture run produced no figures, so this asserts nothing"

    for value in formatted:
        assert value in html, value


def test_the_stored_html_carries_no_page_number(completed) -> None:
    """Req 14.3 — no page number, no page count, no page-position indicator.

    The emitter determines no pagination, and a wrong page count is a promise the
    document breaks. Checked on the **artifact** rather than only in the emitter's own
    suite, because this is the byte string the browser will inject.
    """
    from reporting_agent.render.html import PAGINATION_FORBIDDEN_ATTRIBUTES

    pipeline, _, _ = completed
    stored = pipeline.store.get(f"{ACTOR_ID}/reports/{RUN_ID}/document.html")
    assert stored is not None

    html = stored.body.decode("utf-8")

    for attribute in PAGINATION_FORBIDDEN_ATTRIBUTES:
        assert attribute not in html, attribute


# --------------------------------------------------------------------------- #
# The delivery gate
# --------------------------------------------------------------------------- #


def test_the_artifacts_are_written_only_after_the_verification_passes() -> None:
    """Req 25.1, 25.2 — asserted as an **absence**.

    A definition whose executive summary carries invented prose fails the masking pass. The
    interesting assertion is not that the run failed: it is that **no report object exists
    at all** afterwards. A pipeline that uploaded first and deleted on failure would leave
    this list non-empty for a moment, and that moment is widest exactly when the process is
    about to die.
    """
    pipeline = Pipeline(prose=StubProse("Headroom grew 37.4% against last month."))
    pipeline.definition = definition(
        blocks=[
            df.block("res", "resource_table", {"columns": [df.CPU_AVG]}),
            df.block("summary", "executive_summary", {}),
        ]
    )

    events, error = pipeline.run()

    assert isinstance(error, VerificationFailedError)
    assert error.terminal is True
    assert pipeline.outcome.verification is not None
    assert pipeline.outcome.verification["status"] == "fail"
    assert "report_file" not in types_of(events)
    assert not [
        key
        for key in report_objects(pipeline.store)
        if not key.rsplit("/", 1)[-1].startswith("verification-")
    ]


def test_a_failing_verification_still_writes_its_result(completed) -> None:
    """Req 25.10 — the panel presents every finding for a run whose document was withheld,
    and it can only do that from a result the app can read."""
    pipeline = Pipeline(prose=StubProse("Utilization rose 12% this month."))
    pipeline.definition = definition(
        blocks=[
            df.block("res", "resource_table", {"columns": [df.CPU_AVG]}),
            df.block("summary", "executive_summary", {}),
        ]
    )

    _, error = pipeline.run()

    assert isinstance(error, VerificationFailedError)
    assert [key for key in report_objects(pipeline.store) if "verification-" in key]
    assert completed is not None


# --------------------------------------------------------------------------- #
# The refusals that happen before any Azure call
# --------------------------------------------------------------------------- #


def test_the_theme_is_asserted_before_a_single_azure_call() -> None:
    """Req 8.9. The failure is identical whenever it happens; what differs is whether the
    customer's subscription was queried for four minutes first."""
    pipeline = Pipeline()
    pipeline.definition = definition(design={"preset": "corporate"})
    missing = Path("does-not-exist")

    import reporting_agent.render.themes as themes

    original = themes.theme_directory
    themes.theme_directory = lambda: missing  # type: ignore[assignment]
    try:
        events, error = pipeline.run()
    finally:
        themes.theme_directory = original  # type: ignore[assignment]

    assert isinstance(error, RenderFailedError)
    assert events == [], "no step opened, so no Azure call was made"
    assert pipeline.store.keys() == (), "and nothing was written"


def test_an_uncompilable_pinned_definition_fails_before_collection() -> None:
    """Req 2.8 — the two validators drifted, and the run ends before a metric is
    requested rather than two thirds of the way through a document."""
    from reporting_agent.errors import TemplateInvalidError

    pipeline = Pipeline()
    pipeline.definition = {**definition(), "blocks": [{"id": "x", "type": "nope"}]}

    events, error = pipeline.run()

    assert isinstance(error, TemplateInvalidError)
    assert events == []
    assert pipeline.store.keys() == ()


# --------------------------------------------------------------------------- #
# What the run asks Azure for (Req 5.4)
# --------------------------------------------------------------------------- #


def test_the_run_requests_only_the_metrics_the_pinned_version_selected() -> None:
    """Req 5.4 — exactly the pinned version's selection, and nothing outside it.

    Asserted at the port, because this is a claim about the request rather than about the
    snapshot: a pipeline that asked for every metric the type emits and then compiled only
    the selected ones would produce an identical document, an identical ledger and an
    identical verification — and would have spent the customer's quota on figures nobody
    asked for. The fake's canned response carries both CPU and memory whatever is asked, so
    a narrowing that did not happen is invisible anywhere else.
    """
    pipeline = Pipeline()
    pipeline.definition = definition(metrics={RESOURCE_TYPE: [df.CPU_AVG, df.CPU_MAX]})

    _, error = pipeline.run()

    assert isinstance(error, PartialCoverageError)
    requested = {
        name for call in pipeline.provider_metrics.batch_calls for name in call["metric_names"]
    }
    assert requested == {CPU}, requested
    assert MEMORY not in requested, "memory was not selected, so it must not be requested"


def test_a_derived_selection_requests_the_source_metrics_azure_actually_emits() -> None:
    """Req 5.4 with Req 32.1. `memory_used_pct` is not a metric Azure emits — it is computed
    from `Available Memory Bytes` and a SKU capacity — so a selection naming it has to reach
    the port as its declared metric source. Requesting the derived id itself would ask for a
    name the metrics endpoint has never heard of; requesting nothing would leave every
    derived figure with no input.
    """
    pipeline = Pipeline()
    pipeline.definition = definition(
        metrics={RESOURCE_TYPE: [df.CPU_AVG, df.MEMORY_USED_PCT_AVG]}
    )

    pipeline.run()

    requested = {
        name for call in pipeline.provider_metrics.batch_calls for name in call["metric_names"]
    }
    assert requested == {CPU, MEMORY}, requested
    assert "memory_used_pct" not in requested


def test_a_top_n_ranking_metric_is_folded_into_the_request() -> None:
    """A ranking is resolved against the snapshot, so a snapshot missing the metric it ranks
    by cannot resolve it — and the block would render its empty-scope row on a run that
    collected perfectly. The fold happens even though no block config names the metric."""
    from reporting_agent.report_pipeline import requested_metric_union

    union = requested_metric_union(
        definition(
            metrics={RESOURCE_TYPE: [df.CPU_AVG]},
            blocks=[
                df.block(
                    "top",
                    "top_n_table",
                    {"columns": [df.CPU_AVG], "order_by": df.CPU_AVG},
                    scope_override=df.scope(
                        top_n={"count": 5, "metric": MEMORY, "statistic": "avg"}
                    ),
                )
            ],
        ),
        load_catalog(),
    )

    assert set(union[RESOURCE_TYPE]) == {CPU, MEMORY}, union


# --------------------------------------------------------------------------- #
# The narrowing folds case (Req 3.12) — three spellings meet in one request
# --------------------------------------------------------------------------- #
#
# Azure resource type names are case-insensitive and Resource Graph lowercases `type` in
# its response body, so `Microsoft.Compute/virtualMachines` and
# `microsoft.compute/virtualmachines` name one type. Three independent spellings reach the
# request: the definition's `metrics` key, its scope's `resource_types` entry, and the
# catalog's own declaration. Every pair of them is compared somewhere in the narrowing, and
# an exact comparison anywhere fails **closed** — a type with no metrics rather than a
# spelling mismatch, which is precisely the failure `LoadedCatalog.for_resource_type`
# documents itself as existing to prevent.
#
# These are negative tests. The suite passed with the defect present, because a narrowing
# that requests nothing still renders, still verifies and still completes.

LOWER_TYPE: Final[str] = RESOURCE_TYPE.lower()


def test_a_lowercased_metrics_key_still_resolves_a_derived_statistics_sources() -> None:
    """The row Task 12's narrowing broke: a definition whose `metrics` key is Resource
    Graph's lowercase spelling. Before the narrowing it collected every capability metric;
    with an exact-case catalog lookup it collects **none**, and two failures stack — the
    derived statistic's source metric is dropped by `_derived_source_metrics` returning `()`,
    then the intersection empties whatever was left.

    Any Task 13 affordance that seeds `metrics` from observed inventory produces exactly this
    definition, because lowercase is the casing Resource Graph returns.
    """
    from reporting_agent.report_pipeline import requested_metric_union

    union = requested_metric_union(
        definition(
            metrics={LOWER_TYPE: [df.CPU_AVG, df.MEMORY_USED_PCT_AVG]},
            template_scope=df.scope(resource_types=[RESOURCE_TYPE]),
        ),
        load_catalog(),
    )

    requested = {name for names in union.values() for name in names}
    assert MEMORY in requested, (
        "the derived statistic's source metric was dropped: the catalog lookup did not "
        f"fold case. union={union}"
    )
    assert requested == {CPU, MEMORY}, union


def test_requested_metrics_folds_case_across_the_selection_and_the_capability_map() -> None:
    """`_requested_metrics`' own two comparisons, at the point the request is built.

    Driven directly rather than through a run, because the interesting input is a
    *disagreement* between three spellings and a full run only exercises whichever pair the
    fixture happens to spell alike.
    """
    from reporting_agent.collect.pipeline import _requested_metrics

    class Capabilities:
        def capabilities(self) -> dict[str, Any]:
            return {"metrics": {RESOURCE_TYPE: [CPU, MEMORY]}}

    provider = Capabilities()

    # The selection is lowercase, the scope is the catalog's spelling.
    narrowed = _requested_metrics(
        provider,  # type: ignore[arg-type]
        {"resource_types": [RESOURCE_TYPE]},  # type: ignore[typeddict-item]
        {LOWER_TYPE: [CPU]},
    )
    assert narrowed == {RESOURCE_TYPE: [CPU]}, narrowed

    # The scope is lowercase, the selection is the catalog's spelling. The pre-existing
    # `resource_type not in available` comparison is the one that failed here.
    narrowed = _requested_metrics(
        provider,  # type: ignore[arg-type]
        {"resource_types": [LOWER_TYPE]},  # type: ignore[typeddict-item]
        {RESOURCE_TYPE: [CPU]},
    )
    assert narrowed == {RESOURCE_TYPE: [CPU]}, narrowed

    # Both lowercase. The returned key is still the capability map's spelling, so nothing
    # downstream inherits Azure's casing from this function.
    narrowed = _requested_metrics(
        provider,  # type: ignore[arg-type]
        {"resource_types": [LOWER_TYPE]},  # type: ignore[typeddict-item]
        {LOWER_TYPE: [CPU, MEMORY]},
    )
    assert narrowed == {RESOURCE_TYPE: sorted([CPU, MEMORY])}, narrowed


def test_two_case_variant_selection_keys_union_rather_than_overwrite() -> None:
    """One type under two keys is not a contrived input: `union_scope` folds a top-N ranking
    metric into the *scope's* spelling while the selection is keyed by the definition's, so a
    definition mixing the two arrives here with both. Last-one-wins would drop either the
    selection or the ranking metric depending on dict order."""
    from reporting_agent.collect.pipeline import _requested_metrics

    class Capabilities:
        def capabilities(self) -> dict[str, Any]:
            return {"metrics": {RESOURCE_TYPE: [CPU, MEMORY]}}

    narrowed = _requested_metrics(
        Capabilities(),  # type: ignore[arg-type]
        {"resource_types": [RESOURCE_TYPE]},  # type: ignore[typeddict-item]
        {RESOURCE_TYPE: [CPU], LOWER_TYPE: [MEMORY]},
    )

    assert narrowed == {RESOURCE_TYPE: sorted([CPU, MEMORY])}, narrowed


# --------------------------------------------------------------------------- #
# The snapshot-only shape is untouched
# --------------------------------------------------------------------------- #


def test_a_payload_with_no_pinned_definition_is_a_snapshot_only_run() -> None:
    """`collecting → completed` is still a legal run shape, and the foundation's tests
    describe it — so the report pipeline recognises it rather than redefining it."""
    pipeline = Pipeline()
    pipeline.definition = {}

    events: list[dict[str, Any]] = []

    async def go() -> None:
        payload = pipeline.payload()
        payload.pop("definition")
        async for event in run_generate_report(
            payload=payload,
            context=pipeline.context(),
            steps=pipeline.steps,
            artifact_bucket=BUCKET,
            provider=pipeline.provider,
            object_store=pipeline.store,
            catalog=pipeline.catalog,
        ):
            events.append(event)

    # A snapshot-only run with gaps raises the same non-terminal error, from the same
    # place it always did — the foundation's wrapper, untouched.
    with pytest.raises(PartialCoverageError):
        asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))

    assert "snapshot_ready" in types_of(events)
    assert "verification" not in types_of(events)
    assert report_objects(pipeline.store) == []


def test_no_statistics_carries_the_gap_types_through_the_real_pipeline() -> None:
    """Req 33.7, over the production path rather than the assertion in isolation.

    The unit tests call `assert_some_statistic` directly, so they cannot notice the **call
    site** failing to pass the gaps — which is exactly what the original defect was: the
    gaps existed, were recorded, and were never handed to the error that needed them. A
    mutant removing the argument survived every direct test and is killed only here.

    Every metric is refused inside a 200, so the run collects nothing and the
    `collection_log` holds the reason.
    """
    pipeline = Pipeline(batch_responses=[empty_batch()])

    _, error = pipeline.run()

    assert type(error).__name__ == "NoStatisticsError", error
    message = str(error)
    assert "collection_log this run would have carried" in message
    # The classified type, not a bare count — the operator acts on the classification.
    assert "x" in message.split("carried:")[1]
    assert "no gap either" not in message
