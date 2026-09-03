"""**Property 6: A text fact's check catches what numeric masking cannot.**

Identifier: `text_fact_exact_string`

**Validates: Req 6.2, 6.4, 6.5, 6.6, 6.8, 6.10, 6.13**

## What is generated, and against what

`hypothesis` builds 1–60 text facts distributed across 1–8 data tables, with values from
three pools:

- **digit-free words** — e.g. `Succeeded`, `Failed`, `Windows Server`, `Running`
- **identifier-shaped tokens** — matching `[A-Za-z_][\\w.\\-]*[0-9][\\w.\\-]*`, e.g.
  `Standard_D4s_v3`, `aks_pool_1`, `node2_east`
- **dotted or slashed addresses** — e.g. `10.0.0.4`, `10.0.0.0/16`, `192.168.1.1/24`

The mutations are: {none, one character substituted, one character deleted, one character
inserted, the whole value replaced, the rendered text removed, the table's caption
altered}.

## Why these three pools fail differently under numeric masking

Numeric masking (`verify/masking.py`) operates in two stages:
1. Stage 1 masks formatted figure values.
2. Stage 2 masks tokens matching `[A-Za-z_][\\w.\\-]*[0-9][\\w.\\-]*` (identifiers with digits).

A **digit-free** value (`Succeeded`) carries no digit, so neither stage touches it. Under
numeric masking alone, mutating it records NOTHING — no `unmatched_prose_token`, and no
`text_fact_mismatch`. This is the reason the text-fact check exists.

An **identifier-shaped** value (`Standard_D4s_v3`) DOES carry a digit, so stage 2 masks it
as an identifier. Under numeric masking alone, a mutation would be consumed by the mask and
produce zero `unmatched_prose_token` — making it invisible. The text-fact check catches it
instead, producing `text_fact_mismatch` with zero `unmatched_prose_token`.

A **dotted/slashed address** (`10.0.0.4`) also carries digits. These have their own anchored
check and produce `text_fact_mismatch` on mutation.

## The kills

1. An implementation routing text facts through numeric masking records nothing for
   `Succeeded` → `Failed` (the token carries no digit and is never extracted).
2. One routing them through masking stage 1 as a `formatted` value masks the mutated token
   by accident and reports a clean pass.
3. One emitting text facts as plain `TextCell` content — not a ledger entry, not checked.
4. A formatter that resolves a text fact's value against the message catalog.
"""

from __future__ import annotations

import string
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Final

from hypothesis import assume, example, given
from hypothesis import strategies as st

