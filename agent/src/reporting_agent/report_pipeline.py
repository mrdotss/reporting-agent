"""collect → compile → render → verify → upload, in that order and no other.

The foundation's `collect/pipeline.py` produces a snapshot and stops. This module drives the
four phases that turn a snapshot into a delivered report, and the ordering it enforces is the
product:

    collecting → compiling → rendering → verifying → upload

**The upload is last, and it is last on purpose.** Artifacts are written only after the
verification returns `pass`, so there is no window — not one instruction wide — in which a
`report_file` event could name an object sitting beside a failure. A pipeline that uploaded
first and deleted on failure would have that window, and it would be widest exactly when the
process is about to die.

## Three refusals that happen before any Azure call

Both are ordering decisions with a cost measured in minutes of somebody else's money.

**The theme is asserted at claim** (Req 8.9). A pinned version naming a preset whose theme is
missing from the image, or whose theme no longer declares the `Figure` character style, fails
as `RENDER_FAILED` *before* inventory — rather than after a four-minute collection, at the
first paragraph the renderer tries to style.

**The pinned definition is validated at claim** (Req 2.8). A definition the compiler cannot
compile is `TEMPLATE_INVALID` before a single metric is requested.

**The union scope is gated after inventory and before any snapshot write** (Req 3.9, 32.3),
by `collect/pipeline.py`'s own `assert_scope_not_empty`. The reasoning bears restating
because it is the single most likely way this product could ship a confidently wrong
artifact: an expired secret or an over-narrow role yields zero resources → zero figures →
zero *unverifiable* figures → a clean pass on every other gate → a fully verified, empty,
worthless report.

## Partial coverage is raised last

`run_collection` no longer raises `PartialCoverageError` — this module does, after the
document is uploaded (Req 41.4). A run with recorded gaps is a **complete** run whose gaps
are on its snapshot; raising at the collection boundary would abandon the document phases
over a non-terminal condition and turn a delivered report into no report at all.

## Every step is opened and closed through the tracker

Including on the failing path. A phase that ends by raising still gets its `tool` `end`
before `done` (Req 14.14), which is what keeps `progress.id` referencing an open step and
stops the timeline showing a spinner that never resolves.
"""

from __future__ import annotations

import io
import logging
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Final

from reporting_agent.artifacts import (
    ArtifactRef,
    ast_to_plain,
    write_report_artifacts,
    write_verification_result,
)
from reporting_agent.collect.pipeline import (
    CollectionOutcome,
    CollectionSink,
    RunPlan,
    StepEvents,
    resolve_run_plan,
    run_collection,
)
from reporting_agent.errors import (
    PartialCoverageError,
    RenderFailedError,
    VerificationFailedError,
)
from reporting_agent.events import (
    PROGRESS_UNIT_BLOCKS,
    TOOL_COMPILE_FIGURES,
    TOOL_RENDER_DOCUMENT,
    TOOL_UPLOAD_ARTIFACT,
    TOOL_VERIFY_DOCUMENT,
)
from reporting_agent.progress import ProgressReporter
from reporting_agent.providers.base import PlainData
from reporting_agent.storage.base import ObjectStore

__all__ = [
    "PHASE_COMPILING",
    "PHASE_RENDERING",
    "PHASE_VERIFYING",
    "ReportOutcome",
    "run_generate_report",
]

logger = logging.getLogger(__name__)

PHASE_COMPILING: Final[str] = "compiling"
PHASE_RENDERING: Final[str] = "rendering"
PHASE_VERIFYING: Final[str] = "verifying"

type Event = dict[str, Any]


class ReportOutcome:
    """Where a completed report deposits what the router's terminal callback needs.

    The same shape and the same reasoning as `CollectionSink`: an async generator cannot
    both yield events and return a value, and yielding the outcome as a final pseudo-event
    would put a non-event in a stream every consumer validates against `EVENT_TYPES`.
    """

    __slots__ = ("artifacts", "collection", "verification")

    def __init__(self) -> None:
        self.collection: CollectionOutcome | None = None
        self.verification: Mapping[str, Any] | None = None
        self.artifacts: tuple[ArtifactRef, ...] = ()


