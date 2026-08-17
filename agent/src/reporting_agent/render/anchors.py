"""The two structural contracts the verifier depends on (Req 21).

Small module, load-bearing asymmetry:

* :func:`write_data_table_caption` writes `w:tblPr/w:tblCaption` **exactly once**.
* :func:`write_layout_table` writes **no** caption, no header row and no row key.

That asymmetry *is* the design. The verifier's table pass enumerates the tables carrying a
caption, so **a layout table is excluded by construction** — not by inspecting borders, not
by counting cells, not by guessing from content. Every one of those alternatives is a
heuristic that would eventually classify a two-column data table as layout, or a `row`
block holding one child as data, and either way the failure is silent.

Two consequences worth stating because they are easy to get backwards:

* A data table **nested inside a layout cell** carries its **own** caption (Req 21.10), so
  a data-bearing child of a `row` block is checked while its container is skipped. The rule
  is about the table, never about where the table sits.
* A data table carrying **zero figures** still registers its identity, with zero anchors
  (Req 21.11). Otherwise the verifier would find a captioned table it cannot resolve and
  report `table_anchor_unexpected` for a table the compiler emitted correctly — an
  empty-scope block, or a `gaps_and_coverage` over a clean run.

## Header text and row keys are resolution keys, not decoration

The verifier resolves a cell by `(row_key, column_key)` rather than by coordinates, because
a coordinate pair tells nobody anything when a check fails and shifts the moment a column is
added. So both are constrained where they are written (Req 21.4, 21.5), and a table that
cannot satisfy the constraints is a `RENDER_FAILED` naming it rather than a table the
verifier will later fail to resolve.

**The document's row key is the key column's emitted text, not `Row.key`.** Req 21.5 defines
it as "the concatenated text of that row's cell in one designated key column", which is what
the verifier can actually read back out of the `.docx`. `Row.key` is the compiler's internal
stable key — a resource id — and the first column shows a resource *name*. Recording the id
as the anchor's row key would record something the verifier cannot find in the document.

**And the anchor's column key is the header text, not `Column.key`, for the same reason.**
Req 27.1 resolves a column by "the one column whose header text is character-for-character
equal to the anchor's column key", so the two names have to be the same string. They are not
interchangeable: a chart's companion table declares `Column(key="value", header="Value")`, so
recording `Column.key` would record a string that appears nowhere in the emitted grid and
every chart figure would fail as `table_column_unresolved` on a correct document.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from docx.oxml.ns import qn
from docx.table import Table as DocxTable

from reporting_agent.compile.ast import (
    ANCHOR_ID_MAX_LENGTH,
    Column,
    FigurePath,
    Row,
    Table,
)
from reporting_agent.compile.figures import (
    ANCHOR_CHART,
    ANCHOR_TABLE,
    FigureLedger,
    TableAnchor,
)
from reporting_agent.errors import RenderFailedError

__all__ = [
    "ANCHOR_ID_MAX_LENGTH",
    "HEADER_TEXT_MAX_LENGTH",
    "KEY_COLUMN_ORDINAL",
    "ROW_KEY_MAX_LENGTH",
    "AnchorRecorder",
    "assert_header_row",
    "document_row_key",
    "read_table_caption",
    "record_chart_anchor",
    "record_figure_anchor",
    "write_data_table_caption",
    "write_layout_table",
]

HEADER_TEXT_MAX_LENGTH: Final[int] = 255
ROW_KEY_MAX_LENGTH: Final[int] = 255

KEY_COLUMN_ORDINAL: Final[int] = 0
"""The designated key column, and it is the first one in every data table.

