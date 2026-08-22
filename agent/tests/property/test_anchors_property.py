"""Property 3: Anchored cell equality detects transposition.

**Validates: Requirements 27.1, 27.2, 27.3, 27.9, 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 21.8,
21.9, 30.2, 45.1**

*For any* generated data table and its anchors, an unmutated render records zero findings; any
value-preserving transposition of two columns' values records at least one
`table_cell_mismatch`; and any permutation of column or row order that moves each value
together with its header and row key records zero findings.

**On scale.** The requirement names 1–40 columns × 0–500 rows and charts of 1–8 series ×
1–744 points. A 40 × 500 grid is 20,000 cells, and every figure cell is a real `Figure`
re-resolved against a snapshot, so generating that shape a hundred times over would put this
module into the minutes. The split is the same one Property 2 makes and for the same reason:

* the **resolution** properties — `check_tables` over generated grids and a generated ledger,
  which is pure — run at 1–14 columns × 0–40 rows generated, plus **declared examples at 40
  columns and at 500 rows** that run on every invocation;
* the **structural** properties — every data table captioned, every layout table not, every
  identity unique and path-derived — run against a real compile and render, where the shape
  comes from the compiler rather than from a generator.

The large cases are therefore exercised deterministically rather than occasionally.
"""

from __future__ import annotations

import io
import json
from collections.abc import Sequence
from dataclasses import dataclass
from decimal import Decimal
from typing import Final

from docx import Document as open_docx
from docx.oxml.ns import qn
from hypothesis import example, given
from hypothesis import strategies as st

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.ast import (
    Figure,
    chart_id,
    compiling_against,
    decimal_string_of,
    figure_path,
    table_id,
)
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.figures import ANCHOR_TABLE, FigureLedger, TableAnchor
from reporting_agent.compile.snapshot_view import SnapshotValue, build_snapshot_view
from reporting_agent.render.docx import render_document
from reporting_agent.verify.anchors import (
    TableGrid,
    check_tables,
    containment_discrepancies,
    read_grids,
)
from reporting_agent.verify.charts import check_charts
from reporting_agent.verify.findings import (
    FINDING_TABLE_ANCHOR_MISSING,
    FINDING_TABLE_CELL_MISMATCH,
)
from reporting_agent.verify.tokens import table_caption

IDENTITY: Final[str] = "tbl:res:0"
MAX_COLUMNS: Final[int] = 14
MAX_ROWS: Final[int] = 40


# --------------------------------------------------------------------------- #
# A table, its ledger and its grid, generated together
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Case:
    """One generated table as both halves of the comparison.

    `ledger` and `grid` are built from one description, so an unmutated case agrees by
    construction and every disagreement in this module comes from a mutation rather than from
    the generator.
    """

    ledger: FigureLedger
    grid: TableGrid

    @property
    def headers(self) -> tuple[str, ...]:
        return self.grid.headers

    @property
    def rows(self) -> tuple[tuple[str, ...], ...]:
        return self.grid.rows


class _Resolver:
    """Answers every pointer this module mints.

    A `Figure` re-resolves its own `snapshot_path` at construction, which is the guarantee
    that a figure cannot exist without a snapshot position behind it. A generator needs one
    position per distinct value, and a real `SnapshotView` refuses to hold thousands of
    synthetic ones — so the protocol is satisfied directly, exactly as `test_ast_guard.py`
    does for the same reason.
    """

    def __init__(self, answers: dict[str, SnapshotValue]) -> None:
        self._answers = answers

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        found = self._answers.get(raw_pointer)
        return () if found is None else (found,)

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        """Numeric side only — this property compiles figures, not text facts."""
        del raw_pointer
        return ()


def _snapshot_value(pointer: str, value: str) -> SnapshotValue:
    return SnapshotValue(
        value=Decimal(value),
        unit="percent",
        statistic="avg",
        estimator="exact_count_weighted",
        fidelity_tier="baseline",
        scale=2,
        metric="Percentage CPU",
        resource_id="/vm/a",
        window="2026-07-01/2026-07-02",
        pointer=pointer,
    )


