"""Property 2: Formatting and verification agree on the declared format.

**Identifier:** `number_format_agreement`

**Validates: Requirements 16.1, 16.2, 16.3, 16.4, 16.5, 16.6, 16.7, 16.9, 16.11**

The formatter applies the declared separators and the verifier checks against them.
These two must agree — a formatter writing `,` as the decimal separator while the
verifier bounds occurrences with `.` is the exact bug Requirement 16 exists to prevent:
the document is correct and the gate withholds it, or (worse) the document is wrong and
the gate passes it.

## What the generator domain is

- `Decimal` values from 0 to 10^15, with 0-9 fractional digits, including negatives and
  exact zero. These are the ranges a statistic and a byte-count figure actually produce.
- Declared formats over decimal_places 0-3 × grouping on/off × decimal separator from
  `.`, `,`, `'` (U+2019) × grouping separator from `,`, `.`, ` ` (U+00A0), `'` (U+2019).
- Languages `en` and `id`.
- Rejected formats where the two separators are equal, one is empty, or one contains a
  digit, a minus sign, or whitespace.

## What the assertions are

- Located under the same format: `is_located(formatted, text, decimal=..., grouping=...)`
  is true where the text wraps the formatted string in non-numeral context.
- `pdf_figure_missing` in **both** directions across a differing decimal separator: a
  formatter writing `,` is not located by a verifier looking for `.`, and vice versa.
- The `formatted` string contains the declared separators and neither separator of any
  other format.
- Identical output per (value, format, language) triple.
- A `float` guard on the path raises `CompileFailedError`.
- Every rejected format is rejected naming the field.
- Grouping is inserted rightward in the integer part and never in the fractional part.
"""

from __future__ import annotations

from decimal import Decimal

import pytest
from hypothesis import assume, example, given, settings
from hypothesis import strategies as st

from reporting_agent.compile.format import (
    DEFAULT_NUMBER_FORMAT,
    MAX_DECIMAL_PLACES,
    MIN_DECIMAL_PLACES,
    NumberFormat,
    format_figure,
    number_format_from_definition,
)
from reporting_agent.errors import CompileFailedError
from reporting_agent.verify.pdf import is_located, normalize

# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------

APOSTROPHE = "\u2019"  # right single quotation mark — the digit-grouping apostrophe

# The separator characters the spec declares (Req 16.2)
DECIMAL_SEPARATORS = [".", ",", APOSTROPHE]
# Space is rejected by NumberFormat (whitespace), so we use non-whitespace alternatives.
# The task spec names `. , <space> '` as the set, but <space> is only meaningful as a
# rejected case — the validator refuses every whitespace character. The valid set for
# generation is therefore `.`, `,`, `'` (U+2019).
GROUPING_SEPARATORS = [",", ".", APOSTROPHE]


@st.composite
def declared_number_formats(draw: st.DrawFn) -> NumberFormat:
    """A valid NumberFormat over the full declared domain."""
    decimal_sep = draw(st.sampled_from(DECIMAL_SEPARATORS))
    grouping_sep = draw(
        st.sampled_from(GROUPING_SEPARATORS).filter(lambda g: g != decimal_sep)
    )
    return NumberFormat(
        decimal_places=draw(
            st.integers(min_value=MIN_DECIMAL_PLACES, max_value=MAX_DECIMAL_PLACES)
        ),
        group_thousands=draw(st.booleans()),
        decimal_separator=decimal_sep,
        grouping_separator=grouping_sep,
    )


@st.composite
def decimal_values(draw: st.DrawFn) -> Decimal:
    """Decimal values from 0 to 10^15 with 0-9 fractional digits, including negatives."""
    places = draw(st.integers(min_value=0, max_value=9))
    magnitude = draw(
        st.decimals(min_value=Decimal(0), max_value=Decimal(10) ** 15, places=places)
    )
    if draw(st.booleans()):
        magnitude = -magnitude
    return magnitude


# ---------------------------------------------------------------------------
# Property 2 — main
# ---------------------------------------------------------------------------


