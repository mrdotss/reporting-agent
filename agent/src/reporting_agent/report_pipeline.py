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
from dataclasses import replace
from datetime import UTC, datetime
from typing import Any, Final

from reporting_agent.artifacts import (
    write_styled_diagnostics,
    ArtifactRef,
    ast_to_plain,
    write_report_artifacts,
    write_verification_result,
)
from reporting_agent.catalog.loader import (
    LoadedCatalog,
    load_catalog,
    load_section_catalogue,
)
from reporting_agent.collect.pipeline import (
    CollectionOutcome,
    CollectionSink,
    RunPlan,
    StepEvents,
    resolve_run_plan,
    run_collection,
)
from reporting_agent.compile.blocks.base import HistoricalSelectionKey
from reporting_agent.compile.historical import (
    PriorRunCandidate,
    Selection,
)
from reporting_agent.compile.messages import Messages
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
from reporting_agent.redaction import scrub_exception
from reporting_agent.storage.base import ObjectStore
from reporting_agent.verify import historical as historical_pass
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
    "select_historical_runs",
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

    # --- historical selection (Req 18.4, 18.8) -----------------------------------------
    # Walk the pinned definition for `historical_trend` blocks, collect their distinct
    # (metric, statistic, lookback) keys, and call `select_historical_runs` once per key.
    # The selection is persisted as `historical.json` beside `prose.json` (the same pinned-
    # input reasoning: verify_report cannot re-derive it because the verify payload carries
    # no candidate list).
    actor_id = plan.actor_id
    # Loaded once and threaded to both readers: the key walker below and the compile's
    # own `section_catalogue` argument. Two independent loads would be two chances for
    # them to disagree about what a section expands to.
    section_catalogue = (
        load_section_catalogue(loaded_catalog=catalog)
        if definition.get("schema_version") == 3
        else None
    )
    # Loaded before the document phases, because the front matter is described once and
    # both emitters draw from that description — a signature fetched later would be a
    # second description that the `.docx` and the reading copy could disagree about.
    front_matter_images = await _load_front_matter_images(
        definition, store=store, actor_id=actor_id
    )
    hist_keys = _historical_selection_keys(definition, catalogue=section_catalogue)
    historical_selections: dict[HistoricalSelectionKey, Selection] = {}
    historical_source: _HistoricalSourceFromStore | None = None

    if hist_keys:
        period_raw = definition.get("period")
        _period_start = ""
        if isinstance(period_raw, Mapping):
            _period_start = str(period_raw.get("start") or payload.get("period", {}).get("start") or "")  # type: ignore[union-attr]
        if not _period_start:
            _p = payload.get("period")
            if isinstance(_p, Mapping):
                _period_start = str(_p.get("start") or "")

        fidelity_tier = str(context.get("fidelity_tier") or "baseline")

        for key in hist_keys:
            metric, statistic, lookback = key
            selection = await select_historical_runs(
                payload,
                store=store,
                actor_id=actor_id,
                lookback=lookback,
                metric=metric,
                statistic=statistic,
                compiling_fidelity_tier=fidelity_tier,
                compiling_period_start=_period_start,
            )
            historical_selections[key] = selection

        # Build a HistoricalSource from the loaded prior snapshots.
        # Collect all selected run ids across all selections.
        selected_ids: set[str] = set()
        for sel in historical_selections.values():
            for c in sel.selected:
                selected_ids.add(c.run_id)

        if selected_ids:
            from reporting_agent.compile.snapshot_view import build_snapshot_view

            loaded_views: dict[str, Any] = {}
            for run_id in selected_ids:
                key = _snapshot_key(actor_id, run_id)
                try:
                    snap = await store.get_json(key)
                    if isinstance(snap, Mapping):
                        loaded_views[run_id] = build_snapshot_view(snap)
                except Exception:
                    pass
            historical_source = _HistoricalSourceFromStore(loaded_views)

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
        historical_selections=historical_selections or None,
        historical_source=historical_source,
        front_matter=_resolve_front_matter_config(definition, front_matter_images),
        run_facts=_resolve_run_facts(payload, definition, run_id=plan.run_id),
        section_catalogue=section_catalogue,
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

    schema_version = definition.get("schema_version")
    if schema_version == 3:
        return _requested_metric_union_v3(definition, catalog)

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


