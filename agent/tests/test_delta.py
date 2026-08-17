"""`compare/delta.py` and `compile/blocks/comparison.py` (Req 16.7, 16.8, 16.15).

The two rows that are **not** deltas are the interesting cases, and both must render:

* a resource whose `fidelity_tier` differs between the two runs — subtracting an estimated
  percentile from a guest-measured one produces a number whose units match and whose meaning does
  not, so the row says **not comparable** and carries no delta figure;
* a resource present in one snapshot only — created or decommissioned between the runs.

Neither is omitted, on the same reasoning as the empty-scope row: a row that vanished is
indistinguishable from a resource that was never in scope, and the reader cannot tell "this
machine appeared last month" from "we did not look".
"""

from __future__ import annotations

from decimal import Decimal

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compare.delta import (
    ADVISORY_FIDELITY_NOT_COMPARABLE,
    DELTA_ESTIMATOR,
    DELTA_NAMESPACE,
    DeltaKind,
    compile_delta,
    delta_pointer,
    direction_glyph,
    qualified,
)
from reporting_agent.compile.ast import EmptyCell, FigureCell, Table, TextCell
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import NOT_COMPARABLE_TEXT
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.errors import CompileFailedError

VM = sf.VM_TYPE
RUN_A = "run-2026-06"
RUN_B = "run-2026-07"


def view_of(**kwargs):
    return build_snapshot_view(sf.build(**kwargs))


class Comparison:
    """A `ComparisonSource` over two in-memory views — no S3, no Azure."""

    def __init__(self, **views) -> None:
        self.views = views

    def snapshot_for(self, run_id: str):
        return self.views.get(run_id)


def rows_by_key(table: Table) -> dict[str, object]:
    return {row.key: row for row in table.rows}


def comparison_table(document) -> Table:
    for node in document.document.blocks:
        if isinstance(node, Table) and str(node.path).startswith("delta:"):
            return node
    raise AssertionError("no comparison table")


def delta_definition(*, scope_override=None):
    return df.definition(
        [
            df.block(
                "delta",
                "comparison_delta",
                {"run_a": RUN_A, "run_b": RUN_B, "caption": "Month on month"},
                scope_override=scope_override,
            )
        ],
        metrics={VM: [df.CPU_AVG]},
    )


# --------------------------------------------------------------------------- #
# The pure comparison
# --------------------------------------------------------------------------- #


def test_a_comparable_resource_produces_a_delta_of_later_minus_earlier() -> None:
    earlier = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20")])

    table = compile_delta(
        run_a=RUN_A,
        run_b=RUN_B,
        earlier=earlier,
        later=later,
        metric=sf.CPU,
        statistic="avg",
    )

    assert table.snapshot_a == earlier.snapshot_id
    assert table.snapshot_b == later.snapshot_id
    assert len(table.rows) == 1

    row = table.rows[0]
    assert row.is_comparable
    assert row.delta is not None
    assert row.delta.value == Decimal("14.20")
    assert row.delta.estimator == DELTA_ESTIMATOR
    assert table.advisories == ()


def test_a_deltas_derivation_names_both_operands_fully_qualified() -> None:
    """A pointer alone is ambiguous across two snapshots — the same
    `/resources/0/statistics/0/value` addresses a different resource in each."""
    earlier = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20")])

    row = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="avg"
    ).rows[0]
    assert row.delta is not None and row.earlier is not None and row.later is not None

    names = [source.name for source in row.delta.derived_from]
    assert names == [
        qualified(earlier.snapshot_id, row.earlier),
        qualified(later.snapshot_id, row.later),
    ]
    for name in names:
        snapshot_id, _, pointer = name.partition("#")
        assert len(snapshot_id) == 64
        assert pointer.startswith("/resources/")


