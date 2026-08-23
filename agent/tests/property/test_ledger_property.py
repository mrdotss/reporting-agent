"""Property 6: The ledger and the document AST agree in both directions.

**Validates: Requirements 17.1, 17.3, 17.7, 15.2, 15.4, 15.7, 15.10, 15.11, 16.1, 29.2,
29.6, 3.7, 45.1**

*For any* template definition and snapshot pair, the ledger records exactly one entry per
figure node of the compiled AST keyed by that node's path and no entry addressing a node the
tree does not hold; two compilations over one pair produce an identical AST and an identical
ledger with identical `formatted` values; every ledger entry appears in the rendered
document; a block whose scope resolved to zero resources is present in the tree carrying the
explicit row and zero figures; and no numeric value exists anywhere in the tree outside a
`Figure`.

**On the "AST digest".** The design states 6.3 in terms of one, and there is no AST digest
function in this codebase — deliberately, because nothing needs one: the ledger's digest is
what gets recorded and re-verified. So 6.3 is asserted as **structural equality** of the two
compiled trees. Every AST node is a frozen dataclass, so `==` compares field by field to the
leaves, which is the same claim a digest would make and strictly stronger: two trees that
differ produce a readable diff rather than two unequal hexadecimal strings.

**On scale.** The requirement names 1–200 blocks and 0–300 resources. Compiling is cheap;
*rendering* is not, and 6.4 needs a real render. So the compile-only properties run over
1–10 drawn blocks with a **declared example at 60 blocks**, and 6.4 runs over the same drawn
space without charts, whose matplotlib draw dominates everything else in this module.
"""

from __future__ import annotations

import dataclasses
import io
from decimal import Decimal
from typing import Any, Final

from docx import Document as open_docx
from hypothesis import example, given
from hypothesis import strategies as st

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.ast import Figure, child_nodes
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT, DesignSettings
from reporting_agent.compile.figures import walk_figures
from reporting_agent.compile.messages import load_messages
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render.docx import render_document
import messages_factory as mf

_MESSAGES = load_messages("en")
from reporting_agent.verify.anchors import check_tables, read_grids
from reporting_agent.verify.findings import FINDING_LEDGER_ENTRY_UNRENDERED

CPU: Final[str] = sf.CPU

EMPTY_SCOPE_TEXT_RESOLVED: Final[str] = load_messages("en").text(EMPTY_SCOPE_TEXT)
"""`EMPTY_SCOPE_TEXT` is a catalog string **id**, and the AST carries the **resolved**
string — that is the whole point of resolving at compile time. So a document assertion
compares against the resolved message, never against the id."""

