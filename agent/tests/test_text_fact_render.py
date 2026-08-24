"""`render/anchors.py`, `render/docx.py` and `render/html.py` — how a text fact is emitted
(Req 6.4, 6.9, 8.4).

The AST is built **by hand** here rather than compiled from a definition, because no block
compiler emits a `TextFactCell` yet — that arrives with the table blocks. What is under test
is the three emitters' treatment of one, which is exactly the part that has to be right
before a compiler starts producing them.

## The claims worth machine-checking

 1. **One anchor mechanism.** `record_cell_anchor` builds the triple once and routes it by the
    cell's type. It replaced a pair of near-identical functions, and the failure it forecloses
    is a change to the triple's shape reaching one kind and not the other.
 2. **Exactly one run, in exactly one paragraph, in the `Figure` character style.** The facts
    pass concatenates a cell's runs with **no character between them**, so a second run is a
    place a later edit can insert a space that the comparison will not forgive.
 3. **The same character style as a figure**, because what the style marks is "this text is a
    checked value" — and it is what lets the token extractor find a fact whose value carries
    no digit.
 4. **The HTML carries `source` and `collected_at`.** A figure's source is implicit in its
    metric; a fact's is not, because two Azure APIs can answer for one resource and only one
    of them was asked.
 5. **The layout-table path records no anchor**, and stays reachable. Req 21.2 gives a layout
    table no `w:tblCaption`, so a fact emitted down it is unresolvable — which is a renderer
    defect, and negative test 15.11 drives it into `text_fact_unanchored`.
"""

from __future__ import annotations

import io
import zipfile
from dataclasses import dataclass
from typing import Any, Final

import pytest

from reporting_agent.compile.ast import (
    Column,
    Document,
    EmptyCell,
    FigureCell,
    Row,
    Table,
    TextCell,
    TextFactCell,
    compiling_against,
    figure_path,
)
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.figures import (
    ANCHOR_CHART,
    ANCHOR_TABLE,
    BlockCursor,
    FigureLedger,
)
from reporting_agent.compile.snapshot_view import FactTextValue, SnapshotValue
from reporting_agent.errors import RenderFailedError
from reporting_agent.render import anchors as A
from reporting_agent.render import docx as D
from reporting_agent.render import html as H
from reporting_agent.render.themes import FIGURE_CHARACTER_STYLE, load_theme
import messages_factory as mf

W: Final[str] = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

FACT_POINTER: Final[str] = "/resources/0/facts/0/value"
STAT_POINTER: Final[str] = "/resources/0/statistics/0/value"
COLLECTED_AT: Final[str] = "2026-08-01T09:30:15Z"
FACT_SOURCE: Final[str] = "recovery_services"
FACT_KEY: Final[str] = "last_backup_status"
FACT_VALUE: Final[str] = "Succeeded"
RESOURCE_ID: Final[str] = "/subscriptions/s/resourceGroups/rg/providers/x/vm/prod-web-01"

DESIGN: Final[DesignSettings] = DesignSettings.from_plain(
    {
        "preset": "editorial",
        "accent_color": "#1f6f78",
        "density": "normal",
        "table_style": "hairline",
        "number_format": {"decimal_places": 2, "group_thousands": True},
        "cover_page": False,
        "logo": None,
        "page_size": "A4",
    }
)


# --------------------------------------------------------------------------- #
# Fixtures
# --------------------------------------------------------------------------- #


@dataclass
class Resolver:
    """Answers on both sides, so a fact re-resolves at construction the way it does in a run."""

    text: dict[str, tuple[str, ...]]
    numeric: dict[str, tuple[SnapshotValue, ...]]

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        return self.numeric.get(raw_pointer, ())

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        return self.text.get(raw_pointer, ())


def numeric_value(value: str = "12.4") -> SnapshotValue:
    return SnapshotValue(
        value=__import__("decimal").Decimal(value),
        unit="percent",
        statistic="avg",
        estimator="exact_count_weighted",
        fidelity_tier="baseline",
        scale=1,
        metric="Percentage CPU",
        resource_id=RESOURCE_ID,
        window="2026-07-01/2026-07-31",
        pointer=STAT_POINTER,
    )


