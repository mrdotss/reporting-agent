"""The HTML emitter (Req 24), and its agreement with the DOCX emitter.

The theme running through these tests: **the two emitters walk one tree, so they cannot
disagree.** The strongest assertions here are the ones that render the *same compiled document*
both ways and compare — headers, row keys, cell strings, order, figure count. Anything that only
inspected the HTML would be checking that this module is self-consistent, which is not the
property that matters.

The second theme is what the emitter deliberately *cannot* do: no pagination, no table identity,
no composed estimator label, no partial rendering. Each of those is an absence, so each gets an
explicit test — an absence nobody asserts is an absence that grows a feature.
"""

from __future__ import annotations

import re
import zipfile
from typing import Final

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.ast import (
    Column,
    Document,
    EmptyCell,
    LayoutColumn,
    LayoutRow,
    Paragraph,
    Row,
    Table,
    Text,
    TextCell,
    compiling_against,
    figure_path,
)
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT, DesignSettings
from reporting_agent.compile.messages import load_messages

_EMPTY_SCOPE_RESOLVED = load_messages("en").text(EMPTY_SCOPE_TEXT)
from reporting_agent.compile.figures import BlockCursor, FigureLedger
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render import html as H
from reporting_agent.render.docx import render_document

W: Final[str] = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"

DESIGN: Final[dict[str, object]] = {
    "preset": "editorial",
    "accent_color": "#1f6f78",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": True,
    "logo": None,
    "page_size": "A4",
}

EVERYTHING: Final[list] = [
    df.block("cover", "cover", {"subtitle": "Monthly review"}),
    df.block("h", "heading", {"text": "Utilization", "level": 1}),
    df.block("p", "rich_text", {"text": "CPU headroom is substantial."}),
    df.block("t", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX], "caption": "Cap"}),
    df.block("k", "kpi_row", {"metrics": [df.CPU_AVG]}),
    df.block("g", "gaps_and_coverage", {}),
    df.block("v", "verification_record", {}),
    df.block("m", "appendix_methodology", {}),
]


def compiled_document(blocks=None, *, view=None):
    resolved = build_snapshot_view(sf.two_vm_snapshot()) if view is None else view
    return compile_document(
        df.definition(blocks or EVERYTHING, design=DESIGN), view=resolved
    )


def emit(blocks=None, *, view=None):
    compiled = compiled_document(blocks, view=view)
    return compiled, H.emit_html(compiled.document)


def figure_spans(markup: str) -> list[str]:
    return re.findall(rf'<span class="{H.FIGURE_CLASS}"[^>]*>([^<]*)</span>', markup)


def attributes_of_figures(markup: str) -> list[str]:
    return re.findall(rf'<span class="{H.FIGURE_CLASS}"([^>]*)>', markup)


# --------------------------------------------------------------------------- #
# Req 24.1 — the same tree, no second AST, no rules of its own
# --------------------------------------------------------------------------- #


def test_the_emitter_walks_the_document_it_is_handed() -> None:
    compiled, outcome = emit()
    assert outcome.html.startswith('<div class="rpt-document">')
    assert outcome.figure_count == len(compiled.ledger)


def test_the_two_emitters_walk_one_tree_and_agree_on_figure_count() -> None:
    compiled = compiled_document()
    html_outcome = H.emit_html(compiled.document)
    docx_outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
    )
    assert html_outcome.figure_count == docx_outcome.figures_emitted == len(compiled.ledger)


def test_emitting_twice_from_one_tree_produces_identical_markup() -> None:
    """No hidden state, no clock, no ordering that depends on anything but the tree."""
    compiled = compiled_document()
    assert H.emit_html(compiled.document).html == H.emit_html(compiled.document).html


def test_blocks_are_emitted_in_the_order_the_ast_declares() -> None:
    _, outcome = emit(
        [
            df.block("z", "rich_text", {"text": "First."}),
            df.block("t", "resource_table", {"columns": [df.CPU_AVG]}),
            df.block("a", "rich_text", {"text": "Third."}),
        ]
    )
    assert outcome.html.index("First.") < outcome.html.index("<table")
    assert outcome.html.index("<table") < outcome.html.index("Third.")