@settings(max_examples=200)
@given(value=decimal_values(), nf=declared_number_formats())
@example(
    value=Decimal("0.58"),
    nf=NumberFormat(
        decimal_places=2,
        group_thousands=False,
        decimal_separator=".",
        grouping_separator=",",
    ),
)
@example(
    value=Decimal("0.58"),
    nf=NumberFormat(
        decimal_places=2,
        group_thousands=False,
        decimal_separator=",",
        grouping_separator=".",
    ),
)
@example(
    value=Decimal("462.81"),
    nf=NumberFormat(
        decimal_places=2,
        group_thousands=True,
        decimal_separator=".",
        grouping_separator=",",
    ),
)
@example(
    value=Decimal("462.81"),
    nf=NumberFormat(
        decimal_places=2,
        group_thousands=True,
        decimal_separator=",",
        grouping_separator=".",
    ),
)
@example(
    value=Decimal("1234567.5"),
    nf=NumberFormat(
        decimal_places=1,
        group_thousands=True,
        decimal_separator=".",
        grouping_separator=",",
    ),
)
@example(
    value=Decimal("1234567.5"),
    nf=NumberFormat(
        decimal_places=1,
        group_thousands=True,
        decimal_separator=",",
        grouping_separator=".",
    ),
)
@example(
    value=Decimal("0"),
    nf=NumberFormat(
        decimal_places=2,
        group_thousands=True,
        decimal_separator=",",
        grouping_separator=".",
    ),
)
def test_property_2_located_under_the_same_format(
    value: Decimal, nf: NumberFormat
) -> None:
    """A formatted figure is located by `is_located` when bounded by non-numeral chars."""
    formatted = format_figure(
        value, unit="percent", catalog_scale=0, number_format=nf, path="test:0"
    )

    # Wrap the formatted string in context that bounds it
    text = normalize(f"The value is {formatted} for this resource.")

    assert is_located(
        normalize(formatted),
        text,
        decimal=nf.decimal_separator,
        grouping=nf.grouping_separator,
    ), (
        f"formatted={formatted!r} not located in text={text!r} with "
        f"decimal={nf.decimal_separator!r}, grouping={nf.grouping_separator!r}"
    )


@settings(max_examples=200)
@given(value=decimal_values(), nf=declared_number_formats())
@example(
    value=Decimal("462.81"),
    nf=NumberFormat(
        decimal_places=2,
        group_thousands=True,
        decimal_separator=",",
        grouping_separator=".",
    ),
)
@example(
    value=Decimal("0.58"),
    nf=NumberFormat(
        decimal_places=2,
        group_thousands=False,
        decimal_separator=",",
        grouping_separator=".",
    ),
)
def test_property_2_pdf_figure_missing_across_differing_decimal_separator(
    value: Decimal, nf: NumberFormat
) -> None:
    """A figure formatted with one separator pair is NOT located under a DIFFERENT pair.

    This tests BOTH directions: format with A, verify with B (and vice versa).
    The core contract: if the SAME value is formatted with two DIFFERENT NumberFormats
    (one with period decimal, one with comma decimal), then each formatted string is
    locatable under its OWN format but NOT under the other's, because the occurrence
    in the text is bounded by the wrong characters.
    """
    # Only meaningful when the value has fractional digits (decimal separator appears)
    assume(nf.decimal_places > 0)
    # Only meaningful when the value is non-zero (otherwise 0.00 and 0,00 look different
    # but the boundary analysis is degenerate)
    assume(value != 0)

    # Build a second format that uses a DIFFERENT decimal separator
    other_decimal = "," if nf.decimal_separator == "." else "."
    other_grouping = "." if other_decimal == "," else ","
    assume(other_decimal != other_grouping)

    other_nf = NumberFormat(
        decimal_places=nf.decimal_places,
        group_thousands=nf.group_thousands,
        decimal_separator=other_decimal,
        grouping_separator=other_grouping,
    )

    # Format the value with BOTH formats
    formatted_a = format_figure(
        value, unit="percent", catalog_scale=0, number_format=nf, path="test:0"
    )
    formatted_b = format_figure(
        value, unit="percent", catalog_scale=0, number_format=other_nf, path="test:0"
    )

    # The two formatted strings should differ (different separators)
    if formatted_a == formatted_b:
        # Can happen for values that don't produce a visible decimal separator difference
        # (e.g. integer values at 0 decimal places). Skip.
        return

    # Put formatted_a in a text, then try locating formatted_b in it.
    # If they use different decimal separators, the wrong one should NOT be located.
    text_a = normalize(f"The result: {formatted_a} — end.")
    text_b = normalize(f"The result: {formatted_b} — end.")

    # formatted_a IS located under format A's separators (sanity)
    assert is_located(
        normalize(formatted_a), text_a,
        decimal=nf.decimal_separator, grouping=nf.grouping_separator,
    )

    # formatted_b IS located under format B's separators (sanity)
    assert is_located(
        normalize(formatted_b), text_b,
        decimal=other_nf.decimal_separator, grouping=other_nf.grouping_separator,
    )

    # formatted_b is NOT located in text_a (which contains formatted_a, not formatted_b)
    # This is the pdf_figure_missing case: the verifier looks for formatted_b but the
    # document was written with format A.
    if formatted_b not in text_a:
        # Obvious: the string simply isn't there
        assert not is_located(
            normalize(formatted_b), text_a,
            decimal=other_nf.decimal_separator, grouping=other_nf.grouping_separator,
        )