from reporting_agent.compile.ast import (
    TextFact,
    compiling_against,
)
from reporting_agent.compile.figures import (
    ANCHOR_TABLE,
    FigureLedger,
    FigurePath,
    TableAnchor,
)
from reporting_agent.compile.format import format_text_fact
from reporting_agent.compile.snapshot_view import SnapshotValue
from reporting_agent.verify.anchors import TableGrid
from reporting_agent.verify.facts import check_text_facts
from reporting_agent.verify.findings import (
    FINDING_TEXT_FACT_ANCHOR_MISSING,
    FINDING_TEXT_FACT_MISMATCH,
    FINDING_TEXT_FACT_UNANCHORED,
    FINDING_UNMATCHED_PROSE_TOKEN,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

DIGIT_FREE_EXAMPLES: Final[tuple[str, ...]] = (
    "Succeeded",
    "Failed",
    "Running",
    "Stopped",
    "Windows Server",
    "Healthy",
    "Degraded",
    "Unknown",
    "Active",
    "Expired",
)

IDENTIFIER_EXAMPLES: Final[tuple[str, ...]] = (
    "Standard_D4s_v3",
    "Standard_E32-8s_v5",
    "aks_pool_1",
    "node2_east",
    "vm_prod_3",
    "web_tier_1a",
    "pool_worker_4x",
    "net_nic_2b",
)

ADDRESS_EXAMPLES: Final[tuple[str, ...]] = (
    "10.0.0.4",
    "10.0.0.0/16",
    "192.168.1.1",
    "172.16.0.0/12",
    "10.255.0.1/24",
    "192.168.100.50",
)


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

_DIGIT_FREE_ALPHA = string.ascii_letters + " _-"


@st.composite
def st_digit_free(draw: st.DrawFn) -> str:
    """A value carrying no digit — invisible to numeric masking."""
    use_example = draw(st.booleans())
    if use_example:
        return draw(st.sampled_from(DIGIT_FREE_EXAMPLES))
    length = draw(st.integers(min_value=1, max_value=64))
    chars = draw(
        st.lists(st.sampled_from(list(_DIGIT_FREE_ALPHA)), min_size=length, max_size=length)
    )
    value = "".join(chars).strip()
    assume(len(value) >= 1)
    assume(not any(c.isdigit() for c in value))
    return value


@st.composite
def st_identifier(draw: st.DrawFn) -> str:
    """A token matching `[A-Za-z_][\\w.\\-]*[0-9][\\w.\\-]*` — identifier with digit."""
    use_example = draw(st.booleans())
    if use_example:
        return draw(st.sampled_from(IDENTIFIER_EXAMPLES))
    prefix_char = draw(st.sampled_from(list(string.ascii_letters + "_")))
    mid_len = draw(st.integers(min_value=0, max_value=20))
    mid_chars = draw(
        st.lists(
            st.sampled_from(list(string.ascii_letters + string.digits + "_.-")),
            min_size=mid_len,
            max_size=mid_len,
        )
    )
    digit = draw(st.sampled_from(list(string.digits)))
    suffix_len = draw(st.integers(min_value=0, max_value=20))
    suffix_chars = draw(
        st.lists(
            st.sampled_from(list(string.ascii_letters + string.digits + "_.-")),
            min_size=suffix_len,
            max_size=suffix_len,
        )
    )
    value = prefix_char + "".join(mid_chars) + digit + "".join(suffix_chars)
    assume(any(c.isdigit() for c in value))
    assume(value[0] in string.ascii_letters + "_")
    return value


@st.composite
def st_address(draw: st.DrawFn) -> str:
    """A dotted or slashed address — e.g. `10.0.0.4`, `10.0.0.0/16`."""
    use_example = draw(st.booleans())
    if use_example:
        return draw(st.sampled_from(ADDRESS_EXAMPLES))
    octets = draw(
        st.lists(st.integers(min_value=0, max_value=255), min_size=4, max_size=4)
    )
    base = ".".join(str(o) for o in octets)
    add_cidr = draw(st.booleans())
    if add_cidr:
        prefix = draw(st.integers(min_value=0, max_value=32))
        return f"{base}/{prefix}"
    return base


@st.composite
def st_bare_numeral(draw: st.DrawFn) -> str:
    """A value that is nothing but digits — an NSG rule priority, a destination port.

    The fourth pool, added after a delivered run recorded twenty-one blocking
    `unmatched_prose_token` findings on a security-rules table in which every value was
    correct. The three pools above all *look* like something to the masking stages: a
    digit-free word is never extracted, an identifier is consumed by stage 2, an address by
    stage 3. A bare numeral looks exactly like a figure that is missing from the ledger,
    which is what the soundness pass reported it as.
    """
    return str(draw(st.integers(min_value=0, max_value=65535)))


@st.composite
def st_text_fact_value(draw: st.DrawFn) -> tuple[str, str]:
    """A text fact value and its pool name."""
    pool = draw(
        st.sampled_from(["digit_free", "identifier", "address", "bare_numeral"])
    )
    if pool == "digit_free":
        return draw(st_digit_free()), pool
    elif pool == "identifier":
        return draw(st_identifier()), pool
    elif pool == "bare_numeral":
        return draw(st_bare_numeral()), pool
    else:
        return draw(st_address()), pool


@st.composite
def st_mutate(draw: st.DrawFn, value: str) -> tuple[str, str]:
    """Apply a non-identity mutation to `value`, returning (mutated_value, mutation_kind).

    Always returns a value different from the input.
    """
    kind = draw(st.sampled_from([
        "substitute_char", "delete_char", "insert_char", "replace_all", "remove_rendered",
    ]))
    if kind == "substitute_char":
        assume(len(value) >= 1)
        idx = draw(st.integers(min_value=0, max_value=len(value) - 1))
        replacement = draw(
            st.sampled_from(list(string.ascii_letters + string.digits + "_.- "))
        )
        assume(replacement != value[idx])
        mutated = value[:idx] + replacement + value[idx + 1:]
        assume(mutated != value)
        return mutated, kind
    elif kind == "delete_char":
        assume(len(value) >= 2)
        idx = draw(st.integers(min_value=0, max_value=len(value) - 1))
        return value[:idx] + value[idx + 1:], kind
    elif kind == "insert_char":
        idx = draw(st.integers(min_value=0, max_value=len(value)))
        char = draw(
            st.sampled_from(list(string.ascii_letters + string.digits + "_.- "))
        )
        mutated = value[:idx] + char + value[idx:]
        assume(mutated != value)
        return mutated, kind
    elif kind == "replace_all":
        replacement = draw(
            st.text(min_size=1, max_size=64, alphabet=string.ascii_letters + " ")
        )
        assume(replacement != value)
        return replacement, kind
    else:  # remove_rendered
        return "", kind


# ---------------------------------------------------------------------------
# Resolver
# ---------------------------------------------------------------------------


@dataclass
class _TextResolver:
    """A snapshot resolver that resolves text facts by pointer."""

    _text: dict[str, str]

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        return ()

    def resolve_text_all(self, raw_pointer: str) -> tuple[str, ...]:
        if raw_pointer in self._text:
            return (self._text[raw_pointer],)
        return ()


@contextmanager
def _compile_ctx(text_map: dict[str, str]) -> Iterator[None]:
    with compiling_against(_TextResolver(text_map)):
        yield


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_path(table_idx: int, row_idx: int, col_idx: int) -> str:
    """A valid FigurePath: `tbl<table>:<row>.<col>`."""
    return f"tbl{table_idx}:{row_idx}.{col_idx}"


def _make_pointer(resource_idx: int, fact_idx: int) -> str:
    return f"/resources/{resource_idx}/facts/{fact_idx}/value"


def _build_scenario(
    facts_spec: list[tuple[str, str, int, int, int]],
    *,
    mutated_values: dict[str, str] | None = None,
    altered_table: int | None = None,
    skip_anchors: bool = False,
) -> tuple[FigureLedger, tuple[TableGrid, ...]]:
    """Build a ledger and grids from a specification.

    `facts_spec` is a list of (value, pool, table_idx, row_idx, col_idx).
    `mutated_values` maps path -> mutated cell text in the grids.
    `altered_table` changes the grid identity for that table index, making the anchor miss.
    `skip_anchors` omits all anchor records (for unanchored tests).
    """
    # Build text map for the resolver
    text_map: dict[str, str] = {}
    for i, (value, _pool, _table_idx, _row_idx, _col_idx) in enumerate(facts_spec):
        pointer = _make_pointer(i, 0)
        text_map[pointer] = value

    ledger = FigureLedger()

    with _compile_ctx(text_map):
        for i, (value, _pool, _table_idx, _row_idx, _col_idx) in enumerate(facts_spec):
            path_str = _make_path(_table_idx, _row_idx, _col_idx)
            pointer = _make_pointer(i, 0)
            fact = TextFact(
                path=FigurePath(path_str),
                key=f"fact_{i}",
                value=value,
                snapshot_path=pointer,
                source="test_source",
                collected_at="2026-08-01T09:30:15Z",
                formatted=value,
            )
            ledger.insert_text_fact(fact)

    # Group facts by table_idx
    tables: dict[int, list[tuple[int, str, str, int, int, int]]] = {}
    for i, (value, pool, table_idx, row_idx, col_idx) in enumerate(facts_spec):
        tables.setdefault(table_idx, []).append((i, value, pool, table_idx, row_idx, col_idx))

    grids: list[TableGrid] = []
    for tbl_idx in sorted(tables):
        identity = f"tbl:block{tbl_idx}:0"
        if altered_table == tbl_idx:
            identity = f"tbl:altered{tbl_idx}:0"

        tbl_facts = tables[tbl_idx]
        max_col = max(col_idx for (_, _, _, _, _, col_idx) in tbl_facts)
        headers = ("Resource", *(f"col_{c}" for c in range(max_col + 1)))

        # Group by row
        rows_map: dict[int, list[tuple[int, str, int]]] = {}
        for (global_idx, value, _pool, _, row_idx, col_idx) in tbl_facts:
            rows_map.setdefault(row_idx, []).append((global_idx, value, col_idx))

        grid_rows: list[tuple[str, ...]] = []
        for r_idx in sorted(rows_map):
            row_cells: list[str] = [f"resource_{r_idx}"]  # key column
            for c in range(max_col + 1):
                cell_value = ""
                for (_global_idx, val, cidx) in rows_map[r_idx]:
                    if cidx == c:
                        path_str = _make_path(tbl_idx, r_idx, cidx)
                        if mutated_values and path_str in mutated_values:
                            cell_value = mutated_values[path_str]
                        else:
                            cell_value = val
                        break
                row_cells.append(cell_value)
            grid_rows.append(tuple(row_cells))

        grids.append(
            TableGrid(
                identity=identity,
                ordinal=tbl_idx,
                headers=headers,
                rows=tuple(grid_rows),
            )
        )

        # Record anchors (unless skipped)
        if not skip_anchors:
            # Anchor points to the canonical identity (not the altered one)
            anchor_identity = f"tbl:block{tbl_idx}:0"
            for (_global_idx, _val, _pool, _, row_idx, col_idx) in tbl_facts:
                path_str = _make_path(tbl_idx, row_idx, col_idx)
                ledger.record_text_fact_anchor(
                    FigurePath(path_str),
                    TableAnchor(
                        kind=ANCHOR_TABLE,
                        anchor_id=anchor_identity,
                        row_key=f"resource_{row_idx}",
                        column_key=f"col_{col_idx}",
                    ),
                )

    return ledger, tuple(grids)


# ---------------------------------------------------------------------------
# Properties
# ---------------------------------------------------------------------------


@st.composite
def st_faithful_scenario(draw: st.DrawFn) -> tuple[list[tuple[str, str, int, int, int]], int]:
    """A scenario of 1-60 facts across 1-8 tables, unmutated."""
    num_tables = draw(st.integers(min_value=1, max_value=8))
    num_facts = draw(st.integers(min_value=1, max_value=60))
    facts_spec: list[tuple[str, str, int, int, int]] = []
    for i in range(num_facts):
        value, pool = draw(st_text_fact_value())
        table_idx = i % num_tables
        row_idx = i // num_tables
        col_idx = 0
        facts_spec.append((value, pool, table_idx, row_idx, col_idx))
    return facts_spec, num_facts


@given(scenario=st_faithful_scenario())
@example(scenario=([("Succeeded", "digit_free", 0, 0, 0)], 1))
@example(scenario=([("Standard_D4s_v3", "identifier", 0, 0, 0)], 1))
@example(scenario=([("10.0.0.4", "address", 0, 0, 0)], 1))
def test_unmutated_produces_zero_findings(
    scenario: tuple[list[tuple[str, str, int, int, int]], int],
) -> None:
    """Any faithfully rendered document: zero findings."""
    facts_spec, num_facts = scenario
    ledger, grids = _build_scenario(facts_spec)
    result = check_text_facts(ledger, grids)
    assert result.findings == ()
    assert result.entries_checked == num_facts
    assert result.entries_resolved == num_facts


@st.composite
def st_digit_free_mutated(draw: st.DrawFn) -> tuple[str, str]:
    """A digit-free value and its mutation."""
    value = draw(st_digit_free())
    mutated, _kind = draw(st_mutate(value))
    return value, mutated


@given(pair=st_digit_free_mutated())
@example(pair=("Succeeded", "Failed"))
@example(pair=("Running", "Stopped"))
@example(pair=("Healthy", "Degraded"))
def test_digit_free_mutation_yields_mismatch_and_zero_unmatched_prose(
    pair: tuple[str, str],
) -> None:
    """A digit-free value's mutation → `text_fact_mismatch` and ZERO `unmatched_prose_token`.

    This is the kill: numeric masking cannot catch `Succeeded` → `Failed` because the token
    carries no digit and is never extracted.
    """
    value, mutated = pair
    path_str = _make_path(0, 0, 0)
    facts_spec = [(value, "digit_free", 0, 0, 0)]
    mutated_values = {path_str: mutated}
    ledger, grids = _build_scenario(facts_spec, mutated_values=mutated_values)
    result = check_text_facts(ledger, grids)

    # Must produce text_fact_mismatch
    mismatch_findings = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_MISMATCH]
    assert len(mismatch_findings) >= 1, (
        f"expected text_fact_mismatch for {value!r} → {mutated!r}, got {result.findings}"
    )

    # Must produce ZERO unmatched_prose_token — digit-free values are invisible to masking
    prose_findings = [f for f in result.findings if f["type"] == FINDING_UNMATCHED_PROSE_TOKEN]
    assert len(prose_findings) == 0, (
        f"digit-free mutation must not produce unmatched_prose_token, got {prose_findings}"
    )


