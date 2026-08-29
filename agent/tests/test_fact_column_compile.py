"""Task 12.8 — a `fact`-kind column entry compiles to two `TextFactCell` columns.

The claim this file machine-checks:

 1. A `resource_table` definition naming a `kind=fact` column, compiled through the **real
    pipeline** (`compile_document`), produces a `TextFactCell` anchored to a real cell — not
    one injected past the compiler via the `compiled` hook.
 2. The **instant columns are conditional**, on the distinct `collected_at` set of the
    table's facts: none or one and there are no `<key>.observed_at` columns at all; more
    than one and each fact gets its own, because a disagreement is the thing those columns
    exist to show. One agreed instant becomes `Table.provenance`, one line under the table.
 3. Two facts with **differing `collected_at`** instants produce two distinct instant columns,
    not a table-level instant column.
 4. A resource **missing** the fact gets an `EmptyCell` (fact_unavailable), never a raise or
    an empty string.
 5. The `TextFact` is minted through `BlockCursor.text_fact()` — provenance is structural,
    the ledger records it, and `assert_ledger_matches_tree` passes (the closing invariant
    that `compile_document` always runs).
"""

from __future__ import annotations

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.collect.snapshot import FactEntry
from reporting_agent.compile.ast import (
    EmptyCell,
    FigureCell,
    TextCell,
    TextFactCell,
    child_nodes,
)
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.snapshot_view import build_snapshot_view

VM = sf.VM_TYPE

FACT_KEY = "os_type"
FACT_VALUE_1 = "Windows"
FACT_VALUE_2 = "Linux"
COLLECTED_AT_1 = "2026-07-15T08:30:00Z"
COLLECTED_AT_2 = "2026-07-16T14:00:00Z"
FACT_SOURCE = "resource_graph"


def _fact_entry(
    key: str = FACT_KEY,
    value: str = FACT_VALUE_1,
    collected_at: str = COLLECTED_AT_1,
) -> FactEntry:
    return FactEntry(
        key=key,
        value=value,
        value_kind="text",
        source=FACT_SOURCE,
        collected_at=collected_at,
        formatted=value,
    )


def _fact_column(key: str = FACT_KEY) -> dict:
    return {"kind": "fact", "fact_key": key}


def _vm_with_fact(
    resource_id: str,
    name: str,
    *,
    fact_key: str = FACT_KEY,
    fact_value: str = FACT_VALUE_1,
    collected_at: str = COLLECTED_AT_1,
) -> sf.ResourceSnapshot:
    return sf.vm(
        resource_id=resource_id,
        name=name,
        facts=(_fact_entry(key=fact_key, value=fact_value, collected_at=collected_at),),
    )


def _vm_without_fact(resource_id: str, name: str) -> sf.ResourceSnapshot:
    """A VM with no facts — exercises the fact_unavailable path."""
    return sf.vm(resource_id=resource_id, name=name)


def _view(*resources: sf.ResourceSnapshot):
    return build_snapshot_view(sf.build(resources=list(resources)))


def _table_named(document, block_id: str):
    from reporting_agent.compile.ast import Table

    for node in _walk(document):
        if isinstance(node, Table) and str(node.path).startswith(f"{block_id}:"):
            return node
    raise AssertionError(f"no table for block {block_id!r}")