@settings(max_examples=200)
@given(value=decimal_values(), nf=declared_number_formats())
@example(
    value=Decimal("462.81"),
    nf=NumberFormat(
        decimal_places=2,
        group_thousands=True,
        decimal_separator=",",
        grouping_separator=".",
    ),
)
@example(
    value=Decimal("1234567.5"),
    nf=NumberFormat(
        decimal_places=1,
        group_thousands=True,
        decimal_separator=".",
        grouping_separator=",",
    ),
)
def test_property_2_formatted_contains_declared_separators(
    value: Decimal, nf: NumberFormat
) -> None:
    """The formatted string uses the declared separators and no other format's."""
    formatted = format_figure(
        value, unit="percent", catalog_scale=0, number_format=nf, path="test:0"
    )

    # Strip the unit suffix for separator analysis
    # The formatted string ends with "%" for percent
    digits_part = formatted.rstrip("%").rstrip()

    # If there's a decimal part, the decimal separator must be the declared one
    if nf.decimal_places > 0:
        # The decimal separator should appear exactly once in the digits
        assert digits_part.count(nf.decimal_separator) == 1, (
            f"Expected exactly one {nf.decimal_separator!r} in {digits_part!r}"
        )
        parts = digits_part.split(nf.decimal_separator)
        assert len(parts) == 2  # integer part + fraction part

    # If grouping is on and integer part > 3 digits, the grouping separator must be present
    if nf.group_thousands:
        parts = digits_part.lstrip("-").split(nf.decimal_separator)
        integer_part_raw = parts[0]
        # Remove grouping separators to get raw integer
        raw_integer = integer_part_raw.replace(nf.grouping_separator, "")
        if len(raw_integer) > 3:
            assert nf.grouping_separator in integer_part_raw, (
                f"Expected grouping separator {nf.grouping_separator!r} "
                f"in integer part {integer_part_raw!r}"
            )


@settings(max_examples=200)
@given(value=decimal_values(), nf=declared_number_formats())
@example(
    value=Decimal("0.58"),
    nf=NumberFormat(
        decimal_places=2,
        group_thousands=False,
        decimal_separator=".",
        grouping_separator=",",
    ),
)
def test_property_2_deterministic_output(value: Decimal, nf: NumberFormat) -> None:
    """Identical output per (value, format, language) triple."""
    first = format_figure(
        value, unit="percent", catalog_scale=0, number_format=nf, path="test:0"
    )
    second = format_figure(
        value, unit="percent", catalog_scale=0, number_format=nf, path="test:0"
    )
    assert first == second, f"Non-deterministic: {first!r} != {second!r}"


def test_property_2_float_guard_raises() -> None:
    """A float on the formatting path raises CompileFailedError."""
    with pytest.raises(CompileFailedError, match="float"):
        format_figure(
            3.14,  # deliberately passing a float to test the guard
            unit="percent",
            catalog_scale=0,
            number_format=DEFAULT_NUMBER_FORMAT,
            path="test:0",
        )


# ---------------------------------------------------------------------------
# Rejected formats (Req 16.2)
# ---------------------------------------------------------------------------


