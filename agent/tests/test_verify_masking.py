"""The five ordered masking stages and the derived allowlist.

The declared example that matters most here is a ledger holding both `12.4%` and
`112.4%`. Masking in insertion order lets the shorter string consume the tail of the
longer one and leaves `1` behind as a survivor — one spurious blocking finding on a
document that was correct, and the kind of defect that only appears once a fleet has
two resources whose averages happen to share a suffix. Longest-first is the fix and
:func:`test_a_shorter_ledger_string_cannot_eat_a_longer_one` is the proof.
"""

from __future__ import annotations

import re
from typing import Final

import pytest
from docx import Document

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.errors import VerificationFailedError
from reporting_agent.render.anchors import write_data_table_caption, write_layout_table
from reporting_agent.verify.allowlist import (
    derive_allowlist,
    null_context_snapshot,
    numeric_strings_in,
)
from reporting_agent.verify.masking import (
    MASK_CHAR,
    mask_paragraph,
    masking_order,
    scan_paragraphs,
    survivors_in,
)
from reporting_agent.verify.tokens import PART_BODY, ExtractedParagraph, paragraph_texts

NO_LEDGER: Final[tuple[str, ...]] = ()
NO_ALLOWLIST: Final[tuple[str, ...]] = ()


def _mask(text: str, ledger: tuple[str, ...] = NO_LEDGER, allow: tuple[str, ...] = NO_ALLOWLIST) -> str:
    return mask_paragraph(
        text, ledger_strings=masking_order(ledger), allowlist=masking_order(allow)
    )


def _survivors(text: str, ledger: tuple[str, ...] = NO_LEDGER, allow: tuple[str, ...] = NO_ALLOWLIST) -> list[str]:
    masked = _mask(text, ledger, allow)
    return [m.group() for m in re.finditer(r"\S+", masked) if re.search(r"\d", m.group())]


def _paragraph(text: str, *, block_id: str | None = None, part: str = PART_BODY) -> ExtractedParagraph:
    return ExtractedParagraph(text=text, part=part, ordinal=1, block_id=block_id)


# --- the mask character itself ----------------------------------------------------------


def test_the_mask_character_carries_no_digit_and_is_not_a_word_character() -> None:
    """Req 28.1 — a masked span must match none of the later stages' patterns."""
    assert len(MASK_CHAR) == 1
    assert not MASK_CHAR.isdigit()
    assert re.match(r"\w", MASK_CHAR) is None
    assert re.match(r"\s", MASK_CHAR) is None  # it must not split a token either


def test_masking_overwrites_rather_than_deletes_so_offsets_stay_stable() -> None:
    text = "CPU (34.2%) peak"
    masked = _mask(text, ("34.2%",))
    assert len(masked) == len(text)
    assert masked.index("peak") == text.index("peak")
    # The punctuation around the figure is untouched.
    assert masked[4] == "(" and masked[10] == ")"


# --- stage 1: the ledger, longest first ---------------------------------------------------


def test_a_shorter_ledger_string_cannot_eat_a_longer_one() -> None:
    """Req 28.2 — the declared example. Insertion order leaves `1` behind."""
    assert _survivors("Average 112.4% and 12.4%", ("12.4%", "112.4%")) == []
    # And the same ledger in the opposite insertion order behaves identically.
    assert _survivors("Average 112.4% and 12.4%", ("112.4%", "12.4%")) == []


def test_masking_order_is_longest_first_then_ascending_code_point() -> None:
    assert masking_order(["b", "aa", "a", "bb"]) == ("aa", "bb", "a", "b")


def test_masking_order_is_stable_across_input_orderings() -> None:
    forward = masking_order(["12.4%", "112.4%", "9%"])
    backward = masking_order(["9%", "112.4%", "12.4%"])
    assert forward == backward


def test_masking_order_drops_blank_strings() -> None:
    # An empty literal matches at every position and masks nothing.
    assert masking_order(["", "   ", "5%"]) == ("5%",)


