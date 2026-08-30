"""The chart palette, on the agent's side of the fence.

`app/components/charts/palette.ts` and this module hold **the same values**, because the
static images embedded in the `.docx` and the interactive charts in the app are two views
of one figure ledger and must not disagree about which colour a series is. A reader who
learns from the app that teal is CPU and then finds CPU in ochre in the delivered document
has been given a reason to distrust the whole artifact.

That makes this a **third mirrored pair**, alongside `lib/events.ts` ↔ `events.py` and
`lib/templates/blocks.ts` ↔ `compile/definition.py`. `tests/test_chartstyle.py` reads the
TypeScript across the monorepo path and asserts equality rather than trusting it, the same
way the Mirror_Guard does — a duplicated constant nobody compares is a constant that has
already drifted.

## Why matplotlib needs the values as data

A browser resolves `var(--cat-1)` from a stylesheet. matplotlib, drawing a PNG that will
be embedded in a Word file, has no stylesheet and no cascade: it needs a concrete sRGB
hex. So this module also owns the OKLCH → sRGB conversion, which is why the colour maths
lives here rather than only in the test suite.

## Determinism

Everything here is pure and closed over constants: the same chart node produces the same
bytes on any machine, which `tests/test_charts.py` asserts by byte equality over two
renders. The `rcParams` block and the figure emission live in `render/charts.py`; this
module is only the palette and the colour conversion, so a chart's *style* and a chart's
*data* cannot be confused for one another.

## The floats here are not a violation of the decimal rule

`azure-integration.md` forbids a float anywhere on the path from a snapshot value to a
`formatted` string, and this module is full of them. That is the documented exception: a
colour is chart **layout geometry**, never hashed, never rendered as text, and never a
figure. A hex triple is not a measurement.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from typing import Final

__all__ = [
    "CATEGORICAL_LIMIT",
    "CATEGORICAL_PLOTTED_LIMIT",
    "CATEGORICAL_TOKENS",
    "CATEGORICAL_VALUES",
    "CAT_OTHER",
    "CHART_DPI",
    "CHART_ENCODINGS",
    "CHART_FONT",
    "CHART_GRID_WIDTH",
    "CHART_LABEL_SIZE",
    "CHART_MARKER_SIZE",
    "CHART_PANEL_GAP_INCHES",
    "CHART_PANEL_HEIGHT_INCHES",
    "CHART_SIZE_INCHES",
    "CHART_STROKE_WIDTH",
    "CHART_TITLE_SIZE",
    "CHART_WIDTH_INCHES",
    "DASH_PATTERNS",
    "DESTRUCTIVE_VALUES",
    "MARKER_SHAPES",
    "MAX_CHART_HEIGHT_INCHES",
    "MINIMUM_CVD_DELTA_E",
    "MINIMUM_SURFACE_CONTRAST",
    "PNG_METADATA",
    "SEQUENTIAL_STROKE_SAFE",
    "SEQUENTIAL_TOKENS",
    "SEQUENTIAL_VALUES",
    "SURFACE_VALUES",
    "SVG_METADATA",
    "Theme",
    "assign_colors",
    "axis_label_color",
    "chart_size_inches",
    "color_for_key",
    "compare_by_code_point",
    "contrast_ratio",
    "dash_for_key",
    "frozen_rc_params",
    "grid_color",
    "hash_key",
    "hex_for_token",
    "marker_for_key",
    "oklch_to_hex",
    "palette_for",
    "parse_oklch",
    "slot_for_key",
    "split_for_plotting",
    "stroke_safe_token",
    "value_label_color",
]

Theme = str
"""`"light"` or `"dark"`. A plain `str` rather than an enum because it crosses into
matplotlib calls and a JSON chart spec, and an enum would only add conversions."""

LIGHT: Final[Theme] = "light"
DARK: Final[Theme] = "dark"

# --- The encodings ----------------------------------------------------------

CHART_ENCODINGS: Final[tuple[str, ...]] = ("categorical", "sequential")
"""The chart node's declared `encoding`. The palette follows it and never the series
count: guessing would colour a one-series categorical chart from the sequential ramp."""

# --- The tokens -------------------------------------------------------------

CATEGORICAL_TOKENS: Final[tuple[str, ...]] = (
    "--cat-1",
    "--cat-2",
    "--cat-3",
    "--cat-4",
    "--cat-5",
)

CAT_OTHER: Final[str] = "--cat-other"

CATEGORICAL_LIMIT: Final[int] = len(CATEGORICAL_TOKENS)
"""Five, and it is a cap rather than a coincidence. A hue ring supports about five
reliably separable hues at ~70° spacing; past that lightness has to move, at which point
the set has reinvented the sequential ramp and lost categorical parity."""

CATEGORICAL_PLOTTED_LIMIT: Final[int] = CATEGORICAL_LIMIT - 1
"""Four plotted plus one aggregate. Plotting five and aggregating into a sixth would need
a sixth hue."""

SEQUENTIAL_TOKENS: Final[tuple[str, ...]] = (
    "--chart-1",
    "--chart-2",
    "--chart-3",
    "--chart-4",
    "--chart-5",
)

# --- The values -------------------------------------------------------------

CATEGORICAL_VALUES: Final[dict[Theme, dict[str, str]]] = {
    LIGHT: {
        # Byte-identical to the preset's `--primary`, so a single-series chart is the
        # product's accent colour rather than a near-miss of it.
        "--cat-1": "oklch(0.52 0.105 223.128)",
        "--cat-2": "oklch(0.64 0.105 293)",
        "--cat-3": "oklch(0.46 0.11 353)",
        "--cat-4": "oklch(0.58 0.105 66)",
        "--cat-5": "oklch(0.4 0.105 148)",
    },
    DARK: {
        "--cat-1": "oklch(0.68 0.105 223.128)",
        "--cat-2": "oklch(0.8 0.105 293)",
        "--cat-3": "oklch(0.62 0.11 353)",
        "--cat-4": "oklch(0.74 0.105 66)",
        "--cat-5": "oklch(0.56 0.105 148)",
    },
}
"""Five hues on an even lightness ladder, 0.06 per step, in one rank order in both themes.

