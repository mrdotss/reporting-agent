"""`TextFact`, `TextFactCell` and `Figure`'s prior-run fields (Req 6.2, 6.3, 17.1, 18.9).

The structural claims — that `TextFactCell.fact` is the only field admitting a `TextFact`, that
`TextFactCell` belongs to `Cell` and to nothing else, and that `TextFact` declares no numeric
field — are asserted in `tests/test_ast_guard.py`, beside the rules they extend. What this
module asserts is the **behaviour** those declarations enable: that a text fact re-resolves its
provenance against the snapshot's text side, that it cannot claim a statistic's position, and
that a figure read from a prior run cannot present as this run's own.

## Why a text fact re-resolves at all

A `TextCell` would carry the characters perfectly well. What it cannot carry is provenance, and
that gap is invisible to the verifier: a `TextCell` is prose, so the soundness pass extracts
**numeric** tokens from it and checks nothing else. `Succeeded` becoming `Failed` there is never
extracted, never compared, and ships.

Routing text facts through the numeric masking path instead is the worse of the two available
mistakes, because it reports a *clean pass* — the mutated token is masked as though it were a
`formatted` value and the verifier agrees with itself. So the mutation this module's tests are
written against is `Succeeded` → `Failed`, and the assertion is that construction refuses it.
"""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from typing import Final

import pytest

import snapshot_factory as sf
from reporting_agent.compile.ast import (
    PRIOR_RUNS_POINTER_PREFIX,
    Figure,
    FigureImmutableError,
    TextFact,
    TextFactCell,
    compiling_against,
    figure_path,
)
from reporting_agent.compile.snapshot_view import SnapshotValue
from reporting_agent.errors import CompileFailedError

FACT_POINTER: Final[str] = "/resources/0/facts/0/value"
STATISTIC_POINTER: Final[str] = "/resources/0/statistics/0/value"
PRIOR_RUN_ID: Final[str] = "run-june"
PRIOR_DIGEST: Final[str] = "a" * 64


@dataclass
class Resolver:
    """A `SnapshotResolver` answering on both sides independently.

    Both maps are supplied, which is what lets a test say "this pointer exists on the numeric
    side and not the text side" — the case that proves a `TextFact` cannot borrow a statistic's
    provenance. A real `SnapshotView` can express that too, but not the two-values case below,
    which is why the protocol exists.
    """

    text: dict[str, tuple[str, ...]]
    numeric: dict[str, tuple[SnapshotValue, ...]]

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        return self.numeric.get(raw_pointer, ())

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        return self.text.get(raw_pointer, ())


def numeric_value(pointer: str, value: str) -> SnapshotValue:
    return SnapshotValue(
        value=Decimal(value),
        unit="percent",
        statistic="avg",
        estimator="exact_count_weighted",
        fidelity_tier="baseline",
        scale=2,
        metric=sf.CPU,
        resource_id="/vm/a",
        window="2026-07-01/2026-07-02",
        pointer=pointer,
    )


def resolver(
    *,
    text: dict[str, tuple[str, ...]] | None = None,
    numeric: dict[str, tuple[SnapshotValue, ...]] | None = None,
) -> Resolver:
    return Resolver(
        text=text if text is not None else {FACT_POINTER: ("Succeeded",)},
        numeric=numeric if numeric is not None else {},
    )


def text_fact(**overrides: object) -> TextFact:
    fields: dict[str, object] = {
        "path": figure_path("record", 0),
        "key": "last_backup_status",
        "value": "Succeeded",
        "snapshot_path": FACT_POINTER,
        "source": "recovery_services",
        "collected_at": "2026-07-01T00:30:00Z",
        "formatted": "Succeeded",
    }
    fields.update(overrides)
    if "value" in overrides and "formatted" not in overrides:
        fields["formatted"] = overrides["value"]
    return TextFact(**fields)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# The provenance re-resolution (Req 17.1)
# --------------------------------------------------------------------------- #


def test_a_text_fact_whose_provenance_resolves_is_constructed() -> None:
    """Guard the guard: every refusal below would pass against a class that accepted
    nothing."""
    with compiling_against(resolver()):
        fact = text_fact()

    assert fact.value == "Succeeded"
    assert fact.formatted == "Succeeded"
    assert fact.snapshot_path == FACT_POINTER


def test_a_text_fact_cannot_be_constructed_outside_a_compile_context() -> None:
    """There is no ambient default and no "skip the check if no snapshot is bound", for the
    reason `compiling_against` gives about `Figure`: an unchecked provenance is precisely the
    claim the class exists to refuse."""
    with pytest.raises(CompileFailedError, match="only be constructed while compiling"):
        text_fact()