def test_the_emitter_holds_no_ordering_or_layout_rule_of_its_own() -> None:
    """Req 24.1's "no layout definition of its own", asserted against the source.

    A structural check rather than a behavioural one, because the property is an absence: there
    is no sort, no reversal and no grouping anywhere in the module, so there is nothing that
    could disagree with the compiler about order.
    """
    import inspect

    source = inspect.getsource(H)
    body = "\n".join(
        line for line in source.splitlines() if not line.strip().startswith("#")
    )
    for forbidden in ("sorted(", ".sort(", "reversed(", "itertools.groupby"):
        assert forbidden not in body, forbidden


# --------------------------------------------------------------------------- #
# Req 24.2 — formatted verbatim, provenance as attributes
# --------------------------------------------------------------------------- #


def test_every_figure_carries_its_formatted_string_exactly() -> None:
    compiled, outcome = emit()
    expected = sorted(figure.formatted for figure in compiled.ledger.entries.values())
    emitted = sorted(figure_spans(outcome.html))
    # The markup is HTML-escaped, which changes bytes on the wire and not the text a reader
    # gets — so compare after unescaping.
    import html as html_module

    assert [html_module.unescape(value) for value in emitted] == expected


def test_every_figure_carries_its_snapshot_path() -> None:
    compiled, outcome = emit()
    paths = re.findall(r'data-snapshot-path="([^"]*)"', outcome.html)
    assert len(paths) == len(compiled.ledger)
    assert set(paths) == {
        figure.snapshot_path for figure in compiled.ledger.entries.values()
    }


def test_no_figure_element_is_emitted_without_its_provenance_attributes() -> None:
    """Req 24.2 — so the provenance reveal *reads* those attributes rather than deriving
    them."""
    _, outcome = emit()
    for attributes in attributes_of_figures(outcome.html):
        assert "data-snapshot-path=" in attributes
        assert "data-figure-path=" in attributes


def test_an_estimated_figure_carries_the_ledgers_label_and_an_exact_one_does_not() -> None:
    """The label comes from the ledger; this module composes none of its own.

    An exact value has nothing to qualify, so emitting an empty label attribute for it would
    make the UI's "is this estimated?" test a string comparison rather than a presence check.
    """
    compiled, outcome = emit(
        [
            df.block("t", "resource_table", {"columns": [df.CPU_AVG, df.CPU_P95]}),
        ]
    )
    estimated = [
        figure for figure in compiled.ledger.entries.values() if figure.estimator_label
    ]
    exact = [
        figure for figure in compiled.ledger.entries.values() if not figure.estimator_label
    ]
    assert estimated, "the fixture must include an estimated statistic"
    assert exact, "the fixture must include an exact statistic"

    labels = re.findall(r'data-estimator-label="([^"]*)"', outcome.html)
    assert len(labels) == len(estimated)
    assert set(labels) == {figure.estimator_label for figure in estimated}


def test_the_estimator_label_carries_no_bare_percentile_designation() -> None:
    """Composed by `compile/estimators.py` without a numeral, and passed through untouched."""
    _, outcome = emit([df.block("t", "resource_table", {"columns": [df.CPU_P95]})])
    for label in re.findall(r'data-estimator-label="([^"]*)"', outcome.html):
        assert "est." in label or "estimated" in label, label


def test_the_emitter_composes_no_label_of_its_own() -> None:
    import inspect

    source = inspect.getsource(H)
    assert "estimator_label" in source
    # No f-string builds one: the only use is reading the ledger's value.
    assert not re.search(r'f"[^"]*est\. from', source)


def test_a_figure_with_no_formatted_string_is_refused() -> None:
    view = build_snapshot_view(sf.two_vm_snapshot())
    ledger = FigureLedger()
    with compiling_against(view):
        value = view.stat(view.resources[0].resource_id, sf.CPU, "avg")
        assert value is not None
        cursor = BlockCursor(block_id="p", ledger=ledger)
        figure = cursor.child("nodes", 0).child("inlines", 0).figure(value)
        object.__setattr__(figure, "formatted", "")
        document = Document(
            blocks=(Paragraph(path=figure_path("p", 0), style="Body Text", inlines=(figure,)),)
        )
        with pytest.raises(H.HtmlEmitFailed, match="no formatted string"):
            H.emit_html(document)


