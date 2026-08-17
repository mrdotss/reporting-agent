"""`compile/figures.py` — the ledger IS the render context (Req 17.1-17.11).

Two tests here distinguish this design from one that keeps two structures in agreement:

* :func:`test_the_ledger_and_the_ast_hold_the_same_object` — the ledger identity test. It
  mutates a figure through the **AST** and asserts the **ledger** reports the change, then
  does it in reverse. A copied or re-walked ledger fails both directions.
* :func:`test_the_factory_call_count_equals_the_ledger_and_the_tree` — a second-pass
  implementation shows up as a count mismatch rather than as something a reviewer has to
  notice.
"""

from __future__ import annotations

import ast as py_ast
from decimal import Decimal
from pathlib import Path

import pytest

import snapshot_factory as sf
from reporting_agent.compile import ast as A
from reporting_agent.compile.figures import (
    ANCHOR_CHART,
    ANCHOR_TABLE,
    BlockCursor,
    FigureLedger,
    TableAnchor,
    assert_ledger_matches_tree,
    walk_figures,
)
from reporting_agent.compile.format import NumberFormat
from reporting_agent.compile.snapshot_view import SnapshotValue, build_snapshot_view
from reporting_agent.errors import CompileFailedError

COMPILE_PACKAGE = (
    Path(__file__).resolve().parent.parent / "src" / "reporting_agent" / "compile"
)


@pytest.fixture
def view():
    return build_snapshot_view(sf.two_vm_snapshot())


@pytest.fixture
def ledger() -> FigureLedger:
    return FigureLedger()


def _one_figure(view, ledger: FigureLedger, statistic: str = "avg"):
    """One figure at `kpi-1:0`, minted the only way there is."""
    resource = view.resources[0]
    value = view.stat(resource.resource_id, sf.CPU, statistic)
    assert value is not None
    with A.compiling_against(view):
        cursor = BlockCursor(block_id="kpi-1", ledger=ledger).child("nodes", 0)
        return cursor.figure(value)


def _small_table(view, ledger: FigureLedger) -> tuple[A.Table, BlockCursor]:
    """A two-row, two-column data table over the fixture's resources."""
    with A.compiling_against(view):
        root = BlockCursor(block_id="resources", ledger=ledger)
        table_cursor = root.child("nodes", 0)

        rows = []
        for row_ordinal, resource in enumerate(view.resources):
            row_cursor = table_cursor.child("rows", row_ordinal)
            cells = []
            for cell_ordinal, statistic in enumerate(("avg", "max")):
                cell_cursor = row_cursor.child("cells", cell_ordinal)
                value = view.stat(resource.resource_id, sf.CPU, statistic)
                assert value is not None
                figure = cell_cursor.child("figure", 0).figure(value)
                cells.append(A.FigureCell(path=cell_cursor.path, figure=figure))
            rows.append(
                A.Row(path=row_cursor.path, key=resource.name, cells=tuple(cells))
            )

        table = A.Table(
            path=table_cursor.path,
            style="Table Hairline",
            columns=(A.Column("cpu_avg", "Avg CPU"), A.Column("cpu_max", "Max CPU")),
            rows=tuple(rows),
        )
    return table, root


# --------------------------------------------------------------------------- #
# The ledger identity test — the one that distinguishes this design
# --------------------------------------------------------------------------- #


def test_the_ledger_and_the_ast_hold_the_same_object(view, ledger: FigureLedger) -> None:
    """Req 17.1, 17.4 — the ledger's values *are* the objects the AST holds.

    `object.__setattr__` reaches past `Figure.__setattr__` deliberately: production code
    cannot mutate a figure, this test can. That is the only way to observe the difference
    between "the same object" and "an equal copy", and the difference is the whole design
    — a copied ledger would leave the verifier comparing the document against a snapshot
    of the truth taken at some earlier moment.
    """
    table, _ = _small_table(view, ledger)
    path = table.rows[0].cells[0].figure.path

    # Through the AST, observed in the ledger.
    from_tree = table.rows[0].cells[0].figure
    object.__setattr__(from_tree, "formatted", "MUTATED-VIA-AST")
    assert ledger[path].formatted == "MUTATED-VIA-AST"

    # And in reverse: through the ledger, observed in the AST.
    object.__setattr__(ledger[path], "formatted", "MUTATED-VIA-LEDGER")
    assert table.rows[0].cells[0].figure.formatted == "MUTATED-VIA-LEDGER"

    # Identity, stated directly as well, so the failure message is unambiguous when the
    # two assertions above start passing for the wrong reason.
    assert ledger[path] is table.rows[0].cells[0].figure


