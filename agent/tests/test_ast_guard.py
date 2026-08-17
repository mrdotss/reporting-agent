"""The AST numeric-leaf guard (Req 15.1-15.7, 15.9-15.13, 21.9, 22.2).

Two halves, and the second is what makes the first worth anything:

* **The real module.** `reporting_agent.compile.ast` must satisfy the invariant — every
  node `frozen=True, slots=True`; no dataclass but `Figure` mentioning a numeric type in
  any annotation; every figure-admitting annotation one of six spellings; `Inline` and
  `Cell` unions over exactly their declared members.
* **Guard the guard.** Each of those rules is proven to **fire** against a synthetic
  namespace built here. A guard nobody has watched fail is a guard nobody knows the
  shape of, and this one is checking an absence — the easiest kind of check to write so
  that it can never fail.

The checker itself lives in `src/`, not here, because `.dockerignore` excludes `tests/`:
a guard that only ran in the suite could not stop an image from carrying an AST that
admits a bare number. The Dockerfile runs
`python -m reporting_agent.compile.ast --assert-build`, and
:func:`test_the_build_time_entry_point_agrees_with_the_suite` asserts the two agree.
"""

from __future__ import annotations

import dataclasses
import re
import subprocess
import sys
from dataclasses import dataclass
from decimal import Decimal
from fractions import Fraction
from pathlib import Path

import pytest

import snapshot_factory as sf
from reporting_agent.compile import ast as A
from reporting_agent.compile.snapshot_view import (
    SnapshotValue,
    build_snapshot_view,
)
from reporting_agent.errors import CompileFailedError

AGENT_ROOT = Path(__file__).resolve().parent.parent
SYNTHETIC_MODULE = "synthetic_ast"


# --------------------------------------------------------------------------- #
# The real module satisfies the invariant
# --------------------------------------------------------------------------- #


def test_the_real_ast_satisfies_the_numeric_leaf_invariant() -> None:
    A.assert_numeric_leaf_invariant()
    assert A.collect_invariant_violations(vars(A), module_name=A.__name__) == []


def test_the_guard_inspected_something() -> None:
    """The first failure mode to rule out: a guard that passes by finding no dataclasses."""
    found = {
        name
        for name, value in vars(A).items()
        if isinstance(value, type)
        and dataclasses.is_dataclass(value)
        and value.__module__ == A.__name__
    }
    for required in A.REQUIRED_NODE_NAMES:
        assert required in found, required
    assert len(found) >= 14, sorted(found)


def test_figure_is_the_only_dataclass_mentioning_a_numeric_type() -> None:
    """Req 15.6 — because no cardinality is a number, this is a crisp rule rather than a
    list of exceptions."""
    mentioning: list[str] = []
    for name, value in vars(A).items():
        if not (
            isinstance(value, type)
            and dataclasses.is_dataclass(value)
            and value.__module__ == A.__name__
        ):
            continue
        annotations = getattr(value, "__annotations__", {})
        for declared in dataclasses.fields(value):
            annotation = str(annotations.get(declared.name, ""))
            for numeric in A.NUMERIC_ANNOTATION_NAMES:
                if re.search(rf"\b{numeric}\b", annotation):
                    mentioning.append(f"{name}.{declared.name}: {annotation}")

    assert sorted({entry.split(".", 1)[0] for entry in mentioning}) == ["Figure"], mentioning


def test_no_cardinality_is_a_number() -> None:
    """The three shapes Req 15.6 names by name."""
    layout_annotations = A.LayoutRow.__annotations__
    assert layout_annotations["columns"] == "tuple[LayoutColumn, ...]"

    table_annotations = A.Table.__annotations__
    assert table_annotations["columns"] == "tuple[Column, ...]"
    assert table_annotations["rows"] == "tuple[Row, ...]"

    # A page break carries only its position — no quantity, no cardinality.
    assert [f.name for f in dataclasses.fields(A.PageBreak)] == ["path"]

    # A heading's level is a theme STYLE NAME, not an int — which is both what keeps it
    # out of the annotations as a quantity and how python-docx applies a style.
    assert A.Paragraph.__annotations__["style"] == "str"


