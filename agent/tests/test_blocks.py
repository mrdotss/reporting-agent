"""`compile/blocks/` — the block compilers, and the refusals (Req 15.4, 16.x, 18.9, 18.11).

Every definition here is validated by `tests/definition_factory.py` before it is compiled, so a
test cannot accidentally exercise the compiler with something the wizard could never have saved.
And every compile goes through `compile_document`, which runs the closing invariant
(:func:`~reporting_agent.compile.figures.assert_ledger_matches_tree`) before returning — so each
test below is implicitly also an assertion that the ledger describes the tree it produced.
"""

from __future__ import annotations

from decimal import Decimal

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.ast import (
    Chart,
    EmptyCell,
    FigureCell,
    LayoutRow,
    PageBreak,
    Paragraph,
    Table,
    Text,
    TextCell,
    child_nodes,
)
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import (
    EMPTY_SCOPE_TEXT,
    MAX_TABLE_ROWS,
    BlockContext,
    BlockSpec,
    DesignSettings,
    NO_DATA_TEXT,
    NO_GAPS_TEXT,
    OMITTED_ROW_LABEL,
    RESOURCE_ID_CONFIG_KEY,
)
from reporting_agent.compile.messages import load_messages

# These constants are now string IDs. Tests compare against the resolved English text.
_MESSAGES = load_messages("en")
EMPTY_SCOPE_TEXT_RESOLVED = _MESSAGES.text(EMPTY_SCOPE_TEXT)
NO_DATA_TEXT_RESOLVED = _MESSAGES.text(NO_DATA_TEXT)
NO_GAPS_TEXT_RESOLVED = _MESSAGES.text(NO_GAPS_TEXT)
OMITTED_ROW_LABEL_RESOLVED = _MESSAGES.text(OMITTED_ROW_LABEL)
from reporting_agent.compile.blocks.tables import (
    COLUMN_ATTRIBUTES,
    resource_attribute_text,
)
from reporting_agent.compile.figures import FigureLedger
from reporting_agent.compile.scope import scope_rules_from_plain
from reporting_agent.compile.snapshot_view import SnapshotValue, build_snapshot_view
from reporting_agent.errors import CompileFailedError, ErrorCode

VM = sf.VM_TYPE


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


def view_of(**kwargs) -> object:
    return build_snapshot_view(sf.build(**kwargs))


def walk(node: object):
    """Every node in the tree, depth first — including nested blocks inside a row column."""
    yield node
    for child in child_nodes(node):
        yield from walk(child)


def all_nodes(document) -> list[object]:
    found: list[object] = []
    for block in document.blocks:
        found.extend(walk(block))
    return found


def tables_of(document) -> list[Table]:
    return [node for node in all_nodes(document) if isinstance(node, Table)]


def text_cells_of(node) -> list[TextCell]:
    return [found for found in walk(node) if isinstance(found, TextCell)]


def figure_cells_of(node) -> list[FigureCell]:
    return [found for found in walk(node) if isinstance(found, FigureCell)]


def table_named(document, block_id: str) -> Table:
    for table in tables_of(document):
        if str(table.path).startswith(f"{block_id}:"):
            return table
    raise AssertionError(f"no table for block {block_id!r}")


# --------------------------------------------------------------------------- #
# Req 16.2 — the 500-row cap states its own truncation
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def large_view():
    """501 resources — one past the cap, which is the only interesting size."""
    return view_of(
        resources=[
            sf.vm(
                resource_id=f"/vm/{index:04d}",
                name=f"vm-{index:04d}",
                cpu_avg=f"{index % 100}.00",
                cpu_p95=None,
                memory_pct=None,
                day_cpu={},
            )
            for index in range(MAX_TABLE_ROWS + 1)
        ]
    )