Req 21.5 requires *one* designated key column occupying the same position in every data row.
Making it a fixed position rather than a per-table choice means there is no per-table
configuration to get wrong, and it matches how every block compiler already builds a table:
the identifying column — resource name, gap type, record field — comes first.
"""


# --------------------------------------------------------------------------- #
# The caption: written for a data table, never for a layout table
# --------------------------------------------------------------------------- #


def write_data_table_caption(table: DocxTable, identity: str) -> None:
    """Write `identity` into `w:tblPr/w:tblCaption`, exactly once (Req 21.1).

    Idempotent by removal rather than by checking: any `w:tblCaption` already present is
    dropped first, so calling this twice leaves one element rather than two. Two captions
    on one table is not a documented state — Word shows the first and the verifier's XPath
    would find both — so the safe reading is "exactly one, whatever was there before".
    """
    if not identity:
        raise RenderFailedError(
            "a data table's identity must be a non-empty string; the verifier resolves a "
            "table by its caption and an empty one would exclude the table from the check"
        )
    if len(identity) > ANCHOR_ID_MAX_LENGTH:
        raise RenderFailedError(
            f"table identity {identity!r} is {len(identity)} characters; Word's table "
            f"caption holds at most {ANCHOR_ID_MAX_LENGTH}"
        )

    properties = table._tbl.tblPr
    for existing in properties.findall(qn("w:tblCaption")):
        properties.remove(existing)

    caption = properties.makeelement(qn("w:tblCaption"), {qn("w:val"): identity})
    properties.append(caption)


def write_layout_table(table: DocxTable) -> None:
    """Strip a layout table of everything that would make it look like a data table.

    No caption, no header row, no row key (Req 21.2). Written as an explicit removal rather
    than "just don't add one" so the guarantee holds even if the table was built by a code
    path that added a caption, and so there is a named function a test can point at.

    Also clears `w:tblLook`'s header-row flag: Word uses it to apply first-row conditional
    formatting, and a layout table rendered with a styled header row would read as a data
    table to a human even though the verifier correctly skips it.
    """
    properties = table._tbl.tblPr
    for existing in properties.findall(qn("w:tblCaption")):
        properties.remove(existing)
    for look in properties.findall(qn("w:tblLook")):
        look.set(qn("w:firstRow"), "0")
        look.set(qn("w:noHBand"), "1")
        look.set(qn("w:noVBand"), "1")


def read_table_caption(table: DocxTable) -> str | None:
    """The table's `w:tblCaption` value, or `None` if it carries none.

    Here rather than in `verify/tokens.py` so the writer and the reader of this contract sit
    in one module and cannot disagree about the element's location. A **blank** caption reads
    as `None`: Req 26.5 treats a present-but-whitespace caption as absent, so an empty string
    can smuggle a table neither into nor out of the data pass.
    """
    properties = table._tbl.tblPr
    if properties is None:  # pragma: no cover - python-docx always creates tblPr
        return None
    for caption in properties.findall(qn("w:tblCaption")):
        value = caption.get(qn("w:val"))
        if value is not None and value.strip():
            return value
    return None


# --------------------------------------------------------------------------- #
# Header text and row keys
# --------------------------------------------------------------------------- #


def assert_header_row(columns: tuple[Column, ...], *, at: str) -> tuple[str, ...]:
    """The header text per column, asserted against Req 21.4.

    Non-empty, at most 255 characters, and unique within the table. Every violation is
    reported rather than the first, so one fix pass clears a table.

    A header that fails these is a column the verifier cannot resolve, and it would surface
    later as `table_column_unresolved` on a document that is otherwise correct — so it is a
    `RENDER_FAILED` here, where the message can name the table and the column key.
    """
    if not columns:
        raise RenderFailedError(
            f"{at} declares no columns; the verifier resolves a cell by "
            f"(row key, column key) and a table with no columns has no resolvable cell"
        )

    problems: list[str] = []
    seen: dict[str, str] = {}
    for column in columns:
        header = column.header
        if not header:
            problems.append(f"column {column.key!r} carries an empty header")
        elif len(header) > HEADER_TEXT_MAX_LENGTH:
            problems.append(
                f"column {column.key!r} header is {len(header)} characters, over "
                f"{HEADER_TEXT_MAX_LENGTH}"
            )
        elif header in seen:
            problems.append(
                f"columns {seen[header]!r} and {column.key!r} share the header {header!r}"
            )
        else:
            seen[header] = column.key

    if problems:
        raise RenderFailedError(
            f"{at} cannot be verified by column header:\n  " + "\n  ".join(problems)
        )
    return tuple(column.header for column in columns)


def document_row_key(row: Row, *, at: str) -> str:
    """The row key the verifier will read back out of the document (Req 21.5).

    The **emitted text of the key column's cell**, not `Row.key`. Those differ on purpose:
    `Row.key` is a resource id the compiler uses for uniqueness, while the first column
    shows a resource name. Recording the id would record something absent from the document.

    An `EmptyCell` or `FigureCell` in the key column has no readable text of its own, which
    is a table whose rows cannot be resolved — a `RENDER_FAILED` rather than a table the
    verifier fails on later.
    """
    if len(row.cells) <= KEY_COLUMN_ORDINAL:
        raise RenderFailedError(
            f"{at} has {len(row.cells)} cell(s) and so carries no key column; a data row "
            f"must carry text in column {KEY_COLUMN_ORDINAL} for the verifier to resolve it"
        )

    cell = row.cells[KEY_COLUMN_ORDINAL]
    text = getattr(cell, "text", None)
    if not isinstance(text, str) or not text.strip():
        raise RenderFailedError(
            f"{at} carries no readable text in key column {KEY_COLUMN_ORDINAL} "
            f"({type(cell).__name__}); the verifier resolves a row by that text"
        )
    key = text.strip()
    if len(key) > ROW_KEY_MAX_LENGTH:
        raise RenderFailedError(
            f"{at} row key is {len(key)} characters, over {ROW_KEY_MAX_LENGTH}"
        )
    return key


# --------------------------------------------------------------------------- #
# Recording anchors
# --------------------------------------------------------------------------- #


def record_figure_anchor(
    ledger: FigureLedger,
    path: FigurePath,
    table_identity: str,
    *,
    row_key: str,
    column_key: str,
) -> None:
    """Record the anchor triple for one figure in a data-table cell (Req 21.3).

    Onto the figure's **existing** ledger entry, which is why there is no second structure
    to keep in step. The compile stage already recorded the table identity against every
    figure inside the table (`BlockCursor.anchor_table`); this completes the triple with the
    row and column, which only the renderer knows because only the renderer walks the
    emitted grid.

    Both `row_key` and `column_key` are **strings the document carries** — the key column's
    emitted text and the column's header text — because those are the two the verifier can
    resolve against a `.docx`. See this module's docstring.
    """
    ledger.record_anchor(
        path,
        TableAnchor(
            kind=ANCHOR_TABLE,
            anchor_id=table_identity,
            row_key=row_key,
            column_key=column_key,
        ),
    )


def record_chart_anchor(
    ledger: FigureLedger,
    path: FigurePath,
    chart_identity: str,
    *,
    row_key: str,
    column_key: str,
) -> None:
    """As :func:`record_figure_anchor`, for a figure in a chart's companion table."""
    ledger.record_anchor(
        path,
        TableAnchor(
            kind=ANCHOR_CHART,
            anchor_id=chart_identity,
            row_key=row_key,
            column_key=column_key,
        ),
    )