The ladder is a **measured accessibility fix**, not a style choice. At the equal lightness
`design-system.md` specifies, `--cat-1` teal and `--cat-2` violet are 0.021 apart in OKLab
under deuteranopia — about one just-noticeable difference, i.e. one colour to that reader.
Under dichromacy a hue rotation collapses onto a single axis, so five hues at one
lightness have almost nothing left to separate them. The stagger lifts the worst pair
under any of deuteranopia, protanopia and tritanopia to 0.083."""

SEQUENTIAL_VALUES: Final[dict[Theme, dict[str, str]]] = {
    LIGHT: {
        "--chart-1": "oklch(0.872 0.007 219.6)",
        "--chart-2": "oklch(0.56 0.021 213.5)",
        "--chart-3": "oklch(0.45 0.017 213.2)",
        "--chart-4": "oklch(0.378 0.015 216)",
        "--chart-5": "oklch(0.275 0.011 216.9)",
    },
    DARK: {
        # The reversal. The preset ships one ramp for both themes, so unchanged its high
        # end is the end you cannot see on a dark surface: `--chart-3/4/5` measure 2.67,
        # 1.96 and 1.33 against `--background`.
        "--chart-1": "oklch(0.275 0.011 216.9)",
        "--chart-2": "oklch(0.378 0.015 216)",
        "--chart-3": "oklch(0.45 0.017 213.2)",
        "--chart-4": "oklch(0.56 0.021 213.5)",
        "--chart-5": "oklch(0.872 0.007 219.6)",
    },
}

SEQUENTIAL_STROKE_SAFE: Final[dict[Theme, tuple[str, ...]]] = {
    LIGHT: ("--chart-2", "--chart-3", "--chart-4", "--chart-5"),
    DARK: ("--chart-4", "--chart-5"),
}
"""The ramp steps that clear 3:1 against the surface, so are safe for a stroke or a small
mark. Fills are unrestricted — a pale low end is what a sequential scale should look like
as a heatmap cell or an area band.