def test_a_deltas_own_address_is_its_derivation() -> None:
    """A delta is not a value stored at any single position, so it needs an address of its own —
    and the address names both anchors, the resource, the metric and the statistic."""
    earlier = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20")])

    row = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="avg"
    ).rows[0]
    assert row.delta is not None

    assert row.delta.pointer == delta_pointer(
        earlier_snapshot=earlier.snapshot_id,
        later_snapshot=later.snapshot_id,
        resource_id="/vm/a",
        metric=sf.CPU,
        statistic="avg",
    )
    assert row.delta.pointer.startswith(f"/{DELTA_NAMESPACE}/")
    assert earlier.snapshot_id in row.delta.pointer
    assert later.snapshot_id in row.delta.pointer


def test_the_resolver_answers_for_the_run_and_for_the_deltas() -> None:
    """A **superset** of the run's view, so every other block in the same document still resolves
    normally."""
    earlier = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20")])

    table = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="avg"
    )
    resolver = table.resolver(later)
    row = table.rows[0]
    assert row.delta is not None and row.later is not None

    assert resolver.resolve_all(row.delta.pointer) == (row.delta,)
    assert resolver.resolve_all(row.later.pointer) == later.resolve_all(row.later.pointer)
    assert resolver.resolve_all("/nowhere/value") == ()


# --------------------------------------------------------------------------- #
# Req 16.8 — differing fidelity tiers
# --------------------------------------------------------------------------- #


def _differing_tiers():
    earlier = view_of(
        resources=[
            sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00", fidelity_tier="baseline")
        ]
    )
    later = view_of(
        resources=[
            sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20", fidelity_tier="enhanced")
        ]
    )
    return earlier, later


def test_a_resource_whose_tier_changed_is_not_comparable_and_carries_no_delta() -> None:
    earlier, later = _differing_tiers()
    table = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="avg"
    )

    row = table.rows[0]
    assert row.kind == DeltaKind.FIDELITY_DIFFERS
    assert not row.is_comparable
    assert row.delta is None
    assert row.earlier_tier == "baseline"
    assert row.later_tier == "enhanced"
    # The advisory the verification result records — advisory, not blocking: the report is still
    # deliverable and still honest, because it says the row is not comparable.
    assert table.advisories == ((ADVISORY_FIDELITY_NOT_COMPARABLE, "/vm/a"),)


def test_the_block_renders_a_not_comparable_row_with_an_empty_delta_cell() -> None:
    earlier, later = _differing_tiers()
    document = compile_document(
        delta_definition(),
        view=later,
        comparison_source=Comparison(**{RUN_A: earlier, RUN_B: later}),
    )
    table = comparison_table(document)
    row = rows_by_key(table)["/vm/a"]

    # The row is present, and its delta cell holds nothing.
    assert isinstance(row.cells[2], EmptyCell)
    note = row.cells[3]
    assert isinstance(note, TextCell)
    assert NOT_COMPARABLE_TEXT in note.text
    assert "baseline" in note.text and "enhanced" in note.text

    # No delta figure was minted for it.
    assert all(
        figure.estimator != DELTA_ESTIMATOR for figure in document.ledger.entries.values()
    )


# --------------------------------------------------------------------------- #
# Req 16.15 — present in one snapshot only
# --------------------------------------------------------------------------- #


def test_a_resource_absent_from_the_earlier_run_names_the_snapshot_it_is_missing_from() -> None:
    earlier = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])
    later = view_of(
        resources=[
            sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00"),
            sf.vm(resource_id="/vm/b", name="new", cpu_avg="10.00"),
        ]
    )

    table = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="avg"
    )
    row = rows_by_key_pure(table)["/vm/b"]

    assert row.kind == DeltaKind.ABSENT_FROM_EARLIER
    assert row.delta is None
    assert RUN_A in row.note
    assert row.later is not None  # this run measured it