def test_every_ledger_entry_is_the_object_at_its_position_in_the_tree(
    view, ledger: FigureLedger
) -> None:
    table, _root = _small_table(view, ledger)
    for suffix, figure in walk_figures(table):
        structural = A.figure_path("resources", 0, *suffix)
        assert ledger[structural] is figure
    assert len(ledger) == 4


# --------------------------------------------------------------------------- #
# The factory call count
# --------------------------------------------------------------------------- #


def test_the_factory_call_count_equals_the_ledger_and_the_tree(
    view, ledger: FigureLedger
) -> None:
    """A second-pass implementation — one that walked the finished tree to fill a ledger —
    would satisfy every key-set assertion and fail here."""
    table, root = _small_table(view, ledger)

    assert root.factory_calls == 4
    assert root.factory_calls == len(ledger)
    assert root.factory_calls == sum(1 for _ in walk_figures(table))

    assert_ledger_matches_tree(
        {"resources": (table,)}, ledger, factory_calls=root.factory_calls
    )


def test_the_call_count_is_shared_across_child_cursors(view, ledger: FigureLedger) -> None:
    """Counted on a one-element list shared by reference, so a count read from any cursor
    is the block's total rather than the leaf that happened to be asked."""
    _, root = _small_table(view, ledger)
    child = root.child("nodes", 0).child("rows", 0)
    assert child.factory_calls == root.factory_calls == 4


def test_a_wrong_factory_count_fails_the_invariant(view, ledger: FigureLedger) -> None:
    table, root = _small_table(view, ledger)
    with pytest.raises(CompileFailedError, match="second pass"):
        assert_ledger_matches_tree(
            {"resources": (table,)}, ledger, factory_calls=root.factory_calls + 1
        )


# --------------------------------------------------------------------------- #
# There is no second structure, and no way to build one
# --------------------------------------------------------------------------- #


def test_no_module_in_the_compile_package_declares_a_ledger_builder() -> None:
    """Req 17.4 — there is no `build_ledger(ast)` anywhere in this package, and there
    cannot be one without deleting `BlockCursor.figure`.

    A static scan rather than a convention: a parallel walk is a second structure, and two
    structures can disagree — which is the class of bug the verification stage exists to
    catch, reintroduced one layer below it.
    """
    forbidden = ("build_ledger", "ledger_from_ast", "collect_figures", "extract_figures")
    offenders: list[str] = []

    modules = sorted(COMPILE_PACKAGE.rglob("*.py"))
    assert modules, f"no modules found under {COMPILE_PACKAGE}"

    for module in modules:
        tree = py_ast.parse(module.read_text(encoding="utf-8"), filename=str(module))
        for node in py_ast.walk(tree):
            if isinstance(node, py_ast.FunctionDef | py_ast.AsyncFunctionDef):
                if node.name in forbidden:
                    offenders.append(f"{module.name}:{node.lineno} def {node.name}")

    assert not offenders, (
        "these functions would build a ledger by walking a finished tree, which is a "
        f"second structure: {offenders}"
    )


def test_the_only_figure_factory_is_the_cursor(view, ledger: FigureLedger) -> None:
    """Req 17.2. Stated as an identity check on the ledger's contents: every entry was
    inserted by the cursor, so the count the cursor kept and the ledger's size agree."""
    _, root = _small_table(view, ledger)
    assert len(ledger) == root.factory_calls > 0


