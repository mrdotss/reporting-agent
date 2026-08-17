"""PDF fidelity — the gate on the file the reader actually opens (Req 33).

Everything upstream of here verifies the `.docx`. The `.pdf` is a *conversion* of it, and a
conversion is a second program with its own locale, its own font substitution and its own
field recalculation. The specific failure this exists for: LibreOffice running under a locale
whose decimal separator is `,` renders `1,234.56` as `1.234,56`. Every figure changes, the
`.docx` remains perfect, every earlier gate still passes, and the file the customer opens
carries different numbers than the file that was verified.

## Located, not merely present

An occurrence counts only where it is **bounded** at each end by the start of the text, its
end, or a character that is neither a digit, the decimal separator, nor the grouping separator
(Req 33.6). So `12.4` occurring only inside `112.45` is **absent**, not present.

The naive `formatted in text` check is wrong in the direction that matters. A report full of
percentages contains hundreds of digit strings, and a substring test finds almost any short
figure somewhere by coincidence — so the gate reports a clean pass on a conversion that
dropped the figure it was looking for. That is the same containment mistake
`verify/anchors.py` refuses for table cells, in a different disguise.

The bounding characters are the two separators the number format actually uses, read from the
`NumberFormat` the Formatter was given rather than written down again here. Req 7.2's template
number format exposes only a decimal-place count and a grouping flag today, so those
separators are always `.` and `,` in practice — but restating them as literals in the one
module whose job is detecting a separator change would be a second definition of the pair, and
the day the wizard grows a locale option this gate would begin failing every figure of every
correct report.

## The file, not a file

The checked `.pdf` is identified by asserting its SHA-256 equals the recorded `pdf_sha256`
(Req 33.3). Without that the gate is satisfiable by any PDF carrying the right strings —
including one this process could render itself from the ledger, which would be a check that
the ledger equals the ledger.

## A conversion that failed without failing

Zero extractable characters while the ledger holds at least one entry is
`PDF_CONVERSION_FAILED` (Req 33.7), not "every figure is missing". The distinction is what a
reviewer does next: one says the document is wrong, the other says the converter is. Both
downloads are withheld, and the snapshot, ledger and `.docx` are left exactly as they are.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from typing import Final

from reporting_agent.compile.figures import FigureLedger
from reporting_agent.compile.format import DEFAULT_NUMBER_FORMAT, NumberFormat
from reporting_agent.errors import PdfConversionFailedError, VerificationFailedError
from reporting_agent.verify.findings import (
    FINDING_PDF_FIGURE_MISSING,
    Finding,
    record_finding,
)

__all__ = [
    "PdfPass",
    "check_pdf",
    "is_located",
    "normalize",
]

_WHITESPACE_RUN: Final[re.Pattern[str]] = re.compile(r"\s+")


@dataclass(frozen=True, slots=True)
class PdfPass:
    """What one fidelity pass observed (Req 33.4)."""

    findings: tuple[Finding, ...]
    entries_checked: int
    entries_located: int
    pages_read: int
    pdf_sha256: str


def normalize(text: str) -> str:
    """Collapse every whitespace run to one space and trim (Req 33.5, 33.6).

    Applied to **both** sides of every comparison. A conversion routinely splits one figure
    across two text-show operators, two lines or two pages, and normalizing only the PDF would
    leave a `formatted` string carrying a non-breaking space unmatchable against its own
    rendering.
    """
    return _WHITESPACE_RUN.sub(" ", text).strip()


def is_located(needle: str, haystack: str, *, decimal: str, grouping: str) -> bool:
    """Whether `needle` occurs in `haystack` bounded at both ends (Req 33.6).

    Bounded means each end is the start of the text, its end, or a character that is neither
    a digit nor either separator. Every occurrence is tried, not only the first: `12.4` may
    appear first inside `112.45` and again on its own two pages later, and the second one is
    a located occurrence.
    """
    if not needle:
        return False
    start = haystack.find(needle)
    while start != -1:
        end = start + len(needle)
        before = haystack[start - 1] if start > 0 else ""
        after = haystack[end] if end < len(haystack) else ""
        if not _continues(before, decimal, grouping) and not _continues(
            after, decimal, grouping
        ):
            return True
        start = haystack.find(needle, start + 1)
    return False


def _continues(character: str, decimal: str, grouping: str) -> bool:
    """Whether `character` would make the adjacent match a fragment of a longer numeral."""
    if not character:
        return False
    return character.isdigit() or character in (decimal, grouping)


def check_pdf(
    ledger: FigureLedger,
    *,
    pdf_bytes: bytes,
    text: str,
    pages_read: int,
    expected_sha256: str,
    number_format: NumberFormat = DEFAULT_NUMBER_FORMAT,
) -> PdfPass:
    """Locate every ledger `formatted` string in the converted PDF's text.

    `text` and `pages_read` arrive from `verify/tokens.read_pdf_text`, already normalized —
    the extraction is the Token_Extractor's job (Req 33.5) and doing it again here would be a
    second reader of the same file that could disagree with the first.

    Raises `PDF_CONVERSION_FAILED` for a PDF from which nothing extracted while the ledger
    holds entries, and `VERIFICATION_FAILED` for a digest that is not the recorded one. Both
    are refusals to answer rather than answers: neither says the document is wrong.
    """
    digest = hashlib.sha256(pdf_bytes).hexdigest()
    if digest != expected_sha256:
        # Not a finding. A finding is a statement about the delivered document, and this
        # says the file in hand is not the delivered document.
        raise VerificationFailedError(
            f"the .pdf handed to the fidelity gate digests to {digest}, but the run "
            f"recorded {expected_sha256}; the gate checks the converted file and no other, "
            f"so that it cannot be satisfied by an independently rendered one"
        )

    entries = ledger.entries
    if not text and entries:
        raise PdfConversionFailedError(
            f"zero text characters extracted from the converted .pdf across {pages_read} "
            f"page(s) while the figure ledger holds {len(entries)} entr(ies); a PDF carrying "
            f"no extractable text is a conversion that failed without failing, not a "
            f"document missing every figure"
        )

    # From the Formatter's own format, never restated here. See the module docstring.
    decimal = number_format.decimal_separator
    grouping = number_format.grouping_separator

    findings: list[Finding] = []
    located = 0
    for path, figure in entries.items():
        if is_located(
            normalize(figure.formatted), text, decimal=decimal, grouping=grouping
        ):
            located += 1
            continue
        findings.append(
            record_finding(
                FINDING_PDF_FIGURE_MISSING,
                f"the figure {figure.formatted!r} at {path} has no located occurrence in "
                f"the converted .pdf; a conversion under a locale whose separators differ "
                f"from the Formatter's alters every numeral and no ledger string remains "
                f"locatable",
                ast_path=str(path),
                formatted=figure.formatted,
                snapshot_path=figure.snapshot_path,
            )
        )

    return PdfPass(
        findings=tuple(findings),
        entries_checked=len(entries),
        entries_located=located,
        pages_read=pages_read,
        pdf_sha256=digest,
    )