@st.composite
def st_identifier_mutated(draw: st.DrawFn) -> tuple[str, str]:
    """An identifier-shaped value and its mutation."""
    value = draw(st_identifier())
    mutated, _kind = draw(st_mutate(value))
    return value, mutated


@given(pair=st_identifier_mutated())
@example(pair=("Standard_D4s_v3", "Standard_D4s_v4"))
@example(pair=("aks_pool_1", "aks_pool_2"))
@example(pair=("node2_east", "node3_east"))
def test_identifier_mutation_yields_mismatch_and_zero_unmatched_prose(
    pair: tuple[str, str],
) -> None:
    """An identifier-shaped value's mutation → `text_fact_mismatch` AND zero `unmatched_prose_token`.

    Stage 2 of numeric masking consumes tokens matching `[A-Za-z_][\\w.\\-]*[0-9][\\w.\\-]*`,
    so a mutated identifier would be masked and invisible to the prose pass. The text-fact
    check catches it instead.
    """
    value, mutated = pair
    path_str = _make_path(0, 0, 0)
    facts_spec = [(value, "identifier", 0, 0, 0)]
    mutated_values = {path_str: mutated}
    ledger, grids = _build_scenario(facts_spec, mutated_values=mutated_values)
    result = check_text_facts(ledger, grids)

    # Must produce text_fact_mismatch
    mismatch_findings = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_MISMATCH]
    assert len(mismatch_findings) >= 1, (
        f"expected text_fact_mismatch for {value!r} → {mutated!r}, got {result.findings}"
    )

    # Must produce ZERO unmatched_prose_token — the text-fact check owns this, not masking
    prose_findings = [f for f in result.findings if f["type"] == FINDING_UNMATCHED_PROSE_TOKEN]
    assert len(prose_findings) == 0, (
        f"identifier mutation must not produce unmatched_prose_token, got {prose_findings}"
    )