def test_a_figure_with_no_snapshot_path_is_refused() -> None:
    view = build_snapshot_view(sf.two_vm_snapshot())
    ledger = FigureLedger()
    with compiling_against(view):
        value = view.stat(view.resources[0].resource_id, sf.CPU, "avg")
        assert value is not None
        cursor = BlockCursor(block_id="p", ledger=ledger)
        figure = cursor.child("nodes", 0).child("inlines", 0).figure(value)
        object.__setattr__(figure, "snapshot_path", "")
        document = Document(
            blocks=(Paragraph(path=figure_path("p", 0), style="Body Text", inlines=(figure,)),)
        )
        with pytest.raises(H.HtmlEmitFailed, match="no snapshot path"):
            H.emit_html(document)


def test_a_formatted_string_containing_markup_is_escaped() -> None:
    """Not a realistic figure, but the escaping has to be unconditional: a `formatted` string
    is data, and data that reaches a template unescaped is an injection."""
    view = build_snapshot_view(sf.two_vm_snapshot())
    ledger = FigureLedger()
    with compiling_against(view):
        value = view.stat(view.resources[0].resource_id, sf.CPU, "avg")
        assert value is not None
        cursor = BlockCursor(block_id="p", ledger=ledger)
        figure = cursor.child("nodes", 0).child("inlines", 0).figure(value)
        object.__setattr__(figure, "formatted", "<script>alert(1)</script>")
        document = Document(
            blocks=(Paragraph(path=figure_path("p", 0), style="Body Text", inlines=(figure,)),)
        )
        markup = H.emit_html(document).html
    assert "<script>" not in markup
    assert "&lt;script&gt;" in markup


def test_prose_is_escaped_too() -> None:
    _, outcome = emit([df.block("p", "rich_text", {"text": "5 < 10 & \"quoted\""})])
    assert "5 &lt; 10 &amp;" in outcome.html
    assert "5 < 10 &" not in outcome.html


# --------------------------------------------------------------------------- #
# Req 24.3 — mono, tabular, no animation
# --------------------------------------------------------------------------- #


def test_every_figure_carries_the_one_class_the_stylesheet_hooks() -> None:
    """A class rather than an inline style repeated per element: the hook has to be reliable,
    and mono + tabular numerals is a stylesheet's job."""
    compiled, outcome = emit()
    assert outcome.html.count(f'class="{H.FIGURE_CLASS}"') == len(compiled.ledger)


def test_no_figure_carries_an_animation_or_transition_hook() -> None:
    """Req 24.3 — a count-up on a verified figure is decoration pretending to be data."""
    _, outcome = emit()
    for forbidden in ("animate", "transition", "count-up", "countup", "@keyframes"):
        assert forbidden not in outcome.html.lower(), forbidden


# --------------------------------------------------------------------------- #
# Req 24.4 — no pagination, ever
# --------------------------------------------------------------------------- #


def test_no_page_number_or_count_is_emitted() -> None:
    """The emitter determines no pagination — Word does, from font metrics and column widths
    this module never sees — so any page count it emitted would be a guess."""
    _, outcome = emit(
        [
            *EVERYTHING,
            df.block("pb", "page_break", {}),
        ]
    )
    for attribute in H.PAGINATION_FORBIDDEN_ATTRIBUTES:
        assert attribute not in outcome.html, attribute
    assert not re.search(r"[Pp]age\s+\d+", outcome.html)
    assert not re.search(r"\d+\s+of\s+\d+", outcome.html)


def test_a_page_break_is_a_separator_rather_than_a_page_boundary() -> None:
    _, outcome = emit(
        [
            df.block("a", "rich_text", {"text": "Before."}),
            df.block("pb", "page_break", {}),
            df.block("b", "rich_text", {"text": "After."}),
        ]
    )
    assert outcome.html.count('class="rpt-break"') == 1
    for attribute in H.PAGINATION_FORBIDDEN_ATTRIBUTES:
        assert attribute not in outcome.html


# --------------------------------------------------------------------------- #
# Req 24.5 — the two surfaces show like for like
# --------------------------------------------------------------------------- #


def _docx_tables(payload: bytes) -> list[list[list[str]]]:
    from lxml import etree

    with zipfile.ZipFile(__import__("io").BytesIO(payload)) as archive:
        xml = archive.read("word/document.xml")
    body = etree.fromstring(xml).find(f"{W}body")
    grids: list[list[list[str]]] = []
    for table in body.iter(f"{W}tbl"):
        grids.append(
            [
                [
                    "".join(node.text or "" for node in cell.iter(f"{W}t"))
                    for cell in row.findall(f"{W}tc")
                ]
                for row in table.findall(f"{W}tr")
            ]
        )
    return grids