def _requested_metric_union_v3(
    definition: Mapping[str, PlainData], catalog: LoadedCatalog
) -> dict[str, tuple[str, ...]]:
    """Req 5.4 at `schema_version` 3 — the agent-side twin of the app-side
    `declaredScopes` gap fixed in `a1d912f` (task 7.3, previously "union_scope_v3_gap"
    from an earlier phase, closed here rather than deferred again).

    A v3 definition carries no top-level `metrics` or `scope`/`blocks` at all — every
    section carries its own `metrics` (a list of `{metric, statistic}`/`{derived,
    statistic}` items, the same shape a v1/v2 item uses) and its own `selection` (the
    same shape a v1/v2 `scope_override` uses). The unmodified v1/v2 branch above reads
    both from the top level and folds in nothing for a v3 definition, so it always
    returns an empty union — a v3 run therefore requests zero metrics at any scope and
    fails `NO_STATISTICS`, whose user-facing copy blames the customer's estate
    (deallocated resources, metrics the resource type does not emit) for a failure that
    is this pipeline's own, never the estate's.

    Each section's own resource types are its `selection.resource_types` where the
    section narrows the scope, and the Section_Catalogue entry's own
    `needs_resource_types` where it does not — the same "empty means unconstrained,
    fall back to what the entry actually needs" reading `union_scope` already gives an
    empty `ScopeRules.resource_types`, since a section with no narrowing still needs to
    key its own metrics against *something* rather than every resource type in the
    catalogue.
    """
    from reporting_agent.compile.scope import scope_rules_from_plain, union_scope

    section_catalogue = load_section_catalogue(loaded_catalog=catalog)

    scopes: list[Any] = []
    metrics_by_type: dict[str, set[str]] = {}

    raw_sections = definition.get("sections")
    if not isinstance(raw_sections, Sequence) or isinstance(raw_sections, (str, bytes)):
        return {}

    for ordinal, section in enumerate(raw_sections):
        if not isinstance(section, Mapping):
            continue

        section_type = section.get("type")
        entry = (
            section_catalogue.by_key(section_type)
            if isinstance(section_type, str)
            else None
        )

        selection = section.get("selection")
        scope_rules = scope_rules_from_plain(
            selection, at=f"sections.{ordinal}.selection"
        )
        scopes.append(scope_rules)

        resource_types = scope_rules.resource_types or (
            entry.needs_resource_types if entry is not None else ()
        )
        if not resource_types:
            continue

        items = section.get("metrics")
        if not isinstance(items, Sequence) or isinstance(items, (str, bytes)):
            continue
        for resource_type in resource_types:
            names = metrics_by_type.setdefault(resource_type, set())
            for item in items:
                if not isinstance(item, Mapping):
                    continue
                metric = item.get("metric")
                if isinstance(metric, str) and metric:
                    names.add(metric)
                    continue
                derived = item.get("derived")
                if isinstance(derived, str) and derived:
                    names.update(
                        _derived_source_metrics(catalog, resource_type, derived)
                    )

    requested = union_scope(
        scopes, metrics_by_resource_type=metrics_by_type
    ).metrics_by_resource_type

    canonical: dict[str, set[str]] = {}
    for resource_type, names in requested.items():
        canon_entry = catalog.for_resource_type(resource_type)
        key = canon_entry.resource_type if canon_entry is not None else resource_type
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
# Historical-trend prior-run selection (Req 18.4–18.15)
# --------------------------------------------------------------------------- #


def _parse_historical_candidates(
    payload: Mapping[str, PlainData],
) -> list[PriorRunCandidate]:
    """Parse `historical_candidates` from the invoke command payload.

    Returns an empty list when the field is absent — the normal case for a run whose
    pinned definition declares no `historical_trend` block, or for a snapshot-only run.
    """
    from reporting_agent.compile.historical import PriorRunCandidate

    raw = payload.get("historical_candidates")
    if not isinstance(raw, (list, tuple)):
        return []
    candidates: list[PriorRunCandidate] = []
    for entry in raw:
        if not isinstance(entry, Mapping):
            continue
        run_id = entry.get("id")
        if not isinstance(run_id, str) or not run_id:
            continue
        candidates.append(
            PriorRunCandidate(
                run_id=run_id,
                period_start=str(entry.get("period_start") or ""),
                period_end=str(entry.get("period_end") or ""),
                timezone=str(entry.get("timezone") or ""),
                status=str(entry.get("status") or ""),
                verification_status=(
                    str(entry["verification_status"])
                    if entry.get("verification_status") is not None
                    else None
                ),
                verification_created_at=(
                    str(entry["verification_created_at"])
                    if entry.get("verification_created_at") is not None
                    else None
                ),
                verification_id=(
                    str(entry["verification_id"])
                    if entry.get("verification_id") is not None
                    else None
                ),
                snapshot_sha256=(
                    str(entry["verification_snapshot_sha256"])
                    if entry.get("verification_snapshot_sha256") is not None
                    else None
                ),
            )
        )
    return candidates


async def _load_historical_snapshots(
    candidates: list[PriorRunCandidate],
    *,
    store: ObjectStore,
    actor_id: str,
    lookback: int,
) -> Callable[[str], Mapping[str, object] | None]:
    """Load at most ``lookback`` prior snapshots and return a ``snapshot_for`` callable.

    Follows the same pattern as ``verify/replay.py``: the caller fetches and the pure
    module folds. An unreadable snapshot returns ``None``, which the selector treats as
    ``metric_absent_in_snapshot``.
    """
    # Only load snapshots for candidates that would pass the first two filters —
    # we know their status and verification without a snapshot.
    eligible_ids: list[str] = []
    for c in candidates:
        if c.status != "completed":
            continue
        if c.verification_status != "pass":
            continue
        eligible_ids.append(c.run_id)
        if len(eligible_ids) >= lookback:
            break

    loaded: dict[str, Mapping[str, object]] = {}
    for run_id in eligible_ids:
        key = _snapshot_key(actor_id, run_id)
        try:
            snapshot = await store.get_json(key)
            if isinstance(snapshot, Mapping):
                loaded[run_id] = snapshot
        except Exception as exc:
            logger.warning(
                "prior snapshot for run %s could not be loaded (%s); the selector will "
                "treat this metric as absent",
                run_id,
                type(exc).__name__,
            )

    def snapshot_for(run_id: str) -> Mapping[str, object] | None:
        return loaded.get(run_id)

    return snapshot_for


async def select_historical_runs(
    payload: Mapping[str, PlainData],
    *,
    store: ObjectStore,
    actor_id: str,
    lookback: int,
    metric: str,
    statistic: str,
    compiling_fidelity_tier: str,
    compiling_period_start: str,
) -> Selection:
    """Parse candidates from the payload, load snapshots, and run the pure selector.

    This is the pipeline's integration of ``compile/historical.py``'s pure ``select()``.
    The caller (the future ``historical_trend`` block compiler, task 11.3) invokes this
    rather than assembling the pieces, so the pattern of "caller fetches, pure module
    folds" is encapsulated here alongside the snapshot-only verification path.
    """
    from reporting_agent.compile.historical import select

    candidates = _parse_historical_candidates(payload)
    if not candidates:
        return Selection(selected=(), exclusions=())

    snapshot_for = await _load_historical_snapshots(
        candidates, store=store, actor_id=actor_id, lookback=lookback
    )

    return select(
        candidates,
        compiling_period_start=compiling_period_start,
        lookback=lookback,
        metric=metric,
        statistic=statistic,
        compiling_fidelity_tier=compiling_fidelity_tier,
        snapshot_for=snapshot_for,
    )