@dataclass(slots=True)
class AnchorRecorder:
    """Tracks one rendered document's table identities and row keys.

    Exists so the two uniqueness rules — identities unique within a document (Req 21.6),
    row keys unique within a table (Req 21.5) — are enforced **while** emitting rather than
    audited afterwards. An identity collision found after the fact means the document has
    already been built and one of the two tables is unreachable to the verifier; found here,
    it names both paths.
    """

    ledger: FigureLedger
    _identities: dict[str, FigurePath] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self._identities = {}

    def claim_identity(self, node: Table, identity: str) -> None:
        """Register `identity` for `node`, refusing a duplicate (Req 21.6).

        Registers with the ledger too, so a data table carrying zero figures is still
        resolvable (Req 21.11) — `BlockCursor.anchor_table` only reaches tables that
        contain at least one figure, because it walks the ledger's existing entries.
        """
        existing = self._identities.get(identity)
        if existing is not None:
            raise RenderFailedError(
                f"table identity {identity!r} is emitted twice, by {existing!r} and "
                f"{node.path!r}; the verifier resolves a table by that identity and would "
                f"report duplicate_table_anchor"
            )
        self._identities[identity] = node.path
        self.ledger.register_table(node.path, identity)

    def row_keys_for(self, node: Table) -> tuple[str, ...]:
        """Every data row's document row key, asserted unique within the table.

        Uniqueness is Req 21.5's, and it is a genuine constraint on the **compiler**: the
        key column has to carry something that identifies the row. Two VMs with one name in
        different resource groups would collide here, and the honest response is to fail
        naming the table rather than to emit a table half of whose rows the verifier cannot
        address — or, worse, to invent a disambiguating suffix, which would put a string in
        the document that came from neither the snapshot nor the template.
        """
        keys: list[str] = []
        duplicates: dict[str, int] = {}
        for ordinal, row in enumerate(node.rows):
            key = document_row_key(row, at=f"table {node.path!r} row {ordinal}")
            if key in keys:
                duplicates[key] = duplicates.get(key, 1) + 1
            keys.append(key)

        if duplicates:
            listed = ", ".join(
                f"{key!r} ({count} rows)" for key, count in sorted(duplicates.items())
            )
            raise RenderFailedError(
                f"table {node.path!r} carries repeated row keys in key column "
                f"{KEY_COLUMN_ORDINAL}: {listed}. The verifier resolves a row by that "
                f"text, so a repeat makes those rows unaddressable"
            )
        return tuple(keys)

    def identities(self) -> tuple[str, ...]:
        """Every identity emitted so far, in emission order."""
        return tuple(self._identities)