@pytest.mark.parametrize(
    "offender", [Decimal("12.48"), 12, 12.48, "12.48", None, {"value": "12.48"}]
)
def test_the_factory_refuses_anything_but_a_snapshot_value(
    view, ledger: FigureLedger, offender: object
) -> None:
    """Req 17.3 — there is no operation in this package that accepts a numeric produced by
    a language model, supplied in a template definition, or computed from model-authored
    text, and places it in a figure position."""
    with A.compiling_against(view):
        cursor = BlockCursor(block_id="kpi-1", ledger=ledger).child("nodes", 0)
        with pytest.raises(CompileFailedError, match="SnapshotValue"):
            cursor.figure(offender)  # type: ignore[arg-type]
    assert len(ledger) == 0


def test_a_hand_built_snapshot_value_still_has_to_resolve(view, ledger: FigureLedger) -> None:
    """The type gate is not the only gate. A `SnapshotValue` constructed by hand — the
    closest a caller could get to smuggling a number in — still fails at `Figure`'s
    re-resolution, because its pointer addresses nothing in the snapshot being compiled."""
    fabricated = SnapshotValue(
        value=Decimal("99.99"),
        unit="percent",
        statistic="avg",
        estimator="exact_count_weighted",
        fidelity_tier="baseline",
        scale=2,
        metric=sf.CPU,
        resource_id="/vm/invented",
        window="2026-07-01/2026-07-02",
        pointer="/resources/999/statistics/0/value",
    )
    with A.compiling_against(view):
        cursor = BlockCursor(block_id="kpi-1", ledger=ledger).child("nodes", 0)
        with pytest.raises(CompileFailedError, match="addresses no value"):
            cursor.figure(fabricated)
    assert len(ledger) == 0


# --------------------------------------------------------------------------- #
# The closing invariant
# --------------------------------------------------------------------------- #


def test_a_figure_whose_minted_path_disagrees_with_the_tree_fails_the_invariant(
    view, ledger: FigureLedger
) -> None:
    """The check that catches a cursor minting a wrong ordinal.

    Simulated by placing a correctly-minted figure at the wrong position in the tree,
    which is what a mis-minted ordinal amounts to.
    """
    resource = view.resources[0]
    with A.compiling_against(view):
        root = BlockCursor(block_id="kpi-1", ledger=ledger)
        table_cursor = root.child("nodes", 0)
        row_cursor = table_cursor.child("rows", 0)

        # Minted for cell ordinal 0 ...
        cell_cursor = row_cursor.child("cells", 0)
        value = view.stat(resource.resource_id, sf.CPU, "avg")
        assert value is not None
        figure = cell_cursor.child("figure", 0).figure(value)

        # ... but placed second in the row, behind an empty cell, so the tree addresses
        # it at cell ordinal 1 while it carries the path for ordinal 0.
        row = A.Row(
            path=row_cursor.path,
            key="r0",
            cells=(
                A.EmptyCell(path=row_cursor.child("cells", 0).path),
                A.FigureCell(path=row_cursor.child("cells", 1).path, figure=figure),
            ),
        )
        table = A.Table(path=table_cursor.path, style="Table Hairline", rows=(row,))

    with pytest.raises(CompileFailedError, match="disagrees with its position"):
        assert_ledger_matches_tree({"kpi-1": (table,)}, ledger, factory_calls=1)


def test_a_ledger_entry_absent_from_the_tree_fails_the_invariant(
    view, ledger: FigureLedger
) -> None:
    table, root = _small_table(view, ledger)
    # A figure minted but never placed: in the ledger, nowhere in the tree.
    orphan = _one_figure(view, ledger)
    assert orphan.path in ledger

    with pytest.raises(CompileFailedError, match="not in the tree"):
        assert_ledger_matches_tree(
            {"resources": (table,)}, ledger, factory_calls=root.factory_calls
        )


def test_a_tree_figure_absent_from_the_ledger_fails_the_invariant(
    view, ledger: FigureLedger
) -> None:
    table, root = _small_table(view, ledger)
    other = FigureLedger()
    with pytest.raises(CompileFailedError, match="not in the ledger"):
        assert_ledger_matches_tree(
            {"resources": (table,)}, other, factory_calls=root.factory_calls
        )