The rule is "skip whichever end sits nearest the surface". In light mode `--chart-1` is
L 0.872 on an L 1.0 background and measures 1.47:1. In dark mode the reversal leaves only
the top two steps strokeable, which is enough: a sequential chart plots one ordered
quantity, so it has one line."""

SURFACE_VALUES: Final[dict[Theme, dict[str, str]]] = {
    LIGHT: {"--background": "oklch(1 0 0)", "--card": "oklch(1 0 0)"},
    DARK: {
        "--background": "oklch(0.148 0.004 228.8)",
        "--card": "oklch(0.218 0.008 223.9)",
    },
}
"""Both surfaces, because a chart inside a card sits on `--card`, which in dark mode is
0.07 lighter than `--background` — enough to take a marginal series below 3:1."""

DESTRUCTIVE_VALUES: Final[dict[Theme, str]] = {
    LIGHT: "oklch(0.577 0.245 27.325)",
    DARK: "oklch(0.704 0.191 22.216)",
}
"""Reserved for verification failure and hard errors, and on no series, delta, gridline or
band. If red appears on a report page it means *this document could not be proven*, and
using it for "high utilization" would dilute the one meaning that has to survive."""

MINIMUM_SURFACE_CONTRAST: Final[float] = 3.0
MINIMUM_CVD_DELTA_E: Final[float] = 0.06
"""The floors the palette was designed against. About one JND is 0.02, so 0.06 is three
times the margin; the palette as shipped measures 0.083 at its worst pair. The floor sits
below the measured value on purpose — it is the line a future edit must not cross."""

# --- Redundant channels -----------------------------------------------------

MARKER_SHAPES: Final[tuple[str, ...]] = ("o", "s", "^", "D", "X")
"""matplotlib marker codes, one per categorical slot: circle, square, triangle, diamond,
cross. `palette.ts` names the same five shapes in words, because SVG has no marker code
vocabulary; `tests/test_chartstyle.py` asserts the two lists correspond position for
position."""

DASH_PATTERNS: Final[tuple[tuple[float, ...] | None, ...]] = (
    None,
    (6.0, 3.0),
    (2.0, 2.0),
    (8.0, 3.0, 2.0, 3.0),
    (4.0, 2.0, 1.0, 2.0),
)
"""matplotlib dash sequences, one per categorical slot. `None` is solid, so a
single-series chart is not gratuitously dashed.

Colour is a **redundant** cue here. Nothing is distinguished by colour alone: every series
carries a direct label, and a line additionally carries a marker and a dash. That is what
makes a chart readable under colour-vision deficiency, in greyscale and in a photocopy —
the palette's measured margins are the backstop, not the guarantee."""

# --- Assignment by stable key -----------------------------------------------

_FNV_OFFSET: Final[int] = 0x811C9DC5
_FNV_PRIME: Final[int] = 0x01000193
_UINT32: Final[int] = 0xFFFFFFFF


def hash_key(key: str) -> int:
    """FNV-1a, 32-bit, over `key`'s UTF-8 bytes.

    Must agree with `palette.ts`'s `hashKey` for every input, so the app and the document
    give one series one colour. FNV-1a is used because it is short enough to transliterate
    without either side drifting; it is not a security hash and does not need to be.

    The `& _UINT32` after the multiply is what keeps Python's arbitrary-precision integers
    in step with JavaScript's `Math.imul`.
    """
    value = _FNV_OFFSET
    for byte in key.encode("utf-8"):
        value ^= byte
        value = (value * _FNV_PRIME) & _UINT32
    return value


def slot_for_key(key: str) -> int:
    """The categorical slot `key` *prefers*. Five slots and unbounded keys, so a
    collision is ordinary and :func:`assign_colors` may move it."""
    return hash_key(key) % CATEGORICAL_LIMIT


def compare_by_code_point(key: str) -> tuple[int, ...]:
    """A sort key ordering by Unicode code point.

    Python's `sorted()` already does this; the function exists so the ordering is named
    on both sides. `palette.ts` needs an explicit comparator because JavaScript's default
    string sort orders by UTF-16 **code unit**, which disagrees for anything outside the
    basic multilingual plane.
    """
    return tuple(ord(character) for character in key)


