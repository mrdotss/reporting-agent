"""The five ordered masking stages, and the survivors they leave behind.

**A matched span is overwritten, never deleted** (Req 28.1). The paragraph is a
mutable character buffer and every stage writes :data:`MASK_CHAR` over what it
consumed. `\\u0007` carries no decimal digit and is not `\\w`, so a masked span
matches none of the later stages' patterns and no stage can re-read text an earlier
one consumed — which is what makes five stages produce one identical output for one
input. Overwriting rather than deleting keeps every offset stable, so a survivor's
location still points at the right characters of the original paragraph and a figure
wrapped in punctuation (`(34.2%)`) masks cleanly without disturbing the parentheses.

**Stage 1 masks longest-first, and that ordering is the whole pass** (Req 28.2). A
ledger holding both `12.4%` and `112.4%` is ordinary — two resources, two averages —
and masking in ledger insertion order lets `12.4%` consume the tail of `112.4%`,
leaving the digit `1` as a survivor and one spurious `unmatched_prose_token` on a
document that was correct. Longest-first by character count makes that impossible;
ties broken by ascending code-point sequence make the order identical on every run
over the same ledger, so a re-verification of a stored document cannot disagree with
the original.

**Stage 2 exists because a figure never begins with a letter.** `prod-sql-01`,
`Standard_D4s_v5` and `westus2` all carry digits and none of them is a measurement.
Matching an identifier as a whole — leftmost-longest, non-overlapping — removes it
before any later stage can see the digits inside it.

**Stages 3 and 4 remove the other things that look numeric and are not**: GUIDs,
Azure resource ids, IP addresses and CIDR suffixes; then calendar dates, timestamps
and ISO 8601 durations, so the grain `PT1H` and the window bound `2026-07-01` are not
read as measurements.

**Stage 5 is the derived static-text allowlist** — see `verify/allowlist.py`, which
derives it afresh on every run rather than maintaining a list that would drift.

Everything still carrying a digit after stage 5 is a survivor, and every survivor is
one blocking finding. That is the control the whole product rests on: a model that
wrote a number into its prose put a numeric string in the document that is in neither
the ledger nor the chrome, and it survives every stage.
"""

from __future__ import annotations

import re
from collections.abc import Iterable, Mapping, Sequence
from typing import Final

from reporting_agent.verify.findings import (
    FINDING_UNMATCHED_PROSE_TOKEN,
    Finding,
    record_finding,
)
from reporting_agent.verify.tokens import (
    PART_BODY,
    ExtractedParagraph,
)

__all__ = [
    "MASK_CHAR",
    "STAGE_ALLOWLIST",
    "STAGE_DATES",
    "STAGE_IDENTIFIERS",
    "STAGE_LEDGER",
    "STAGE_STRUCTURED",
    "Survivor",
    "mask_paragraph",
    "masking_order",
    "scan_paragraphs",
    "survivors_in",
]

MASK_CHAR: Final[str] = "\u0007"
"""Not a decimal digit and not `\\w`, so a masked span matches no later stage."""

STAGE_LEDGER: Final[int] = 1
STAGE_IDENTIFIERS: Final[int] = 2
STAGE_STRUCTURED: Final[int] = 3
STAGE_DATES: Final[int] = 4
STAGE_ALLOWLIST: Final[int] = 5

_DIGIT: Final[re.Pattern[str]] = re.compile(r"\d")

# Stage 2 — a figure never begins with a letter or an underscore.
#
# The lookbehind is load-bearing, not tidiness. Without it the pattern matches any
# letter-initial *substring*, so in the GUID `550e8400-e29b-41d4-a716-446655440000` it
# matches from the `e` of `e8400`, masks the rest of the GUID, and leaves `550` behind
# as a survivor — a blocking finding on a document whose only crime was quoting a
# subscription id. IPv6 fails the same way at `0db8`. Requiring the match to begin at
# a token boundary makes stage 2 match identifiers rather than fragments, which is what
# "identifier" meant all along, and leaves the structured values intact for stage 3.
_IDENTIFIER: Final[re.Pattern[str]] = re.compile(
    r"(?<![\w.\-])[A-Za-z_][\w.\-]*[0-9][\w.\-]*"
)

# Stage 3 — alternatives ordered longest-first, because Python's alternation is
# leftmost-*first* rather than leftmost-longest: an IPv4 pattern placed before the
# CIDR form would match the address and leave `/16` behind as a survivor.
_STRUCTURED: Final[re.Pattern[str]] = re.compile(
    "|".join(
        (
            r"/subscriptions/\S+",  # an Azure resource id, to its first whitespace
            r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}",  # GUID
            r"(?:[0-9a-fA-F]{0,4}:){2,7}[0-9a-fA-F]{0,4}(?:/\d{1,3})?",  # IPv6 (+CIDR)
            r"\d{1,3}(?:\.\d{1,3}){3}/\d{1,2}",  # IPv4 CIDR, before bare IPv4
            r"\d{1,3}(?:\.\d{1,3}){3}",  # IPv4
        )
    )
)