@st.composite
def st_bare_numeral_mutated(draw: st.DrawFn) -> tuple[str, str]:
    """A bare numeral and its mutation."""
    value = draw(st_bare_numeral())
    mutated, _kind = draw(st_mutate(value))
    return value, mutated


@given(pair=st_bare_numeral_mutated())
@example(pair=("443", "444"))
@example(pair=("310", "320"))
@example(pair=("22", "23"))
def test_bare_numeral_mutation_yields_mismatch(
    pair: tuple[str, str],
) -> None:
    """A bare numeral's mutation → `text_fact_mismatch`.

    The property that makes it safe for `verify/masking.py` to admit a proven text fact's
    string inside its own table. The admitted string comes from the **ledger**, which comes
    from the snapshot; a document showing `444` where the ledger says `443` matches no
    admitted string, so masking hides nothing — and this check catches it regardless.
    """
    value, mutated = pair
    path_str = _make_path(0, 0, 0)
    facts_spec = [(value, "bare_numeral", 0, 0, 0)]
    mutated_values = {path_str: mutated}
    ledger, grids = _build_scenario(facts_spec, mutated_values=mutated_values)
    result = check_text_facts(ledger, grids)

    mismatch_findings = [
        f for f in result.findings if f["type"] == FINDING_TEXT_FACT_MISMATCH
    ]
    assert len(mismatch_findings) >= 1, (
        f"expected text_fact_mismatch for {value!r} → {mutated!r}, got {result.findings}"
    )