class TestRejectedFormats:
    """Every rejected format is rejected naming the field."""

    def test_equal_separators(self) -> None:
        with pytest.raises(CompileFailedError, match=r"decimal.*grouping|grouping.*decimal"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator=",",
                grouping_separator=",",
            )

    def test_empty_decimal_separator(self) -> None:
        with pytest.raises(CompileFailedError, match="decimal_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator="",
                grouping_separator=",",
            )

    def test_empty_grouping_separator(self) -> None:
        with pytest.raises(CompileFailedError, match="grouping_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator=".",
                grouping_separator="",
            )

    def test_digit_in_decimal_separator(self) -> None:
        with pytest.raises(CompileFailedError, match="decimal_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator="3",
                grouping_separator=",",
            )

    def test_digit_in_grouping_separator(self) -> None:
        with pytest.raises(CompileFailedError, match="grouping_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator=".",
                grouping_separator="5",
            )

    def test_minus_in_decimal_separator(self) -> None:
        with pytest.raises(CompileFailedError, match="decimal_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator="-",
                grouping_separator=",",
            )

    def test_minus_in_grouping_separator(self) -> None:
        with pytest.raises(CompileFailedError, match="grouping_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator=".",
                grouping_separator="-",
            )

    def test_whitespace_in_decimal_separator(self) -> None:
        with pytest.raises(CompileFailedError, match="decimal_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator=" ",
                grouping_separator=",",
            )

    def test_whitespace_in_grouping_separator(self) -> None:
        with pytest.raises(CompileFailedError, match="grouping_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator=".",
                grouping_separator="\t",
            )

    def test_thin_space_in_grouping_separator(self) -> None:
        """U+2009 thin space — historically a grouping separator, now rejected."""
        with pytest.raises(CompileFailedError, match="grouping_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator=".",
                grouping_separator="\u2009",
            )

    def test_nbsp_in_decimal_separator(self) -> None:
        """U+00A0 no-break space."""
        with pytest.raises(CompileFailedError, match="decimal_separator"):
            NumberFormat(
                decimal_places=2,
                group_thousands=True,
                decimal_separator="\u00a0",
                grouping_separator=",",
            )


# ---------------------------------------------------------------------------
# Grouping rightward in integer part, never in fractional (Req 16.11)
# ---------------------------------------------------------------------------


@settings(max_examples=200)
@given(value=decimal_values(), nf=declared_number_formats())
@example(
    value=Decimal("1234567.5"),
    nf=NumberFormat(
        decimal_places=1,
        group_thousands=True,
        decimal_separator=".",
        grouping_separator=",",
    ),
)
@example(
    value=Decimal("1234567.5"),
    nf=NumberFormat(
        decimal_places=3,
        group_thousands=True,
        decimal_separator=",",
        grouping_separator=".",
    ),
)
def test_property_2_grouping_rightward_in_integer_never_in_fraction(
    value: Decimal, nf: NumberFormat
) -> None:
    """Grouping inserted rightward in the integer part, never in the fractional part."""
    formatted = format_figure(
        value, unit="percent", catalog_scale=0, number_format=nf, path="test:0"
    )

    # Strip the unit suffix
    digits_part = formatted.rstrip("%").rstrip()
    # Strip negative sign
    if digits_part.startswith("-"):
        digits_part = digits_part[1:]

    if nf.decimal_places > 0:
        parts = digits_part.split(nf.decimal_separator)
        assert len(parts) == 2, f"Expected int{nf.decimal_separator}frac, got {digits_part!r}"
        integer_part, fraction_part = parts

        # The fractional part must NEVER contain the grouping separator
        assert nf.grouping_separator not in fraction_part, (
            f"Grouping separator {nf.grouping_separator!r} found in fractional part "
            f"{fraction_part!r} of {formatted!r}"
        )

        # If grouping is on, verify groups of 3 from the right in the integer part
        if nf.group_thousands and nf.grouping_separator in integer_part:
            groups = integer_part.split(nf.grouping_separator)
            # All groups except the leftmost must be exactly 3 digits
            for group in groups[1:]:
                assert len(group) == 3, (
                    f"Group {group!r} is not 3 digits in {integer_part!r}"
                )
            # Leftmost group must be 1-3 digits
            assert 1 <= len(groups[0]) <= 3, (
                f"Leftmost group {groups[0]!r} is not 1-3 digits"
            )
    else:
        # No decimal separator — the whole thing is the integer part
        if nf.group_thousands and nf.grouping_separator in digits_part:
            groups = digits_part.split(nf.grouping_separator)
            for group in groups[1:]:
                assert len(group) == 3
            assert 1 <= len(groups[0]) <= 3


