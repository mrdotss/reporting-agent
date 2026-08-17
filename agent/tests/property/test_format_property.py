"""Property 1: formatting is total, deterministic and the single display path.

**Validates: Req 18.3, 18.4, 18.5, 18.6, 18.7, 7.3, 7.9, 45.1**

`compile/format.py` is the only operation in the runtime that turns a value into a
display string, and the verifier compares every numeric token in the rendered document
against a `formatted` value by **exact equality**. So the properties that matter are not
about aesthetics: a formatter that is non-deterministic, that loses a digit, or that
round-trips through a binary float produces a token that matches nothing, and the report
is withheld for a number that was actually correct.

## What the generator domain is, and why it is quantized at the catalog scale

Every value this function meets in production is either a snapshot value — stored as a
decimal string at exactly the Metric_Catalog's declared scale — or `Decimal` arithmetic
over such values (a run-to-run delta), which cannot introduce fractional digits beyond
that scale. The generator therefore quantizes each value to the catalog scale before
formatting.

That is not narrowing the test to make it pass; it is what makes the round-trip assertion
Req 18.4 asks for meaningful. Because the display scale is `max(decimal_places,
catalog_scale)` and the value carries no digits below the catalog scale, quantization at
display scale only ever **pads with zeros** — so parsing the emitted digits back
reproduces the value quantized at the *catalog* scale exactly. An over-precise input is
covered separately, by
:func:`test_an_over_precise_value_rounds_half_away_from_zero_at_the_display_scale`, where
the rounding mode is genuinely load-bearing.
"""

from __future__ import annotations

from decimal import Decimal, localcontext

import pytest
from hypothesis import assume, example, given
from hypothesis import strategies as st

from reporting_agent.catalog.loader import MAX_SCALE, MIN_SCALE
from reporting_agent.compile.estimators import estimator_label
from reporting_agent.compile.format import (
    MAX_DECIMAL_PLACES,
    MIN_DECIMAL_PLACES,
    UNIT_PRESENTATION,
    NumberFormat,
    display_scale,
    format_figure,
    unit_suffix,
)
from reporting_agent.errors import CompileFailedError

THIN_SPACE = "\u2009"

DECLARED_UNITS = tuple(unit for unit, _ in UNIT_PRESENTATION)
PERCENTAGE_UNITS = ("percent",)
MAGNITUDE_UNITS = tuple(unit for unit in DECLARED_UNITS if unit not in PERCENTAGE_UNITS)

# Every estimator the collector can emit, in both classes, so an estimated value and an
# exact one are both exercised against every number format.
ESTIMATED_ESTIMATORS = (
    "histogram_sketch_pt1h_interval_average",
    "histogram_sketch_pt15m_interval_average",
    "ddsketch_pt1h_interval_average",
    "ddsketch_pt15m_interval_average",
    "histogram_sketch_pt1m_interval_average",
    "ddsketch_p1d_interval_average",
)
EXACT_ESTIMATOR = "exact_count_weighted"


def _quantize(value: Decimal, scale: int) -> Decimal:
    """The reference quantization, half away from zero, computed independently of the
    module under test."""
    from decimal import ROUND_HALF_UP

    integer_digits = max(value.adjusted() + 1, 1)
    with localcontext() as context:
        context.prec = integer_digits + scale + 4
        return value.quantize(Decimal(1).scaleb(-scale), rounding=ROUND_HALF_UP)


@st.composite
def number_formats(draw: st.DrawFn) -> NumberFormat:
    """Decimal places 0-3 x grouping on/off x a decimal separator of `.` or `,` x a
    grouping separator of `,`, `.` or a thin space.

    Equal separators are filtered out rather than generated and discarded downstream: a
    number format whose decimal and grouping separators are the same is refused by
    construction, and generating one would be testing the constructor rather than the
    formatter.
    """
    decimal_separator = draw(st.sampled_from([".", ","]))
    grouping_separator = draw(
        st.sampled_from([",", ".", THIN_SPACE]).filter(
            lambda candidate: candidate != decimal_separator
        )
    )
    return NumberFormat(
        decimal_places=draw(
            st.integers(min_value=MIN_DECIMAL_PLACES, max_value=MAX_DECIMAL_PLACES)
        ),
        group_thousands=draw(st.booleans()),
        decimal_separator=decimal_separator,
        grouping_separator=grouping_separator,
    )


