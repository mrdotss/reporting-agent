"""Section expansion: a v3 definition's ``sections`` array → ``BlockSpec`` sequence.

**Pure.**  No Azure, no ledger, no I/O — including the resolved ``Messages`` this module
takes as a parameter rather than loading itself: the caller builds it once from data
already in hand, so accepting it here is a pure lookup against an in-memory table, not
a second load path.

Ordering (Req 8.4):
  1. ``group`` order: ``inventory``, ``utilisation``, ``closing``
  2. Authored ``position`` within a group (the stored integer for ``free`` entries)
  3. Catalogue-declared order for ``fixed`` entries (ignoring their stored ``position``)
  4. The ``always`` appendix last

Derived block ids (Req 21.5):
  ``<section.id>__<expansion_index>`` for ``per: "section"``
  ``<section.id>__<expansion_index>__<n>`` for ``per: "resource"``

where ``n`` is the index in the resolved order from :func:`compile/scope.py::resolve`
(already deterministic: declaration order, then top-N ranking, unranked appended last).

A ``per: "resource"`` block carries the section's ``selection`` as its
``scope_override`` plus a resource **ordinal** the compiler uses to pick one of the
resolved set.  It never stores a resource id in the definition.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from typing import Final

from reporting_agent.catalog.loader import (
    EACH_RESOURCE_SLOT,
    LoadedSectionCatalogue,
    SectionCatalogueEntry,
    SectionExpansionBlock,
)
from reporting_agent.compile.blocks.base import RESOURCE_ID_CONFIG_KEY, BlockSpec
from reporting_agent.compile.messages import Messages
from reporting_agent.compile.scope import ScopeRules, TopNRule, resolve, scope_rules_from_plain
from reporting_agent.compile.snapshot_view import SnapshotView
from reporting_agent.errors import CompileFailedError

__all__ = [
    "AUTHOR_ROWS_PAYLOAD_KEY",
    "GROUP_ORDER",
    "AuthoredMatch",
    "SectionDrift",
    "apply_author_rows",
    "compute_section_drift",
    "expand_sections",
    "historical_trend_keys",
]

# The canonical group ordering.  Every section declares one of these.
GROUP_ORDER: Final[tuple[str, ...]] = ("summary", "inventory", "utilisation", "closing")
"""Document-order groups: the summary first (At a glance), then inventory, utilisation and
closing."""

_GROUP_RANK: Final[dict[str, int]] = {g: i for i, g in enumerate(GROUP_ORDER)}


# ---------------------------------------------------------------------------
# Section sorting
# ---------------------------------------------------------------------------


def _section_sort_key(
    section: Mapping[str, object],
    entry: SectionCatalogueEntry,
    fixed_order: dict[str, int],
) -> tuple[int, int, int]:
    """Produce a three-tuple sort key guaranteeing deterministic ordering.

    - First dimension: group rank (inventory < utilisation < closing)
    - Second dimension:
        * ``free`` entries: their authored ``position`` (the integer stored on them)
        * ``fixed`` entries: their catalogue-declared fixed order (ignoring stored position)
        * ``always`` entries: a sentinel past any plausible position
    - Third dimension: catalogue number (tiebreaker for identical positions)
    """
    group_rank = _GROUP_RANK.get(entry.group, len(GROUP_ORDER))

    if entry.position == "fixed":
        position_rank = fixed_order.get(entry.key, 9999)
    elif entry.position == "always":
        # The always appendix sorts AFTER everything in its group
        position_rank = 99999
    else:
        # free: use the authored position
        raw_pos = section.get("position")
        position_rank = int(raw_pos) if isinstance(raw_pos, int) else 9999

    return (group_rank, position_rank, entry.number)


# ---------------------------------------------------------------------------
# Expansion
# ---------------------------------------------------------------------------


def _build_scope_override(section: Mapping[str, object]) -> ScopeRules | None:
    """Build a ScopeRules from a section's ``selection``, or None when absent."""
    selection = section.get("selection")
    if selection is None:
        return None
    return scope_rules_from_plain(selection, at=f"section {section.get('id', '?')}.selection")


def _presentation_of(section: Mapping[str, object]) -> str:
    """A section's declared presentation, defaulting to ``chart_and_table``.

    Named rather than inlined because two callers resolve it — `_expand_one_section`,
    which decides which blocks to emit, and `historical_trend_keys`, which decides which
    prior runs to fetch for them. Those two must agree: a section presented `table_only`
    emits no `historical_trend` block, and fetching its candidates would load snapshots
    for a block that is never compiled.
    """
    presentation = section.get("presentation", "chart_and_table")
    if not isinstance(presentation, str) or not presentation:
        return "chart_and_table"
    return presentation


def _should_emit(
    expansion: SectionExpansionBlock,
    presentation: str,
) -> bool:
    """Whether an expansion block should be emitted given the section's presentation.

    An expansion with an empty ``when_presentation`` emits unconditionally.
    """
    if not expansion.when_presentation:
        return True
    return presentation in expansion.when_presentation


def _resolve_heading_text(
    expansion: SectionExpansionBlock,
    entry: SectionCatalogueEntry,
    config: dict[str, object],
    messages: Messages,
) -> None:
    """Fill a `heading` expansion's `text` from its `title_id`, in place on `config`.

    A `heading` expansion may declare its own `title_id` in its static config (used by
    a section with more than one heading, e.g. `virtual_machines`'s three subsection
    headings) — that one wins. Absent that, the section entry's own `title_id` is the
    heading's text, which is the common case: one section, one level-2 heading, titled
    from the catalogue entry itself.

    **`per: "section"` headings only.** A `per: "resource"` heading is emitted once per
    resolved resource and is titled by that resource — see
    :func:`_assert_resource_heading_untitled` and `_expand_one_section`. Titling those
    from the catalogue is what made `vm_utilization` emit its section title once per
    machine instead of naming the machines.

    `expand_sections` stays pure by construction — this resolves a string from data
    already in hand (the catalogue entry, the expansion's own config, and a `Messages`
    object built once outside any I/O) rather than performing any I/O of its own.
    """
    title_id = config.pop("title_id", None) or entry.title_id
    if not isinstance(title_id, str) or not title_id:
        raise CompileFailedError(
            f"section {entry.key!r}: a heading expansion carries no usable title_id"
        )
    config["text"] = messages.text(title_id)