def test_a_resource_absent_from_the_later_run_is_not_omitted() -> None:
    earlier = view_of(
        resources=[
            sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00"),
            sf.vm(resource_id="/vm/gone", name="decommissioned", cpu_avg="80.00"),
        ]
    )
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])

    table = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="avg"
    )
    row = rows_by_key_pure(table)["/vm/gone"]

    assert row.kind == DeltaKind.ABSENT_FROM_LATER
    assert row.delta is None
    assert RUN_B in row.note
    # The union is compared, not either side — intersecting would drop exactly this row.
    assert len(table.rows) == 2


def rows_by_key_pure(table) -> dict[str, object]:
    return {row.resource_id: row for row in table.rows}


def test_the_block_renders_a_decommissioned_resource_with_no_figures() -> None:
    earlier = view_of(
        resources=[
            sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00"),
            sf.vm(resource_id="/vm/gone", name="decommissioned", cpu_avg="80.00"),
        ]
    )
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20")])

    document = compile_document(
        delta_definition(),
        view=later,
        comparison_source=Comparison(**{RUN_A: earlier, RUN_B: later}),
    )
    table = comparison_table(document)
    row = rows_by_key(table)["/vm/gone"]

    assert isinstance(row.cells[1], EmptyCell)  # no value in this run
    assert isinstance(row.cells[2], EmptyCell)  # therefore no change
    assert RUN_B in row.cells[3].text  # type: ignore[union-attr]


def test_a_row_with_no_value_in_one_run_carries_no_delta() -> None:
    earlier = view_of(
        resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00", cpu_p95=None)]
    )
    later = view_of(
        resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20", cpu_p95="90.00")]
    )

    table = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="p95"
    )
    row = table.rows[0]
    assert row.kind == DeltaKind.NO_VALUE
    assert row.delta is None


# --------------------------------------------------------------------------- #
# The block's own shape
# --------------------------------------------------------------------------- #


def test_the_table_names_both_snapshot_anchors_in_the_document() -> None:
    """A caption is the first thing a copy-paste loses, so the anchors are rows."""
    earlier = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20")])

    document = compile_document(
        delta_definition(),
        view=later,
        comparison_source=Comparison(**{RUN_A: earlier, RUN_B: later}),
    )
    table = comparison_table(document)
    keys = [row.key for row in table.rows]

    assert keys[:2] == ["snapshot_a", "snapshot_b"]
    text = " ".join(cell.text for row in table.rows[:2] for cell in row.cells if isinstance(cell, TextCell))
    assert earlier.snapshot_id in text
    assert later.snapshot_id in text
    assert RUN_A in text and RUN_B in text


def test_the_table_has_no_earlier_column() -> None:
    """A document is verified against exactly one snapshot, and the earlier run's value resolves
    in a different one. Emitting it as text would put an unmatchable token in the document."""
    earlier = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20")])

    document = compile_document(
        delta_definition(),
        view=later,
        comparison_source=Comparison(**{RUN_A: earlier, RUN_B: later}),
    )
    table = comparison_table(document)

    assert [column.key for column in table.columns] == ["resource", "later", "delta", "note"]
    # Every figure in the document resolves against THIS run's snapshot or the delta namespace.
    for figure in document.ledger.entries.values():
        assert later.resolve(figure.snapshot_path) is not None or figure.snapshot_path.startswith(
            f"/{DELTA_NAMESPACE}/"
        )


def test_the_delta_figure_is_in_the_ledger_and_is_the_trees_own_object() -> None:
    earlier = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20")])

    document = compile_document(
        delta_definition(),
        view=later,
        comparison_source=Comparison(**{RUN_A: earlier, RUN_B: later}),
    )
    row = rows_by_key(comparison_table(document))["/vm/a"]
    cell = row.cells[2]
    assert isinstance(cell, FigureCell)
    assert document.ledger[cell.figure.path] is cell.figure
    assert cell.figure.formatted == "14.20%"


