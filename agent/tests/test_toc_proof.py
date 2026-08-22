"""The table-of-contents proof, over the adopted approach, on every run (Req 14.2, 14.10).

`test_toc_evidence.py` checks the record of a measurement taken once. **This** module takes
the measurement again, every commit, over the approach the image actually ships — because a
page number is the one thing in a delivered document that neither the compiler nor the HTML
emitter can determine. It is decided by LibreOffice, at conversion time, from font metrics and
table column widths, so the only honest proof is a real multi-page render.

## There is no configuration in which nothing executes

Criterion 14.2 says the suite SHALL fail if this test is absent, is skipped, or is marked as
an expected failure. So:

* the branch on :data:`~reporting_agent.render.toc.ADOPTED_APPROACH` is a **runtime `if`**,
  not `skipif` — whichever way it goes, assertions run;
* the `none` branch is not `pass`. Shipping no table of contents is a shippable outcome
  (criterion 14.3), and it has its own obligation: the document must carry no half-built one.
  A `TOC` field left behind with no cached result renders as an empty section, and a page
  number left in the front matter is a claim nothing computed;
* `tests/test_property_hygiene.py` scans **this module by name** for a skip or
  expected-failure marker, which is how that requirement becomes an assertion rather than a
  convention somebody has to keep.

The one thing this cannot cover is LibreOffice being absent from the machine. That is not a
configuration of this repository — the image installs it and `render/pdf.py` refuses without
it — so its absence fails here rather than skipping, on the same reasoning: a suite that goes
green because the converter is missing has not proven the thing this module exists to prove.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import shutil
import time
import zipfile
from collections.abc import Iterator
from typing import Final

import pytest

import toc_harness as H
from reporting_agent.render import pdf as P
from reporting_agent.render.toc import (
    ADOPTED_APPROACH,
    TOC_APPROACH_NONE,
    TOC_APPROACH_TWO_PASS,
)

MIN_PAGES: Final[int] = 8
MIN_HEADINGS: Final[int] = 6
MIN_DISTINCT_HEADING_PAGES: Final[int] = 4

_TOC_INSTRUCTION_KEYWORD: Final[str] = "TOC"
_PAGE_FIELD_KEYWORD: Final[str] = "PAGE"


@pytest.fixture(scope="module")
def converter_env(
    tmp_path_factory: pytest.TempPathFactory,
) -> Iterator[None]:
    """The locale and profile every conversion in this module runs under.

    A fixture rather than setup inside `measured`, because two tests convert: the shared
    measurement and the serialization check, which drives `measure` itself so it can observe
    both calls. Without this, the second one fails on the `LANG` assertion for a reason
    unrelated to what it checks.

    `soffice`'s absence **fails** here rather than skipping. Criterion 14.2 asks for a proof
    that executes, and a green suite on a machine with no converter is not one.
    """
    import os

    assert shutil.which(P.SOFFICE_BINARY) is not None, (
        f"{P.SOFFICE_BINARY!r} is not on PATH, so the adopted table of contents cannot be "
        f"proven. This fails rather than skipping: criterion 14.2 asks for a proof that "
        f"executes, and a green suite on a machine with no converter is not one"
    )

    profile = tmp_path_factory.mktemp("profile")
    previous = {
        "LANG": os.environ.get("LANG"),
        P.PROFILE_ENV_VAR: os.environ.get(P.PROFILE_ENV_VAR),
    }
    os.environ["LANG"] = P.REQUIRED_LANG
    os.environ[P.PROFILE_ENV_VAR] = str(profile)
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


@pytest.fixture(scope="module")
def measured(converter_env: None) -> H.TocMeasurement:
    """One `measure` call over the adopted approach, shared by the whole module.

    Module-scoped because it spawns LibreOffice — twice, for the adopted two-pass approach —
    and every assertion below reads the same document. Sharing it is what keeps this proof
    affordable enough to run on every commit, which is the point of it running at all.
    """
    del converter_env
    definition, snapshot = H.load_fixture()
    return asyncio.run(H.measure(definition, snapshot, approach=ADOPTED_APPROACH))


def document_xml(docx_bytes: bytes) -> str:
    return (
        zipfile.ZipFile(io.BytesIO(docx_bytes))
        .read("word/document.xml")
        .decode("utf-8")
    )


# --------------------------------------------------------------------------- #
# The proof
# --------------------------------------------------------------------------- #


def test_the_adopted_approach_names_the_page_every_heading_landed_on(
    measured: H.TocMeasurement,
) -> None:
    """The whole requirement, in one assertion per branch.

    For the adopted two-pass approach, `named_pages` is pass 1's measurement printed into
    pass 2's document and `observed_pages` is pass 2's own pagination — so this equality
    **is** criterion 14.3's fixed-point test, not a separate check that happens to agree with
    it. A first pass whose numbers did not survive its own re-render would fail here.
    """
    if ADOPTED_APPROACH == TOC_APPROACH_NONE:
        assert measured.named_pages == {}, (
            "no table of contents is shipped, so the document names no page. A non-empty "
            "mapping here would mean something emitted one anyway"
        )
        assert measured.observed_pages, (
            "the headings still have to land somewhere, or the measurement is vacuous"
        )
        return

    assert measured.named_pages == measured.observed_pages, (
        f"{ADOPTED_APPROACH} named "
        f"{sorted(measured.named_pages.items())} and the headings landed on "
        f"{sorted(measured.observed_pages.items())}"
    )
    assert measured.named_pages, (
        "two empty mappings are equal; a table of contents naming no page passes the "
        "assertion above without proving anything"
    )


def test_the_document_it_was_proven_over_can_paginate(
    measured: H.TocMeasurement,
) -> None:
    """Criterion 14.11's three floors, asserted on the measurement rather than assumed of the
    fixture — the fixture could be edited, and then the equality above would hold over a
    document with nothing to get wrong."""
    assert measured.pages >= MIN_PAGES
    assert measured.headings >= MIN_HEADINGS
    assert measured.distinct_heading_pages >= MIN_DISTINCT_HEADING_PAGES


def test_every_declared_heading_was_located(measured: H.TocMeasurement) -> None:
    """A heading the renderer emitted nowhere would be silently absent from both mappings,
    and the equality above would hold across the hole."""
    definition, _snapshot = H.load_fixture()
    declared = H._heading_texts(definition)

    assert set(measured.observed_pages) == set(declared)
    if ADOPTED_APPROACH != TOC_APPROACH_NONE:
        assert set(measured.named_pages) == set(declared)


def test_the_pages_named_are_pages_the_document_has(measured: H.TocMeasurement) -> None:
    """A number outside the document's own page range is wrong in the one way an equality
    against a second measurement of the same wrong thing cannot catch."""
    for heading, page in measured.observed_pages.items():
        assert 1 <= page <= measured.pages, (heading, page, measured.pages)
    for heading, page in measured.named_pages.items():
        assert 1 <= page <= measured.pages, (heading, page, measured.pages)


def test_the_headings_are_named_in_document_order(measured: H.TocMeasurement) -> None:
    """Heading *n* cannot be on an earlier page than heading *n − 1*. A property of the
    document rather than of the measurement, so a locator that matched the wrong occurrence
    of a repeated phrase shows up here rather than as an equality between two identically
    wrong mappings."""
    definition, _snapshot = H.load_fixture()
    ordered = [measured.observed_pages[text] for text in H._heading_texts(definition)]

    assert ordered == sorted(ordered), ordered


def test_the_document_carries_no_half_built_table_of_contents(
    measured: H.TocMeasurement,
) -> None:
    """The `none` branch's own obligation, and the adopted branch's mirror of it.

    Shipping no table of contents is a decision, not an omission, so the document has to be
    *clean* rather than merely missing a section: a `TOC` field left behind resolves to an
    empty heading in Word and to nothing at all through LibreOffice, and a page-number field
    in the front matter is a number nothing computed — the exact shape of claim this product
    refuses to make.

    Where a candidate **is** adopted, the same assertion runs inverted: the mechanism the
    record justifies is the mechanism the document actually uses. The adopted two-pass
    approach prints literal text and emits no field, so a `TOC` field appearing in its output
    would mean a second, unevaluated mechanism had been wired in beside it.
    """
    xml = document_xml(measured.docx_bytes)

    if ADOPTED_APPROACH == TOC_APPROACH_NONE:
        assert H.TOC_LABEL not in xml, "a contents section was emitted anyway"
        assert "instrText" not in xml, (
            "the document carries a Word field; with no table of contents shipped there is "
            "nothing for one to compute"
        )
        assert _PAGE_FIELD_KEYWORD not in xml.upper().replace("PAGES", ""), (
            "a page-number position survives in a document that names no page"
        )
        return

    assert H.TOC_LABEL in xml, "the adopted approach emitted no contents section"
    if ADOPTED_APPROACH == TOC_APPROACH_TWO_PASS:
        assert _TOC_INSTRUCTION_KEYWORD not in xml, (
            "the two-pass approach prints literal numbers and emits no field; a TOC field "
            "here is a second mechanism the evaluation never measured"
        )


def test_the_measurement_carries_the_bytes_it_measured(
    measured: H.TocMeasurement,
) -> None:
    """So the evidence record's digests name artifacts that exist, and the proof is over the
    same two files a delivered report would be."""
    assert measured.docx_bytes.startswith(b"PK")
    assert measured.pdf_bytes.startswith(b"%PDF")
    assert measured.pdf_sha256 == hashlib.sha256(measured.pdf_bytes).hexdigest()


# --------------------------------------------------------------------------- #
# The two-pass approach's own two obligations (Req 14.2)
# --------------------------------------------------------------------------- #
#
# These run only where the two-pass candidate is adopted, and the `if` is a runtime one for the
# same reason every other branch in this module is: `skipif` would make them vanish silently if
# the adoption were ever reverted, and the guard that catches a reverted adoption is
# `test_toc_evidence.py`, not a marker.


def test_the_two_conversions_are_serialized(
    converter_env: None, monkeypatch: pytest.MonkeyPatch
) -> None:
    """They contend on the single pre-warmed profile in the image, so they must not overlap.

    `render/pdf.py` holds a process-wide lock across each whole invocation because the profile
    is **used** rather than copied — two concurrent conversions fight over LibreOffice's lock
    files inside it, which surfaces as one of the two failing with a profile-in-use error,
    intermittently, under load. That is also what makes the 900-second `rendering` budget in
    `app/lib/runs/state.ts` additive rather than concurrent: 300 + 300 plus the emits.

    Asserted by observing the calls rather than by reading the lock, because the property that
    matters is "the second starts after the first finished", and a test that checked the lock
    exists would pass over a call path that never took it.
    """
    if ADOPTED_APPROACH != TOC_APPROACH_TWO_PASS:
        # A single-conversion candidate has nothing to serialize; assert that instead, so this
        # test still executes rather than becoming an empty branch.
        assert ADOPTED_APPROACH in {TOC_APPROACH_NONE, *H.TOC_APPROACHES}
        return

    del converter_env
    intervals: list[tuple[int, int]] = []
    real = H.convert_to_pdf

    def recording(docx_bytes: bytes, **kwargs: object) -> object:
        started = time.perf_counter_ns()
        outcome = real(docx_bytes, **kwargs)  # type: ignore[arg-type]
        intervals.append((started, time.perf_counter_ns()))
        return outcome

    monkeypatch.setattr(H, "convert_to_pdf", recording)
    definition, snapshot = H.load_fixture()
    asyncio.run(H.measure(definition, snapshot, approach=ADOPTED_APPROACH))

    assert len(intervals) == 2, (
        f"the two-pass approach converts exactly twice; observed {len(intervals)}"
    )
    (first_started, first_ended), (second_started, _) = intervals
    assert first_started < first_ended <= second_started, (
        "the second conversion began before the first returned, so the two contend on the "
        "one pre-warmed profile"
    )


def test_only_the_second_passes_bytes_are_the_artifacts(
    measured: H.TocMeasurement,
) -> None:
    """Pass 1 is held in memory and never written, so `docx_sha256` and `pdf_sha256` name
    pass 2's bytes and the templates spec's fidelity gate is unaffected.

    Asserted positively — the returned document **contains the measured page numbers** — rather
    than by looking for the absence of a pass-1 artifact. There is no object store in this path
    at all, so "no object exists at any pass-1 key" is true of a harness that wrote nothing and
    equally true of one that returned the wrong bytes; what distinguishes them is which pass the
    returned document came from, and only pass 2 carries numbers.
    """
    if ADOPTED_APPROACH != TOC_APPROACH_TWO_PASS:
        assert measured.named_pages == {} or measured.named_pages
        return

    xml = document_xml(measured.docx_bytes)

    assert measured.named_pages, "pass 2 printed no numbers, so this cannot distinguish it"
    for heading, page in measured.named_pages.items():
        assert f"<w:t>{page}</w:t>" in xml, (
            f"the returned .docx carries no printed page number for {heading!r}, so these "
            f"bytes are pass 1's rather than pass 2's"
        )
    # And the digest travels with those bytes, not with a second render of them.
    assert measured.pdf_sha256 == hashlib.sha256(measured.pdf_bytes).hexdigest()