# --------------------------------------------------------------------------- #
# The four document phases
# --------------------------------------------------------------------------- #


async def _load_front_matter_images(
    definition: Mapping[str, PlainData],
    *,
    store: ObjectStore,
    actor_id: str,
) -> dict[str, bytes]:
    """Every front-matter image the definition references, by key.

    ## Why this exists at all

    `ApproverEntry.signature_image` has been declared since the front matter was written,
    `render/front_matter.py::_place_signature_image` has always known how to draw one, and
    the definition has carried `signature_key` since v3. Nothing loaded the bytes. So an
    approver who uploaded a signature got the same empty ruled box as one who had not —
    the two indistinguishable in the delivered document, which is the one place the
    difference matters.

    ## Never fatal

    A key that is missing, unreadable, or owned by somebody else yields no bytes and no
    exception. Criterion 13.6 clause (b) already requires an unsupplied signature to
    render as a ruled box and never as the typed name, so the failure mode of "could not
    read it" and the ordinary case of "none was given" produce the identical, correct
    document. Withholding a report because a logo would not load would be the wrong trade
    by a wide margin.

    Ownership is checked before the read rather than trusted: a key is only fetched when
    its first segment is this run's actor, so a definition naming another tenant's object
    reads nothing. `collect/snapshot.py::snapshot_key` draws the same first-segment line
    for the same reason.
    """
    keys: set[str] = set()
    front = definition.get("front_matter")
    if isinstance(front, Mapping):
        control = front.get("document_control")
        if isinstance(control, Mapping):
            approvers = control.get("approvers")
            if isinstance(approvers, Sequence) and not isinstance(approvers, str):
                for entry in approvers:
                    if isinstance(entry, Mapping):
                        key = entry.get("signature_key")
                        if isinstance(key, str) and key:
                            keys.add(key)
        cover = front.get("cover")
        if isinstance(cover, Mapping):
            key = cover.get("logo_key")
            if isinstance(key, str) and key:
                keys.add(key)

    images: dict[str, bytes] = {}
    for key in sorted(keys):
        if key.split("/", 1)[0] != actor_id:
            logger.warning(
                "a front-matter image key names an actor other than this run's; "
                "nothing is read and the document renders without it."
            )
            continue
        try:
            images[key] = await store.get_bytes(key)
        except Exception as exc:
            logger.warning(
                "a front-matter image could not be read; the document renders without "
                "it: %s",
                scrub_exception(exc),
            )
    return images


def _resolve_front_matter_config(
    definition: Mapping[str, PlainData],
    images: Mapping[str, bytes] | None = None,
) -> object | None:
    """Build a `FrontMatterConfig` from the definition's `front_matter` section.

    Returns `None` for v1 definitions (no `front_matter` key), so the render pipeline
    correctly omits front matter for pre-v2 templates.
    """
    from reporting_agent.render.front_matter import (
        ApproverEntry,
        CoverConfig,
        DistributionRow,
        DocumentControlConfig,
        FrontMatterConfig,
        TocConfig,
    )

    fm_raw = definition.get("front_matter")
    if not isinstance(fm_raw, Mapping):
        return None

    # Cover
    #
    # `design.cover_page` is Req 13.9's switch and it is **ANDed** into the cover's own
    # `enabled` flag here, because `emit_front_matter` gates the cover on
    # `front_matter.cover.enabled` alone and takes no `design`. Resolving it at this
    # boundary is what makes "cover_page false emits no cover content and no leading
    # blank page" true without the emitter having to learn about design settings.
    #
    # It is an AND, not a replacement: a template may switch its cover off in the
    # front-matter section too, and either switch alone is enough to suppress it. The
    # cover *configuration* stays in the definition either way — the requirement is that
    # nothing is emitted, not that the config is discarded — and the document control page
    # and the table of contents are untouched, because disabling the cover does not
    # disable the front matter.
    design_raw = definition.get("design")
    cover_page_enabled = True
    if isinstance(design_raw, Mapping):
        cover_page_enabled = bool(design_raw.get("cover_page", True))

    cover_raw = fm_raw.get("cover")
    cover = CoverConfig(enabled=cover_page_enabled)
    if isinstance(cover_raw, Mapping):
        logo_key = str(cover_raw["logo_key"]) if cover_raw.get("logo_key") else None
        cover = CoverConfig(
            enabled=bool(cover_raw.get("enabled", True)) and cover_page_enabled,
            logo=str(cover_raw["logo"]) if cover_raw.get("logo") else None,
            logo_key=logo_key,
            logo_image=(images or {}).get(logo_key or ""),
            contact_block=str(cover_raw["contact_block"]) if cover_raw.get("contact_block") else None,
            subtitle=str(cover_raw["subtitle"]) if cover_raw.get("subtitle") else None,
        )

    # Document control
    dc_raw = fm_raw.get("document_control")
    dc = DocumentControlConfig()
    if isinstance(dc_raw, Mapping):
        approvers_raw = dc_raw.get("approvers")
        approvers: tuple[ApproverEntry, ...] = ()
        if isinstance(approvers_raw, (list, tuple)):
            entries: list[ApproverEntry] = []
            for item in approvers_raw:
                if isinstance(item, Mapping):
                    entries.append(ApproverEntry(
                        role=str(item.get("role") or ""),
                        name=str(item.get("name") or ""),
                        title=str(item.get("title") or ""),
                        # Collected by the wizard's approver rows and declared on
                        # `ApproverEntry` since it was written; dropped here, so the
                        # approvers table had nothing to put in its Company column.
                        company=str(item.get("company") or ""),
                        # The uploaded signature's bytes, where this run could read them.
                        # `None` renders the ruled box criterion 13.6 clause (b) requires,
                        # which is also what an approver who uploaded nothing gets — the
                        # two are the same document and always were; what changed is that
                        # an approver who *did* upload one now differs from both.
                        signature_image=(images or {}).get(
                            str(item.get("signature_key") or "")
                        ),
                    ))
            approvers = tuple(entries)
        distribution_raw = dc_raw.get("distribution")
        distribution_rows: tuple[DistributionRow, ...] = ()
        distribution_text: str | None = None
        if isinstance(distribution_raw, (list, tuple)):
            # Req 12.6's v3 shape. `str()` over this list produced its Python repr and
            # put that in the delivered document.
            distribution_rows = tuple(
                DistributionRow(
                    recipient=str(row.get("recipient") or ""),
                    company=str(row.get("company") or ""),
                    note=str(row.get("note") or ""),
                )
                for row in distribution_raw
                if isinstance(row, Mapping)
            )
        elif distribution_raw:
            distribution_text = str(distribution_raw)

        dc = DocumentControlConfig(
            document_name=str(dc_raw["document_name"]) if dc_raw.get("document_name") else None,
            document_number_pattern=str(dc_raw["document_number_pattern"]) if dc_raw.get("document_number_pattern") else None,
            confidentiality_notice_id=str(dc_raw["confidentiality_notice_id"]) if dc_raw.get("confidentiality_notice_id") else None,
            confidentiality_notice=str(dc_raw["confidentiality_notice"]) if dc_raw.get("confidentiality_notice") else None,
            distribution=distribution_text,
            distribution_rows=distribution_rows,
            approvers=approvers,
        )

    # TOC
    toc_raw = fm_raw.get("toc")
    toc = TocConfig()
    if isinstance(toc_raw, Mapping):
        toc = TocConfig(
            enabled=bool(toc_raw.get("enabled", True)),
            max_level=int(toc_raw.get("max_level", 3)),
        )

    return FrontMatterConfig(cover=cover, document_control=dc, toc=toc)