# The block types a definition can carry here. `comparison_delta` needs two completed runs
# and a `ComparisonSource`, which is a pipeline concern rather than a compile one; `cover`
# is drawn separately because it exists only where `design.cover_page` is true. Everything
# else in the sixteen is represented.
BLOCK_CATALOGUE: Final[tuple[tuple[str, dict[str, Any]], ...]] = (
    ("resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
    ("top_n_table", {"columns": [df.CPU_AVG], "order_by": df.CPU_AVG}),
    ("kpi_row", {"metrics": [df.CPU_AVG]}),
    (
        "capacity_vs_usage",
        {"capacity_metric": {"sku_capability": "vCPUsAvailable"}, "usage_metric": df.CPU_AVG},
    ),
    ("timeseries_chart", {"metrics": [df.CPU_AVG]}),
    ("distribution_chart", {"metrics": [df.CPU_AVG]}),
    ("gaps_and_coverage", {}),
    ("verification_record", {}),
    ("appendix_methodology", {}),
    ("executive_summary", {}),
    ("heading", {"level": 2, "text": "Utilization"}),
    ("rich_text", {"text": "Every figure below traces to the snapshot."}),
    ("page_break", {}),
)

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
"""What a `row` column can hold. The deferring blocks and `page_break` are refused inside a
row by the compiler and the renderer respectively; see `test_anchors_property.py`, which
documents that divergence between the validators and the later stages."""

CHARTLESS: Final[frozenset[str]] = frozenset({"timeseries_chart", "distribution_chart"})


def design_of(*, cover: bool, decimals: int, grouping: bool, table_style: str) -> dict:
    return {
        "preset": "editorial",
        "accent_color": "#1f6f78",
        "density": "normal",
        "table_style": table_style,
        "number_format": {"decimal_places": decimals, "group_thousands": grouping},
        "cover_page": cover,
        "logo": None,
        "page_size": "A4",
    }


@st.composite
def snapshots(draw: st.DrawFn) -> dict:
    """0–12 VMs with distinct statistics, percentiles carrying estimators, and gaps.

    Zero resources is drawn on purpose: it is the case where every block's scope matches
    nothing, which 6.5 is about.
    """
    count = draw(st.integers(min_value=0, max_value=12))
    resources = [
        sf.vm(
            resource_id=f"/vm/{index:03d}",
            name=f"vm-{index:03d}",
            cpu_avg=f"{(index % 80) + 5}.{index % 100:02d}",
            cpu_max=f"{(index % 15) + 80}.00",
            cpu_p95=f"{(index % 30) + 60}.50" if draw(st.booleans()) else None,
            memory_pct=f"{(index % 40) + 30}.10" if draw(st.booleans()) else None,
        )
        for index in range(count)
    ]
    return sf.build(resources=resources)


@st.composite
def definitions(draw: st.DrawFn, *, charts: bool = True) -> dict:
    catalogue = [
        entry
        for entry in BLOCK_CATALOGUE
        if charts or entry[0] not in CHARTLESS
    ]
    chosen = draw(
        st.lists(st.sampled_from(catalogue), min_size=1, max_size=10, unique_by=str)
    )
    blocks: list[dict[str, Any]] = []
    for index, (block_type, config) in enumerate(chosen):
        override = None
        if draw(st.booleans()) and draw(st.booleans()):
            # A scope that matches nothing — Req 3.7's case, drawn rather than hoped for.
            override = df.scope(resource_groups=["rg-matches-nothing"])
        blocks.append(df.block(f"b{index}", block_type, dict(config), scope_override=override))

    nestable = [block for block in blocks if str(block["type"]) in ROW_SAFE]
    if len(nestable) >= 2 and draw(st.booleans()):
        rest = [block for block in blocks if block not in nestable]
        blocks = [
            {"id": "row0", "type": "row", "columns": [[nestable[0]], nestable[1:]]},
            *rest,
        ]

    design = design_of(
        cover=draw(st.booleans()),
        decimals=draw(st.integers(min_value=0, max_value=3)),
        grouping=draw(st.booleans()),
        table_style=draw(st.sampled_from(("hairline", "banded", "bordered"))),
    )
    if design["cover_page"]:
        blocks.insert(0, df.block("cover", "cover", {}))
    return df.definition(blocks, design=design)


@st.composite
def pairs(draw: st.DrawFn, *, charts: bool = True) -> tuple[dict, dict]:
    return draw(definitions(charts=charts)), draw(snapshots())


def compile_pair(pair: tuple[dict, dict]):
    definition, snapshot = pair
    return compile_document(definition, view=build_snapshot_view(snapshot))


MANY_BLOCKS: Final[dict] = df.definition(
    [
        df.block(f"b{index}", "resource_table", {"columns": [df.CPU_AVG]})
        for index in range(60)
    ],
    design=design_of(cover=False, decimals=2, grouping=True, table_style="hairline"),
)


# --------------------------------------------------------------------------- #
# 6.1, 6.2 — one entry per figure node, keyed by path
# --------------------------------------------------------------------------- #


@given(pairs())
@example((MANY_BLOCKS, sf.two_vm_snapshot()))
def test_one_ledger_entry_per_figure_node_keyed_by_path(pair) -> None:
    """6.1 and 6.2. `compile()` already asserts this internally through
    `assert_ledger_matches_tree`, and asserting it again here is not redundant: this walks
    the *finished* tree independently, so a change that weakened the internal invariant
    would still be caught.
    """
    compiled = compile_pair(pair)

    from_tree = {
        str(figure.path)
        for nodes in compiled.nodes_by_block.values()
        for node in nodes
        for _, figure in walk_figures(node)
    }
    from_ledger = {str(path) for path in compiled.ledger.paths()}

    assert from_tree == from_ledger
    assert len(from_ledger) == len(compiled.ledger) == compiled.figure_count


@given(pairs())
def test_the_ledger_holds_the_objects_the_tree_holds(pair) -> None:
    """Req 17.1 — the ledger's values *are* the AST's figures, by identity.

    Identity rather than equality, because equality is what a *copy* would satisfy. Two
    structures that merely agree today can disagree tomorrow; one structure cannot.
    """
    compiled = compile_pair(pair)

    for nodes in compiled.nodes_by_block.values():
        for node in nodes:
            for _, figure in walk_figures(node):
                assert compiled.ledger[figure.path] is figure


# --------------------------------------------------------------------------- #
# 6.3 — two compilations agree, exactly
# --------------------------------------------------------------------------- #


@given(pairs())
@example((MANY_BLOCKS, sf.two_vm_snapshot()))
def test_two_compilations_of_one_pair_produce_one_tree_and_one_ledger(pair) -> None:
    """6.3. A compiler deriving a path from emission order, or walking a hash-ordered
    container, passes every other assertion here and fails this one."""
    first = compile_pair(pair)
    second = compile_pair(pair)

    assert first.document == second.document
    assert first.ledger.digest() == second.ledger.digest()
    assert [f.formatted for f in first.ledger.entries.values()] == [
        f.formatted for f in second.ledger.entries.values()
    ]
    assert list(first.ledger.paths()) == list(second.ledger.paths())


# --------------------------------------------------------------------------- #
# 6.5 — an empty-scope block is present, with its row and no figures
# --------------------------------------------------------------------------- #


@given(pairs())
@example(
    (
        df.definition(
            [
                df.block(
                    "narrow",
                    "resource_table",
                    {"columns": [df.CPU_AVG]},
                    scope_override=df.scope(resource_groups=["rg-matches-nothing"]),
                ),
                df.block(
                    "narrow2",
                    "kpi_row",
                    {"metrics": [df.CPU_AVG]},
                    scope_override=df.scope(resource_groups=["rg-matches-nothing"]),
                ),
            ],
            design=design_of(cover=False, decimals=2, grouping=True, table_style="hairline"),
        ),
        sf.build(resources=[sf.vm(resource_id="/vm/only", name="only")]),
    )
)
def test_every_block_is_present_even_where_its_scope_matched_nothing(pair) -> None:
    """6.5, and the declared example is Req 3.7's named case: every block's scope matches
    nothing while the union matches one resource.

    A block that vanished would be indistinguishable in the delivered document from one that
    was never configured, and a reader could not tell an empty result from a missing section.
    """
    definition, _ = pair
    compiled = compile_pair(pair)

    declared = {
        str(block["id"])
        for block in definition["blocks"]
        if block["type"] != "cover" or definition["design"]["cover_page"]
    }
    for block in definition["blocks"]:
        if block["type"] == "row":
            declared.discard(str(block["id"]))
            declared.update(
                str(child["id"]) for column in block["columns"] for child in column
            )
            declared.add(str(block["id"]))

    assert declared <= set(compiled.nodes_by_block)


def test_an_empty_scope_block_carries_the_explicit_row_and_zero_figures() -> None:
    """The other half of 6.5, asserted on the emitted text rather than on the node count."""
    pair = (
        df.definition(
            [
                df.block(
                    "narrow",
                    "resource_table",
                    {"columns": [df.CPU_AVG]},
                    scope_override=df.scope(resource_groups=["rg-matches-nothing"]),
                )
            ],
            design=design_of(cover=False, decimals=2, grouping=True, table_style="hairline"),
        ),
        sf.build(resources=[sf.vm(resource_id="/vm/only", name="only")]),
    )
    compiled = compile_pair(pair)

    assert compiled.figure_count == 0
    assert EMPTY_SCOPE_TEXT_RESOLVED in _all_text(compiled.document)


def _all_text(node: object) -> str:
    pieces: list[str] = []
    stack = [node]
    while stack:
        current = stack.pop()
        text = getattr(current, "text", None)
        if isinstance(text, str):
            pieces.append(text)
        stack.extend(child_nodes(current))
    return "\n".join(pieces)


# --------------------------------------------------------------------------- #
# 6.6 — no numeric value anywhere outside a Figure
# --------------------------------------------------------------------------- #


NUMERIC_TYPES: Final[tuple[type, ...]] = (int, float, Decimal, complex)


@given(pairs())
@example((MANY_BLOCKS, sf.two_vm_snapshot()))
def test_no_numeric_value_exists_in_the_tree_outside_a_figure(pair) -> None:
    """6.6, at run time. The static guard in `compile/ast.py` asserts it over every future
    node *type*; this asserts it over the values one compilation actually produced, which is
    the half a `object`-typed field would slip past.

    `bool` is excluded — it is an `int` in Python and a flag is not a quantity — and so is a
    field named for a position or a count on a structural node, enumerated below rather than
    inferred, so the rule stays about quantities.
    """
    compiled = compile_pair(pair)
    offenders = list(_numeric_offenders(compiled.document))

    assert offenders == [], offenders


STRUCTURAL_NUMERIC_FIELDS: Final[frozenset[str]] = frozenset({"level", "columns", "span"})
"""Fields whose integer is a position or a count, never a measurement.

Enumerated rather than inferred from the value: a heading's `level` and a layout column's
count are structure, and treating "is an int" as "is a quantity" would make the rule about
Python types rather than about the product's invariant."""


def _numeric_offenders(node: object, path: str = "$"):
    if isinstance(node, Figure):
        return
    if dataclasses.is_dataclass(node) and not isinstance(node, type):
        for field in dataclasses.fields(node):
            value = getattr(node, field.name)
            if field.name in STRUCTURAL_NUMERIC_FIELDS:
                continue
            if isinstance(value, bool):
                continue
            if isinstance(value, NUMERIC_TYPES):
                yield f"{path}.{field.name} = {value!r} ({type(value).__name__})"
    for ordinal, child in enumerate(child_nodes(node)):
        yield from _numeric_offenders(child, f"{path}[{ordinal}]")


# --------------------------------------------------------------------------- #
# 6.4 — every ledger entry appears in the emitted document
# --------------------------------------------------------------------------- #


@given(pairs(charts=False))
def test_every_ledger_entry_appears_in_the_rendered_document(pair) -> None:
    """6.4. Charts are excluded from this one property only: rendering one draws a real PNG
    through matplotlib, which dominates every other cost in this module, and the chart path
    is covered by Property 3 and `tests/test_verify_charts.py`.

    Asserted through the anchored pass rather than by searching the document for strings —
    which is the whole point of requirement 27, applied to itself.
    """
    definition, _ = pair
    compiled = compile_pair(pair)
    outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(definition["design"]),
        messages=mf.EN,
    )
    grids = read_grids(open_docx(io.BytesIO(outcome.docx_bytes)))

    result = check_tables(compiled.ledger, grids)

    assert result.findings == ()
    assert len(result.matched) == result.anchors_checked
    assert FINDING_LEDGER_ENTRY_UNRENDERED not in {f["type"] for f in result.findings}