async def run_generate_report(
    *,
    payload: Mapping[str, PlainData],
    context: Mapping[str, PlainData],
    steps: StepEvents,
    artifact_bucket: str,
    aws_region: str | None = None,
    progress: ProgressReporter | None = None,
    outcome: ReportOutcome | None = None,
    prose: Any | None = None,
    prose_model_id: str = "",
    now: Callable[[], datetime] = lambda: datetime.now(UTC),
    **collection_kwargs: Any,
) -> AsyncIterator[Event]:
    """Run one `generate_report` invocation end to end.

    **A payload carrying no pinned definition is a snapshot-only run**, and it is delegated
    to `collect/pipeline.py`'s wrapper unchanged. That shape is still legal — the state
    machine keeps `collecting → completed` for it — and the foundation's tests describe it,
    so this module recognises it rather than redefining it.

    Raises rather than emitting a terminal `error` of its own (Req 18.8): `main.py`'s router
    owns the translation from an `AgentError` to one `error` plus `done`, so there is exactly
    one place in the process where an exception becomes a terminal stream.
    """
    definition = payload.get("definition")
    if not isinstance(definition, Mapping):
        from reporting_agent.collect.pipeline import (
            run_generate_report as run_snapshot_only,
        )

        async for event in run_snapshot_only(
            payload=payload,
            context=context,
            steps=steps,
            artifact_bucket=artifact_bucket,
            aws_region=aws_region,
            progress=progress,
            now=now,
            **collection_kwargs,
        ):
            yield event
        return

    sink = ReportOutcome() if outcome is None else outcome

    # --- before any Azure call ------------------------------------------------------
    plan = resolve_run_plan(payload, context)
    _assert_compilable(definition)
    _assert_theme_present(definition)

    # --- collecting -------------------------------------------------------------------
    collection = CollectionSink()
    async for event in run_collection(
        payload=payload,
        context=context,
        steps=steps,
        artifact_bucket=artifact_bucket,
        aws_region=aws_region,
        progress=progress,
        now=now,
        sink=collection,
        **collection_kwargs,
    ):
        yield event
    sink.collection = collection.require()

    store = collection_kwargs.get("object_store") or _s3_store(artifact_bucket, aws_region)

    async for event in _document_phases(
        prose=prose if prose is not None else _prose_provider(prose_model_id, aws_region),
        definition=definition,
        plan=plan,
        collected=sink.collection,
        steps=steps,
        progress=progress,
        store=store,
        artifact_bucket=artifact_bucket,
        sink=sink,
        now=now,
    ):
        yield event

    # Req 41.4 — last, after the document exists and its `report_file` events are out.
    if sink.collection.partial:
        raise PartialCoverageError(
            f"this run completed with {sink.collection.gap_count} recorded collection_log "
            f"{'entry' if sink.collection.gap_count == 1 else 'entries'}: the report is "
            f"complete and the gaps are recorded on its snapshot rather than zero-filled."
        )


# --------------------------------------------------------------------------- #
# The pre-collection refusals
# --------------------------------------------------------------------------- #


def _assert_compilable(definition: Mapping[str, PlainData]) -> None:
    """Req 2.8 — `TEMPLATE_INVALID` before a metric is requested.

    The pinned version was validated when it was saved, so failing here means the two
    validators have drifted. That is worth failing loudly and early rather than compiling
    two thirds of a document and stopping.
    """
    from reporting_agent.compile.definition import assert_valid_pinned_definition

    assert_valid_pinned_definition(definition)


def _assert_theme_present(definition: Mapping[str, PlainData]) -> None:
    """Req 8.9 — the theme the pinned version names is in the image and usable.

    Checked at claim rather than at the first styled paragraph. The failure is identical
    either way; what differs is whether the customer's subscription was queried for four
    minutes first.
    """
    from reporting_agent.compile.blocks.base import DesignSettings
    from reporting_agent.render.themes import assert_theme_available

    preset = DesignSettings.from_plain(definition.get("design")).preset
    try:
        assert_theme_available(preset)
    except RenderFailedError:
        raise
    except Exception as exc:
        raise RenderFailedError(
            f"the theme document for preset {preset!r} could not be read before "
            f"collection started ({type(exc).__name__}); failing here rather than after "
            f"a full collection"
        ) from exc


# --------------------------------------------------------------------------- #
# The four document phases
# --------------------------------------------------------------------------- #


