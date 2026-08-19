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

All three are ordering decisions with a cost measured in minutes of somebody else's money.

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

## The run asks for exactly what the template selected

`requested_metric_union` narrows the collection to the pinned version's metric selection
(Req 5.4) — expanded from its derived statistics, widened by every top-N ranking metric, and
keyed against the union of the template default and every block override. The collector then
intersects that with what the provider says it can collect, so a run requests neither a
metric Azure does not emit nor one the template did not ask for. A template selecting one CPU
figure does not pay for every disk and network counter the resource type emits.

## Partial coverage is raised last

`run_collection` no longer raises `PartialCoverageError` — this module does, after the
document is uploaded (Req 41.4). A run with recorded gaps is a **complete** run whose gaps
are on its snapshot; raising at the collection boundary would abandon the document phases
over a non-terminal condition and turn a delivered report into no report at all.

## Every step is opened and closed through the tracker

Including on the failing path. A phase that ends by raising still gets its `tool` `end`
before `done` (Req 14.14), which is what keeps `progress.id` referencing an open step and
stops the timeline showing a spinner that never resolves.

## Every blocking phase body runs in a worker thread

`compile_document`, `render_document`, `convert_to_pdf` and the verifier's gate body are
synchronous and each takes **minutes** at a few hundred resources. Called directly they
would block the event loop for that whole stretch, and two things this spec requires
happen on that loop:

* the **heartbeat ticker** `main.invoke` merges around this generator, which is what keeps
  consecutive events no more than 30 seconds apart while the status is `compiling`,
  `rendering` or `verifying` (Req 42.11) — a blocked loop emits no keep-alive, and the
  relay's 120-second inactivity window then elapses on a run that is working perfectly;
* the **fire-and-forget phase-transition callbacks** `ProgressReporter.report` schedules
  with `asyncio.create_task` (Req 41.4). A task that never gets a loop turn is cancelled
  by `aclose()` behind the terminal callback, so the `compiling`, `rendering` and
  `verifying` transitions would never reach the Progress_Endpoint at all — leaving the row
  to jump `collecting → completed` and bypassing the `verifying → completed`
  precondition that requires a stored passing verification.