def _assert_resource_heading_untitled(
    entry: SectionCatalogueEntry,
    config: Mapping[str, object],
) -> None:
    """Refuse a `per: "resource"` heading that declares a fixed `title_id`.

    The combination has exactly one possible rendering — the same fixed string once per
    resource — which is the defect this guard exists to keep out of the catalogue, and
    which shipped in `vm_utilization`, `database_utilization` and
    `app_service_and_storage`. A per-resource heading names its resource; a heading that
    wants a fixed title is a `per: "section"` heading.

    Unless the repetition is the point, and it is declared to be. A network security
    group's rules are listed under an `Inbound` label and an `Outbound` one, once per
    group, exactly as `ReportA.dc.html` lists them — the same fixed string once per
    resource is the correct rendering there. `repeats_per_resource: true` is how the
    catalogue says so, so the defect this guard names stays a failure and the deliberate
    case stays expressible without either one having to look like the other.
    """
    if config.get("repeats_per_resource") is True:
        return
    if "title_id" in config:
        raise CompileFailedError(
            f"section {entry.key!r}: a per-resource heading declares "
            f"title_id={config['title_id']!r}, which would emit that one title once per "
            f"resource. A per-resource heading is titled by its resource; use "
            f"per='section' for a fixed title."
        )


def _thread_metric_config(
    expansion: SectionExpansionBlock,
    entry: SectionCatalogueEntry,
    section: Mapping[str, object],
    config: dict[str, object],
) -> None:
    """Fill a metric-bearing expansion's config from the section's own selected metrics
    and the catalogue entry's declared `order_by`/`trend_metric` (task 7.3's own finding).

    `expand_sections` sets each block's `scope_override` from the section's `selection`
    already; this is the missing half — its `metrics` — and only for the three block
    types that need exactly this shape:

    * `timeseries_chart` needs `config.metrics`: the section's own selected metrics,
      unchanged. A chart plots every selected metric as its own series (task 5.1-5.4's
      own panelling then decides how many panels those series need).
    * `metric_summary` needs the same `config.metrics`, and takes it through the same
      branch: it summarises exactly the metrics the chart plots, which is what keeps the
      table under a chart describing the chart above it.
    * `top_n_table` needs `config.columns` (the section's own selected metrics again —
      the table shows every selected metric as a column) and `config.order_by` (which
      metric+statistic ranks the table). `order_by` is the catalogue entry's own
      declaration, never inferred from the section's own selection order — the wizard's
      metric chips are a set, not a ranked list, and ranking by "whichever was clicked
      first" would make the ranking depend on an interaction artifact.
    * `historical_trend` takes one metric/statistic per chart. `_historical_configs`
      expands the selected set; the catalogue default supports older empty selections.
      The lookback always comes from the profile.

    Does nothing for any other block type, and does nothing when the entry declares
    neither `order_by` nor `trend_metric` (the metric-bearing sections this doesn't
    apply to today).
    """
    section_metrics = section.get("metrics")
    if expansion.block in ("timeseries_chart", "metric_summary"):
        if (
            "metrics" not in config
            and isinstance(section_metrics, Sequence)
            and not isinstance(section_metrics, str)
        ):
            selected = list(section_metrics)
            # Every selected metric belongs in the report, not only the ranking metric.
            config.pop("metrics_from", None)
            config["metrics"] = selected
    elif expansion.block == "resource_table":
        # A metric-bearing section's per-resource resource_table needs the same
        # `columns` the chart needs `metrics` — the section's own selected metrics,
        # shown as columns rather than plotted as series. Not one of the three
        # bindings first named, but the identical shape of gap: `vm_utilization`'s own
        # `resource_table` expansion carries no `columns` config either, and fails to
        # compile for the same reason `timeseries_chart` did before this fix.
        #
        # Only fills `columns` when the catalogue declared none — a section like
        # `recommendations` (task 6.4) declares its own static fact-key columns on
        # this exact block type, and that declaration must always win over a
        # metrics-derived one this section never asked for.
        if (
            "columns" not in config
            and isinstance(section_metrics, Sequence)
            and not isinstance(section_metrics, str)
        ):
            config["columns"] = list(section_metrics)
    elif expansion.block == "top_n_table":
        if (
            "columns" not in config
            and isinstance(section_metrics, Sequence)
            and not isinstance(section_metrics, str)
        ):
            config["columns"] = list(section_metrics)
        if "order_by" not in config and entry.order_by is not None:
            order_metric, order_stat = entry.order_by
            config["order_by"] = {"metric": order_metric, "statistic": order_stat}
    elif expansion.block == "historical_trend":
        if "metric" not in config and "statistic" not in config and entry.trend_metric is not None:
            trend_metric_name, trend_stat = entry.trend_metric
            config["metric"] = trend_metric_name
            config["statistic"] = trend_stat
        # `lookback` is author-set on the section, with no catalogue default (task
        # 7.3's own ruling): a default would make every profile print a history depth
        # nobody chose, and `verify/derived_counts.py` re-derives and VERIFIES it as a
        # `derived_count("historical_lookback", ...)` — a catalogue default here would
        # make that a verified claim no human made. Absent is a compile-time failure
        # naming `config.lookback`, not a silent fallback.
        lookback = section.get("lookback")
        if (
            "lookback" not in config
            and isinstance(lookback, int)
            and not isinstance(lookback, bool)
        ):
            config["lookback"] = lookback


def _historical_configs(expansion, entry, section):
    """One chart configuration per selected metric/statistic; shared with collection."""
    base = dict(expansion.config)
    _thread_metric_config(expansion, entry, section, base)
    selected = section.get("metrics")
    if not isinstance(selected, Sequence) or isinstance(selected, str) or not selected:
        return [base]
    pairs = sorted({(str(ref["metric"]), str(ref["statistic"])) for ref in selected
                    if isinstance(ref, Mapping) and ref.get("metric") and ref.get("statistic")})
    # Retain the old default block's id where it is still selected.
    default = (base.get("metric"), base.get("statistic"))
    pairs.sort(key=lambda pair: (pair != default, pair))
    return [{**base, "metric": metric, "statistic": statistic} for metric, statistic in pairs]