async def _document_phases(
    *,
    prose: Any | None,
    definition: Mapping[str, PlainData],
    plan: RunPlan,
    collected: CollectionOutcome,
    steps: StepEvents,
    progress: ProgressReporter | None,
    store: ObjectStore,
    artifact_bucket: str,
    sink: ReportOutcome,
    now: Callable[[], datetime],
) -> AsyncIterator[Event]:
    from reporting_agent.compile.blocks import compile_document
    from reporting_agent.compile.blocks.base import DesignSettings
    from reporting_agent.compile.snapshot_view import build_snapshot_view
    from reporting_agent.render.docx import render_document
    from reporting_agent.render.pdf import convert_to_pdf

    design = DesignSettings.from_plain(definition.get("design"))
    view = build_snapshot_view(collected.document)
    block_count = _block_count(definition)

    # --- compiling ------------------------------------------------------------------
    await _report(progress, PHASE_COMPILING, current=0, total=block_count, label="Compiling")
    compile_step = steps.start(
        TOOL_COMPILE_FIGURES, label="Compiling", status="Compiling figures"
    )
    yield compile_step
    # No `try`/`finally` around the phase bodies, and that is deliberate rather than an
    # omission. `main.run_invocation` closes every step this generator left open in its own
    # `finally`, before `done` (Req 14.14) — so a step is closed on the raising path either
    # way, and yielding from a `finally` while an exception unwinds an async generator is
    # the one shape that turns a clean failure into a `RuntimeError`.
    compiled = compile_document(definition, view=view, prose=prose)
    if block_count:
        yield steps.progress(
            compile_step["id"],
            done=block_count,
            total=block_count,
            unit=PROGRESS_UNIT_BLOCKS,
        )
    yield steps.end(compile_step["id"])

    for event in _chart_events(compiled):
        yield event
    for event in _delta_events(compiled):
        yield event

    # --- rendering ------------------------------------------------------------------
    await _report(
        progress, PHASE_RENDERING, current=0, total=block_count, label="Rendering"
    )
    render_step = steps.start(
        TOOL_RENDER_DOCUMENT, label="Rendering", status="Emitting the document"
    )
    yield render_step
    rendered = render_document(compiled.document, ledger=compiled.ledger, design=design)
    converted = convert_to_pdf(rendered.docx_bytes)
    yield steps.end(render_step["id"])

    # --- verifying ------------------------------------------------------------------
    await _report(progress, PHASE_VERIFYING, label="Verifying")
    verify_step = steps.start(
        TOOL_VERIFY_DOCUMENT, label="Verifying", status="Checking every figure"
    )
    yield verify_step
    result = await _verify(
        definition=definition,
        plan=plan,
        collected=collected,
        compiled=compiled,
        rendered=rendered,
        converted=converted,
        store=store,
        now=now,
    )
    yield steps.end(verify_step["id"])

    sink.verification = result

    # Written on both paths (Req 25.10): the panel presents every finding for a run whose
    # document was withheld, and it can only do that from a result the app can read.
    await write_verification_result(
        store, result, actor_id=plan.actor_id, run_id=plan.run_id
    )
    yield _verification_event(result)

    if result["status"] != "pass":
        raise VerificationFailedError(
            f"the verification recorded "
            f"{result['counts'].get('blocking_findings_observed', 0)} blocking finding(s); "
            f"no document is delivered for this run"
        )

    # --- upload, after the pass and never before -------------------------------------
    upload_step = steps.start(
        TOOL_UPLOAD_ARTIFACT, label="Storing", status="Writing the report"
    )
    yield upload_step
    sink.artifacts = await write_report_artifacts(
        store,
        actor_id=plan.actor_id,
        run_id=plan.run_id,
        bucket=artifact_bucket,
        docx_bytes=rendered.docx_bytes,
        pdf_bytes=converted.pdf_bytes,
        ledger_bytes=compiled.ledger.serialize(),
        ast=ast_to_plain(compiled.document),
        prose=_prose_bundle(compiled),
        chart_sidecars=dict(rendered.chart_sidecars),
    )
    yield steps.end(upload_step["id"])

    for artifact in sink.artifacts:
        yield {
            "type": "report_file",
            "key": artifact.key,
            "bucket": artifact.bucket,
            "kind": artifact.kind,
            "bytes": artifact.bytes,
        }