def fact_value(value: str = FACT_VALUE) -> FactTextValue:
    return FactTextValue(
        key=FACT_KEY,
        value=value,
        source=FACT_SOURCE,
        collected_at=COLLECTED_AT,
        pointer=FACT_POINTER,
        resource_id=RESOURCE_ID,
    )


def resolver(fact_text: str = FACT_VALUE) -> Resolver:
    return Resolver(
        text={FACT_POINTER: (fact_text,)},
        numeric={STAT_POINTER: (numeric_value(),)},
    )


def cursor_at(ledger: FigureLedger, *ordinals: int) -> BlockCursor:
    found = BlockCursor(block_id="facts", ledger=ledger)
    for ordinal in ordinals:
        found = found.child("nodes", ordinal)
    return found


def one_fact_table(
    ledger: FigureLedger, *, value: str = FACT_VALUE
) -> tuple[Table, Any]:
    """A two-column data table whose second cell is the fact. Returns `(table, fact)`.

    The key column carries a resource **name**: `document_row_key` records the emitted text,
    so a table whose first cell is the fact itself would have no readable row key.
    """
    with compiling_against(resolver(value)):
        fact = cursor_at(ledger, 0, 0, 1, 0).text_fact(fact_value(value))

    table = Table(
        path=figure_path("facts", 0),
        # The **resolved Word style name**, not the definition's `table_style` token: the
        # compiler resolves `"hairline"` to this, and the renderer checks it against the
        # theme's declared styles.
        style="Table Hairline",
        columns=(
            Column(key="resource", header="Resource"),
            Column(key="backup", header="Last backup"),
        ),
        rows=(
            Row(
                path=figure_path("facts", 0, 0),
                key=RESOURCE_ID,
                cells=(
                    TextCell(path=figure_path("facts", 0, 0, 0), text="prod-web-01"),
                    TextFactCell(path=figure_path("facts", 0, 0, 1), fact=fact),
                ),
            ),
        ),
    )
    return table, fact


def render(table: Table, ledger: FigureLedger) -> D.RenderOutcome:
    return D.render_document(
        Document(blocks=(table,)), ledger=ledger, design=DESIGN,
    messages=mf.EN,
    )


def body_element(payload: bytes):
    from lxml import etree

    with zipfile.ZipFile(io.BytesIO(payload)) as archive:
        xml = archive.read("word/document.xml")
    return etree.fromstring(xml).find(f"{W}body")


def styled_runs(payload: bytes, style_id: str) -> list[str]:
    found: list[str] = []
    for run in body_element(payload).iter(f"{W}r"):
        properties = run.find(f"{W}rPr")
        if properties is None:
            continue
        style = properties.find(f"{W}rStyle")
        if style is not None and style.get(f"{W}val") == style_id:
            found.append("".join(node.text or "" for node in run.iter(f"{W}t")))
    return found


def fact_cell_element(payload: bytes):
    """The `w:tc` holding the fact — the second cell of the one data row."""
    table = next(iter(body_element(payload).iter(f"{W}tbl")))
    rows = table.findall(f"{W}tr")
    return rows[-1].findall(f"{W}tc")[1]


# --------------------------------------------------------------------------- #
# Req 6.9 — one anchor mechanism, routed by cell type
# --------------------------------------------------------------------------- #


def test_the_ledger_bearing_cells_are_the_two_that_carry_an_entry() -> None:
    """`TextCell` and `EmptyCell` carry no ledger entry, so an anchor for either would be a
    claim about a document position holding no checked value."""
    assert A._LEDGER_BEARING_CELLS == (FigureCell, TextFactCell)


