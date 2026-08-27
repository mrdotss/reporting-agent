"""The ``derived_counts`` gate (Req 19.10).

**Pure**: re-derives each ``DerivedCount`` from the ledger's own content and the
definition's block config, then asserts the stored ``formatted`` value matches. This is
the verification mechanism that replaces the unsound allowlist path for
compile-derived integers.

One blocking finding:

- ``derived_count_mismatch``: the stored count disagrees with what the ledger actually
  contains. Names the block id, the derivation kind, the stored value, and the expected
  value.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

from reporting_agent.compile.ast import CHART_ID_PREFIX, DerivedCount, FigurePath
from reporting_agent.compile.figures import ANCHOR_CHART, FigureLedger
from reporting_agent.verify.findings import Finding, record_finding

__all__ = ["DerivedCountsPass", "check_derived_counts"]

FINDING_DERIVED_COUNT_MISMATCH: Final[str] = "derived_count_mismatch"


@dataclass(frozen=True, slots=True)
class DerivedCountsPass:
    """Result of the ``derived_counts`` gate."""

    findings: tuple[Finding, ...]
    counts_checked: int


def check_derived_counts(
    ledger: FigureLedger,
    *,
    definition: Mapping[str, object],
    view: object | None = None,
    catalogue: object | None = None,
    authored_matches: Mapping[str, object] | None = None,
) -> DerivedCountsPass:
    """Re-derive each DerivedCount and assert it matches the compiled value.

    Parameters
    ----------
    ledger
        The compiled figure ledger (may be a recompiled one for re-verification).
    definition
        The template definition, for reading block config values.
    view, catalogue, authored_matches
        Required only to re-derive `scope_added_count`/`scope_removed_count`
        (task 3.11) — every other kind ignores them. All three default to `None`
        so every existing caller is unaffected; a `scope_added_count`/
        `scope_removed_count` encountered with any of the three missing reports
        as unresolvable (the `derived_count_mismatch` finding with
        `expected="<unresolvable>"`), the same outcome an unrecognized kind
        already gets, rather than silently trusting the compiler's value.

    **Not yet called with these three from `verify.verify()`.** Wiring that
    call site needs `report_pipeline.py` to read a real
    `report_profile_authored_matches` row for the run's template version — and
    `writeAuthoredMatches` (task 3.10) is itself not yet called from the
    publish path, pending an undecided scan-selection design question (asked
    twice this session, recorded on tasks.md). Until a real row can exist, a
    verifier call site reading one would find nothing to check, which would be
    indistinguishable from "verified and found nothing wrong" — worse than not
    wiring it at all. This function is ready for that call the moment the
    upstream question resolves.
    """
    findings: list[Finding] = []
    checked = 0

    for path, count in ledger.derived_counts().items():
        expected = _rederive(
            count,
            ledger=ledger,
            definition=definition,
            view=view,
            catalogue=catalogue,
            authored_matches=authored_matches,
        )
        checked += 1
        if expected is None:
            # Cannot re-derive — this is a structural error
            findings.append(record_finding(
                FINDING_DERIVED_COUNT_MISMATCH,
                f"derived count at {str(path)!r} (kind={count.derivation_kind!r}, "
                f"block={count.block_id!r}) could not be re-derived from the ledger",
                block_id=count.block_id,
                derivation_kind=count.derivation_kind,
                stored=count.formatted,
                expected="<unresolvable>",
            ))
        elif str(expected) != count.formatted:
            findings.append(record_finding(
                FINDING_DERIVED_COUNT_MISMATCH,
                f"derived count at {str(path)!r} (kind={count.derivation_kind!r}, "
                f"block={count.block_id!r}) is {count.formatted!r} but the ledger "
                f"contains {expected}",
                block_id=count.block_id,
                derivation_kind=count.derivation_kind,
                stored=count.formatted,
                expected=str(expected),
            ))

    return DerivedCountsPass(findings=tuple(findings), counts_checked=checked)


def _rederive(
    count: DerivedCount,
    *,
    ledger: FigureLedger,
    definition: Mapping[str, object],
    view: object | None = None,
    catalogue: object | None = None,
    authored_matches: Mapping[str, object] | None = None,
) -> int | None:
    """Re-derive the expected value for one DerivedCount.

    Returns the integer value the ledger/definition says this count should be, or None
    if the derivation cannot be performed (structural error).
    """
    if count.derivation_kind == "historical_points_emitted":
        return _count_historical_points(count.block_id, ledger)
    elif count.derivation_kind == "historical_lookback":
        return _read_lookback_config(count.block_id, definition)
    elif count.derivation_kind in ("scope_added_count", "scope_removed_count"):
        return _rederive_scope_drift_count(
            count,
            definition=definition,
            view=view,
            catalogue=catalogue,
            authored_matches=authored_matches,
        )
    return None


def _rederive_scope_drift_count(
    count: DerivedCount,
    *,
    definition: Mapping[str, object],
    view: object | None,
    catalogue: object | None,
    authored_matches: Mapping[str, object] | None,
) -> int | None:
    """Re-derive `scope_added_count`/`scope_removed_count` by recomputing every
    section's drift from scratch and reading off the one matching `count.block_id`.

    Recomputes the FULL `compute_section_drift` result rather than re-resolving
    just one section — the function is cheap (a handful of set differences over
    an already-loaded snapshot) and doing so keeps this re-derivation from
    silently depending on `compute_section_drift`'s internal id-derivation
    scheme staying in sync with `block_id`'s own format, which a `record.py`
    change could otherwise drift out from under this check without either
    side's own tests catching it.
    """
    if view is None or catalogue is None or authored_matches is None:
        return None

    # Deferred import for the same reason `compile/blocks/__init__.py` defers it:
    # avoiding a circular import at package-load time.
    from reporting_agent.compile.sections import compute_section_drift

    drifts = compute_section_drift(
        definition,
        catalogue=catalogue,  # type: ignore[arg-type]
        view=view,  # type: ignore[arg-type]
        authored_matches=authored_matches,  # type: ignore[arg-type]
    )

    # `count.block_id` is the gaps_and_coverage block's own id (e.g. "sec_cov__1"),
    # not a section id — `_drift_statements` mints the DerivedCount from that
    # block's cursor, so every drift statement in one coverage block shares one
    # block_id regardless of which section it reports on. Re-derivation therefore
    # sums the matching kind across every section's drift rather than looking up
    # one section by id.
    if count.derivation_kind == "scope_added_count":
        return sum(len(drift.added) for drift in drifts)  # type: ignore[attr-defined]
    return sum(len(drift.removed) for drift in drifts)  # type: ignore[attr-defined]


def _count_historical_points(block_id: str, ledger: FigureLedger) -> int:
    """Count how many chart points the block emitted.

    A historical_trend block's chart points are ledger entries whose path starts with
    the block_id and that are anchored to a chart. We count entries with chart anchors
    whose path is prefixed by this block's id.
    """
    count = 0
    chart_anchors = ledger.anchors()
    for path, anchor in chart_anchors.items():
        if anchor.kind == ANCHOR_CHART and str(path).startswith(f"{block_id}:"):
            count += 1
    return count


def _read_lookback_config(block_id: str, definition: Mapping[str, object]) -> int | None:
    """Read the lookback config value from the definition for the given block.

    Searches the definition's blocks list for one with the matching id and
    type 'historical_trend', then reads config.lookback.
    """
    blocks = definition.get("blocks")
    if not isinstance(blocks, list):
        return None

    for block in blocks:
        if not isinstance(block, Mapping):
            continue
        if block.get("id") == block_id and block.get("type") == "historical_trend":
            config = block.get("config")
            if isinstance(config, Mapping):
                lookback = config.get("lookback")
                if isinstance(lookback, int):
                    return lookback
    return None
