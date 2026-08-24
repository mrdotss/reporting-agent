"""The block registry, and the three-phase document compile.

## The registry is exhaustive by assertion, not by convention

:data:`BLOCK_COMPILERS` must cover **exactly** the seventeen types
`compile/definition.py` declares, and an import-time assertion says so. A block type with no
compiler would otherwise reach :func:`compile_block` and be skipped — and a silently skipped
block is a document missing a section the author configured, which is the failure Req 2.3
refuses ("neither ignore nor drop it") one layer below the validator.

## Three phases, and the reason there are three

1. **Compile.** Every block in document order. Figures are minted here, into the one ledger, by
   the one factory. Two block types return a :class:`~.base.Deferred` instead of finished nodes.
2. **Narrate.** The complete ledger now exists, so the prose provider can be asked. This is the
   only phase a model participates in, and no figure depends on its answer.
3. **Assemble.** Each deferred block's `finish` runs once, and the `Document` is built. Nothing
   is mutated: every node placed here was constructed in phase one or is new.

Phase two cannot move earlier — `executive_summary`'s context is the *complete* ledger, and
`appendix_methodology` reads *every* estimated statistic's label from it. Phase three cannot
merge into phase one for the same reason. The ordering is forced by the invariant rather than
chosen for tidiness.

## The closing invariant runs before this returns

:func:`~reporting_agent.compile.figures.assert_ledger_matches_tree` compares the ledger's key
set against an assertion-only walk of the finished tree, checks that each figure's minted path
equals the position the tree addresses it at, checks object **identity** in both directions, and
checks that the figure factory was called exactly as many times as there are entries and nodes.
A compile that got any of that wrong fails here rather than producing a document whose ledger
does not describe it.
"""

from __future__ import annotations

import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Final

from reporting_agent.compile.ast import Block, Document, compiling_against
from reporting_agent.compile.blocks import charts, comparison, layout, narrative, record, tables
from reporting_agent.compile.blocks.base import (
    BlockContext,
    BlockOutput,
    BlockSpec,
    Deferred,
    DesignSettings,
    HistoricalSelectionKey,
    ProseProvider,
)
from reporting_agent.compile.historical import Selection
from reporting_agent.compile.blocks.structure import (
    compile_cover,
    compile_heading,
    compile_page_break,
    compile_rich_text,
)
from reporting_agent.compile.definition import (
    BLOCK_TYPES,
    FRONT_MATTER_FORBIDDEN_BLOCK_TYPES,
    resolved_schema_version,
)
from reporting_agent.compile.figures import (
    BlockCursor,
    FigureLedger,
    assert_ledger_matches_tree,
)
from reporting_agent.compile.messages import Messages, load_messages
from reporting_agent.compile.scope import ScopeRules, scope_rules_from_plain
from reporting_agent.compile.snapshot_view import SnapshotView
from reporting_agent.errors import CompileFailedError
from reporting_agent.messages import DEFAULT_LANGUAGE

__all__ = [
    "BLOCK_COMPILERS",
    "FRONT_MATTER_SCHEMA_VERSION",
    "BlockCompiler",
    "CompiledDocument",
    "compile_block",
    "compile_document",
]

logger = logging.getLogger(__name__)

type BlockCompiler = Callable[[BlockContext, BlockSpec, BlockCursor], BlockOutput]

BLOCK_COMPILERS: Final[dict[str, BlockCompiler]] = {
    "cover": compile_cover,
    "executive_summary": narrative.compile_executive_summary,
    "kpi_row": tables.compile_kpi_row,
    "resource_table": tables.compile_resource_table,
    "top_n_table": tables.compile_top_n_table,
    "timeseries_chart": charts.compile_timeseries_chart,
    "distribution_chart": charts.compile_distribution_chart,
    "capacity_vs_usage": tables.compile_capacity_vs_usage,
    "gaps_and_coverage": record.compile_gaps_and_coverage,
    "comparison_delta": comparison.compile_comparison_delta,
    "verification_record": record.compile_verification_record,
    "appendix_methodology": record.compile_appendix_methodology,
    "page_break": compile_page_break,
    "heading": compile_heading,
    "rich_text": compile_rich_text,
    "historical_trend": charts.compile_historical_trend,
}
"""Every declared block type but `row`, which needs the child compiler and is dispatched
separately in :func:`compile_block`."""