def build_case(*, columns: int, rows: int, figure_columns: frozenset[int]) -> Case:
    """A table of `columns` × `rows` whose figure cells all carry distinct values.

    Distinctness is required rather than incidental: two columns holding equal values in
    every row are indistinguishable after a transposition, so a generator that allowed it
    would produce cases where assertion 3.2 is *correctly* unsatisfiable and the property
    would be flaky rather than wrong.

    Column 0 is always the key column and always text, mirroring
    `render/anchors.py`'s `KEY_COLUMN_ORDINAL`.
    """
    headers = tuple(f"Column {index}" for index in range(columns))
    row_keys = tuple(f"vm-{index:04d}" for index in range(rows))

    answers: dict[str, SnapshotValue] = {}
    ledger = FigureLedger()
    grid_rows: list[tuple[str, ...]] = []
    counter = 0

    resolver = _Resolver(answers)
    with compiling_against(resolver):  # type: ignore[arg-type]
        for row_index, row_key in enumerate(row_keys):
            cells: list[str] = [row_key]
            for column_index in range(1, columns):
                if column_index not in figure_columns:
                    cells.append(f"text-{row_index}-{column_index}")
                    continue
                counter += 1
                raw = f"{counter // 100}.{counter % 100:02d}"
                pointer = f"/resources/{row_index}/metrics/{column_index}/avg/value"
                answers[pointer] = _snapshot_value(pointer, raw)
                figure = Figure(
                    path=figure_path("res", row_index, column_index),
                    value=decimal_string_of(raw, at="property"),
                    unit="percent",
                    snapshot_path=pointer,
                    formatted=f"{raw}%",
                    fidelity_tier="baseline",
                    statistic="avg",
                )
                ledger.insert(figure)
                ledger.record_anchor(
                    figure.path,
                    TableAnchor(
                        kind=ANCHOR_TABLE,
                        anchor_id=IDENTITY,
                        row_key=row_key,
                        column_key=headers[column_index],
                    ),
                )
                cells.append(figure.formatted)
            grid_rows.append(tuple(cells))

    ledger.register_table(figure_path("res", 0), IDENTITY)
    return Case(
        ledger=ledger,
        grid=TableGrid(
            identity=IDENTITY, ordinal=1, headers=headers, rows=tuple(grid_rows)
        ),
    )


@st.composite
def cases(draw: st.DrawFn) -> Case:
    """A table with at least one figure column wherever the shape allows one."""
    columns = draw(st.integers(min_value=1, max_value=MAX_COLUMNS))
    rows = draw(st.integers(min_value=0, max_value=MAX_ROWS))
    candidates = list(range(1, columns))
    chosen = (
        draw(st.lists(st.sampled_from(candidates), min_size=1, unique=True))
        if candidates
        else []
    )
    return build_case(columns=columns, rows=rows, figure_columns=frozenset(chosen))


def _figure_column_pair(case: Case) -> tuple[int, int] | None:
    """Two figure-bearing columns whose values differ in at least one row, or `None`."""
    anchored = sorted(
        {
            case.headers.index(str(anchor.column_key))
            for anchor in case.ledger.anchors().values()
        }
    )
    for left in anchored:
        for right in anchored:
            if left >= right:
                continue
            if any(row[left] != row[right] for row in case.rows):
                return (left, right)
    return None


def _swap(values: Sequence[str], left: int, right: int) -> tuple[str, ...]:
    swapped = list(values)
    swapped[left], swapped[right] = swapped[right], swapped[left]
    return tuple(swapped)


def _regrid(case: Case, *, headers=None, rows=None) -> TableGrid:
    return TableGrid(
        identity=case.grid.identity,
        ordinal=case.grid.ordinal,
        headers=case.headers if headers is None else headers,
        rows=case.rows if rows is None else rows,
    )