def test_every_figure_admitting_annotation_is_one_of_the_six_spellings() -> None:
    admitting: dict[str, str] = {}
    for name, value in vars(A).items():
        if not (
            isinstance(value, type)
            and dataclasses.is_dataclass(value)
            and value.__module__ == A.__name__
        ):
            continue
        annotations = getattr(value, "__annotations__", {})
        for declared in dataclasses.fields(value):
            annotation = str(annotations.get(declared.name, ""))
            if re.search(r"\b(Figure|Inline|Cell)\b", annotation):
                admitting[f"{name}.{declared.name}"] = annotation

    assert admitting, "no figure-admitting field was found, so this rule checked nothing"
    for where, annotation in admitting.items():
        assert annotation in A.FIGURE_ADMITTING_ANNOTATIONS, f"{where}: {annotation}"

    # The four positions a figure can actually occupy, named so a fifth is a visible
    # change rather than a silent one. `Figure.path` is absent because `FigurePath` does
    # not match `\bFigure\b` — the word boundary is what keeps a path from reading as a
    # figure position.
    assert set(admitting) == {
        "FigureCell.figure",
        "Paragraph.inlines",
        "Row.cells",
        "ChartPoint.y",
    }


def test_inline_and_cell_are_unions_over_exactly_their_declared_members() -> None:
    assert {member.__name__ for member in A.Inline.__value__.__args__} == {"Text", "Figure"}
    assert {member.__name__ for member in A.Cell.__value__.__args__} == {
        "FigureCell",
        "TextCell",
        "EmptyCell",
    }


def test_every_node_is_frozen_and_slotted() -> None:
    for name, value in vars(A).items():
        if not (
            isinstance(value, type)
            and dataclasses.is_dataclass(value)
            and value.__module__ == A.__name__
        ):
            continue
        params = value.__dataclass_params__
        assert params.frozen, name
        assert params.slots, name
        assert hasattr(value, "__slots__"), name


def test_the_build_time_entry_point_agrees_with_the_suite() -> None:
    """`.dockerignore` excludes `tests/`, so the invariant has to be assertable from
    `src/` alone. This runs the exact command the Dockerfile runs."""
    result = subprocess.run(
        [sys.executable, "-m", "reporting_agent.compile.ast", "--assert-build"],
        cwd=AGENT_ROOT,
        capture_output=True,
        text=True,
        env={"PYTHONPATH": str(AGENT_ROOT / "src"), "PATH": "/usr/bin:/bin"},
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "ok" in result.stdout


def test_the_build_time_entry_point_refuses_to_run_without_the_flag() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "reporting_agent.compile.ast"],
        cwd=AGENT_ROOT,
        capture_output=True,
        text=True,
        env={"PYTHONPATH": str(AGENT_ROOT / "src"), "PATH": "/usr/bin:/bin"},
        check=False,
    )
    assert result.returncode == 2, result.stdout


# --------------------------------------------------------------------------- #
# Guard the guard — every rule is proven to fire
# --------------------------------------------------------------------------- #


def _violations(namespace: dict[str, object], **over: object) -> list[str]:
    options: dict[str, object] = {
        "module_name": SYNTHETIC_MODULE,
        "required_names": (),
        "unions": (),
    }
    options.update(over)
    return A.collect_invariant_violations(namespace, **options)  # type: ignore[arg-type]


def _synthetic(name: str, fields: list[tuple[str, str]], **params: object) -> type:
    """A frozen, slotted dataclass in the synthetic module, with string annotations.

    Built with `dataclasses.make_dataclass` so the annotations are the *strings* handed
    in — the same form `from __future__ import annotations` produces in the real module,
    which is what the guard reads.
    """
    options: dict[str, object] = {"frozen": True, "slots": True}
    options.update(params)
    created = dataclasses.make_dataclass(
        name,
        [(field_name, annotation) for field_name, annotation in fields],
        **options,  # type: ignore[arg-type]
    )
    created.__module__ = SYNTHETIC_MODULE
    created.__annotations__ = dict(fields)
    return created


