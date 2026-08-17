"""PDF fidelity (Req 33).

Two tests carry the module. The **comma-decimal locale** test is negative test 44.6 made
executable: it converts every figure the way LibreOffice under `de_DE` would and asserts the
gate catches it, because that conversion leaves the `.docx` perfect and every upstream gate
green. The **fragment** test asserts `12.4` inside `112.45` reads as *absent* — the difference
between this gate and `formatted in text`, which is the same containment mistake
`verify/anchors.py` refuses for table cells wearing a different hat.
"""

from __future__ import annotations

import hashlib
import io
from typing import Final

import pytest
from docx import Document as open_docx

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.format import NumberFormat
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.errors import PdfConversionFailedError, VerificationFailedError
from reporting_agent.verify.findings import FINDING_PDF_FIGURE_MISSING, SEVERITY_BLOCKING
from reporting_agent.verify.pdf import check_pdf, is_located, normalize

PAYLOAD: Final[bytes] = b"%PDF-1.7 pretend"
DIGEST: Final[str] = hashlib.sha256(PAYLOAD).hexdigest()


@pytest.fixture(scope="module")
def ledger():
    """A real ledger from a real compile — the strings under test are the Formatter's."""
    view = build_snapshot_view(sf.two_vm_snapshot())
    compiled = compile_document(
        df.definition([df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]})]),
        view=view,
    )
    assert len(compiled.ledger) > 0
    return compiled.ledger


def text_of(ledger, *, joiner: str = " and then ") -> str:
    return joiner.join(figure.formatted for figure in ledger.entries.values())


def run(ledger, text: str, **kwargs):
    return check_pdf(
        ledger,
        pdf_bytes=PAYLOAD,
        text=text,
        pages_read=kwargs.pop("pages_read", 3),
        expected_sha256=kwargs.pop("expected_sha256", DIGEST),
        **kwargs,
    )


# --------------------------------------------------------------------------- #
# The normalization, applied to both sides
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("  12.4%  ", "12.4%"),
        ("12.4\n%", "12.4 %"),
        ("a\t\t b", "a b"),
        ("1,234.56", "1,234.56"),
        ("", ""),
    ],
)
def test_normalization_collapses_whitespace_and_trims(raw: str, expected: str) -> None:
    """Req 33.5. A conversion splits a figure across lines and pages routinely, so both sides
    go through this or a non-breaking space makes a figure unmatchable against itself."""
    assert normalize(raw) == expected


# --------------------------------------------------------------------------- #
# Req 33.6 — located, not merely present
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("needle", "haystack", "located"),
    [
        ("12.4", "CPU averaged 12.4 across the window", True),
        ("12.4", "12.4", True),
        ("12.4", "peak 12.4", True),
        ("12.4", "12.4 peak", True),
        ("12.4", "the value 112.45 was recorded", False),
        ("12.4", "the value 12.45 was recorded", False),
        ("12.4", "the value 112.4 was recorded", False),
        ("12.4%", "the value 12.4% was recorded", True),
        ("1,234.56", "totalling 1,234.56 bytes", True),
        ("234.56", "totalling 1,234.56 bytes", False),
        ("", "anything", False),
    ],
)
def test_an_occurrence_counts_only_where_it_is_bounded(needle, haystack, located) -> None:
    """The row that matters is `12.4` inside `112.45`. A substring test calls that present,
    so the gate would report a clean pass on a conversion that dropped the figure."""
    assert is_located(needle, haystack, decimal=".", grouping=",") is located


def test_a_fragment_occurrence_does_not_hide_a_later_genuine_one() -> None:
    """Every occurrence is tried. A figure appearing first as a fragment and later on its own
    is located — stopping at the first match would fail a correct document."""
    assert is_located(
        "12.4", "first 112.45 then 12.4 alone", decimal=".", grouping=","
    )


def test_the_boundary_characters_come_from_the_number_format_and_not_from_a_literal() -> None:
    """Swapping `.` and `,` cannot show this, because both pairs are the same *set* of two
    characters. A grouping separator outside that set can: Swiss `1'234.56`.

    With the right pair the apostrophe continues the numeral, so `234.56` inside it is a
    fragment. With the default pair it does not, so the same fragment reads as located — a
    false pass on a figure the conversion actually lost.
    """
    swiss = "1'234.56"

    assert is_located(swiss, f"totalling {swiss} bytes", decimal=".", grouping="'")
    assert not is_located("234.56", f"totalling {swiss} bytes", decimal=".", grouping="'")
    assert is_located("234.56", f"totalling {swiss} bytes", decimal=".", grouping=",")


# --------------------------------------------------------------------------- #
# The gate
# --------------------------------------------------------------------------- #


def test_a_faithful_conversion_locates_every_entry(ledger) -> None:
    outcome = run(ledger, text_of(ledger))

    assert outcome.findings == ()
    assert outcome.entries_checked == len(ledger)
    assert outcome.entries_located == len(ledger)
    assert outcome.pages_read == 3
    assert outcome.pdf_sha256 == DIGEST


def test_a_comma_decimal_locale_conversion_fails_every_figure(ledger) -> None:
    """Negative test 44.6. LibreOffice under a locale whose decimal separator is `,` renders
    `1,234.56` as `1.234,56`: every numeral changes, the `.docx` is untouched, and every gate
    upstream of this one still passes."""
    swapped = text_of(ledger).translate(str.maketrans({".": ",", ",": "."}))

    outcome = run(ledger, swapped)

    assert len(outcome.findings) == outcome.entries_checked
    assert outcome.entries_located == 0
    assert all(f["type"] == FINDING_PDF_FIGURE_MISSING for f in outcome.findings)
    assert all(f["severity"] == SEVERITY_BLOCKING for f in outcome.findings)