def test_one_recorder_routes_a_figure_cell_and_a_fact_cell_to_their_own_mapping() -> None:
    ledger = FigureLedger()
    with compiling_against(resolver()):
        figure = cursor_at(ledger, 0).figure(numeric_value())
        fact = cursor_at(ledger, 1).text_fact(fact_value())

    A.record_cell_anchor(
        ledger,
        FigureCell(path=figure.path, figure=figure),
        anchor_kind=ANCHOR_TABLE,
        anchor_id="tbl:facts:0",
        row_key="prod-web-01",
        column_key="Average CPU",
    )
    A.record_cell_anchor(
        ledger,
        TextFactCell(path=fact.path, fact=fact),
        anchor_kind=ANCHOR_TABLE,
        anchor_id="tbl:facts:0",
        row_key="prod-web-01",
        column_key="Last backup",
    )

    # Disjoint mappings, one triple shape. The whole point of the single builder is that these
    # two anchors cannot differ in structure.
    assert set(ledger.anchors()) == {figure.path}
    assert set(ledger.text_fact_anchors()) == {fact.path}
    numeric_anchor = ledger.anchors()[figure.path]
    fact_anchor = ledger.text_fact_anchors()[fact.path]
    assert numeric_anchor.kind == fact_anchor.kind == ANCHOR_TABLE
    assert numeric_anchor.anchor_id == fact_anchor.anchor_id == "tbl:facts:0"
    assert numeric_anchor.row_key == fact_anchor.row_key == "prod-web-01"
    assert (numeric_anchor.column_key, fact_anchor.column_key) == (
        "Average CPU",
        "Last backup",
    )


def test_the_chart_kind_reaches_a_fact_anchor_too() -> None:
    """A chart's companion table takes the chart's identity, and a fact in one is anchored
    against that identity rather than a `tbl:` one it would pair with nothing."""
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor_at(ledger, 0).text_fact(fact_value())

    A.record_cell_anchor(
        ledger,
        TextFactCell(path=fact.path, fact=fact),
        anchor_kind=ANCHOR_CHART,
        anchor_id="cht:trend:0",
        row_key="prod-web-01",
        column_key="Last backup",
    )

    anchor = ledger.text_fact_anchors()[fact.path]
    assert (anchor.kind, anchor.anchor_id) == (ANCHOR_CHART, "cht:trend:0")


@pytest.mark.parametrize(
    "cell",
    [
        pytest.param(TextCell(path=figure_path("facts", 0), text="x"), id="TextCell"),
        pytest.param(EmptyCell(path=figure_path("facts", 0)), id="EmptyCell"),
        pytest.param("not a cell", id="a bare string"),
    ],
)
def test_a_cell_carrying_no_ledger_entry_is_refused(cell: object) -> None:
    with pytest.raises(RenderFailedError) as raised:
        A.record_cell_anchor(
            FigureLedger(),
            cell,
            anchor_kind=ANCHOR_TABLE,
            anchor_id="tbl:facts:0",
            row_key="r",
            column_key="c",
        )

    assert "carries no ledger entry" in str(raised.value)


def test_an_anchor_kind_outside_the_two_is_refused() -> None:
    """The verifier pairs an anchor with a table or with a chart and has no third case, so an
    unknown kind is a `RENDER_FAILED` here rather than an anchor nothing resolves later."""
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor_at(ledger, 0).text_fact(fact_value())

    with pytest.raises(RenderFailedError) as raised:
        A.record_cell_anchor(
            ledger,
            TextFactCell(path=fact.path, fact=fact),
            anchor_kind="paragraph",
            anchor_id="tbl:facts:0",
            row_key="r",
            column_key="c",
        )

    assert "neither" in str(raised.value)
    assert not ledger.text_fact_anchors()


def test_the_two_removed_helpers_are_gone_so_there_is_one_builder() -> None:
    """`record_figure_anchor` and `record_chart_anchor` were two construction sites for one
    triple. Asserting their absence is what stops one being reintroduced beside the router."""
    assert not hasattr(A, "record_figure_anchor")
    assert not hasattr(A, "record_chart_anchor")
    assert "record_cell_anchor" in A.__all__


