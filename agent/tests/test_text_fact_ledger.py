"""Task 5.2 — two dictionaries, one walk, and a serialization that is additive in **bytes**.

Three claims are load-bearing here and each has a specific failure it prevents:

**The two dictionaries stay apart.** Masking stage 1 reads `formatted_values()`, which reads
`_entries` alone. If the text facts lived in that dictionary they would be masked out of the
document text as though they were numbers — and the verifier would then agree with itself about
a `Succeeded` that had become `Failed`. A *clean pass* on an unproven document is worse than a
failure, so the exclusion is structural rather than a filter at each call site.

**One walk, both kinds.** `walk_ledger_nodes` recomputes positions from `compile/ast.py`'s
`child_nodes`, and `assert_ledger_matches_tree` compares what the two factories minted against
what the finished tree says. A second walk for the text side would be the parallel structure
the whole ledger design exists to make unbuildable.

**"Additive" is a claim about bytes.** A document with no text fact must serialize to exactly
the bytes it did before the two keys existed, or every committed `ledger_sha256` moves and a
stored verification stops matching the report it proved.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Final

import pytest

import snapshot_factory as sf
from reporting_agent.compile.ast import (
    Paragraph,
    Row,
    Table,
    Text,
    TextFact,
    TextFactCell,
    compiling_against,
    figure_path,
)
from reporting_agent.compile.figures import (
    ANCHOR_TABLE,
    BlockCursor,
    FigureLedger,
    TableAnchor,
    assert_ledger_matches_tree,
    walk_figures,
    walk_ledger_nodes,
)
from reporting_agent.compile.snapshot_view import (
    FactTextValue,
    SnapshotValue,
    build_snapshot_view,
)
from reporting_agent.errors import CompileFailedError

FACT_POINTER: Final[str] = "/resources/0/facts/0/value"
SECOND_FACT_POINTER: Final[str] = "/resources/0/facts/1/value"
STAT_POINTER: Final[str] = "/resources/0/statistics/0/value"
COLLECTED_AT: Final[str] = "2026-08-01T09:30:15Z"
RESOURCE_ID: Final[str] = "/subscriptions/s/resourceGroups/rg/providers/x/vm/prod-web-01"


@dataclass
class Resolver:
    """A resolver answering on both sides, so a test can place a pointer on one and not the
    other — the case that proves a `TextFact` cannot borrow a statistic's provenance."""

    text: dict[str, tuple[str, ...]]
    numeric: dict[str, tuple[SnapshotValue, ...]]

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        return self.numeric.get(raw_pointer, ())

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        return self.text.get(raw_pointer, ())


def numeric_value(pointer: str = STAT_POINTER, value: str = "12.4") -> SnapshotValue:
    return SnapshotValue(
        value=Decimal(value),
        unit="percent",
        statistic="avg",
        estimator="exact_count_weighted",
        fidelity_tier="baseline",
        scale=1,
        metric="Percentage CPU",
        resource_id=RESOURCE_ID,
        window="2026-07-01/2026-07-31",
        pointer=pointer,
    )


def fact_value(
    *,
    key: str = "last_backup_status",
    value: str = "Succeeded",
    pointer: str = FACT_POINTER,
) -> FactTextValue:
    return FactTextValue(
        key=key,
        value=value,
        source="recovery_services",
        collected_at=COLLECTED_AT,
        pointer=pointer,
        resource_id=RESOURCE_ID,
    )


def text_fact_entry(key: str, value: str) -> Any:
    """One `FactEntry` as the snapshot carries it — the input side of `build_snapshot_view`."""
    from reporting_agent.collect.snapshot import FactEntry

    return FactEntry(
        key=key,
        value=value,
        value_kind="text",
        source="recovery_services",
        collected_at=COLLECTED_AT,
        formatted=value,
    )


def resolver(**overrides: Any) -> Resolver:
    # Both fact pointers answer with the same string, so a test placing one fact at
    # `facts:0` and another at `facts:1` does not also have to line up two values against two
    # pointers — `TextFact` re-resolves, so a mismatched fixture fails at construction with a
    # message about provenance rather than about the thing under test.
    text = {
        FACT_POINTER: ("Succeeded",),
        SECOND_FACT_POINTER: ("Succeeded",),
    }
    numeric = {STAT_POINTER: (numeric_value(),)}
    text.update(overrides.pop("text", {}))
    numeric.update(overrides.pop("numeric", {}))
    assert not overrides, overrides
    return Resolver(text=text, numeric=numeric)