# --------------------------------------------------------------------------- #
# Every snapshot_path resolves to the value the figure carries
# --------------------------------------------------------------------------- #


@given(pairs())
def test_every_snapshot_path_resolves_to_exactly_one_matching_value(pair) -> None:
    """The provenance claim, checked rather than assumed.

    `Figure` re-resolves its own pointer at construction, so this cannot currently fail —
    which is the point: it asserts that the guarantee is *structural* rather than a
    convention, and it would go red the moment a figure could be constructed some other way.
    """
    _, snapshot = pair
    compiled = compile_pair(pair)
    view = build_snapshot_view(snapshot)

    for figure in compiled.ledger.entries.values():
        resolved = view.resolve_all(figure.snapshot_path)
        assert len(resolved) == 1, figure.snapshot_path
        assert f"{resolved[0].value:f}" == str(figure.value)


# --------------------------------------------------------------------------- #
# Guard the guards
# --------------------------------------------------------------------------- #


def test_the_generated_space_produces_figures() -> None:
    """Non-vacuity for every property above. `snapshots()` legitimately draws zero
    resources, and a run that happened to draw only those would report eight green
    properties over eight empty ledgers.
    """
    populated = sf.two_vm_snapshot()
    for block_type, config in BLOCK_CATALOGUE:
        definition = df.definition(
            [df.block("b0", block_type, dict(config))],
            design=design_of(
                cover=False, decimals=2, grouping=True, table_style="hairline"
            ),
        )
        compiled = compile_pair((definition, populated))
        assert compiled.figure_count >= 0
        if block_type in {"resource_table", "kpi_row", "top_n_table"}:
            assert compiled.figure_count > 0, block_type