def test_every_occurrence_of_a_ledger_string_is_masked() -> None:
    assert _survivors("5% then 5% then 5%", ("5%",)) == []


# --- stage 2: identifiers -----------------------------------------------------------------


@pytest.mark.parametrize(
    "identifier",
    ["prod-sql-01", "Standard_D4s_v5", "westus2", "web-01", "vm_2", "Standard_E32-8s_v5"],
)
def test_an_identifier_is_masked_whole(identifier: str) -> None:
    """Req 28.3 — a figure never begins with a letter or an underscore."""
    assert _survivors(f"resource {identifier} reported") == []


def test_a_figure_adjacent_to_an_identifier_still_survives_if_unmatched() -> None:
    # Stage 2 must not swallow a genuine measurement standing next to an identifier.
    assert _survivors("web-01 reported 47.3%") == ["47.3%"]


# --- stage 3: structured values -----------------------------------------------------------


@pytest.mark.parametrize(
    "value",
    [
        "550e8400-e29b-41d4-a716-446655440000",
        "/subscriptions/4e818b57-c747-4ce0-ac4f-bfc7912e95a4/resourceGroups/rg/providers/x/vm/web-01",
        "10.0.1.4",
        "10.0.0.0/16",
        "2001:0db8:85a3:0000:0000:8a2e:0370:7334",
        "fe80::1",
    ],
)
def test_a_structured_value_is_masked(value: str) -> None:
    assert _survivors(f"observed at {value} today") == []


def test_a_cidr_suffix_does_not_survive_its_address() -> None:
    """The IPv4-CIDR alternative precedes bare IPv4, or `/16` is left behind."""
    assert _survivors("network 10.0.0.0/16 allocated") == []


# --- stage 4: dates, timestamps, durations -------------------------------------------------


@pytest.mark.parametrize(
    "temporal",
    [
        "2026-07-01",
        "2026-07-31T17:00:00Z",
        "2026-07-01 00:00",
        "2026-07-01T00:00:00+07:00",
        "PT1H",
        "PT15M",
        "P1D",
        "PT1H30M",
        "14:35",
        "14:35:07",
    ],
)
def test_a_temporal_value_is_masked(temporal: str) -> None:
    """Req 28.5 — the grain and the window bounds are not measurements."""
    assert _survivors(f"window {temporal} applied") == []


def test_a_bare_p_is_not_treated_as_a_duration() -> None:
    # The lookahead requires a component, so a stray `P` masks nothing and a real
    # numeral beside it still survives.
    assert _survivors("P and 42%") == ["42%"]


# --- stage 5: the allowlist ----------------------------------------------------------------


def test_an_allowlisted_chrome_string_is_masked() -> None:
    assert _survivors("Top 10 by average CPU", allow=("10",)) == []


def test_allowlisting_does_not_hide_an_unrelated_numeral() -> None:
    assert _survivors("Top 10 by average CPU was 47.3%", allow=("10",)) == ["47.3%"]


# --- retained counterexamples (Req 42.8) --------------------------------------------------
#
# Both were found by Property 2 against an earlier implementation that masked a literal
# at any substring position. They are pinned here because each is a case where the
# delivery gate silently stops working, and neither is obvious from reading the code.


def test_a_short_allowlist_entry_cannot_punch_a_hole_in_an_unrelated_token() -> None:
    """Chrome legitimately yields one-character entries, and they must stay harmless.

    `page 2 of 14` puts `2` in the derived allowlist. Substring masking then removed
    that `2` from every unrelated token in the document — `1.02units` was reported as
    the mangled survivor `1.0<mask>units`.
    """
    assert _survivors("consumed 1.02units overall", allow=("2", "14")) == ["1.02units"]


def test_short_allowlist_entries_cannot_erase_an_invented_number() -> None:
    """The same defect at its worst: the gate misses what it exists to catch.

    An allowlist holding `1` and `2` masked an invented `12%` away to nothing, so the
    model's fabricated figure produced no finding at all.
    """
    assert _survivors("CPU averaged 12% last month", allow=("1", "2")) == ["12%"]


