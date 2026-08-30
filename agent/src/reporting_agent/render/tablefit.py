"""Will this table's values survive the conversion to PDF at their own width?

`verify/pdf.py` searches the converted PDF's extracted page text for each ledger string
**contiguously**. A value that wraps inside its cell has a line break in the middle of it
by the time the extractor sees it, so the search fails even though every character is on
the page. That is a `pdf_figure_missing` finding, and it is indistinguishable in the
report from the locale corruption the gate actually exists to catch.

Two things follow, and both live here so the emitter and the compiler cannot disagree
about them:

* **Columns are sized to their content** (:func:`column_demands`). Word divides a table's
  width equally by default, which is fine until one column holds something much longer
  than its neighbours.
* **A table too wide for the page at any division is refused before it is built**
  (:func:`fits_page`), so the caller can choose a taller shape instead.

The numbers here were measured against real LibreOffice at a month of rows, not derived.
See :data:`WIDTH_BUDGET_CHARS`.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Final

from reporting_agent.compile.ast import FigureCell, Table, TextCell, TextFactCell

__all__ = [
    "COLUMN_OVERHEAD_CHARS",
    "allocate",
    "header_demands",
    "MAX_COLUMN_CHARS",
    "MIN_COLUMN_CHARS",
    "WIDTH_BUDGET_CHARS",
    "column_demands",
    "fits_page",
    "width_score",
]

MIN_COLUMN_CHARS: Final[int] = 6
"""The narrowest a column may be squeezed to, in characters.

A column of empty cells still has to be visible as a column, and a `Count` beside a cell
holding three hundred characters of resource ids would otherwise be given almost nothing.
"""

MAX_COLUMN_CHARS: Final[int] = 40
"""The widest a column's *demand* may count for when dividing the page.

The `resources_affected` cell of the coverage appendix carries every affected resource id
— several hundred characters. Weighting a column by that would starve every other column
on the row, so past this the cell simply wraps, which is the right outcome for a cell that
is prose rather than a figure. No figure this product formats comes close: the longest
realistic one is a grouped byte count with its unit, at 22.
"""

COLUMN_OVERHEAD_CHARS: Final[int] = 2
"""What a column costs before it holds anything — its cell padding and rules.

Two tables with the same total content do not fit alike if one spreads it over six columns
and the other over four, which is why the budget below is not simply a sum of demands.
"""

WIDTH_BUDGET_CHARS: Final[int] = 70
"""The largest :func:`width_score` that converts with every value intact.

**Measured**, on A4 portrait at the theme's margins, one table of 31 rows per document,
through the same LibreOffice that runs in the container:

    score 63  (6 columns, demands 10+17+6+6+6+6)     every figure located
    score 66  (5 columns, demands 10+17+17+6+6)      every figure located
    score 69  (4 columns, demands 10+17+17+17)       every figure located
    score 74  (6 columns, demands 10+17+17+17+6+6)    93 of 155 figures lost
    score 77  (5 columns, demands 10+17+17+17+6)      31 of 124 figures lost
    score 80  (5 columns, demands 10+11+11+11+11)    124 of 124 figures lost
    score 97  (6 columns, demands 10+11+11+11+11+11) 155 of 155 figures lost

