"""Column sizing and the page-width budget (`render/tablefit.py`).

The unit-level half of run ef01a404: 30 `pdf_figure_missing` findings on a document that
was correct in every respect except that one column's values were wider than the space
Word gave them, so LibreOffice wrapped each of them and the verifier's contiguous search
for the ledger string fell across the break.

`tests/test_docx.py` holds the end-to-end half, through real LibreOffice. This file holds
the arithmetic, which is where the second defect lived: the first fix sized columns in
proportion to their demand, which is right until the total does not fit and then starves
the narrow columns to feed the wide one — breaking a column that Word's own equal division
had handled perfectly well.
"""

from __future__ import annotations

import pytest

from reporting_agent.compile.ast import Column, FigureCell, Row, Table, TextCell
from reporting_agent.compile.figures import FigureLedger
from reporting_agent.render.tablefit import (
    COLUMN_OVERHEAD_CHARS,
    header_demands,
    MAX_COLUMN_CHARS,
    MIN_COLUMN_CHARS,
    WIDTH_BUDGET_CHARS,
    allocate,
    column_demands,
    fits_page,
    width_score,
)


def table_of(rows: list[list[str]], *, columns: int | None = None) -> Table:
    """A table of plain text cells — `column_demands` measures text length and does not
    care which kind of cell carries it."""
    width = columns if columns is not None else max(len(r) for r in rows)
    return Table(
        path="t",
        style="Table Hairline",
        columns=tuple(Column(key=f"c{i}", header=f"h{i}") for i in range(width)),
        rows=tuple(
            Row(path=f"t.{n}", key=str(n),
                cells=tuple(TextCell(path=f"t.{n}.{i}", text=c) for i, c in enumerate(r)))
            for n, r in enumerate(rows)
        ),
    )


class TestColumnDemands:
    def test_a_column_demands_its_longest_value(self) -> None:
        node = table_of([["a", "xxxxxxxxxxxx"], ["bbbb", "y"]])
        assert column_demands(node) == (MIN_COLUMN_CHARS, 12)

    def test_an_empty_column_still_gets_the_floor(self) -> None:
        """A column of empty cells has to remain visible as a column."""
        assert column_demands(table_of([["", ""]])) == (MIN_COLUMN_CHARS,) * 2

    def test_a_prose_cell_is_capped(self) -> None:
        """The coverage appendix lists every affected resource id in one cell — several
        hundred characters. Weighting a column by that would starve the whole row."""
        node = table_of([["x" * 400, "9.00"]])
        assert column_demands(node) == (MAX_COLUMN_CHARS, MIN_COLUMN_CHARS)

    def test_a_short_row_demands_nothing_of_the_columns_it_does_not_reach(self) -> None:
        """The truncation row carries two cells in a five-column table, by design."""
        node = table_of([["aaaaaaaaaa", "bbbbbbbbbb", "cccccccccc"], ["omitted"]], columns=3)
        assert column_demands(node) == (10, 10, 10)

    def test_the_header_is_not_measured(self) -> None:
        """A header may wrap for free: the verifier reads a column's key out of the `.docx`,
        not out of the PDF, so a forty-character series label costs nothing."""
        node = Table(
            path="t", style="s",
            columns=(Column(key="c", header="prod-db-02 — Available Memory Bytes (avg)"),),
            rows=(Row(path="t.0", key="0", cells=(TextCell(path="t.0.0", text="1.0%"),)),),
        )
        assert column_demands(node) == (MIN_COLUMN_CHARS,)


