"""`format_figure` — the **only** operation in the runtime that turns a value into a
display string (Req 18.1).

Every numeral in a delivered `.docx`, in the PDF converted from it, in the HTML preview
and in an in-app chart label comes out of this one function. That is not a style
preference; it is what the verifier's soundness pass rests on. The verifier extracts
numeric tokens from the rendered document and requires each to equal a `formatted` value
in the figure ledger, character for character. A second formatting path — a renderer
appending its own unit, a chart library choosing its own separator, a template composing
`f"{value}%"` — produces a token that matches nothing, and the report is withheld for a
number that was actually correct.

So the surface here is deliberately narrow and deliberately total: one function, no
optional behaviour, and a refusal rather than a fallback wherever the inputs do not
determine an answer.

## The catalog scale is a floor a style preference may not cut into (Req 18.4)

Display scale is `max(number_format.decimal_places, catalog_scale)`.

Precision is a property of the **measurement**, not of a template's taste. A CPU
percentage the catalog declares at two fractional digits was measured to two, so a
template asking for zero does not get to publish `12%` for a value that is `12.48` — the
setting adds zeros where it asks for more and is **ignored** where it asks for less. The
grouping flag and both separators, by contrast, are pure presentation and apply
unconditionally.

There is a second, quieter reason the floor matters: the snapshot stored the value at
exactly the catalog scale, so a display scale at or above it means quantization here only
ever *pads*. Round-tripping the emitted digits therefore reproduces the stored value
exactly, which is what lets `Figure.value` (provenance, at the collector's scale) and
`Figure.formatted` (presentation, at the display scale) both be checked against the same
snapshot position.

## Rounding: half away from zero, one mode for everything

`ROUND_HALF_UP` in `decimal`'s vocabulary. One mode for every value, every unit and
every number format, so two runs over one snapshot cannot disagree.

**This is deliberately a different mode from `collect/snapshot.py`'s `decimal_string`,
which rounds half to even, and the two must not be unified.** They are two quantizations
with two jobs: the snapshot's decides the bytes a content address is taken over, and
banker's rounding is the right neutral choice for an aggregate; this one decides what a
human reads, where "round half up" is the convention a reader expects and the one a
spreadsheet would have produced. Because the display scale is at or above the stored
scale, the modes cannot actually disagree on a snapshot-sourced value — but the compiler
also formats *computed* values (a run-to-run delta), and there the mode is load-bearing.

## No float, anywhere on the path

Not a single `float()`, and no `Decimal(float)`. A binary approximation entering here
would produce a `formatted` string that differs by one digit between two machines, and
verification would fail on a report that is correct — the failure mode that is worst of
all, because it looks like a data problem.

## Refusals, and why there is no default scale

A value that is neither a `Decimal` nor a fixed-precision decimal string produces **no
string at all**, and neither does a metric for which the catalog declares no
fractional-digit count. Both fail the run with the AST path named, applying no default
(Req 18.9, 18.11).

A default scale is the tempting one, and it is the wrong answer: publishing a figure at
a guessed precision is publishing a claim about how well something was measured, on the
basis of nothing. The catalog is code shipped in the image, so a metric with no declared
scale is a bug to surface at the path that hit it, not a gap to paper over.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation, localcontext
from typing import Final

from reporting_agent.catalog.loader import MAX_SCALE, MIN_SCALE
from reporting_agent.compile.snapshot_view import DECIMAL_STRING_PATTERN
from reporting_agent.errors import CompileFailedError

__all__ = [
    "DEFAULT_NUMBER_FORMAT",
    "MAX_DECIMAL_PLACES",
    "MIN_DECIMAL_PLACES",
    "UNIT_PRESENTATION",
    "NumberFormat",
    "display_scale",
    "format_figure",
    "format_text_fact",
    "number_format_from_definition",
    "unit_suffix",
]

MIN_DECIMAL_PLACES: Final[int] = 0
MAX_DECIMAL_PLACES: Final[int] = 3
"""Req 7.2's bound on a template's `number_format.decimal_places`, mirrored from
`compile/definition.py`. Checked here as well, because this function is reachable with a
number format the definition validator never saw — a delta compiled from two runs, for
instance."""

_GROUP_SIZE: Final[int] = 3

UNIT_PRESENTATION: Final[tuple[tuple[str, str], ...]] = (
    ("percent", "%"),
    ("bytes", " bytes"),
    ("count_per_second", "/s"),
    ("count", ""),
    ("days", " days"),
)
"""How each declared unit reads immediately after its digits.