def cursor(ledger: FigureLedger | None = None) -> BlockCursor:
    """A cursor at `facts:0`, over `ledger` or a fresh one.

    `is not None` and **not** `ledger or FigureLedger()`: `FigureLedger.__len__` makes an empty
    ledger falsy, so the `or` spelling silently substitutes a second ledger for the one the
    caller passed — and every assertion about the caller's ledger then reads an empty one.
    """
    return BlockCursor(
        block_id="facts", ledger=ledger if ledger is not None else FigureLedger()
    ).child("nodes", 0)


# --------------------------------------------------------------------------- #
# The factory
# --------------------------------------------------------------------------- #


def test_the_cursor_is_the_only_way_a_text_fact_reaches_the_ledger() -> None:
    """Mirrors `.figure(...)`: the entry is created during the traversal that creates the
    node, which is what makes a `build_text_fact_ledger(ast)` unwritable without deleting
    this method."""
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor(ledger).text_fact(fact_value())

    assert ledger.text_facts() == {fact.path: fact}
    assert ledger.text_facts()[fact.path] is fact
    assert str(fact.path) == "facts:0"
    assert len(ledger) == 0, "a text fact is not a figure and does not count as one"


@pytest.mark.parametrize("supplied", ["Succeeded", 12, None, {"value": "Succeeded"}])
def test_the_factory_refuses_anything_but_a_fact_read_from_the_snapshot(
    supplied: object,
) -> None:
    """A `FactTextValue` exists only as the output of `compile/snapshot_view.py`'s walk, so
    there is no way to reach this factory with a string a template supplied or a model wrote."""
    with compiling_against(resolver()), pytest.raises(
        CompileFailedError, match="minted from a FactTextValue"
    ):
        cursor().text_fact(supplied)  # type: ignore[arg-type]


def test_formatted_equals_value_character_for_character() -> None:
    """Nothing is formatted: a fact carries no unit suffix, no grouping and no estimator
    label. `TextFact.__post_init__` refuses any other relationship, so a future translation
    of a collected value fails at construction rather than in a delivered document."""
    with compiling_against(resolver(text={FACT_POINTER: ("Berhasil ",)})):
        fact = cursor().text_fact(fact_value(value="Berhasil "))
    assert fact.formatted == fact.value == "Berhasil "


def test_the_factory_counts_against_the_same_call_counter_as_the_numeric_one() -> None:
    """One counter for both kinds. Two would let one kind's second pass hide behind the
    other kind's correct total."""
    ledger = FigureLedger()
    root = BlockCursor(block_id="facts", ledger=ledger)
    with compiling_against(resolver()):
        root.child("nodes", 0).text_fact(fact_value())
        root.child("nodes", 1).figure(numeric_value())

    assert root.factory_calls == 2
    assert len(ledger.entry_paths()) == 2


# --------------------------------------------------------------------------- #
# Two dictionaries, disjoint keys
# --------------------------------------------------------------------------- #


def test_the_two_entry_dictionaries_are_disjoint_and_entry_paths_is_their_union() -> None:
    ledger = FigureLedger()
    root = BlockCursor(block_id="facts", ledger=ledger)
    with compiling_against(resolver()):
        fact = root.child("nodes", 0).text_fact(fact_value())
        figure = root.child("nodes", 1).figure(numeric_value())

    assert set(ledger.entries) & set(ledger.text_facts()) == set()
    assert ledger.entry_paths() == (figure.path, fact.path)
    assert set(ledger.entry_paths()) == {figure.path, fact.path}


def test_a_figure_and_a_text_fact_cannot_share_one_node_position() -> None:
    """One node position carries one checked value, not one of each kind — otherwise the
    verifier has two answers for one document cell."""
    ledger = FigureLedger()
    with compiling_against(resolver()):
        first = cursor(ledger)
        first.text_fact(fact_value())
        with pytest.raises(CompileFailedError, match="already holds a text fact"):
            cursor(ledger).figure(numeric_value())

    other = FigureLedger()
    with compiling_against(resolver()):
        cursor(other).figure(numeric_value())
        with pytest.raises(CompileFailedError, match="already holds a figure"):
            cursor(other).text_fact(fact_value())


def test_two_text_facts_at_one_path_are_refused() -> None:
    ledger = FigureLedger()
    with compiling_against(resolver()):
        cursor(ledger).text_fact(fact_value())
        with pytest.raises(CompileFailedError, match="two text facts resolve"):
            cursor(ledger).text_fact(fact_value(pointer=SECOND_FACT_POINTER))