# --------------------------------------------------------------------------- #
# Req 6.4 — one run, one paragraph, the Figure character style
# --------------------------------------------------------------------------- #


def test_a_text_fact_is_one_figure_styled_run_holding_the_value() -> None:
    ledger = FigureLedger()
    table, fact = one_fact_table(ledger)

    outcome = render(table, ledger)

    # The same character style a figure takes: what it marks is "this text is a checked
    # value", which is as true of `Succeeded` as of `12.5%`.
    assert styled_runs(outcome.docx_bytes, FIGURE_CHARACTER_STYLE) == [FACT_VALUE]
    assert fact.formatted == FACT_VALUE


def test_the_fact_cell_holds_exactly_one_paragraph_and_one_run() -> None:
    """The facts pass concatenates a cell's runs with **no character between them**, so this
    is the invariant the comparison rests on. Asserted on the emitted XML rather than on the
    emitter's own bookkeeping, because it is a property of the document."""
    ledger = FigureLedger()
    table, _ = one_fact_table(ledger)

    cell = fact_cell_element(render(table, ledger).docx_bytes)

    paragraphs = cell.findall(f"{W}p")
    assert len(paragraphs) == 1
    assert len(paragraphs[0].findall(f"{W}r")) == 1
    assert "".join(node.text or "" for node in cell.iter(f"{W}t")) == FACT_VALUE


@pytest.mark.parametrize(
    "value",
    [
        "Succeeded",
        "Standard_D4s_v3",
        "Windows Server 2022",
        "10.0.0.0/16",
        "  padded  ",
    ],
)
def test_the_run_holds_the_formatted_string_and_no_other_character(value: str) -> None:
    """Including the padded case: `format_text_fact` does not trim, so the run must not
    either. A renderer that stripped would emit a string the ledger does not carry, and the
    facts pass compares character for character."""
    ledger = FigureLedger()
    table, _ = one_fact_table(ledger, value=value)

    cell = fact_cell_element(render(table, ledger).docx_bytes)

    texts = [node.text or "" for node in cell.iter(f"{W}t")]
    assert "".join(texts) == value


def test_a_fact_emitted_into_an_occupied_paragraph_is_refused() -> None:
    """Two runs would concatenate correctly today and are a place a later edit can insert a
    separator the comparison admits none of. Refused where the runs are created."""
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor_at(ledger, 0).text_fact(fact_value())

    document = load_theme(DESIGN.preset)
    paragraph = document.add_paragraph()
    paragraph.add_run("already here")
    emitter = D._Emitter(
        document=document,
        ledger=ledger,
        design=DESIGN,
        messages=mf.EN,
        recorder=A.AnchorRecorder(ledger=ledger),
        declared_styles=frozenset({FIGURE_CHARACTER_STYLE}),
    )

    with pytest.raises(RenderFailedError) as raised:
        emitter.write_text_fact_run(paragraph, fact)

    assert "already carries" in str(raised.value)


def test_the_emitted_counts_are_separate_for_the_two_kinds() -> None:
    """Req 6.15 — a text fact is a checked value and not a figure. One total would make an
    unrendered figure and an unrendered fact indistinguishable in the number read first."""
    ledger = FigureLedger()
    table, _ = one_fact_table(ledger)

    outcome = render(table, ledger)

    assert outcome.text_facts_emitted == 1
    assert outcome.figures_emitted == 0


def test_the_anchor_is_recorded_against_the_tables_own_identity_and_emitted_strings() -> None:
    """The triple the verifier resolves against: the caption Word carries, the key column's
    **emitted text**, and the column's **header**. Not `Row.key` and not `Column.key`."""
    ledger = FigureLedger()
    table, fact = one_fact_table(ledger)

    render(table, ledger)

    anchor = ledger.text_fact_anchors()[fact.path]
    assert anchor.anchor_id == table.anchor_id
    # The row's key is a resource id; the document shows a resource name.
    assert table.rows[0].key == RESOURCE_ID
    assert anchor.row_key == "prod-web-01"
    assert anchor.column_key == "Last backup"