def assign_colors(keys: tuple[str, ...] | list[str]) -> dict[str, str]:
    """Assign a colour to every series in one chart, deterministically.

    Resolved as a **whole set in one pass**, not key by key. A per-key walk asks "is my
    preferred slot taken by another key's *preferred* slot?", answers yes for both
    colliding keys and moves both to the same next slot — so the chart still draws two
    series in one colour, relocated. Recording each assignment before computing the next
    is the only way the result is a bijection.

    The pass runs in **code-point order**, which is a property of the set rather than of
    the list the caller built: otherwise the same chart assembled in a different order
    would assign different colours, which is the index-assignment defect this avoids.

    Honest consequence: with five slots and arbitrary keys, a key's colour cannot be
    globally fixed *and* collision-free. A key keeps its preferred slot unless a colliding
    key sorting earlier is present. Stability across two views of the *same* series set —
    a chart and the table beside it — is exact, and that is the case that matters.
    """
    ordered = sorted(set(keys), key=compare_by_code_point)
    used: set[int] = set()
    assigned: dict[str, str] = {}

    for key in ordered:
        slot = slot_for_key(key)
        attempts = 0
        while slot in used and attempts < CATEGORICAL_LIMIT:
            slot = (slot + 1) % CATEGORICAL_LIMIT
            attempts += 1
        used.add(slot)
        assigned[key] = CATEGORICAL_TOKENS[slot]
    return assigned


def color_for_key(key: str, siblings: tuple[str, ...] | list[str] = ()) -> str:
    """The categorical token for one series, collision-free within its chart."""
    return assign_colors([key, *siblings])[key]


def marker_for_key(key: str, siblings: tuple[str, ...] | list[str] = ()) -> str:
    """The marker for a series, from the same slot as its colour."""
    return MARKER_SHAPES[CATEGORICAL_TOKENS.index(color_for_key(key, siblings))]


def dash_for_key(
    key: str, siblings: tuple[str, ...] | list[str] = ()
) -> tuple[float, ...] | None:
    """The dash sequence for a series, from the same slot as its colour."""
    return DASH_PATTERNS[CATEGORICAL_TOKENS.index(color_for_key(key, siblings))]


def palette_for(encoding: str) -> tuple[str, ...]:
    """The palette for a **declared** encoding (Req 22.7).

    From the chart node's `encoding` and nothing else — not the series count, not the
    chart type. A peer chart is never coloured from the ramp, because a lightness ramp
    asserts an order peer series do not carry.
    """
    if encoding not in CHART_ENCODINGS:
        raise ValueError(
            f"{encoding!r} is not a declared chart encoding; expected one of "
            f"{CHART_ENCODINGS}"
        )
    return CATEGORICAL_TOKENS if encoding == "categorical" else SEQUENTIAL_TOKENS


def split_for_plotting(
    ordered: tuple[str, ...] | list[str],
) -> tuple[tuple[str, ...], tuple[str, ...]]:
    """`(plotted, aggregated)` for a series list already in the node's declared order.

    Never re-sorted here: the ranking is the chart node's, by its declared ordering
    statistic with ties broken by ascending stable key, and a second ordering rule could
    disagree with the one the document used.
    """
    items = tuple(ordered)
    if len(items) <= CATEGORICAL_LIMIT:
        return items, ()
    return items[:CATEGORICAL_PLOTTED_LIMIT], items[CATEGORICAL_PLOTTED_LIMIT:]


# --- OKLCH to sRGB ----------------------------------------------------------
#
# matplotlib has no stylesheet and no cascade, so a token has to become a concrete hex
# before it can be drawn into a PNG that will be embedded in a Word file.

_OKLCH_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\Aoklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)\Z"
)


def parse_oklch(value: str) -> tuple[float, float, float]:
    """`(L, C, H)` from an `oklch(L C H)` string.

    Only the space-separated, no-alpha form this codebase writes. Anything else raises
    rather than being coerced: a colour silently parsed as black would be a chart that
    renders and is wrong, which is harder to notice than one that fails.
    """
    match = _OKLCH_PATTERN.match(value)
    if match is None:
        raise ValueError(f"not an oklch() colour: {value!r}")
    return (float(match.group(1)), float(match.group(2)), float(match.group(3)))


def _oklch_to_oklab(lightness: float, chroma: float, hue: float) -> tuple[float, float, float]:
    radians = math.radians(hue)
    return (lightness, chroma * math.cos(radians), chroma * math.sin(radians))


