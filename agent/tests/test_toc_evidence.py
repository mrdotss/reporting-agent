"""The committed table-of-contents evaluation record, read back and checked (Req 14.1, 14.10).

`tests/toc_evaluate.py` produced `agent/evidence/toc/`; this module is what stops that record
from drifting away from the code that reads it. The two things it can catch are both silent:

* **a record that no longer describes this tree** — a fourth candidate declared in
  `render/toc.py` and never evaluated, a verdict outside the declared set, an
  `ADOPTED_APPROACH` naming a candidate the record calls `incorrect`;
* **a record that disagrees with itself** — a `correct` verdict whose own `named_pages` and
  `observed_pages` differ, which is the recollection criterion 14.1 refuses: a verdict is a
  claim about numbers that are in the record beside it, so the claim is checkable without
  re-running LibreOffice, and if it is not true the record is worse than absent.

**Why a record rather than a re-measurement.** The evaluation spawns LibreOffice five times.
Criterion 14.1 asks for the *record* — a verdict measured once, over a pinned fixture, on a
named LibreOffice build — not for the measurement repeated on every commit. What *is* repeated
on every commit is `tests/test_toc_proof.py`, over the adopted approach alone.

The seam between the two is the fixture, so it is pinned in both directions: this module
asserts the fixture the record names is the fixture the proof test loads, **by path and by
content digest**. Comparing only the path would let the fixture be edited under a verdict
measured against its previous contents; comparing only the digest would let the record name a
different file that happens to hash the same, which cannot happen but also cannot be seen.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Final

import pytest

import toc_evaluate as E
import toc_harness as H
from reporting_agent.render.toc import ADOPTED_APPROACH, TOC_APPROACH_NONE, TOC_APPROACHES

EVIDENCE_DIR: Final[Path] = E.EVIDENCE_DIR
RECORD_PATH: Final[Path] = EVIDENCE_DIR / "evaluation.json"


@pytest.fixture(scope="module")
def record() -> dict[str, Any]:
    """The committed record, parsed.

    A hard failure rather than a skip when it is absent: an unevaluated approach is exactly
    what criterion 14.1 asks the record to rule out, so a missing record must not read as a
    clean suite.
    """
    assert RECORD_PATH.is_file(), (
        f"{RECORD_PATH} is absent. Criterion 14.1 requires the evaluation on the record; "
        f"regenerate it with `python -m tests.toc_evaluate` and commit the result"
    )
    return json.loads(RECORD_PATH.read_text(encoding="utf-8"))


def entries(record: dict[str, Any]) -> list[dict[str, Any]]:
    candidates = record["candidates"]
    assert isinstance(candidates, list)
    return candidates


# --------------------------------------------------------------------------- #
# The record names exactly the three candidates
# --------------------------------------------------------------------------- #


def test_the_record_names_exactly_the_three_candidates_and_no_more(
    record: dict[str, Any],
) -> None:
    """Both directions, because each failure is different and both are silent.

    A **missing** candidate means an approach was never tried and the record cannot say so —
    the absence of an entry is indistinguishable from an approach nobody thought of. An
    **extra** candidate means the record describes a mechanism this tree does not declare,
    so a reader could adopt a name `render/toc.py` will not accept.
    """
    named = [entry["candidate"] for entry in entries(record)]

    assert named == list(E.EVALUATED_CANDIDATES), (
        "the record's candidates must be exactly the three declared ones, in evaluation "
        f"order; got {named}"
    )
    assert len(named) == len(set(named)), f"a candidate is recorded twice: {named}"
    assert set(named) == set(TOC_APPROACHES) - {TOC_APPROACH_NONE}, (
        "the evaluated set must be every declared approach except `none`, which is the "
        "outcome when no candidate is correct rather than a mechanism to evaluate"
    )


def test_every_candidate_carries_a_verdict_from_the_declared_set(
    record: dict[str, Any],
) -> None:
    """Three verdicts, not two. `unavailable` — the mechanism needs a facility the image
    does not provide — is a different fact from `incorrect` — the mechanism ran and got the
    page numbers wrong — and collapsing them would file "we could not try it" under the same
    word as "we tried it and it lies"."""
    for entry in entries(record):
        assert entry["verdict"] in E.VERDICTS, entry

    assert set(E.VERDICTS) == {"correct", "incorrect", "unavailable"}


@pytest.mark.parametrize(
    "field", ["candidate", "verdict", "evaluated_at", "named_pages", "observed_pages", "note"]
)
def test_every_candidate_carries_every_required_field(
    record: dict[str, Any], field: str
) -> None:
    """Criterion 14.1's field list, asserted per field so a failure names the missing one."""
    for entry in entries(record):
        assert field in entry, f"{entry.get('candidate')!r} carries no {field!r}"
    if field == "note":
        for entry in entries(record):
            assert entry["note"].strip(), (
                f"{entry['candidate']!r} carries an empty note; the note is the only part "
                f"of a rejection a future reader can act on"
            )