def test_a_guid_is_not_shredded_by_the_identifier_stage() -> None:
    """Stage 2 matched from the `e` of `e8400`, leaving `550` as a spurious survivor."""
    assert _survivors("correlation 550e8400-e29b-41d4-a716-446655440000 logged") == []


def test_a_figure_wrapped_in_punctuation_still_masks() -> None:
    """The bound must not be so strict that brackets block a legitimate match."""
    assert _survivors("peak (34.2%) observed", ("34.2%",)) == []
    assert _survivors('"91.0%" recorded', ("91.0%",)) == []


# --- survivors and determinism --------------------------------------------------------------


def test_a_foreign_numeral_always_survives() -> None:
    """The control the product rests on: prose the model invented."""
    assert _survivors("CPU headroom is substantial, averaging 12%", ("47.3%",)) == ["12%"]


def test_masking_is_idempotent_and_deterministic() -> None:
    text = "web-01 at 47.3% on 2026-07-01 over PT1H, id 550e8400-e29b-41d4-a716-446655440000"
    once = _mask(text, ("47.3%",))
    assert once == _mask(text, ("47.3%",))
    assert _mask(once, ("47.3%",)) == once


def test_a_legitimate_paragraph_leaves_zero_survivors() -> None:
    text = "web-01 averaged 47.3% over PT1H from 2026-07-01, peaking at 91.0%"
    assert _survivors(text, ("47.3%", "91.0%")) == []


# --- findings and their location ---------------------------------------------------------


def test_a_survivor_becomes_one_unmatched_prose_token_finding() -> None:
    findings = scan_paragraphs(
        [_paragraph("CPU averaged 12%")], ledger_strings=(), allowlist=()
    )
    assert len(findings) == 1
    assert findings[0]["type"] == "unmatched_prose_token"
    assert findings[0]["severity"] == "blocking"
    assert findings[0]["substring"] == "12%"


def test_two_survivors_in_one_paragraph_are_two_findings() -> None:
    findings = scan_paragraphs(
        [_paragraph("saw 12% and 34%")], ledger_strings=(), allowlist=()
    )
    assert [f["substring"] for f in findings] == ["12%", "34%"]


def test_a_paragraph_in_a_block_locates_by_block_id() -> None:
    findings = scan_paragraphs(
        [_paragraph("12%", block_id="tbl-7")], ledger_strings=(), allowlist=()
    )
    assert findings[0]["block_id"] == "tbl-7"
    assert "region" not in findings[0]


def test_a_paragraph_in_no_block_locates_by_region() -> None:
    findings = scan_paragraphs(
        [_paragraph("12%", part="footer")], ledger_strings=(), allowlist=()
    )
    assert findings[0]["region"] == "footer"
    assert "block_id" not in findings[0]


def test_ordinals_are_one_based_within_the_scope_the_finding_names() -> None:
    """Req 28.12 — within the block, or within the region for a blockless paragraph."""
    paragraphs = [
        ExtractedParagraph("no digits here", PART_BODY, 1, None),
        ExtractedParagraph("12%", PART_BODY, 2, None),
        ExtractedParagraph("34%", PART_BODY, 3, "tbl-1"),
        ExtractedParagraph("56%", PART_BODY, 4, "tbl-1"),
    ]
    findings = scan_paragraphs(paragraphs, ledger_strings=(), allowlist=())
    located = [(f["substring"], f.get("block_id"), f.get("region"), f["paragraph_ordinal"]) for f in findings]
    assert located == [
        ("12%", None, PART_BODY, 2),  # second paragraph of the body
        ("34%", "tbl-1", None, 1),  # first paragraph of that block
        ("56%", "tbl-1", None, 2),
    ]