def _oklab_to_linear_srgb(
    lightness: float, a: float, b: float
) -> tuple[float, float, float]:
    """Björn Ottosson's OKLab → linear sRGB."""
    l_ = lightness + 0.3963377774 * a + 0.2158037573 * b
    m_ = lightness - 0.1055613458 * a - 0.0638541728 * b
    s_ = lightness - 0.0894841775 * a - 1.2914855480 * b
    long_, medium, short = l_**3, m_**3, s_**3
    return (
        4.0767416621 * long_ - 3.3077115913 * medium + 0.2309699292 * short,
        -1.2684380046 * long_ + 2.6097574011 * medium - 0.3413193965 * short,
        -0.0041960863 * long_ - 0.7034186147 * medium + 1.7076147010 * short,
    )


def _clamp01(value: float) -> float:
    return min(1.0, max(0.0, value))


def _linear_to_srgb(channel: float) -> float:
    """The sRGB transfer function. Needed because a hex triple is gamma-encoded."""
    channel = _clamp01(channel)
    if channel <= 0.0031308:
        return 12.92 * channel
    return 1.055 * channel ** (1 / 2.4) - 0.055


def oklch_to_hex(value: str) -> str:
    """`oklch(L C H)` → `#rrggbb`, gamma-encoded and clamped to the sRGB gamut.

    Clamping rather than gamut-mapping: every colour in this module is inside sRGB by
    construction (they were chosen against it), so a clamp is a no-op for real input and
    a visible, debuggable result for a mistake.
    """
    lightness, chroma, hue = parse_oklch(value)
    linear = _oklab_to_linear_srgb(*_oklch_to_oklab(lightness, chroma, hue))
    channels = (round(_linear_to_srgb(channel) * 255) for channel in linear)
    return "#" + "".join(f"{channel:02x}" for channel in channels)


def hex_for_token(token: str, theme: Theme = LIGHT) -> str:
    """The concrete colour for a palette token, for matplotlib.

    `--cat-other` resolves to `--muted-foreground`, which is what `globals.css` aliases it
    to — the alias is followed here rather than duplicated, so the aggregate series is the
    same neutral in the document as in the app.
    """
    values = CATEGORICAL_VALUES[theme]
    if token in values:
        return oklch_to_hex(values[token])
    if token in SEQUENTIAL_VALUES[theme]:
        return oklch_to_hex(SEQUENTIAL_VALUES[theme][token])
    if token == CAT_OTHER:
        return oklch_to_hex(_MUTED_FOREGROUND[theme])
    raise ValueError(f"{token!r} is not a palette token")


_MUTED_FOREGROUND: Final[dict[Theme, str]] = {
    LIGHT: "oklch(0.56 0.021 213.5)",
    DARK: "oklch(0.723 0.014 214.4)",
}
"""What `--cat-other` aliases to. Asserted against `globals.css` by the mirror test, so
this is a followed alias rather than a second opinion about the neutral."""

_FOREGROUND: Final[dict[Theme, str]] = {
    LIGHT: "oklch(0.148 0.004 228.8)",
    DARK: "oklch(0.987 0.002 197.1)",
}
"""The `--foreground` token — near-black in light, near-white in dark. Used for inline
value labels on charts: the categorical palette carries identity on the *mark*, and the
numeral beside it takes foreground so the text clears 4.5:1 without constraining the
palette's lightness ladder.

Measured ratios (value_label_color on --background):
  light: oklch(0.148 0.004 228.8) on oklch(1 0 0)       → ~16.7:1
  dark:  oklch(0.987 0.002 197.1) on oklch(0.148 0.004 228.8) → ~19.5:1

Both exceed the 4.5:1 WCAG 1.4.3 text floor by a wide margin."""


def _relative_luminance(linear: tuple[float, float, float]) -> float:
    red, green, blue = (_clamp01(channel) for channel in linear)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue


def contrast_ratio(first: str, second: str) -> float:
    """WCAG 2.x contrast between two `oklch()` colours.

    Here as well as in the app's test suite because the document's own charts have to
    clear the same floor, and `render/charts.py` picks a stroke-safe ramp step by asking
    this rather than by hardcoding an index.
    """
    luminances = sorted(
        _relative_luminance(_oklab_to_linear_srgb(*_oklch_to_oklab(*parse_oklch(colour))))
        for colour in (first, second)
    )
    return (luminances[1] + 0.05) / (luminances[0] + 0.05)