def test_the_invariant_passes_for_a_tree_carrying_no_figures(ledger: FigureLedger) -> None:
    """A `page_break` block, or an empty-scope block: zero figures, and that is not a
    failure."""
    break_node = A.PageBreak(path=A.figure_path("break-1", 0))
    assert_ledger_matches_tree({"break-1": (break_node,)}, ledger, factory_calls=0)


def test_two_figures_at_one_ledger_key_are_refused(view, ledger: FigureLedger) -> None:
    """Two figures at one key would leave the verifier with two candidate `formatted`
    values for one document token."""
    _one_figure(view, ledger, statistic="avg")
    with pytest.raises(CompileFailedError, match="resolve to the ledger key"):
        _one_figure(view, ledger, statistic="max")


# --------------------------------------------------------------------------- #
# Percentiles must carry their label
# --------------------------------------------------------------------------- #


def test_a_percentile_figure_carries_its_estimator_label(view, ledger: FigureLedger) -> None:
    resource = view.resources[0]
    value = view.stat(resource.resource_id, sf.CPU, "p95")
    assert value is not None

    with A.compiling_against(view):
        cursor = BlockCursor(block_id="kpi-1", ledger=ledger).child("nodes", 0)
        figure = cursor.figure(value)

    assert figure.estimator_label == "p95, est. from hourly averages"
    assert figure.formatted.endswith("(p95, est. from hourly averages)")
    assert figure.is_estimate


def test_a_percentile_whose_estimator_composes_no_label_is_refused(
    view, ledger: FigureLedger
) -> None:
    """The layer that knows: the formatter never sees the statistic, so it cannot make
    this check. A percentile marked with an exact estimator would otherwise reach a
    document as a bare `p95`."""
    resource = view.resources[0]
    value = view.stat(resource.resource_id, sf.CPU, "p95")
    assert value is not None
    mislabelled = SnapshotValue(
        value=value.value,
        unit=value.unit,
        statistic="p95",
        estimator="exact_count_weighted",
        fidelity_tier=value.fidelity_tier,
        scale=value.scale,
        metric=value.metric,
        resource_id=value.resource_id,
        window=value.window,
        pointer=value.pointer,
    )

    with A.compiling_against(view):
        cursor = BlockCursor(block_id="kpi-1", ledger=ledger).child("nodes", 0)
        with pytest.raises(CompileFailedError, match="percentile"):
            cursor.figure(mislabelled)


def test_an_exact_figure_carries_no_estimator_label(view, ledger: FigureLedger) -> None:
    figure = _one_figure(view, ledger)
    assert figure.estimator_label is None
    assert not figure.is_estimate
    assert "(" not in figure.formatted


def test_a_derived_figure_carries_its_formula_and_sources(view, ledger: FigureLedger) -> None:
    """Req 30.9 — a derived number without its derivation is an assertion rather than a
    measurement, so both travel into the figure and into the ledger artifact."""
    resource = view.resources[0]
    value = view.stat(resource.resource_id, sf.MEMORY_USED_PCT, "avg")
    assert value is not None

    with A.compiling_against(view):
        cursor = BlockCursor(block_id="kpi-1", ledger=ledger).child("nodes", 0)
        figure = cursor.figure(value)

    assert figure.formula
    assert figure.derived_from
    assert {source.kind for source in figure.derived_from} == {"metric", "sku_capability"}


# --------------------------------------------------------------------------- #
# Formatted values, masking order, and the number format
# --------------------------------------------------------------------------- #


def test_formatted_values_are_ordered_longest_first(view, ledger: FigureLedger) -> None:
    """Masking stage 1's requirement, not a preference: masking `12.4` before `12.48%`
    would leave `8%` behind as a spurious unmatched token — a false verification failure
    on a correct report."""
    _small_table(view, ledger)
    values = ledger.formatted_values()
    assert list(values) == sorted(values, key=lambda value: (-len(value), value))
    assert len(set(values)) == len(values)