def _html_tables(markup: str) -> list[list[list[str]]]:
    from lxml import html as lxml_html

    root = lxml_html.fromstring(markup)
    grids: list[list[list[str]]] = []
    for table in root.iter("table"):
        rows: list[list[str]] = []
        for row in table.iter("tr"):
            rows.append(
                ["".join(cell.itertext()).strip() for cell in row if cell.tag in ("td", "th")]
            )
        grids.append(rows)
    return grids


def test_both_surfaces_emit_the_same_headers_rows_and_cell_strings() -> None:
    """Req 24.5 — same column order, same row order, same strings.

    The strongest test in this file: it renders one compiled document both ways and compares
    the grids. Anything that only inspected the HTML would be checking self-consistency.
    """
    compiled = compiled_document()
    markup = H.emit_html(compiled.document).html
    docx = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
    ).docx_bytes

    html_grids = _html_tables(markup)
    docx_grids = _docx_tables(docx)
    assert len(html_grids) == len(docx_grids) > 0

    for index, (from_html, from_docx) in enumerate(zip(html_grids, docx_grids, strict=True)):
        assert from_html == from_docx, f"table {index} differs between the two surfaces"


def test_the_row_key_the_html_carries_is_the_compilers_key() -> None:
    """Deliberately different from the DOCX anchor's row key, which is the key column's *text*
    — because the two answer different questions. The DOM key is for a client correlating a row
    with the AST; the anchor key is what the verifier can read out of the `.docx`."""
    compiled, outcome = emit([df.block("t", "resource_table", {"columns": [df.CPU_AVG]})])
    keys = re.findall(r'data-row-key="([^"]*)"', outcome.html)
    table = next(block for block in compiled.document.blocks if isinstance(block, Table))
    import html as html_module

    assert [html_module.unescape(key) for key in keys] == [row.key for row in table.rows]


def test_column_keys_are_emitted_so_a_client_can_correlate_a_cell() -> None:
    compiled, outcome = emit([df.block("t", "resource_table", {"columns": [df.CPU_AVG]})])
    table = next(block for block in compiled.document.blocks if isinstance(block, Table))
    for column in table.columns:
        assert f'data-column-key="{column.key}"' in outcome.html


def test_an_empty_cell_emits_an_empty_cell_and_not_a_zero() -> None:
    node = Table(
        path=figure_path("t", 0),
        style="Table Hairline",
        columns=(Column(key="a", header="A"), Column(key="b", header="B")),
        rows=(
            Row(
                path=figure_path("t", 0, 0),
                key="k",
                cells=(
                    TextCell(path=figure_path("t", 0, 0, 0), text="vm-1"),
                    EmptyCell(path=figure_path("t", 0, 0, 1)),
                ),
            ),
        ),
    )
    markup = H.emit_html(Document(blocks=(node,))).html
    assert _html_tables(markup) == [[["A", "B"], ["vm-1", ""]]]


def test_a_short_row_is_padded_the_way_the_docx_pads_it() -> None:
    node = Table(
        path=figure_path("t", 0),
        style="Table Hairline",
        columns=(
            Column(key="a", header="A"),
            Column(key="b", header="B"),
            Column(key="c", header="C"),
        ),
        rows=(
            Row(
                path=figure_path("t", 0, 0),
                key="only",
                cells=(TextCell(path=figure_path("t", 0, 0, 0), text="just one"),),
            ),
        ),
    )
    markup = H.emit_html(Document(blocks=(node,))).html
    assert _html_tables(markup) == [[["A", "B", "C"], ["just one", "", ""]]]


# --------------------------------------------------------------------------- #
# Req 24.6 — an empty scope
# --------------------------------------------------------------------------- #


def test_an_empty_scope_block_is_emitted_with_its_notice_row_and_zero_figures() -> None:
    narrow = df.scope(tag_filters=[{"key": "env", "value": "nope"}])
    _, outcome = emit(
        [df.block("t", "resource_table", {"columns": [df.CPU_AVG]}, scope_override=narrow)]
    )
    assert _EMPTY_SCOPE_RESOLVED in outcome.html
    assert outcome.figure_count == 0
    assert outcome.table_count == 1
    assert H.NOTICE_ROW_CLASS in outcome.html