@st.composite
def figure_inputs(draw: st.DrawFn) -> tuple[Decimal, str, int, NumberFormat, str | None]:
    """`(value, unit, catalog_scale, number_format, estimator_label)`.

    A percentage is drawn from 0-100 and a magnitude from 0-10^15, both including
    negatives and exact zero, because those are the two ranges the Metric_Catalog's unit
    families actually cover — and 10^15 is where a byte count near a petabyte lives,
    which is the value that would expose a quantization context too narrow to hold it.
    """
    unit = draw(st.sampled_from(DECLARED_UNITS))
    catalog_scale = draw(st.integers(min_value=MIN_SCALE, max_value=MAX_SCALE))

    if unit in PERCENTAGE_UNITS:
        magnitude = draw(
            st.decimals(
                min_value=Decimal(0), max_value=Decimal(100), places=draw(st.integers(0, 9))
            )
        )
    else:
        magnitude = draw(
            st.decimals(
                min_value=Decimal(0),
                max_value=Decimal(10) ** 15,
                places=draw(st.integers(0, 9)),
            )
        )
    if draw(st.booleans()):
        magnitude = -magnitude

    number_format = draw(number_formats())

    estimated = draw(st.booleans())
    label: str | None = None
    if estimated:
        label = estimator_label(draw(st.sampled_from(ESTIMATED_ESTIMATORS)), "p95")

    # Quantized to the catalog scale, which is the domain every production value comes
    # from — see the module docstring.
    return (_quantize(magnitude, catalog_scale), unit, catalog_scale, number_format, label)


@given(figure_inputs())
@example(
    (Decimal("0"), "percent", 2, NumberFormat(), None),
)
@example(
    (Decimal("0.000001"), "percent", 6, NumberFormat(decimal_places=1), None),
)
@example(
    (Decimal("-0.5"), "percent", 1, NumberFormat(decimal_places=1), None),
)
@example(
    (Decimal("9007199254740993"), "bytes", 0, NumberFormat(decimal_places=0), None),
)
@example(
    (Decimal("0.1"), "percent", 1, NumberFormat(decimal_places=1), None),
)
@example(
    (Decimal("0.30000000000000004"), "percent", 9, NumberFormat(decimal_places=0), None),
)
@example(
    (
        Decimal("1234567.89"),
        "bytes",
        2,
        NumberFormat(
            decimal_places=2,
            group_thousands=True,
            decimal_separator=",",
            grouping_separator=".",
        ),
        None,
    ),
)
def test_property_1_formatting_is_total_deterministic_and_the_single_display_path(
    inputs: tuple[Decimal, str, int, NumberFormat, str | None],
) -> None:
    value, unit, catalog_scale, number_format, label = inputs
    path = "kpi-1:0"

    first = format_figure(
        value,
        unit=unit,
        catalog_scale=catalog_scale,
        number_format=number_format,
        estimator_label=label,
        path=path,
    )
    second = format_figure(
        value,
        unit=unit,
        catalog_scale=catalog_scale,
        number_format=number_format,
        estimator_label=label,
        path=path,
    )

    # Idempotent per input tuple: two formats of one input are the same string. The
    # verifier's exact-equality comparison has no tolerance for anything less.
    assert first == second

    # The display scale is the catalog scale raised, never lowered (Req 18.4).
    scale = display_scale(number_format, catalog_scale, at=path)
    assert scale == max(number_format.decimal_places, catalog_scale)
    assert scale >= catalog_scale

    # The unit's presentation is inside the string, never appended by a consumer
    # (Req 18.6) — a renderer adding its own `%` would produce a token no ledger entry
    # matches, and the run would be withheld for a correct number.
    suffix = unit_suffix(unit, at=path)
    digits_and_suffix = first.split(" (", 1)[0] if label is not None else first
    assert digits_and_suffix.endswith(suffix)

    digits = digits_and_suffix.removesuffix(suffix)
    assert digits, digits_and_suffix

    # The digits round-trip to the value quantized at the CATALOG scale.
    recovered = _parse_digits(digits, number_format)
    assert recovered == _quantize(value, catalog_scale), (
        f"{digits!r} recovered as {recovered} but the value at the catalog scale is "
        f"{_quantize(value, catalog_scale)}"
    )

    # An estimated value's string contains its label, and no bare percentile designation
    # survives outside it.
    if label is None:
        assert " (" not in first
        assert "p95" not in first
        assert "percentile" not in first.casefold()
    else:
        assert first.endswith(f" ({label})")
        assert "p95" not in digits_and_suffix
        assert "percentile" not in digits_and_suffix.casefold()