def _resolve_run_facts(
    payload: Mapping[str, PlainData],
    definition: Mapping[str, PlainData],
    *,
    run_id: str,
) -> object | None:
    """Build a `RunFacts` from the payload's per-run values.

    Returns `None` when the definition has no `front_matter` section (v1), because there
    is no front matter to render.
    """
    from reporting_agent.render.front_matter import RevisionHistoryRow, RunFacts

    fm_raw = definition.get("front_matter")
    if not isinstance(fm_raw, Mapping):
        return None

    customer_name = str(payload.get("customer_name") or "")

    # report_title from identity
    identity = definition.get("identity")
    report_title = ""
    if isinstance(identity, Mapping):
        title = identity.get("report_title") or identity.get("name")
        if isinstance(title, str):
            report_title = title

    # template_id from identity
    template_id = ""
    if isinstance(identity, Mapping):
        tid = identity.get("id") or identity.get("name") or ""
        template_id = str(tid) if tid else ""
    if not template_id:
        template_id = str(payload.get("template_version_id") or run_id)

    # period info
    period_raw = payload.get("period")
    period_start = ""
    if isinstance(period_raw, Mapping):
        period_start = str(period_raw.get("start") or "")
    elif isinstance(definition.get("period"), Mapping):
        period_start = str(definition["period"].get("start") or "")  # type: ignore[union-attr]

    period_start_year = ""
    period_start_month = ""
    if period_start and len(period_start) >= 7:
        # "2026-07-01" -> year="2026", month="07"
        parts = period_start.split("-")
        if len(parts) >= 2:
            period_start_year = parts[0]
            period_start_month = parts[1]

    # period_display from payload or derived
    period_display = str(payload.get("period_display") or "")
    if not period_display and period_start:
        # Derive a human-readable display from the start date.
        try:
            from datetime import date as _date
            d = _date.fromisoformat(period_start)
            period_display = d.strftime("%B %Y")
        except (ValueError, TypeError):
            period_display = period_start

    # revision_history
    revision_history: RevisionHistoryRow | None = None
    rh_raw = payload.get("revision_history_row")
    if isinstance(rh_raw, Mapping):
        revision_history = RevisionHistoryRow(
            revision=str(rh_raw.get("revision") or ""),
            note=str(rh_raw.get("note") or ""),
            author=str(rh_raw.get("author") or ""),
        )

    return RunFacts(
        run_id=run_id,
        template_id=template_id,
        customer_name=customer_name,
        period_display=period_display,
        report_title=report_title,
        revision_history=revision_history,
        period_start_year=period_start_year,
        period_start_month=period_start_month,
    )


