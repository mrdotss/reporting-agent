"""`compile/format.py` — the refusals, the separators and the unit presentation.

Property 1 (`tests/property/test_format_property.py`) covers totality, determinism and
the round-trip. This module pins the cases a generator would reach rarely or never: the
exact refusals Req 18.9 and 18.11 name, the declared unit presentations, and the shape of
the string a consumer is required to emit verbatim.
"""

from __future__ import annotations

import inspect
from decimal import Decimal

import pytest

from reporting_agent.compile.estimators import estimator_label
from reporting_agent.compile.format import (
    DEFAULT_NUMBER_FORMAT,
    UNIT_PRESENTATION,
    NumberFormat,
    display_scale,
    format_figure,
    format_text_fact,
    unit_suffix,
)
from reporting_agent.errors import CompileFailedError, ErrorCode

PATH = "kpi-1:0"


# --------------------------------------------------------------------------- #
# The string a consumer emits verbatim
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("value", "unit", "catalog_scale", "expected"),
    [
        (Decimal("12.48"), "percent", 2, "12.48%"),
        (Decimal("0.00"), "percent", 2, "0.00%"),
        (Decimal("100.00"), "percent", 2, "100.00%"),
        (Decimal("8589934592"), "bytes", 0, "8,589,934,592 bytes"),
        (Decimal("1024"), "bytes", 0, "1,024 bytes"),
        (Decimal("999"), "bytes", 0, "999 bytes"),
        (Decimal("42.5"), "count_per_second", 1, "42.5/s"),
        (Decimal("2"), "count", 0, "2"),
    ],
)
def test_the_display_string_is_digits_plus_the_units_own_presentation(
    value: Decimal, unit: str, catalog_scale: int, expected: str
) -> None:
    """Req 18.6 — the unit travels **inside** the string.

    A renderer that emitted the digits and appended its own `%` would produce a token no
    ledger entry matches, and the run would be withheld for a number that is correct.
    """
    number_format = NumberFormat(decimal_places=0, group_thousands=True)
    assert (
        format_figure(
            value,
            unit=unit,
            catalog_scale=catalog_scale,
            number_format=number_format,
            path=PATH,
        )
        == expected
    )


def test_an_estimated_value_carries_its_label_in_parentheses() -> None:
    label = estimator_label("histogram_sketch_pt1h_interval_average", "p95")
    rendered = format_figure(
        Decimal("68.40"),
        unit="percent",
        catalog_scale=2,
        number_format=NumberFormat(decimal_places=0),
        estimator_label=label,
        path=PATH,
    )
    assert rendered == "68.40% (p95, est. from hourly averages)"


def test_an_exact_value_carries_no_parenthetical() -> None:
    rendered = format_figure(
        Decimal("12.48"), unit="percent", catalog_scale=2, path=PATH
    )
    assert "(" not in rendered


def test_negative_zero_is_folded_to_zero() -> None:
    """A tiny negative quantity quantizes to `-0.00`, which would be a second spelling of
    zero and therefore a second token for one measurement."""
    for value in (Decimal("-0.004"), Decimal("-0.000001"), Decimal("-0")):
        rendered = format_figure(value, unit="percent", catalog_scale=2, path=PATH)
        assert rendered == "0.00%", value
        assert "-" not in rendered


def test_a_negative_value_keeps_exactly_one_leading_minus() -> None:
    rendered = format_figure(
        Decimal("-1234.5"),
        unit="percent",
        catalog_scale=1,
        number_format=NumberFormat(decimal_places=1, group_thousands=True),
        path=PATH,
    )
    assert rendered == "-1,234.5%"
    assert rendered.count("-") == 1


def test_plain_notation_only_never_an_exponent() -> None:
    """`Decimal.__str__` emits scientific notation for a far-from-zero exponent, and
    `1E+3` where another run wrote `1000` is two spellings of one quantity in a document
    meant to be comparable to itself."""
    rendered = format_figure(
        Decimal("1E+15"),
        unit="bytes",
        catalog_scale=0,
        number_format=NumberFormat(decimal_places=0, group_thousands=False),
        path=PATH,
    )
    assert rendered == "1000000000000000 bytes"
    assert "E" not in rendered