def test_a_snapshot_path_addressing_nothing_is_refused() -> None:
    """The provenance is fiction."""
    with compiling_against(resolver(text={})), pytest.raises(
        CompileFailedError, match="addresses no text value"
    ):
        text_fact()


def test_a_snapshot_path_addressing_two_values_is_refused() -> None:
    """The position is ambiguous, so the ledger could not say which value the
    `snapshot_path` meant. Unreachable through a real `SnapshotView`, which refuses a
    duplicate pointer at build time — which is exactly why the protocol is what
    `compile/ast.py` depends on."""
    two = resolver(text={FACT_POINTER: ("Succeeded", "Failed")})

    with compiling_against(two), pytest.raises(CompileFailedError, match="addresses 2 values"):
        text_fact()


def test_a_value_the_snapshot_does_not_hold_is_refused() -> None:
    """`Succeeded` → `Failed`: the mutation this whole node exists to catch.

    In a `TextCell` this is invisible — the token carries no digit, so the verifier never
    extracts it. Here it fails at construction, before a document exists.
    """
    with compiling_against(resolver()), pytest.raises(
        CompileFailedError, match="addresses 'Succeeded'"
    ):
        text_fact(value="Failed")


def test_a_text_fact_cannot_claim_a_statistics_position() -> None:
    """The mutual exclusion the two resolver methods buy.

    The pointer exists on the numeric side and not the text side, so a text fact naming it
    addresses nothing — which is what stops a fact from borrowing a statistic's provenance and
    presenting a measured number as collected configuration.
    """
    both = resolver(
        text={FACT_POINTER: ("Succeeded",)},
        numeric={STATISTIC_POINTER: (numeric_value(STATISTIC_POINTER, "12.48"),)},
    )

    with compiling_against(both):
        assert both.resolve_all(STATISTIC_POINTER)
        with pytest.raises(CompileFailedError, match="addresses no text value"):
            text_fact(value="12.48", snapshot_path=STATISTIC_POINTER)


def test_a_figure_cannot_claim_a_facts_position() -> None:
    """The same exclusion in the other direction, so neither node can reach the other's
    values."""
    both = resolver(
        text={FACT_POINTER: ("Succeeded",)},
        numeric={STATISTIC_POINTER: (numeric_value(STATISTIC_POINTER, "12.48"),)},
    )

    with compiling_against(both), pytest.raises(CompileFailedError, match="addresses no value"):
        Figure(
            path=figure_path("kpi", 0),
            value="12.48",
            unit="percent",
            snapshot_path=FACT_POINTER,
            formatted="12.48%",
            fidelity_tier="baseline",
            statistic="avg",
        )


# --------------------------------------------------------------------------- #
# The field-level refusals
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "field",
    ["key", "value", "snapshot_path", "source", "collected_at", "formatted"],
)
def test_every_field_must_be_non_empty(field: str) -> None:
    """A fact missing any of the six is a fact that cannot be traced, presented, or checked
    against the run's lifetime."""
    with compiling_against(resolver()), pytest.raises(CompileFailedError, match=field):
        text_fact(**{field: ""})


def test_formatted_must_equal_value_character_for_character() -> None:
    """A fact carries no unit suffix and no grouping, so the two are one string. A second
    spelling would be a second display path the verifier would have to choose between — the
    same rule `collect/snapshot.py`'s `FactEntry` enforces one layer down."""
    with compiling_against(resolver()), pytest.raises(
        CompileFailedError, match="differs from `value`"
    ):
        TextFact(
            path=figure_path("record", 0),
            key="last_backup_status",
            value="Succeeded",
            snapshot_path=FACT_POINTER,
            source="recovery_services",
            collected_at="2026-07-01T00:30:00Z",
            formatted="Succeeded ",
        )


def test_a_malformed_path_is_refused() -> None:
    with compiling_against(resolver()), pytest.raises(CompileFailedError, match="path"):
        text_fact(path="not a path")


def test_a_constructed_text_fact_is_immutable() -> None:
    """The ledger holds this same object, so an edit here would agree with the ledger and the
    verifier would find the two in perfect agreement about a value that came from nowhere —
    the one corruption in this system that is otherwise undetectable."""
    with compiling_against(resolver()):
        fact = text_fact()

    with pytest.raises(FigureImmutableError):
        fact.value = "Failed"  # type: ignore[misc]
    with pytest.raises(FigureImmutableError):
        del fact.value  # type: ignore[attr-defined]