def _chart_chunks(config: Mapping[str, object]) -> list[list[object]]:
    """A per-resource chart's metrics, split into the charts it takes.

    Keeps unlike metrics in separate figures and preserves every selection without
    exceeding the chart compiler's per-chart series bound. Always at least one chunk, so a
    chart with no metric still compiles into the statement that it has none.
    """
    from reporting_agent.compile.blocks.charts import MAX_CHART_SERIES

    grouped: dict[object, list[object]] = {}
    metrics = config.get("metrics", [])
    for ref in metrics if isinstance(metrics, Sequence) and not isinstance(metrics, str) else ():
        grouped.setdefault(ref.get("metric") if isinstance(ref, Mapping) else None, []).append(ref)
    chunks = [refs[start:start + MAX_CHART_SERIES] for refs in grouped.values()
              for start in range(0, len(refs), MAX_CHART_SERIES)]
    return chunks or [[]]


def _expand_one_section(
    section: Mapping[str, object],
    entry: SectionCatalogueEntry,
    view: SnapshotView,
    messages: Messages,
) -> tuple[BlockSpec, ...]:
    """Expand one section into its BlockSpec sequence.

    For ``per: "section"`` entries: one BlockSpec with id ``<section_id>__<exp_index>``.
    For ``per: "resource"`` entries: one BlockSpec per resolved resource, with id
    ``<section_id>__<exp_index>__<resource_ordinal>``.

    ## Consecutive per-resource expansions are emitted resource-major

    A run of adjacent ``per: "resource"`` expansions emits **every block of one resource
    before moving to the next**, not every resource of one block. `vm_utilization`
    expands to a heading, a detail table, a chart and a summary per machine; block-major
    order would put all three headings together, then all three detail tables, then all
    three charts — a section that lists its machines' names, then their sizes, then their
    graphs, with nothing connecting a graph to the name four pages above it.

    This changes nothing for a section with a single per-resource expansion, where the
    two orders coincide — which is every section that shipped before `vm_utilization`
    grew its per-machine shape, so no existing block id or position moves.

    Block **ids** keep the ``<expansion_index>__<resource_ordinal>`` scheme regardless of
    emission order: an id names which expansion and which resource a block came from, and
    tying it to document position instead would renumber every block whenever a section
    gained one.
    """
    section_id: str = section.get("id", "")  # type: ignore[assignment]
    if not isinstance(section_id, str) or not section_id:
        raise CompileFailedError("a section carries no usable id")

    scope_override = _build_scope_override(section)
    presentation = _presentation_of(section)

    result: list[BlockSpec] = []
    expansion_index = 0

    # The emitted expansions, paired with the index each one keeps in its block ids.
    #
    # An expansion filtered out by presentation consumes **no** index — the numbering is
    # over what was emitted, not over what the catalogue declared. That is what shipped,
    # and it is what every stored ledger's figure paths are rooted at, so changing it
    # would move the block ids of already-delivered reports and fail their replay on a
    # document nothing is wrong with. The numbering is separated from the emission loop
    # here only so a run of per-resource expansions can be emitted resource-major below;
    # which index each one gets is unchanged.
    emitted: list[tuple[int, SectionExpansionBlock]] = []
    for expansion in entry.expands_to:
        if _should_emit(expansion, presentation):
            emitted.append((expansion_index, expansion))
            expansion_index += 1

    position = 0
    while position < len(emitted):
        index, expansion = emitted[position]

        if expansion.per == "section":
            config: dict[str, object] = dict(expansion.config)
            if expansion.block == "heading":
                _resolve_heading_text(expansion, entry, config, messages)
            _thread_metric_config(expansion, entry, section, config)
            # An author-filled section's typed rows — the incidents a consultant entered on
            # the run form, placed on the section by `apply_author_rows` — print ahead of
            # its table's blank rows.
            if entry.author_filled and expansion.block == BLANK_ROWS_BLOCK:
                supplied = section.get(SUPPLIED_ROWS_KEY)
                if supplied:
                    config[SUPPLIED_ROWS_KEY] = supplied
            configs = _historical_configs(expansion, entry, section) if expansion.block == "historical_trend" else [config]
            for metric_index, metric_config in enumerate(configs):
                suffix = "" if metric_index == 0 else f"__metric_{metric_index}"
                result.append(BlockSpec(
                    id=f"{section_id}__{index}{suffix}",
                    type=expansion.block,
                    config=metric_config,
                    scope_override=scope_override,
                ))
            position += 1
            continue

        if expansion.per != "resource":
            raise CompileFailedError(
                f"section {section_id!r}: expansion block declares unknown per={expansion.per!r}"
            )

        # The whole adjacent run of per-resource expansions, emitted resource-major.
        run: list[tuple[int, SectionExpansionBlock]] = []
        while position < len(emitted) and emitted[position][1].per == "resource":
            run.append(emitted[position])
            position += 1

        run_configs: list[tuple[int | str, SectionExpansionBlock, dict[str, object]]] = []
        for run_index, run_expansion in run:
            run_config: dict[str, object] = dict(run_expansion.config)
            if run_expansion.block == "heading":
                _assert_resource_heading_untitled(entry, run_config)
                # A label repeated under each resource resolves its own title here, the
                # way a per-section heading does. Resolving it below, where the resource
                # name is written, would be too late — that assignment is what a label
                # exists to opt out of.
                if run_config.pop("repeats_per_resource", None) is True:
                    _resolve_heading_text(run_expansion, entry, run_config, messages)
            _thread_metric_config(run_expansion, entry, section, run_config)
            if run_expansion.block == "historical_trend":
                for metric_index, metric_config in enumerate(_historical_configs(run_expansion, entry, section)):
                    chart_id = run_index if metric_index == 0 else f"{run_index}__metric_{metric_index}"
                    run_configs.append((chart_id, run_expansion, metric_config))
            elif run_expansion.block == "timeseries_chart":
                for chart_index, refs in enumerate(_chart_chunks(run_config)):
                    chart_id = run_index if chart_index == 0 else f"{run_index}__metric_{chart_index}"
                    run_configs.append((chart_id, run_expansion, {**run_config, "metrics": refs}))
            else:
                run_configs.append((run_index, run_expansion, run_config))

        # Resolve to get the deterministic resource order
        if scope_override is not None:
            resolved = resolve(scope_override, view)
        else:
            resolved = view.resources

        for resource_ordinal, resource in enumerate(resolved):
            for index, expansion, config in run_configs:
                block_id = f"{section_id}__{index}__{resource_ordinal}"
                # Carry the section's selection as scope_override, plus the resource this
                # block is *for*, so `BlockContext.resources_for` can narrow the section's
                # resolution to it. Without that narrowing every block of the expansion
                # renders the whole section scope, which is three identical NSG rule tables
                # for three NSGs.
                #
                # The id rather than the ordinal it used to write: the expander resolves
                # `scope_override or view.resources` and a compiler resolves
                # `scope_override or default_scope`, and an ordinal into a list resolved a
                # second way mis-selects silently if those ever differ. It never reaches the
                # stored definition — this config is built per run, from the live snapshot,
                # and a replay rebuilds it from the pinned one.
                per_resource_config = dict(config)
                per_resource_config[RESOURCE_ID_CONFIG_KEY] = resource.resource_id
                if expansion.block == "heading" and "text" not in per_resource_config:
                    # A per-resource heading names its resource. `resolved` is the
                    # snapshot's own order, so this is as deterministic as the ordinal
                    # beside it.
                    #
                    # Unless it already carries a text: a label declared with
                    # `repeats_per_resource` resolved its own title above, and overwriting
                    # it here would put the group's name where `Inbound` belongs.
                    per_resource_config["text"] = resource.name
                result.append(BlockSpec(
                    id=block_id,
                    type=expansion.block,
                    config=per_resource_config,
                    scope_override=scope_override,
                ))

    return tuple(result)