# --------------------------------------------------------------------------- #
# Separators and grouping
# --------------------------------------------------------------------------- #


def test_the_templates_separators_are_honoured_unconditionally() -> None:
    european = NumberFormat(
        decimal_places=2,
        group_thousands=True,
        decimal_separator=",",
        grouping_separator=".",
    )
    assert (
        format_figure(
            Decimal("1234567.89"),
            unit="bytes",
            catalog_scale=2,
            number_format=european,
            path=PATH,
        )
        == "1.234.567,89 bytes"
    )


def test_grouping_off_emits_no_grouping_separator() -> None:
    ungrouped = NumberFormat(decimal_places=0, group_thousands=False)
    assert (
        format_figure(
            Decimal("1234567"),
            unit="bytes",
            catalog_scale=0,
            number_format=ungrouped,
            path=PATH,
        )
        == "1234567 bytes"
    )


@pytest.mark.parametrize(
    ("field", "separator"),
    [
        ("grouping_separator", " "),
        ("grouping_separator", "\u2009"),  # thin space — a European grouping separator
        ("grouping_separator", "\u00a0"),  # no-break space — the other one
        ("grouping_separator", "\t"),
        ("grouping_separator", "\n"),
        ("grouping_separator", "\u2028"),  # line separator
        ("grouping_separator", "\u3000"),  # ideographic space
        ("decimal_separator", " "),
        ("decimal_separator", "\u2009"),
        ("decimal_separator", "\u00a0"),
    ],
)
def test_a_whitespace_separator_is_refused_naming_the_field(
    field: str, separator: str
) -> None:
    """Req 16.2. Whitespace of **any** kind, not only an ASCII space.

    `verify/tokens.numeric_tokens` splits a paragraph on `\\S+`, so `1<thin>234<thin>567`
    reaches the verifier as three tokens none of which equals the ledger's `formatted`
    string; and `normalize_pdf_text` collapses every whitespace run to one space, so the
    `.pdf` pass cannot locate it either. A format the constructor accepted here would
    withhold a report whose numbers were correct.
    """
    with pytest.raises(CompileFailedError) as raised:
        NumberFormat(**{field: separator})

    # The offending field is named, so the builder can point at the control that wrote it.
    assert f"number_format.{field}" in str(raised.value)
    assert "whitespace" in str(raised.value)


def test_a_non_whitespace_non_digit_separator_still_constructs() -> None:
    """The clause above rejects whitespace and nothing wider: an apostrophe (the Swiss
    grouping separator) and the two language-derived pairs Req 16.3 declares are all
    still accepted."""
    swiss = NumberFormat(decimal_places=0, group_thousands=True, grouping_separator="'")
    assert (
        format_figure(
            Decimal("1234567"), unit="bytes", catalog_scale=0, number_format=swiss, path=PATH
        )
        == "1'234'567 bytes"
    )

    # `en` and `id`, the two resolved pairs the definition can supply at schema_version 2.
    assert NumberFormat(decimal_separator=".", grouping_separator=",").decimal_places == 1
    assert NumberFormat(decimal_separator=",", grouping_separator=".").group_thousands is True


@pytest.mark.parametrize(
    "kwargs",
    [
        {"decimal_places": -1},
        {"decimal_places": 4},
        {"decimal_places": 1.5},
        {"decimal_places": True},
        {"group_thousands": "yes"},
        {"decimal_separator": ""},
        {"grouping_separator": ""},
        {"decimal_separator": "5"},
        {"grouping_separator": "-"},
        {"decimal_separator": ".", "grouping_separator": "."},
    ],
)
def test_an_unusable_number_format_is_refused_at_construction(kwargs: dict) -> None:
    """A separator that could be read as part of the number makes the verifier's token
    extraction ambiguous, and two identical separators make the number unreadable."""
    with pytest.raises(CompileFailedError):
        NumberFormat(**kwargs)


def test_the_default_number_format_is_one_place_grouped_and_ascii() -> None:
    assert DEFAULT_NUMBER_FORMAT.decimal_places == 1
    assert DEFAULT_NUMBER_FORMAT.group_thousands is True
    assert DEFAULT_NUMBER_FORMAT.decimal_separator == "."
    assert DEFAULT_NUMBER_FORMAT.grouping_separator == ","