# --------------------------------------------------------------------------- #
# 3.1 — an unmutated render records nothing
# --------------------------------------------------------------------------- #


@given(cases())
@example(build_case(columns=40, rows=3, figure_columns=frozenset(range(1, 40))))
@example(build_case(columns=3, rows=500, figure_columns=frozenset({1, 2})))
@example(build_case(columns=1, rows=0, figure_columns=frozenset()))
def test_an_unmutated_table_records_no_finding(case: Case) -> None:
    """3.1. The two declared examples are the scale clause of Req 27, run every time: 40
    columns, and 500 rows."""
    outcome = check_tables(case.ledger, (case.grid,))

    assert outcome.findings == ()
    assert outcome.anchors_checked == len(case.ledger.anchors())
    assert len(outcome.matched) == outcome.anchors_checked
    assert outcome.faulted == frozenset()


# --------------------------------------------------------------------------- #
# 3.2 — a transposition fails here and passes a containment check
# --------------------------------------------------------------------------- #


@given(cases())
@example(build_case(columns=3, rows=4, figure_columns=frozenset({1, 2})))
def test_a_transposition_fails_while_containment_reports_nothing(case: Case) -> None:
    """3.2 and Req 27.3, together — and the second half is what gives the first its force.

    The declared example is the two-column `Avg CPU` / `Max CPU` table the task text names:
    every `formatted` string is still somewhere in the document after the swap, so a verifier
    checking containment records a clean pass on a report whose averages and peaks are
    swapped for every row.
    """
    pair = _figure_column_pair(case)
    if pair is None:
        return
    left, right = pair
    mutated = _regrid(case, rows=tuple(_swap(row, left, right) for row in case.rows))

    findings = check_tables(case.ledger, (mutated,)).findings

    assert any(f["type"] == FINDING_TABLE_CELL_MISMATCH for f in findings)
    assert containment_discrepancies(case.ledger, (mutated,)) == ()


# --------------------------------------------------------------------------- #
# 3.3 — a permutation that carries its header or its key changes nothing
# --------------------------------------------------------------------------- #


@given(cases(), st.integers(min_value=1, max_value=MAX_COLUMNS))
@example(build_case(columns=4, rows=3, figure_columns=frozenset({1, 2, 3})), 2)
def test_a_column_permutation_carrying_its_header_verifies_cleanly(
    case: Case, shift: int
) -> None:
    """3.3. The case a positional implementation gets backwards: it fails this and cannot
    detect 3.2 at all."""
    width = len(case.headers)
    if width < 3:
        return
    order = [0, *_rotated(range(1, width), shift)]

    permuted = _regrid(
        case,
        headers=tuple(case.headers[index] for index in order),
        rows=tuple(tuple(row[index] for index in order) for row in case.rows),
    )

    assert check_tables(case.ledger, (permuted,)).findings == ()


@given(cases())
def test_a_row_permutation_carrying_its_key_verifies_cleanly(case: Case) -> None:
    """3.3's other half. Rows resolve by key, so their order carries no information."""
    reversed_rows = _regrid(case, rows=case.rows[::-1])

    assert check_tables(case.ledger, (reversed_rows,)).findings == ()


def _rotated(values, shift: int) -> list[int]:
    items = list(values)
    if not items:
        return items
    offset = shift % len(items)
    return items[offset:] + items[:offset]


# --------------------------------------------------------------------------- #
# 3.4 — a single-cell mutation names the table, the row and the column
# --------------------------------------------------------------------------- #