async def _verify(
    *,
    definition: Mapping[str, PlainData],
    plan: RunPlan,
    collected: CollectionOutcome,
    compiled: Any,
    rendered: Any,
    converted: Any,
    store: ObjectStore,
    now: Callable[[], datetime],
) -> Mapping[str, Any]:
    """Assemble the verifier's inputs and run every gate.

    The archived objects are **fetched here and handed in** (Req 31.2). Replay is forbidden
    from fetching its own inputs, so the fetch is the caller's — and this is the caller. A
    fetch that fails leaves `archived` short, which replay reports as an inability to
    replay rather than as a mismatch.
    """
    from docx import Document as open_docx

    from reporting_agent.catalog.loader import load_catalog
    from reporting_agent.compile.snapshot_view import build_snapshot_view
    from reporting_agent.verify.replay import plan_from_snapshot
    from reporting_agent.verify.verifier import VerifyInputs, verify

    archived = await _fetch_archive(store, actor_id=plan.actor_id, run_id=plan.run_id)
    replay_plan = None
    try:
        replay_plan = plan_from_snapshot(
            collected.document, catalog=load_catalog(), objects_named=len(archived)
        )
    except Exception as exc:
        # An unreconstructable plan is an inability to replay, not a mismatch — the same
        # reading `verify/replay.py` gives a missing object. Every other gate still runs.
        logger.warning(
            "the replay plan could not be reconstructed from this run's snapshot (%s); "
            "replay is recorded as not possible and every other gate still runs",
            type(exc).__name__,
        )

    pdf_text, pdf_pages = _pdf_text(converted.pdf_bytes)

    return await verify(
        VerifyInputs(
            attempt_id=f"{plan.run_id}-1",
            run_id=plan.run_id,
            template_version_id=str(
                (definition.get("identity") or {}).get("version_id")  # type: ignore[union-attr]
                or plan.run_id
            ),
            docx_bytes=rendered.docx_bytes,
            pdf_bytes=converted.pdf_bytes,
            ledger=compiled.ledger,
            ast=compiled.document,
            document=open_docx(io.BytesIO(rendered.docx_bytes)),
            snapshot=collected.document,
            view=build_snapshot_view(collected.document),
            definition=definition,
            pdf_text=pdf_text,
            pdf_pages=pdf_pages,
            pdf_sha256=converted.pdf_sha256,
            snapshot_sha256=collected.snapshot_id,
            chart_sidecars=dict(rendered.chart_sidecars),
            archived=archived,
            replay_plan=replay_plan,
            requery=None,
            drift_seed=collected.snapshot_id,
            catalog_scales=None,
        )
    )


async def _fetch_archive(
    store: ObjectStore, *, actor_id: str, run_id: str
) -> tuple[tuple[int, bytes], ...]:
    """Every archived raw response, in sequence order.

    Ordered by key, which **is** sequence order: `collect/archive.py` embeds a zero-padded
    per-run counter as the key's first component precisely so this ordering needs no second
    index. An object that cannot be read is omitted, and replay reports the shortfall as an
    incomplete archive rather than a mismatch.
    """
    prefix = f"{actor_id}/snapshots/{run_id}/raw/"
    try:
        keys = await store.list_keys(prefix)
    except Exception as exc:
        logger.warning(
            "the raw archive at %s could not be listed (%s); replay will report that it "
            "was not possible",
            prefix,
            type(exc).__name__,
        )
        return ()

    found: list[tuple[int, bytes]] = []
    for ordinal, key in enumerate(keys):
        try:
            found.append((ordinal, await store.get_bytes(key)))
        except Exception as exc:
            logger.warning(
                "archived object %s could not be read (%s); the archive is incomplete",
                key,
                type(exc).__name__,
            )
    return tuple(found)


def _pdf_text(pdf_bytes: bytes) -> tuple[str, int]:
    """The converted PDF's normalized text and page count, read from bytes in memory."""
    from reporting_agent.verify.tokens import normalize_pdf_text

    try:
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(pdf_bytes))
        pages = [page.extract_text() or "" for page in reader.pages]
    except Exception as exc:
        # Not a finding and not a crash: zero extractable text with a non-empty ledger is
        # `PDF_CONVERSION_FAILED`, which `verify/pdf.py` raises. Reporting no text here is
        # what routes it there rather than to a stack trace.
        logger.warning(
            "the converted PDF could not be read for the fidelity gate (%s)",
            type(exc).__name__,
        )
        return ("", 0)
    return (normalize_pdf_text(pages), len(pages))


# --------------------------------------------------------------------------- #
# Events
# --------------------------------------------------------------------------- #