def test_the_guard_reports_nothing_for_a_clean_synthetic_namespace() -> None:
    clean = _synthetic("CleanNode", [("path", "FigurePath"), ("style", "str")])
    assert _violations({"CleanNode": clean}) == []


@pytest.mark.parametrize(
    "annotation", ["int", "float", "Decimal", "DecimalString", "complex", "Fraction"]
)
def test_the_guard_catches_a_numeric_annotation_on_a_non_exempt_dataclass(
    annotation: str,
) -> None:
    offender = _synthetic("Offender", [("path", "FigurePath"), ("count", annotation)])
    found = _violations({"Offender": offender})
    assert len(found) == 1, found
    assert annotation in found[0]


@pytest.mark.parametrize(
    "annotation",
    [
        "tuple[int, ...]",
        "int | None",
        "Decimal | None",
        "dict[str, int]",
        "tuple[str, Decimal]",
    ],
)
def test_the_guard_catches_a_numeric_type_nested_in_a_container(annotation: str) -> None:
    """A count hidden inside a container is still a count — the check is on the
    annotation's *text*, so `tuple[int, ...]` is caught as surely as `int`."""
    offender = _synthetic("Offender", [("path", "FigurePath"), ("hidden", annotation)])
    assert _violations({"Offender": offender}), annotation


def test_the_guard_exempts_only_the_named_node() -> None:
    exempt = _synthetic("Figure", [("value", "DecimalString")])
    other = _synthetic("Other", [("value", "DecimalString")])

    assert _violations({"Figure": exempt}) == []
    assert _violations({"Other": other})
    # And the exemption is by name, so renaming the exempt node does not carry it along.
    assert _violations({"Figure": exempt}, exempt="SomethingElse")


@pytest.mark.parametrize(
    "annotation",
    [
        "Figure | None",
        "tuple[Figure, ...] | None",
        "list[Figure]",
        "dict[str, Figure]",
        "Cell | None",
        "tuple[Cell]",
        "Inline | Text",
    ],
)
def test_the_guard_catches_a_figure_admitting_annotation_outside_the_six_spellings(
    annotation: str,
) -> None:
    offender = _synthetic("Offender", [("path", "FigurePath"), ("held", annotation)])
    found = _violations({"Offender": offender})
    assert any("is not one of" in message for message in found), found


@pytest.mark.parametrize("annotation", sorted(A.FIGURE_ADMITTING_ANNOTATIONS))
def test_the_guard_permits_each_of_the_six_spellings(annotation: str) -> None:
    permitted = _synthetic("Permitted", [("path", "FigurePath"), ("held", annotation)])
    assert _violations({"Permitted": permitted}) == []


def test_the_guard_does_not_confuse_figure_source_for_a_figure_position() -> None:
    """`tuple[FigureSource, ...]` is a descriptor list, not a figure position. Word
    boundaries are what keep the two apart — and the same reasoning keeps
    `DecimalString` from being reported as `Decimal`."""
    node = _synthetic("Node", [("derived_from", "tuple[FigureSource, ...]")])
    assert _violations({"Node": node}) == []


def test_the_guard_catches_a_dataclass_that_is_not_frozen() -> None:
    offender = _synthetic("Offender", [("path", "FigurePath")], frozen=False)
    found = _violations({"Offender": offender})
    assert any("frozen" in message for message in found), found


def test_the_guard_catches_a_dataclass_that_is_not_slotted() -> None:
    offender = _synthetic("Offender", [("path", "FigurePath")], slots=False)
    found = _violations({"Offender": offender})
    assert any("slots" in message for message in found), found


def test_the_guard_catches_an_empty_namespace() -> None:
    found = _violations({})
    assert any("inspecting nothing" in message for message in found), found


def test_the_guard_ignores_a_dataclass_defined_in_another_module() -> None:
    """`SnapshotValue` is imported into the AST module and legitimately carries a
    `Decimal`. The `__module__` filter is what stops the guard from failing on it."""
    assert SnapshotValue.__module__ != A.__name__

    namespace: dict[str, object] = {
        "Own": _synthetic("Own", [("path", "FigurePath")]),
        "SnapshotValue": SnapshotValue,
    }
    assert _violations(namespace) == []