_ROW_TYPE: Final[str] = "row"

FRONT_MATTER_SCHEMA_VERSION: Final[int] = 2
"""The lowest `schema_version` at which the front matter owns its own sections.

At and above it, `render/front_matter.py` emits the cover from `front_matter.cover`, so
:func:`compile_document` compiles no `cover` **block** — see :func:`_phase_one`.
"""

assert FRONT_MATTER_SCHEMA_VERSION > 1, (
    "version 1 has no front matter; a front-matter floor of 1 would stop every stored v1 "
    "definition from compiling the cover block it carries"
)
assert set(FRONT_MATTER_FORBIDDEN_BLOCK_TYPES) <= set(BLOCK_COMPILERS), (
    "the front matter claims a block type this registry cannot compile at version 1: "
    f"{sorted(set(FRONT_MATTER_FORBIDDEN_BLOCK_TYPES) - set(BLOCK_COMPILERS))}"
)

assert set(BLOCK_COMPILERS) | {_ROW_TYPE} == set(BLOCK_TYPES), (
    "the block registry and the declared block-type set disagree: "
    f"{sorted(set(BLOCK_TYPES) ^ (set(BLOCK_COMPILERS) | {_ROW_TYPE}))}"
)


@dataclass(frozen=True, slots=True)
class CompiledDocument:
    """One compile's outputs: the tree, the ledger, and the per-block node mapping.

    `nodes_by_block` is what the closing invariant reads, and it is returned rather than kept
    private because the pipeline records it on the run: an error naming a figure path is only
    actionable if the block that emitted it can be recovered.
    """

    document: Document
    ledger: FigureLedger
    nodes_by_block: Mapping[str, tuple[Block, ...]]
    figure_count: int


def compile_block(
    context: BlockContext, block: BlockSpec
) -> tuple[BlockOutput, Mapping[str, tuple[Block, ...]]]:
    """Compile one block, returning its output and every block id it emitted nodes for.

    The second value is a mapping rather than a single entry because a `row` emits nodes for its
    children too, each rooted at the child's own block id.

    An undeclared block type raises `COMPILE_FAILED` naming the type and the block. It cannot
    normally get here — the validator rejects it on both sides of the mirror — so reaching this
    branch means the two have drifted, and dropping the block would turn that drift into a
    document quietly missing a section.
    """
    cursor = context.cursor(block)

    if block.type == _ROW_TYPE:
        output, child_nodes = layout.compile_row(
            context, block, cursor, compile_child=_compile_child
        )
        return (output, {block.id: output.nodes, **child_nodes})

    compiler = BLOCK_COMPILERS.get(block.type)
    if compiler is None:
        raise CompileFailedError(
            f"block {block.id!r} declares the type {block.type!r}, for which this compiler "
            f"has no implementation. Declared types are {list(BLOCK_TYPES)}; a block is never "
            f"ignored or dropped."
        )

    output = compiler(context, block, cursor)
    return (output, {block.id: output.nodes})


def _compile_child(
    context: BlockContext, block: BlockSpec
) -> tuple[BlockOutput, BlockCursor]:
    """A row's child, compiled with a cursor rooted at the child's **own** block id."""
    cursor = context.cursor(block)
    if block.type == _ROW_TYPE:
        # Unreachable through a valid definition: the schema rejects a row inside a row at any
        # depth, on both sides of the mirror. Reaching it means the mirror drifted.
        raise block.fail("a row cannot nest inside a row; one level of nesting only")

    compiler = BLOCK_COMPILERS.get(block.type)
    if compiler is None:
        raise block.fail(
            f"no compiler is registered for the type {block.type!r}; a block is never ignored"
        )
    return (compiler(context, block, cursor), cursor)