def test_a_resource_table_caps_at_five_hundred_rows_and_states_the_truncation(large_view) -> None:
    document = compile_document(
        df.definition(
            [df.block("fleet", "resource_table", {"columns": [df.CPU_AVG]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=large_view,
    )
    table = table_named(document.document, "fleet")

    # 500 resource rows plus one truncation row.
    assert len(table.rows) == MAX_TABLE_ROWS + 1
    assert [row.key for row in table.rows[:MAX_TABLE_ROWS]] == [
        resource.resource_id for resource in large_view.resources[:MAX_TABLE_ROWS]
    ]

    truncation = table.rows[-1]
    assert truncation.key == "omitted"
    assert [cell.text for cell in truncation.cells if isinstance(cell, TextCell)] == [
        OMITTED_ROW_LABEL_RESOLVED
    ]

    # The count is a FIGURE, addressed to the snapshot's own resource cardinality.
    figures = [cell.figure for cell in truncation.cells if isinstance(cell, FigureCell)]
    assert len(figures) == 1
    assert figures[0].snapshot_path.endswith("/count")
    assert figures[0].value == str(MAX_TABLE_ROWS + 1)
    assert document.ledger[figures[0].path] is figures[0]


def test_the_truncation_row_carries_no_numeral_in_text(large_view) -> None:
    """A computed number in prose could be neither a figure nor allowlisted, so the verifier
    would withhold the report for a sentence the compiler wrote.

    The line this draws: text may carry identifiers and dates the snapshot already contains; it
    may not carry a quantity the compiler computed.
    """
    document = compile_document(
        df.definition(
            [df.block("fleet", "resource_table", {"columns": [df.CPU_AVG]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=large_view,
    )
    truncation = table_named(document.document, "fleet").rows[-1]

    for cell in truncation.cells:
        if isinstance(cell, TextCell):
            assert not any(character.isdigit() for character in cell.text), cell.text


def test_a_table_below_the_cap_carries_no_truncation_row() -> None:
    document = compile_document(
        df.definition(
            [df.block("fleet", "resource_table", {"columns": [df.CPU_AVG]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    table = table_named(document.document, "fleet")
    assert [row.key for row in table.rows] == ["/vm/a"]


def test_a_top_n_table_caps_and_ranks(large_view) -> None:
    """The ranking is the scope's; the cap is the table's. Both apply."""
    document = compile_document(
        df.definition(
            [
                df.block(
                    "busiest",
                    "top_n_table",
                    {"columns": [df.CPU_AVG], "order_by": df.CPU_AVG},
                    scope_override=df.scope(
                        top_n={"count": 3, "metric": sf.CPU, "statistic": "avg"},
                        sort="descending",
                    ),
                )
            ],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=large_view,
    )
    table = table_named(document.document, "busiest")

    assert len(table.rows) == 3
    values = [
        cell.figure.value
        for row in table.rows
        for cell in row.cells
        if isinstance(cell, FigureCell)
    ]
    assert values == sorted(values, key=Decimal, reverse=True)
    # The ranking column comes first among the metric columns.
    assert table.columns[-1].key == f"{sf.CPU}:avg"


# --------------------------------------------------------------------------- #
# Req 16.3 — an empty collection log gets an explicit row
# --------------------------------------------------------------------------- #


def test_gaps_and_coverage_over_an_empty_log_emits_an_explicit_no_gaps_row() -> None:
    """A missing section is indistinguishable from one that was never configured, so an empty
    log renders a row rather than nothing."""
    document = compile_document(
        df.definition([df.block("gaps", "gaps_and_coverage", {"caption": "Coverage"})]),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")], gaps=[]),
    )
    table = table_named(document.document, "gaps")

    assert len(table.rows) == 1
    assert table.rows[0].key == "no-gaps"
    assert NO_GAPS_TEXT_RESOLVED in [
        cell.text for cell in table.rows[0].cells if isinstance(cell, TextCell)
    ]
    assert figure_cells_of(table) == []


def test_gaps_and_coverage_groups_by_type_and_counts_each_group_as_a_figure() -> None:
    view = build_snapshot_view(sf.snapshot_with_every_gap_type())
    document = compile_document(
        df.definition([df.block("gaps", "gaps_and_coverage", {})]), view=view
    )
    table = table_named(document.document, "gaps")

    # Grouped by gap_type ascending in code-point order — produced, not inherited.
    assert [row.key for row in table.rows] == sorted(row.key for row in table.rows)
    assert len(table.rows) == len(view.gaps_by_type())

    # Each group's count is a figure, and the counts add up to the recorded total.
    counts = [
        cell.figure
        for row in table.rows
        for cell in row.cells
        if isinstance(cell, FigureCell)
    ]
    assert len(counts) == len(table.rows)
    assert sum(Decimal(figure.value) for figure in counts) == Decimal(len(view.gaps))


# --------------------------------------------------------------------------- #
# Req 16.5 — the verification record carries no verification outcome
# --------------------------------------------------------------------------- #


FORBIDDEN_IN_THE_RECORD = ("status", "verified", "finding", "unmatched", "unused", "pass", "fail")


def test_a_verification_record_carries_no_status_no_verified_count_and_no_finding_count() -> None:
    """Structural rather than an omission to remember: those are computed from the **rendered**
    document, which does not exist while this block is compiling."""
    view = build_snapshot_view(sf.two_vm_snapshot())
    document = compile_document(
        df.definition([df.block("record", "verification_record", {})]), view=view
    )
    table = table_named(document.document, "record")

    keys = {row.key for row in table.rows}
    texts = " ".join(cell.text for cell in text_cells_of(table)).casefold()
    for forbidden in FORBIDDEN_IN_THE_RECORD:
        assert not any(forbidden in key.casefold() for key in keys), (forbidden, keys)
        assert forbidden not in texts, forbidden


def test_a_verification_record_carries_the_provenance_and_the_counts_as_figures() -> None:
    view = build_snapshot_view(sf.two_vm_snapshot())
    document = compile_document(
        df.definition([df.block("record", "verification_record", {})]), view=view
    )
    table = table_named(document.document, "record")
    keys = [row.key for row in table.rows]

    assert "snapshot_id" in keys
    assert "window" in keys
    assert "grain" in keys
    assert "resources" in keys
    assert "gaps" in keys
    assert "raw_archive_complete" in keys
    assert any(key.startswith("fidelity_tier:") for key in keys)

    # The snapshot id, window and grain are text; every count is a figure.
    by_key = {row.key: row for row in table.rows}
    assert isinstance(by_key["snapshot_id"].cells[1], TextCell)
    assert view.snapshot_id in by_key["snapshot_id"].cells[1].text
    for key in ("resources", "gaps"):
        assert isinstance(by_key[key].cells[1], FigureCell)

    resources_figure = by_key["resources"].cells[1].figure
    assert resources_figure.value == str(len(view.resources))
    assert resources_figure.fidelity_tier is None  # a count measures no resource


# --------------------------------------------------------------------------- #
# Req 3.7, 16.10 — a zero-resource block renders, and is never omitted
# --------------------------------------------------------------------------- #


SCOPED_BLOCKS = (
    ("kpi", "kpi_row", {"metrics": [df.CPU_AVG]}),
    ("resources", "resource_table", {"columns": [df.CPU_AVG]}),
    ("topn", "top_n_table", {"columns": [df.CPU_AVG], "order_by": df.CPU_AVG}),
    (
        "capacity",
        "capacity_vs_usage",
        {
            "capacity_metric": {"sku_capability": "vCPUsAvailable"},
            "usage_metric": df.CPU_AVG,
        },
    ),
    ("trend", "timeseries_chart", {"metrics": [df.CPU_AVG]}),
    ("spread", "distribution_chart", {"metrics": [df.CPU_AVG]}),
)


def test_every_block_whose_scope_matches_nothing_still_renders_with_zero_figures() -> None:
    """The named case from Req 3.7 and 16.10: every block's scope matches nothing while the
    **union** matches one resource, so the run is not `EMPTY_SCOPE` and every block must be
    present with its explicit row and no figures.

    A block that vanished is indistinguishable from one that was never configured, and the reader
    cannot tell an empty result from a missing section.
    """
    narrow = df.scope(
        resource_types=[VM], tag_filters=[{"key": "env", "value": "does-not-exist"}]
    )
    blocks = [
        df.block(block_id, block_type, config, scope_override=narrow)
        for block_id, block_type, config in SCOPED_BLOCKS
    ]
    document = compile_document(
        df.definition(blocks, metrics={VM: [df.CPU_AVG]}),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a", tags={"env": "prod"})]),
    )

    # Every block is present, in declared order, and none was dropped.
    assert len(document.document.blocks) == len(SCOPED_BLOCKS)
    for (block_id, _, _), node in zip(SCOPED_BLOCKS, document.document.blocks, strict=True):
        assert str(node.path).startswith(f"{block_id}:"), block_id
        assert isinstance(node, Table), block_id
        assert [row.key for row in node.rows] == ["empty-scope"], block_id
        assert node.rows[0].cells[0].text == EMPTY_SCOPE_TEXT_RESOLVED  # type: ignore[union-attr]

    # Zero figures across the whole document, and therefore an empty ledger.
    assert document.figure_count == 0
    assert len(document.ledger) == 0
    assert figure_cells_of(document.document) == []


def test_an_empty_scope_block_keeps_its_caption_and_its_position() -> None:
    narrow = df.scope(tag_filters=[{"key": "env", "value": "nope"}])
    document = compile_document(
        df.definition(
            [
                df.block("before", "heading", {"level": 1, "text": "Before"}),
                df.block(
                    "empty",
                    "resource_table",
                    {"columns": [df.CPU_AVG], "caption": "Per-machine utilization"},
                    scope_override=narrow,
                ),
                df.block("after", "heading", {"level": 1, "text": "After"}),
            ],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )

    nodes = document.document.blocks
    assert [str(node.path).split(":")[0] for node in nodes] == ["before", "empty", "after"]
    assert nodes[1].caption == "Per-machine utilization"  # type: ignore[union-attr]


def test_an_empty_scope_block_reports_no_error_and_records_no_gap() -> None:
    """An empty result is not a failure: a report can legitimately ask for Storage Accounts in a
    subscription with none.

    The definition selects a metric for `Microsoft.Sql/servers` even though the snapshot holds
    none, because Req 5.9 requires every scoped resource type to carry a metric selection. That
    is the honest shape of this case rather than a concession to the validator: Req 3.7 is
    about a scope the *subscription* did not satisfy, and a definition that never selected
    anything for the type would be an author mistake rather than an empty subscription. The
    block still resolves to nothing, which is the thing under test.
    """
    view = view_of(resources=[sf.vm(resource_id="/vm/a", name="a")], gaps=[])
    document = compile_document(
        df.definition(
            [
                df.block(
                    "empty",
                    "resource_table",
                    {"columns": [df.CPU_AVG]},
                    scope_override=df.scope(resource_types=["Microsoft.Sql/servers"]),
                )
            ],
            metrics={VM: [df.CPU_AVG], "Microsoft.Sql/servers": [df.CPU_AVG]},
        ),
        view=view,
    )
    assert document.figure_count == 0
    assert view.gaps == ()


# --------------------------------------------------------------------------- #
# Req 16.1 — every quantity is a figure; nothing numeric is a text node
# --------------------------------------------------------------------------- #


def test_a_missing_value_becomes_an_empty_cell_not_a_zero() -> None:
    """A metric a resource does not emit is a recorded gap. A zero would read as measured
    idleness — the single error this package exists to prevent."""
    document = compile_document(
        df.definition(
            [
                df.block(
                    "fleet",
                    "resource_table",
                    {"columns": [df.CPU_AVG, {"metric": "Network In Total", "statistic": "avg"}]},
                )
            ],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    row = table_named(document.document, "fleet").rows[0]

    assert isinstance(row.cells[1], FigureCell)
    assert isinstance(row.cells[2], EmptyCell)


def test_a_kpi_row_selects_an_extreme_and_names_the_resource_that_carries_it() -> None:
    """A fleet average would be arithmetic with no snapshot address, so a KPI selects. The row
    names the resource, so the figure is attributable."""
    view = view_of(
        resources=[
            sf.vm(resource_id="/vm/a", name="quiet", cpu_avg="5.00", cpu_min="1.00"),
            sf.vm(resource_id="/vm/b", name="busy", cpu_avg="90.00", cpu_min="40.00"),
        ]
    )
    document = compile_document(
        df.definition(
            [df.block("kpi", "kpi_row", {"metrics": [df.CPU_AVG, {"metric": sf.CPU, "statistic": "min"}]})],
            metrics={VM: [df.CPU_AVG, {"metric": sf.CPU, "statistic": "min"}]},
        ),
        view=view,
    )
    table = table_named(document.document, "kpi")

    avg_row, min_row = table.rows
    assert avg_row.cells[1].text == "highest observed"  # type: ignore[union-attr]
    assert avg_row.cells[2].figure.value == "90.00"  # type: ignore[union-attr]
    assert avg_row.cells[3].text == "busy"  # type: ignore[union-attr]

    # A `min` statistic selects the LOWEST, and says so.
    assert min_row.cells[1].text == "lowest observed"  # type: ignore[union-attr]
    assert min_row.cells[2].figure.value == "1.00"  # type: ignore[union-attr]
    assert min_row.cells[3].text == "quiet"  # type: ignore[union-attr]


def test_a_capacity_and_its_usage_are_both_figures_and_there_is_no_headroom_column() -> None:
    """Capacity minus usage is arithmetic with no snapshot address, so the document places the
    two numbers side by side rather than inventing a third."""
    document = compile_document(
        df.definition(
            [
                df.block(
                    "headroom",
                    "capacity_vs_usage",
                    {
                        "capacity_metric": {"sku_capability": "MemoryGB"},
                        "usage_metric": df.MEMORY_USED_PCT_AVG,
                    },
                )
            ],
            metrics={VM: [df.CPU_AVG, df.MEMORY_USED_PCT_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    table = table_named(document.document, "headroom")

    assert [column.key for column in table.columns] == [
        "resource",
        "sku:MemoryGB",
        f"{sf.MEMORY_USED_PCT}:avg",
    ]
    row = table.rows[0]
    assert isinstance(row.cells[1], FigureCell)
    assert isinstance(row.cells[2], FigureCell)
    assert row.cells[1].figure.snapshot_path.endswith("/sku/memory_bytes")


def test_a_resource_with_no_resolvable_capacity_gets_an_empty_cell() -> None:
    document = compile_document(
        df.definition(
            [
                df.block(
                    "headroom",
                    "capacity_vs_usage",
                    {
                        "capacity_metric": {"sku_capability": "MemoryGB"},
                        "usage_metric": df.CPU_AVG,
                    },
                )
            ],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(
            resources=[sf.vm(resource_id="/vm/a", name="a", memory_bytes=None)]
        ),
    )
    row = table_named(document.document, "headroom").rows[0]
    assert isinstance(row.cells[1], EmptyCell)
    assert isinstance(row.cells[2], FigureCell)


# --------------------------------------------------------------------------- #
# Req 16.14 — charts, and who decides the encoding
# --------------------------------------------------------------------------- #


def charts_of(document) -> list[Chart]:
    return [node for node in all_nodes(document) if isinstance(node, Chart)]


def test_one_timeseries_series_is_sequential_and_several_are_categorical() -> None:
    single = compile_document(
        df.definition(
            [df.block("trend", "timeseries_chart", {"metrics": [df.CPU_AVG]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    assert charts_of(single.document)[0].encoding == "sequential"

    several = compile_document(
        df.definition(
            [df.block("trend", "timeseries_chart", {"metrics": [df.CPU_AVG]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(
            resources=[
                sf.vm(resource_id="/vm/a", name="a"),
                sf.vm(resource_id="/vm/b", name="b"),
            ]
        ),
    )
    chart = charts_of(several.document)[0]
    assert chart.encoding == "categorical"
    assert len(chart.series) == 2


def test_every_plotted_value_is_a_figure_in_the_ledger() -> None:
    document = compile_document(
        df.definition(
            [df.block("trend", "timeseries_chart", {"metrics": [df.CPU_AVG]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    chart = charts_of(document.document)[0]
    points = [point for series in chart.series for point in series.points]

    assert points
    for point in points:
        assert document.ledger[point.y.path] is point.y
        assert point.y.snapshot_path.startswith("/resources/")


def test_a_timeseries_omits_a_day_with_no_value_rather_than_plotting_zero() -> None:
    document = compile_document(
        df.definition(
            [df.block("trend", "timeseries_chart", {"metrics": [df.CPU_AVG]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(
            resources=[
                sf.vm(resource_id="/vm/a", name="a", day_cpu={sf.DAY_ONE: "10.00"})
            ]
        ),
    )
    chart = charts_of(document.document)[0]
    assert [point.x for point in chart.series[0].points] == [sf.DAY_ONE]


def test_a_distribution_chart_sorts_ascending_and_is_sequential() -> None:
    document = compile_document(
        df.definition(
            [df.block("spread", "distribution_chart", {"metrics": [df.CPU_AVG]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(
            resources=[
                sf.vm(resource_id="/vm/a", name="a", cpu_avg="90.00"),
                sf.vm(resource_id="/vm/b", name="b", cpu_avg="10.00"),
                sf.vm(resource_id="/vm/c", name="c", cpu_avg="50.00"),
            ]
        ),
    )
    chart = charts_of(document.document)[0]
    assert chart.encoding == "sequential"
    values = [Decimal(point.y.value) for point in chart.series[0].points]
    assert values == sorted(values)
    assert [point.x for point in chart.series[0].points] == ["b", "c", "a"]


def test_a_chart_whose_metric_no_resource_carries_says_so_rather_than_blaming_the_scope() -> None:
    """The scope matched resources and the snapshot holds nothing for the metric. That is a
    recorded gap, not a chart of zeros — and not an empty scope either.

    This test used to assert `EMPTY_SCOPE_TEXT` here, which is a **false statement**: the
    filter selected a resource, and telling the reader it matched nothing sends them to
    correct a filter that is already correct. It is also unreachable by the verifier, since
    Req 27.11 exempts the no-resources-matched notice from `table_rows_absent` — so the
    wrong claim passed every gate. The two facts now have two texts."""
    document = compile_document(
        df.definition(
            [
                df.block(
                    "spread",
                    "distribution_chart",
                    {"metrics": [{"metric": "Network In Total", "statistic": "avg"}]},
                )
            ],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    assert charts_of(document.document) == []
    table = table_named(document.document, "spread")
    assert table.rows[0].key == "no-data"
    assert table.rows[0].cells[0].text == NO_DATA_TEXT_RESOLVED  # type: ignore[union-attr]
    assert table.rows[0].cells[0].text != EMPTY_SCOPE_TEXT_RESOLVED  # type: ignore[union-attr]


def test_a_timeseries_over_a_snapshot_with_no_day_values_says_so() -> None:
    """The branch that started this: a matched scope and empty day buckets.

    Reachable in production, and it was reachable silently — the block emitted "No resources
    matched this scope" over a scope that matched, and no gate could see it. Pinned here
    with a snapshot whose day buckets carry no statistics, which is what a resource
    deallocated for the whole window produces.
    """
    document = compile_document(
        df.definition(
            [df.block("trend", "timeseries_chart", {"metrics": [df.CPU_AVG]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(
            resources=[sf.vm(resource_id="/vm/a", name="a", day_cpu={})]
        ),
    )

    assert charts_of(document.document) == []
    row = table_named(document.document, "trend").rows[0]
    assert row.key == "no-data"
    assert row.cells[0].text == NO_DATA_TEXT_RESOLVED  # type: ignore[union-attr]
    assert document.figure_count == 0


def test_the_two_notice_rows_say_two_different_things() -> None:
    """An empty scope and missing data are distinct facts, and one chart block reports both.

    Asserted as a pair over one block type, because the failure mode is convergence: the two
    branches sat behind one helper for a while and the document said "No resources matched
    this scope" for a scope that matched two. Nothing else in the suite would notice them
    becoming one string again — the verifier cannot, since a notice row carries no figure to
    check, and Req 27.11 exempts the empty-scope text from the one gate that looks at row
    counts.
    """
    resources = [sf.vm(resource_id="/vm/a", name="a", tags={"env": "prod"})]
    config = {"metrics": [{"metric": "Network In Total", "statistic": "avg"}]}

    # The scope matched nothing.
    empty = compile_document(
        df.definition(
            [
                df.block(
                    "spread",
                    "distribution_chart",
                    config,
                    scope_override=df.scope(
                        tag_filters=[{"key": "env", "value": "does-not-exist"}]
                    ),
                )
            ],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=resources),
    )

    # The scope matched, and the snapshot carries no value for what the block plots.
    absent = compile_document(
        df.definition([df.block("spread", "distribution_chart", config)],
                      metrics={VM: [df.CPU_AVG]}),
        view=view_of(resources=resources),
    )

    empty_row = table_named(empty.document, "spread").rows[0]
    absent_row = table_named(absent.document, "spread").rows[0]

    assert empty_row.cells[0].text == EMPTY_SCOPE_TEXT_RESOLVED  # type: ignore[union-attr]
    assert absent_row.cells[0].text == NO_DATA_TEXT_RESOLVED  # type: ignore[union-attr]
    assert EMPTY_SCOPE_TEXT != NO_DATA_TEXT_RESOLVED
    assert empty_row.key != absent_row.key

    # Both carry zero figures and keep the block in the document (Req 3.7, 16.11).
    for compiled in (empty, absent):
        assert compiled.figure_count == 0
        assert len(compiled.document.blocks) == 1


# --------------------------------------------------------------------------- #
# The structural blocks
# --------------------------------------------------------------------------- #


def test_a_heading_becomes_a_styled_paragraph_and_a_level_out_of_range_is_clamped() -> None:
    """Clamped rather than refused: `BLOCK_CONFIG` does not bound `level`, so refusing would fail
    a run for a definition the wizard saved cleanly."""
    document = compile_document(
        df.definition(
            [
                df.block("h1", "heading", {"level": 1, "text": "One"}),
                df.block("h9", "heading", {"level": 9, "text": "Nine"}),
                df.block("h0", "heading", {"level": 0, "text": "Zero"}),
            ]
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    styles = [node.style for node in document.document.blocks if isinstance(node, Paragraph)]
    assert styles == ["Heading 1", "Heading 4", "Heading 1"]
    assert document.figure_count == 0


def test_rich_text_and_page_break_carry_no_figure() -> None:
    document = compile_document(
        df.definition(
            [
                df.block("prose", "rich_text", {"text": "A fixed methodological caveat."}),
                df.block("brk", "page_break", {}),
            ]
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    prose, brk = document.document.blocks
    assert isinstance(prose, Paragraph)
    assert isinstance(prose.inlines[0], Text)
    assert isinstance(brk, PageBreak)
    assert document.figure_count == 0


def test_a_cover_is_emitted_only_when_the_cover_page_flag_is_true() -> None:
    blocks = [df.block("cover", "cover", {"subtitle": "Monthly review"})]
    view = view_of(resources=[sf.vm(resource_id="/vm/a", name="a")])

    on = compile_document(
        df.definition(blocks, name="Titled"), view=view, subscription_display_name="Acme"
    )
    assert len(on.document.blocks) == 4
    assert [node.style for node in on.document.blocks] == [  # type: ignore[union-attr]
        "Title",
        "Subtitle",
        "Body Text",
        "Body Text",
    ]
    # No metric value on a cover (Req 16.13).
    assert on.figure_count == 0

    off = compile_document(
        df.definition(
            blocks,
            design={
                "preset": "minimal",
                "accent_color": "#000",
                "density": "normal",
                "table_style": "hairline",
                "number_format": {"decimal_places": 1, "group_thousands": True},
                "cover_page": False,
                "logo": None,
                "page_size": "A4",
            },
        ),
        view=view,
    )
    assert off.document.blocks == ()


def test_a_row_places_each_childs_nodes_in_its_column_rooted_at_the_childs_own_id() -> None:
    document = compile_document(
        df.definition(
            [
                {
                    "id": "row-1",
                    "type": "row",
                    "columns": [
                        [df.block("left", "kpi_row", {"metrics": [df.CPU_AVG]})],
                        [df.block("right", "heading", {"level": 2, "text": "Right"})],
                    ],
                }
            ],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    row = document.document.blocks[0]
    assert isinstance(row, LayoutRow)
    assert len(row.columns) == 2

    left = row.columns[0].blocks[0]
    right = row.columns[1].blocks[0]
    assert str(left.path).startswith("left:")
    assert str(right.path).startswith("right:")

    # A nested block's figures are rooted at ITS block id, not the row's.
    for path in document.ledger.paths():
        assert str(path).startswith("left:")


# --------------------------------------------------------------------------- #
# Req 16.12 — the model writes prose, and only prose
# --------------------------------------------------------------------------- #


class FakeProse:
    def __init__(self, answer: str) -> None:
        self.answer = answer
        self.requests: list[object] = []

    def narrate(self, request):
        self.requests.append(request)
        return self.answer


class FailingProse:
    def narrate(self, request):
        raise RuntimeError("the narrator is unavailable")


def _summary_definition():
    return df.definition(
        [
            df.block("kpi", "kpi_row", {"metrics": [df.CPU_AVG]}),
            df.block("summary", "executive_summary", {}),
        ],
        metrics={VM: [df.CPU_AVG]},
    )


def test_model_prose_is_inserted_as_text_nodes_unaltered() -> None:
    prose = FakeProse("CPU headroom is substantial.\n\nTwo machines carry the load.")
    document = compile_document(
        _summary_definition(),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
        prose=prose,
    )

    paragraphs = [
        node
        for node in document.document.blocks
        if isinstance(node, Paragraph) and str(node.path).startswith("summary:")
    ]
    assert [paragraph.inlines[0].text for paragraph in paragraphs] == [  # type: ignore[union-attr]
        "CPU headroom is substantial.",
        "Two machines carry the load.",
    ]
    for paragraph in paragraphs:
        assert all(isinstance(inline, Text) for inline in paragraph.inlines)


def test_the_model_sees_the_complete_ledger_and_only_formatted_strings() -> None:
    """Two-phase: the request cannot be built until every block's figures exist. And it carries
    `formatted` strings rather than values, so the model is never in a position to compute."""
    prose = FakeProse("Prose.")
    document = compile_document(
        _summary_definition(),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
        prose=prose,
    )

    assert len(prose.requests) == 1
    request = prose.requests[0]
    assert request.figures
    formatted = {value for _, value in request.figures}
    assert formatted <= {figure.formatted for figure in document.ledger.entries.values()}
    # Every figure that exists at the end was visible to the model.
    assert len(request.figures) == len(document.ledger)


def test_the_summarys_figures_precede_its_prose_so_their_paths_do_not_move() -> None:
    """A node's path is its position, and the prose length is unknown when the figures are
    minted. If the prose came first, every figure's ledger key would depend on how much the model
    wrote — and two runs over one snapshot would produce two different ledgers."""
    view = view_of(resources=[sf.vm(resource_id="/vm/a", name="a")])
    short = compile_document(_summary_definition(), view=view, prose=FakeProse("One."))
    long = compile_document(
        _summary_definition(),
        view=view,
        prose=FakeProse("One.\n\nTwo.\n\nThree.\n\nFour."),
    )

    summary_paths = lambda result: sorted(  # noqa: E731
        str(path) for path in result.ledger.paths() if str(path).startswith("summary:")
    )
    assert summary_paths(short) == summary_paths(long)
    assert summary_paths(short)


def test_a_prose_failure_costs_a_paragraph_and_not_the_run() -> None:
    document = compile_document(
        _summary_definition(),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
        prose=FailingProse(),
    )
    summary_nodes = [
        node for node in document.document.blocks if str(node.path).startswith("summary:")
    ]
    assert len(summary_nodes) == 1  # the headline table, no prose paragraph
    assert isinstance(summary_nodes[0], Table)
    assert document.figure_count > 0


def test_no_provider_means_no_prose_and_still_a_document() -> None:
    document = compile_document(
        _summary_definition(), view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")])
    )
    assert any(str(node.path).startswith("summary:") for node in document.document.blocks)


# --------------------------------------------------------------------------- #
# Req 16.6 — the methodology appendix reads labels from the ledger
# --------------------------------------------------------------------------- #


def test_the_appendix_reads_each_estimated_statistics_label_from_the_ledger() -> None:
    view = build_snapshot_view(sf.two_vm_snapshot())
    document = compile_document(
        df.definition(
            [
                df.block("kpi", "kpi_row", {"metrics": [df.CPU_P95]}),
                df.block("method", "appendix_methodology", {}),
            ],
            metrics={VM: [df.CPU_AVG, df.CPU_P95]},
        ),
        view=view,
    )

    labels = {
        figure.estimator_label
        for figure in document.ledger.entries.values()
        if figure.estimator_label
    }
    assert labels == {"p95, est. from hourly averages"}

    text = " ".join(
        inline.text
        for node in document.document.blocks
        if isinstance(node, Paragraph) and str(node.path).startswith("method:")
        for inline in node.inlines
        if isinstance(inline, Text)
    )
    for label in labels:
        assert label in text
    assert "last_full_month" in text
    assert view.grain in text
    assert "baseline" in text


def test_the_appendix_carries_no_figure() -> None:
    document = compile_document(
        df.definition(
            [df.block("method", "appendix_methodology", {})], metrics={VM: [df.CPU_AVG]}
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
    )
    assert document.figure_count == 0


# --------------------------------------------------------------------------- #
# Req 18.9, 18.11 — formatter refusals, as COMPILE_FAILED naming the AST path
# --------------------------------------------------------------------------- #


def test_a_metric_with_no_catalog_scale_fails_the_run_naming_the_ast_path() -> None:
    """Req 18.11 — no default scale. Publishing a figure at a guessed precision is a claim about
    how well something was measured, made on the basis of nothing."""
    with pytest.raises(CompileFailedError) as caught:
        compile_document(
            df.definition(
                [df.block("fleet", "resource_table", {"columns": [df.CPU_AVG]})],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
            # A catalog that declares a scale for nothing this block reads.
            catalog_scales={"Some Other Metric": 2},
        )

    message = str(caught.value)
    assert caught.value.code is ErrorCode.COMPILE_FAILED
    assert caught.value.terminal is True
    assert "fleet:" in message, message


def test_a_value_that_is_neither_a_decimal_nor_a_decimal_string_fails_naming_the_path(
    monkeypatch,
) -> None:
    """Req 18.9. Reached through the block path by handing the view a value whose `value` field is
    a float — the one shape `SnapshotValue` does not itself police, and the shape a binary
    approximation would arrive as."""
    view = view_of(resources=[sf.vm(resource_id="/vm/a", name="a")])
    genuine = view.stat("/vm/a", sf.CPU, "avg")
    assert genuine is not None

    corrupted = SnapshotValue(
        value=12.48,  # type: ignore[arg-type]
        unit=genuine.unit,
        statistic=genuine.statistic,
        estimator=genuine.estimator,
        fidelity_tier=genuine.fidelity_tier,
        scale=genuine.scale,
        metric=genuine.metric,
        resource_id=genuine.resource_id,
        window=genuine.window,
        pointer=genuine.pointer,
    )

    def corrupted_stat(resource_id, metric, statistic, *, instance=None):
        return corrupted

    monkeypatch.setattr(type(view), "stat", staticmethod(corrupted_stat))

    with pytest.raises(CompileFailedError) as caught:
        compile_document(
            df.definition(
                [df.block("fleet", "resource_table", {"columns": [df.CPU_AVG]})],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view,
        )
    assert "float" in str(caught.value)
    assert "fleet:" in str(caught.value)


# --------------------------------------------------------------------------- #
# Req 16.11 — a block that cannot compile names its id and its type
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("block_type", "config"),
    [
        ("kpi_row", {"metrics": []}),
        ("kpi_row", {"metrics": "Percentage CPU"}),
        ("kpi_row", {"metrics": ["Percentage CPU"]}),
        ("kpi_row", {"metrics": [{"statistic": "avg"}]}),
        ("kpi_row", {"metrics": [{"metric": sf.CPU}]}),
        ("resource_table", {"columns": []}),
        ("top_n_table", {"columns": [df.CPU_AVG], "order_by": "cpu"}),
        (
            "capacity_vs_usage",
            {"capacity_metric": "vCPUsAvailable", "usage_metric": df.CPU_AVG},
        ),
        (
            "capacity_vs_usage",
            {"capacity_metric": {"sku_capability": "Nonsense"}, "usage_metric": df.CPU_AVG},
        ),
        ("heading", {"level": 1}),
        ("rich_text", {"text": ""}),
    ],
)
def test_an_unreadable_config_names_the_block_id_and_type(block_type: str, config: dict) -> None:
    """`BLOCK_CONFIG` is deliberately shallow — field names only — so a value's *shape* is checked
    here. A shape this compiler cannot read is a refusal naming the block, never a silently
    skipped column: a dropped column is a document quietly missing something the author
    configured."""
    with pytest.raises(CompileFailedError) as caught:
        compile_document(
            df.definition(
                [df.block("offender", block_type, config)],
                metrics={VM: [df.CPU_AVG]},
                validate=False,
            ),
            view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
        )
    message = str(caught.value)
    assert "'offender'" in message, message
    assert block_type in message, message


def test_an_undeclared_block_type_is_refused_rather_than_dropped() -> None:
    """Req 2.3 restated one layer down: the validator rejects an undeclared type, so reaching this
    branch means the two halves drifted — and dropping the block would turn that drift into a
    document quietly missing a section."""
    with pytest.raises(CompileFailedError) as caught:
        compile_document(
            df.definition([df.block("bogus", "sankey_diagram", {})], validate=False),
            view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
        )
    assert "sankey_diagram" in str(caught.value)
    assert "'bogus'" in str(caught.value)


def test_a_deferred_block_inside_a_row_column_is_refused() -> None:
    """A deferred assembly happens after the whole document's phase one, so a node produced then
    could not be placed inside a `LayoutColumn` that was already built."""
    with pytest.raises(CompileFailedError) as caught:
        compile_document(
            df.definition(
                [
                    {
                        "id": "row-1",
                        "type": "row",
                        "columns": [
                            [df.block("summary", "executive_summary", {})],
                            [df.block("h", "heading", {"level": 2, "text": "Right"})],
                        ],
                    }
                ],
                metrics={VM: [df.CPU_AVG]},
            ),
            view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a")]),
        )
    assert "'row-1'" in str(caught.value)
    assert "document order" in str(caught.value)


# --------------------------------------------------------------------------- #
# The closing invariant, stated once explicitly
# --------------------------------------------------------------------------- #


def test_the_ledger_describes_the_tree_for_a_document_using_every_block_type() -> None:
    """`compile_document` runs the closing invariant before returning, so this asserts the parts
    it checks are actually non-trivial here: figures exist, they are the tree's own objects, and
    the anchors point at real tables."""
    import json
    from pathlib import Path

    corpus = Path(__file__).resolve().parent / "fixtures" / "definitions"
    body = json.loads((corpus / "accept-every-block-type.json").read_text(encoding="utf-8"))

    view = build_snapshot_view(sf.two_vm_snapshot())
    earlier = build_snapshot_view(
        sf.build(
            resources=[
                sf.vm(resource_id=resource.resource_id, name=resource.name, cpu_avg="50.00")
                for resource in view.resources
            ]
        )
    )

    class Comparison:
        def snapshot_for(self, run_id: str):
            return earlier if run_id == "run-2026-06" else view

    document = compile_document(
        body,
        view=view,
        subscription_display_name="Acme Production",
        prose=FakeProse("Prose."),
        comparison_source=Comparison(),
    )

    assert document.figure_count > 20
    for path, figure in document.ledger.entries.items():
        assert document.ledger[path] is figure
    for anchor in document.ledger.anchors().values():
        assert anchor.anchor_id.startswith(("tbl:", "cht:"))


# --------------------------------------------------------------------------- #
# Req 12.3 — the column-attribute vocabulary is exactly what the compiler can emit
# --------------------------------------------------------------------------- #
def test_resource_attribute_text_answers_for_every_declared_attribute():
    """Totality over `COLUMN_ATTRIBUTES`, asserted name by name.

    This is the assertion that keeps the constant honest in the direction that matters. The
    builder's `column_list` options come from this vocabulary (mirrored into
    `app/lib/templates/options.ts`), so a name in the tuple with no branch in
    `resource_attribute_text` is a column a consultant selects, saves, and then finds missing
    from a delivered document — and the mirror guard cannot see it, because both halves would
    agree on a name neither can emit.

    Asserted against the **snapshot's own values** rather than against literals, so a branch
    reading the wrong field fails here: returning `resource.resource_group` for `location`
    would satisfy "answers for every attribute" and be wrong.
    """
    view = build_snapshot_view(
        sf.build(resources=[sf.vm(resource_id="/subscriptions/s/x", name="prod-web-01")])
    )
    resource = view.resources[0]

    expected = {
        "resource_name": resource.name,
        "resource_group": resource.resource_group,
        "resource_type": resource.resource_type,
        "location": resource.location,
        "sku_name": resource.sku.name,
        "power_state": resource.power_state,
        "fidelity_tier": resource.fidelity_tier,
    }
    # The two lists are compared before the values, so adding a member to the tuple without
    # extending this mapping fails as a missing case rather than as a silent skip.
    assert sorted(expected) == sorted(COLUMN_ATTRIBUTES)

    for attribute in COLUMN_ATTRIBUTES:
        assert resource_attribute_text(resource, attribute) == expected[attribute]


def test_resource_attribute_text_refuses_a_name_outside_the_vocabulary():
    """A name the tuple does not carry raises, naming the declared set.

    Refusing rather than returning `""` is the point: an empty string is a legitimate answer
    for an attribute the inventory did not record, so a silent `""` for an *unknown* name would
    be indistinguishable from an unresolved SKU and the column would simply be blank.
    """
    view = build_snapshot_view(
        sf.build(resources=[sf.vm(resource_id="/subscriptions/s/x", name="prod-web-01")])
    )
    resource = view.resources[0]

    for attribute in ("tags", "resource_id", "Percentage CPU", "resource_name ", ""):
        with pytest.raises(ValueError, match="not a declared column attribute"):
            resource_attribute_text(resource, attribute)


def test_the_declared_attributes_are_a_tuple_of_unique_names_in_a_fixed_order():
    """Order and uniqueness, because the mirror is compared order-sensitively.

    A `list` would let a caller reorder the vocabulary in place and a duplicate would make the
    app's option list show one attribute twice, so both are asserted rather than assumed from
    the literal's appearance.
    """
    assert isinstance(COLUMN_ATTRIBUTES, tuple)
    assert len(set(COLUMN_ATTRIBUTES)) == len(COLUMN_ATTRIBUTES)
    assert COLUMN_ATTRIBUTES[0] == "resource_name"
    assert set(COLUMN_ATTRIBUTES) >= {"resource_name", "fidelity_tier"}


# --------------------------------------------------------------------------- #
# blank_rows_table
# --------------------------------------------------------------------------- #


def test_blank_rows_table_emits_the_declared_rows_and_columns_as_empty_cells() -> None:
    """Section 13's author-filled table: ruled empty rows a consultant fills in after
    printing, at the declared column and row count, with no resource resolution at all.

    Added because this exact shape — more than one row, each needing more than one
    column — went unexercised by any compile-path test until the catalogue's
    `incident_report` entry (5 columns, 5 rows) was driven through `compile_document`
    for the first time and raised a `TypeError` from a `cursor.child()` call passing
    the row and column ordinals as two positional arguments to a method that takes
    exactly one field name and one ordinal per call. The existing corpus fixture for
    this block type asserted only that a definition carrying it validates — never that
    it compiles — so the defect shipped in the block's very first commit and stayed
    invisible until this test (and the catalogue regression test in
    `test_expand_sections.py`) exercised the real compile path with more than a single
    cell.
    """
    view = view_of(resources=[], gaps=[])
    document = compile_document(
        df.definition(
            [
                df.block(
                    "blank",
                    "blank_rows_table",
                    {"columns": ["date", "description", "impact"], "rows": 3},
                ),
            ]
        ),
        view=view,
    )

    table = next(node for node in child_nodes(document.document) if isinstance(node, Table))
    # The compiler-generated "No" ordinal column is always first, and is never
    # part of the author's own `columns` config.
    assert [column.key for column in table.columns] == [
        "no",
        "date",
        "description",
        "impact",
    ]
    assert len(table.rows) == 3

    for row_idx, row in enumerate(table.rows):
        assert row.key == f"row_{row_idx}"
        assert len(row.cells) == 4
        # The ordinal cell is a real TextCell holding the row's 1-based
        # position — not empty, even on a fully blank row.
        assert isinstance(row.cells[0], TextCell)
        assert row.cells[0].text == str(row_idx + 1)
        for cell in row.cells[1:]:
            assert isinstance(cell, EmptyCell)
            # Every cell's path is distinct — proof the row/column ordinals actually
            # reached the path rather than silently colliding.
            assert str(cell.path) not in {
                str(other.path)
                for other_row in table.rows
                for other in other_row.cells
                if other is not cell
            }


def test_blank_rows_table_produces_no_ledger_entry_for_any_cell() -> None:
    """An `EmptyCell` carries no figure and mints no anchor — the ledger's
    bidirectional completeness check (which `compile_document` runs on every call) is
    unaffected by a block that is all empty cells."""
    view = view_of(resources=[], gaps=[])
    document = compile_document(
        df.definition(
            [
                df.block(
                    "blank",
                    "blank_rows_table",
                    {"columns": ["status"], "rows": 2},
                ),
            ]
        ),
        view=view,
    )

    assert document.figure_count == 0


def test_blank_rows_table_prints_supplied_rows_first_then_pads_to_the_minimum() -> None:
    """Author-supplied rows print first, in entry order, then the table pads
    with blank rows up to `config.rows`'s declared minimum total."""
    view = view_of(resources=[], gaps=[])
    document = compile_document(
        df.definition(
            [
                df.block(
                    "incidents",
                    "blank_rows_table",
                    {
                        "columns": ["Case", "Date", "Solution", "Description"],
                        "rows": 5,
                        "supplied_rows": [
                            ["INC-1", "14 July", "Restarted", "Brief outage"],
                            ["INC-2", "22 July", "Scaled up", "High CPU"],
                        ],
                    },
                ),
            ]
        ),
        view=view,
    )

    table = next(node for node in child_nodes(document.document) if isinstance(node, Table))
    assert len(table.rows) == 5  # padded up to the minimum, not just the 2 supplied

    first_row, second_row = table.rows[0], table.rows[1]
    assert [cell.text for cell in first_row.cells if isinstance(cell, TextCell)] == [
        "1",
        "INC-1",
        "14 July",
        "Restarted",
        "Brief outage",
    ]
    assert [cell.text for cell in second_row.cells if isinstance(cell, TextCell)] == [
        "2",
        "INC-2",
        "22 July",
        "Scaled up",
        "High CPU",
    ]

    # The remaining 3 rows are padding: a real ordinal, empty cells otherwise.
    for row_idx in range(2, 5):
        row = table.rows[row_idx]
        assert isinstance(row.cells[0], TextCell)
        assert row.cells[0].text == str(row_idx + 1)
        assert all(isinstance(cell, EmptyCell) for cell in row.cells[1:])


def test_blank_rows_table_with_zero_supplied_rows_is_the_original_all_blank_behaviour() -> None:
    """Zero supplied rows reproduces exactly the all-blank behaviour this block
    always had, unchanged — the ordinal column is the only visible difference."""
    view = view_of(resources=[], gaps=[])
    document = compile_document(
        df.definition(
            [
                df.block(
                    "incidents",
                    "blank_rows_table",
                    {"columns": ["Case", "Date"], "rows": 3},
                ),
            ]
        ),
        view=view,
    )

    table = next(node for node in child_nodes(document.document) if isinstance(node, Table))
    assert len(table.rows) == 3
    for row in table.rows:
        assert all(isinstance(cell, EmptyCell) for cell in row.cells[1:])


def test_blank_rows_table_more_supplied_rows_than_the_minimum_adds_no_padding() -> None:
    """More supplied rows than `config.rows` prints all of them with zero
    padding, rather than truncating the author's own content to fit a minimum
    that is meant as a floor, not a ceiling."""
    view = view_of(resources=[], gaps=[])
    document = compile_document(
        df.definition(
            [
                df.block(
                    "incidents",
                    "blank_rows_table",
                    {
                        "columns": ["Case"],
                        "rows": 2,
                        "supplied_rows": [["A"], ["B"], ["C"], ["D"]],
                    },
                ),
            ]
        ),
        view=view,
    )

    table = next(node for node in child_nodes(document.document) if isinstance(node, Table))
    assert len(table.rows) == 4
    assert all(
        not any(isinstance(cell, EmptyCell) for cell in row.cells)
        for row in table.rows
    )


def test_blank_rows_table_supplied_rows_produce_no_ledger_entry() -> None:
    """Author-supplied text is presentation, exactly like a revision-history
    note: it enters no figure ledger, is checked by no numeric gate, and its
    absence is not a verification finding."""
    view = view_of(resources=[], gaps=[])
    document = compile_document(
        df.definition(
            [
                df.block(
                    "incidents",
                    "blank_rows_table",
                    {
                        "columns": ["Case"],
                        "rows": 1,
                        "supplied_rows": [["INC-1"]],
                    },
                ),
            ]
        ),
        view=view,
    )

    assert document.figure_count == 0


def test_blank_rows_table_rejects_a_supplied_row_of_the_wrong_length() -> None:
    view = view_of(resources=[], gaps=[])
    with pytest.raises(CompileFailedError):
        compile_document(
            df.definition(
                [
                    df.block(
                        "incidents",
                        "blank_rows_table",
                        {
                            "columns": ["Case", "Date"],
                            "rows": 1,
                            "supplied_rows": [["only-one-value"]],
                        },
                    ),
                ]
            ),
            view=view,
        )


def test_blank_rows_table_rejects_a_columns_entry_named_no() -> None:
    """`No` is generated by the compiler and prepended automatically — an
    author declaring it in `config.columns` would collide with the column the
    compiler already emits."""
    view = view_of(resources=[], gaps=[])
    with pytest.raises(CompileFailedError):
        compile_document(
            df.definition(
                [
                    df.block(
                        "incidents",
                        "blank_rows_table",
                        {"columns": ["No", "Case"], "rows": 1},
                    ),
                ]
            ),
            view=view,
        )


# ---------------------------------------------------------------------------
# Attribute columns, and the per-resource narrowing
# ---------------------------------------------------------------------------


def test_an_attribute_column_reaches_the_table() -> None:
    """`kind: "attribute"` columns are emitted, not silently dropped.

    `read_column_entries` validated them against `COLUMN_ATTRIBUTES` and
    `resource_attribute_text` could render every one, and in between the two
    `compile_resource_table` read only the `metric` and `fact` entries — so an attribute
    column passed save-time validation, passed compile, and arrived in the document as
    nothing at all.

    What that produced: `azure_subscription` declares `resource_type` + a `count` fact and
    `resource_groups` declares `resource_group` + `resource_type` + the same fact, and both
    rendered as the identical two-column `Resource | Count` table over every resource in
    the subscription — twenty-three rows of resource ids, twice, under a blank column.
    """
    document = compile_document(
        df.definition(
            [df.block("inventory", "resource_table", {"columns": [
                {"kind": "attribute", "attribute": "resource_group"},
                {"kind": "attribute", "attribute": "location"},
                df.CPU_AVG,
            ]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[
            sf.vm(resource_id="/vm/a", name="a", resource_group="rg-prod", location="southeastasia"),
        ]),
    )
    table = table_named(document.document, "inventory")

    # Attributes sit between the key column and the numbers.
    assert [column.key for column in table.columns] == [
        "resource", "resource_group", "location", f"{sf.CPU}:avg",
    ]
    row = table.rows[0]
    assert [cell.text for cell in row.cells[:3] if isinstance(cell, TextCell)] == [
        "a", "rg-prod", "southeastasia",
    ]


def test_an_attribute_column_carries_no_figure() -> None:
    """An attribute is a string the inventory already held, so it emits as a `TextCell`.

    It carries no figure, which means it is not in the ledger and the `facts` gate does not
    check it — the same treatment the resource-name column has always had. A `TextCell`
    rather than a `TextFactCell` because the value has no `collected_at` of its own: it came
    off the resource record, not off a fact query.
    """
    document = compile_document(
        df.definition(
            [df.block("inventory", "resource_table", {"columns": [
                {"kind": "attribute", "attribute": "power_state"},
            ]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a", power_state="running")]),
    )
    row = table_named(document.document, "inventory").rows[0]

    assert all(isinstance(cell, TextCell) for cell in row.cells)
    assert [cell.text for cell in row.cells] == ["a", "running"]


def test_resources_for_narrows_a_per_resource_block_to_its_own_resource() -> None:
    """A block `expand_sections` produced per-resource narrows to that resource.

    The section's scope is on every one of those blocks, so a compiler that resolved it
    directly rendered the whole section in each: three NSGs produced three byte-identical
    rule tables, and twenty produced twenty. `BlockContext.resources_for` narrows by the
    `_resource_id` the expander wrote.

    Exercised against `BlockContext` rather than through a definition on purpose:
    `_resource_id` is not a config field any template may declare, and
    `collect_definition_issues` rejects it as an undeclared key. It exists only between
    the expander and the compiler within one run, which is what this asserts.
    """
    view = view_of(resources=[
        sf.vm(resource_id="/vm/a", name="a"),
        sf.vm(resource_id="/vm/b", name="b"),
        sf.vm(resource_id="/vm/c", name="c"),
    ])
    context = BlockContext(
        view=view,
        ledger=FigureLedger(),
        design=DesignSettings.from_plain(df.definition([df.block("b", "resource_table", {"columns": [df.CPU_AVG]})])["design"]),
        default_scope=scope_rules_from_plain(df.scope()),
        messages=_MESSAGES,
    )

    def spec(config: dict) -> BlockSpec:
        return BlockSpec(id="b", type="resource_table", config=config, scope_override=None)

    narrowed = context.resources_for(spec({RESOURCE_ID_CONFIG_KEY: "/vm/b"}))
    assert [resource.resource_id for resource in narrowed] == ["/vm/b"]

    # Opt-in: a block carrying no `_resource_id` is unaffected. Asserted directly, because
    # a `.get` treating the absent case as falsy would silently empty every table.
    every = context.resources_for(spec({}))
    assert [resource.resource_id for resource in every] == ["/vm/a", "/vm/b", "/vm/c"]

    # A resource the scope no longer resolves yields nothing, which every compiler already
    # renders as the empty-scope notice rather than raising.
    assert context.resources_for(spec({RESOURCE_ID_CONFIG_KEY: "/vm/gone"})) == ()


def test_a_resource_name_attribute_column_does_not_duplicate_the_key_column() -> None:
    """`resource_name` as an attribute is the key column, so it emits once.

    The section catalogue declares one on five of its tables, always first — which is
    where the automatic key column already puts the name. Emitting both produced two
    columns headed "Resource", and `assert_header_row` refuses that table outright: the
    verifier reads a column's key out of its header text, so two columns sharing a header
    are two cells at one address. `virtual_machines` failed to render at all.
    """
    document = compile_document(
        df.definition(
            [df.block("vms", "resource_table", {"columns": [
                {"kind": "attribute", "attribute": "resource_name"},
                {"kind": "attribute", "attribute": "power_state"},
            ]})],
            metrics={VM: [df.CPU_AVG]},
        ),
        view=view_of(resources=[sf.vm(resource_id="/vm/a", name="a", power_state="running")]),
    )
    table = table_named(document.document, "vms")

    assert [column.key for column in table.columns] == ["resource", "power_state"]
    headers = [column.header for column in table.columns]
    assert len(headers) == len(set(headers)), headers
    assert [cell.text for cell in table.rows[0].cells] == ["a", "running"]



class TestATableWithNothingToShowSaysSo:
    """A fact table whose every declared key came back empty prints the notice, not names.

    `Reserved Instances` scopes to virtual machines on purpose — it answers "which of my
    machines does a reservation cover" — so a subscription with **no** reservations
    produced a table headed `Resource` listing CPN-App, CPN-MCP and RAAS-App. Under that
    heading a reader takes it as *these are your reserved instances*, which is the opposite
    of true, and a note underneath naming five unanswered fact keys is not what carries.
    The disk table and the network-security-group table said the same about themselves.

    The notice already existed for exactly this — `no_data_table`, "the scope matched
    resources and none of them carry a value" — and the table simply never reached for it.
    """

    @staticmethod
    def _table(columns, snapshot=None):
        view = build_snapshot_view(snapshot or sf.two_vm_snapshot())
        compiled = compile_document(
            df.definition([df.block("t", "resource_table", {"columns": columns})]),
            view=view,
        )
        return compiled.nodes_by_block["t"][0]

    def test_only_unanswered_facts_produce_the_notice(self) -> None:
        table = self._table([{"kind": "fact", "fact_key": "reservation_name"}])

        assert [c.header for c in table.columns] == ["Scope"], (
            "the table still lists its resources under a column of names"
        )
        assert len(table.rows) == 1
        assert table.rows[0].key == "no-data"

    def test_a_resolving_column_keeps_the_table(self) -> None:
        """Only where there is nothing else to show. A declared attribute or metric that
        did resolve is content, and a table carrying one has rows worth printing."""
        table = self._table(
            [
                {"kind": "fact", "fact_key": "reservation_name"},
                {"kind": "attribute", "attribute": "resource_group"},
            ]
        )

        assert [c.header for c in table.columns] != ["Scope"]
        assert len(table.rows) == 2, "both machines should still be listed"

    def test_an_answered_fact_keeps_the_table(self) -> None:
        snapshot = sf.two_vm_snapshot()
        for resource in snapshot["resources"]:
            resource["facts"] = [
                {
                    "key": "os_type",
                    "value": "Linux",
                    "value_kind": "text",
                    "source": "resource_graph",
                    "collected_at": "2026-08-31T00:00:00Z",
                    "formatted": "Linux",
                }
            ]
        table = self._table([{"kind": "fact", "fact_key": "os_type"}], snapshot)

        assert [c.header for c in table.columns] != ["Scope"]
        assert len(table.rows) == 2