# --------------------------------------------------------------------------- #
# TextFactCell (Req 6.3)
# --------------------------------------------------------------------------- #


def test_a_text_fact_cell_holds_a_text_fact() -> None:
    with compiling_against(resolver()):
        cell = TextFactCell(path=figure_path("record", 0, 1), fact=text_fact())

    assert isinstance(cell.fact, TextFact)


@pytest.mark.parametrize("value", ["Succeeded", 12, None, Decimal("1")])
def test_a_text_fact_cell_refuses_anything_but_a_text_fact(value: object) -> None:
    """The annotation says it statically; this says it on the paths a type checker does not
    see. A bare string reaching a fact position would skip the provenance check entirely,
    which is the whole hole the node closes."""
    with pytest.raises(CompileFailedError, match="admits a TextFact alone"):
        TextFactCell(path=figure_path("record", 0, 1), fact=value)  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Figure's prior-run fields (Req 18.9)
# --------------------------------------------------------------------------- #


def figure(**overrides: object) -> Figure:
    fields: dict[str, object] = {
        "path": figure_path("trend", 0),
        "value": "12.48",
        "unit": "percent",
        "snapshot_path": STATISTIC_POINTER,
        "formatted": "12.48%",
        "fidelity_tier": "baseline",
        "statistic": "avg",
    }
    fields.update(overrides)
    return Figure(**fields)  # type: ignore[arg-type]


def numeric_resolver(pointer: str, value: str = "12.48") -> Resolver:
    return Resolver(text={}, numeric={pointer: (numeric_value(pointer, value),)})


def test_a_figure_from_this_run_names_no_prior_run() -> None:
    """The default, and every figure compiled today. `None` for both fields."""
    with compiling_against(numeric_resolver(STATISTIC_POINTER)):
        built = figure()

    assert built.source_run_id is None
    assert built.source_snapshot_sha256 is None


def test_a_prior_run_pointer_must_name_its_run() -> None:
    """Otherwise the figure presents another run's value as this run's own."""
    pointer = f"{PRIOR_RUNS_POINTER_PREFIX}/{PRIOR_RUN_ID}{STATISTIC_POINTER}"

    with compiling_against(numeric_resolver(pointer)), pytest.raises(
        CompileFailedError, match="names no `source_run_id`"
    ):
        figure(snapshot_path=pointer)


def test_a_source_run_id_must_match_the_pointer_it_came_from() -> None:
    """Matched rather than merely required to be present, so a figure cannot carry run A's id
    beside run B's position — which would be a delta between two runs neither of which is the
    one named."""
    pointer = f"{PRIOR_RUNS_POINTER_PREFIX}/{PRIOR_RUN_ID}{STATISTIC_POINTER}"

    with compiling_against(numeric_resolver(pointer)), pytest.raises(
        CompileFailedError, match="addresses run"
    ):
        figure(
            snapshot_path=pointer,
            source_run_id="run-may",
            source_snapshot_sha256=PRIOR_DIGEST,
        )


def test_a_source_run_id_must_be_accompanied_by_a_snapshot_digest() -> None:
    """A delta between two runs means something only if both snapshots are pinned; a figure
    naming a prior run without naming which snapshot of it is a comparison against a moving
    target."""
    with compiling_against(numeric_resolver(STATISTIC_POINTER)), pytest.raises(
        CompileFailedError, match="carries no `source_snapshot_sha256`"
    ):
        figure(source_run_id=PRIOR_RUN_ID)


def test_a_well_formed_prior_run_figure_is_constructed() -> None:
    """Guard the guard for the three refusals above."""
    pointer = f"{PRIOR_RUNS_POINTER_PREFIX}/{PRIOR_RUN_ID}{STATISTIC_POINTER}"

    with compiling_against(numeric_resolver(pointer)):
        built = figure(
            snapshot_path=pointer,
            source_run_id=PRIOR_RUN_ID,
            source_snapshot_sha256=PRIOR_DIGEST,
        )

    assert built.source_run_id == PRIOR_RUN_ID
    assert built.source_snapshot_sha256 == PRIOR_DIGEST


# --------------------------------------------------------------------------- #
# Through the real view, over a real snapshot
# --------------------------------------------------------------------------- #
#
# Everything above uses a hand-built `Resolver`, which is what lets the two-values case exist
# at all. But a fake resolver proves nothing about the **indexing**: it answers whatever the
# test put in it, so a `build_snapshot_view` that indexed a fact on the numeric side, or not at
# all, would leave every assertion above green.
#
# These close the loop end to end — `FactEntry` -> `build_snapshot` -> `build_snapshot_view` ->
# `TextFact` — so the pointer a fact is addressed by is the pointer the walk actually produced
# rather than one a test invented.