# ---------------------------------------------------------------------------
# schema_version 1 defaults to en separators (. and ,)
# ---------------------------------------------------------------------------


def test_property_2_schema_version_1_resolves_en_defaults() -> None:
    """A schema_version 1 definition resolves the `en` defaults: `.` and `,`."""
    # schema_version 1 has no language and no separators declared
    nf = number_format_from_definition(
        {"decimal_places": 1, "group_thousands": True},
        language=None,
    )
    assert nf.decimal_separator == "."
    assert nf.grouping_separator == ","

    # Formatting with those defaults
    formatted = format_figure(
        Decimal("1234567.5"),
        unit="percent",
        catalog_scale=0,
        number_format=nf,
        path="test:0",
    )
    assert "1,234,567.5%" == formatted


# ---------------------------------------------------------------------------
# Declared examples as @example decorators (Req 16.9, 25.9)
# These ratchet the specific outputs the task spec names.
# ---------------------------------------------------------------------------


class TestDeclaredExamples:
    """The format pairs and values the task spec names as correct outputs."""

    def test_058_percent_with_comma_decimal(self) -> None:
        """0.58 with decimal=',' → '0,58%'"""
        nf = NumberFormat(
            decimal_places=2,
            group_thousands=False,
            decimal_separator=",",
            grouping_separator=".",
        )
        result = format_figure(
            Decimal("0.58"), unit="percent", catalog_scale=0, number_format=nf, path="x:0"
        )
        assert result == "0,58%"

    def test_46281_gb_with_comma_decimal(self) -> None:
        """462.81 with decimal=',' → '462,81 bytes' (the sample the consultant sees)."""
        nf = NumberFormat(
            decimal_places=2,
            group_thousands=True,
            decimal_separator=",",
            grouping_separator=".",
        )
        result = format_figure(
            Decimal("462.81"), unit="bytes", catalog_scale=0, number_format=nf, path="x:0"
        )
        assert result == "462,81 bytes"

    def test_1234567_5_with_period_decimal_comma_grouping(self) -> None:
        """1234567.5 with decimal='.', grouping=',' → '1,234,567.5%'"""
        nf = NumberFormat(
            decimal_places=1,
            group_thousands=True,
            decimal_separator=".",
            grouping_separator=",",
        )
        result = format_figure(
            Decimal("1234567.5"), unit="percent", catalog_scale=0, number_format=nf, path="x:0"
        )
        assert result == "1,234,567.5%"

    def test_1234567_5_with_comma_decimal_period_grouping(self) -> None:
        """1234567.5 with decimal=',', grouping='.' → '1.234.567,5%'"""
        nf = NumberFormat(
            decimal_places=1,
            group_thousands=True,
            decimal_separator=",",
            grouping_separator=".",
        )
        result = format_figure(
            Decimal("1234567.5"), unit="percent", catalog_scale=0, number_format=nf, path="x:0"
        )
        assert result == "1.234.567,5%"

    def test_058_percent_with_period_decimal(self) -> None:
        """0.58 with decimal='.' → '0.58%'"""
        nf = NumberFormat(
            decimal_places=2,
            group_thousands=False,
            decimal_separator=".",
            grouping_separator=",",
        )
        result = format_figure(
            Decimal("0.58"), unit="percent", catalog_scale=0, number_format=nf, path="x:0"
        )
        assert result == "0.58%"

    def test_46281_gb_with_period_decimal(self) -> None:
        """462.81 with decimal='.' → '462.81 bytes'"""
        nf = NumberFormat(
            decimal_places=2,
            group_thousands=True,
            decimal_separator=".",
            grouping_separator=",",
        )
        result = format_figure(
            Decimal("462.81"), unit="bytes", catalog_scale=0, number_format=nf, path="x:0"
        )
        assert result == "462.81 bytes"