# ---------------------------------------------------------------------------
# Schema v4: a section's own layout
# ---------------------------------------------------------------------------
#
# A v4 section may carry `blocks`: the catalogue's slots in the author's order, hidden or
# configured, with text the author added. Absent, a section prints exactly as the
# catalogue lays it out — the v3 `chart_and_table` document, block for block.
#
# Block ids are named by slot rather than numbered by expansion index:
#   ``<section.id>__<slot>``                      per section
#   ``<section.id>__<slot>__<n>``                 per resource
#   ``<section.id>__<slot>__m<k>[__<n>]``         a second and later chart of one block
#   ``<section.id>__<u_id>``                      a block the author added
# so hiding or moving one block never renumbers another. The v3 scheme above is untouched:
# every delivered v3 report re-verifies by recompiling, byte for byte.


@dataclass(frozen=True, slots=True)
class _Placed:
    """One visible entry of a v4 section's layout.

    A catalogue block (`expansion` set), a block the author added (`expansion` None, the
    entry in `settings`), or the per-resource group (`group` non-empty)."""

    expansion: SectionExpansionBlock | None
    settings: Mapping[str, object]
    group: tuple[_Placed, ...] = ()


def _listed(raw: object) -> list[Mapping[str, object]]:
    if not isinstance(raw, Sequence) or isinstance(raw, str):
        return []
    return [item for item in raw if isinstance(item, Mapping)]


def _v4_layout(
    section: Mapping[str, object], entry: SectionCatalogueEntry
) -> tuple[_Placed, ...]:
    """A v4 section's visible blocks in print order.

    The author's `blocks` first, in their order; then any catalogue slot it does not name,
    in catalogue order, so a slot the catalogue gains later still prints. Hidden entries
    are dropped here, which is the only place visibility is decided.
    """
    by_slot = {expansion.slot: expansion for expansion in entry.expands_to}
    catalogue_order: list[str] = []
    for expansion in entry.expands_to:
        name = EACH_RESOURCE_SLOT if expansion.per == "resource" else expansion.slot
        if name not in catalogue_order:
            catalogue_order.append(name)
    resource_slots = [expansion.slot for expansion in entry.expands_to if expansion.per == "resource"]

    authored = _listed(section.get("blocks"))
    named = {item.get("slot") for item in authored if "slot" in item}
    ordered = authored + [{"slot": name} for name in catalogue_order if name not in named]

    placed: list[_Placed] = []
    for item in ordered:
        if "kind" in item:
            placed.append(_Placed(expansion=None, settings=item))
            continue
        if item.get("hidden") is True:
            continue
        slot = item.get("slot")
        if slot == EACH_RESOURCE_SLOT:
            inner = _listed(item.get("blocks"))
            inner_named = {child.get("slot") for child in inner}
            inner += [{"slot": name} for name in resource_slots if name not in inner_named]
            group = tuple(
                _Placed(expansion=by_slot[str(child.get("slot"))], settings=child)
                for child in inner
                if child.get("hidden") is not True and child.get("slot") in by_slot
            )
            if group:
                placed.append(_Placed(expansion=None, settings=item, group=group))
            continue
        if isinstance(slot, str) and slot in by_slot:
            placed.append(_Placed(expansion=by_slot[slot], settings=item))
    return tuple(placed)


def _column_key(column: object) -> object:
    if isinstance(column, Mapping):
        return column.get("fact_key") or column.get("attribute")
    return None


def _apply_v4_settings(
    expansion: SectionExpansionBlock,
    entry: SectionCatalogueEntry,
    settings: Mapping[str, object],
    config: dict[str, object],
    messages: Messages,
) -> None:
    """The author's settings on one catalogue block, applied to its config in place.

    `title` replaces a section heading's catalogue title with words the author typed, in
    the report's language. `columns` narrows and reorders a table's declared columns.
    Both were validated against this slot before the run began.
    """
    title = settings.get("title")
    if expansion.block == "heading" and expansion.per == "section":
        if isinstance(title, Mapping) and isinstance(title.get(messages.language), str):
            config.pop("title_id", None)
            config["text"] = title[messages.language]
        else:
            _resolve_heading_text(expansion, entry, config, messages)
    columns = settings.get("columns")
    declared = config.get("columns")
    if (
        expansion.block == "resource_table"
        and isinstance(columns, Sequence)
        and not isinstance(columns, str)
        and isinstance(declared, Sequence)
        and not isinstance(declared, str)
    ):
        by_key = {_column_key(column): column for column in declared}
        config["columns"] = [by_key[key] for key in columns if key in by_key]