def test_formatted_values_deduplicate(view, ledger: FigureLedger) -> None:
    """Two resources with the same value produce one masking token, not two."""
    document = sf.build(
        resources=[
            sf.vm(resource_id="/vm/a", name="a", cpu_avg="12.48"),
            sf.vm(resource_id="/vm/b", name="b", cpu_avg="12.48"),
        ]
    )
    same = build_snapshot_view(document)
    with A.compiling_against(same):
        root = BlockCursor(block_id="kpi-1", ledger=ledger)
        for ordinal, resource in enumerate(same.resources):
            value = same.stat(resource.resource_id, sf.CPU, "avg")
            assert value is not None
            root.child("nodes", ordinal).figure(value)

    assert len(ledger) == 2
    assert ledger.formatted_values() == ("12.48%",)


def test_the_cursors_number_format_reaches_the_figure(view, ledger: FigureLedger) -> None:
    resource = view.resources[0]
    value = view.stat(resource.resource_id, sf.CPU, "avg")
    assert value is not None

    european = NumberFormat(
        decimal_places=3,
        group_thousands=True,
        decimal_separator=",",
        grouping_separator=".",
    )
    with A.compiling_against(view):
        cursor = BlockCursor(
            block_id="kpi-1", ledger=ledger, number_format=european
        ).child("nodes", 0)
        figure = cursor.figure(value)

    assert figure.formatted == "64,200%"
    # `value` keeps the snapshot's own spelling — provenance, not presentation.
    assert figure.value == "64.20"


def test_a_figures_value_is_the_snapshots_stored_string(view, ledger: FigureLedger) -> None:
    figure = _one_figure(view, ledger)
    stored = view.resolve(figure.snapshot_path)
    assert stored is not None
    assert figure.value == f"{stored.value:f}"


# --------------------------------------------------------------------------- #
# Anchors
# --------------------------------------------------------------------------- #


def test_anchoring_a_table_records_the_anchor_on_every_figure_inside_it(
    view, ledger: FigureLedger
) -> None:
    table, root = _small_table(view, ledger)
    anchor_id = root.anchor_table(table.path)

    assert anchor_id == A.table_id(table.path)
    assert set(ledger.anchors()) == set(ledger.paths())
    for anchor in ledger.anchors().values():
        assert anchor.kind == ANCHOR_TABLE
        assert anchor.anchor_id == anchor_id


def test_anchoring_a_chart_uses_the_chart_prefix(view, ledger: FigureLedger) -> None:
    resource = view.resources[0]
    with A.compiling_against(view):
        root = BlockCursor(block_id="chart-1", ledger=ledger)
        chart_cursor = root.child("nodes", 0)
        series_cursor = chart_cursor.child("series", 0)
        point_cursor = series_cursor.child("points", 0)
        value = view.stat(resource.resource_id, sf.CPU, "avg")
        assert value is not None
        figure = point_cursor.child("y", 0).figure(value)
        point = A.ChartPoint(path=point_cursor.path, x=resource.name, y=figure)
        series = A.Series(path=series_cursor.path, key="cpu", label="CPU", points=(point,))
        A.Chart(
            path=chart_cursor.path,
            chart_type="bar",
            title="Top VMs by Average CPU",
            unit="percent",
            encoding="categorical",
            series=(series,),
        )
        anchor_id = root.anchor_chart(chart_cursor.path)

    assert anchor_id.startswith("cht:")
    assert next(iter(ledger.anchors().values())).kind == ANCHOR_CHART


def test_recording_an_anchor_for_an_unknown_path_is_refused(ledger: FigureLedger) -> None:
    """An anchor with no figure is a claim about a document position carrying no
    verifiable number — the shape of a second structure starting to grow."""
    with pytest.raises(CompileFailedError, match="holds no figure"):
        ledger.record_anchor(
            A.figure_path("absent", 0),
            TableAnchor(kind=ANCHOR_TABLE, anchor_id="tbl:absent:0"),
        )


