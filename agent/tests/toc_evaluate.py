"""Run the three table-of-contents candidates and write the evidence record (Req 14.1, 14.3).

Not a test — a **generator**, run by hand and its output committed:

```
LANG=C.UTF-8 LO_PROFILE=<profile> .venv/bin/python -m tests.toc_evaluate
```

`agent/tests/test_toc_evidence.py` is the test that reads what this wrote. Splitting the two
is deliberate: the evaluation spawns LibreOffice five times and takes the better part of a
minute, and criterion 14.1 asks for a **record** — a verdict measured once, on a named
LibreOffice, over a pinned fixture — not for a measurement repeated on every commit. What
*is* repeated on every commit is task 2.4's proof test over the adopted approach.

## Why all three verdicts are recorded

Criterion 14.1 asks for the record and not for the winner. A record naming only the adopted
candidate cannot answer the question a future reader actually has — "was this tried, and what
happened?" — and the absence of an entry is indistinguishable from an approach nobody thought
of. Two of the three entries here describe rejections, and they are the more useful two.

## The verdict rule, in one place

A candidate is `correct` only when the document's own numbers agree with where the headings
landed **and** the fixture it was measured over is big enough for that agreement to mean
something. Both halves matter: a table of contents in a one-page document agrees trivially,
and criterion 14.11's thresholds are what stop a trivial agreement from being recorded as
evidence.

`unavailable` is reserved for a candidate that could not be exercised at all — see
:class:`~toc_harness.TocApproachUnavailableError`. It is not a synonym for `incorrect`:
"the image does not provide the facility" and "the mechanism produced wrong page numbers" send
a future reader to different places.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

from reporting_agent.render.toc import (
    TOC_APPROACH_CONVERSION_MACRO,
    TOC_APPROACH_LIBREOFFICE_INDEX,
    TOC_APPROACH_NONE,
    TOC_APPROACH_TWO_PASS,
    TOC_APPROACHES,
)
from toc_harness import (
    FIXTURE_DIR,
    TocApproachUnavailableError,
    TocMeasurement,
    fixture_digest,
    load_fixture,
    measure,
    soffice_version,
)

__all__ = [
    "EVALUATED_CANDIDATES",
    "EVIDENCE_DIR",
    "EVIDENCE_SCHEMA_VERSION",
    "MIN_DISTINCT_HEADING_PAGES",
    "MIN_HEADINGS",
    "MIN_PAGES",
    "VERDICTS",
    "VERDICT_CORRECT",
    "VERDICT_INCORRECT",
    "VERDICT_UNAVAILABLE",
    "build_record",
    "main",
]

AGENT_ROOT: Final[Path] = Path(__file__).resolve().parent.parent
EVIDENCE_DIR: Final[Path] = AGENT_ROOT / "evidence" / "toc"
EVIDENCE_SCHEMA_VERSION: Final[str] = "1.0.0"

VERDICT_CORRECT: Final[str] = "correct"
VERDICT_INCORRECT: Final[str] = "incorrect"
VERDICT_UNAVAILABLE: Final[str] = "unavailable"
VERDICTS: Final[tuple[str, ...]] = (
    VERDICT_CORRECT,
    VERDICT_INCORRECT,
    VERDICT_UNAVAILABLE,
)

EVALUATED_CANDIDATES: Final[tuple[str, ...]] = (
    TOC_APPROACH_LIBREOFFICE_INDEX,
    TOC_APPROACH_TWO_PASS,
    TOC_APPROACH_CONVERSION_MACRO,
)
"""The three candidates, in evaluation order — cheapest first, exactly as criterion 14.1
names them.

:data:`~reporting_agent.render.toc.TOC_APPROACH_NONE` is deliberately absent: it is the
*outcome* when no candidate is correct, not a mechanism to evaluate, and recording a verdict
for it would invite the reading that shipping no table of contents is a fourth thing that
could be `incorrect`.
"""

assert set(EVALUATED_CANDIDATES) == set(TOC_APPROACHES) - {TOC_APPROACH_NONE}

MIN_PAGES: Final[int] = 8
MIN_HEADINGS: Final[int] = 6
MIN_DISTINCT_HEADING_PAGES: Final[int] = 4
"""Criterion 14.11's thresholds, mirrored here because the verdict depends on them.