# --------------------------------------------------------------------------- #
# Req 18.4 — the catalog scale is a floor
# --------------------------------------------------------------------------- #


def test_the_template_may_add_digits_but_not_remove_them() -> None:
    value = Decimal("12.48")

    # Asking for fewer digits than the measurement carries is ignored.
    assert (
        format_figure(
            value,
            unit="percent",
            catalog_scale=2,
            number_format=NumberFormat(decimal_places=0),
            path=PATH,
        )
        == "12.48%"
    )
    # Asking for more adds zeros.
    assert (
        format_figure(
            value,
            unit="percent",
            catalog_scale=2,
            number_format=NumberFormat(decimal_places=3),
            path=PATH,
        )
        == "12.480%"
    )


def test_display_scale_is_the_maximum_of_the_two() -> None:
    for decimal_places in range(4):
        for catalog_scale in range(10):
            assert display_scale(
                NumberFormat(decimal_places=decimal_places), catalog_scale, at=PATH
            ) == max(decimal_places, catalog_scale)


# --------------------------------------------------------------------------- #
# Req 18.9, 18.11 — refusals, naming the AST path, applying no default
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("catalog_scale", [None, -1, 10, "2", 2.0, True])
def test_a_metric_with_no_declared_scale_produces_no_string_at_all(
    catalog_scale: object,
) -> None:
    """Req 18.11. No default scale: publishing a figure at a guessed precision is a claim
    about how well something was measured, made on the basis of nothing."""
    with pytest.raises(CompileFailedError) as caught:
        format_figure(
            Decimal("12.48"), unit="percent", catalog_scale=catalog_scale, path=PATH
        )
    assert PATH in str(caught.value)
    assert caught.value.code is ErrorCode.COMPILE_FAILED
    assert caught.value.terminal is True


@pytest.mark.parametrize(
    "value",
    [
        12.48,
        12,
        True,
        None,
        "twelve",
        "1E+3",
        "+12.48",
        "12.",
        ".48",
        "",
        " 12.48 ",
        "1,000",
        Decimal("NaN"),
        Decimal("Infinity"),
        Decimal("-Infinity"),
    ],
)
def test_a_value_that_is_not_a_decimal_or_a_decimal_string_produces_no_string(
    value: object,
) -> None:
    """Req 18.9. A `float` in particular is refused rather than converted: `Decimal(1.1)`
    is `1.1000000000000000888…`, and a figure formatted from that differs between two
    machines in a way that fails verification on a correct report."""
    with pytest.raises(CompileFailedError) as caught:
        format_figure(value, unit="percent", catalog_scale=2, path=PATH)
    assert PATH in str(caught.value)


def test_a_decimal_string_value_is_accepted() -> None:
    """The snapshot stores decimal strings, so the formatter reads one directly rather
    than making every caller parse first."""
    assert (
        format_figure("12.48", unit="percent", catalog_scale=2, path=PATH) == "12.48%"
    )


@pytest.mark.parametrize("unit", ["", "PERCENT", "gigabytes", "ops", "unknown"])
def test_an_undeclared_unit_produces_no_string(unit: str) -> None:
    with pytest.raises(CompileFailedError) as caught:
        format_figure(Decimal("1"), unit=unit, catalog_scale=0, path=PATH)
    assert PATH in str(caught.value)


def test_every_declared_unit_has_a_presentation() -> None:
    for unit, expected in UNIT_PRESENTATION:
        assert unit_suffix(unit, at=PATH) == expected


@pytest.mark.parametrize("label", ["", 0, False, []])
def test_an_unusable_estimator_label_produces_no_string(label: object) -> None:
    with pytest.raises(CompileFailedError) as caught:
        format_figure(
            Decimal("1.0"),
            unit="percent",
            catalog_scale=1,
            estimator_label=label,
            path=PATH,
        )
    assert PATH in str(caught.value)