# Stage 4 — timestamp before date before time, so the longest form wins at a position.
_TEMPORAL: Final[re.Pattern[str]] = re.compile(
    "|".join(
        (
            r"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?",
            r"\d{4}-\d{2}-\d{2}",
            r"\d{2}:\d{2}(?::\d{2})?",
            # An ISO 8601 duration, requiring at least one component so a bare `P`
            # or a stray `PT` matches nothing.
            r"P(?=\d|T\d)(?:\d+[YMWD])*(?:T(?:\d+(?:\.\d+)?[HMS])+)?",
        )
    )
)


class Survivor(str):
    """A numeric-bearing substring that survived every stage, with where it was.

    A `str` subclass so a caller can compare and print it directly while the location
    rides along — the finding builder needs both, and a bare tuple at every call site
    reads worse than the thing itself.
    """

    __slots__ = ("block_id", "offset", "ordinal", "region")

    block_id: str | None
    region: str
    ordinal: int
    offset: int

    def __new__(
        cls,
        text: str,
        *,
        block_id: str | None,
        region: str,
        ordinal: int,
        offset: int,
    ) -> Survivor:
        self = super().__new__(cls, text)
        self.block_id = block_id
        self.region = region
        self.ordinal = ordinal
        self.offset = offset
        return self


def masking_order(strings: Iterable[str]) -> tuple[str, ...]:
    """Longest first, ties by ascending code-point sequence (Req 28.2).

    Blank strings are dropped: an empty literal would match at every position and mask
    nothing, and a whitespace-only one cannot appear inside a whitespace-delimited
    token anyway.
    """
    return tuple(sorted({s for s in strings if s.strip()}, key=lambda s: (-len(s), s)))


# A character that can be part of a figure's or an identifier's body. An occurrence
# touching one of these on either side is a fragment of a longer token, not an
# occurrence of the literal.
#
# Alphanumerics are obvious. The rest are the characters that continue a numeric or
# identifier token in this product's output: `.` and `,` are decimal and grouping
# separators (so masking `2` inside `2.00units` is blocked by the following `.`), `%`
# is a unit suffix (so `34.2` cannot mask out of `34.2%`), and `-` `_` `/` `:` continue
# identifiers, resource ids, CIDR suffixes, dates and times.
#
# Brackets, quotes and whitespace are deliberately absent, which is what lets a figure
# wrapped in punctuation — `(34.2%)` — mask cleanly.
_TOKEN_BODY: Final[re.Pattern[str]] = re.compile(r"[0-9A-Za-z.,%\-_/:]")


def _bounded(text: str, start: int, end: int) -> bool:
    """Is `text[start:end]` an occurrence bounded by non-alphanumeric characters?

    This is what "exact equality" means for a literal embedded in prose (Req 28.2,
    28.6), and it is not a refinement — it is the difference between a working gate and
    a broken one.

    A plain substring search masks a literal *anywhere* it appears. An allowlist
    legitimately derived from the chrome string `page 2 of 14` contains `2`, and a
    plain search then punches that `2` out of every unrelated token in the document:
    `1.02units` becomes `1.0␇units`, which is reported as a mangled survivor, and a
    model's invented `12%` masks away to nothing under an allowlist holding `1` and
    `2` — the delivery gate silently missing the one thing it exists to catch.

    Bounding also makes stage 1 correct independently of its ordering: the `12.4%`
    inside `112.4%` is preceded by a digit, so it cannot match there at all. The
    longest-first order still stands, because two entries can both be bounded at
    overlapping positions, but the shadowing case no longer depends on it alone.

    `MASK_CHAR` is deliberately outside the class below, so an already-masked
    neighbour never blocks a later match.
    """
    before = text[start - 1] if start > 0 else ""
    after = text[end] if end < len(text) else ""
    return not _TOKEN_BODY.match(before) and not _TOKEN_BODY.match(after)


def _mask_literals(buffer: list[str], literals: Sequence[str]) -> None:
    """Overwrite every bounded occurrence of every literal, in the order given."""
    for literal in literals:
        text = "".join(buffer)
        start = text.find(literal)
        while start != -1:
            end = start + len(literal)
            if _bounded(text, start, end):
                for index in range(start, end):
                    buffer[index] = MASK_CHAR
                text = "".join(buffer)
            start = text.find(literal, end)


def _mask_pattern(buffer: list[str], pattern: re.Pattern[str]) -> None:
    """Overwrite every non-overlapping match, leftmost first."""
    for match in pattern.finditer("".join(buffer)):
        for index in range(match.start(), match.end()):
            buffer[index] = MASK_CHAR