def test_the_notice_row_is_marked_as_information_rather_than_as_an_error() -> None:
    """`design-system.md`: an empty result belongs in mist neutrals, not `--destructive`."""
    narrow = df.scope(tag_filters=[{"key": "env", "value": "nope"}])
    _, outcome = emit(
        [df.block("t", "resource_table", {"columns": [df.CPU_AVG]}, scope_override=narrow)]
    )
    assert H.NOTICE_ROW_CLASS in outcome.html
    for forbidden in ("error", "destructive", "danger", "failure"):
        assert forbidden not in outcome.html.lower(), forbidden


def test_the_notice_row_is_matched_by_key_not_by_text() -> None:
    """The same rule `render/docx.py` applies, so a wording change cannot restyle one surface
    and not the other."""
    node = Table(
        path=figure_path("t", 0),
        style="Table Hairline",
        columns=(Column(key="notice", header="Scope"),),
        rows=(
            Row(
                path=figure_path("t", 0, 0),
                key="empty-scope",
                cells=(TextCell(path=figure_path("t", 0, 0, 0), text="Anything at all"),),
            ),
        ),
    )
    markup = H.emit_html(Document(blocks=(node,))).html
    assert H.NOTICE_ROW_CLASS in markup


# --------------------------------------------------------------------------- #
# Req 24.7 — a row is a container, never a data table
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("column_count", [2, 3])
def test_a_row_is_a_container_carrying_its_declared_column_count(column_count: int) -> None:
    columns = [
        [df.block(f"c{index}", "rich_text", {"text": f"Column {index}."})]
        for index in range(column_count)
    ]
    _, outcome = emit([{"id": "r", "type": "row", "columns": columns}])
    assert f'data-columns="{column_count}"' in outcome.html
    assert outcome.html.count('class="rpt-column"') == column_count
    # And it is not a table.
    assert "<table" not in outcome.html


def test_a_row_carries_no_table_identity_and_no_anchor_triple() -> None:
    """So a layout container is never presented as a data table. Putting the identity in the
    DOM would also invite a consumer to treat the preview as a verification input, which it is
    explicitly not."""
    _, outcome = emit(
        [
            {
                "id": "r",
                "type": "row",
                "columns": [
                    [df.block("a", "rich_text", {"text": "Left."})],
                    [df.block("b", "rich_text", {"text": "Right."})],
                ],
            }
        ]
    )
    assert "tbl:" not in outcome.html
    assert "cht:" not in outcome.html
    assert "data-row-key" not in outcome.html


def test_no_table_identity_is_emitted_for_a_data_table_either() -> None:
    """The identity is the `.docx`'s anchor contract. The preview is never a verification
    input, and emitting it would suggest otherwise."""
    _, outcome = emit([df.block("t", "resource_table", {"columns": [df.CPU_AVG]})])
    assert "tbl:" not in outcome.html


def test_each_child_is_emitted_into_its_declared_column_in_declared_order() -> None:
    _, outcome = emit(
        [
            {
                "id": "r",
                "type": "row",
                "columns": [
                    [
                        df.block("a1", "rich_text", {"text": "Left first."}),
                        df.block("a2", "rich_text", {"text": "Left second."}),
                    ],
                    [df.block("b1", "rich_text", {"text": "Right only."})],
                ],
            }
        ]
    )
    from lxml import html as lxml_html

    root = lxml_html.fromstring(outcome.html)
    columns = root.find_class("rpt-column")
    assert len(columns) == 2
    assert [text.strip() for text in columns[0].itertext() if text.strip()] == [
        "Left first.",
        "Left second.",
    ]
    assert [text.strip() for text in columns[1].itertext() if text.strip()] == ["Right only."]


def test_figures_inside_a_row_are_counted() -> None:
    """The nested emitter's counts have to roll up, or a caller comparing against the ledger
    would see a mismatch for a document that is fine."""
    compiled, outcome = emit(
        [
            {
                "id": "r",
                "type": "row",
                "columns": [
                    [df.block("inner", "resource_table", {"columns": [df.CPU_AVG]})],
                    [df.block("b", "rich_text", {"text": "Right."})],
                ],
            }
        ]
    )
    assert outcome.figure_count == len(compiled.ledger) > 0
    assert outcome.table_count == 1


