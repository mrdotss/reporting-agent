"""The one table-of-contents measurement, used by the evaluation and by the proof test
(Req 14.2, 14.11).

## Why there is exactly one of these

Task 2.3 evaluates three candidate approaches and records a verdict for each; task 2.4's
proof test then asserts the adopted one is still correct on every run. If those two measured
through different code, a `correct` verdict would mean "candidate B satisfied the
evaluation's notion of correct" while the proof asserted something else — and the
disagreement would be invisible, because both would be green.

So this module owns the measurement and both callers import it. `agent/tests/
test_toc_evidence.py` additionally asserts that the fixture the evidence record names is the
fixture the proof test uses, compared by path **and** by content digest, which closes the
other half of the same hole.

## What is measured, and the one subtlety in it

A table of contents claims that a heading is on a page. Checking that claim needs two
numbers per heading:

* `named_pages` — the page number the **document itself prints** in its table of contents.
* `observed_pages` — the page the heading **actually landed on** after conversion.

`observed_pages` resolves a heading to the page carrying its **first rendered character**.
That rule is not a tie-break detail; it is what makes the measurement single-valued. A
heading long enough to wrap can straddle a page boundary, and "the page it is on" then has
two defensible answers. Taking the first character means a heading is on exactly one page,
which is also the page a reader turns to — a table of contents that pointed at the page
holding a heading's *second* line would send them one page late.

## Not a unit test's shape, deliberately

`measure` runs the real `compile → render/docx.py → render/pdf.py` path, which means it
spawns LibreOffice and takes seconds rather than milliseconds. That cost is the point:
pagination is decided by the converter, so a measurement that stubbed the conversion would
be measuring an assumption. There is no faster honest version of this.
"""

from __future__ import annotations

import hashlib
import tempfile
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import definition_factory as df  # noqa: F401  (imported for callers' convenience)
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render import docx as D
from reporting_agent.render.pdf import convert_to_pdf
from reporting_agent.render.toc import TOC_APPROACH_NONE, TOC_APPROACHES
from reporting_agent.verify.tokens import pdf_page_texts

__all__ = ["FIXTURE_DIR", "TocMeasurement", "load_fixture", "measure"]

FIXTURE_DIR: Final[Path] = Path(__file__).resolve().parent / "fixtures" / "toc"


def load_fixture(name: str = "long_report") -> tuple[dict, dict]:
    """The committed `(definition, snapshot)` pair.

    Returned as plain data read from disk rather than rebuilt from the factories, because the
    evidence record names this file and its digest: a fixture rebuilt at measurement time
    could drift from the one a recorded verdict was measured against, and the verdict would
    then describe a document nobody has.
    """
    import json

    definition = json.loads(
        (FIXTURE_DIR / f"{name}.definition.json").read_text(encoding="utf-8")
    )
    snapshot = json.loads(
        (FIXTURE_DIR / f"{name}.snapshot.json").read_text(encoding="utf-8")
    )
    return definition, snapshot


def fixture_digest(name: str = "long_report") -> str:
    """A digest over both fixture files, so the evidence record can pin what was measured.

    Over the **bytes on disk**, in a fixed order, rather than over the parsed objects: the
    parsed form would hash the same after a reformat that changed what a future reader sees,
    and the point of pinning is that the recorded verdict describes an exact input.
    """
    digest = hashlib.sha256()
    for suffix in ("definition", "snapshot"):
        digest.update((FIXTURE_DIR / f"{name}.{suffix}.json").read_bytes())
    return digest.hexdigest()


@dataclass(frozen=True, slots=True)
class TocMeasurement:
    """One rendered-and-converted measurement of one approach.

    `named_pages` and `observed_pages` are both `{heading text: page number}`, one-based.
    `named_pages` is **empty** for an approach that ships no table of contents — which is not
    a failure but the recorded outcome of :data:`TOC_APPROACH_NONE`, and is why the proof test
    branches on the adopted approach rather than asserting equality unconditionally.
    """

    docx_bytes: bytes
    pdf_bytes: bytes
    pdf_sha256: str
    observed_pages: Mapping[str, int]
    named_pages: Mapping[str, int]

    @property
    def pages(self) -> int:
        """How many pages the converted PDF has."""
        return self._page_count

    _page_count: int = 0

    @property
    def headings(self) -> int:
        return len(self.observed_pages)

    @property
    def distinct_heading_pages(self) -> int:
        """How many **different** pages carry a heading (Req 14.11).

        The fixture's whole purpose is that this is greater than one: a table of contents
        every entry of which points at page 1 would satisfy "named equals observed" while
        proving nothing about pagination.
        """
        return len(set(self.observed_pages.values()))