def mask_paragraph(
    text: str,
    *,
    ledger_strings: Sequence[str],
    allowlist: Sequence[str],
) -> str:
    """Run the five stages over `text`, returning the overwritten buffer.

    Pure and total: the same input and the same two vocabularies produce the same
    output on every call, which is what Property 2's idempotence clause pins.
    """
    buffer = list(text)
    _mask_literals(buffer, ledger_strings)  # stage 1
    _mask_pattern(buffer, _IDENTIFIER)  # stage 2
    _mask_pattern(buffer, _STRUCTURED)  # stage 3
    _mask_pattern(buffer, _TEMPORAL)  # stage 4
    _mask_literals(buffer, allowlist)  # stage 5
    return "".join(buffer)


def survivors_in(
    paragraph: ExtractedParagraph,
    *,
    ledger_strings: Sequence[str],
    allowlist: Sequence[str],
    scoped_ordinal: int,
) -> tuple[Survivor, ...]:
    """Every maximal whitespace-delimited token still carrying a digit.

    The token is located on the **masked** buffer and its text is sliced from the
    **original** paragraph, because offsets are stable across masking and a reader
    debugging a finding wants the characters that are actually in the document, not a
    row of control characters.
    """
    masked = mask_paragraph(
        paragraph.text, ledger_strings=ledger_strings, allowlist=allowlist
    )
    found: list[Survivor] = []
    for match in re.finditer(r"\S+", masked):
        if _DIGIT.search(match.group()) is None:
            continue
        found.append(
            Survivor(
                paragraph.text[match.start() : match.end()],
                block_id=paragraph.block_id,
                region=paragraph.part,
                ordinal=scoped_ordinal,
                offset=match.start(),
            )
        )
    return tuple(found)


def scan_paragraphs(
    paragraphs: Iterable[ExtractedParagraph],
    *,
    ledger_strings: Iterable[str],
    allowlist: Iterable[str],
) -> tuple[Finding, ...]:
    """One `unmatched_prose_token` finding per survivor, over every paragraph.

    Applied to **every** paragraph the extractor returned irrespective of which block
    authored it (Req 28.13) — inside data tables, inside layout tables, in headers and
    in footers — because a model's invented number is no less invented for appearing
    in a footer.

    Ordinals are 1-based **within the scope the finding names**: within the block for a
    paragraph inside a captioned table, within the region otherwise (Req 28.12). The
    extractor's own ordinal is document-wide and stable, which is the right identity
    for an extraction but the wrong one for a reader being told where to look; this is
    the only place the two differ, and it is derived here rather than carried on
    `ExtractedParagraph` because it is a property of the report, not of the document.
    """
    ledger_order = masking_order(ledger_strings)
    allowlist_order = masking_order(allowlist)

    counters: dict[tuple[str | None, str], int] = {}
    findings: list[Finding] = []

    for paragraph in paragraphs:
        scope = (paragraph.block_id, paragraph.part)
        counters[scope] = counters.get(scope, 0) + 1
        if not paragraph.text:
            continue
        for survivor in survivors_in(
            paragraph,
            ledger_strings=ledger_order,
            allowlist=allowlist_order,
            scoped_ordinal=counters[scope],
        ):
            locating: dict[str, object] = {
                "substring": str(survivor),
                "paragraph_ordinal": survivor.ordinal,
            }
            if survivor.block_id is not None:
                locating["block_id"] = survivor.block_id
            else:
                locating["region"] = survivor.region
            findings.append(
                record_finding(
                    FINDING_UNMATCHED_PROSE_TOKEN,
                    (
                        f"a numeric token survived every masking stage in "
                        f"{survivor.block_id or survivor.region} "
                        f"paragraph {survivor.ordinal}"
                    ),
                    **locating,
                )
            )
    return tuple(findings)


def ledger_strings_of(ledger: Mapping[str, object] | Iterable[object]) -> tuple[str, ...]:
    """Every `formatted` string a ledger carries, in masking order.

    Accepts either a mapping of entries or an iterable of them, so a caller holding a
    `FigureLedger` and a caller holding a plain list of entries use the same helper
    rather than each growing their own extraction.
    """
    entries: Iterable[object]
    entries = ledger.values() if isinstance(ledger, Mapping) else ledger
    formatted: list[str] = []
    for entry in entries:
        value = getattr(entry, "formatted", None)
        if value is None and isinstance(entry, Mapping):
            value = entry.get("formatted")
        if isinstance(value, str):
            formatted.append(value)
    return masking_order(formatted)


# Re-exported so a caller importing the scanner does not also have to import the
# extractor's part constants to build a region label.
DEFAULT_REGION: Final[str] = PART_BODY