def test_the_guard_catches_a_union_over_the_wrong_members() -> None:
    type WrongInline = A.Text | A.Figure | A.PageBreak

    found = _violations(
        {"WrongInline": WrongInline},
        unions=(("WrongInline", ("Text", "Figure")),),
    )
    assert any("union over" in message for message in found), found


def test_the_guard_catches_a_missing_required_node() -> None:
    found = _violations(
        {"Present": _synthetic("Present", [("path", "FigurePath")])},
        required_names=("Figure",),
    )
    assert any("no longer declares 'Figure'" in message for message in found), found


def test_the_guard_reports_every_violation_not_the_first() -> None:
    """One fix pass should be able to clear the module, which needs every violation
    named at once."""
    offender = _synthetic(
        "Offender",
        [("count", "int"), ("size", "Decimal"), ("held", "Figure | None")],
        frozen=False,
        slots=False,
    )
    found = _violations({"Offender": offender})
    assert len(found) >= 5, found


# --------------------------------------------------------------------------- #
# Req 15.4 — a non-Figure in a figure position raises with the path and the type
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def view():
    return build_snapshot_view(sf.two_vm_snapshot())


@pytest.fixture
def figure(view):
    resource = view.resources[0]
    value = view.stat(resource.resource_id, sf.CPU, "avg")
    assert value is not None
    with A.compiling_against(view):
        yield A.Figure(
            path=A.figure_path("kpi-1", 0),
            value=A.decimal_string_of(f"{value.value:f}", at="fixture"),
            unit=value.unit,
            snapshot_path=value.pointer,
            formatted="64.2%",
            fidelity_tier=value.fidelity_tier,
            statistic=value.statistic,
            metric=value.metric,
            resource_id=value.resource_id,
        )


@pytest.mark.parametrize(
    ("offender", "type_name"),
    [
        (Decimal("12.48"), "Decimal"),
        (12, "int"),
        ("12.48", "str"),
        (12.48, "float"),
        (Fraction(1, 2), "Fraction"),
        (None, "NoneType"),
    ],
)
def test_a_non_figure_in_a_figure_cell_raises_with_the_node_path_and_the_type(
    view, offender: object, type_name: str
) -> None:
    """Req 15.4. Four of these mean four different mistakes: a `Decimal` or a `float` is
    a raw quantity that skipped the formatter, an `int` is usually a cardinality that
    should not have been a figure at all, and a `str` is a pre-formatted string that
    skipped the ledger — which is precisely how a model-authored number would try to
    enter."""
    path = A.figure_path("kpi-1", 3)
    with A.compiling_against(view), pytest.raises(CompileFailedError) as caught:
        A.FigureCell(path=path, figure=offender)  # type: ignore[arg-type]

    message = str(caught.value)
    assert str(path) in message
    assert type_name in message


@pytest.mark.parametrize(
    ("offender", "type_name"),
    [(Decimal("1"), "Decimal"), (1, "int"), ("1", "str"), (1.0, "float")],
)
def test_a_non_figure_in_a_chart_point_raises_with_the_node_path_and_the_type(
    view, offender: object, type_name: str
) -> None:
    path = A.figure_path("chart-1", 0, 0)
    with A.compiling_against(view), pytest.raises(CompileFailedError) as caught:
        A.ChartPoint(path=path, x="prod-web-01", y=offender)  # type: ignore[arg-type]

    assert str(path) in str(caught.value)
    assert type_name in str(caught.value)


@pytest.mark.parametrize("offender", [Decimal("1"), 1, 1.0, "1"])
def test_a_bare_quantity_in_an_inline_position_raises(view, offender: object) -> None:
    """An inline position admits only `Text` or `Figure`, so a bare number cannot appear
    in prose — including the `str` a model would produce."""
    path = A.figure_path("prose-1", 0)
    with A.compiling_against(view), pytest.raises(CompileFailedError) as caught:
        A.Paragraph(path=path, style="Body Text", inlines=(offender,))  # type: ignore[arg-type]

    assert str(path) in str(caught.value)