def _expand_one_section_v4(
    section: Mapping[str, object],
    entry: SectionCatalogueEntry,
    view: SnapshotView,
    messages: Messages,
) -> tuple[BlockSpec, ...]:
    """Expand one v4 section into its BlockSpec sequence, in the author's layout.

    The same compile as v3 for each block — metrics threaded the same way, typed incident
    rows placed the same way, the per-resource group emitted resource-major — with the
    layout, the overrides and the slot-named ids being what v4 adds.
    """
    section_id = section.get("id", "")
    if not isinstance(section_id, str) or not section_id:
        raise CompileFailedError("a section carries no usable id")

    scope_override = _build_scope_override(section)
    result: list[BlockSpec] = []

    for item in _v4_layout(section, entry):
        if item.group:
            result.extend(
                _expand_resource_group_v4(section_id, section, entry, item.group, scope_override, view, messages)
            )
            continue

        if item.expansion is None:
            result.extend(_added_blocks(section_id, section, entry, item.settings, scope_override, messages))
            continue

        expansion = item.expansion
        config: dict[str, object] = dict(expansion.config)
        _apply_v4_settings(expansion, entry, item.settings, config, messages)
        _thread_metric_config(expansion, entry, section, config)
        if entry.author_filled and expansion.block == BLANK_ROWS_BLOCK:
            supplied = section.get(SUPPLIED_ROWS_KEY)
            if supplied:
                config[SUPPLIED_ROWS_KEY] = supplied
        configs = (
            _historical_configs(expansion, entry, section)
            if expansion.block == "historical_trend"
            else [config]
        )
        for metric_index, metric_config in enumerate(configs):
            suffix = "" if metric_index == 0 else f"__m{metric_index}"
            result.append(BlockSpec(
                id=f"{section_id}__{expansion.slot}{suffix}",
                type=expansion.block,
                config=metric_config,
                scope_override=scope_override,
            ))

    return tuple(result)


PREVIOUS_PERIOD_LOOKBACK: Final[int] = 1
"""The prior-run selection a month-vs-month block reads: the one latest verified report.

A `historical_trend` key with a lookback of one, so the pipeline fetches, records and — on
re-verification — reloads that report's snapshot through the same path a trend uses."""


def _section_metric_refs(section: Mapping[str, object]) -> list[dict[str, object]]:
    metrics = section.get("metrics")
    if not isinstance(metrics, Sequence) or isinstance(metrics, str):
        return []
    return [dict(item) for item in metrics if isinstance(item, Mapping)]


def _first_metric(section: Mapping[str, object]) -> tuple[str, str] | None:
    for item in _section_metric_refs(section):
        name = item.get("metric") or item.get("derived")
        statistic = item.get("statistic")
        if isinstance(name, str) and name and isinstance(statistic, str) and statistic:
            return (name, statistic)
    return None


def _ranking_of(section: Mapping[str, object], entry: SectionCatalogueEntry) -> tuple[str, str] | None:
    """What a section ranks by: its own top-N rule, else the catalogue's, else its first metric."""
    selection = section.get("selection")
    top_n = selection.get("top_n") if isinstance(selection, Mapping) else None
    if isinstance(top_n, Mapping) and isinstance(top_n.get("metric"), str) and isinstance(top_n.get("statistic"), str):
        return (str(top_n["metric"]), str(top_n["statistic"]))
    selected = {
        (str(item.get("metric") or item.get("derived")), str(item.get("statistic")))
        for item in _section_metric_refs(section)
    }
    # The catalogue's ranking only where the section collects it: an author who chose other
    # metrics would otherwise get a ranking column with nothing in it.
    if entry.order_by is not None and entry.order_by in selected:
        return entry.order_by
    return _first_metric(section)


TOP_LIST_DEFAULT_COUNT: Final[int] = 10
"""How many resources an added top list ranks when the section sets no top-N of its own."""


SPARKLINE_ROWS: Final[int] = 5
"""The resources a sparkline table draws: a chart's series bound, ranked by the section."""


def _ranked_scope(
    scope_override: ScopeRules | None, metric: str, statistic: str, count: int
) -> ScopeRules:
    """The section's scope ranked by `metric`, keeping its own top-N where it has one."""
    base = scope_override or ScopeRules()
    if base.top_n is not None:
        return base
    return replace(
        base,
        top_n=TopNRule(count=count, metric=metric, statistic=statistic),
        sort=base.sort or "descending",
    )


def _added_blocks(
    section_id: str,
    section: Mapping[str, object],
    entry: SectionCatalogueEntry,
    settings: Mapping[str, object],
    scope_override: ScopeRules | None,
    messages: Messages,
) -> list[BlockSpec]:
    """The block — or, for a sparkline table, the two — an added entry compiles to."""
    kind = settings.get("kind")
    block_id = f"{section_id}__{settings.get('id')}"
    if kind == "callout":
        return [_callout_block(block_id, section, entry, settings, scope_override, messages)]
    if kind in ("heatmap", "sparklines"):
        ranking = _ranking_of(section, entry)
        if ranking is None:
            raise CompileFailedError(
                f"section {section_id!r}: block {settings.get('id')!r} reads metrics, and the "
                f"section selects none"
            )
        metric, statistic = ranking
        ref = {"metric": metric, "statistic": statistic}
        if kind == "heatmap":
            from reporting_agent.compile.blocks.charts import HEATMAP_LAYOUT, MAX_HEATMAP_ROWS

            return [BlockSpec(
                id=block_id,
                type="timeseries_chart",
                config={"metrics": [ref], "layout": HEATMAP_LAYOUT},
                scope_override=_ranked_scope(scope_override, metric, statistic, MAX_HEATMAP_ROWS),
            )]
        ranked = _ranked_scope(scope_override, metric, statistic, SPARKLINE_ROWS)
        return [
            BlockSpec(
                id=f"{block_id}__chart",
                type="timeseries_chart",
                config={"metrics": [ref], "style": "sparkline"},
                scope_override=ranked,
            ),
            BlockSpec(
                id=f"{block_id}__summary",
                type="metric_summary",
                config={"metrics": [ref], "orientation": "resource_major"},
                scope_override=ranked,
            ),
        ]
    return [_added_block(section_id, section, entry, settings, scope_override, messages)]