def _verification_event(result: Mapping[str, Any]) -> Event:
    """Exactly one per invocation, carrying **the values written to the store** (Req 42.2).

    The same object, not a re-derivation: a client that received no event must render the
    identical panel from the stored artifact, and two constructions of "the same" payload is
    how those two panels come to differ.
    """
    return {"type": "verification", **result}


def _chart_events(compiled: Any) -> list[Event]:
    """One `chart` per chart node (Req 42.4).

    `encoding` comes from the node's own declaration rather than from the series count. The
    compiler decides whether the series are peers or an ordered quantity; inferring it here
    from how many there happen to be would assert an order the data does not carry.
    """
    from reporting_agent.render.charts import chart_data_hash, plotted_series
    from reporting_agent.verify.charts import chart_nodes

    events: list[Event] = []
    for node in chart_nodes(compiled.document):
        events.append(
            {
                "type": "chart",
                "chart_id": node.anchor_id,
                "chart_type": node.chart_type,
                "encoding": node.encoding,
                "title": node.title,
                "unit": node.unit,
                "data_hash": chart_data_hash(node),
                "series": [
                    {
                        "key": series.key,
                        "label": series.label,
                        "points": [
                            {
                                "x": point.x,
                                "y": str(point.y.value),
                                "ledger_path": str(point.y.path),
                            }
                            for point in series.points
                        ],
                    }
                    for series in plotted_series(node)
                ],
            }
        )
    return events


def _delta_events(compiled: Any) -> list[Event]:
    """Model-authored prose only (Req 42.5).

    Every `Text` node under a block whose compiler deferred for prose. No figure is carried:
    a `delta` naming a number would put a second copy of a figure in the stream, and the one
    in the document is the one the verifier checked.
    """
    from reporting_agent.compile.ast import Text, child_nodes

    events: list[Event] = []
    for block_id, nodes in sorted(compiled.nodes_by_block.items()):
        if not block_id.startswith("summary") and "summary" not in block_id:
            continue
        for node in nodes:
            for text in _texts(node, Text, child_nodes):
                events.append({"type": "delta", "block_id": block_id, "text": text})
    return events


def _texts(node: object, text_type: type, children: Callable[[object], Sequence[object]]):
    if isinstance(node, text_type):
        yield node.text  # type: ignore[attr-defined]
        return
    for child in children(node):
        yield from _texts(child, text_type, children)


def _prose_bundle(compiled: Any) -> dict[str, Any]:
    """`prose.json` — the model's text, keyed by block, persisted for recompilation.

    Req 19.6's whole point: a compile is a pure function of (template version, snapshot,
    prose bundle). Re-asking the model on a re-verification would make the recompiled
    ledger depend on a model's determinism, which it does not have.
    """
    return {
        "schema_version": 1,
        "blocks": {
            event["block_id"]: event["text"] for event in _delta_events(compiled)
        },
    }


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def _block_count(definition: Mapping[str, PlainData]) -> int:
    """Blocks including a row's children, matching what the compiler emits."""
    blocks = definition.get("blocks")
    if not isinstance(blocks, Sequence):
        return 0
    total = 0
    for block in blocks:
        if not isinstance(block, Mapping):
            continue
        total += 1
        columns = block.get("columns")
        if isinstance(columns, Sequence):
            total += sum(len(column) for column in columns if isinstance(column, Sequence))
    return total


async def _report(
    reporter: ProgressReporter | None,
    phase: str,
    *,
    current: int | None = None,
    total: int | None = None,
    label: str | None = None,
) -> None:
    """Fire one phase callback, fire-and-forget (Req 41.10).

    Never raises and never fails the run. A phase transition that did not land is the
    Reaper's problem: it will fail the row on the deadline of whichever phase the row still
    holds, which is a false `TIMEOUT` on a healthy run — bad, but far better than a run that
    died because it could not announce itself.
    """
    if reporter is None:
        return
    await reporter.report(phase, current=current, total=total, label=label)


def _prose_provider(model_id: str, region: str | None) -> Any | None:
    """The executive summary's model, or `None`.

    Built through `narrate/`, which is the only package permitted to reach a Bedrock client
    — so this module names a model without importing one.
    """
    from reporting_agent.narrate.summary import prose_generator

    return prose_generator(model_id, region=region)


def _s3_store(bucket: str, region: str | None) -> ObjectStore:
    from reporting_agent.storage.s3 import S3ObjectStore

    return S3ObjectStore(bucket, region_name=region)