def compile_document(
    definition: Mapping[str, object],
    *,
    view: SnapshotView,
    subscription_display_name: str = "",
    prose: ProseProvider | None = None,
    comparison_source: object | None = None,
    historical: object | None = None,
    historical_selections: Mapping[HistoricalSelectionKey, Selection] | None = None,
    catalog_scales: Mapping[str, int] | None = None,
) -> CompiledDocument:
    """Compile a validated definition against one snapshot.

    `definition` is a definition **already accepted** by
    :func:`~reporting_agent.compile.definition.assert_valid_pinned_definition`. This function
    does not re-validate it: a second validator would be a second verdict, and the pipeline runs
    the gate first so a drifted mirror fails as `TEMPLATE_INVALID` before any figure exists.

    The one thing it does read off the definition itself is `schema_version`, through
    :func:`~reporting_agent.compile.definition.resolved_schema_version` — the same function the
    validator resolves with, so the version a definition is admitted at and the version it is
    compiled at cannot differ. It selects **one** behaviour: whether a `cover` block compiles
    (Req 13.2), described on :func:`_phase_one`.
    """
    schema_version = resolved_schema_version(definition.get("schema_version"))
    ledger = FigureLedger()
    identity = definition.get("identity")
    report_title = ""
    if isinstance(identity, Mapping):
        title = identity.get("report_title") or identity.get("name")
        report_title = title if isinstance(title, str) else ""

    # Req 15.11, 15.12 — resolve language from the pinned definition's identity.
    # A v1 definition has no identity.language, so it resolves as `en` (Req 15.12).
    language = DEFAULT_LANGUAGE
    if isinstance(identity, Mapping):
        declared_lang = identity.get("language")
        if isinstance(declared_lang, str) and declared_lang in ("en", "id"):
            language = declared_lang

    # Req 16.4 — build NumberFormat from the pinned definition's design.number_format,
    # supplying the declared separators resolved from the definition's language.
    design = DesignSettings.from_plain(definition.get("design"), language=language)
    messages = load_messages(language)

    period_raw = definition.get("period")
    metrics_raw = definition.get("metrics")

    context = BlockContext(
        view=view,
        ledger=ledger,
        design=design,
        default_scope=_default_scope(definition),
        messages=messages,
        period=dict(period_raw) if isinstance(period_raw, Mapping) else {},
        report_title=report_title,
        subscription_display_name=subscription_display_name,
        metrics=dict(metrics_raw) if isinstance(metrics_raw, Mapping) else {},
        prose=prose,
        comparison=comparison_source,  # type: ignore[arg-type]
        historical=historical,  # type: ignore[arg-type]
        historical_selections=historical_selections,
        catalog_scales=catalog_scales,
    )

    specs = _block_specs(definition)

    with compiling_against(view):
        emitted, nodes_by_block, deferrals, factory_calls = _phase_one(
            context, specs, design, schema_version=schema_version
        )
        prose_by_block = _phase_two(context, deferrals)
        document, nodes_by_block = _phase_three(
            emitted, nodes_by_block, deferrals, prose_by_block
        )

    assert_ledger_matches_tree(nodes_by_block, ledger, factory_calls=factory_calls)

    return CompiledDocument(
        document=document,
        ledger=ledger,
        nodes_by_block=nodes_by_block,
        figure_count=len(ledger),
    )


@dataclass(slots=True)
class _Emitted:
    """One block's phase-one result, in document order."""

    block_id: str
    nodes: tuple[Block, ...] = ()
    deferred: Deferred | None = None
    cursors: list[BlockCursor] = field(default_factory=list)