@st.composite
def st_address_mutated(draw: st.DrawFn) -> tuple[str, str]:
    """A dotted/slashed address and its mutation."""
    value = draw(st_address())
    mutated, _kind = draw(st_mutate(value))
    return value, mutated


@given(pair=st_address_mutated())
@example(pair=("10.0.0.4", "10.0.0.5"))
@example(pair=("10.0.0.0/16", "10.0.0.0/24"))
@example(pair=("192.168.1.1", "192.168.1.2"))
def test_address_mutation_yields_mismatch(
    pair: tuple[str, str],
) -> None:
    """A dotted/slashed address's mutation → `text_fact_mismatch`."""
    value, mutated = pair
    path_str = _make_path(0, 0, 0)
    facts_spec = [(value, "address", 0, 0, 0)]
    mutated_values = {path_str: mutated}
    ledger, grids = _build_scenario(facts_spec, mutated_values=mutated_values)
    result = check_text_facts(ledger, grids)

    mismatch_findings = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_MISMATCH]
    assert len(mismatch_findings) >= 1, (
        f"expected text_fact_mismatch for {value!r} → {mutated!r}, got {result.findings}"
    )


@given(value_and_pool=st_text_fact_value())
@example(value_and_pool=("Succeeded", "digit_free"))
@example(value_and_pool=("Standard_D4s_v3", "identifier"))
@example(value_and_pool=("10.0.0.4", "address"))
def test_unanchored_text_fact_yields_text_fact_unanchored(
    value_and_pool: tuple[str, str],
) -> None:
    """A TextFact with no recorded anchor → `text_fact_unanchored` (Req 6.8)."""
    value, _pool = value_and_pool
    pointer = _make_pointer(0, 0)
    text_map = {pointer: value}
    path_str = "block0:0.0"

    ledger = FigureLedger()
    with _compile_ctx(text_map):
        fact = TextFact(
            path=FigurePath(path_str),
            key="test_key",
            value=value,
            snapshot_path=pointer,
            source="test_source",
            collected_at="2026-08-01T09:30:15Z",
            formatted=value,
        )
    ledger.insert_text_fact(fact)
    # No anchor recorded

    grids: tuple[TableGrid, ...] = ()
    result = check_text_facts(ledger, grids)

    unanchored = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_UNANCHORED]
    assert len(unanchored) == 1, (
        f"expected text_fact_unanchored, got {result.findings}"
    )