def test_the_survivor_substring_comes_from_the_original_text_not_the_buffer() -> None:
    survivor = survivors_in(
        _paragraph("web-01 saw 12%"), ledger_strings=(), allowlist=(), scoped_ordinal=1
    )[0]
    assert str(survivor) == "12%"
    assert MASK_CHAR not in str(survivor)


def test_every_paragraph_is_scanned_including_nested_and_header() -> None:
    """Req 28.13 — an invented number is no less invented for being in a footer."""
    document = Document()
    layout = document.add_table(rows=1, cols=1)
    write_layout_table(layout)
    inner = layout.rows[0].cells[0].add_table(rows=1, cols=1)
    write_data_table_caption(inner, "companion")
    inner.rows[0].cells[0].paragraphs[0].add_run("11%")
    document.sections[0].footer.paragraphs[0].add_run("22%")

    findings = scan_paragraphs(paragraph_texts(document), ledger_strings=(), allowlist=())
    assert sorted(f["substring"] for f in findings) == ["11%", "22%"]


def test_an_empty_paragraph_yields_nothing() -> None:
    assert scan_paragraphs([_paragraph("")], ledger_strings=(), allowlist=()) == ()


# --- the derived allowlist ------------------------------------------------------------------


def _compilable_definition() -> dict:
    return df.definition(
        blocks=[
            df.block("cover-1", "cover"),
            df.block("h-1", "heading", {"text": "Top 10 by average CPU", "level": 1}),
            df.block("fleet", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
            df.block("gaps-1", "gaps_and_coverage"),
            df.block("appx-1", "appendix_methodology"),
        ]
    )


def test_the_null_context_snapshot_empties_data_and_keeps_the_rest() -> None:
    full = sf.two_vm_snapshot()
    null = null_context_snapshot(full)
    assert null["resources"] == [] and null["gaps"] == []
    assert null["grain"] == full["grain"]
    assert null["window"] == full["window"]
    # The original is untouched — it is the content-addressed artifact.
    assert full["resources"], "null_context_snapshot must not mutate its input"


def test_the_derived_allowlist_is_chrome_and_carries_no_measurement() -> None:
    """Req 28.11 — with no resources there is no figure, so nothing here is data."""
    allowlist = derive_allowlist(_compilable_definition(), sf.two_vm_snapshot())
    assert allowlist
    assert "10" in allowlist  # from the heading
    assert any(s.startswith("2026-07-") for s in allowlist)  # the window
    assert any("PT1H" in s for s in allowlist)  # the grain
    # Every entry carries a digit, by construction.
    assert all(re.search(r"\d", s) for s in allowlist)


def test_the_derived_allowlist_is_identical_on_two_runs() -> None:
    definition = _compilable_definition()
    snapshot = sf.two_vm_snapshot()
    assert derive_allowlist(definition, snapshot) == derive_allowlist(definition, snapshot)


def test_a_failed_null_context_render_fails_the_verification() -> None:
    """Req 28.11 — no allowlist, no prose pass, and a failure rather than a default.

    An empty allowlist is unsafe in both directions: it makes every chrome string a
    blocking survivor on a correct document, and a caller that swallowed the error
    would pass a document nothing checked.
    """
    broken = df.definition(
        blocks=[df.block("tbl-1", "resource_table", {"columns": [df.CPU_AVG]})]
    )
    broken["blocks"][0]["config"]["columns"] = "not-a-list"
    with pytest.raises(VerificationFailedError, match="null-context render"):
        derive_allowlist(broken, sf.two_vm_snapshot())


def test_a_malformed_snapshot_fails_the_derivation_rather_than_returning_nothing() -> None:
    with pytest.raises(VerificationFailedError, match="null-context render"):
        derive_allowlist(_compilable_definition(), {"snapshot_id": "only-this-field"})


def test_numeric_strings_in_admits_exactly_what_stage_five_can_mask() -> None:
    assert numeric_strings_in(["Top 10 by CPU", "no digits", "PT1H."]) == frozenset(
        {"10", "PT1H."}
    )
    assert numeric_strings_in([None, 42, "7%"]) == frozenset({"7%"})