def test_masking_stage_one_never_sees_a_text_fact() -> None:
    """The exclusion this whole split exists for. A text fact masked as though it were a
    number makes the verifier agree with itself about a value nobody proved — and it reports
    a **clean pass**, which is worse than a failure."""
    ledger = FigureLedger()
    root = BlockCursor(block_id="facts", ledger=ledger)
    with compiling_against(resolver()):
        root.child("nodes", 0).text_fact(fact_value())
        figure = root.child("nodes", 1).figure(numeric_value())

    assert ledger.formatted_values() == (figure.formatted,)
    assert "Succeeded" not in ledger.formatted_values()
    assert ledger.by_snapshot_path() == {STAT_POINTER: (figure.path,)}


# --------------------------------------------------------------------------- #
# Anchors
# --------------------------------------------------------------------------- #


def test_a_text_fact_anchor_is_recorded_on_its_own_mapping() -> None:
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor(ledger).text_fact(fact_value())

    anchor = TableAnchor(
        kind=ANCHOR_TABLE, anchor_id="tbl:facts:0", row_key="prod-web-01", column_key="backup"
    )
    ledger.record_text_fact_anchor(fact.path, anchor)

    assert ledger.text_fact_anchors() == {fact.path: anchor}
    assert ledger.anchors() == {}, "the figure anchors are a separate mapping"


def test_an_anchor_for_a_path_the_ledger_does_not_hold_is_refused() -> None:
    ledger = FigureLedger()
    anchor = TableAnchor(kind=ANCHOR_TABLE, anchor_id="tbl:facts:0")

    with pytest.raises(CompileFailedError, match="holds no text fact there"):
        ledger.record_text_fact_anchor(figure_path("facts", 0), anchor)

    with compiling_against(resolver()):
        figure = cursor(ledger).figure(numeric_value())
    # A figure's path is not a text fact's path, even though the ledger holds it.
    with pytest.raises(CompileFailedError, match="holds no text fact there"):
        ledger.record_text_fact_anchor(figure.path, anchor)


# --------------------------------------------------------------------------- #
# One walk, both kinds
# --------------------------------------------------------------------------- #


def cursor_at(ledger: FigureLedger, *ordinals: int) -> BlockCursor:
    """A cursor at `facts:<ordinals>` — the position a node actually occupies in the tree.

    Needed for the invariant tests: `assert_ledger_matches_tree` recomputes a path
    structurally, so a fact inside a table's first row's first cell sits at `facts:0.0.0.0`,
    and minting it at `facts:0` would fail for the right reason about the wrong thing.
    """
    found = BlockCursor(block_id="facts", ledger=ledger)
    for ordinal in ordinals:
        found = found.child("nodes", ordinal)
    return found


CELL_ORDINALS: Final[tuple[int, ...]] = (0, 0, 0, 0)
"""Where :func:`_table_with` puts its one cell's node: table 0, row 0, cell 0, fact 0."""


def _table_with(*cells: object) -> Table:
    return Table(
        path=figure_path("facts", 0),
        style="hairline",
        columns=(),
        rows=(Row(path=figure_path("facts", 0, 0), key="r", cells=tuple(cells)),),
    )


def test_walk_ledger_nodes_yields_both_kinds_and_walk_figures_filters() -> None:
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor_at(ledger, *CELL_ORDINALS).text_fact(fact_value())
        figure = cursor_at(ledger, 1, 0).figure(numeric_value())

    both = _table_with(TextFactCell(path=figure_path("facts", 0, 0, 0), fact=fact))
    assert [node for _, node in walk_ledger_nodes(both)] == [fact]
    assert [node for _, node in walk_figures(both)] == []

    paragraph = Paragraph(
        path=figure_path("facts", 1), style="Body Text", inlines=(figure,)
    )
    assert [node for _, node in walk_ledger_nodes(paragraph)] == [figure]
    assert [node for _, node in walk_figures(paragraph)] == [figure]