**Inside** the string this function returns, never appended by a consumer. That is the
requirement (Req 18.6) and the reason is mechanical: the verifier compares a document
token against `formatted` by exact equality, so a renderer that emitted the digits and
added its own `%` would produce a token no ledger entry matches, and the run would be
withheld for a correct number.

`count` presents as nothing at all — a vCPU count reads as `2`, not `2 count`. Declared
explicitly rather than defaulted, so the absence is a decision on the record.

`count` and `days` are here for the **facts** half of the catalog, whose declared units are
not the metric ones (`catalog/loader.py`'s `DECLARED_FACT_UNITS`): a fact is never sketched,
so it has no `count_per_second`, and a metric is never a duration in days.

**`days` does not agree in number, deliberately.** A retention of one day reads `1 days`,
the same way one byte already reads `1 bytes` above. Both are the consequence of the rule
that makes the ledger checkable: this module is the *only* place a figure becomes a string
(Req 18.6), the verifier matches that string by exact equality, and a pluralization branch
would be a second formatting decision — one that would also have to be right in Indonesian,
which does not pluralize at all. A grammatically tidy figure the verifier cannot match is
worse than an ungrammatical one it can.

A `tuple` of pairs rather than a `dict`: scanned in a declared order, and nothing on this
path iterates a hash-ordered container."""

_PERCENTILE_TOKEN_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\bp\d+\b|\bpercentile\b", re.IGNORECASE
)
"""A bare percentile designation. Req 18.10: none may survive in a `formatted` string
outside the estimator label, because an unqualified `p95` asserts a measurement the
platform does not provide."""


@dataclass(frozen=True, slots=True)
class NumberFormat:
    """A template's number presentation (Req 7.2).

    All four fields come from the definition's `design.number_format`, conditionally on
    its `schema_version`: at version 2 the definition declares `decimal_separator` and
    `grouping_separator` alongside `decimal_places` and `group_thousands`, and at
    version 1 it declares only the first two and the separators are defaulted from
    `identity.language` — which is `en` at version 1, which is this class's own defaults,
    so a stored version 1 definition renders byte-identically to the way it always did
    (Req 16.3, 16.10). Property 1 exercises every combination.
    """

    decimal_places: int = 1
    group_thousands: bool = True
    decimal_separator: str = "."
    grouping_separator: str = ","

    def __post_init__(self) -> None:
        if (
            isinstance(self.decimal_places, bool)
            or not isinstance(self.decimal_places, int)
            or not MIN_DECIMAL_PLACES <= self.decimal_places <= MAX_DECIMAL_PLACES
        ):
            raise CompileFailedError(
                f"number_format.decimal_places must be an integer from "
                f"{MIN_DECIMAL_PLACES} to {MAX_DECIMAL_PLACES}, got "
                f"{self.decimal_places!r}"
            )
        if not isinstance(self.group_thousands, bool):
            raise CompileFailedError(
                f"number_format.group_thousands must be a boolean, got "
                f"{self.group_thousands!r}"
            )
        for name, separator in (
            ("decimal_separator", self.decimal_separator),
            ("grouping_separator", self.grouping_separator),
        ):
            if not isinstance(separator, str) or not separator:
                raise CompileFailedError(
                    f"number_format.{name} must be a non-empty string, got "
                    f"{separator!r}"
                )
            if any(character.isdigit() or character == "-" for character in separator):
                raise CompileFailedError(
                    f"number_format.{name} must contain no digit and no minus sign, got "
                    f"{separator!r}: a separator that could be read as part of the "
                    f"number makes the verifier's token extraction ambiguous"
                )
            # `str.isspace()` rather than an explicit set (Req 16.2): the set that has to
            # be caught is every character the two whitespace-splitting readers named
            # below treat as a break, and that is Unicode's, not ASCII's — a thin space
            # (U+2009) and a no-break space (U+00A0) are the separators a European number
            # format actually reaches for, and both would pass an `== " "` check and any
            # hand-written list that forgot them. An explicit set is also a list that goes
            # stale as Unicode grows, against a predicate that does not.
            #
            # The mirror obligation this puts on `app/lib/templates/definition.ts` in task
            # 7.1: bare `/\s/u` is **not** this set. JavaScript's `\s` misses `\x1c`-`\x1f`
            # and `\x85`, which `str.isspace()` is true for, so the app would save a
            # separator this constructor then refuses — a save-time error turned into a
            # failed run. Use `/[\s\x1c-\x1f\x85]/u`. The one residual difference,
            # `\ufeff` (matched by `\s`, not by `isspace()`), errs the safe way: the app
            # refuses it, so it never reaches here.
            if any(character.isspace() for character in separator):
                raise CompileFailedError(
                    f"number_format.{name} must contain no whitespace, got "
                    f"{separator!r}: `verify/tokens.numeric_tokens` splits a paragraph on "
                    f"whitespace, so a whitespace-separated numeral reaches the verifier "
                    f"as several tokens none of which equals the ledger's formatted "
                    f"string, and `normalize_pdf_text` collapses every whitespace run to "
                    f"one space, so the .pdf pass cannot locate it either — the run would "
                    f"be withheld for a number that was correct"
                )
        if self.decimal_separator == self.grouping_separator:
            raise CompileFailedError(
                f"number_format's decimal and grouping separators are both "
                f"{self.decimal_separator!r}; a reader could not tell one from the other"
            )


DEFAULT_NUMBER_FORMAT: Final[NumberFormat] = NumberFormat()
"""One decimal place, grouped thousands, `.` and `,` — the shape
`lib/templates/starters.ts` writes and the fallback for a caller that has no template
number format to hand (a preflight probe, a compare command reading two runs whose
templates disagree)."""

# Req 16.3 — the separators each language implies when the definition declares none.
# Duplicated from `compile/definition.SEPARATOR_DEFAULTS` to avoid a circular import:
# `definition.py` imports this module for `NumberFormat` and `DEFAULT_NUMBER_FORMAT`.
_SEPARATOR_DEFAULTS: Final[dict[str, tuple[str, str]]] = {
    "en": (".", ","),
    "id": (",", "."),
}
_DEFAULT_LANGUAGE: Final[str] = "en"


def number_format_from_definition(
    raw_number_format: object,
    *,
    language: str | None = None,
) -> NumberFormat:
    """Build a `NumberFormat` from the pinned definition's `design.number_format` (Req 16.4).

    Resolves the declared separators when they are present and fills from the language's
    defaults when they are absent (Req 16.3). A `schema_version` 1 definition declares no
    separators and no language, so both absent values resolve from `en`, which is
    `DEFAULT_NUMBER_FORMAT`'s own pair — rendering byte-identically to the way it always did
    (Req 16.10).

    A `schema_version` 2 definition declares both separators explicitly (or has them
    defaulted by the definition validator from its `identity.language`). When the stored
    definition carries them they are used as-is; when it does not, language defaults apply.

    Re-verification reads `number_format` from the run's **pinned** template version rather
    than from the template's current definition, so a later separator edit leaves an archived
    report verifying exactly as delivered (Req 16.12).
    """
    from collections.abc import Mapping

    resolved_language = language if language in _SEPARATOR_DEFAULTS else _DEFAULT_LANGUAGE
    decimal_default, grouping_default = _SEPARATOR_DEFAULTS[resolved_language]

    if not isinstance(raw_number_format, Mapping):
        return NumberFormat(
            decimal_separator=decimal_default,
            grouping_separator=grouping_default,
        )

    decimal_separator = raw_number_format.get("decimal_separator")
    if not isinstance(decimal_separator, str) or not decimal_separator:
        decimal_separator = decimal_default

    grouping_separator = raw_number_format.get("grouping_separator")
    if not isinstance(grouping_separator, str) or not grouping_separator:
        grouping_separator = grouping_default

    # If the resolved pair conflicts (equal separators), fall back to language defaults.
    # In production this cannot happen: the definition validator rejects equal separators
    # before a definition is saved. This guard exists for robustness against corrupted or
    # hand-edited data that bypassed validation.
    if decimal_separator == grouping_separator:
        decimal_separator = decimal_default
        grouping_separator = grouping_default

    return NumberFormat(
        decimal_places=int(raw_number_format.get("decimal_places", 1)),
        group_thousands=bool(raw_number_format.get("group_thousands", True)),
        decimal_separator=decimal_separator,
        grouping_separator=grouping_separator,
    )


def unit_suffix(unit: str, *, at: str) -> str:
    """How `unit` reads after its digits, or a refusal.

    An unrecognised unit is a refusal rather than an empty suffix, on the same reasoning
    as the missing catalog scale: publishing a bare number for a quantity whose unit
    nobody declared is publishing an unreadable figure, and the catalog is code.
    """
    for declared, suffix in UNIT_PRESENTATION:
        if declared == unit:
            return suffix
    raise CompileFailedError(
        f"{at}: unit {unit!r} has no declared presentation. Every unit a figure can "
        f"carry needs one here, because the unit travels inside the `formatted` string "
        f"the verifier matches; declared units are "
        f"{[declared for declared, _ in UNIT_PRESENTATION]}."
    )


def display_scale(number_format: NumberFormat, catalog_scale: int, *, at: str) -> int:
    """`max(number_format.decimal_places, catalog_scale)` (Req 18.4).

    The catalog scale is a **floor**. A template asking for fewer digits than the
    measurement carries is ignored; asking for more adds zeros.
    """
    if (
        isinstance(catalog_scale, bool)
        or not isinstance(catalog_scale, int)
        or not MIN_SCALE <= catalog_scale <= MAX_SCALE
    ):
        raise CompileFailedError(
            f"{at}: the Metric_Catalog declares no usable fractional-digit count for "
            f"this value (got {catalog_scale!r}). No default scale is applied — "
            f"publishing a figure at a guessed precision is a claim about how well "
            f"something was measured, made on the basis of nothing."
        )
    return max(number_format.decimal_places, catalog_scale)


def _as_decimal(value: object, *, at: str) -> Decimal:
    """`value` as a `Decimal`, from a `Decimal` or a fixed-precision decimal string.

    A `float` is refused, not converted: `Decimal(1.1)` is
    `1.100000000000000088817841970012523233890533447265625`, and a figure formatted from
    that would differ between two machines in a way that fails verification on a correct
    report. An `int` is refused too — every quantity on this path arrives as the
    snapshot's decimal string or as `Decimal` arithmetic over one, so an `int` means a
    cardinality reached a figure position.
    """
    if isinstance(value, Decimal):
        if not value.is_finite():
            raise CompileFailedError(
                f"{at}: a figure's value must be finite; NaN and Infinity have no "
                f"decimal string and no place in an audit artifact"
            )
        return value
    if isinstance(value, str) and DECIMAL_STRING_PATTERN.match(value):
        return Decimal(value)
    raise CompileFailedError(
        f"{at}: a figure's value must be a Decimal or a fixed-precision decimal string, "
        f"got {type(value).__name__}. No float is constructed anywhere on this path — a "
        f"binary approximation would produce a display string that differs between two "
        f"machines and fail verification on a correct report."
    )


def _quantize(value: Decimal, scale: int, *, at: str) -> Decimal:
    """`value` at exactly `scale` fractional digits, rounding half away from zero.

    Deliberately **not** `collect/snapshot.py`'s `decimal_string`, which rounds half to
    even: that one decides the bytes a content address is taken over, where banker's
    rounding is the right neutral choice for an aggregate. This one decides what a human
    reads. See the module docstring; unifying them would make one of the two wrong.

    A local context wide enough for the integer part plus the scale, so a byte count near
    `10^15` at scale 0 does not raise `InvalidOperation` for want of precision.
    """
    integer_digits = max(value.adjusted() + 1, 1)
    try:
        with localcontext() as context:
            context.prec = integer_digits + scale + 2
            return value.quantize(Decimal(1).scaleb(-scale), rounding=ROUND_HALF_UP)
    except InvalidOperation as exc:  # pragma: no cover - the context above prevents this
        raise CompileFailedError(f"{at}: {value} cannot be shown at {scale} digits: {exc}") from exc


def _render_digits(value: Decimal, scale: int, number_format: NumberFormat) -> str:
    """The quantized value as digits with the template's separators.

    `format(value, "f")` is the plain-notation renderer — `Decimal.__str__` emits
    scientific notation for a far-from-zero exponent, and `1E+3` where another run wrote
    `1000` is two spellings of one quantity in a document that is supposed to be
    comparable to itself.

    Negative zero is folded to zero: a tiny negative quantity quantizes to `-0.0`, which
    would be a second spelling of zero and therefore a second token for one measurement.
    """
    if value == 0:
        value = abs(value)

    plain = f"{value:f}"
    negative = plain.startswith("-")
    if negative:
        plain = plain[1:]

    integer_part, _, fraction = plain.partition(".")

    if number_format.group_thousands and len(integer_part) > _GROUP_SIZE:
        groups: list[str] = []
        remaining = integer_part
        while len(remaining) > _GROUP_SIZE:
            groups.append(remaining[-_GROUP_SIZE:])
            remaining = remaining[:-_GROUP_SIZE]
        groups.append(remaining)
        integer_part = number_format.grouping_separator.join(reversed(groups))

    rendered = integer_part
    if scale > 0:
        rendered = f"{integer_part}{number_format.decimal_separator}{fraction}"

    return f"-{rendered}" if negative else rendered


def format_text_fact(value: str, *, at: str) -> str:
    """The display string for one text fact: `value`, character for character (Req 6.12).

    No case folding, no truncation, no separator substitution, no trimming, and **no
    resolution against the Message_Catalog**. `Succeeded` reaches an Indonesian document as
    `Succeeded`, because a fact's value is **collected data** and not fixed copy — the two
    are different kinds of string and only one of them is translatable. `Berhasil` in that
    cell would be a value Azure never returned, sitting in a position the verifier compares
    against what Azure did return, so it would fail verification for a document that was
    otherwise correct; and if the verifier translated too, the pair would agree with each
    other about a value neither of them collected.

    A function rather than an inline pass-through, and that is the whole reason it exists.
    `formatted` is then assigned in exactly **one** module for both entry kinds, so rule 7
    in `tests/test_boundaries.py` covers text facts by the same mechanism it covers figures
    — and this module is the one place a reviewer looks to see whether a display string can
    be transformed. An inline `formatted=fact.value` at the call site would be a second
    display path that happens to be the identity today.

    `at` describes the position for a refusal, and is passed rather than composed here
    because the caller knows whether it holds an AST path or a snapshot pointer.

    Refuses a non-`str` and an empty string rather than defaulting, matching
    :func:`format_figure`: an empty display string is a cell a reader sees as absent data,
    and a non-string is a value that reached the text side of the compiler through a path
    that should not exist.
    """
    if not isinstance(value, str):
        raise CompileFailedError(
            f"{at}: a text fact's value must be a str, got {type(value).__name__}. "
            f"A quantity belongs on a Figure, which carries the provenance a number needs."
        )
    if not value:
        raise CompileFailedError(
            f"{at}: a text fact's value is empty, so there is no display string to emit. "
            f"An absent fact is a recorded gap, not a blank cell."
        )
    return value


def format_figure(
    value: object,
    *,
    unit: str,
    catalog_scale: int,
    number_format: NumberFormat = DEFAULT_NUMBER_FORMAT,
    estimator_label: str | None = None,
    path: str,
) -> str:
    """The display string for one figure — the only place a value becomes one.

    `path` is the AST path of the figure being formatted and appears in every refusal, so
    a failure names the position in the document rather than the value that caused it.

    The result is `<digits><unit suffix>` plus, for an estimated value,
    ` (<estimator label>)`:

    * `12.5%`
    * `8,589,934,592 bytes`
    * `68.4% (p95, est. from hourly averages)`

    The estimator label is composed by `compile/estimators.py` and carries **no numeral**,
    so the whole string has exactly one source of digits.
    """
    at = f"figure {path!r}"

    scale = display_scale(number_format, catalog_scale, at=at)
    suffix = unit_suffix(unit, at=at)
    quantized = _quantize(_as_decimal(value, at=at), scale, at=at)
    rendered = f"{_render_digits(quantized, scale, number_format)}{suffix}"

    if estimator_label is not None:
        if not isinstance(estimator_label, str) or not estimator_label:
            raise CompileFailedError(
                f"{at}: estimator_label must be None or a non-empty string, got "
                f"{estimator_label!r}"
            )
        if _PERCENTILE_TOKEN_PATTERN.search(rendered):
            raise CompileFailedError(
                f"{at}: the value's own presentation {rendered!r} already reads as a "
                f"percentile designation"
            )
        return f"{rendered} ({estimator_label})"

    # Req 18.10 — with no label there is nothing to qualify a percentile, so a bare
    # designation surviving here would be exactly the unqualified `p95` the document must
    # be incapable of carrying.
    if _PERCENTILE_TOKEN_PATTERN.search(rendered):
        raise CompileFailedError(
            f"{at}: {rendered!r} carries a bare percentile designation and no estimator "
            f"label. A percentile reconstructed from coarser intervals runs well below "
            f"the true value, so it may not appear unqualified."
        )

    return rendered