@given(value_and_pool=st_text_fact_value())
@example(value_and_pool=("Succeeded", "digit_free"))
@example(value_and_pool=("Failed", "digit_free"))
@example(value_and_pool=("Standard_D4s_v3", "identifier"))
@example(value_and_pool=("10.0.0.4", "address"))
@example(value_and_pool=("Windows Server 2022", "digit_free"))
@example(value_and_pool=("10.0.0.0/16", "address"))
def test_formatted_equals_value_character_for_character(
    value_and_pool: tuple[str, str],
) -> None:
    """Req 6.13: `formatted == value` character for character — no transformation.

    The formatter (`format_text_fact`) must return its input verbatim: no case folding,
    no truncation, no separator substitution, and no resolution against the message catalog.
    """
    value, _pool = value_and_pool
    formatted = format_text_fact(value, at="property_test")
    assert formatted == value, (
        f"format_text_fact must return value verbatim: "
        f"input={value!r}, output={formatted!r}"
    )


@given(scenario=st_faithful_scenario())
@example(scenario=([("Succeeded", "digit_free", 0, 0, 0)], 1))
def test_text_fact_count_disjoint_from_figure_count(
    scenario: tuple[list[tuple[str, str, int, int, int]], int],
) -> None:
    """Req 6.15: `text_fact_count` is counted as distinct from `figure_count`.

    The ledger's two entry dictionaries share no key — the ledger's own assertion enforces
    this, and `entry_paths()` returns both kinds in one tuple.
    """
    facts_spec, num_facts = scenario
    ledger, grids = _build_scenario(facts_spec)

    # text_facts paths are separate from figure paths
    text_fact_paths = set(ledger.text_facts().keys())
    # `entries` (property) returns only figures, not text facts
    figure_paths = set(ledger.entries.keys())

    # The two sets must be disjoint
    assert text_fact_paths.isdisjoint(figure_paths), (
        f"text fact paths and figure paths must be disjoint; overlap: "
        f"{text_fact_paths & figure_paths}"
    )

    # The check resolves all
    result = check_text_facts(ledger, grids)
    assert result.entries_checked == num_facts
    assert result.entries_resolved == num_facts