69 is the highest score observed to convert and 74 the lowest to fail, so the boundary is
somewhere between and 70 is inside it. Erring low costs a taller table; erring high costs
a withheld report, which is why this sits at the bottom of the measured gap rather than
the top.
"""


def column_demands(node: Table) -> tuple[int, ...]:
    """Each column's width demand in characters — the longest value it has to hold.

    Measured from the **data**, not from the header. A header is allowed to wrap: the
    verifier reads a column's key out of the `.docx` rather than out of the PDF, so
    `prod-db-02 — Available Memory Bytes (avg)` set over three lines costs nothing. A value
    wrapping is what breaks, so only values are counted.

    Empty cells contribute nothing and a short row the emitter pads contributes nothing,
    which is why the floor exists.
    """
    demands = []
    for ordinal in range(len(node.columns)):
        longest = 0
        for row in node.rows:
            if ordinal >= len(row.cells):
                continue
            cell = row.cells[ordinal]
            if isinstance(cell, FigureCell):
                longest = max(longest, len(cell.figure.formatted))
            elif isinstance(cell, TextFactCell):
                longest = max(longest, len(cell.fact.formatted))
            elif isinstance(cell, TextCell):
                longest = max(longest, len(cell.text))
        demands.append(max(MIN_COLUMN_CHARS, min(MAX_COLUMN_CHARS, longest)))
    return tuple(demands)


def header_demands(node: Table) -> tuple[int, ...]:
    """Each column's **longest header word**, in characters.

    Not the whole header — a column headed `CPN-App — Percentage CPU (avg)` cannot be given
    thirty characters when its values need five and four of its siblings want the same. The
    longest single word is what decides whether the header breaks at a space or through the
    middle of a word, and `ALLOC ATION METHO D` is what the latter looks like on the page.

    Subordinate to the values in :func:`allocate`, and deliberately so: a header may wrap
    without consequence and a figure may not, so this is spent out of what the values did
    not need rather than competing with them.
    """
    return tuple(
        min(MAX_COLUMN_CHARS, max((len(word) for word in column.header.split()), default=0))
        for column in node.columns
    )


def _water_fill(demands: Sequence[float], budget: float) -> list[float]:
    """Divide `budget` between claims, giving a claim less than it asked for only when every
    claim still in the running is receiving the same share.

    * every claim at or below an equal share of what is left takes exactly what it asked
      for and leaves the table;
    * whatever remains is divided again between the rest, until either nobody is under the
      share or the share is all there is.
    """
    allocation = [0.0] * len(demands)
    unsettled = set(range(len(demands)))
    remaining = budget

    while unsettled:
        share = remaining / len(unsettled)
        settled = {i for i in unsettled if demands[i] <= share}
        if not settled:
            for i in unsettled:
                allocation[i] = share
            break
        for i in settled:
            allocation[i] = float(demands[i])
            remaining -= demands[i]
        unsettled -= settled

    return allocation


def allocate(
    demands: Sequence[int], headers: Sequence[int] | None = None
) -> tuple[float, ...]:
    """Divide the page between columns, in the same character units as the demands.

    **Water-filling, not proportional sharing.** Proportional is correct only while the
    total fits: past that it scales every column down by the same factor, so a six-character
    `79.88%` beside a thirty-eight-character `0.25% (p95, est. from hourly averages)` is
    squeezed to four characters and wraps — a column that had been perfectly fine under
    Word's equal division, broken by the sizing meant to help it.

    The columns that end up short are therefore the widest ones, which is the right place
    for a shortfall to land: the longest cell in a table is almost always prose — a list of
    affected resource ids, an estimator label — and prose may wrap without consequence. A
    figure is short, so it settles early and keeps its full width.

    ## Headers get what the values did not need, and only that

    `headers` is a **second pass** over the slack, never a competing claim in the first.
    Sizing columns by their values alone left `Allocation method` set as `ALLOC ATION METHO
    D` over a column of six-character values — free for the verifier, which reads a column's
    key out of the `.docx`, and plainly wrong on the page.

    Folding the header into the first pass fixes that and breaks something worse. The
    companion table's four percentage columns each want ten characters for the word
    `PERCENTAGE` and need six for `0.20%`; the memory column beside them needs twenty-two
    and its header's longest word is nine. Water-filling on the larger of the two claims
    settles the four small ones first and leaves the memory column under ten — which is
    precisely the wrap that withheld run ef01a404. So a header can only ever raise a column,
    never lower one, and a table with no slack sets its headers exactly as it did before.

    Returns character-unit widths summing to at most the page budget, which the caller
    scales into whatever the section actually measures.
    """
    budget = float(WIDTH_BUDGET_CHARS - COLUMN_OVERHEAD_CHARS * len(demands))
    if budget <= 0 or not demands:
        return tuple(float(d) for d in demands)

    base = _water_fill([float(d) for d in demands], budget)
    if headers is None:
        return tuple(base)

    slack = budget - sum(base)
    if slack <= 1e-9:
        return tuple(base)

    wanted = [max(0.0, float(h) - b) for h, b in zip(headers, base, strict=True)]
    extra = _water_fill(wanted, slack)
    return tuple(b + e for b, e in zip(base, extra, strict=True))


def width_score(node: Table) -> int:
    """The table's total width demand, in characters, including per-column overhead."""
    demands = column_demands(node)
    return sum(demands) + COLUMN_OVERHEAD_CHARS * len(demands)


def fits_page(node: Table) -> bool:
    """Whether **every** column of `node` can be given its full demand.

    A `False` is not an error — it is the caller's cue to choose a shape that trades width
    for height. `render/charts.py` is the one caller, and it asks this of the wide
    companion-table candidate before building the tall one instead.

    Deliberately stricter than "every figure survives". A column holding prose is free to
    wrap and costs nothing when it does, so a table can be over budget on this measure and
    still convert perfectly — the tall companion shape is exactly that, scoring 71 to 73
    because its key column carries a 40-character series label, and losing nothing, because
    the only column that must not wrap is the one holding the figure and it has a third of
    the page. Distinguishing the two would mean asking which columns carry figures, and
    since the caller only asks about a table whose columns are *all* figures but one, the
    stricter question has the same answer and one fewer thing to get wrong.
    """
    return width_score(node) <= WIDTH_BUDGET_CHARS