def _historical_verify_inputs(
    historical_selections: Mapping[HistoricalSelectionKey, Selection] | None,
) -> Mapping[str, historical_pass.HistoricalRunInfo]:
    """Derive `VerifyInputs.historical` from the same selection already computed for compile.

    `verify/historical.py`'s gate reads `VerifyInputs.historical` — a mapping from source
    run id to `{verification_status, period_start, period_end}` — and treats a run id
    **absent** from it as `verification_status="unknown"`, which is a **blocking**
    `historical_point_unverified` finding (Req 18.11). Every field the gate needs is
    already sitting on the `PriorRunCandidate` tuples inside `historical_selections`: the
    selector admitted only `status="completed"` candidates whose latest verification
    passed (`compile/historical.py::select`), so re-deriving the map here is exactly one
    read of data this run already fetched, not a second Azure call and not a second
    decision about which runs are eligible.

    Without this, activating `historical_trend` breaks verification for every run that
    plots a real prior run: the block compiles and renders real figures, and the gate
    that is supposed to prove them correctly refuses every one, because nothing ever told
    it the run it is being asked to trust was verified at all.
    """
    inputs: dict[str, historical_pass.HistoricalRunInfo] = {}
    for selection in (historical_selections or {}).values():
        for candidate in selection.selected:
            inputs[candidate.run_id] = historical_pass.HistoricalRunInfo(
                verification_status=candidate.verification_status or "",
                period_start=candidate.period_start,
                period_end=candidate.period_end,
            )
    return inputs


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
    historical_selections: Mapping[HistoricalSelectionKey, Selection] | None = None,
    historical_source: _HistoricalSourceFromStore | None = None,
    front_matter: object | None = None,
    run_facts: object | None = None,
    section_catalogue: object | None = None,
) -> AsyncIterator[Event]:
    from reporting_agent.compile.blocks import compile_document
    from reporting_agent.compile.blocks.base import DesignSettings
    from reporting_agent.compile.messages import load_messages
    from reporting_agent.compile.snapshot_view import build_snapshot_view
    from reporting_agent.messages import DEFAULT_LANGUAGE
    from reporting_agent.render.docx import render_document
    from reporting_agent.render.html import emit_html
    from reporting_agent.render.pdf import convert_to_pdf

    # Resolve the run's pinned language from the definition — the same path
    # compile_document uses, so the rendered document and the compiled one agree.
    _identity = definition.get("identity")
    _language = DEFAULT_LANGUAGE
    if isinstance(_identity, Mapping):
        _declared_lang = _identity.get("language")
        if isinstance(_declared_lang, str) and _declared_lang in ("en", "id"):
            _language = _declared_lang
    messages = load_messages(_language)

    design = DesignSettings.from_plain(definition.get("design"), language=_language)
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
        compile_document, definition, view=view, prose=prose,
        historical=historical_source,
        historical_selections=historical_selections,
        catalogue=section_catalogue,
    )
    if block_count:
        yield steps.progress(
            compile_step["id"],
            done=block_count,
            total=block_count,
            unit=PROGRESS_UNIT_BLOCKS,
        )
    yield steps.end(compile_step["id"])

    for event in _chart_events(compiled, messages=messages):
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
        render_document, compiled.document, ledger=compiled.ledger, design=design, messages=messages,
        front_matter=front_matter, run=run_facts,
    )
    converted = await asyncio.to_thread(convert_to_pdf, rendered.docx_bytes)

    # --- TOC pass 2 (Req 14.3, 14.4) -----------------------------------------------
    # Where the two-pass approach is adopted and front matter emitted a TOC, measure
    # actual page positions and re-emit with real page numbers. The final pass-2 bytes
    # become the delivered artifact and the input to verification.
    from reporting_agent.render.toc import should_emit_toc, toc_entries_from_document
    if should_emit_toc() and front_matter is not None:
        from reporting_agent.render.front_matter import FrontMatterConfig
        if isinstance(front_matter, FrontMatterConfig) and front_matter.toc.enabled:
            from reporting_agent.render.toc import apply_toc_page_numbers
            headings = toc_entries_from_document(compiled.document)
            heading_texts = tuple(h[0] for h in headings)
            if heading_texts:
                final_docx, final_pdf = await asyncio.to_thread(
                    apply_toc_page_numbers, rendered.docx_bytes, headings=heading_texts,
                )
                # Replace rendered and converted with the pass-2 artifacts so that
                # docx_sha256 / pdf_sha256 are the pass-2 digests.
                #
                # `replace` rather than reconstructing field by field. The explicit form
                # named seven fields, so `chart_vectors` and `chart_tables` — added for the
                # styled PDF — would have been dropped here and nowhere else, on the one
                # path that re-emits the document: every run with a table of contents would
                # have produced a reading copy with no charts, and every run without one
                # would have been fine. That is the same full-replace hazard
                # `update-agent-runtime` has, in a dataclass.
                rendered = replace(rendered, docx_bytes=final_docx)
                from reporting_agent.render.pdf import ConversionOutcome, digest_of
                converted = ConversionOutcome(
                    pdf_bytes=final_pdf,
                    docx_sha256=digest_of(final_docx),
                    pdf_sha256=digest_of(final_pdf),
                    page_count=converted.page_count,
                )

    yield steps.end(render_step["id"])

    # --- the styled reading copy ------------------------------------------------------
    #
    # A third artifact, rendered from the same compiled AST through `render/html.py` and a
    # print stylesheet. The delivered pair above is untouched and gated as it was; this is
    # a reading copy, and it is checked for the same figures at advisory severity.
    #
    # Failures here never stop a run. A document whose every figure traced and whose twelve
    # gates passed is not withheld because its reading copy failed to lay out — or because
    # the image is missing a library, which is what an unavailable renderer means.
    styled = await asyncio.to_thread(
        _render_styled_pdf,
        compiled=compiled,
        rendered=rendered,
        design=design,
        messages=messages,
        front_matter=front_matter,
        run_facts=run_facts,
    )
    styled_text, styled_pages = _pdf_text(styled.pdf_bytes) if styled is not None else ("", 0)

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
        messages=messages,
        historical=_historical_verify_inputs(historical_selections),
        front_matter=front_matter,
        run_facts=run_facts,
        section_catalogue=section_catalogue,
        styled_pdf_text=styled_text,
        styled_pdf_pages=styled_pages,
        styled_pdf_omitted=(
            styled.omitted_figure_paths if styled is not None else frozenset()
        ),
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
        historical=_historical_bundle(historical_selections),
        # Req 14.1 — the AST the `.docx` was emitted from, emitted again through the
        # `Html_Emitter`. Both artifacts describe one compilation, so the in-app paper
        # rendering of this report and the delivered `.pdf` cannot describe two.
        html=emit_html(
            compiled.document,
            messages=messages,
            chart_vectors=rendered.chart_vectors,
            chart_tables=rendered.chart_tables,
        ).html,
        chart_sidecars=dict(rendered.chart_sidecars),
        # Offered only where it rendered AND carries every figure. The verification result
        # is the authority on the second: a reading copy that lost one is recorded as an
        # advisory finding and simply not presented, while the delivered pair — which
        # passed every gate — is unaffected.
        styled_pdf_bytes=(
            styled.pdf_bytes if styled is not None and not _styled_findings(result) else b""
        ),
    )

    # A reading copy that lost a figure is suppressed, and then it is the only thing that
    # can explain why. Both halves are kept under diagnostic names — not in
    # `DOWNLOADABLE_LEAF_NAMES`, so nothing offers them — because the question "is the
    # figure absent from the markup or lost in layout?" has two different answers and two
    # different fixes, and neither is answerable from the finding alone. The stored
    # `document.html` is emitted separately and is not this page: it carries no front
    # matter and no stylesheet.
    if styled is not None and _styled_findings(result):
        await write_styled_diagnostics(
            store,
            actor_id=plan.actor_id,
            run_id=plan.run_id,
            pdf_bytes=styled.pdf_bytes,
            html=styled.html,
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




def _styled_findings(result: Mapping[str, Any]) -> tuple[Any, ...]:
    """The reading copy's own findings on a verification result.

    Read back rather than carried forward from the gate, so the decision to present the
    artifact and the record of why it was not are the same statement.
    """
    from reporting_agent.verify.findings import FINDING_STYLED_PDF_FIGURE_MISSING

    return tuple(
        finding
        for finding in result.get("findings", ())
        if finding.get("type") == FINDING_STYLED_PDF_FIGURE_MISSING
    )


def _render_styled_pdf(
    *,
    compiled: Any,
    rendered: Any,
    design: Any,
    messages: Messages,
    front_matter: object | None,
    run_facts: object | None,
) -> object | None:
    """The styled reading copy and the markup it came from, or `None`.

    Never raises. Every reason this can fail — an image without cairo and pango, a
    stylesheet that cannot lay out a document, a front matter this run does not have — is a
    reason to deliver the `.docx` and its conversion without a reading copy, and none of
    them is a reason to withhold a document that verified.

    The charts come off `rendered` rather than being drawn again: `render/charts.py`
    serialises one figure as both a PNG and an SVG, and taking the vector from the same
    render is what stops the Word file and the reading copy from showing different charts.
    """
    from reporting_agent.render.front_matter import FrontMatterConfig, front_matter_sections
    from reporting_agent.render.printpdf import render_print_pdf
    from reporting_agent.render.toc import should_emit_toc, toc_entries_from_document

    try:
        sections: tuple[object, ...] = ()
        if isinstance(front_matter, FrontMatterConfig) and run_facts is not None:
            sections = front_matter_sections(
                front_matter=front_matter,
                run=run_facts,  # type: ignore[arg-type]
                messages=messages,
                heading_entries=toc_entries_from_document(compiled.document),
                include_toc=should_emit_toc(),
            )
        outcome = render_print_pdf(
            compiled.document,
            front_matter_sections=sections,
            chart_vectors=rendered.chart_vectors,
            chart_tables=rendered.chart_tables,
            design=design,
            messages=messages,
            title=getattr(run_facts, "report_title", "") or "",
            language=messages.language,
        )
        return outcome
    except Exception:
        logger.warning("the styled reading copy could not be rendered", exc_info=True)
        return None


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
    messages: Messages,
    historical: Mapping[str, historical_pass.HistoricalRunInfo] | None = None,
    front_matter: object | None = None,
    run_facts: object | None = None,
    section_catalogue: object | None = None,
    styled_pdf_text: str = "",
    styled_pdf_pages: int = 0,
    styled_pdf_omitted: frozenset[str] = frozenset(),
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
            styled_pdf_text=styled_pdf_text,
            styled_pdf_pages=styled_pdf_pages,
            styled_pdf_omitted=styled_pdf_omitted,
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
            messages=messages,
            historical=historical or {},
            front_matter=front_matter,
            run_facts=run_facts,
            section_catalogue=section_catalogue,
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


def _chart_events(compiled: Any, *, messages: Messages) -> list[Event]:
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
                "data_hash": chart_data_hash(node, messages=messages),
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
                    for series in plotted_series(node, messages=messages)
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


def _historical_bundle(
    selections: Mapping[HistoricalSelectionKey, Selection] | None,
) -> dict[str, Any] | None:
    """`historical.json` — the pinned historical selection, persisted for recompilation.

    Same reasoning as `_prose_bundle` / `_StoredProse`: a compile is a pure function of
    (template version, snapshot, prose bundle, historical selection). The selection depends
    on `historical_candidates` from the generate_report payload, which verify_report does
    not carry. Without this pin, a template using `historical_trend` blocks fails
    re-verification with a ledger mismatch on a correct report.
    """
    if not selections:
        return None
    serialized: dict[str, Any] = {}
    for (metric, statistic, lookback), selection in selections.items():
        key_str = f"{metric}|{statistic}|{lookback}"
        serialized[key_str] = {
            "selected": [
                {
                    "run_id": c.run_id,
                    "period_start": c.period_start,
                    "period_end": c.period_end,
                    "timezone": c.timezone,
                    "status": c.status,
                    "verification_status": c.verification_status,
                    "verification_created_at": c.verification_created_at,
                    "verification_id": c.verification_id,
                    "snapshot_sha256": c.snapshot_sha256,
                }
                for c in selection.selected
            ],
        }
    return {"schema_version": 1, "selections": serialized}


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


def _historical_selection_keys(
    definition: Mapping[str, PlainData],
    *,
    catalogue: object | None = None,
) -> set[HistoricalSelectionKey]:
    """Extract distinct `(metric, statistic, lookback)` keys from `historical_trend` blocks.

    Returns the empty set when the definition has no such block — which is the normal case
    and the one where no selection work is needed.

    A **v3** definition carries `sections`, not `blocks`, and its trend keys are resolved
    by `compile/sections.py::historical_trend_keys` against the section catalogue — the
    same function the expansion itself uses, so the keys fetched and the blocks compiled
    cannot disagree. Reading only `blocks` here made every v3 profile's trend print "no
    prior verified period" against a database holding eleven passing prior runs, with no
    error anywhere: an empty key set selects no candidates, and a `historical_trend` block
    with no candidates is *supposed* to be able to say that.

    A v3 definition with no `catalogue` **raises**, rather than falling through to the
    `blocks` walk that returns nothing. Falling through would reproduce the original
    defect exactly — silently, on the same input, with the same invisible symptom — and a
    caller that forgot the catalogue has made a mistake this function can see.
    """
    if definition.get("schema_version") == 3:
        if catalogue is None:
            raise CompileFailedError(
                "a v3 definition's historical-trend keys cannot be resolved without the "
                "section catalogue: its trends live in `sections`, not `blocks`, and "
                "answering from `blocks` would report no trend on a profile that "
                "declares one"
            )
        from reporting_agent.compile.sections import historical_trend_keys

        return historical_trend_keys(definition, catalogue=catalogue)  # type: ignore[arg-type]

    blocks = definition.get("blocks")
    if not isinstance(blocks, Sequence):
        return set()
    keys: set[HistoricalSelectionKey] = set()
    for block in blocks:
        if not isinstance(block, Mapping):
            continue
        if block.get("type") == "historical_trend":
            config = block.get("config")
            if not isinstance(config, Mapping):
                continue
            metric = config.get("metric")
            statistic = config.get("statistic")
            lookback = config.get("lookback")
            if isinstance(metric, str) and isinstance(statistic, str) and isinstance(lookback, int):
                keys.add((metric, statistic, lookback))
        # Also look inside row columns
        columns = block.get("columns")
        if isinstance(columns, Sequence):
            for column in columns:
                if not isinstance(column, Sequence):
                    continue
                for child in column:
                    if not isinstance(child, Mapping):
                        continue
                    if child.get("type") == "historical_trend":
                        config = child.get("config")
                        if not isinstance(config, Mapping):
                            continue
                        metric = config.get("metric")
                        statistic = config.get("statistic")
                        lookback = config.get("lookback")
                        if isinstance(metric, str) and isinstance(statistic, str) and isinstance(lookback, int):
                            keys.add((metric, statistic, lookback))
    return keys


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
    historical_raw = await _optional_json(store, f"{prefix}historical.json")

    view = build_snapshot_view(snapshot)

    # Replay historical selection: load _StoredSelection and build a HistoricalSource
    # from the selected prior snapshots, exactly as the generate path does.
    stored_selection = _StoredSelection(historical_raw)
    hist_selections = stored_selection.selections or None
    hist_source: _HistoricalSourceFromStore | None = None
    if hist_selections:
        selected_ids: set[str] = set()
        for sel in hist_selections.values():
            for c in sel.selected:
                selected_ids.add(c.run_id)
        if selected_ids:
            loaded_views: dict[str, Any] = {}
            for prior_run_id in selected_ids:
                try:
                    snap = await store.get_json(_snapshot_key(actor_id, prior_run_id))
                    if isinstance(snap, Mapping):
                        loaded_views[prior_run_id] = build_snapshot_view(snap)
                except Exception:
                    pass
            hist_source = _HistoricalSourceFromStore(loaded_views)

    recompiled = compile_document(
        definition, view=view, prose=_StoredProse(prose), catalog_scales=None,
        historical=hist_source,
        historical_selections=hist_selections,
    )

    # Compare the compile-derivable layer only. The stored ledger includes render-populated
    # fields (row_key, column_key on anchors) that a recompile without render cannot
    # reproduce — and should not: those fields are verified by the anchored-cell pass
    # against the stored .docx, which is stronger than re-derivation.
    from reporting_agent.compile.figures import stored_ledger_compile_layer

    if recompiled.ledger.serialize_compile_layer() != stored_ledger_compile_layer(stored_ledger):
        raise VerificationFailedError(
            "the ledger recompiled from the pinned version and the stored snapshot is not "
            "byte-identical to the stored ledger's compile layer; the figures trace to a "
            "different snapshot or template version and no re-verification of this report "
            "is meaningful"
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
        historical_selections=hist_selections,
        front_matter=_resolve_front_matter_config(
            definition,
            await _load_front_matter_images(
                definition, store=store, actor_id=actor_id
            ),
        ),
        run_facts=_resolve_run_facts(payload, definition, run_id=run_id),
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


class _StoredSelection:
    """The persisted historical selection, replayed into a recompile.

    Mirrors `_StoredProse` exactly: a compile is a pure function of (template version,
    snapshot, prose bundle, historical selection). The selection depends on the
    `historical_candidates` list from the generate_report payload; the verify_report
    payload carries only the definition and run_id. Without this pin, a recompile cannot
    reproduce figures from historical_trend blocks, and the ledger comparison fails on a
    correct report.
    """

    __slots__ = ("_selections",)

    def __init__(self, bundle: Mapping[str, Any] | None) -> None:
        self._selections: dict[HistoricalSelectionKey, Selection] = {}
        if bundle is None:
            return
        raw = bundle.get("selections")
        if not isinstance(raw, Mapping):
            return
        for key_str, sel_raw in raw.items():
            # Key is stored as "metric|statistic|lookback"
            parts = key_str.split("|")
            if len(parts) != 3:
                continue
            try:
                lookback = int(parts[2])
            except (ValueError, TypeError):
                continue
            key: HistoricalSelectionKey = (parts[0], parts[1], lookback)
            # Reconstruct the Selection from its serialized form
            selected: list[PriorRunCandidate] = []
            for entry in (sel_raw.get("selected") or []) if isinstance(sel_raw, Mapping) else []:
                if not isinstance(entry, Mapping):
                    continue
                run_id = entry.get("run_id")
                if not isinstance(run_id, str):
                    continue
                selected.append(
                    PriorRunCandidate(
                        run_id=run_id,
                        period_start=str(entry.get("period_start") or ""),
                        period_end=str(entry.get("period_end") or ""),
                        timezone=str(entry.get("timezone") or ""),
                        status=str(entry.get("status") or ""),
                        verification_status=(
                            str(entry["verification_status"])
                            if entry.get("verification_status") is not None
                            else None
                        ),
                        verification_created_at=(
                            str(entry["verification_created_at"])
                            if entry.get("verification_created_at") is not None
                            else None
                        ),
                        verification_id=(
                            str(entry["verification_id"])
                            if entry.get("verification_id") is not None
                            else None
                        ),
                        snapshot_sha256=(
                            str(entry["snapshot_sha256"])
                            if entry.get("snapshot_sha256") is not None
                            else None
                        ),
                    )
                )
            self._selections[key] = Selection(selected=tuple(selected), exclusions=())

    @property
    def selections(self) -> dict[HistoricalSelectionKey, Selection]:
        return self._selections


class _HistoricalSourceFromStore:
    """A `HistoricalSource` backed by pre-loaded snapshot views.

    The same role as `tests/test_render_guards.py::FakeHistorical` but used in production:
    maps run ids to their already-loaded `SnapshotView`, so the compiler can resolve prior
    values without any network call.
    """

    __slots__ = ("_views",)

    def __init__(self, views: dict[str, Any]) -> None:
        self._views = views

    def snapshot_view_for(self, run_id: str) -> Any | None:
        return self._views.get(run_id)


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
    historical_selections: Mapping[HistoricalSelectionKey, Selection] | None = None,
    front_matter: object | None = None,
    run_facts: object | None = None,
) -> Mapping[str, Any]:
    from docx import Document as open_docx

    from reporting_agent.catalog.loader import load_catalog
    from reporting_agent.compile.messages import load_messages as _load_msgs
    from reporting_agent.messages import DEFAULT_LANGUAGE
    from reporting_agent.render.pdf import digest_of
    from reporting_agent.verify.replay import plan_from_snapshot
    from reporting_agent.verify.verifier import VerifyInputs, verify

    _id = definition.get("identity")
    _lang = DEFAULT_LANGUAGE
    if isinstance(_id, Mapping):
        _dl = _id.get("language")
        if isinstance(_dl, str) and _dl in ("en", "id"):
            _lang = _dl
    _msgs = _load_msgs(_lang)

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
            messages=_msgs,
            historical=_historical_verify_inputs(historical_selections),
            front_matter=front_matter,
            run_facts=run_facts,
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
    from reporting_agent.compile.messages import load_messages
    from reporting_agent.compile.snapshot_view import build_snapshot_view
    from reporting_agent.messages import DEFAULT_LANGUAGE
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

    # The pinned language, resolved the same way the delivered path resolves it at line
    # ~590 — so a preview of an Indonesian template is Indonesian. This was MISSING until
    # wave 11: task 6.6 made `messages` required on `render_document` and `emit_html`, and
    # this call site was the one the change did not reach, because no test drives
    # `run_render_preview`. A production-only call site with no caller in the suite is the
    # "an injected seam is an untested seam" case `tech.md` records, and it is why the
    # green suite at that commit proved less than it appeared to.
    _preview_identity = definition.get("identity")
    _preview_language = DEFAULT_LANGUAGE
    if isinstance(_preview_identity, Mapping):
        _declared = _preview_identity.get("language")
        if isinstance(_declared, str) and _declared in ("en", "id"):
            _preview_language = _declared
    preview_messages = load_messages(_preview_language)

    # `preview=True` is what puts the per-page notice in against each theme's
    # `PreviewNotice` style, so the artifact says what it is even after it leaves the app.
    #
    # ## The preview carries NO front matter, and the requirement decides that
    #
    # `design-system.md` calls "Render real preview" the only surface allowed to imply
    # "this is what you will get", which argues for emitting the cover, the document
    # control page and the table of contents here too. It cannot: a preview is rendered
    # from a template and a snapshot with **no run**, so there is no `customer_name`, no
    # revision-history row and no period to print — and Req 13.15 is explicit that an
    # absent per-run value is `RENDER_FAILED` with **no substituted placeholder in its
    # position**, because "a cover carrying invented copy is a document that cannot be
    # signed". Emitting front matter here would therefore either fail every v2 preview or
    # require inventing exactly the copy that requirement forbids.
    #
    # So the preview is honest about being a preview of the *content*: the notice on every
    # page already says the artifact is not the deliverable, and the front matter it omits
    # is the part that has no per-run truth to show yet. The delivered path
    # (`_document_phases`) is where front matter is emitted, and it is the only path that
    # has the values to emit it from.
    rendered = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(definition.get("design")),
        preview=True,
        messages=preview_messages,
        front_matter=None,
        run=None,
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
        emit_html(compiled.document, messages=preview_messages).html.encode("utf-8"),
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