@pytest.mark.parametrize("kind", ["", "row", "figure", "TABLE"])
def test_an_undeclared_anchor_kind_is_refused(kind: str) -> None:
    with pytest.raises(CompileFailedError, match="anchor kind"):
        TableAnchor(kind=kind, anchor_id="tbl:x:0")


# --------------------------------------------------------------------------- #
# Serialization
# --------------------------------------------------------------------------- #


def test_the_ledger_artifact_is_deterministic(view) -> None:
    """A re-verification reads the same ledger the render used, so the bytes have to be a
    function of the figures alone."""
    first, second = FigureLedger(), FigureLedger()
    _small_table(view, first)
    _small_table(view, second)

    assert first.serialize() == second.serialize()
    assert first.digest() == second.digest()
    assert len(first.digest()) == 64
    assert first.digest() == first.digest().lower()


def test_the_artifact_changes_when_any_figure_does(view) -> None:
    baseline = FigureLedger()
    table, _ = _small_table(view, baseline)
    before = baseline.digest()

    object.__setattr__(table.rows[0].cells[0].figure, "formatted", "CHANGED")
    assert baseline.digest() != before


def test_the_artifact_carries_provenance_and_omits_absent_fields(
    view, ledger: FigureLedger
) -> None:
    import json

    _one_figure(view, ledger)
    entry = json.loads(ledger.serialize())["entries"]["kpi-1:0"]

    for required in ("path", "value", "unit", "snapshot_path", "formatted", "fidelity_tier"):
        assert required in entry
    # Absent fields are omitted rather than emitted as null — two spellings of "absent"
    # would be two digests for one ledger.
    assert "estimator_label" not in entry
    assert None not in entry.values()


def test_by_snapshot_path_groups_figures_citing_one_position(view, ledger: FigureLedger) -> None:
    _small_table(view, ledger)
    grouped = ledger.by_snapshot_path()

    assert grouped
    for snapshot_path, paths in grouped.items():
        assert view.resolve(snapshot_path) is not None
        assert list(paths) == sorted(paths)
    assert sum(len(paths) for paths in grouped.values()) == len(ledger)


# --------------------------------------------------------------------------- #
# Cursor mechanics
# --------------------------------------------------------------------------- #


def test_a_block_root_cursor_has_no_node_path_of_its_own(ledger: FigureLedger) -> None:
    """`<block_id>` alone names a block, never a node."""
    root = BlockCursor(block_id="kpi-1", ledger=ledger)
    with pytest.raises(CompileFailedError, match="at least one ordinal"):
        _ = root.path
    assert root.child("nodes", 0).path == "kpi-1:0"


def test_child_appends_an_ordinal(ledger: FigureLedger) -> None:
    root = BlockCursor(block_id="t", ledger=ledger)
    assert root.child("nodes", 0).child("rows", 2).child("cells", 1).path == "t:0.2.1"


def test_children_mints_consecutive_cursors(ledger: FigureLedger) -> None:
    root = BlockCursor(block_id="t", ledger=ledger).child("nodes", 0)
    assert [str(cursor.path) for cursor in root.children("rows", 3)] == [
        "t:0.0",
        "t:0.1",
        "t:0.2",
    ]


@pytest.mark.parametrize("ordinal", [-1, True, 1.0, "0", None])
def test_an_invalid_ordinal_is_refused(ledger: FigureLedger, ordinal: object) -> None:
    root = BlockCursor(block_id="t", ledger=ledger)
    with pytest.raises(CompileFailedError, match="ordinal"):
        root.child("rows", ordinal)  # type: ignore[arg-type]


def test_a_missing_ledger_key_raises_a_keyerror_naming_the_path(ledger: FigureLedger) -> None:
    with pytest.raises(KeyError, match="absent:0"):
        ledger[A.figure_path("absent", 0)]


def test_the_ledger_reports_membership_and_length(view, ledger: FigureLedger) -> None:
    assert len(ledger) == 0
    figure = _one_figure(view, ledger)
    assert len(ledger) == 1
    assert str(figure.path) in ledger
    assert "nowhere:0" not in ledger
    assert list(ledger) == [figure.path]