# The palette has to be internally consistent or a chart asks for a token that resolves to
# nothing. Asserted at import, the way `errors.py` asserts its own partitions.
assert len(MARKER_SHAPES) == CATEGORICAL_LIMIT, MARKER_SHAPES
assert len(DASH_PATTERNS) == CATEGORICAL_LIMIT, DASH_PATTERNS
assert len(set(MARKER_SHAPES)) == CATEGORICAL_LIMIT, "two slots share a marker"
assert DASH_PATTERNS[0] is None, "the first slot must be solid"
assert set(CATEGORICAL_VALUES) == {LIGHT, DARK}
assert set(SEQUENTIAL_VALUES) == {LIGHT, DARK}
for _theme in (LIGHT, DARK):
    assert tuple(CATEGORICAL_VALUES[_theme]) == CATEGORICAL_TOKENS, _theme
    assert tuple(SEQUENTIAL_VALUES[_theme]) == SEQUENTIAL_TOKENS, _theme
    for _token, _value in CATEGORICAL_VALUES[_theme].items():
        parse_oklch(_value)
    for _token, _value in SEQUENTIAL_VALUES[_theme].items():
        parse_oklch(_value)
assert tuple(SEQUENTIAL_VALUES[DARK].values()) == tuple(
    reversed(tuple(SEQUENTIAL_VALUES[LIGHT].values()))
), "the dark ramp must be the light ramp reversed, not a re-typing of it"


# --------------------------------------------------------------------------- #
# The frozen figure style (Req 22.14)
# --------------------------------------------------------------------------- #
#
# Two renders of one chart node must produce byte-identical image content, because the
# chart data hash and the `.docx` byte-equality guarantee both rest on it. Everything
# below is therefore pinned, and each pin closes a specific way matplotlib's output
# varies between machines or between versions.

CHART_DPI: Final[int] = 200
"""Fixed rather than inherited from `figure.dpi`, which a user-level matplotlibrc can
change. It also fixes the pixel dimensions, which the byte comparison depends on."""

CHART_SIZE_INCHES: Final[tuple[float, float]] = (6.0, 3.2)
"""One size for every chart, so a document's charts share a shape and the emitted PNG
has one pixel geometry. 6 inches sits inside an A4 text column at the theme's 2 cm
margins with room for the direct labels."""

CHART_WIDTH_INCHES: Final[float] = CHART_SIZE_INCHES[0]
"""The width every chart shares, panelled or not — pulled out under its own name so
`chart_size_inches` states plainly which of `CHART_SIZE_INCHES`'s two numbers it is
holding fixed, rather than reaching into a tuple by position a reader has to remember."""

CHART_PANEL_HEIGHT_INCHES: Final[float] = CHART_SIZE_INCHES[1]
"""Req 17.3 — the height of ONE panel. A single-panel chart is exactly
`CHART_SIZE_INCHES` today (`panels` empty means one panel, task 5.1), so fixing this to
the existing single-chart height is what makes a one-panel chart's emitted bytes
byte-identical to every chart rendered before task 5.1, rather than a chart the same
data used to produce coming out a different size now that panels exist as a concept."""

CHART_PANEL_GAP_INCHES: Final[float] = 0.3
"""The vertical gap between two stacked panels — enough to separate a panel's x-axis
tick labels from the panel above's title without the two panels reading as one taller
chart. Not zero: a panel boundary with no visual gap is a panel boundary a reader has
to infer from the axis ranges alone."""