class TestAllocate:
    """The property that matters, and the one proportional sharing does not have."""

    @pytest.mark.parametrize("demands", [
        (10, 6, 6, 6, 38, 22),      # the run that exposed it: p95's estimator label
        (10, 22, 22, 22, 22, 22),   # five wide series, nothing to give
        (40, 6, 6),                 # one prose column beside two figures
        (6,), (6, 6), (10, 17, 17, 17),
        (40, 40, 40, 40, 40, 40),   # every column capped and still over budget
    ])
    def test_no_column_is_starved_while_another_is_over_fed(self, demands) -> None:
        """A column gets less than it asked for only when every column still in the running
        is getting the same share — never to make room for a greedier one."""
        allocation = allocate(demands)
        short = [i for i, a in enumerate(allocation) if a < demands[i] - 1e-9]
        for i in short:
            for j, a in enumerate(allocation):
                assert a <= allocation[i] + 1e-9, (
                    f"column {i} was cut to {allocation[i]:.2f} of its {demands[i]} while "
                    f"column {j} received {a:.2f}"
                )

    def test_it_never_hands_out_more_than_the_page(self, ) -> None:
        for demands in [(6,), (10, 17, 17), (40, 40, 40, 40, 40, 40), (6,) * 9]:
            budget = WIDTH_BUDGET_CHARS - COLUMN_OVERHEAD_CHARS * len(demands)
            assert sum(allocate(demands)) <= budget + 1e-9

    def test_a_table_that_fits_gets_everything_it_asked_for(self) -> None:
        demands = (10, 17, 17, 17)
        assert sum(demands) + COLUMN_OVERHEAD_CHARS * 4 <= WIDTH_BUDGET_CHARS
        for got, wanted in zip(allocate(demands), demands, strict=True):
            assert got >= wanted - 1e-9

    def test_the_narrow_columns_of_an_overfull_table_are_untouched(self) -> None:
        """The regression this exists for. `0.25% (p95, est. from hourly averages)` is a
        genuine 38-character value; the three CPU columns beside it are six, and they must
        come through at six."""
        allocation = allocate((10, 6, 6, 6, 38, 22))
        assert allocation[1] == allocation[2] == allocation[3] == 6.0
        assert allocation[0] == 10.0
        assert allocation[4] < 38.0 and allocation[5] < 22.0


class TestFitsPage:
    def test_the_measured_boundary(self) -> None:
        """The scores either side of the budget, from the LibreOffice measurements recorded
        on `WIDTH_BUDGET_CHARS`. 69 converted; 74 lost 93 of 155 figures."""
        assert fits_page(_scored(10, 17, 17, 17))          # 69
        assert not fits_page(_scored(10, 17, 17, 17, 6, 6))  # 74

    def test_a_narrow_wide_table_fits(self) -> None:
        """Five series of percentages — the ordinary utilization chart, which must keep the
        compact shape."""
        assert fits_page(_scored(10, 7, 7, 7, 7, 7))


def _scored(*demands: int) -> Table:
    """A table whose columns demand exactly `demands`, so a test can name a score."""
    return table_of([["x" * d for d in demands]])


def test_the_score_is_the_demands_plus_per_column_overhead() -> None:
    node = _scored(10, 17, 17, 17)
    assert width_score(node) == 61 + COLUMN_OVERHEAD_CHARS * 4 == 69


class TestHeaderDemands:
    def test_it_measures_the_longest_word_not_the_whole_header(self) -> None:
        """A thirty-character header cannot have thirty characters in a six-column table.
        What decides whether it breaks at a space or through a word is its longest word."""
        node = Table(
            path="t", style="s",
            columns=(
                Column(key="a", header="Allocation method"),
                Column(key="b", header="CPN-App — Percentage CPU (avg)"),
                Column(key="c", header="SKU"),
            ),
            rows=(Row(path="t.0", key="0", cells=(TextCell(path="t.0.0", text="x"),)),),
        )
        assert header_demands(node) == (10, 10, 3)


class TestHeadersGetOnlyTheSlack:
    """The second pass, and the reason it is a second pass."""

    def test_a_header_raises_a_column_when_there_is_room(self) -> None:
        """`Percentage CPU (avg)` over a column of `0.20%` was set as `PERCEN TAGE`. The
        values need six characters and the table has room for ten, so it takes ten."""
        values, headers = (10, 6, 6), (8, 10, 10)
        assert allocate(values) == (10.0, 6.0, 6.0)
        assert allocate(values, headers) == (10.0, 10.0, 10.0)

    def test_a_header_never_takes_width_from_a_figure(self) -> None:
        """The companion table, and the regression this ordering exists to prevent.

        Four percentage columns each want ten characters for the word `PERCENTAGE` and need
        six for `0.20%`; the memory column beside them needs twenty-two and its header's
        longest word is nine. Water-filling on the larger of the two claims would settle the
        four small ones first and leave memory under ten — the exact wrap that withheld run
        ef01a404. So the memory column must come through at twenty-two either way.
        """
        values = (10, 6, 6, 22, 6, 6)
        headers = (4, 10, 10, 9, 10, 10)

        without = allocate(values)
        with_headers = allocate(values, headers)

        assert without[3] == with_headers[3] == 22.0
        for before, after in zip(without, with_headers, strict=True):
            assert after >= before, "a header pass may only ever raise a column"

    def test_a_table_with_no_slack_is_left_exactly_as_it_was(self) -> None:
        """Page 7's public-IP table: the association column carries a two-hundred-character
        resource id and there is nothing spare. `Allocation method` still wraps, and that is
        the honest outcome — the width is not there to give."""
        values, headers = (15, 13, 6, 8, 40), (8, 7, 10, 3, 11)
        assert allocate(values, headers) == allocate(values)