def test_a_bare_quantity_in_a_cell_position_raises(view) -> None:
    path = A.figure_path("table-1", 1)
    with A.compiling_against(view), pytest.raises(CompileFailedError) as caught:
        A.Row(path=path, key="r1", cells=(Decimal("1"),))  # type: ignore[arg-type]

    assert str(path) in str(caught.value)
    assert "Decimal" in str(caught.value)


# --------------------------------------------------------------------------- #
# Req 15.11 — the re-resolution check, and its three distinct failures
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class _FakeResolver:
    """A resolver that answers with whatever it was handed.

    The reason `compile/ast.py` depends on the `SnapshotResolver` **protocol** rather
    than on `SnapshotView`: a real view refuses a duplicate pointer at build time, so
    "resolves to two values" is unreachable through it — and a rule that cannot be tested
    for failure is a rule nobody has seen work.
    """

    answers: tuple[SnapshotValue, ...]

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        return tuple(
            answer for answer in self.answers if answer.pointer == raw_pointer
        )


def _snapshot_value(pointer: str, value: str) -> SnapshotValue:
    return SnapshotValue(
        value=Decimal(value),
        unit="percent",
        statistic="avg",
        estimator="exact_count_weighted",
        fidelity_tier="baseline",
        scale=2,
        metric=sf.CPU,
        resource_id="/vm/a",
        window="2026-07-01/2026-07-02",
        pointer=pointer,
    )


def _figure_against(resolver: object, *, value: str, snapshot_path: str) -> A.Figure:
    with A.compiling_against(resolver):  # type: ignore[arg-type]
        return A.Figure(
            path=A.figure_path("kpi-1", 0),
            value=A.DecimalString(value),
            unit="percent",
            snapshot_path=snapshot_path,
            formatted=f"{value}%",
            fidelity_tier="baseline",
            statistic="avg",
        )


def test_a_figure_whose_provenance_resolves_is_constructed() -> None:
    pointer = "/resources/0/statistics/0/value"
    resolver = _FakeResolver(answers=(_snapshot_value(pointer, "12.48"),))
    figure = _figure_against(resolver, value="12.48", snapshot_path=pointer)
    assert figure.value == "12.48"


def test_a_snapshot_path_resolving_to_nothing_is_a_compile_failure() -> None:
    resolver = _FakeResolver(answers=())
    with pytest.raises(CompileFailedError) as caught:
        _figure_against(
            resolver, value="12.48", snapshot_path="/resources/0/statistics/0/value"
        )
    assert "addresses no value" in str(caught.value)


def test_a_snapshot_path_resolving_to_two_values_is_a_compile_failure() -> None:
    pointer = "/resources/0/statistics/0/value"
    resolver = _FakeResolver(
        answers=(_snapshot_value(pointer, "12.48"), _snapshot_value(pointer, "12.48"))
    )
    with pytest.raises(CompileFailedError) as caught:
        _figure_against(resolver, value="12.48", snapshot_path=pointer)
    assert "addresses 2 values" in str(caught.value)


def test_a_snapshot_path_addressing_a_different_decimal_string_is_a_compile_failure() -> None:
    """The transcription error that would otherwise reach a document looking entirely
    plausible."""
    pointer = "/resources/0/statistics/0/value"
    resolver = _FakeResolver(answers=(_snapshot_value(pointer, "12.48"),))
    with pytest.raises(CompileFailedError) as caught:
        _figure_against(resolver, value="12.49", snapshot_path=pointer)
    assert "'12.49'" in str(caught.value)
    assert "'12.48'" in str(caught.value)


def test_a_figure_cannot_be_constructed_outside_a_compile_context() -> None:
    """There is no ambient default and no "skip the check if no snapshot is bound": an
    unchecked provenance is the claim this class exists to refuse."""
    with pytest.raises(CompileFailedError, match="compiling against a snapshot"):
        A.Figure(
            path=A.figure_path("kpi-1", 0),
            value=A.DecimalString("1.00"),
            unit="percent",
            snapshot_path="/resources/0/statistics/0/value",
            formatted="1.0%",
            fidelity_tier="baseline",
            statistic="avg",
        )