@given(cases(), st.integers(min_value=0, max_value=10_000))
def test_a_single_cell_mutation_names_where_it_is(case: Case, pick: int) -> None:
    """3.4. A finding a reader can act on without opening the document."""
    anchors = sorted(
        ((str(path), anchor) for path, anchor in case.ledger.anchors().items()),
        key=lambda pair: pair[0],
    )
    if not anchors:
        return
    path, anchor = anchors[pick % len(anchors)]
    row_index = case.grid.row_keys.index(str(anchor.row_key))
    column_index = case.headers.index(str(anchor.column_key))

    row = list(case.rows[row_index])
    row[column_index] = "999999.99%"
    mutated = _regrid(
        case, rows=(*case.rows[:row_index], tuple(row), *case.rows[row_index + 1 :])
    )

    findings = [
        f
        for f in check_tables(case.ledger, (mutated,)).findings
        if f["type"] == FINDING_TABLE_CELL_MISMATCH
    ]

    assert len(findings) == 1
    assert findings[0]["table_id"] == IDENTITY
    assert findings[0]["row_key"] == anchor.row_key
    assert findings[0]["column_key"] == anchor.column_key
    assert findings[0]["ast_path"] == path
    assert findings[0]["observed"] == "999999.99%"
    assert findings[0]["expected"] == case.ledger[path].formatted


# --------------------------------------------------------------------------- #
# 3.6 — a removed caption is a missing anchor, not a silent pass
# --------------------------------------------------------------------------- #


@given(cases())
def test_a_removed_caption_makes_every_anchor_missing(case: Case) -> None:
    """3.6. A table with no caption is not in the pass at all, so every anchor naming it is
    unresolvable — the failure a verifier that scanned for numbers anywhere would not have."""
    outcome = check_tables(case.ledger, ())

    assert outcome.matched == frozenset()
    assert len(outcome.findings) == len(case.ledger.anchors())
    assert {f["type"] for f in outcome.findings} <= {FINDING_TABLE_ANCHOR_MISSING}


# --------------------------------------------------------------------------- #
# Determinism
# --------------------------------------------------------------------------- #


@given(cases(), st.integers(min_value=0, max_value=10_000))
def test_two_checks_of_one_document_produce_one_result(case: Case, pick: int) -> None:
    """Req 27.14. Ordering is by table, then row, then column — never by the order the
    ledger happened to iterate in, which is what a set anywhere on the path would expose."""
    rows = tuple(
        tuple(cell if index % 2 else "0" for index, cell in enumerate(row))
        for row in case.rows
    )
    mutated = _regrid(case, rows=rows)
    del pick

    first = check_tables(case.ledger, (mutated,)).findings
    second = check_tables(case.ledger, (mutated,)).findings

    assert first == second
    keys = [
        (str(f.get("table_id", "")), str(f.get("row_key", "")), str(f.get("column_key", "")))
        for f in first
    ]
    assert keys == sorted(keys)


# --------------------------------------------------------------------------- #
# The structural half — against a real compile and a real render
# --------------------------------------------------------------------------- #
#
# Everything above is pure, so it runs at the requirement's scale for free. The claims
# below are about what the *emitter* produces — which table gets a caption, which
# identity a table carries, whether a layout table can be pulled into the data pass — and
# those cannot be asserted over a generated grid, because a generated grid is exactly the
# thing whose production is in question.