@given(value_and_pool=st_text_fact_value())
@example(value_and_pool=("Succeeded", "digit_free"))
def test_alter_caption_yields_anchor_missing(
    value_and_pool: tuple[str, str],
) -> None:
    """When a table's caption (identity) is altered, the anchor resolves to nothing.

    This yields `text_fact_anchor_missing`.
    """
    value, pool = value_and_pool
    facts_spec = [(value, pool, 0, 0, 0)]
    # The anchor points to `tbl:block0:0` but the grid has `tbl:altered0:0`
    ledger, grids = _build_scenario(facts_spec, altered_table=0)
    result = check_text_facts(ledger, grids)

    anchor_missing = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_ANCHOR_MISSING]
    assert len(anchor_missing) >= 1, (
        f"expected text_fact_anchor_missing when caption is altered, got {result.findings}"
    )


@given(value_and_pool=st_text_fact_value())
@example(value_and_pool=("Succeeded", "digit_free"))
def test_layout_table_text_fact_yields_unanchored(
    value_and_pool: tuple[str, str],
) -> None:
    """A text fact emitted through the layout-table path carries no anchor (Req 6.8).

    A layout table has no `w:tblCaption`, so the renderer cannot record an anchor. The
    verifier must report `text_fact_unanchored`.
    """
    value, _pool = value_and_pool
    pointer = _make_pointer(0, 0)
    text_map = {pointer: value}
    path_str = "layout0:0.0"

    ledger = FigureLedger()
    with _compile_ctx(text_map):
        fact = TextFact(
            path=FigurePath(path_str),
            key="layout_fact",
            value=value,
            snapshot_path=pointer,
            source="test_source",
            collected_at="2026-08-01T09:30:15Z",
            formatted=value,
        )
    ledger.insert_text_fact(fact)
    # No anchor — layout table path

    # Even with a grid present, the entry has no anchor
    grids = (
        TableGrid(
            identity="tbl:layout0:0",
            ordinal=0,
            headers=("Resource", "col_0"),
            rows=(("res_0", value),),
        ),
    )
    result = check_text_facts(ledger, grids)

    unanchored = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_UNANCHORED]
    assert len(unanchored) == 1, (
        f"expected text_fact_unanchored for layout-table path, got {result.findings}"
    )