def chart_size_inches(panel_count: int) -> tuple[float, float]:
    """The figure size for a chart with `panel_count` stacked panels (Req 17.3, 17.5).

    Width is always `CHART_WIDTH_INCHES` — panelling stacks panels **vertically**, so
    the width `docx.py::emit_chart`'s `_CHART_WIDTH_INCHES = 6.0` embeds against never
    changes, and a taller PNG still embeds without resampling. Height is `panel_count`
    panels plus `panel_count - 1` gaps between them, so `panel_count == 1` reduces
    exactly to `CHART_SIZE_INCHES`'s own height with zero gaps — the same byte-identical
    guarantee `CHART_PANEL_HEIGHT_INCHES`'s own docstring states.

    `panel_count < 1` is a caller error — a chart always has at least one panel, empty
    `panels` on the AST node included, since that means one panel holding every series
    rather than zero panels holding none — so this raises rather than silently
    clamping to 1, which would hide the caller passing the wrong count.
    """
    if panel_count < 1:
        raise ValueError(
            f"chart_size_inches requires panel_count >= 1, got {panel_count}; a chart "
            f"always has at least one panel (an empty AST `panels` field means one "
            f"panel holding every series, not zero panels)."
        )
    # The stack at full panel height, then clamped to what the page can hold. `docx.py`
    # embeds the image at a fixed WIDTH and passes no height, so python-docx keeps the
    # aspect ratio and Word gets an image as tall as it was drawn — which it **crops**
    # rather than scales. Three panels at the full height is 10.2in against roughly 9.7in
    # of A4 text, and the delivered report showed the memory panel cut through its own
    # y-axis.
    #
    # `min` of the total rather than a divided per-panel height: dividing and
    # re-multiplying returns 7.999999999999999 at five panels, and a figure size that
    # wobbles with the panel count is a figure size that changes the PNG bytes for no
    # reason a reader could see.
    height = (
        panel_count * CHART_PANEL_HEIGHT_INCHES
        + (panel_count - 1) * CHART_PANEL_GAP_INCHES
    )
    return (CHART_WIDTH_INCHES, min(height, MAX_CHART_HEIGHT_INCHES))


MAX_CHART_HEIGHT_INCHES: Final[float] = 8.0
"""The tallest a chart image may be, whatever its panel count.

`render/docx.py::emit_chart` embeds the PNG at a fixed width of 6in and passes no height,
so python-docx preserves the aspect ratio and the image is as tall as it was drawn. Word
does not scale an over-tall image down to the text block — it crops it. A three-panel
chart at the full panel height is 10.2in tall against about 9.7in of A4 text at the
themes' margins, and the delivered report showed the memory panel sliced through the
middle of its own y-axis, with the values above 3.30e9 simply absent.

8.0 rather than the 9.7 that would just fit: the chart is followed by its caption and
usually by the first rows of its companion table, and a chart that exactly fills the text
block pushes both to the next page on their own.

One and two panels are below this at the full panel height, so they are unaffected — the
byte-identical guarantee `CHART_PANEL_HEIGHT_INCHES` states for the single-panel case
still holds, and only a chart that could not fit at all is redrawn.
"""

CHART_FONT: Final[str] = "DejaVu Sans"
"""Named explicitly, never resolved by fallback.

matplotlib ships DejaVu Sans in its own wheel, so it is present wherever matplotlib is —
and the image installs `fonts-dejavu-core` as well, for LibreOffice. A fallback would
resolve to whatever the host has, which changes glyph widths, which changes where every
label lands, which changes the bytes."""

CHART_STROKE_WIDTH: Final[float] = 1.6
CHART_MARKER_SIZE: Final[float] = 4.0
CHART_GRID_WIDTH: Final[float] = 0.6
CHART_LABEL_SIZE: Final[float] = 7.0
CHART_TITLE_SIZE: Final[float] = 9.0

_FROZEN_RC_PARAMS: Final[Mapping[str, object]] = {
    # --- determinism ---------------------------------------------------------
    # PNG metadata carries a creation date by default, which alone would make two
    # renders differ. `metadata={"Software": None}` at save time is the other half.
    "svg.hashsalt": "reporting-agent",
    "path.simplify": False,
    "agg.path.chunksize": 0,
    # --- typography ----------------------------------------------------------
    "font.family": "sans-serif",
    "font.sans-serif": [CHART_FONT],
    "font.size": CHART_LABEL_SIZE,
    "axes.titlesize": CHART_TITLE_SIZE,
    "axes.labelsize": CHART_LABEL_SIZE,
    "xtick.labelsize": CHART_LABEL_SIZE,
    "ytick.labelsize": CHART_LABEL_SIZE,
    # `mathtext` would let a label containing `$` be reinterpreted as maths, which for a
    # currency-adjacent label is a silent corruption rather than an error.
    "text.usetex": False,
    "axes.unicode_minus": False,
    # --- geometry ------------------------------------------------------------
    "figure.figsize": CHART_SIZE_INCHES,
    "figure.dpi": CHART_DPI,
    "savefig.dpi": CHART_DPI,
    "figure.autolayout": False,
    "savefig.bbox": None,
    "savefig.pad_inches": 0.0,
    # --- ink -----------------------------------------------------------------
    "axes.grid": True,
    "axes.grid.axis": "y",
    "grid.linewidth": CHART_GRID_WIDTH,
    "axes.spines.top": False,
    "axes.spines.right": False,
    "lines.linewidth": CHART_STROKE_WIDTH,
    "lines.markersize": CHART_MARKER_SIZE,
    "figure.facecolor": "white",
    "axes.facecolor": "white",
    "savefig.facecolor": "white",
    "savefig.transparent": False,
    # --- legend (Req 17.3, 17.9 determinism) ---------------------------------
    "legend.fontsize": CHART_LABEL_SIZE,
    "legend.framealpha": 0.8,
    "legend.loc": "upper right",
}
"""One block, applied through a context manager at use rather than mutated globally.

Global mutation would make the emitted bytes depend on whether some other module had
already changed an rcParam, which is the opposite of the guarantee."""

