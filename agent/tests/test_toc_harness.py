"""`pdf_page_texts`, the committed TOC fixture's geometry, and the measurement harness
(Req 14.2, 14.11).

## What this module is responsible for, and what it is not

Task 2.4 adds `test_toc_proof.py`, which reads `ADOPTED_APPROACH` and asserts the adopted
candidate's page numbers are right. This module is the layer beneath that: it asserts the
**instrument** works and the **fixture** has the geometry the proof will need. Splitting them
matters because a proof test over a one-page fixture would pass trivially — every heading
would be on page 1 and "named equals observed" would hold for a document that proves
nothing about pagination.

So the assertions here are about the measurement being able to fail:

* `pdf_page_texts` separates pages rather than joining them, and preserves a blank page's
  index — otherwise every page number after a blank one would be off by one.
* the fixture renders to **at least 8 pages** with **at least 6 headings** on **at least 4
  distinct pages**, so a table of contents over it has something to get wrong.
* `measure` refuses an approach it cannot render, rather than measuring `none` and letting a
  verdict be recorded for a candidate that was never exercised.

## The slow test, and why it is not stubbed

One `measure` call spawns LibreOffice and takes seconds. It is module-scoped and shared, and
it is not faked, because pagination is decided by the converter: a measurement over a stubbed
conversion would be measuring an assumption about the thing under test.
"""

from __future__ import annotations

import asyncio
import shutil
from pathlib import Path
from typing import Final

import pytest
from pypdf import PdfWriter

import toc_harness as H
from reporting_agent.errors import ErrorCode, VerificationFailedError
from reporting_agent.render import pdf as P
from reporting_agent.render.toc import (
    TOC_APPROACH_CONVERSION_MACRO,
    TOC_APPROACH_LIBREOFFICE_INDEX,
    TOC_APPROACH_NONE,
    TOC_APPROACH_TWO_PASS,
)
from reporting_agent.verify.tokens import pdf_page_texts, read_pdf_text

SOFFICE: Final[str | None] = shutil.which("soffice")

MIN_PAGES: Final[int] = 8
MIN_HEADINGS: Final[int] = 6
MIN_DISTINCT_HEADING_PAGES: Final[int] = 4


