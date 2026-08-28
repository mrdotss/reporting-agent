"""`verify/derived_counts.py`'s `historical_lookback` re-derivation, at both versions.

The function read only the top-level `blocks` list. A v3 definition has none: the
author writes `lookback` on a SECTION and `compile/sections.py` expands that section
into blocks whose ids it synthesizes, so no v3 definition can contain a block whose
id matches. Re-derivation therefore returned `None` for every v3 run, which the
module reports as a BLOCKING `derived_count_mismatch` ("could not be re-derived from
the ledger").

Observed in production: a v3 report with three VMs and a historical trend section was
withheld at verification with exactly three findings, one per expanded block —
`sec_mtcbrmo7_xus31t__1__0`, `__1__1`, `__1__2`. 518 figures compiled and every one
of them was fine; the document was refused because the verifier could not read a
number the definition plainly carried.

Unit tests of `_read_lookback_config` rather than a whole-pipeline mutation, and
deliberately so: the defect is IN this function (the earlier v3 gaps in this codebase
were at call sites, where only an end-to-end test could catch them). The
block-id-to-section mapping is the whole behaviour under test.
"""

from __future__ import annotations

from reporting_agent.verify.derived_counts import _read_lookback_config

SECTION_ID = "sec_mtcbrmo7_xus31t"


def _v3(lookback: object, *, section_id: str = SECTION_ID) -> dict[str, object]:
    """A v3 definition carrying one historical section. No `blocks` key, by design."""
    return {
        "schema_version": 3,
        "provider": "azure",
        "sections": [
            {"id": "sec_other", "type": "azure_subscription"},
            {
                "id": section_id,
                "type": "historical_vm_utilization",
                "lookback": lookback,
            },
        ],
    }


def _v2(lookback: object) -> dict[str, object]:
    return {
        "schema_version": 2,
        "blocks": [
            {"id": "res", "type": "resource_table", "config": {}},
            {
                "id": "trend",
                "type": "historical_trend",
                "config": {"lookback": lookback},
            },
        ],
    }


class TestV3:
    def test_per_resource_expanded_block_reads_its_section_lookback(self) -> None:
        # The exact id shape production emitted: <section_id>__<exp>__<ordinal>.
        for ordinal in (0, 1, 2):
            assert (
                _read_lookback_config(f"{SECTION_ID}__1__{ordinal}", _v3(6)) == 6
            ), f"ordinal {ordinal} did not resolve its section's lookback"

    def test_per_section_expanded_block_reads_it_too(self) -> None:
        # `per: "section"` expansions carry no resource ordinal.
        assert _read_lookback_config(f"{SECTION_ID}__1", _v3(24)) == 24

    def test_the_bare_section_id_resolves(self) -> None:
        assert _read_lookback_config(SECTION_ID, _v3(2)) == 2

    def test_a_block_from_a_DIFFERENT_section_does_not_borrow_the_lookback(self) -> None:
        # Prefix matching must not match a section that did not expand into this block.
        assert _read_lookback_config("sec_unrelated__1__0", _v3(6)) is None

    def test_a_section_id_that_merely_shares_a_prefix_does_not_match(self) -> None:
        # `sec_abc` must not claim `sec_abcdef__1__0`: the separator is required.
        definition = _v3(6, section_id="sec_abc")
        assert _read_lookback_config("sec_abcdef__1__0", definition) is None

    def test_a_section_with_no_lookback_is_unre_derivable(self) -> None:
        # Correct: the validator requires `lookback` for this section type, so its
        # absence is a definition defect and `None` is the honest answer.
        definition = {
            "schema_version": 3,
            "sections": [{"id": SECTION_ID, "type": "historical_vm_utilization"}],
        }
        assert _read_lookback_config(f"{SECTION_ID}__1__0", definition) is None

    def test_a_boolean_lookback_is_not_an_integer(self) -> None:
        # `isinstance(True, int)` is true in Python, so an unguarded read would
        # re-derive 1 and silently agree with a one-point trend.
        assert _read_lookback_config(f"{SECTION_ID}__1__0", _v3(True)) is None

    def test_a_non_integer_lookback_is_unre_derivable(self) -> None:
        for bad in ("6", 6.0, None, [], {}):
            assert _read_lookback_config(f"{SECTION_ID}__1__0", _v3(bad)) is None

    def test_malformed_sections_do_not_raise(self) -> None:
        for sections in ("nope", 7, [None], [{"id": 7}], [{"no_id": "x"}]):
            assert (
                _read_lookback_config(
                    f"{SECTION_ID}__1__0",
                    {"schema_version": 3, "sections": sections},
                )
                is None
            )


class TestV1V2:
    def test_an_authored_block_still_reads_its_config(self) -> None:
        assert _read_lookback_config("trend", _v2(6)) == 6

    def test_a_block_id_that_names_no_authored_block_is_unre_derivable(self) -> None:
        assert _read_lookback_config("absent", _v2(6)) is None

    def test_the_block_must_be_a_historical_trend(self) -> None:
        # `res` carries no lookback and is the wrong type; borrowing another block's
        # config would re-derive a number for a block that never declared one.
        assert _read_lookback_config("res", _v2(6)) is None

    def test_a_boolean_lookback_is_rejected_here_too(self) -> None:
        assert _read_lookback_config("trend", _v2(True)) is None

    def test_no_blocks_and_no_sections_is_unre_derivable(self) -> None:
        assert _read_lookback_config("trend", {"schema_version": 2}) is None