def test_the_numeric_walk_finds_a_planted_quantity() -> None:
    """A walk that returned nothing would satisfy 6.6 on any tree at all.

    The planted node is a dataclass carrying a `Decimal` outside a `Figure` — exactly the
    shape the invariant forbids and the one an `object`-typed field would let through.
    """

    @dataclasses.dataclass(frozen=True)
    class Smuggler:
        path: str
        amount: Decimal

    offenders = list(_numeric_offenders(Smuggler(path="x:0", amount=Decimal("12.4"))))

    assert len(offenders) == 1
    assert "amount" in offenders[0]


def test_the_numeric_walk_permits_a_figure_and_a_structural_int() -> None:
    """The two exclusions, asserted rather than asserted-about. A rule that flagged a
    heading's level would be a rule about Python types rather than about quantities."""

    @dataclasses.dataclass(frozen=True)
    class Heading:
        path: str
        level: int

    assert list(_numeric_offenders(Heading(path="h:0", level=2))) == []

    compiled = compile_pair(
        (
            df.definition(
                [df.block("b0", "resource_table", {"columns": [df.CPU_AVG]})],
                design=design_of(
                    cover=False, decimals=2, grouping=True, table_style="hairline"
                ),
            ),
            sf.two_vm_snapshot(),
        )
    )
    assert compiled.figure_count > 0
    assert list(_numeric_offenders(compiled.document)) == []