def _walk(node):
    yield node
    for child in child_nodes(node):
        yield from _walk(child)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestFactColumnCompiles:
    """A fact-kind column, compiled through the real pipeline, produces TextFactCells."""

    def test_one_agreed_instant_emits_one_column_and_a_provenance_line(self) -> None:
        """The ordinary case: every fact in the table shares one `collected_at`.

        One column for the value, no instant column, and the instant stated once as
        `Table.provenance`. Six facts used to mean twelve columns and a header that wrapped
        to four lines; this is the rule that stopped that.
        """
        rid = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"
        view = _view(_vm_with_fact(rid, "vm-01"))

        document = compile_document(
            df.definition(
                [df.block("facts_table", "resource_table", {
                    "columns": [df.CPU_AVG, _fact_column(FACT_KEY)],
                })],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view,
        )

        table = _table_named(document.document, "facts_table")

        # Columns: resource + cpu_avg + fact_key. No instant column.
        assert len(table.columns) == 3
        assert table.columns[2].key == FACT_KEY
        assert [column.key for column in table.columns].count(
            f"{FACT_KEY}.observed_at"
        ) == 0

        # The header is the key humanised, while the key stays the cell address.
        assert table.columns[2].header == "OS type"

        # The instant is stated once, under the table.
        assert table.provenance is not None
        assert COLLECTED_AT_1 in table.provenance

        # One resource row
        assert len(table.rows) == 1
        row = table.rows[0]

        # Cell layout: [TextCell(name), FigureCell(cpu_avg), TextFactCell(value)]
        assert len(row.cells) == 3
        assert isinstance(row.cells[0], TextCell)  # resource name
        assert isinstance(row.cells[1], FigureCell)  # cpu_avg figure
        assert isinstance(row.cells[2], TextFactCell)  # fact value

        # The fact value cell
        fact_cell = row.cells[2]
        assert fact_cell.fact.value == FACT_VALUE_1
        assert fact_cell.fact.key == FACT_KEY
        assert fact_cell.fact.source == FACT_SOURCE
        assert fact_cell.fact.collected_at == COLLECTED_AT_1
        assert fact_cell.fact.formatted == FACT_VALUE_1
        assert fact_cell.fact.snapshot_path.endswith("/value")

    def test_text_facts_are_in_the_ledger(self) -> None:
        """The fact's TextFact is registered in the figure ledger.

        One entry, not two: with the instant stated under the table there is no
        `observed_at` cell to anchor. The instant is provenance rather than a figure — the
        snapshot still carries it and replay still proves it, and `render/html.py` has
        always treated it as an attribute rather than a cell.
        """
        rid = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"
        view = _view(_vm_with_fact(rid, "vm-01"))

        document = compile_document(
            df.definition(
                [df.block("facts_table", "resource_table", {
                    "columns": [_fact_column(FACT_KEY)],
                })],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view,
        )

        # The closing invariant (assert_ledger_matches_tree) already passed inside
        # compile_document. Verify the text_facts dict has entries.
        text_facts = document.ledger.text_facts()
        assert len(text_facts) == 1

        fact_values = {tf.key for tf in text_facts.values()}
        assert fact_values == {FACT_KEY}

    def test_missing_fact_produces_an_empty_cell_not_a_raise(self) -> None:
        """A resource without the fact gets an EmptyCell (fact_unavailable).

        No resource carries the fact, so there is no instant to state and no disagreement
        to show — one empty column rather than two. This is the shape that printed the
        `Disks` table as empty rows under seven headers.
        """
        rid = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-no-fact"
        view = _view(_vm_without_fact(rid, "vm-no-fact"))

        document = compile_document(
            df.definition(
                [df.block("facts_table", "resource_table", {
                    "columns": [df.CPU_AVG, _fact_column(FACT_KEY)],
                })],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view,
        )

        table = _table_named(document.document, "facts_table")
        row = table.rows[0]

        # Cell layout: [TextCell(name), FigureCell(cpu_avg), EmptyCell]
        assert len(row.cells) == 3
        assert isinstance(row.cells[0], TextCell)
        assert isinstance(row.cells[1], FigureCell)
        assert isinstance(row.cells[2], EmptyCell)

        # Nothing was collected, so nothing is claimed about when.
        assert table.provenance is None

    def test_two_resources_with_different_collected_at_get_distinct_timestamps(self) -> None:
        """Two facts with differing collected_at produce two distinct instant cells."""
        rid1 = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"
        rid2 = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-02"
        view = _view(
            _vm_with_fact(rid1, "vm-01", collected_at=COLLECTED_AT_1),
            _vm_with_fact(rid2, "vm-02", fact_value=FACT_VALUE_2, collected_at=COLLECTED_AT_2),
        )

        document = compile_document(
            df.definition(
                [df.block("facts_table", "resource_table", {
                    "columns": [_fact_column(FACT_KEY)],
                })],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view,
        )

        table = _table_named(document.document, "facts_table")
        assert len(table.rows) == 2

        # Row 1
        obs_cell_1 = table.rows[0].cells[2]
        assert isinstance(obs_cell_1, TextFactCell)
        assert obs_cell_1.fact.value == COLLECTED_AT_1

        # Row 2
        obs_cell_2 = table.rows[1].cells[2]
        assert isinstance(obs_cell_2, TextFactCell)
        assert obs_cell_2.fact.value == COLLECTED_AT_2

        # They are distinct instants — no table-level instant column merging
        assert obs_cell_1.fact.value != obs_cell_2.fact.value

    def test_fact_column_works_alongside_metric_columns_in_entry_order(self) -> None:
        """Fact columns appear after metric columns, in entry order."""
        rid = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"
        view = _view(_vm_with_fact(rid, "vm-01"))

        document = compile_document(
            df.definition(
                [df.block("mixed", "resource_table", {
                    "columns": [df.CPU_AVG, df.CPU_MAX, _fact_column(FACT_KEY)],
                })],
                metrics={VM: [df.CPU_AVG, df.CPU_MAX]},
            ),
            view=view,
        )

        table = _table_named(document.document, "mixed")

        # Columns: resource, cpu_avg, cpu_max, os_type
        assert len(table.columns) == 4
        assert table.columns[0].key == "resource"
        assert table.columns[1].key == f"{sf.CPU}:avg"
        assert table.columns[2].key == f"{sf.CPU}:max"
        assert table.columns[3].key == FACT_KEY

    def test_multiple_fact_columns_each_emit_two_columns(self) -> None:
        """Two different fact keys produce 4 fact columns total."""
        FACT_KEY_2 = "backup_status"
        FACT_VALUE_B = "Succeeded"
        rid = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"
        resource = sf.vm(
            resource_id=rid,
            name="vm-01",
            facts=(
                _fact_entry(key=FACT_KEY, value=FACT_VALUE_1, collected_at=COLLECTED_AT_1),
                _fact_entry(key=FACT_KEY_2, value=FACT_VALUE_B, collected_at=COLLECTED_AT_2),
            ),
        )
        view = _view(resource)

        document = compile_document(
            df.definition(
                [df.block("multi_fact", "resource_table", {
                    "columns": [
                        df.CPU_AVG,
                        _fact_column(FACT_KEY),
                        _fact_column(FACT_KEY_2),
                    ],
                })],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view,
        )

        table = _table_named(document.document, "multi_fact")

        # resource + cpu_avg + (os_type + os_type.observed_at) + (backup_status + backup_status.observed_at)
        assert len(table.columns) == 6
        assert table.columns[2].key == FACT_KEY
        assert table.columns[3].key == f"{FACT_KEY}.observed_at"
        assert table.columns[4].key == FACT_KEY_2
        assert table.columns[5].key == f"{FACT_KEY_2}.observed_at"

        row = table.rows[0]
        # All 4 fact cells are TextFactCells
        assert isinstance(row.cells[2], TextFactCell)
        assert isinstance(row.cells[3], TextFactCell)
        assert isinstance(row.cells[4], TextFactCell)
        assert isinstance(row.cells[5], TextFactCell)

        assert row.cells[2].fact.value == FACT_VALUE_1
        assert row.cells[4].fact.value == FACT_VALUE_B

    def test_mixed_present_and_absent_facts_across_resources(self) -> None:
        """One resource has the fact, the other does not: distinct cell types per row."""
        rid1 = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-with"
        rid2 = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-without"
        view = _view(
            _vm_with_fact(rid1, "vm-with"),
            _vm_without_fact(rid2, "vm-without"),
        )

        document = compile_document(
            df.definition(
                [df.block("partial", "resource_table", {
                    "columns": [_fact_column(FACT_KEY)],
                })],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view,
        )

        table = _table_named(document.document, "partial")
        assert len(table.rows) == 2

        # One instant across the facts that exist, so one value column.
        assert isinstance(table.rows[0].cells[1], TextFactCell)
        assert isinstance(table.rows[1].cells[1], EmptyCell)
        assert len(table.rows[0].cells) == len(table.rows[1].cells) == 2

        # The resource that carries nothing does not weaken the claim about the one that
        # does: the instant is still stated, and it is that fact's.
        assert table.provenance is not None
        assert COLLECTED_AT_1 in table.provenance

    def test_text_fact_anchored_to_table(self) -> None:
        """The TextFact is anchored: text_fact_anchors() returns its path mapped to
        the table anchor — the same contract render/anchors.py reads."""
        rid = f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-01"
        view = _view(_vm_with_fact(rid, "vm-01"))

        document = compile_document(
            df.definition(
                [df.block("anchored", "resource_table", {
                    "columns": [_fact_column(FACT_KEY)],
                })],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view,
        )

        # anchor_table was called, so text_fact_anchors has entries
        anchors = document.ledger.text_fact_anchors()
        assert len(anchors) == 1  # the value; the instant is not a cell
        for path, anchor in anchors.items():
            assert anchor.anchor_id is not None
            assert anchor.kind == "table"