def snapshot_with_facts(*entries: object) -> dict[str, object]:
    from reporting_agent.collect.snapshot import FactEntry

    del FactEntry
    return sf.build(
        resources=[
            sf.vm(
                resource_id="/vm/a",
                name="prod-web-01",
                facts=tuple(entries),  # type: ignore[arg-type]
            )
        ]
    )


def one_fact(key: str = "last_backup_status", value: str = "Succeeded") -> object:
    from reporting_agent.collect.snapshot import FactEntry

    return FactEntry(
        key=key,
        value=value,
        value_kind="text",
        source="recovery_services",
        collected_at="2026-07-01T00:30:00Z",
        formatted=value,
    )


def test_the_real_view_addresses_a_fact_on_the_text_side_only() -> None:
    """The indexing, asserted through the walk that produces it.

    Both directions: the fact's pointer resolves on the text side and **not** on the numeric
    one. Without the second half, a walk that indexed facts into `_by_pointer` would satisfy
    the first.
    """
    from reporting_agent.compile.snapshot_view import build_snapshot_view

    view = build_snapshot_view(snapshot_with_facts(one_fact()))

    assert view.resolve_text_all(FACT_POINTER) == ("Succeeded",)
    assert view.resolve_all(FACT_POINTER) == ()


def test_the_real_view_addresses_a_statistic_on_the_numeric_side_only() -> None:
    """The mirror, so neither index has quietly become the other."""
    from reporting_agent.compile.snapshot_view import build_snapshot_view

    view = build_snapshot_view(snapshot_with_facts(one_fact()))

    assert view.resolve_all(STATISTIC_POINTER)
    assert view.resolve_text_all(STATISTIC_POINTER) == ()


def test_a_text_fact_resolves_against_the_real_view() -> None:
    """The loop closed: the value `collect/snapshot.py` wrote is the value `compile/ast.py`
    re-resolves, at the pointer the walk assigned it."""
    from reporting_agent.compile.snapshot_view import build_snapshot_view

    view = build_snapshot_view(snapshot_with_facts(one_fact()))

    with compiling_against(view):
        fact = text_fact()

    assert fact.value == "Succeeded"


def test_the_mutated_value_is_refused_against_the_real_view() -> None:
    """`Succeeded` → `Failed` again, this time against the snapshot the collector actually
    produced rather than a fake that was told the answer."""
    from reporting_agent.compile.snapshot_view import build_snapshot_view

    view = build_snapshot_view(snapshot_with_facts(one_fact()))

    with compiling_against(view), pytest.raises(
        CompileFailedError, match="addresses 'Succeeded'"
    ):
        text_fact(value="Failed")


def test_the_view_addresses_each_fact_at_its_own_ordinal() -> None:
    """Two facts on one resource get two pointers, ordered by key — so a `snapshot_path`
    naming ordinal 1 addresses the second key in sorted order and not whichever arrived
    second."""
    from reporting_agent.compile.snapshot_view import build_snapshot_view

    view = build_snapshot_view(
        snapshot_with_facts(
            one_fact(key="os_type", value="Windows"),
            one_fact(key="last_backup_status", value="Succeeded"),
        )
    )

    # `last_backup_status` sorts before `os_type`, so it takes ordinal 0 whatever order the
    # entries were supplied in.
    assert view.resolve_text_all("/resources/0/facts/0/value") == ("Succeeded",)
    assert view.resolve_text_all("/resources/0/facts/1/value") == ("Windows",)


def test_a_resource_with_no_facts_addresses_no_text_value() -> None:
    """The empty array is emitted always, so this is a real pointer space with nothing in
    it rather than a missing key."""
    from reporting_agent.compile.snapshot_view import build_snapshot_view

    view = build_snapshot_view(snapshot_with_facts())

    assert view.resolve_text_all(FACT_POINTER) == ()


def test_the_view_refuses_a_fact_whose_value_is_not_a_string() -> None:
    """A fact's value is always a string, including a numeric fact's (Req 4.6). A view that
    accepted a JSON number here would hand `TextFact` something whose `!=` against a `str`
    is always true, and every text fact in the document would fail its own provenance check
    for the wrong reason."""
    from reporting_agent.compile.snapshot_view import build_snapshot_view

    document = snapshot_with_facts(one_fact())
    document["resources"][0]["facts"][0]["value"] = 4  # type: ignore[index]

    with pytest.raises(CompileFailedError, match="not a non-empty string"):
        build_snapshot_view(document)