def test_the_compile_context_is_restored_on_the_way_out(view) -> None:
    with A.compiling_against(view):
        pass
    with pytest.raises(CompileFailedError, match="compiling against a snapshot"):
        A.Figure(
            path=A.figure_path("kpi-1", 0),
            value=A.DecimalString("1.00"),
            unit="percent",
            snapshot_path="/resources/0/statistics/0/value",
            formatted="1.0%",
            fidelity_tier="baseline",
            statistic="avg",
        )


# --------------------------------------------------------------------------- #
# Immutability
# --------------------------------------------------------------------------- #


def test_assignment_to_a_constructed_figure_raises_figure_immutable_error(
    figure: A.Figure,
) -> None:
    with pytest.raises(A.FigureImmutableError):
        figure.formatted = "MUTATED"  # type: ignore[misc]
    with pytest.raises(A.FigureImmutableError):
        figure.value = A.DecimalString("0")  # type: ignore[misc]
    with pytest.raises(A.FigureImmutableError):
        figure.snapshot_path = "/elsewhere/value"  # type: ignore[misc]


def test_deletion_from_a_constructed_figure_raises(figure: A.Figure) -> None:
    with pytest.raises(A.FigureImmutableError):
        del figure.formatted  # type: ignore[misc]


def test_figure_immutable_error_is_a_frozen_instance_error(figure: A.Figure) -> None:
    """So a caller catching the standard frozen-dataclass error still catches this."""
    assert issubclass(A.FigureImmutableError, dataclasses.FrozenInstanceError)
    with pytest.raises(dataclasses.FrozenInstanceError):
        figure.unit = "bytes"  # type: ignore[misc]


def test_the_immutability_message_explains_why_it_matters(figure: A.Figure) -> None:
    with pytest.raises(A.FigureImmutableError) as caught:
        figure.formatted = "MUTATED"  # type: ignore[misc]
    assert "ledger" in str(caught.value)


# --------------------------------------------------------------------------- #
# Paths, anchors and declared child order
# --------------------------------------------------------------------------- #


def test_a_figure_path_is_block_id_then_dotted_ordinals() -> None:
    assert A.figure_path("kpi-1", 0) == "kpi-1:0"
    assert A.figure_path("kpi-1", 0, 2, 11) == "kpi-1:0.2.11"
    assert A.FIGURE_PATH_PATTERN.match(A.figure_path("a", 0))


def test_a_figure_path_accepts_a_block_id_containing_punctuation() -> None:
    """The definition schema bounds a block id at 1-64 characters and forbids no
    punctuation, so rejecting a `:` here would refuse a definition the web half accepts
    — the save-then-fail divergence the Mirror_Guard exists to prevent."""
    assert A.figure_path("a:b", 0) == "a:b:0"
    assert A.FIGURE_PATH_PATTERN.match("a:b:0")


@pytest.mark.parametrize(
    ("block_id", "ordinals"),
    [("", (0,)), ("x" * 65, (0,)), ("ok", ()), ("ok", (-1,)), ("ok", (True,))],
)
def test_an_invalid_figure_path_is_refused(block_id: str, ordinals: tuple) -> None:
    with pytest.raises(CompileFailedError):
        A.figure_path(block_id, *ordinals)


def test_table_and_chart_anchor_ids_carry_their_prefixes() -> None:
    path = A.figure_path("resources", 2)
    assert A.table_id(path) == f"tbl:{path}"
    assert A.chart_id(path) == f"cht:{path}"


def test_an_anchor_id_above_the_format_bound_is_refused() -> None:
    long_path = A.figure_path("b" * 64, *range(70))
    assert len(long_path) > A.ANCHOR_ID_MAX_LENGTH - len(A.TABLE_ID_PREFIX)
    with pytest.raises(CompileFailedError, match="255"):
        A.table_id(long_path)