BLOCK_CATALOGUE: Final[tuple[tuple[str, dict[str, object]], ...]] = (
    ("resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
    ("top_n_table", {"columns": [df.CPU_AVG], "order_by": df.CPU_AVG}),
    ("kpi_row", {"metrics": [df.CPU_AVG]}),
    (
        "capacity_vs_usage",
        {"capacity_metric": {"sku_capability": "vCPUsAvailable"}, "usage_metric": df.CPU_AVG},
    ),
    ("gaps_and_coverage", {}),
    ("verification_record", {}),
    ("appendix_methodology", {}),
    ("heading", {"level": 2, "text": "Utilization"}),
    ("rich_text", {"text": "Every figure below traces to the snapshot."}),
    ("timeseries_chart", {"metrics": [df.CPU_AVG]}),
    ("distribution_chart", {"metrics": [df.CPU_AVG]}),
)

# `page_break` is deliberately absent. Both validators accept one inside a `row`'s column
# and `render/docx.py` then refuses it as a contract violation, so a drawn document
# containing that shape fails the render rather than the property. That divergence is a real
# gap between the definition validator and the emitter — a template a wizard would save and
# a run would spend a full collection on before failing — but it belongs to the definition
# model, not to this pass, so it is excluded here rather than worked around.

ROW_SAFE: Final[frozenset[str]] = frozenset(
    {
        "resource_table",
        "top_n_table",
        "kpi_row",
        "capacity_vs_usage",
        "heading",
        "rich_text",
        "timeseries_chart",
        "distribution_chart",
    }
)
"""The block types a `row` column can actually hold.

`appendix_methodology`, `verification_record` and `executive_summary` defer their content
until every figure exists, and a row column is built before that point — the compiler refuses
them there by name. Same shape of gap as `page_break`: the validators accept the arrangement
and a later stage refuses it. Excluded here for the same reason."""

DESIGN: Final[dict[str, object]] = {
    "preset": "editorial",
    "accent_color": "#1f6f78",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": False,
    "logo": None,
    "page_size": "A4",
}


@st.composite
def documents(draw: st.DrawFn, *, nested: bool = True) -> tuple[object, object, bytes]:
    """A compiled and rendered document over a drawn subset of the block catalogue.

    Half the time the blocks are wrapped in a `row`, so a data table nested inside a layout
    cell — the structure `document.tables` cannot see and the one a caption-guessing verifier
    misclassifies — is generated rather than hoped for.
    """
    chosen = draw(
        st.lists(st.sampled_from(BLOCK_CATALOGUE), min_size=1, max_size=4, unique_by=str)
    )
    blocks: list[dict[str, object]] = [
        df.block(f"b{index}", block_type, dict(config))
        for index, (block_type, config) in enumerate(chosen)
    ]
    nestable = [
        block for block in blocks if str(block["type"]) in ROW_SAFE
    ]
    if nested and len(nestable) >= 2 and draw(st.booleans()):
        rest = [block for block in blocks if block not in nestable]
        blocks = [
            {"id": "row0", "type": "row", "columns": [[nestable[0]], nestable[1:]]},
            *rest,
        ]

    view = build_snapshot_view(sf.two_vm_snapshot())
    compiled = compile_document(df.definition(blocks, design=DESIGN), view=view)
    outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
    )
    return compiled, outcome, outcome.docx_bytes


@given(documents())
def test_a_real_render_verifies_and_every_identity_is_unique_and_path_derived(
    rendered: tuple[object, object, bytes],
) -> None:
    """The clean end-to-end case, plus Req 21.6's uniqueness and Req 21.1's derivation.

    An identity is `tbl:<path>` or `cht:<path>` for a node the tree actually holds — never a
    counter, never a name a template supplied — which is what makes a caption a claim about
    a position rather than a label.
    """
    compiled, outcome, payload = rendered
    grids = read_grids(open_docx(io.BytesIO(payload)))

    identities = [grid.identity for grid in grids]
    assert len(identities) == len(set(identities))
    assert set(identities) == set(compiled.ledger.table_identities())
    for identity, path in compiled.ledger.table_identities().items():
        assert identity in (table_id(path), chart_id(path))

    assert check_tables(compiled.ledger, grids).findings == ()
    assert set(outcome.table_identities) == set(identities)


@given(documents())
def test_every_data_table_carries_a_caption_and_every_layout_table_carries_none(
    rendered: tuple[object, object, bytes],
) -> None:
    """Req 21.1 and 21.2 — the asymmetry that excludes layout **by construction**.

    Asserted over the emitted package rather than over the AST, because the claim is about
    what got written: a `w:tbl` with a caption is in the data pass, and one without is not,
    and no other property of the element is consulted by either side.
    """
    _, _, payload = rendered
    document = open_docx(io.BytesIO(payload))

    in_the_pass = {grid.identity for grid in read_grids(document)}
    captions = [
        table_caption(element) for element in document.element.body.iter(qn("w:tbl"))
    ]

    # The partition, both directions: a captioned table is in the pass and an uncaptioned
    # one is not. No other property of the element is consulted by either side.
    assert {caption for caption in captions if caption is not None} == in_the_pass
    assert len(in_the_pass) == sum(1 for caption in captions if caption is not None)