@pytest.fixture(autouse=True)
def _required_lang(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test runs with the locale the converter requires.

    Autouse for the reason `tests/test_pdf.py` gives for its own copy: the alternative is
    every test remembering to set it, and one that forgot would fail on the `LANG` assertion
    for a reason unrelated to what it checks.
    """
    monkeypatch.setenv("LANG", P.REQUIRED_LANG)


# --- pdf_page_texts (Req 14.2) -------------------------------------------------------


def blank_pdf(path: Path, pages: int) -> Path:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=200, height=200)
    with path.open("wb") as handle:
        writer.write(handle)
    return path


def test_one_string_per_page_in_page_order(tmp_path: Path) -> None:
    texts = pdf_page_texts(blank_pdf(tmp_path / "three.pdf", 3))

    assert len(texts) == 3


def test_a_blank_page_yields_an_empty_string_rather_than_being_dropped(
    tmp_path: Path,
) -> None:
    """The index of a page in the returned tuple **is** its page number minus one, so a
    dropped blank page would renumber every page after it — and a table of contents built on
    that would be wrong by one for the rest of the document."""
    texts = pdf_page_texts(blank_pdf(tmp_path / "blank.pdf", 4))

    assert texts == ("", "", "", "")
    assert len(texts) == 4


def test_an_unreadable_pdf_raises_rather_than_reporting_no_pages(tmp_path: Path) -> None:
    """The same contract `read_pdf_text` holds: a caller must not conclude that a heading is
    on no page because the file would not parse."""
    broken = tmp_path / "broken.pdf"
    broken.write_bytes(b"not a pdf at all")

    with pytest.raises(VerificationFailedError) as raised:
        pdf_page_texts(broken)

    assert raised.value.code is ErrorCode.VERIFICATION_FAILED
    assert str(broken) in str(raised.value)


def test_the_two_readers_agree_about_the_same_document(tmp_path: Path) -> None:
    """`read_pdf_text` joins pages and `pdf_page_texts` does not, so joining the second must
    reproduce the first. Without this they could drift into two different normalizations and
    a string findable by the fidelity gate would be unfindable by the page locator."""
    path = blank_pdf(tmp_path / "agree.pdf", 3)

    whole, count = read_pdf_text(path)
    per_page = pdf_page_texts(path)

    assert count == len(per_page)
    assert " ".join(per_page).strip() == whole


# --- the harness contract, without rendering ------------------------------------------


def test_an_undeclared_approach_is_refused() -> None:
    """A typo must fail rather than silently measure `none`, which would record a verdict for
    a candidate that was never rendered."""
    definition, snapshot = H.load_fixture()

    with pytest.raises(ValueError, match="is not one of the declared TOC approaches"):
        asyncio.run(H.measure(definition, snapshot, approach="two-pass"))


@pytest.mark.parametrize(
    "approach",
    [
        TOC_APPROACH_LIBREOFFICE_INDEX,
        TOC_APPROACH_TWO_PASS,
        TOC_APPROACH_CONVERSION_MACRO,
    ],
)
def test_a_candidate_with_no_emission_path_refuses_to_be_measured(approach: str) -> None:
    """Task 2.3 adds one emission path per candidate. Until then, measuring one has to fail:
    returning a measurement for a candidate whose table of contents was never emitted would
    let the evaluation record `correct` for a document that carried none."""
    definition, snapshot = H.load_fixture()

    with pytest.raises(NotImplementedError, match="has no emission path yet"):
        asyncio.run(H.measure(definition, snapshot, approach=approach))


def test_the_fixture_declares_the_headings_the_measurement_looks_for() -> None:
    """Read from the definition, not found in the PDF. Scanning the rendered text for things
    that *look* like headings would pass on a document that emitted none."""
    definition, _snapshot = H.load_fixture()

    headings = H._heading_texts(definition)

    assert len(headings) >= MIN_HEADINGS
    assert len(set(headings)) == len(headings), (
        "two headings with identical text cannot be told apart by page, so the fixture's "
        "headings must be distinct"
    )


def test_the_fixture_digest_covers_both_files() -> None:
    """The evidence record pins what was measured, so the digest has to move when either
    file does."""
    before = H.fixture_digest()

    assert len(before) == 64
    assert before == H.fixture_digest(), "the digest must be stable across calls"


def test_the_first_character_rule_resolves_a_straddling_heading_to_one_page() -> None:
    """The subtlety that makes `observed_pages` single-valued.

    A heading long enough to wrap can straddle a page boundary and then appears in full on
    neither page. The rule is the page carrying its **first character**, which is also the
    page a reader turns to — pointing at the page holding its second line would send them one
    page late.
    """
    pages = ("body text ending with Methodology And", "Provenance continues here")

    assert H._first_character_page(pages, "Methodology And Provenance") == 1


def test_a_heading_present_in_full_resolves_to_the_page_holding_it() -> None:
    pages = ("front matter", "Compute Utilization and some body", "later text")

    assert H._first_character_page(pages, "Compute Utilization") == 2


def test_a_heading_appearing_on_several_pages_resolves_to_the_first() -> None:
    """The rule is the page carrying the heading's **first** character, and this is the only
    case where first and last differ — so it is the only case that can catch a locator
    written as "the last page mentioning it".

    Not hypothetical: a theme with a running header repeats the section title on every page
    of the section, and body prose can quote a heading. A locator taking the last match would
    then point a reader at the end of the section instead of its start, and every page number
    in the table of contents would be wrong in the same plausible-looking direction.
    """
    pages = (
        "front matter",
        "Compute Utilization begins here",
        "Compute Utilization continued",
        "Compute Utilization continued further",
    )

    assert H._first_character_page(pages, "Compute Utilization") == 2


def test_a_heading_on_no_page_resolves_to_none() -> None:
    """So a heading the renderer dropped is a missing observation rather than page 1."""
    assert H._first_character_page(("a", "b"), "Absent Heading") is None


# --- the real render, once (Req 14.11) ------------------------------------------------


@pytest.fixture(scope="module")
def measured(tmp_path_factory: pytest.TempPathFactory) -> H.TocMeasurement:
    """One `measure` call for the whole module: it spawns LibreOffice and takes seconds."""
    if SOFFICE is None:  # pragma: no cover - environment dependent
        pytest.skip("LibreOffice is not installed")

    import os

    profile = tmp_path_factory.mktemp("profile")
    previous_lang = os.environ.get("LANG")
    previous_profile = os.environ.get(P.PROFILE_ENV_VAR)
    os.environ["LANG"] = P.REQUIRED_LANG
    os.environ[P.PROFILE_ENV_VAR] = str(profile)
    try:
        definition, snapshot = H.load_fixture()
        return asyncio.run(
            H.measure(definition, snapshot, approach=TOC_APPROACH_NONE)
        )
    finally:
        for name, value in (
            ("LANG", previous_lang),
            (P.PROFILE_ENV_VAR, previous_profile),
        ):
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@pytest.mark.skipif(SOFFICE is None, reason="LibreOffice is not installed")
def test_the_fixture_has_the_geometry_the_proof_test_needs(
    measured: H.TocMeasurement,
) -> None:
    """Req 14.11, and the reason the fixture is as long as it is.

    A proof test over a one-page document would pass trivially: every heading would be on
    page 1, and "named equals observed" would hold for a table of contents that demonstrated
    nothing about pagination. These three floors are what make the eventual equality
    assertion meaningful.
    """
    assert measured.pages >= MIN_PAGES
    assert measured.headings >= MIN_HEADINGS
    assert measured.distinct_heading_pages >= MIN_DISTINCT_HEADING_PAGES


@pytest.mark.skipif(SOFFICE is None, reason="LibreOffice is not installed")
def test_every_declared_heading_was_located(measured: H.TocMeasurement) -> None:
    """A heading the renderer emitted nowhere would otherwise be silently absent from the
    measurement rather than a failure."""
    definition, _snapshot = H.load_fixture()

    assert set(measured.observed_pages) == set(H._heading_texts(definition))


@pytest.mark.skipif(SOFFICE is None, reason="LibreOffice is not installed")
def test_each_heading_resolves_to_exactly_one_page_in_ascending_order(
    measured: H.TocMeasurement,
) -> None:
    """Single-valued, and in document order: heading *n* cannot be on an earlier page than
    heading *n − 1*. That ordering is a property of the document rather than of the
    measurement, so a locator that matched the wrong occurrence of a repeated word would
    show up here."""
    definition, _snapshot = H.load_fixture()
    ordered = [measured.observed_pages[text] for text in H._heading_texts(definition)]

    assert all(isinstance(page, int) and page >= 1 for page in ordered)
    assert ordered == sorted(ordered), ordered
    assert max(ordered) <= measured.pages


@pytest.mark.skipif(SOFFICE is None, reason="LibreOffice is not installed")
def test_the_none_approach_names_no_page(measured: H.TocMeasurement) -> None:
    """`named_pages` is empty rather than mirroring `observed_pages`.

    Mirroring would make the proof test's `named == observed` equality true by construction
    for **every** approach, including the one that emits no table of contents at all — which
    is precisely the assertion that has to be able to fail.
    """
    assert measured.named_pages == {}
    assert measured.observed_pages != {}


@pytest.mark.skipif(SOFFICE is None, reason="LibreOffice is not installed")
def test_the_measurement_carries_both_artifacts_and_the_pdf_digest(
    measured: H.TocMeasurement,
) -> None:
    """The evidence record pins `docx_sha256` and `pdf_sha256`, so the measurement has to
    carry the bytes it measured rather than a path to something that could be regenerated."""
    import hashlib

    assert measured.docx_bytes.startswith(b"PK")
    assert measured.pdf_bytes.startswith(b"%PDF")
    assert measured.pdf_sha256 == hashlib.sha256(measured.pdf_bytes).hexdigest()