def _parse_digits(digits: str, number_format: NumberFormat) -> Decimal:
    """Undo the template's separators and read the number back.

    A second, independent implementation of the presentation, which is the point: if this
    and the formatter agreed by sharing code, the round-trip would prove nothing.
    """
    plain = digits.replace(number_format.grouping_separator, "")
    plain = plain.replace(number_format.decimal_separator, ".")
    return Decimal(plain)


@given(
    value=st.decimals(min_value=Decimal(0), max_value=Decimal(100), places=2),
    delta=st.decimals(min_value=Decimal("0.01"), max_value=Decimal("50"), places=2),
    number_format=number_formats(),
)
def test_two_values_differing_after_quantization_format_differently(
    value: Decimal, delta: Decimal, number_format: NumberFormat
) -> None:
    """Two distinct measurements must not collapse onto one display string at the scale
    they are shown at — otherwise the verifier could match a document token against the
    wrong ledger entry and call the report proven."""
    catalog_scale = 2
    other = value + delta
    scale = display_scale(number_format, catalog_scale, at="k:0")
    assume(_quantize(value, scale) != _quantize(other, scale))

    first = format_figure(
        value, unit="percent", catalog_scale=catalog_scale, number_format=number_format, path="k:0"
    )
    second = format_figure(
        other, unit="percent", catalog_scale=catalog_scale, number_format=number_format, path="k:1"
    )
    assert first != second


@given(
    value=st.floats(allow_nan=False, allow_infinity=False, min_value=-1e6, max_value=1e6)
)
def test_a_float_on_the_path_raises(value: float) -> None:
    """No float is constructed anywhere on this path, and one offered from outside is
    refused rather than converted: `Decimal(1.1)` is
    `1.1000000000000000888…`, and a figure formatted from that differs between two
    machines in a way that fails verification on a correct report."""
    with pytest.raises(CompileFailedError, match="float"):
        format_figure(value, unit="percent", catalog_scale=2, path="k:0")


@given(
    value=st.decimals(min_value=Decimal(0), max_value=Decimal(100), places=2),
    catalog_scale=st.integers(min_value=MIN_SCALE, max_value=MAX_SCALE),
    decimal_places=st.integers(min_value=MIN_DECIMAL_PLACES, max_value=MAX_DECIMAL_PLACES),
)
def test_the_catalog_scale_is_a_floor_the_template_cannot_cut_into(
    value: Decimal, catalog_scale: int, decimal_places: int
) -> None:
    """Req 18.4. Precision is a property of the measurement, not of a template's taste:
    the setting adds zeros where it asks for more and is ignored where it asks for less."""
    number_format = NumberFormat(decimal_places=decimal_places)
    scale = display_scale(number_format, catalog_scale, at="k:0")

    assert scale == max(decimal_places, catalog_scale)
    assert scale >= catalog_scale

    rendered = format_figure(
        value,
        unit="percent",
        catalog_scale=catalog_scale,
        number_format=number_format,
        path="k:0",
    )
    digits = rendered.removesuffix("%")
    _, _, fraction = digits.partition(".")
    assert len(fraction) == scale


@given(magnitude=st.integers(min_value=0, max_value=999), negative=st.booleans())
def test_an_over_precise_value_rounds_half_away_from_zero_at_the_display_scale(
    magnitude: int, negative: bool
) -> None:
    """The one place the rounding mode is load-bearing: a value carrying more digits than
    the display scale, exactly on the half.

    Half **away from zero**, deliberately different from `collect/snapshot.py`'s half to
    even. Two quantizations, two jobs: that one decides the bytes a content address is
    taken over, this one decides what a human reads.
    """
    value = Decimal(magnitude) + Decimal("0.5")
    if negative:
        value = -value

    rendered = format_figure(
        value,
        unit="count",
        catalog_scale=0,
        number_format=NumberFormat(decimal_places=0, group_thousands=False),
        path="k:0",
    )

    # Exactly on the half, away from zero in both directions: 0.5 -> 1, -0.5 -> -1.
    expected = -(magnitude + 1) if negative else magnitude + 1
    assert rendered == str(expected)
    # Half to EVEN would give 0 for 0.5 and 2 for 1.5, so this assertion is what tells
    # the two modes apart rather than merely documenting that they differ.
    if magnitude % 2 == 0:
        assert rendered != str(magnitude if not negative else -magnitude)
