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
from dataclasses import dataclass
from typing import Final

from reporting_agent.catalog.loader import (
    LoadedSectionCatalogue,
    SectionCatalogueEntry,
    SectionExpansionBlock,
)
from reporting_agent.compile.blocks.base import BlockSpec
from reporting_agent.compile.messages import Messages
from reporting_agent.compile.scope import ScopeRules, resolve, scope_rules_from_plain
from reporting_agent.compile.snapshot_view import SnapshotView
from reporting_agent.errors import CompileFailedError

__all__ = [
    "GROUP_ORDER",
    "AuthoredMatch",
    "SectionDrift",
    "compute_section_drift",
    "expand_sections",
]

# The canonical group ordering.  Every section declares one of these.
GROUP_ORDER: Final[tuple[str, ...]] = ("inventory", "utilisation", "closing")
"""Document-order groups: inventory first, utilisation second, closing third."""

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
    * `top_n_table` needs `config.columns` (the section's own selected metrics again —
      the table shows every selected metric as a column) and `config.order_by` (which
      metric+statistic ranks the table). `order_by` is the catalogue entry's own
      declaration, never inferred from the section's own selection order — the wizard's
      metric chips are a set, not a ranked list, and ranking by "whichever was clicked
      first" would make the ranking depend on an interaction artifact.
    * `historical_trend` needs exactly one `config.metric` + `config.statistic` (the
      catalogue entry's own `trend_metric`, for the identical "not an interaction
      artifact" reason) plus `config.lookback`, which is NOT a catalogue default — see
      the section's own docstring reference below.

    Does nothing for any other block type, and does nothing when the entry declares
    neither `order_by` nor `trend_metric` (the metric-bearing sections this doesn't
    apply to today).
    """
    section_metrics = section.get("metrics")
    if expansion.block == "timeseries_chart":
        if (
            "metrics" not in config
            and isinstance(section_metrics, Sequence)
            and not isinstance(section_metrics, str)
        ):
            config["metrics"] = list(section_metrics)
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
    """
    section_id: str = section.get("id", "")  # type: ignore[assignment]
    if not isinstance(section_id, str) or not section_id:
        raise CompileFailedError("a section carries no usable id")

    scope_override = _build_scope_override(section)
    presentation: str = section.get("presentation", "chart_and_table")  # type: ignore[assignment]
    if not isinstance(presentation, str):
        presentation = "chart_and_table"

    result: list[BlockSpec] = []
    expansion_index = 0

    for expansion in entry.expands_to:
        if not _should_emit(expansion, presentation):
            continue

        # Build the config from the catalogue's declared config
        config: dict[str, object] = dict(expansion.config)
        if expansion.block == "heading":
            _resolve_heading_text(expansion, entry, config, messages)
        _thread_metric_config(expansion, entry, section, config)

        if expansion.per == "section":
            block_id = f"{section_id}__{expansion_index}"
            result.append(BlockSpec(
                id=block_id,
                type=expansion.block,
                config=config,
                scope_override=scope_override,
            ))
        elif expansion.per == "resource":
            # Resolve to get the deterministic resource order
            if scope_override is not None:
                resolved = resolve(scope_override, view)
            else:
                resolved = view.resources

            for resource_ordinal, _resource in enumerate(resolved):
                block_id = f"{section_id}__{expansion_index}__{resource_ordinal}"
                # Carry the section's selection as scope_override, plus a resource ordinal
                # in config so the block compiler can pick the right one from the resolved
                # set without the id being stored in the definition.
                per_resource_config = dict(config)
                per_resource_config["_resource_ordinal"] = resource_ordinal
                result.append(BlockSpec(
                    id=block_id,
                    type=expansion.block,
                    config=per_resource_config,
                    scope_override=scope_override,
                ))
        else:
            raise CompileFailedError(
                f"section {section_id!r}: expansion block declares unknown per={expansion.per!r}"
            )

        expansion_index += 1

    return tuple(result)


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

    # Expand each section in sorted order
    all_specs: list[BlockSpec] = []
    for section, entry in resolved_sections:
        specs = _expand_one_section(section, entry, view, messages)
        all_specs.extend(specs)

    return tuple(all_specs)