def test_a_document_holding_both_kinds_of_table_partitions_them() -> None:
    """Non-vacuity for the property above, which a drawn document carrying no table at all
    would otherwise satisfy trivially.

    A `row` emits a layout table and its child emits a data table nested inside it, so one
    document carries one of each and the partition is asserted over a real instance of both.
    """
    view = build_snapshot_view(sf.two_vm_snapshot())
    definition = df.definition(
        [
            {
                "id": "row0",
                "type": "row",
                "columns": [
                    [df.block("t", "resource_table", {"columns": [df.CPU_AVG]})],
                    [df.block("h", "heading", {"level": 2, "text": "Aside"})],
                ],
            }
        ],
        design=DESIGN,
    )
    compiled = compile_document(definition, view=view)
    outcome = render_document(
        compiled.document, ledger=compiled.ledger, design=DesignSettings.from_plain(DESIGN)
    )
    document = open_docx(io.BytesIO(outcome.docx_bytes))

    captions = [
        table_caption(element) for element in document.element.body.iter(qn("w:tbl"))
    ]

    assert captions.count(None) >= 1, "the row emits a layout table, which carries no caption"
    assert [c for c in captions if c is not None] == ["tbl:t:0"]
    assert [grid.identity for grid in read_grids(document)] == ["tbl:t:0"]


@given(documents())
def test_a_layout_table_carrying_numeric_text_produces_no_table_finding(
    rendered: tuple[object, object, bytes],
) -> None:
    """3.5. The mutation is the point: an uncaptioned table is filled with a number that
    matches no ledger entry, and the anchored pass must be **identical** afterwards.

    A verifier that classified tables by borders, by cell count or by "does it look like
    data" would pull this table in and report a spurious finding on a correct document.
    """
    compiled, _, payload = rendered
    document = open_docx(io.BytesIO(payload))
    before = check_tables(compiled.ledger, read_grids(document)).findings

    injected = False
    for element in document.element.body.iter(qn("w:tbl")):
        if table_caption(element) is not None:
            continue
        for node in element.iter(qn("w:t")):
            node.text = "1,234.56 987.65"
            injected = True
            break
        break

    after = check_tables(compiled.ledger, read_grids(document)).findings

    assert after == before
    assert injected or all(
        table_caption(element) is not None
        for element in document.element.body.iter(qn("w:tbl"))
    )


@given(documents())
def test_a_recomputed_chart_hash_draws_no_contribution_from_the_sidecar(
    rendered: tuple[object, object, bytes],
) -> None:
    """Req 30.2 — the digest that would otherwise always agree with itself.

    Every sidecar is rewritten to one forged value. A recomputation reading the sidecar would
    report equality; a recomputation reading the ledger reports the forgery, for every chart.
    """
    compiled, outcome, payload = rendered
    grids = read_grids(open_docx(io.BytesIO(payload)))
    forged = "b" * 64
    sidecars = {
        key: json.dumps({"data_hash": forged}).encode() for key in outcome.chart_sidecars
    }

    clean = check_charts(
        compiled.document,
        grids=grids,
        sidecars=dict(outcome.chart_sidecars),
        table_pass=check_tables(compiled.ledger, grids),
    )
    tampered = check_charts(
        compiled.document,
        grids=grids,
        sidecars=sidecars,
        table_pass=check_tables(compiled.ledger, grids),
    )

    assert clean.hashes_matched == clean.charts_checked
    assert clean.findings == ()
    assert tampered.charts_checked == clean.charts_checked
    assert tampered.hashes_matched == 0
    assert len(tampered.findings) == tampered.charts_checked
    for finding in tampered.findings:
        assert finding["observed"] == forged
        assert finding["expected"] != forged