# --------------------------------------------------------------------------- #
# Charts
# --------------------------------------------------------------------------- #


def test_a_chart_is_emitted_as_a_structured_spec_rather_than_an_image() -> None:
    """In-app charts render client-side from the data, so they are interactive and
    theme-aware. The static PNG belongs in the `.docx`."""
    compiled, outcome = emit([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    assert "<img" not in outcome.html
    assert "media/image" not in outcome.html
    assert 'class="rpt-chart"' in outcome.html
    assert outcome.figure_count == len(compiled.ledger)


def test_a_chart_carries_its_declared_encoding_verbatim() -> None:
    """The agent decides the palette; the client must not guess it from the series count."""
    _, outcome = emit([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    encodings = re.findall(r'data-encoding="([^"]*)"', outcome.html)
    assert encodings
    assert set(encodings) <= {"categorical", "sequential"}


def test_every_plotted_point_is_a_figure_element_with_provenance() -> None:
    compiled, outcome = emit([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    assert outcome.html.count('class="rpt-point"') == len(compiled.ledger)
    assert outcome.html.count("data-snapshot-path=") == len(compiled.ledger)


def test_series_carry_their_stable_key() -> None:
    """So the client can assign a colour by stable key rather than by array index."""
    _, outcome = emit([df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})])
    assert re.findall(r'data-series-key="([^"]+)"', outcome.html)


def test_an_empty_chart_is_emitted_with_an_explicit_indication() -> None:
    narrow = df.scope(tag_filters=[{"key": "env", "value": "nope"}])
    _, outcome = emit(
        [
            df.block(
                "ts", "timeseries_chart", {"metrics": [df.CPU_AVG]}, scope_override=narrow
            )
        ]
    )
    assert outcome.figure_count == 0
    assert _EMPTY_SCOPE_RESOLVED in outcome.html


# --------------------------------------------------------------------------- #
# Req 24.8 — no partial rendering
# --------------------------------------------------------------------------- #


def test_an_unknown_node_type_emits_nothing_at_all() -> None:
    """A half-rendered preview is worse than an absent one, because a reader cannot tell which
    half is missing."""

    class Mystery:
        path = "mystery:0"

    document = Document(blocks=())
    object.__setattr__(
        document,
        "blocks",
        (
            Paragraph(
                path=figure_path("p", 0), style="Body Text", inlines=(
                    Text(path=figure_path("p", 0, 0), text="This must not survive."),
                )
            ),
            Mystery(),
        ),
    )

    with pytest.raises(H.HtmlEmitFailed) as raised:
        H.emit_html(document)

    # `str(...)` rather than `.message`: this is deliberately a plain exception, not an
    # `AgentError`, so it carries no code, no `terminal` flag and no `message` attribute.
    message = str(raised.value)
    assert "Mystery" in message
    assert "mystery:0" in message
    assert "no partial rendering" in message.lower()


def test_the_failure_carries_no_error_code_and_so_cannot_fail_the_run() -> None:
    """Req 24.8 — the verified `.pdf` remains the delivered result, the verifier records no
    finding, and the run's verification status is unchanged.

    Every `AgentError` carries an `ErrorCode` that becomes a run's terminal state, so being one
    would fail the run and withhold both downloads over a preview. The first version of this
    class subclassed `RenderFailedError`, and `tests/test_errors.py` caught it: that module
    asserts one exception class per `ErrorCode`. The invariant was right and the subclass was
    wrong.
    """
    from reporting_agent.errors import AgentError

    assert not issubclass(H.HtmlEmitFailed, AgentError)
    error = H.HtmlEmitFailed("preview unavailable")
    assert not hasattr(error, "code")
    assert not hasattr(error, "terminal")


def test_the_html_emitter_adds_no_exception_class_to_the_error_code_vocabulary() -> None:
    """The invariant `tests/test_errors.py` owns, asserted here too because this module is
    where it would be broken again.

    Counted over classes that **declare** a `code`, matching that module's own formulation:
    the vocabulary the app switches on is the set of codes, and a subclass inheriting an
    existing code without declaring a new one widens nothing. See
    `test_every_exception_is_catchable_as_agent_error` for the reasoning.
    """
    from reporting_agent.errors import AgentError, ErrorCode

    def descendants(cls: type) -> set[type]:
        found = set(cls.__subclasses__())
        for child in tuple(found):
            found |= descendants(child)
        return found

    declaring = {cls for cls in descendants(AgentError) if "code" in vars(cls)}

    assert len(declaring) == len(ErrorCode)
    assert {cls.code for cls in declaring} == set(ErrorCode)  # type: ignore[attr-defined]


def test_a_non_document_argument_is_refused() -> None:
    with pytest.raises(H.HtmlEmitFailed, match="compiled Document"):
        H.emit_html({})


def test_an_unknown_cell_type_is_refused() -> None:
    class Weird:
        path = "t:0.0.0"

    node = Table(
        path=figure_path("t", 0),
        style="Table Hairline",
        columns=(Column(key="a", header="A"),),
        rows=(Row(path=figure_path("t", 0, 0), key="k", cells=()),),
    )
    object.__setattr__(node.rows[0], "cells", (Weird(),))
    with pytest.raises(H.HtmlEmitFailed, match="admits only FigureCell"):
        H.emit_html(Document(blocks=(node,)))


def test_an_unknown_inline_type_is_refused() -> None:
    class Weird:
        text = "12.4"

    paragraph = Paragraph(path=figure_path("p", 0), style="Body Text", inlines=())
    object.__setattr__(paragraph, "inlines", (Weird(),))
    with pytest.raises(H.HtmlEmitFailed, match="admits only Text or Figure"):
        H.emit_html(Document(blocks=(paragraph,)))


def test_a_layout_row_inside_a_layout_column_is_still_emitted() -> None:
    """Unlike the DOCX emitter, which refuses it: HTML nests without the structural problem a
    nested layout table creates for the verifier's table pass.

    Recorded as a deliberate difference rather than an oversight — the definition schema makes
    it unreachable anyway, and the two emitters are allowed to differ on something the verifier
    never reads.
    """
    inner = LayoutRow(
        path=figure_path("inner", 0),
        columns=(
            LayoutColumn(path=figure_path("inner", 0, 0)),
            LayoutColumn(path=figure_path("inner", 0, 1)),
        ),
    )
    outer = LayoutRow(
        path=figure_path("outer", 0),
        columns=(
            LayoutColumn(path=figure_path("outer", 0, 0), blocks=(inner,)),
            LayoutColumn(path=figure_path("outer", 0, 1)),
        ),
    )
    markup = H.emit_html(Document(blocks=(outer,))).html
    assert markup.count('class="rpt-layout-row"') == 2


# --------------------------------------------------------------------------- #
# The fragment is a fragment
# --------------------------------------------------------------------------- #


def test_the_output_is_a_fragment_rather_than_a_page() -> None:
    """The app owns the surrounding page, the theme tokens and the permanent preview label. A
    self-contained document here would be a second place those decisions live."""
    _, outcome = emit()
    lowered = outcome.html.lower()
    for forbidden in ("<html", "<head", "<body", "<!doctype", "<style", "<link"):
        assert forbidden not in lowered, forbidden


def test_the_markup_parses(  ) -> None:
    from lxml import html as lxml_html

    _, outcome = emit()
    root = lxml_html.fromstring(outcome.html)
    assert root.get("class") == "rpt-document"


def test_a_heading_becomes_a_heading_element_and_a_caption_does_not() -> None:
    """A caption marked up as a heading would appear in a screen reader's document outline."""
    _, outcome = emit(
        [
            df.block("h", "heading", {"text": "Utilization", "level": 1}),
            df.block("t", "resource_table", {"columns": [df.CPU_AVG], "caption": "Cap"}),
        ]
    )
    assert "<h2" in outcome.html
    assert "<caption>Cap</caption>" in outcome.html


def test_every_declared_block_type_emits_without_error() -> None:
    """The breadth check: whatever the compiler can produce, this can emit."""
    import json

    from definition_corpus import CORPUS_ROOT

    definition = json.loads((CORPUS_ROOT / "accept-every-block-type.json").read_text())
    view = build_snapshot_view(sf.two_vm_snapshot())

    class Comparison:
        def snapshot_for(self, run_id: str):
            return view

    compiled = compile_document(definition, view=view, comparison_source=Comparison())
    outcome = H.emit_html(compiled.document)
    assert outcome.figure_count == len(compiled.ledger) > 0
    assert outcome.table_count > 0