def _phase_one(
    context: BlockContext,
    specs: Sequence[BlockSpec],
    design: DesignSettings,
    *,
    schema_version: int,
) -> tuple[list[_Emitted], dict[str, tuple[Block, ...]], list[Deferred], int]:
    """Compile every block in document order, minting every figure into the one ledger.

    Two blocks are skipped rather than compiled, for different reasons, and the version skip
    comes first because it is the stronger statement:

    **The front matter owns the cover from version 2 on** (Req 13.2). At that version
    `render/front_matter.py` emits the cover from `front_matter.cover`, so compiling a `cover`
    block as well would put two covers in one document. The validator already refuses a `cover`
    in `blocks` at version 2 on both sides of the mirror, so this branch is reached only if the
    two halves drift — and unlike the undeclared-type branch in :func:`compile_block`, skipping
    here loses no section: the cover is still emitted, from the front matter. Dropping a block
    is only dishonest when nothing else produces it.

    **At version 1 the cover is a block**, and it compiles exactly as it always has, which is
    what keeps every stored v1 row and all five `app/lib/templates/starters.ts` covers
    rendering byte-identically (Req 13.11).
    """
    emitted: list[_Emitted] = []
    nodes_by_block: dict[str, tuple[Block, ...]] = {}
    deferrals: list[Deferred] = []
    factory_calls = 0

    for spec in specs:
        if (
            schema_version >= FRONT_MATTER_SCHEMA_VERSION
            and spec.type in FRONT_MATTER_FORBIDDEN_BLOCK_TYPES
        ):
            logger.warning(
                "block %s declares the type %r, which the front matter owns at schema_version "
                "%d and above; it is not compiled here because the front matter emits it. The "
                "validator should have refused it, so the two halves of the mirror have drifted",
                spec.id,
                spec.type,
                schema_version,
            )
            continue

        # Req 16.13 — a cover is emitted only where the template's cover-page flag is true, so
        # a template with it off carries no empty cover rather than an unstyled stub.
        if spec.type == "cover" and not design.cover_page:
            continue

        cursor_before = context.ledger.paths()
        output, produced = compile_block(context, spec)
        factory_calls += len(context.ledger.paths()) - len(cursor_before)

        nodes_by_block.update(produced)
        emitted.append(
            _Emitted(block_id=spec.id, nodes=output.nodes, deferred=output.deferred)
        )
        if output.deferred is not None:
            deferrals.append(output.deferred)

    return (emitted, nodes_by_block, deferrals, factory_calls)


def _phase_two(
    context: BlockContext, deferrals: Sequence[Deferred]
) -> dict[str, str | None]:
    """Ask the prose provider, once per deferred block that wants prose.

    A provider that raises costs a paragraph, not a report: nothing numeric depends on the
    model, so a run that failed because a narrator was unavailable would be the wrong trade in a
    product whose value is the figures. The failure is logged and the block assembles without
    prose.
    """
    answers: dict[str, str | None] = {}
    for deferred in deferrals:
        if deferred.prose_request is None or context.prose is None:
            answers[deferred.block_id] = None
            continue
        try:
            answers[deferred.block_id] = context.prose.narrate(deferred.prose_request)
        except Exception:
            logger.warning(
                "the prose provider failed for block %s; the block will render its figures "
                "without prose",
                deferred.block_id,
                exc_info=True,
            )
            answers[deferred.block_id] = None
    return answers


def _phase_three(
    emitted: Sequence[_Emitted],
    nodes_by_block: dict[str, tuple[Block, ...]],
    deferrals: Sequence[Deferred],
    prose_by_block: Mapping[str, str | None],
) -> tuple[Document, dict[str, tuple[Block, ...]]]:
    """Assemble the tree **once**, from parts already built, mutating nothing."""
    by_id = {deferred.block_id: deferred for deferred in deferrals}
    blocks: list[Block] = []

    for entry in emitted:
        if entry.deferred is None:
            blocks.extend(entry.nodes)
            continue
        finished = by_id[entry.block_id].finish(prose_by_block.get(entry.block_id))
        nodes_by_block[entry.block_id] = finished
        blocks.extend(finished)

    return (Document(blocks=tuple(blocks)), nodes_by_block)


def _default_scope(definition: Mapping[str, object]) -> ScopeRules:
    return scope_rules_from_plain(definition.get("scope"), at="scope")


def _block_specs(definition: Mapping[str, object]) -> tuple[BlockSpec, ...]:
    raw = definition.get("blocks")
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        raise CompileFailedError("the definition carries no blocks array")
    return tuple(
        BlockSpec.from_plain(entry, at=f"blocks[{index}]")
        for index, entry in enumerate(raw)
    )