def _callout_block(
    block_id: str,
    section: Mapping[str, object],
    entry: SectionCatalogueEntry,
    settings: Mapping[str, object],
    scope_override: ScopeRules | None,
    messages: Messages,
) -> BlockSpec:
    """A callout: the author's words in the report's language, and the condition that prints
    them. A peak condition reads the section's ranking metric."""
    from reporting_agent.compile.blocks.callout import CALLOUT_CONDITION_KEY

    text = settings.get("text")
    value = text.get(messages.language) if isinstance(text, Mapping) else None
    if not isinstance(value, str) or not value:
        raise CompileFailedError(f"{block_id}: a callout has no text in {messages.language!r}")
    condition: dict[str, object] = {"when": settings.get("when"), "tone": settings.get("tone", "info")}
    if settings.get("when") == "peak_at_or_above":
        ranking = _ranking_of(section, entry)
        if ranking is None:
            raise CompileFailedError(f"{block_id}: a peak callout needs the section to select a metric")
        condition.update(metric=ranking[0], statistic=ranking[1], threshold=settings.get("threshold"))
    return BlockSpec(
        id=block_id,
        type="rich_text",
        config={"text": value, CALLOUT_CONDITION_KEY: condition},
        scope_override=scope_override,
    )


def _added_block(
    section_id: str,
    section: Mapping[str, object],
    entry: SectionCatalogueEntry,
    settings: Mapping[str, object],
    scope_override: ScopeRules | None,
    messages: Messages,
) -> BlockSpec:
    """A block the author placed in a v4 section, configured from the section it sits in.

    Text prints the author's words in the report's language. The others are catalogue
    blocks with nothing of their own to configure: they read the section's metrics and its
    selection, so what the author chose for the section is what they show.
    """
    kind = settings.get("kind")
    block_id = f"{section_id}__{settings.get('id')}"

    if kind == "text":
        text = settings.get("text")
        value = text.get(messages.language) if isinstance(text, Mapping) else None
        if not isinstance(value, str) or not value:
            raise CompileFailedError(
                f"section {section_id!r}: block {settings.get('id')!r} has no text in "
                f"{messages.language!r}"
            )
        return BlockSpec(id=block_id, type="rich_text", config={"text": value}, scope_override=None)

    if kind == "page_break":
        return BlockSpec(id=block_id, type="page_break", config={}, scope_override=None)

    if kind == "coverage":
        return BlockSpec(id=block_id, type="gaps_and_coverage", config={}, scope_override=None)

    metrics = _section_metric_refs(section)
    if kind == "key_figures":
        return BlockSpec(id=block_id, type="kpi_row", config={"metrics": metrics}, scope_override=scope_override)

    ranking = _ranking_of(section, entry)
    if ranking is None:
        raise CompileFailedError(
            f"section {section_id!r}: block {settings.get('id')!r} reads metrics, and the "
            f"section selects none"
        )
    metric, statistic = ranking

    if kind == "top_list":
        # Ranked by the section's own top-N rule where it has one; otherwise the top ten by
        # the ranking metric, so a "top list" is a ranking and never the whole estate.
        ranked = _ranked_scope(scope_override, metric, statistic, TOP_LIST_DEFAULT_COUNT)
        return BlockSpec(
            id=block_id,
            type="top_n_table",
            config={"columns": metrics, "order_by": {"metric": metric, "statistic": statistic}},
            scope_override=ranked,
        )

    if kind == "month_vs_month":
        return BlockSpec(
            id=block_id,
            type="comparison_delta",
            config={
                "against": "previous",
                "metric": metric,
                "statistic": statistic,
                "lookback": PREVIOUS_PERIOD_LOOKBACK,
            },
            scope_override=scope_override,
        )

    raise CompileFailedError(f"section {section_id!r}: unknown added block kind {kind!r}")


def _expand_resource_group_v4(
    section_id: str,
    section: Mapping[str, object],
    entry: SectionCatalogueEntry,
    group: tuple[_Placed, ...],
    scope_override: ScopeRules | None,
    view: SnapshotView,
    messages: Messages,
) -> list[BlockSpec]:
    """The per-resource group, emitted resource-major as v3 emits it: every block of one
    resource, in the author's order, before the next resource."""
    planned: list[tuple[str, SectionExpansionBlock, dict[str, object]]] = []
    for item in group:
        expansion = item.expansion
        assert expansion is not None  # a group holds catalogue blocks only
        config: dict[str, object] = dict(expansion.config)
        if expansion.block == "heading":
            _assert_resource_heading_untitled(entry, config)
            if config.pop("repeats_per_resource", None) is True:
                _resolve_heading_text(expansion, entry, config, messages)
        _apply_v4_settings(expansion, entry, item.settings, config, messages)
        _thread_metric_config(expansion, entry, section, config)
        if expansion.block == "historical_trend":
            for metric_index, metric_config in enumerate(_historical_configs(expansion, entry, section)):
                name = expansion.slot if metric_index == 0 else f"{expansion.slot}__m{metric_index}"
                planned.append((name, expansion, metric_config))
        elif expansion.block == "timeseries_chart":
            for chart_index, refs in enumerate(_chart_chunks(config)):
                name = expansion.slot if chart_index == 0 else f"{expansion.slot}__m{chart_index}"
                planned.append((name, expansion, {**config, "metrics": refs}))
        else:
            planned.append((expansion.slot, expansion, config))

    resolved = resolve(scope_override, view) if scope_override is not None else view.resources
    specs: list[BlockSpec] = []
    for resource_ordinal, resource in enumerate(resolved):
        for name, expansion, config in planned:
            per_resource_config = dict(config)
            per_resource_config[RESOURCE_ID_CONFIG_KEY] = resource.resource_id
            if expansion.block == "heading" and "text" not in per_resource_config:
                per_resource_config["text"] = resource.name
            specs.append(BlockSpec(
                id=f"{section_id}__{name}__{resource_ordinal}",
                type=expansion.block,
                config=per_resource_config,
                scope_override=scope_override,
            ))
    return specs


def _visible_expansions(
    section: Mapping[str, object], entry: SectionCatalogueEntry, schema_version: object
) -> list[SectionExpansionBlock]:
    """The catalogue blocks a section will emit: by presentation at v3, by layout at v4."""
    if isinstance(schema_version, int) and schema_version >= 4:
        visible: list[SectionExpansionBlock] = []
        for item in _v4_layout(section, entry):
            if item.group:
                visible.extend(child.expansion for child in item.group if child.expansion is not None)
            elif item.expansion is not None:
                visible.append(item.expansion)
        return visible
    presentation = _presentation_of(section)
    return [expansion for expansion in entry.expands_to if _should_emit(expansion, presentation)]