# ---------------------------------------------------------------------------
# Declared examples as standalone tests (design.md's named values)
# ---------------------------------------------------------------------------


def test_declared_example_succeeded_to_failed() -> None:
    """The design's primary declared example: `Succeeded` → `Failed`.

    This is THE kill: numeric masking records nothing because neither token carries a digit.
    """
    path_str = _make_path(0, 0, 0)
    facts_spec = [("Succeeded", "digit_free", 0, 0, 0)]
    mutated_values = {path_str: "Failed"}
    ledger, grids = _build_scenario(facts_spec, mutated_values=mutated_values)
    result = check_text_facts(ledger, grids)

    mismatch = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_MISMATCH]
    assert len(mismatch) == 1
    assert mismatch[0]["expected"] == "Succeeded"
    assert mismatch[0]["observed"] == "Failed"

    # Zero unmatched_prose_token — the WHOLE POINT
    prose = [f for f in result.findings if f["type"] == FINDING_UNMATCHED_PROSE_TOKEN]
    assert prose == []


def test_declared_example_standard_d4s_v3() -> None:
    """Identifier: `Standard_D4s_v3` — masking stage 2 would consume this."""
    path_str = _make_path(0, 0, 0)
    facts_spec = [("Standard_D4s_v3", "identifier", 0, 0, 0)]
    mutated_values = {path_str: "Standard_D4s_v4"}
    ledger, grids = _build_scenario(facts_spec, mutated_values=mutated_values)
    result = check_text_facts(ledger, grids)

    mismatch = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_MISMATCH]
    assert len(mismatch) == 1
    prose = [f for f in result.findings if f["type"] == FINDING_UNMATCHED_PROSE_TOKEN]
    assert prose == []


def test_declared_example_ip_address() -> None:
    """`10.0.0.4` — an address."""
    path_str = _make_path(0, 0, 0)
    facts_spec = [("10.0.0.4", "address", 0, 0, 0)]
    mutated_values = {path_str: "10.0.0.5"}
    ledger, grids = _build_scenario(facts_spec, mutated_values=mutated_values)
    result = check_text_facts(ledger, grids)

    mismatch = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_MISMATCH]
    assert len(mismatch) == 1


def test_declared_example_windows_server_2022() -> None:
    """`Windows Server 2022` — contains a digit but has spaces."""
    path_str = _make_path(0, 0, 0)
    facts_spec = [("Windows Server 2022", "digit_free", 0, 0, 0)]
    mutated_values = {path_str: "Windows Server 2019"}
    ledger, grids = _build_scenario(facts_spec, mutated_values=mutated_values)
    result = check_text_facts(ledger, grids)

    mismatch = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_MISMATCH]
    assert len(mismatch) == 1


def test_declared_example_cidr() -> None:
    """`10.0.0.0/16` — a CIDR address."""
    path_str = _make_path(0, 0, 0)
    facts_spec = [("10.0.0.0/16", "address", 0, 0, 0)]
    mutated_values = {path_str: "10.0.0.0/24"}
    ledger, grids = _build_scenario(facts_spec, mutated_values=mutated_values)
    result = check_text_facts(ledger, grids)

    mismatch = [f for f in result.findings if f["type"] == FINDING_TEXT_FACT_MISMATCH]
    assert len(mismatch) == 1