def test_a_candidate_that_ran_carries_both_digests_and_one_that_did_not_carries_neither(
    record: dict[str, Any],
) -> None:
    """`docx_sha256` and `pdf_sha256` name the bytes that were measured — so a candidate that
    produced no bytes must not claim a digest, and one that did must not omit it.

    `null` rather than `""` for the unavailable case: an empty digest string is a second
    spelling of absence that a reader would have to know to treat as one.
    """
    for entry in entries(record):
        digests = (entry["docx_sha256"], entry["pdf_sha256"])
        if entry["verdict"] == E.VERDICT_UNAVAILABLE:
            assert digests == (None, None), entry["candidate"]
        else:
            for digest in digests:
                assert isinstance(digest, str) and len(digest) == 64, entry["candidate"]
                assert digest == digest.lower()


# --------------------------------------------------------------------------- #
# A verdict agrees with its own numbers
# --------------------------------------------------------------------------- #


def test_a_correct_verdict_names_the_pages_it_observed(record: dict[str, Any]) -> None:
    """The assertion that makes the record checkable rather than merely present.

    A `correct` verdict is the claim "the document's own page numbers are where the headings
    landed". Both numbers are in the record beside the verdict, so the claim can be checked
    here without LibreOffice — and a verdict that disagrees with its own numbers is the
    recollection criterion 14.1 exists to refuse.
    """
    correct = [
        entry for entry in entries(record) if entry["verdict"] == E.VERDICT_CORRECT
    ]

    for entry in correct:
        assert entry["named_pages"] == entry["observed_pages"], entry["candidate"]
        assert entry["named_pages"], (
            f"{entry['candidate']!r} is recorded correct and names no page at all; two "
            f"empty mappings are equal, which would make this verdict vacuous"
        )
        assert len(set(entry["observed_pages"].values())) >= E.MIN_DISTINCT_HEADING_PAGES
        assert len(entry["observed_pages"]) >= E.MIN_HEADINGS


def test_a_rejected_verdict_does_not_agree_with_its_own_numbers(
    record: dict[str, Any],
) -> None:
    """The other direction, which is what stops the rule above from being satisfiable by
    recording every candidate as `incorrect`.

    An `incorrect` verdict whose named and observed pages *did* agree, over a fixture of the
    required size, would be a candidate rejected for no reason the record can show.
    """
    for entry in entries(record):
        if entry["verdict"] != E.VERDICT_INCORRECT:
            continue
        big_enough = (
            len(entry["observed_pages"]) >= E.MIN_HEADINGS
            and len(set(entry["observed_pages"].values()))
            >= E.MIN_DISTINCT_HEADING_PAGES
        )
        assert not (entry["named_pages"] == entry["observed_pages"] and big_enough), (
            f"{entry['candidate']!r} is recorded incorrect and its own numbers agree over a "
            f"fixture of the required size; the note says: {entry['note']}"
        )


def test_an_unavailable_candidate_recorded_no_measurement(record: dict[str, Any]) -> None:
    """It never ran, so it observed nothing. A verdict of `unavailable` carrying observations
    would mean the harness measured something and then reported it as unmeasurable."""
    for entry in entries(record):
        if entry["verdict"] != E.VERDICT_UNAVAILABLE:
            continue
        assert entry["named_pages"] == {}
        assert entry["observed_pages"] == {}


def test_the_per_candidate_files_agree_with_the_record(record: dict[str, Any]) -> None:
    """`<candidate>/named.json` and `<candidate>/observed.json` are the same numbers as the
    record's, and exist for every candidate.

    Two copies of one measurement can disagree, and then neither is evidence — the same
    reasoning `.dockerignore` records for not duplicating the metric-definition fixtures into
    `src/`. They are committed separately because a reviewer reads a diff of two small files
    more easily than a diff of one large one; that convenience is only safe if a guard pins
    them together.
    """
    for entry in entries(record):
        directory = EVIDENCE_DIR / entry["candidate"]
        for name, expected in (
            ("named", entry["named_pages"]),
            ("observed", entry["observed_pages"]),
        ):
            path = directory / f"{name}.json"
            assert path.is_file(), f"{path} is absent"
            assert json.loads(path.read_text(encoding="utf-8")) == expected, path