A `correct` verdict measured over a document too small to paginate would be evidence of
nothing, so the size of the document is part of what makes the agreement meaningful rather
than a separate check somebody could forget to run.
"""


def _verdict(measurement: TocMeasurement) -> tuple[str, str]:
    """`(verdict, note)` for a candidate that ran to completion."""
    named = dict(measurement.named_pages)
    observed = dict(measurement.observed_pages)

    if not named:
        return (
            VERDICT_INCORRECT,
            "the document named no page for any heading: the field was emitted with no "
            "cached result and the conversion did not resolve it, so the section renders "
            "as a heading with nothing under it",
        )
    if named != observed:
        disagreeing = sorted(
            heading
            for heading in set(named) | set(observed)
            if named.get(heading) != observed.get(heading)
        )
        return (
            VERDICT_INCORRECT,
            f"the document's own numbers disagree with where the headings landed for "
            f"{disagreeing}",
        )
    if measurement.pages < MIN_PAGES or measurement.headings < MIN_HEADINGS:
        return (
            VERDICT_INCORRECT,
            f"agreement was measured over {measurement.pages} pages and "
            f"{measurement.headings} headings, under the {MIN_PAGES}/{MIN_HEADINGS} "
            f"criterion 14.11 requires for the agreement to mean anything",
        )
    if measurement.distinct_heading_pages < MIN_DISTINCT_HEADING_PAGES:
        return (
            VERDICT_INCORRECT,
            f"every heading agreed, but across only "
            f"{measurement.distinct_heading_pages} distinct pages: a table of contents "
            f"whose entries all point at one page agrees trivially",
        )
    return (
        VERDICT_CORRECT,
        f"every one of the {measurement.headings} headings is named on the page it "
        f"landed on, across {measurement.distinct_heading_pages} distinct pages of a "
        f"{measurement.pages}-page document",
    )


async def _evaluate_one(
    candidate: str, definition: dict[str, Any], snapshot: dict[str, Any]
) -> dict[str, Any]:
    evaluated_at = datetime.now(UTC).isoformat().replace("+00:00", "Z")
    try:
        measurement = await measure(definition, snapshot, approach=candidate)
    except TocApproachUnavailableError as error:
        return {
            "candidate": candidate,
            "verdict": VERDICT_UNAVAILABLE,
            "evaluated_at": evaluated_at,
            "docx_sha256": None,
            "pdf_sha256": None,
            "named_pages": {},
            "observed_pages": {},
            "note": str(error),
        }

    verdict, note = _verdict(measurement)
    return {
        "candidate": candidate,
        "verdict": verdict,
        "evaluated_at": evaluated_at,
        "docx_sha256": hashlib.sha256(measurement.docx_bytes).hexdigest(),
        "pdf_sha256": measurement.pdf_sha256,
        "named_pages": dict(measurement.named_pages),
        "observed_pages": dict(measurement.observed_pages),
        "note": note,
    }


async def build_record(fixture: str = "long_report") -> dict[str, Any]:
    """Measure every candidate and return the record, without writing anything."""
    definition, snapshot = load_fixture(fixture)

    # The fixture's own pagination, measured with **no table of contents at all**, so the
    # `fixture` block describes the input rather than any candidate's output. Each candidate
    # adds its own section and therefore its own page, which is why a candidate's `pages` is
    # one more than this.
    baseline = await measure(definition, snapshot, approach=TOC_APPROACH_NONE)

    candidates = [
        await _evaluate_one(candidate, definition, snapshot)
        for candidate in EVALUATED_CANDIDATES
    ]

    return {
        "schema_version": EVIDENCE_SCHEMA_VERSION,
        "soffice_version": soffice_version(),
        "fixture": {
            "name": fixture,
            # Relative to `agent/`, which is where both this generator and the guard that
            # reads the record live — an absolute path would pin the record to the machine
            # that produced it.
            "definition_path": _agent_relative(f"{fixture}.definition.json"),
            "snapshot_path": _agent_relative(f"{fixture}.snapshot.json"),
            "sha256": fixture_digest(fixture),
            "pages": baseline.pages,
            "headings": baseline.headings,
            "distinct_heading_pages": baseline.distinct_heading_pages,
        },
        "candidates": candidates,
    }


def _agent_relative(name: str) -> str:
    """`tests/fixtures/toc/<name>`, as a POSIX path relative to `agent/`."""
    return (FIXTURE_DIR / name).relative_to(AGENT_ROOT).as_posix()


def _write(path: Path, body: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(body, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    record = asyncio.run(build_record())
    _write(EVIDENCE_DIR / "evaluation.json", record)
    for entry in record["candidates"]:
        directory = EVIDENCE_DIR / entry["candidate"]
        _write(directory / "named.json", entry["named_pages"])
        _write(directory / "observed.json", entry["observed_pages"])

    correct = [
        entry["candidate"]
        for entry in record["candidates"]
        if entry["verdict"] == VERDICT_CORRECT
    ]
    print(f"soffice: {record['soffice_version']}")
    for entry in record["candidates"]:
        print(f"  {entry['candidate']:26} {entry['verdict']}")
    print(
        "\nADOPTED_APPROACH should be "
        f"{correct[0] if correct else TOC_APPROACH_NONE!r}"
    )


if __name__ == "__main__":  # pragma: no cover - a generator, run by hand
    main()
