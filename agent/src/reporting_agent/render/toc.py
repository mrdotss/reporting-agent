"""The table-of-contents approach: the candidate set, and which one was adopted
(Req 14.1, 14.3, 14.10).

This module declares **only** the vocabulary and the decision. The measurement harness
that produced the decision lives in `agent/tests/toc_harness.py`, the evidence it
recorded is committed under `agent/evidence/toc/`, and the emitter — if there is one —
lands in `render/docx.py`. Keeping the decision here, alone, is what lets every later
module *read* it rather than assume a value.

## Why a module constant and not an environment variable

**A table of contents whose correctness was proven in the image build must not be
switchable at run time by a deployment that never ran the proof.**

That is the whole reason, and it is worth being concrete about the failure it rules out.
A page number in a table of contents is a claim about where a heading will land after
Word or LibreOffice has paginated the document — the one thing neither the compiler nor
the HTML emitter can determine, which is why criterion 14.2 demands a proof test over a
real multi-page render rather than a unit test over a field code. An environment variable
would let an operator turn that section on in an image where the proof was never run,
or in an image where it ran and *failed*: the document would then ship a page number that
is not merely unverified but structurally unverifiable, in a product whose entire claim
is that a figure in a delivered document traces to something checkable. A wrong page
number is also the most quietly damaging kind of wrong, because a reader who follows it
to the wrong page concludes the document is sloppy rather than that a number is untrue,
and stops checking the numbers that matter.

So the value is compiled into the image beside the proof that justifies it, and the two
travel together or not at all. **`.env.example` gains nothing in this module's name, in
this task or any other** — there is no variable to add, and adding one would be the
mistake this paragraph exists to prevent.

The corollary, and it is a real cost accepted deliberately: changing the approach is a
code change, a review and a new image, not a redeploy. That is the correct price for a
claim that has to be re-proven whenever it changes.

## The candidates

Three ways to make a table of contents carry true page numbers, evaluated in this order —
cheapest first — and one way to ship no table of contents at all:

* :data:`TOC_APPROACH_LIBREOFFICE_INDEX` — insert a Word `TOC` field with **no cached
  result** and let the `.docx` → `.pdf` conversion resolve it. Cheapest by far: no second
  conversion, no macro, no change to the conversion filter.
* :data:`TOC_APPROACH_TWO_PASS` — emit the section at full size with no numbers, convert,
  measure which page each heading landed on, re-emit with those numbers as literal text,
  convert again. Correct only if the measurement is a **fixed point**: the second pass's
  own pagination must agree with the first's, or the numbers describe a document that no
  longer exists. It also doubles the LibreOffice conversion, which is why adopting it is
  the one candidate that moves the `rendering` phase budget.
* :data:`TOC_APPROACH_CONVERSION_MACRO` — drive `updateIndexes()` through `soffice`'s
  scripting interface before export.
* :data:`TOC_APPROACH_NONE` — **ship no table of contents.** Criterion 14.3's stated
  outcome when no candidate is `correct`, and not a gap: the document is cover →
  document control → content, `front_matter.toc` is retained in the definition exactly
  as a disabled cover is retained, and `verification.counts.toc_entries_checked` is `0`.
  A section that cannot state a true page number is worth less than no section.

:data:`ADOPTED_APPROACH` is :data:`TOC_APPROACH_NONE` until the evaluation of task 2.3
has run and recorded a `correct` verdict. It is **not** a placeholder to be optimistically
overwritten: `none` is a shippable outcome, so a reader cannot tell "not yet evaluated"
from "evaluated and nothing worked" by looking at this value — that is what
`agent/evidence/toc/evaluation.json` is for, and why the evidence record carries all
three verdicts regardless of which one was adopted.

## Nothing else may spell these strings

`tests/test_boundaries.py`'s rule 12 fails on any of the four literals appearing outside
this module. A second declaration is the ordinary way this kind of constant rots: a
comparison written as `== "two_pass_measure"` keeps passing after the constant it was
meant to track is renamed, and the branch silently stops being taken. Every later
consumer imports the name.
"""

from __future__ import annotations

from typing import Final

__all__ = [
    "ADOPTED_APPROACH",
    "TOC_APPROACHES",
    "TOC_APPROACH_CONVERSION_MACRO",
    "TOC_APPROACH_LIBREOFFICE_INDEX",
    "TOC_APPROACH_NONE",
    "TOC_APPROACH_TWO_PASS",
]

# --- the candidate set (Req 14.1) ----------------------------------------------------
#
# Four `Final[str]` constants rather than a `StrEnum`, matching `collect/log.py`'s
# `GAP_TYPE_*` and `catalog/loader.py`'s `CATALOG_ENTRY_INVALID_GAP_TYPE`: the value is
# written into `evidence/toc/evaluation.json` as a JSON string and read back out of it,
# and a plain `str` crosses that boundary with no enum-to-string conversion on either
# side.

TOC_APPROACH_LIBREOFFICE_INDEX: Final[str] = "libreoffice_index_update"
TOC_APPROACH_TWO_PASS: Final[str] = "two_pass_measure"
TOC_APPROACH_CONVERSION_MACRO: Final[str] = "conversion_macro"
TOC_APPROACH_NONE: Final[str] = "none"

TOC_APPROACHES: Final[tuple[str, ...]] = (
    TOC_APPROACH_LIBREOFFICE_INDEX,
    TOC_APPROACH_TWO_PASS,
    TOC_APPROACH_CONVERSION_MACRO,
    TOC_APPROACH_NONE,
)
"""Exactly the four approaches, in the order they are evaluated — cheapest first, with
`none` last because it is the outcome rather than a candidate. A `tuple`, so the
evaluation iterates a declared order and two runs try them in the same sequence."""

assert len(TOC_APPROACHES) == 4
assert len(set(TOC_APPROACHES)) == len(TOC_APPROACHES)

# --- the decision (Req 14.3, 14.10) -------------------------------------------------

ADOPTED_APPROACH: Final[str] = TOC_APPROACH_NONE
"""The approach this image ships, and the value every front-matter module reads.

Set to the first candidate the evaluation recorded a `correct` verdict for, or left at
:data:`TOC_APPROACH_NONE`. See the module docstring on why this is a module constant and
not an environment variable, and why `none` is a shippable value rather than a
placeholder."""

assert ADOPTED_APPROACH in TOC_APPROACHES