def test_the_evidence_directory_holds_no_candidate_the_record_does_not_name() -> None:
    """A stale directory from a renamed candidate would sit beside the record looking like
    evidence for a mechanism nothing evaluates."""
    directories = {
        path.name for path in EVIDENCE_DIR.iterdir() if path.is_dir()
    }

    assert directories == set(E.EVALUATED_CANDIDATES), (
        f"the evidence directory holds {sorted(directories)}; the record names "
        f"{sorted(E.EVALUATED_CANDIDATES)}"
    )


# --------------------------------------------------------------------------- #
# The adopted approach is one the record justifies
# --------------------------------------------------------------------------- #


def test_the_adopted_approach_is_none_or_a_candidate_recorded_correct(
    record: dict[str, Any],
) -> None:
    """Criterion 14.3, and the reason `ADOPTED_APPROACH` is a module constant: the image
    ships the value beside the proof that justifies it, so the two travel together."""
    verdicts = {entry["candidate"]: entry["verdict"] for entry in entries(record)}

    assert ADOPTED_APPROACH in TOC_APPROACHES
    if ADOPTED_APPROACH == TOC_APPROACH_NONE:
        assert E.VERDICT_CORRECT not in verdicts.values(), (
            "a candidate is recorded correct and the image ships no table of contents; "
            f"adopt it or explain the verdict: {verdicts}"
        )
    else:
        assert verdicts[ADOPTED_APPROACH] == E.VERDICT_CORRECT, (
            f"{ADOPTED_APPROACH!r} is adopted and recorded "
            f"{verdicts[ADOPTED_APPROACH]!r}"
        )


def test_the_adopted_approach_is_the_first_correct_candidate_in_evaluation_order(
    record: dict[str, Any],
) -> None:
    """Criterion 14.1 evaluates cheapest first, so adopting a later `correct` candidate over
    an earlier one would take on cost the record shows was unnecessary — the two-pass
    approach doubles the LibreOffice conversion, and the macro approach adds a profile
    requirement."""
    correct = [
        entry["candidate"]
        for entry in entries(record)
        if entry["verdict"] == E.VERDICT_CORRECT
    ]
    expected = correct[0] if correct else TOC_APPROACH_NONE

    assert ADOPTED_APPROACH == expected


# --------------------------------------------------------------------------- #
# The fixture is pinned, by path and by digest
# --------------------------------------------------------------------------- #


def test_the_record_names_the_fixture_the_proof_test_loads(record: dict[str, Any]) -> None:
    """Both halves of the seam. See the module docstring on why one of them is not enough."""
    fixture = record["fixture"]
    name = fixture["name"]

    for key, suffix in (
        ("definition_path", "definition"),
        ("snapshot_path", "snapshot"),
    ):
        named = E.AGENT_ROOT / fixture[key]
        assert named.is_file(), f"{fixture[key]} does not exist"
        assert named == H.FIXTURE_DIR / f"{name}.{suffix}.json", (
            f"the record names {fixture[key]}, which is not the file the harness loads"
        )

    assert fixture["sha256"] == H.fixture_digest(name), (
        "the fixture has been edited since the record was measured, so every verdict in it "
        "describes a document that no longer exists; re-run `python -m tests.toc_evaluate`"
    )


def test_the_recorded_fixture_geometry_meets_the_declared_floors(
    record: dict[str, Any],
) -> None:
    """Criterion 14.11's thresholds, on the record. A verdict measured over a document too
    small to paginate would be evidence of nothing, so the size is part of the record rather
    than a property somebody checked once."""
    fixture = record["fixture"]

    assert fixture["pages"] >= E.MIN_PAGES
    assert fixture["headings"] >= E.MIN_HEADINGS
    assert fixture["distinct_heading_pages"] >= E.MIN_DISTINCT_HEADING_PAGES


def test_the_record_names_the_libreoffice_it_was_measured_on(
    record: dict[str, Any],
) -> None:
    """Pagination is decided by this binary, so a verdict measured under one LibreOffice is
    not evidence about another. Recorded, not asserted equal to the local one: the record
    describes the build that produced it, and a developer machine may differ from the
    image."""
    version = record["soffice_version"]

    assert isinstance(version, str) and version.strip()
    assert "LibreOffice" in version, version
    assert record["schema_version"] == E.EVIDENCE_SCHEMA_VERSION