def test_the_closing_invariant_counts_a_text_fact_as_an_entry() -> None:
    """`assert_ledger_matches_tree` compares against `entry_paths()`, so a text fact in the
    tree and not in the ledger — or the reverse — is caught by the same assertion that has
    always caught it for a figure."""
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor_at(ledger, *CELL_ORDINALS).text_fact(fact_value())

    node = Paragraph(
        path=figure_path("facts", 0),
        style="Body Text",
        inlines=(Text(path=figure_path("facts", 0, 0), text="backup"),),
    )
    # The fact is in the ledger and nowhere in the tree.
    with pytest.raises(CompileFailedError, match="in the ledger but not in the tree"):
        assert_ledger_matches_tree({"facts": (node,)}, ledger, factory_calls=1)

    # And with the fact placed where its path says it sits, the invariant passes.
    placed = _table_with(TextFactCell(path=figure_path("facts", 0, 0, 0), fact=fact))
    assert_ledger_matches_tree({"facts": (placed,)}, ledger, factory_calls=1)


def test_a_second_pass_over_the_tree_fails_the_count_check() -> None:
    """The claim that keeps `build_text_fact_ledger` unbuildable: a walk that filled the
    ledger afterwards satisfies the key-set and identity checks and fails here."""
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor_at(ledger, *CELL_ORDINALS).text_fact(fact_value())
    placed = _table_with(TextFactCell(path=figure_path("facts", 0, 0, 0), fact=fact))

    with pytest.raises(CompileFailedError, match="two ledger factories were called"):
        assert_ledger_matches_tree({"facts": (placed,)}, ledger, factory_calls=0)


def test_the_invariant_compares_object_identity_for_a_text_fact_too() -> None:
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor_at(ledger, *CELL_ORDINALS).text_fact(fact_value())
        twin = TextFact(
            path=fact.path,
            key=fact.key,
            value=fact.value,
            snapshot_path=fact.snapshot_path,
            source=fact.source,
            collected_at=fact.collected_at,
            formatted=fact.formatted,
        )

    assert twin == fact and twin is not fact
    placed = _table_with(TextFactCell(path=figure_path("facts", 0, 0, 0), fact=twin))
    with pytest.raises(CompileFailedError, match="not the object the tree holds"):
        assert_ledger_matches_tree({"facts": (placed,)}, ledger, factory_calls=1)


# --------------------------------------------------------------------------- #
# Serialization — additive in bytes
# --------------------------------------------------------------------------- #


def test_a_ledger_with_no_text_fact_serializes_byte_identically() -> None:
    """The guard the task asks for by name. Not "the two keys are absent" but "these are the
    same bytes", because every committed `ledger_sha256` fixture is a claim about them — and
    a moved digest makes a stored verification stop matching the report it proved."""
    ledger = FigureLedger()
    with compiling_against(resolver()):
        figure = cursor(ledger).figure(numeric_value())
    ledger.record_anchor(
        figure.path, TableAnchor(kind=ANCHOR_TABLE, anchor_id="tbl:facts:0")
    )

    document = json.loads(ledger.serialize())
    assert set(document) == {"schema_version", "entries", "anchors"}
    assert "text_facts" not in document
    assert "text_fact_anchors" not in document

    # The exact bytes the pre-text-fact serializer produced, reconstructed from the same
    # canonicalizer over the same three keys.
    import rfc8785

    expected = rfc8785.dumps(
        {
            "schema_version": document["schema_version"],
            "entries": document["entries"],
            "anchors": document["anchors"],
        }
    )
    assert ledger.serialize() == expected


def test_a_text_fact_reaches_the_artifact_with_its_whole_provenance() -> None:
    ledger = FigureLedger()
    with compiling_against(resolver()):
        fact = cursor(ledger).text_fact(fact_value())
    ledger.record_text_fact_anchor(
        fact.path,
        TableAnchor(
            kind=ANCHOR_TABLE,
            anchor_id="tbl:facts:0",
            row_key="prod-web-01",
            column_key="backup",
        ),
    )

    document = json.loads(ledger.serialize())
    assert document["text_facts"] == {
        "facts:0": {
            "path": "facts:0",
            "key": "last_backup_status",
            "value": "Succeeded",
            "snapshot_path": FACT_POINTER,
            "source": "recovery_services",
            "collected_at": COLLECTED_AT,
            "formatted": "Succeeded",
        }
    }
    assert document["text_fact_anchors"] == {
        "facts:0": {
            "kind": "table",
            "anchor_id": "tbl:facts:0",
            "row_key": "prod-web-01",
            "column_key": "backup",
        }
    }


def test_the_digest_moves_when_a_text_fact_is_added_and_not_before() -> None:
    """The positive control the byte-identity test needs: without it, a `serialize` that
    ignored the text facts entirely would satisfy that assertion perfectly."""
    empty = FigureLedger()
    with compiling_against(resolver()):
        empty_figure = cursor(empty).figure(numeric_value())

    with_fact = FigureLedger()
    root = BlockCursor(block_id="facts", ledger=with_fact)
    with compiling_against(resolver()):
        root.child("nodes", 0).figure(numeric_value())
        root.child("nodes", 1).text_fact(fact_value())

    assert empty_figure.path in with_fact.entries
    assert empty.digest() != with_fact.digest()
    assert len(empty.digest()) == 64