So each blocking body is awaited through `asyncio.to_thread`, the same idiom `azure/`,
`storage/s3.py` and `collect/` already use for exactly this reason. It is not an
optimization: the two requirements above are unsatisfiable without it.
"""

from __future__ import annotations

import asyncio
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
from reporting_agent.catalog.loader import LoadedCatalog, load_catalog
from reporting_agent.collect.pipeline import (
    CollectionOutcome,
    CollectionSink,
    RunPlan,
    StepEvents,
    resolve_run_plan,
    run_collection,
)
from reporting_agent.errors import (
    AgentError,
    CompileFailedError,
    PartialCoverageError,
    RenderFailedError,
    ReplayMismatchError,
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
from reporting_agent.verify.findings import (
    FINDING_REPLAY_HASH_MISMATCH,
    SEVERITY_BLOCKING,
)

__all__ = [
    "PHASE_COMPILING",
    "PHASE_RENDERING",
    "PHASE_VERIFYING",
    "ReportOutcome",
    "requested_metric_union",
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
    #
    # Req 5.4 — the catalog is loaded here rather than left to `run_collection`, because the
    # metric narrowing needs it and loading it twice for one run would be two chances to
    # read two different catalogs.
    catalog = collection_kwargs.pop("catalog", None) or load_catalog()
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
        catalog=catalog,
        metric_selection=requested_metric_union(definition, catalog),
        **collection_kwargs,
    ):
        yield event
    sink.collection = collection.require()

    store = collection_kwargs.get("object_store") or _s3_store(artifact_bucket, aws_region)

    async for event in _document_phases(
        prose=prose if prose is not None else _prose_provider(prose_model_id, aws_region),
        definition=definition,
        template_version_id=pinned_version_id(payload, definition),
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
# What the run asks Azure for (Req 5.4)
# --------------------------------------------------------------------------- #


def requested_metric_union(
    definition: Mapping[str, PlainData], catalog: LoadedCatalog
) -> dict[str, tuple[str, ...]]:
    """Req 5.4 — per resource type, exactly the platform metrics the pinned version selected.

    Three things are folded in, and each is the answer to a way this could be wrong:

    * **The selection itself.** A `metric` item names a platform metric directly. A
      `derived` item names a statistic that Azure does not emit — `memory_used_pct` is
      computed from `Available Memory Bytes` and a SKU capacity — so it is expanded to the
      catalog's declared `kind == "metric"` sources. Requesting the derived id itself would
      request a metric that does not exist; requesting only what the items literally say
      would leave every derived figure with no input.
    * **Every top-N ranking metric**, folded by :func:`union_scope`. A ranking is resolved
      against the snapshot, so a snapshot that does not carry the metric it ranks by cannot
      resolve it — and the block would render its empty-scope row on a run that collected
      perfectly.
    * **The union of the template default and every block override**, so the resource types
      the metric map is keyed against are the ones the run actually collects.

    Unknown resource types and unknown item shapes are passed through as-is rather than
    rejected: `_assert_compilable` has already run, so anything unrecognized here is either
    a resource type the provider will drop for having no capability entry, or a name the
    intersection in `collect/pipeline.py` will drop for the same reason. This function
    narrows; it is not a second validator.

    **The returned keys are the catalog's spelling** for every type the catalog declares
    (Req 3.12). Without that normalization one type comes back under two keys — the
    definition's `metrics` spelling and its scope's, which `union_scope` uses when folding in
    a top-N ranking metric — and a caller reading the map by key would see the selection
    under one and the ranking metric under the other. Types the catalog does not declare keep
    their own spelling; there is no authority to normalize them against.
    """
    from reporting_agent.compile.scope import scope_rules_from_plain, union_scope

    selected: dict[str, set[str]] = {}
    raw_metrics = definition.get("metrics")
    if isinstance(raw_metrics, Mapping):
        for resource_type, items in raw_metrics.items():
            if not isinstance(resource_type, str):
                continue
            if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
                continue
            names = selected.setdefault(resource_type, set())
            for item in items:
                if not isinstance(item, Mapping):
                    continue
                metric = item.get("metric")
                if isinstance(metric, str) and metric:
                    names.add(metric)
                    continue
                derived = item.get("derived")
                if isinstance(derived, str) and derived:
                    names.update(_derived_source_metrics(catalog, resource_type, derived))

    scopes = [scope_rules_from_plain(definition.get("scope"), at="scope")]
    blocks = definition.get("blocks")
    if isinstance(blocks, Sequence) and not isinstance(blocks, (str, bytes)):
        for ordinal, block in enumerate(blocks):
            if not isinstance(block, Mapping):
                continue
            override = block.get("scope_override")
            if override is None:
                continue
            scopes.append(
                scope_rules_from_plain(override, at=f"blocks.{ordinal}.scope_override")
            )

    requested = union_scope(
        scopes, metrics_by_resource_type=selected
    ).metrics_by_resource_type

    canonical: dict[str, set[str]] = {}
    for resource_type, names in requested.items():
        entry = catalog.for_resource_type(resource_type)
        key = entry.resource_type if entry is not None else resource_type
        canonical.setdefault(key, set()).update(names)
    return {key: tuple(sorted(names)) for key, names in sorted(canonical.items())}


def _derived_source_metrics(
    catalog: LoadedCatalog, resource_type: str, statistic_id: str
) -> tuple[str, ...]:
    """The platform metric names one derived statistic's formula consumes.

    `kind == "sku_capability"` sources are excluded on purpose: a SKU capability comes from
    `azure-mgmt-compute`'s SKU listing, not from the metrics endpoint, so naming one here
    would put a value in a metrics request that the metrics endpoint has never heard of.

    Resolved through :meth:`LoadedCatalog.for_resource_type` rather than by scanning
    `catalog.resource_types` here, because that method **folds case** and a hand-rolled scan
    does not. Azure resource type names are case-insensitive and Resource Graph lowercases
    `type` in its response body, so a definition whose `metrics` key is
    `microsoft.compute/virtualmachines` — the spelling any inventory-seeded wizard
    affordance will produce — would find nothing against a catalog declaring
    `Microsoft.Compute/virtualMachines`. Failing closed to `()` here is the worst available
    outcome: the derived statistic's source metric is silently dropped from the request and
    the figure it feeds has no input, with nothing anywhere naming a spelling mismatch.
    """
    entry = catalog.for_resource_type(resource_type)
    if entry is None:
        return ()
    for derived in entry.derived:
        if derived.statistic_id != statistic_id:
            continue
        return tuple(source.name for source in derived.sources if source.kind == "metric")
    return ()


# --------------------------------------------------------------------------- #
# The four document phases
# --------------------------------------------------------------------------- #


async def _document_phases(
    *,
    prose: Any | None,
    definition: Mapping[str, PlainData],
    template_version_id: str,
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
    from reporting_agent.render.html import emit_html
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
    compiled = await asyncio.to_thread(
        compile_document, definition, view=view, prose=prose
    )
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
    rendered = await asyncio.to_thread(
        render_document, compiled.document, ledger=compiled.ledger, design=design
    )
    converted = await asyncio.to_thread(convert_to_pdf, rendered.docx_bytes)
    yield steps.end(render_step["id"])

    # --- verifying ------------------------------------------------------------------
    await _report(progress, PHASE_VERIFYING, label="Verifying")
    verify_step = steps.start(
        TOOL_VERIFY_DOCUMENT, label="Verifying", status="Checking every figure"
    )
    yield verify_step
    result = await _verify(
        definition=definition,
        template_version_id=template_version_id,
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
    artifact_key, _ = await write_verification_result(
        store, result, actor_id=plan.actor_id, run_id=plan.run_id
    )
    # Then recorded with the app, as a **pointer** to what was just written — so the
    # artifact exists before anything names it, on both paths.
    if progress is not None:
        await progress.report_verification(
            attempt_id=str(result["attempt_id"]),
            status=str(result["status"]),
            figure_count=int(result["figure_count"]),
            snapshot_sha256=str(result["snapshot_sha256"]),
            docx_sha256=str(result["docx_sha256"]),
            pdf_sha256=str(result["pdf_sha256"]),
            artifact_key=artifact_key,
        )
    yield _verification_event(result)

    if result["status"] != "pass":
        raise _terminal_for(result)

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
        # Req 14.1 — the AST the `.docx` was emitted from, emitted again through the
        # `Html_Emitter`. Both artifacts describe one compilation, so the in-app paper
        # rendering of this report and the delivered `.pdf` cannot describe two.
        html=emit_html(compiled.document).html,
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


def _terminal_for(result: Mapping[str, Any]) -> AgentError:
    """The terminal code a failing verification reports.

    `REPLAY_MISMATCH` when a replay mismatch is the **only** kind of blocking finding, and
    `VERIFICATION_FAILED` otherwise. The two codes make different claims and the glossary is
    explicit about the difference: a replay mismatch says the snapshot is not reproducible
    from its own archived inputs, while the document may transcribe it perfectly. So a run
    whose document *also* disagrees with its snapshot has failed at transcription as well,
    and the narrower code would hide that — the broader one is the true statement.

    Both are terminal, both withhold every artifact, and the verification result carries every
    finding either way; what the code decides is which failure a reader is sent to first.
    """
    blocking = {
        str(finding["type"])
        for finding in result["findings"]
        if finding.get("severity") == SEVERITY_BLOCKING
    }
    count = result["counts"].get("blocking_findings_observed", 0)

    if blocking == {FINDING_REPLAY_HASH_MISMATCH}:
        return ReplayMismatchError(
            f"re-running the aggregation over this run's archived raw responses produced a "
            f"snapshot digest differing from the one recorded; the document is not delivered "
            f"({count} blocking finding(s))"
        )

    return VerificationFailedError(
        f"the verification recorded {count} blocking finding(s); no document is delivered "
        f"for this run"
    )


async def _verify(
    *,
    definition: Mapping[str, PlainData],
    template_version_id: str,
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
    from reporting_agent.verify.coverage import table_scope_counts
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

    # Req 27.10's "that block's resolved scope". Without this the anchored pass has no
    # expectation to compare a row count against, and `table_rows_absent` — one of the
    # sixteen blocking types — can never fire on a real run however empty a table is.
    view = build_snapshot_view(collected.document)
    scope_counts = table_scope_counts(
        definition,
        view=view,
        identities=(anchor.anchor_id for anchor in compiled.ledger.anchors().values()),
    )

    return await verify(
        VerifyInputs(
            attempt_id=f"{plan.run_id}-1",
            run_id=plan.run_id,
            template_version_id=template_version_id,
            docx_bytes=rendered.docx_bytes,
            pdf_bytes=converted.pdf_bytes,
            ledger=compiled.ledger,
            ast=compiled.document,
            document=open_docx(io.BytesIO(rendered.docx_bytes)),
            snapshot=collected.document,
            view=view,
            definition=definition,
            pdf_text=pdf_text,
            pdf_pages=pdf_pages,
            pdf_sha256=converted.pdf_sha256,
            snapshot_sha256=collected.snapshot_id,
            chart_sidecars=dict(rendered.chart_sidecars),
            scope_counts=scope_counts,
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
    """An `S3ObjectStore` over the run's artifact bucket.

    The twin of `collect.pipeline._s3_store`, and imported locally for the same reason:
    every test injects `object_store`, so this seam is the one line of the document phases
    that only production executes. `tests/test_object_store_factories.py` calls it for
    exactly that reason — the keyword is `region`, boto3's is `region_name`, and nothing
    else in the suite had ever run this line to notice the difference.
    """
    from reporting_agent.storage.s3 import S3ObjectStore

    return S3ObjectStore(bucket, region=region)


# --------------------------------------------------------------------------- #
# `verify_report` — re-verify a stored report, fetching no fresh anything
# --------------------------------------------------------------------------- #


async def run_verify_report(
    *,
    payload: Mapping[str, PlainData],
    context: Mapping[str, PlainData],
    steps: StepEvents,
    artifact_bucket: str,
    aws_region: str | None = None,
    progress: ProgressReporter | None = None,
    object_store: ObjectStore | None = None,
) -> AsyncIterator[Event]:
    """Re-verify one stored report (Req 36.4).

    Reads the stored `.docx`, `.pdf`, ledger, prose and the snapshot the run names.
    Recompiles the **pinned** version — not the template's current one, which is the whole
    point: editing a template must never change what an existing report is checked against
    — and asserts the recompiled ledger is byte-identical to the stored one.

    An absent, unreadable or digest-mismatched stored input sets **this attempt's** status
    to fail naming that input. It reconstructs nothing and modifies no earlier row: the
    original verification is a record of what was true then, and a later attempt that
    rewrote it would destroy the only evidence of the discrepancy it found.
    """
    from reporting_agent.artifacts import report_prefix
    from reporting_agent.compile.blocks import compile_document
    from reporting_agent.compile.snapshot_view import build_snapshot_view

    del progress

    actor_id = str(context.get("actor_id") or "")
    run_id = str(context.get("run_id") or "")
    attempt_id = str(payload.get("attempt_id") or f"{run_id}-reverify")
    definition = payload.get("definition")
    if not isinstance(definition, Mapping):
        raise VerificationFailedError(
            "verify_report needs the pinned template version's definition; re-verifying "
            "against the template's current version would check the report against a "
            "document it was never produced from"
        )

    store = object_store or _s3_store(artifact_bucket, aws_region)
    step = steps.start(
        TOOL_VERIFY_DOCUMENT, label="Re-verifying", status="Reading the stored report"
    )
    yield step

    prefix = report_prefix(actor_id, run_id)
    docx_bytes = await _require_object(store, f"{prefix}report.docx")
    pdf_bytes = await _require_object(store, f"{prefix}report.pdf")
    stored_ledger = await _require_object(store, f"{prefix}ledger.json")
    snapshot = await store.get_json(_snapshot_key(actor_id, run_id))
    prose = await _optional_json(store, f"{prefix}prose.json")

    view = build_snapshot_view(snapshot)
    recompiled = compile_document(
        definition, view=view, prose=_StoredProse(prose), catalog_scales=None
    )
    if recompiled.ledger.serialize() != stored_ledger:
        raise VerificationFailedError(
            "the ledger recompiled from the pinned version and the stored snapshot is not "
            "byte-identical to the stored ledger; the two describe different documents and "
            "no re-verification of this report is meaningful"
        )

    yield steps.end(step["id"])

    result = await _verify_stored(
        attempt_id=attempt_id,
        run_id=run_id,
        definition=definition,
        template_version_id=pinned_version_id(payload, definition),
        snapshot=snapshot,
        view=view,
        compiled=recompiled,
        docx_bytes=docx_bytes,
        pdf_bytes=pdf_bytes,
        store=store,
        actor_id=actor_id,
    )
    await write_verification_result(store, result, actor_id=actor_id, run_id=run_id)
    yield _verification_event(result)


class _StoredProse:
    """The persisted prose bundle, replayed into a recompile as a `ProseProvider`.

    Req 19.6 — a compile is a pure function of (template version, snapshot, prose bundle).
    Asking the model again here would make a re-verification's byte-identical ledger depend
    on a model producing the same words twice, which is not a property models have.
    """

    __slots__ = ("_blocks",)

    def __init__(self, bundle: Mapping[str, Any] | None) -> None:
        blocks = (bundle or {}).get("blocks")
        self._blocks: Mapping[str, str] = blocks if isinstance(blocks, Mapping) else {}

    def narrate(self, request: Any) -> str:
        return self._blocks.get(request.block_id, "")


async def _verify_stored(
    *,
    attempt_id: str,
    run_id: str,
    definition: Mapping[str, PlainData],
    template_version_id: str,
    snapshot: Mapping[str, Any],
    view: Any,
    compiled: Any,
    docx_bytes: bytes,
    pdf_bytes: bytes,
    store: ObjectStore,
    actor_id: str,
) -> Mapping[str, Any]:
    from docx import Document as open_docx

    from reporting_agent.catalog.loader import load_catalog
    from reporting_agent.render.pdf import digest_of
    from reporting_agent.verify.replay import plan_from_snapshot
    from reporting_agent.verify.verifier import VerifyInputs, verify

    archived = await _fetch_archive(store, actor_id=actor_id, run_id=run_id)
    replay_plan = None
    try:
        replay_plan = plan_from_snapshot(
            snapshot, catalog=load_catalog(), objects_named=len(archived)
        )
    except Exception as exc:
        logger.warning(
            "the replay plan could not be reconstructed on re-verification (%s)",
            type(exc).__name__,
        )

    pdf_text, pdf_pages = _pdf_text(pdf_bytes)
    return await verify(
        VerifyInputs(
            attempt_id=attempt_id,
            run_id=run_id,
            template_version_id=template_version_id,
            docx_bytes=docx_bytes,
            pdf_bytes=pdf_bytes,
            ledger=compiled.ledger,
            ast=compiled.document,
            document=open_docx(io.BytesIO(docx_bytes)),
            snapshot=snapshot,
            view=view,
            definition=definition,
            pdf_text=pdf_text,
            pdf_pages=pdf_pages,
            pdf_sha256=digest_of(pdf_bytes),
            snapshot_sha256=str(snapshot.get("snapshot_id") or ""),
            archived=archived,
            replay_plan=replay_plan,
            requery=None,
            drift_seed=str(snapshot.get("snapshot_id") or ""),
        )
    )


def payload_version_id(definition: Mapping[str, PlainData]) -> str | None:
    identity = definition.get("identity")
    if isinstance(identity, Mapping):
        value = identity.get("version_id")
        return str(value) if isinstance(value, str) else None
    return None


def pinned_version_id(
    payload: Mapping[str, PlainData], definition: Mapping[str, PlainData]
) -> str:
    """The `report_template_versions.id` a verification result must carry.

    ## Why this is not derived from the definition

    `report_verifications.template_version_id` is a **foreign key**. The only value that
    satisfies it is the row id the app pinned at enqueue, and the app sends exactly that,
    at the top level of the invoke payload — `template_version_id`, beside `definition`
    (`app/lib/aws/agentcore.ts`, and Req 9.6).

    This used to read `definition.identity.version_id` instead and fall back to the
    **run id**. A wizard-authored definition carries no `version_id` under `identity`
    (that object holds the name, description and report title), so the fallback was not
    a fallback — it was the only branch, on every real run. And a run id is not a
    template version id, so every completed verification failed to insert with a
    Postgres 23503, the callback answered 500, and the run could not reach `completed`
    because Req 41.1 requires the stored `pass` row it had just failed to store. A
    document that passed every gate was withheld on the strength of a foreign key.

    The definition-derived id is kept as a fallback for an **inline** definition, which
    `render_preview` supplies with no pinned row behind it. When neither is available
    this raises rather than inventing one: an unusable value here does not degrade the
    verification, it destroys the record of it, and failing at input assembly is both
    earlier and honest.
    """
    pinned = payload.get("template_version_id")
    if isinstance(pinned, str) and pinned.strip():
        return pinned

    inline = payload_version_id(definition)
    if inline:
        return inline

    raise CompileFailedError(
        "this run carries no `template_version_id`: the invoke payload named none and "
        "the definition's identity declares none. A verification result must carry the "
        "pinned version's row id, which is the only value its foreign key accepts."
    )


# --------------------------------------------------------------------------- #
# `render_preview` — a draft, rendered for layout, gating nothing
# --------------------------------------------------------------------------- #


async def run_render_preview(
    *,
    payload: Mapping[str, PlainData],
    context: Mapping[str, PlainData],
    steps: StepEvents,
    artifact_bucket: str,
    aws_region: str | None = None,
    object_store: ObjectStore | None = None,
) -> AsyncIterator[Event]:
    """Compile and render an **inline** definition against a completed run's snapshot.

    Emits **no** `report_file` (Req 14.6), and the key it writes — `previews/<previewId>/`
    — is one the report download predicate cannot serve, so "a preview is not a report" is
    a property of the key space rather than a rule the download route has to remember.

    The verifier runs and its status is reported as **information**. It does not gate: a
    draft template must be previewable for layout reasons before its figures verify, and a
    wizard that refused to show a page until every number was provable would be unusable at
    exactly the moment a consultant needs to see the page.
    """
    from reporting_agent.artifacts import (
        HTML_CONTENT_TYPE,
        preview_html_key,
        preview_key,
    )
    from reporting_agent.compile.blocks import compile_document
    from reporting_agent.compile.blocks.base import DesignSettings
    from reporting_agent.compile.snapshot_view import build_snapshot_view
    from reporting_agent.render.docx import render_document
    from reporting_agent.render.html import emit_html
    from reporting_agent.render.pdf import convert_to_pdf
    from reporting_agent.storage.base import owner_tags

    actor_id = str(context.get("actor_id") or "")
    preview_id = str(payload.get("preview_id") or "")
    definition = payload.get("definition")
    if not isinstance(definition, Mapping):
        raise RenderFailedError(
            "render_preview carries its definition inline; a preview of a stored version "
            "id would be a preview of something already saved"
        )

    _assert_compilable(definition)
    _assert_theme_present(definition)

    store = object_store or _s3_store(artifact_bucket, aws_region)
    snapshot = await store.get_json(
        _snapshot_key(actor_id, str(payload.get("snapshot_run_id") or ""))
    )

    step = steps.start(
        TOOL_RENDER_DOCUMENT, label="Preview", status="Rendering a draft page"
    )
    yield step
    compiled = compile_document(definition, view=build_snapshot_view(snapshot))
    # `preview=True` is what puts the per-page notice in against each theme's
    # `PreviewNotice` style, so the artifact says what it is even after it leaves the app.
    rendered = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(definition.get("design")),
        preview=True,
    )
    converted = convert_to_pdf(rendered.docx_bytes)
    tags = owner_tags(actor_id)

    await store.put_bytes(
        preview_key(actor_id, preview_id),
        converted.pdf_bytes,
        content_type="application/pdf",
        tags=tags,
    )

    # Req 14.1 — the paper canvas emits "from the same document AST the Docx_Renderer
    # emits from ... through the Html_Emitter", and holds no layout definition of its
    # own. `compiled.document` is that AST, by identity: the object two lines above
    # produced the `.docx`. Emitting here rather than letting the app walk the tree is
    # what keeps the number of layout definitions at two.
    await store.put_bytes(
        preview_html_key(actor_id, preview_id),
        emit_html(compiled.document).html.encode("utf-8"),
        content_type=HTML_CONTENT_TYPE,
        tags=tags,
    )

    yield steps.end(step["id"])


async def _require_object(store: ObjectStore, key: str) -> bytes:
    """One stored input, or a failed attempt naming it.

    Named, because "the re-verification failed" is not actionable and "the stored `.pdf`
    for this run is gone" is.
    """
    try:
        return await store.get_bytes(key)
    except Exception as exc:
        raise VerificationFailedError(
            f"the stored input at {key} could not be read ({type(exc).__name__}); this "
            f"attempt fails naming it, reconstructs nothing, and leaves every earlier "
            f"verification of this run unmodified"
        ) from exc


async def _optional_json(store: ObjectStore, key: str) -> Mapping[str, Any] | None:
    try:
        return await store.get_json(key)
    except Exception:
        return None


def _snapshot_key(actor_id: str, run_id: str) -> str:
    from reporting_agent.collect.snapshot import snapshot_key

    return snapshot_key(actor_id, run_id)