def test_child_nodes_is_the_concatenation_of_child_bearing_fields_in_declaration_order(
    view,
) -> None:
    with A.compiling_against(view):
        resource = view.resources[0]
        value = view.stat(resource.resource_id, sf.CPU, "avg")
        figure = A.Figure(
            path=A.figure_path("t", 1, 0, 0),
            value=A.decimal_string_of(f"{value.value:f}", at="t"),
            unit=value.unit,
            snapshot_path=value.pointer,
            formatted="64.2%",
            fidelity_tier=value.fidelity_tier,
            statistic=value.statistic,
        )
        cell = A.FigureCell(path=A.figure_path("t", 1, 0), figure=figure)
        row = A.Row(path=A.figure_path("t", 1), key="r1", cells=(cell,))
        table = A.Table(
            path=A.figure_path("t", 0),
            style="Table Hairline",
            columns=(A.Column(key="cpu", header="CPU"),),
            rows=(row,),
        )

    # `Column` is a descriptor, not a node, so it contributes no child. `rows` does.
    assert A.child_nodes(table) == (row,)
    assert A.child_nodes(row) == (cell,)
    assert A.child_nodes(cell) == (figure,)
    # A figure is a leaf: `derived_from` holds descriptors, not nodes.
    assert A.child_nodes(figure) == ()


def test_child_nodes_returns_nothing_for_a_non_node() -> None:
    assert A.child_nodes(Decimal("1")) == ()
    assert A.child_nodes(A.Column(key="k", header="H")) == ()
    assert A.child_nodes(A.FigureSource(kind="metric", name=sf.CPU)) == ()


# --------------------------------------------------------------------------- #
# Node-level validators
# --------------------------------------------------------------------------- #


def test_a_layout_row_requires_two_or_three_columns() -> None:
    """Two or three is the tuple's own length (Req 15.6). There is no count field to
    disagree with the children the row actually holds."""
    root = A.figure_path("row-1", 0)
    columns = tuple(
        A.LayoutColumn(path=A.figure_path("row-1", 0, index)) for index in range(4)
    )

    for count in (2, 3):
        row = A.LayoutRow(path=root, columns=columns[:count])
        assert len(row.columns) == count
        assert A.child_nodes(row) == columns[:count]

    for count in (0, 1, 4):
        with pytest.raises(CompileFailedError, match="columns"):
            A.LayoutRow(path=root, columns=columns[:count])


def test_a_table_refuses_duplicate_column_or_row_keys() -> None:
    with pytest.raises(CompileFailedError, match="column key"):
        A.Table(
            path=A.figure_path("t", 0),
            style="Table Hairline",
            columns=(A.Column(key="cpu", header="CPU"), A.Column(key="cpu", header="CPU 2")),
        )
    with pytest.raises(CompileFailedError, match="row key"):
        A.Table(
            path=A.figure_path("t", 0),
            style="Table Hairline",
            rows=(
                A.Row(path=A.figure_path("t", 1), key="r"),
                A.Row(path=A.figure_path("t", 2), key="r"),
            ),
        )


def test_a_chart_requires_a_declared_type_and_encoding() -> None:
    for chart_type in A.CHART_TYPES:
        for encoding in A.CHART_ENCODINGS:
            chart = A.Chart(
                path=A.figure_path("c", 0),
                chart_type=chart_type,
                title="Top 5 VMs by Average CPU",
                unit="percent",
                encoding=encoding,
            )
            assert chart.anchor_id.startswith(A.CHART_ID_PREFIX)

    with pytest.raises(CompileFailedError, match="chart_type"):
        A.Chart(
            path=A.figure_path("c", 0),
            chart_type="pie",
            title="t",
            unit="percent",
            encoding="categorical",
        )
    with pytest.raises(CompileFailedError, match="encoding"):
        A.Chart(
            path=A.figure_path("c", 0),
            chart_type="bar",
            title="t",
            unit="percent",
            encoding="ordinal",
        )


def test_decimal_string_of_refuses_a_decimal_and_a_non_decimal_spelling() -> None:
    assert A.decimal_string_of("12.48", at="t") == "12.48"
    for bad in (Decimal("12.48"), 12, 12.48, True, None, "1E+3", "", "+1"):
        with pytest.raises(CompileFailedError):
            A.decimal_string_of(bad, at="t")