# ---------------------------------------------------------------------------
# Drift (task 3.11)
# ---------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class AuthoredMatch:
    """One section's recorded matched-resource set from a prior publish (task 3.10's
    `report_profile_authored_matches` row, read by the caller — this module never
    touches a database).

    Carries only what drift needs: the resource ids as they stood when the profile was
    last authored. `matched_count` is not stored here — the count is `len(resource_ids)`,
    always, and storing it separately would let the two disagree.
    """

    resource_ids: frozenset[str]


@dataclass(frozen=True, slots=True)
class SectionDrift:
    """The difference between one section's `AuthoredMatch` and what its rule resolves
    to against the CURRENT snapshot — ordered tuples, not sets, so the coverage
    appendix's rows are deterministic across repeated compiles of the same inputs.
    """

    section_id: str
    added: tuple[str, ...]
    """Resource ids the current snapshot resolves that the authored match did not."""
    removed: tuple[str, ...]
    """Resource ids the authored match recorded that the current snapshot no longer
    resolves — deallocated, deleted, or moved out of scope."""


def compute_section_drift(
    definition: Mapping[str, object],
    *,
    catalogue: LoadedSectionCatalogue,
    view: SnapshotView,
    authored_matches: Mapping[str, AuthoredMatch],
) -> tuple[SectionDrift, ...]:
    """One `SectionDrift` per authored section that HAS a recorded `AuthoredMatch`,
    comparing it against what that section's own rule resolves against `view` today.

    **Pure.** No Azure, no ledger, no I/O — `authored_matches` arrives as a value the
    caller already read from the database, the same "caller fetches, pure module folds"
    split `compile/blocks/base.py`'s `historical_selections` and `comparison` already
    follow.

    A section with no entry in `authored_matches` (the profile has never been
    published, or this section was added since) is skipped entirely rather than
    reported as "everything added" — an appendix comparing against a match that was
    never recorded would be comparing against nothing, which is not a fact about drift.

    Every result — including a section whose rule resolves to exactly what was
    authored — is still included as a `SectionDrift` with two empty tuples. Req 19.3's
    "every matched resource is included and announced, never withheld pending
    confirmation, never excluded silently" is about a **row of the appendix table**,
    not about non-empty drift cases only; filtering empties out here would exclude the
    "no drift" fact silently, which is exactly the announcement Req 19.3 requires.
    """
    drifts: list[SectionDrift] = []

    raw_sections = definition.get("sections")
    if not isinstance(raw_sections, Sequence) or isinstance(raw_sections, str):
        return ()

    for section in raw_sections:
        if not isinstance(section, Mapping):
            continue
        section_id = section.get("id")
        if not isinstance(section_id, str) or not section_id:
            continue

        recorded = authored_matches.get(section_id)
        if recorded is None:
            continue

        section_type = section.get("type")
        entry = catalogue.by_key(section_type) if isinstance(section_type, str) else None
        if entry is None:
            continue

        scope_override = _build_scope_override(section)
        resolved = resolve(scope_override, view) if scope_override is not None else view.resources

        current_ids = frozenset(resource.resource_id for resource in resolved)

        added = tuple(sorted(current_ids - recorded.resource_ids))
        removed = tuple(sorted(recorded.resource_ids - current_ids))

        drifts.append(SectionDrift(section_id=section_id, added=added, removed=removed))

    return tuple(drifts)


def historical_trend_keys(
    definition: Mapping[str, object],
    *,
    catalogue: LoadedSectionCatalogue,
) -> set[tuple[str, str, int]]:
    """The distinct ``(metric, statistic, lookback)`` keys a v3 definition's sections
    will compile into ``historical_trend`` blocks.

    **Pure**, and deliberately **view-free**: a `historical_trend` expansion is declared
    `per: "section"`, so no resource resolution changes which keys exist. That is what
    lets the pipeline call this *before* it has a snapshot view — it needs the keys in
    order to fetch the prior runs whose values the compile will then plot.

    ## Why this lives beside `expand_sections` rather than in the pipeline

    The pipeline's own walker read `definition["blocks"]` — the v2 shape — and a v3
    definition carries `sections`, so it returned the empty set for every profile the
    wizard writes. Nothing failed: the keys being empty means no candidate is ever
    selected, and `historical_trend` then compiles the "no prior verified period"
    statement, which is a sentence the block is *supposed* to be able to print. A
    correct-looking report with an empty trend was the only symptom.

    The repair is not a second walker that knows about sections; it is one function, in
    the module that owns the expansion rules, calling the same `_should_emit` and
    `_thread_metric_config` the expansion itself calls. A key this returns and a block
    `expand_sections` emits cannot disagree about the catalogue's `trend_metric` or the
    section's `lookback`, because neither reads those directly.
    """
    raw_sections = definition.get("sections")
    if not isinstance(raw_sections, Sequence) or isinstance(raw_sections, str):
        return set()

    keys: set[tuple[str, str, int]] = set()
    for section in raw_sections:
        if not isinstance(section, Mapping):
            continue
        section_type = section.get("type")
        if not isinstance(section_type, str) or not section_type:
            continue
        entry = catalogue.by_key(section_type)
        if entry is None:
            # Not this function's failure to report. `expand_sections` raises
            # `CompileFailedError` on an unknown type a few moments later, with the
            # section id in the message; refusing here would only move that same
            # failure earlier and word it worse.
            continue

        version = definition.get("schema_version")
        if isinstance(version, int) and version >= 4:
            for item in _listed(section.get("blocks")):
                if item.get("kind") == "month_vs_month":
                    ranking = _ranking_of(section, entry)
                    if ranking is not None:
                        keys.add((*ranking, PREVIOUS_PERIOD_LOOKBACK))
        for expansion in _visible_expansions(section, entry, version):
            if expansion.block != "historical_trend":
                continue
            for config in _historical_configs(expansion, entry, section):
                metric, statistic, lookback = config.get("metric"), config.get("statistic"), config.get("lookback")
                if isinstance(metric, str) and isinstance(statistic, str) and isinstance(lookback, int) and not isinstance(lookback, bool):
                    keys.add((metric, statistic, lookback))
    return keys


AUTHOR_ROWS_PAYLOAD_KEY: Final[str] = "author_rows"
"""The payload key the app sends typed rows under, by section type — `lib/runs/invoke.ts`."""