# --------------------------------------------------------------------------- #
# Req 8.4 — the layout path records no anchor, and stays reachable
# --------------------------------------------------------------------------- #


def test_a_fact_emitted_down_the_layout_path_records_no_anchor() -> None:
    """Req 21.2 gives a layout table no `w:tblCaption`, so the verifier's table pass skips it
    and a fact inside one resolves against nothing.

    The path is left reachable **on purpose**: the type system stops a `TextFact` occupying a
    non-cell *AST* position and does not stop a *renderer* emitting one down here, which is a
    renderer defect of exactly the class `text_fact_unanchored` exists to catch. Negative test
    15.11 drives it end to end; this asserts the mechanism it depends on — that emitting the
    run and recording the anchor are separate steps, so skipping the second leaves the first
    intact.
    """
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor_at(ledger, 0).text_fact(fact_value())

    document = load_theme(DESIGN.preset)
    docx_table = document.add_table(rows=1, cols=1)
    A.write_layout_table(docx_table)
    emitter = D._Emitter(
        document=document,
        ledger=ledger,
        design=DESIGN,
        messages=mf.EN,
        recorder=A.AnchorRecorder(ledger=ledger),
        declared_styles=frozenset({FIGURE_CHARACTER_STYLE}),
    )

    emitter.write_text_fact_run(docx_table.rows[0].cells[0].paragraphs[0], fact)

    # The fact is in the document and unanchored — which is the state 15.11 asserts is
    # blocking rather than a state this renderer prevents.
    assert emitter.text_facts_emitted == 1
    assert not ledger.text_fact_anchors()
    assert A.read_table_caption(docx_table) is None


def test_a_layout_table_carries_no_caption_so_a_fact_in_it_is_unresolvable() -> None:
    """The other half: the exclusion is by construction, not by inspecting the contents."""
    document = load_theme(DESIGN.preset)
    docx_table = document.add_table(rows=1, cols=1)
    A.write_data_table_caption(docx_table, "tbl:facts:0")
    assert A.read_table_caption(docx_table) == "tbl:facts:0"

    A.write_layout_table(docx_table)

    assert A.read_table_caption(docx_table) is None


# --------------------------------------------------------------------------- #
# Req 6.9 — the HTML preview carries the source and the instant
# --------------------------------------------------------------------------- #


def test_the_html_cell_carries_the_facts_source_and_collected_at() -> None:
    ledger = FigureLedger()
    table, fact = one_fact_table(ledger)

    outcome = H.emit_html(Document(blocks=(table,)), messages=mf.EN)

    assert f'data-fact-source="{FACT_SOURCE}"' in outcome.html
    assert f'data-collected-at="{COLLECTED_AT}"' in outcome.html
    # The provenance a figure also carries, so the reveal is one interaction.
    assert f'data-snapshot-path="{FACT_POINTER}"' in outcome.html
    assert f'data-fact-key="{FACT_KEY}"' in outcome.html
    assert f">{FACT_VALUE}</span>" in outcome.html
    assert fact.source == FACT_SOURCE


def test_the_html_counts_facts_separately_from_figures() -> None:
    ledger = FigureLedger()
    table, _ = one_fact_table(ledger)

    outcome = H.emit_html(Document(blocks=(table,)), messages=mf.EN)

    assert outcome.text_fact_count == 1
    assert outcome.figure_count == 0


def test_the_html_escapes_a_facts_value_and_its_attributes() -> None:
    """Escaped for HTML, which changes the bytes on the wire and not the text a reader gets.
    A value carrying markup is a value Azure returned, so it is emitted rather than rejected —
    and emitted safely."""
    ledger = FigureLedger()
    table, _ = one_fact_table(ledger, value='<script>"x"</script>')

    outcome = H.emit_html(Document(blocks=(table,)), messages=mf.EN)

    assert "<script>" not in outcome.html
    assert "&lt;script&gt;" in outcome.html