def test_the_compared_pair_comes_from_the_block_scopes_top_n_when_it_has_one() -> None:
    earlier = view_of(
        resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00", cpu_max="60.00")]
    )
    later = view_of(
        resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20", cpu_max="99.00")]
    )

    document = compile_document(
        delta_definition(
            scope_override=df.scope(
                top_n={"count": 5, "metric": sf.CPU, "statistic": "max"}, sort="descending"
            )
        ),
        view=later,
        comparison_source=Comparison(**{RUN_A: earlier, RUN_B: later}),
    )
    row = rows_by_key(comparison_table(document))["/vm/a"]
    assert row.cells[2].figure.value == "39.00"  # type: ignore[union-attr]


def test_an_unresolvable_run_is_a_compile_failure_naming_the_run() -> None:
    """A comparison block that silently rendered one run's numbers would look like a delta of
    zero, which is the most misleading possible outcome."""
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a")])

    with pytest.raises(CompileFailedError) as caught:
        compile_document(
            delta_definition(), view=later, comparison_source=Comparison(**{RUN_B: later})
        )
    assert RUN_A in str(caught.value)
    assert "'delta'" in str(caught.value)


def test_no_comparison_source_is_a_compile_failure() -> None:
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a")])
    with pytest.raises(CompileFailedError, match="comparison source"):
        compile_document(delta_definition(), view=later)


def test_a_missing_run_id_in_the_config_is_a_compile_failure() -> None:
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a")])
    body = df.definition(
        [df.block("delta", "comparison_delta", {"run_a": RUN_A})],
        metrics={VM: [df.CPU_AVG]},
        validate=False,
    )
    with pytest.raises(CompileFailedError, match=r"run_a and config\.run_b"):
        compile_document(body, view=later, comparison_source=Comparison(**{RUN_A: later}))


# --------------------------------------------------------------------------- #
# Direction glyphs, not colour
# --------------------------------------------------------------------------- #


def test_direction_is_a_glyph_and_never_a_colour() -> None:
    """CPU rising is not "bad", and disk free space falling is not the same kind of "down" as
    network throughput falling. The glyph states the direction; the prose states whether it
    matters. `--destructive` stays reserved for a verification failure."""
    assert direction_glyph(Decimal("1")) == "\u25b2"
    assert direction_glyph(Decimal("-1")) == "\u25bc"
    assert direction_glyph(Decimal("0")) == "\u2014"


# --------------------------------------------------------------------------- #
# Purity
# --------------------------------------------------------------------------- #


def test_the_comparison_reads_two_snapshots_and_opens_no_socket(monkeypatch) -> None:
    """Req 16.7 — two stored snapshots and no Azure call."""
    import socket

    def refuse(*args: object, **kwargs: object) -> None:
        raise AssertionError("the delta compiler opened a socket")

    monkeypatch.setattr(socket, "socket", refuse)

    earlier = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00")])
    later = view_of(resources=[sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20")])
    table = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="avg"
    )
    assert table.rows[0].delta is not None


def test_the_comparison_is_deterministic_over_one_pair() -> None:
    earlier = view_of(
        resources=[
            sf.vm(resource_id="/vm/b", name="b", cpu_avg="10.00"),
            sf.vm(resource_id="/vm/a", name="a", cpu_avg="50.00"),
        ]
    )
    later = view_of(
        resources=[
            sf.vm(resource_id="/vm/a", name="a", cpu_avg="64.20"),
            sf.vm(resource_id="/vm/c", name="c", cpu_avg="1.00"),
        ]
    )

    first = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="avg"
    )
    second = compile_delta(
        run_a=RUN_A, run_b=RUN_B, earlier=earlier, later=later, metric=sf.CPU, statistic="avg"
    )

    assert [row.resource_id for row in first.rows] == [row.resource_id for row in second.rows]
    # The union of both snapshots, ordered by resource id.
    assert [row.resource_id for row in first.rows] == ["/vm/a", "/vm/b", "/vm/c"]