SUPPLIED_ROWS_KEY: Final[str] = "supplied_rows"
BLANK_ROWS_BLOCK: Final[str] = "blank_rows_table"
MAX_AUTHOR_ROWS: Final[int] = 50
MAX_AUTHOR_CELL_CHARS: Final[int] = 2000


def apply_author_rows(
    definition: Mapping[str, object],
    author_rows: object,
    *,
    catalogue: LoadedSectionCatalogue,
) -> Mapping[str, object]:
    """The definition this run compiles and verifies, with its typed rows placed.

    `author_rows` maps an **author-filled** section type — today `incident_report` — to the
    rows a consultant typed on the run form for that run, one string per column of the
    section's table. Each goes onto every section of that type as `supplied_rows`, which
    :func:`expand_sections` hands to the table; they print ahead of its blank rows.

    Returned as a new definition rather than applied to the pinned one in place, and used
    for **both** the compile and the verification: the verifier renders the definition to
    learn what text is the template's own, so rows the compile printed and the verifier
    never saw would read as unproven numbers in a correct report — a date typed into an
    incident, for one.

    Anything malformed is refused rather than trimmed: the app validates these before they
    are stored, so a bad shape here is a contract break, not a typing mistake.
    """
    if author_rows is None:
        return definition
    if not isinstance(author_rows, Mapping):
        raise CompileFailedError(f"{AUTHOR_ROWS_PAYLOAD_KEY} must be an object")
    sections = definition.get("sections")
    if not author_rows or not isinstance(sections, list):
        return definition

    placed: dict[str, list[list[str]]] = {}
    for section_type, rows in author_rows.items():
        entry = catalogue.by_key(section_type) if isinstance(section_type, str) else None
        if entry is None or not entry.author_filled:
            raise CompileFailedError(
                f"{AUTHOR_ROWS_PAYLOAD_KEY} names {section_type!r}, which is not an "
                f"author-filled section"
            )
        columns = next(
            (
                dict(expansion.config).get("columns")
                for expansion in entry.expands_to
                if expansion.block == BLANK_ROWS_BLOCK
            ),
            None,
        )
        width = len(columns) if isinstance(columns, (list, tuple)) else 0
        if not isinstance(rows, list) or len(rows) > MAX_AUTHOR_ROWS:
            raise CompileFailedError(
                f"{AUTHOR_ROWS_PAYLOAD_KEY}.{section_type} must be a list of at most "
                f"{MAX_AUTHOR_ROWS} rows"
            )
        for row in rows:
            if (
                not isinstance(row, list)
                or len(row) != width
                or not all(
                    isinstance(cell, str) and len(cell) <= MAX_AUTHOR_CELL_CHARS for cell in row
                )
            ):
                raise CompileFailedError(
                    f"every row in {AUTHOR_ROWS_PAYLOAD_KEY}.{section_type} must be "
                    f"{width} strings of at most {MAX_AUTHOR_CELL_CHARS} characters, one "
                    f"per column of its table"
                )
        placed[section_type] = [list(row) for row in rows]

    return {
        **definition,
        "sections": [
            {**section, SUPPLIED_ROWS_KEY: placed[section["type"]]}
            if isinstance(section, Mapping) and section.get("type") in placed and placed[section["type"]]
            else section
            for section in sections
        ],
    }


def expand_sections(
    definition: Mapping[str, object],
    *,
    catalogue: LoadedSectionCatalogue,
    view: SnapshotView,
    messages: Messages,
) -> tuple[BlockSpec, ...]:
    """Expand a v3 definition's ``sections`` into a flat ordered BlockSpec tuple.

    **Pure.** No Azure, no ledger, no I/O.

    Ordering:
      1. ``group`` order (inventory, utilisation, closing)
      2. Authored ``position`` within a group for ``free`` entries
      3. Catalogue-declared order for ``fixed`` entries (ignoring stored position)
      4. The ``always`` appendix last

    Derived block ids:
      ``<section.id>__<expansion_index>`` for ``per: "section"``
      ``<section.id>__<expansion_index>__<n>`` for ``per: "resource"``

    Args:
        definition: The validated v3 definition mapping.
        catalogue: The loaded and validated section catalogue.
        view: The SnapshotView for scope resolution.
        messages: The resolved `Messages` for the report's language, used to turn a
            heading expansion's `title_id` into its required `text`.

    Returns:
        An ordered tuple of BlockSpec, ready for the three-phase compile loop.

    Raises:
        CompileFailedError: If a section references an unknown catalogue key or
            has a malformed structure.
    """
    raw_sections = definition.get("sections")
    if not isinstance(raw_sections, Sequence) or isinstance(raw_sections, str):
        raise CompileFailedError("a v3 definition carries no sections array")

    # Build the fixed-order lookup from the catalogue's declared fixed entries
    fixed_order: dict[str, int] = {
        entry.key: idx
        for idx, entry in enumerate(catalogue.fixed_entries)
    }

    # Resolve each section to its catalogue entry
    resolved_sections: list[tuple[Mapping[str, object], SectionCatalogueEntry]] = []
    for section in raw_sections:
        if not isinstance(section, Mapping):
            raise CompileFailedError("a section entry must be an object")
        section_type = section.get("type")
        if not isinstance(section_type, str) or not section_type:
            raise CompileFailedError(
                f"section {section.get('id', '?')!r} carries no type"
            )
        entry = catalogue.by_key(section_type)
        if entry is None:
            raise CompileFailedError(
                f"section {section.get('id', '?')!r} declares type {section_type!r} "
                f"which is not in the section catalogue"
            )
        resolved_sections.append((section, entry))

    # Sort: group order → position within group → catalogue number as tiebreaker
    resolved_sections.sort(key=lambda pair: _section_sort_key(pair[0], pair[1], fixed_order))

    # Expand each section in sorted order. v4 lays each section out by its own `blocks`;
    # v3 keeps the expansion every delivered v3 report was compiled with.
    schema_version = definition.get("schema_version")
    expand_one = (
        _expand_one_section_v4
        if isinstance(schema_version, int) and schema_version >= 4
        else _expand_one_section
    )
    all_specs: list[BlockSpec] = []
    for section, entry in resolved_sections:
        specs = expand_one(section, entry, view, messages)
        all_specs.extend(specs)

    return tuple(all_specs)