def test_no_bare_percentile_designation_survives_in_a_formatted_string() -> None:
    """Req 18.10. The digits and the unit cannot spell a percentile, so the only route in
    is the label — and a label is never absent for an estimated value, because
    `compile/figures.py` refuses one."""
    label = estimator_label("histogram_sketch_pt1h_interval_average", "p99")
    with_label = format_figure(
        Decimal("95.10"),
        unit="percent",
        catalog_scale=2,
        estimator_label=label,
        path=PATH,
    )
    assert with_label.endswith("(p99, est. from hourly averages)")

    # Strip the parenthetical and nothing percentile-shaped is left.
    digits = with_label.split(" (", 1)[0]
    assert "p99" not in digits
    assert "percentile" not in digits.casefold()

    without_label = format_figure(
        Decimal("95.10"), unit="percent", catalog_scale=2, path=PATH
    )
    assert "p" not in without_label


# --------------------------------------------------------------------------- #
# `format_text_fact` — the identity, and that it is an identity on purpose
# --------------------------------------------------------------------------- #


TEXT_FACT_AT = "text fact 'resource-table-1:3:2'"


@pytest.mark.parametrize(
    "value",
    [
        # The values this exists for, from the fact declaration's own vocabulary.
        "Succeeded",
        "Failed",
        "Standard_D4s_v3",
        "10.0.0.4",
        "10.0.0.0/16",
        "Windows Server 2022",
        # Shapes a well-meaning formatter would be tempted to tidy, and must not.
        "  leading and trailing  ",
        "MiXeD CaSe",
        "1,234.56",
        "value\twith\ttabs",
        "line\nbreak",
        "a" * 512,
        "Berhasil",
        "\u00e9\u0142\u5b89",
        "\U0001f680",
    ],
)
def test_a_text_facts_display_string_is_the_value_character_for_character(
    value: str,
) -> None:
    """Req 6.12 — no case folding, no truncation, no trimming, no separator substitution.

    The parametrization is the assertion: every entry is a value some formatter would have
    a plausible reason to change, and the expected result is always the input. `==` is
    character-for-character here because both sides are `str` — there is no normalization
    step to have gone wrong.
    """
    assert format_text_fact(value, at=TEXT_FACT_AT) == value


def test_the_two_languages_get_the_same_string() -> None:
    """Req 6.13 — `Succeeded` reaches an Indonesian document as `Succeeded`.

    Stated as a test even though the function takes no language, because *that* is the
    claim: there is no parameter a caller could pass to change the answer, so the two
    languages cannot diverge. A signature is the strongest form this property has.
    """
    assert format_text_fact("Succeeded", at=TEXT_FACT_AT) == "Succeeded"
    assert "language" not in inspect.signature(format_text_fact).parameters
    assert set(inspect.signature(format_text_fact).parameters) == {"value", "at"}


def test_the_result_is_idempotent() -> None:
    """Formatting a formatted value changes nothing — which is what lets
    `TextFact.__post_init__` require `formatted == value` without the two ever fighting."""
    once = format_text_fact("Standard_E32-8s_v5", at=TEXT_FACT_AT)

    assert format_text_fact(once, at=TEXT_FACT_AT) == once


@pytest.mark.parametrize(
    "value",
    [
        pytest.param(Decimal("12.48"), id="a Decimal"),
        pytest.param(12, id="an int"),
        pytest.param(12.48, id="a float"),
        pytest.param(None, id="None"),
        pytest.param(["Succeeded"], id="a list"),
    ],
)
def test_a_non_string_is_refused_rather_than_coerced(value: object) -> None:
    """A quantity belongs on a `Figure`, which carries the provenance a number needs.

    `str(value)` here would be the tempting coercion and it is the wrong one: it would put
    a number in the document through the one path that applies no scale, no unit and no
    estimator label — a figure with none of a figure's guarantees.
    """
    with pytest.raises(CompileFailedError) as raised:
        format_text_fact(value, at=TEXT_FACT_AT)  # type: ignore[arg-type]

    assert raised.value.code is ErrorCode.COMPILE_FAILED
    assert TEXT_FACT_AT in str(raised.value)


def test_an_empty_value_is_refused() -> None:
    """An absent fact is a recorded gap, not a blank cell. A formatter that returned `""`
    would put a cell in the document that a reader sees as missing data and the verifier
    sees as matching."""
    with pytest.raises(CompileFailedError) as raised:
        format_text_fact("", at=TEXT_FACT_AT)

    assert raised.value.code is ErrorCode.COMPILE_FAILED
    assert TEXT_FACT_AT in str(raised.value)