SVG_METADATA: Final[Mapping[str, object]] = {"Date": None}
"""Suppress the `<dc:date>` matplotlib writes into an SVG's RDF metadata.

The same reasoning as :data:`PNG_METADATA`'s `Software`: a timestamp in the output makes
two renders of one chart differ in bytes, which is exactly what the replay gate compares.
`svg.hashsalt` in the frozen rc params covers the other source of drift — the element ids,
which are otherwise salted per process."""

PNG_METADATA: Final[Mapping[str, object]] = {"Software": None}
"""Suppresses the `Software` and creation-date chunks matplotlib writes into a PNG.

Passing `None` removes the key rather than blanking it. Without this, two renders of one
chart differ in their metadata chunk and the `.docx` containing them differs too — a
determinism failure with no visible cause."""


def frozen_rc_params() -> dict[str, object]:
    """A fresh copy of the pinned `rcParams`, for `matplotlib.rc_context`."""
    return dict(_FROZEN_RC_PARAMS)


def stroke_safe_token(encoding: str, theme: Theme = LIGHT) -> str:
    """The ramp step a **stroke** may use for a sequential chart (Req 22.15).

    The darkest safe step in light mode and the lightest in dark, i.e. the end furthest
    from the surface. A sequential chart plots one ordered quantity, so it needs one
    stroke colour and there is no ordering to preserve among several.
    """
    if encoding != "sequential":
        raise ValueError(
            f"stroke_safe_token is for a sequential encoding, got {encoding!r}; a peer "
            f"chart takes a categorical token by stable key"
        )
    safe = SEQUENTIAL_STROKE_SAFE[theme]
    if not safe:  # pragma: no cover - both themes declare at least two
        raise ValueError(f"no stroke-safe ramp step for {theme!r}")
    # The last entry either way, and that is not a coincidence to paper over: the ramp is
    # ordered low-lightness-first in light mode and reversed in dark, so its last step is
    # the end furthest from the surface in both — the darkest on white, the lightest on a
    # dark card.
    return safe[-1]


def grid_color(theme: Theme = LIGHT) -> str:
    """Gridlines from the border token, so they never compete with data."""
    return oklch_to_hex(_BORDER[theme])


def axis_label_color(theme: Theme = LIGHT) -> str:
    return oklch_to_hex(_MUTED_FOREGROUND[theme])


def value_label_color(theme: Theme = LIGHT) -> str:
    """Inline value labels — the numerals at each plotted point or bar — take foreground.

    The categorical palette carries identity on the mark; the numeral beside it takes
    `--foreground` so it clears the 4.5:1 WCAG 1.4.3 text floor without constraining the
    palette's lightness ladder. design-system.md records the measured ratios and the
    reasoning (§ "Inline value labels take foreground").
    """
    return oklch_to_hex(_FOREGROUND[theme])


_BORDER: Final[dict[Theme, str]] = {
    LIGHT: "oklch(0.925 0.005 214.3)",
    DARK: "oklch(1 0 0 / 10%)",
}
"""`--border`. The dark value carries an alpha the OKLCH parser here does not accept, so
:func:`grid_color` in dark mode would raise — deliberate: the document is always rendered
on white, and a dark-mode chart image has no use case in a Word file. The app's own charts
read the CSS token directly."""

assert set(_FROZEN_RC_PARAMS) >= {"figure.dpi", "savefig.dpi", "font.sans-serif"}
assert _FROZEN_RC_PARAMS["font.sans-serif"] == [CHART_FONT]