def test_two_serializations_of_one_ledger_are_byte_identical() -> None:
    ledger = FigureLedger()
    root = BlockCursor(block_id="facts", ledger=ledger)
    with compiling_against(resolver()):
        root.child("nodes", 0).text_fact(fact_value())
        root.child("nodes", 1).text_fact(
            fact_value(key="last_restore_point", pointer=SECOND_FACT_POINTER)
        )

    assert ledger.serialize() == ledger.serialize()
    assert ledger.digest() == ledger.digest()


# --------------------------------------------------------------------------- #
# `FactTextValue` and the view that produces it
# --------------------------------------------------------------------------- #


def test_the_view_indexes_every_fact_with_its_own_provenance() -> None:
    """One index holding the whole record, not an index of bare strings beside one of
    records: a `TextFact`'s provenance and the value it re-resolves against come from the
    same lookup."""
    view = build_snapshot_view(
        sf.build(
            resources=[
                sf.vm(
                    resource_id=RESOURCE_ID,
                    name="prod-web-01",
                    facts=(
                        text_fact_entry("last_backup_status", "Succeeded"),
                        text_fact_entry("os_type", "Linux"),
                    ),
                )
            ]
        )
    )

    facts = view.facts_for(RESOURCE_ID)
    assert [fact.key for fact in facts] == ["last_backup_status", "os_type"]
    assert [fact.value for fact in facts] == ["Succeeded", "Linux"]
    assert [fact.pointer for fact in facts] == [FACT_POINTER, SECOND_FACT_POINTER]
    assert view.resolve_text_all(FACT_POINTER) == ("Succeeded",)
    assert all(fact.resource_id == RESOURCE_ID for fact in facts)
    assert view.facts_for("/subscriptions/s/nothing") == ()

    # The provenance is read **from the document**, not defaulted. A `source` the view
    # supplied rather than read would be an assertion about where a value came from, which is
    # exactly what Req 4.2 forbids one layer down — and a `TextFact` would then prove itself
    # against a claim rather than an observation.
    assert [fact.source for fact in facts] == ["recovery_services"] * 2
    assert [fact.collected_at for fact in facts] == [COLLECTED_AT] * 2


def test_a_fact_read_from_the_view_mints_a_node_that_re_resolves() -> None:
    """End to end through the **real** view: the pointer the walk minted is the pointer the
    node re-resolves against, so the two cannot disagree about which position was read."""
    document = sf.build(
        resources=[
            sf.vm(
                resource_id=RESOURCE_ID,
                name="prod-web-01",
                facts=(text_fact_entry("last_backup_status", "Succeeded"),),
            )
        ]
    )
    view = build_snapshot_view(document)
    ledger = FigureLedger()

    with compiling_against(view):
        fact = cursor(ledger).text_fact(view.facts_for(RESOURCE_ID)[0])

    assert fact.snapshot_path == FACT_POINTER
    assert fact.value == "Succeeded"
    assert ledger.text_facts()[fact.path] is fact


@pytest.mark.parametrize(
    "field_name", ["key", "value", "source", "collected_at", "resource_id"]
)
def test_a_fact_value_missing_any_field_it_proves_itself_with_is_refused(
    field_name: str,
) -> None:
    with pytest.raises(CompileFailedError, match=f"carries no {field_name}"):
        FactTextValue(
            **{
                **{
                    "key": "os_type",
                    "value": "Linux",
                    "source": "resource_graph",
                    "collected_at": COLLECTED_AT,
                    "pointer": FACT_POINTER,
                    "resource_id": RESOURCE_ID,
                },
                field_name: "",
            }
        )


def test_a_fact_pointer_must_address_the_value_field_itself() -> None:
    """A pointer naming the fact object would resolve to a mapping rather than to the string
    the document prints, and the node's own re-resolution would then find nothing."""
    with pytest.raises(CompileFailedError, match="must address its own `value` or `collected_at` field"):
        FactTextValue(
            key="os_type",
            value="Linux",
            source="resource_graph",
            collected_at=COLLECTED_AT,
            pointer="/resources/0/facts/0",
            resource_id=RESOURCE_ID,
        )