def _heading_texts(definition: Mapping[str, object]) -> tuple[str, ...]:
    """The headings the definition declares, in document order.

    Read from the **definition** rather than found in the rendered text, so a heading the
    renderer dropped entirely is a missing observation rather than a heading nobody looked
    for. That direction matters: scanning the PDF for things that look like headings would
    silently pass on a document that emitted none.
    """
    texts: list[str] = []
    for block in definition.get("blocks") or []:
        if not isinstance(block, Mapping) or block.get("type") != "heading":
            continue
        config = block.get("config")
        text = config.get("text") if isinstance(config, Mapping) else None
        if isinstance(text, str) and text.strip():
            texts.append(text)
    return tuple(texts)


def _first_character_page(pages: Sequence[str], text: str) -> int | None:
    """The one-based page carrying `text`'s first rendered character, or `None`.

    Scans pages in order and returns the first that contains the heading, which **is** the
    first-character rule for any heading that fits on a page and the correct reading for one
    that does not: a heading straddling a boundary appears in full only on neither page, so
    the search falls back to progressively shorter prefixes, and the earliest page carrying
    any prefix is the page its first character is on.
    """
    for index, page in enumerate(pages, start=1):
        if text in page:
            return index

    # Straddling a boundary: find the longest prefix that appears, earliest page first.
    for length in range(len(text) - 1, 0, -1):
        prefix = text[:length].strip()
        if not prefix:
            break
        for index, page in enumerate(pages, start=1):
            if prefix and page.endswith(prefix):
                return index
    return None


def _observed_pages(pages: Sequence[str], headings: Sequence[str]) -> dict[str, int]:
    observed: dict[str, int] = {}
    for heading in headings:
        page = _first_character_page(pages, heading)
        if page is not None:
            observed[heading] = page
    return observed


async def measure(
    definition: Mapping[str, object],
    snapshot: Mapping[str, object],
    *,
    approach: str,
) -> TocMeasurement:
    """Compile, render, convert and measure, once.

    `approach` selects how the table of contents is produced. It is validated against
    :data:`TOC_APPROACHES` rather than accepted as free text, so a typo in an evaluation run
    fails instead of silently measuring :data:`TOC_APPROACH_NONE` and recording a verdict for
    a candidate that was never exercised.

    `async` because task 2.3's evaluation and task 2.5's two-pass candidate both need to
    serialize conversions — LibreOffice contends on the one pre-warmed profile in the image —
    and an `async` signature is what lets a caller await them in a defined order rather than
    discovering the contention as an intermittent profile-in-use failure.

    Only :data:`TOC_APPROACH_NONE` is implemented here. The other three are the candidates
    task 2.3 evaluates, and each lands with its own emission path; raising for them keeps an
    unimplemented candidate from being measured as though it were correct.
    """
    if approach not in TOC_APPROACHES:
        raise ValueError(
            f"{approach!r} is not one of the declared TOC approaches "
            f"{list(TOC_APPROACHES)}; a typo must fail rather than silently measure 'none'"
        )
    if approach != TOC_APPROACH_NONE:
        raise NotImplementedError(
            f"the {approach!r} candidate has no emission path yet; task 2.3 adds one per "
            f"candidate, and measuring an unimplemented candidate would record a verdict "
            f"for something that was never rendered"
        )

    view = build_snapshot_view(dict(snapshot))
    compiled = compile_document(dict(definition), view=view)
    design = DesignSettings.from_plain(definition.get("design"))
    outcome = D.render_document(
        compiled.document, ledger=compiled.ledger, design=design
    )
    conversion = convert_to_pdf(outcome.docx_bytes)

    with tempfile.TemporaryDirectory() as directory:
        path = Path(directory) / "measured.pdf"
        path.write_bytes(conversion.pdf_bytes)
        pages = pdf_page_texts(path)

    headings = _heading_texts(definition)
    observed = _observed_pages(pages, headings)

    return TocMeasurement(
        docx_bytes=outcome.docx_bytes,
        pdf_bytes=conversion.pdf_bytes,
        pdf_sha256=hashlib.sha256(conversion.pdf_bytes).hexdigest(),
        observed_pages=observed,
        # No table of contents is emitted, so the document names no page. Empty rather
        # than mirroring `observed` — mirroring would make the proof test's equality
        # assertion true by construction for every approach, including the one that
        # emits nothing.
        named_pages={},
        _page_count=len(pages),
    )