def test_every_missing_entry_is_reported_rather_than_the_first(ledger) -> None:
    """Req 33.2 — one verification names every figure the conversion lost."""
    outcome = run(ledger, "the document converted to prose with no figures at all")

    assert len(outcome.findings) == len(ledger) > 1


def test_a_finding_names_the_path_the_string_and_the_snapshot_path(ledger) -> None:
    """Req 33.2 — enough to go from the finding to the source value without the document."""
    keep = next(iter(ledger.entries))
    others = [
        figure.formatted for path, figure in ledger.entries.items() if path != keep
    ]
    text = " and ".join(others)

    findings = run(ledger, text).findings

    dropped = [f for f in findings if f["ast_path"] == str(keep)]
    assert len(dropped) == 1
    assert dropped[0]["formatted"] == ledger[keep].formatted
    assert dropped[0]["snapshot_path"] == ledger[keep].snapshot_path


def test_an_empty_ledger_over_an_empty_pdf_is_not_a_conversion_failure(ledger) -> None:
    """Req 33.7's precondition is "while the ledger holds one or more entries". A document
    with no figures converting to no text is odd but not a proven conversion failure."""
    from reporting_agent.compile.figures import FigureLedger

    outcome = check_pdf(
        FigureLedger(),
        pdf_bytes=PAYLOAD,
        text="",
        pages_read=1,
        expected_sha256=DIGEST,
    )

    assert outcome.findings == ()
    assert outcome.entries_checked == 0
    assert ledger is not None


# --------------------------------------------------------------------------- #
# The two refusals to answer
# --------------------------------------------------------------------------- #


def test_a_pdf_with_no_extractable_text_is_a_conversion_failure_not_a_missing_figure(
    ledger,
) -> None:
    """Req 33.7. The distinction is what a reviewer does next: one says the document is
    wrong, the other says the converter is."""
    with pytest.raises(PdfConversionFailedError) as caught:
        run(ledger, "")

    assert "conversion that failed without failing" in str(caught.value)


def test_a_pdf_whose_digest_is_not_the_recorded_one_is_refused(ledger) -> None:
    """Req 33.3. Without this the gate is satisfiable by any PDF carrying the right strings —
    including one rendered from the ledger, which would check the ledger against itself."""
    with pytest.raises(VerificationFailedError) as caught:
        run(ledger, text_of(ledger), expected_sha256="0" * 64)

    assert DIGEST in str(caught.value)


def test_the_digest_is_asserted_before_the_text_is_read(ledger) -> None:
    """Order matters: the wrong file producing no text must report the wrong file, not a
    conversion failure about a file the run never produced."""
    with pytest.raises(VerificationFailedError):
        run(ledger, "", expected_sha256="0" * 64)


# --------------------------------------------------------------------------- #
# The counts
# --------------------------------------------------------------------------- #


def test_the_counts_add_up_on_a_partial_conversion(ledger) -> None:
    """Req 33.4 — checked, located, and the finding count, all consistent."""
    keep = list(ledger.entries.values())[:1]
    text = " ".join(figure.formatted for figure in keep)

    outcome = run(ledger, text)

    assert outcome.entries_checked == len(ledger)
    assert outcome.entries_located >= 1
    assert outcome.entries_located + len(outcome.findings) == outcome.entries_checked


def test_a_template_cannot_choose_its_separators_today_and_the_gate_still_follows_them(
    ledger,
) -> None:
    """The honest state of the separator parameter, pinned in both directions.

    Req 7.2's number format exposes a decimal-place count and a grouping flag and nothing
    else, so a definition carrying separator fields is rejected and `DesignSettings.from_plain`
    would not read them anyway. The gate is still parameterised on the `NumberFormat` rather
    than on two literals, and this asserts that parameter is live: hand it a format whose
    separators the Formatter never used and the boundary rule changes accordingly.

    Without the second half, the day the wizard grows a locale option this module would begin
    failing every figure of every correct report, and the failure would look like a broken
    conversion rather than a stale constant.
    """
    from reporting_agent.compile.blocks.base import DesignSettings
    from reporting_agent.compile.definition import collect_definition_issues

    raw = df.definition([df.block("res", "resource_table", {"columns": [df.CPU_AVG]})])
    raw["design"]["number_format"]["decimal_separator"] = ","
    issues = collect_definition_issues(raw, mode="run")

    assert any("decimal_separator" in issue.message for issue in issues)
    assert DesignSettings.from_plain(raw["design"]).number_format.decimal_separator == "."

    swiss = NumberFormat(decimal_places=2, group_thousands=True, grouping_separator="'")
    text = " ".join(f"9'{figure.formatted}" for figure in ledger.entries.values())

    assert run(ledger, text).entries_located == len(ledger)
    assert (
        check_pdf(
            ledger,
            pdf_bytes=PAYLOAD,
            text=text,
            pages_read=1,
            expected_sha256=DIGEST,
            number_format=swiss,
        ).entries_located
        == 0
    )


def test_the_extractor_and_the_gate_agree_on_normalization() -> None:
    """`verify/tokens.normalize_pdf_text` produces the text this gate consumes. Two
    normalizations that disagreed would fail a correct conversion on whitespace alone."""
    from reporting_agent.verify.tokens import normalize_pdf_text

    pages = ["CPU averaged\n12.4%", "and\t peaked at  88.2%"]

    assert normalize_pdf_text(pages) == normalize(" ".join(pages))
    assert open_docx is not None and io is not None
