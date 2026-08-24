"""The palette's third mirror: `chartstyle.py` against `app/components/charts/palette.ts`.

The static images embedded in the `.docx` and the interactive charts in the app are two
views of one figure ledger. If they disagree about which colour a series is, a reader who
learned from the app that teal is CPU and then finds CPU in ochre in the delivered document
has been handed a reason to distrust the whole artifact — and it is the kind of defect that
survives review indefinitely, because each half looks right on its own.

So this is a mirrored pair alongside `lib/events.ts` ↔ `events.py` and
`lib/templates/blocks.ts` ↔ `compile/definition.py`, and it is guarded the same way: this
module **reads the TypeScript across the monorepo path** and asserts equality. A duplicated
constant nobody compares is a constant that has already drifted.

It also asserts the two `hash_key` implementations agree, by running the TypeScript. Equal
constants are necessary and not sufficient: the values could match while the *assignment*
diverged, which would give one series two colours with no constant out of place anywhere.

## Deliberate coupling

Like `app/test/mirror.static.test.ts`, this **fails loudly** rather than skipping when the
other half is missing. A guard that silently skips is a guard that is not running, and this
one exists precisely for the case where somebody edits one side.
"""

from __future__ import annotations

import json
import math
import re
import shutil
import subprocess
from pathlib import Path
from typing import Final

import pytest

from reporting_agent.render import chartstyle as C

AGENT_ROOT: Final[Path] = Path(__file__).resolve().parent.parent
REPO_ROOT: Final[Path] = AGENT_ROOT.parent
APP_ROOT: Final[Path] = REPO_ROOT / "app"
PALETTE_TS: Final[Path] = APP_ROOT / "components" / "charts" / "palette.ts"
GLOBALS_CSS: Final[Path] = APP_ROOT / "app" / "globals.css"


def _palette_source() -> str:
    if not PALETTE_TS.is_file():
        raise AssertionError(
            f"{PALETTE_TS} is absent. The palette is mirrored across the two halves and "
            f"this guard compares them; it fails rather than skipping, because a guard "
            f"that skips is a guard that is not running."
        )
    return PALETTE_TS.read_text()


def _ts_record(source: str, name: str) -> dict[str, dict[str, str]]:
    """Parse an `export const NAME = { light: {...}, dark: {...} } as const` block."""
    match = re.search(
        rf"export const {re.escape(name)} = (\{{.*?\n\}}) as const", source, re.DOTALL
    )
    assert match is not None, f"{name} not found in palette.ts"
    body = match.group(1)

    parsed: dict[str, dict[str, str]] = {}
    for theme_match in re.finditer(r"(light|dark):\s*\{(.*?)\n  \}", body, re.DOTALL):
        theme = theme_match.group(1)
        entries = dict(re.findall(r'"([^"]+)":\s*"([^"]*)"', theme_match.group(2)))
        parsed[theme] = entries
    return parsed


def _ts_string_tuple(source: str, name: str) -> tuple[str, ...]:
    """Parse an `export const NAME = [ "a", "b" ] as const` array of strings."""
    match = re.search(
        rf"export const {re.escape(name)} = \[(.*?)\] as const", source, re.DOTALL
    )
    assert match is not None, f"{name} not found in palette.ts"
    return tuple(re.findall(r'"([^"]*)"', match.group(1)))


# --------------------------------------------------------------------------- #
# The two halves declare the same values
# --------------------------------------------------------------------------- #


def test_the_typescript_half_exists_and_was_parsed() -> None:
    """Guard the guard: every assertion below is vacuous if the parse returned nothing."""
    source = _palette_source()
    assert len(_ts_record(source, "CATEGORICAL_VALUES")) == 2
    assert len(_ts_record(source, "SEQUENTIAL_VALUES")) == 2
    assert len(_ts_string_tuple(source, "CATEGORICAL_TOKENS")) == 5


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_the_categorical_values_are_identical_across_the_two_halves(theme: str) -> None:
    web = _ts_record(_palette_source(), "CATEGORICAL_VALUES")[theme]
    assert web == C.CATEGORICAL_VALUES[theme]


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_the_sequential_values_are_identical_across_the_two_halves(theme: str) -> None:
    web = _ts_record(_palette_source(), "SEQUENTIAL_VALUES")[theme]
    assert web == C.SEQUENTIAL_VALUES[theme]


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_the_surface_values_are_identical_across_the_two_halves(theme: str) -> None:
    web = _ts_record(_palette_source(), "SURFACE_VALUES")[theme]
    assert web == C.SURFACE_VALUES[theme]


def test_the_token_names_are_identical_across_the_two_halves() -> None:
    source = _palette_source()
    assert _ts_string_tuple(source, "CATEGORICAL_TOKENS") == C.CATEGORICAL_TOKENS
    assert _ts_string_tuple(source, "SEQUENTIAL_TOKENS") == C.SEQUENTIAL_TOKENS
    assert _ts_string_tuple(source, "CHART_ENCODINGS") == C.CHART_ENCODINGS


def test_the_stroke_safe_sets_are_identical_across_the_two_halves() -> None:
    source = _palette_source()
    match = re.search(
        r"export const SEQUENTIAL_STROKE_SAFE = (\{.*?\n\}) as const", source, re.DOTALL
    )
    assert match is not None
    for theme in ("light", "dark"):
        theme_match = re.search(rf"{theme}: \[(.*?)\]", match.group(1), re.DOTALL)
        assert theme_match is not None, theme
        web = tuple(re.findall(r'"([^"]*)"', theme_match.group(1)))
        assert web == C.SEQUENTIAL_STROKE_SAFE[theme], theme


def test_the_marker_and_dash_slots_correspond_position_for_position() -> None:
    """The two halves name shapes differently — matplotlib takes `"o"`, SVG needs a word —
    so the assertion is on the *count and order*, not on the strings.

    It still matters: a legend swatch drawn by the app and a line drawn into the document
    have to belong to the same series, and they only do if slot N means one shape in both.
    """
    source = _palette_source()
    web_markers = _ts_string_tuple(source, "MARKER_SHAPES")
    web_dashes = _ts_string_tuple(source, "DASH_PATTERNS")

    assert len(web_markers) == len(C.MARKER_SHAPES) == C.CATEGORICAL_LIMIT
    assert len(web_dashes) == len(C.DASH_PATTERNS) == C.CATEGORICAL_LIMIT

    expected = {"circle": "o", "square": "s", "triangle": "^", "diamond": "D", "cross": "X"}
    for slot, web_name in enumerate(web_markers):
        assert expected[web_name] == C.MARKER_SHAPES[slot], (slot, web_name)

    # Solid first on both sides, so a single-series chart is not gratuitously dashed.
    assert web_dashes[0] == "0"
    assert C.DASH_PATTERNS[0] is None

    # And every other slot is dashed on both sides.
    for slot in range(1, C.CATEGORICAL_LIMIT):
        assert web_dashes[slot] != "0", slot
        assert C.DASH_PATTERNS[slot] is not None, slot


def test_the_limits_are_identical_across_the_two_halves() -> None:
    source = _palette_source()
    assert "CATEGORICAL_LIMIT = CATEGORICAL_TOKENS.length" in source
    assert "CATEGORICAL_PLOTTED_LIMIT = CATEGORICAL_LIMIT - 1" in source
    assert C.CATEGORICAL_LIMIT == 5
    assert C.CATEGORICAL_PLOTTED_LIMIT == 4

    for name, value in (
        ("MINIMUM_SURFACE_CONTRAST", C.MINIMUM_SURFACE_CONTRAST),
        ("MINIMUM_CVD_DELTA_E", C.MINIMUM_CVD_DELTA_E),
    ):
        match = re.search(rf"export const {name} = ([\d.]+)", source)
        assert match is not None, name
        assert float(match.group(1)) == value, name


def test_the_destructive_values_are_identical_across_the_two_halves() -> None:
    source = _palette_source()
    match = re.search(
        r"export const DESTRUCTIVE_VALUES = \{(.*?)\} as const", source, re.DOTALL
    )
    assert match is not None
    web = dict(re.findall(r'(light|dark):\s*"([^"]*)"', match.group(1)))
    assert web == C.DESTRUCTIVE_VALUES


# --------------------------------------------------------------------------- #
# The stylesheet is the third party to the agreement
# --------------------------------------------------------------------------- #


def _declared(token: str, theme: str) -> str:
    """The last declaration of `token` for `theme` in globals.css, as the cascade sees it."""
    selector = r":root" if theme == "light" else r"\.dark"
    found: str | None = None
    for block in re.findall(rf"{selector}\s*\{{([^}}]*)\}}", GLOBALS_CSS.read_text()):
        match = re.search(rf"{re.escape(token)}:\s*([^;]+);", block)
        if match:
            found = match.group(1).strip()
    assert found is not None, f"{token} not declared for {theme}"
    return found


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_the_stylesheet_declares_what_the_agent_draws(theme: str) -> None:
    """The agent never reads CSS, so this is the only thing keeping the document's colours
    equal to the app's rendered ones."""
    for token, value in C.CATEGORICAL_VALUES[theme].items():
        assert _declared(token, theme) == value, token
    for token, value in C.SEQUENTIAL_VALUES[theme].items():
        assert _declared(token, theme) == value, token


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_the_aggregate_alias_is_followed_rather_than_duplicated(theme: str) -> None:
    """`--cat-other` aliases `--muted-foreground` in the stylesheet, and `chartstyle.py`
    resolves the alias to the same value rather than holding a second opinion about what
    the neutral is."""
    assert _declared(C.CAT_OTHER, theme) == "var(--muted-foreground)"
    assert C._MUTED_FOREGROUND[theme] == _declared("--muted-foreground", theme)
    assert C.hex_for_token(C.CAT_OTHER, theme) == C.oklch_to_hex(
        _declared("--muted-foreground", theme)
    )


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_the_foreground_value_matches_the_stylesheet(theme: str) -> None:
    """The value `value_label_color` resolves must be what the stylesheet declares for
    `--foreground`, or the document's inline labels would disagree with the app's."""
    assert C._FOREGROUND[theme] == _declared("--foreground", theme)


def test_cat_one_is_the_products_accent_in_light_mode() -> None:
    assert C.CATEGORICAL_VALUES["light"]["--cat-1"] == _declared("--primary", "light")


# --------------------------------------------------------------------------- #
# The two hash implementations agree
# --------------------------------------------------------------------------- #

_HASH_PROBE = """
import {{ hashKey, slotForKey, assignColors }} from {module}
const keys: string[] = {keys}
const out: Record<string, Record<string, unknown>> = {{
  hash: {{}}, slot: {{}}, assignment: {{}},
}}
for (const key of keys) {{
  out.hash[key] = hashKey(key)
  out.slot[key] = slotForKey(key)
}}
for (const [key, token] of assignColors(keys).entries()) {{
  out.assignment[key] = token
}}
process.stdout.write(JSON.stringify(out))
"""
"""Prints ONLY a JSON payload on stdout, so the Python half can read it without parsing
around log noise — the same discipline `tests/definition_corpus.py` uses for the
Mirror_Guard."""

PROBE_KEYS: Final[tuple[str, ...]] = (
    "",
    "cpu",
    "memory",
    "Percentage CPU",
    "prod-sql-01",
    "/subscriptions/0000/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm1",
    "üñî",
    "a" * 300,
    "0",
    "network-in",
)


def test_the_two_hash_implementations_agree(tmp_path: Path) -> None:
    """Equal constants are necessary and not sufficient.

    The values could match while the *assignment* diverged — a different hash, or a
    different collision walk — and then one series would get two colours with no constant
    out of place anywhere. So this runs the TypeScript.

    Run through `tsx`, which the app already depends on, because `palette.ts` is
    TypeScript and `node` cannot read it. `palette.ts` imports nothing, which is what
    makes loading it in isolation possible at all — the module was kept dependency-free
    partly for this reason.
    """
    if not (APP_ROOT / "node_modules").is_dir():
        raise AssertionError(
            f"{APP_ROOT / 'node_modules'} is absent, so the mirrored half cannot be run. "
            f"Install the app's dependencies with `pnpm install`; this guard fails rather "
            f"than skipping."
        )
    pnpm = shutil.which("pnpm")
    if pnpm is None:
        pytest.skip("pnpm is not installed")

    probe = tmp_path / "probe.mts"
    probe.write_text(
        _HASH_PROBE.format(
            module=json.dumps(PALETTE_TS.as_posix()), keys=json.dumps(list(PROBE_KEYS))
        )
    )

    result = subprocess.run(
        [pnpm, "exec", "tsx", str(probe)],
        cwd=APP_ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    web = json.loads(result.stdout)

    for key in PROBE_KEYS:
        assert web["hash"][key] == C.hash_key(key), f"hash disagrees for {key!r}"
        assert web["slot"][key] == C.slot_for_key(key), f"slot disagrees for {key!r}"

    assert web["assignment"] == C.assign_colors(list(PROBE_KEYS)), (
        "the two halves assign colours differently, so one series would take two colours"
    )


def test_the_hash_starts_from_the_fnv_offset_basis() -> None:
    """The one value that pins the algorithm rather than the implementation."""
    assert C.hash_key("") == 0x811C9DC5


def test_the_hash_stays_a_32_bit_unsigned_integer() -> None:
    for key in PROBE_KEYS:
        value = C.hash_key(key)
        assert 0 <= value <= 0xFFFFFFFF, (key, value)
        assert C.hash_key(key) == value


# --------------------------------------------------------------------------- #
# Assignment
# --------------------------------------------------------------------------- #


def test_assignment_is_a_bijection_at_or_below_the_cap() -> None:
    for seed in range(200):
        keys = [f"key-{seed}-{index}" for index in range(C.CATEGORICAL_LIMIT)]
        assigned = C.assign_colors(keys)
        assert len(assigned) == len(keys)
        assert len(set(assigned.values())) == len(keys), (seed, assigned)


def test_assignment_ignores_the_callers_list_order() -> None:
    """The canonical order is a property of the set. Otherwise the same chart assembled in
    a different order would assign different colours — index assignment, reintroduced."""
    keys = ["memory", "cpu", "network-out", "disk-read", "network-in"]
    forward = C.assign_colors(keys)
    assert C.assign_colors(list(reversed(keys))) == forward
    assert C.assign_colors([keys[2], keys[0], keys[4], keys[1], keys[3]]) == forward


def test_assignment_deduplicates_rather_than_consuming_two_slots() -> None:
    assert len(C.assign_colors(["cpu", "cpu", "memory"])) == 2


def test_a_collision_is_resolved_rather_than_relocated() -> None:
    """The defect a per-key walk produces: both colliding keys move to the same next slot,
    so the chart still draws two series in one colour."""
    target = C.slot_for_key("cpu")
    colliding = next(
        key for key in (f"k{index}" for index in range(5000)) if C.slot_for_key(key) == target
    )
    assigned = C.assign_colors(["cpu", colliding])
    assert len(set(assigned.values())) == 2, assigned


def test_the_marker_and_dash_follow_the_colour() -> None:
    for key in ("cpu", "memory", "prod-web-01"):
        slot = C.CATEGORICAL_TOKENS.index(C.color_for_key(key))
        assert C.marker_for_key(key) == C.MARKER_SHAPES[slot]
        assert C.dash_for_key(key) == C.DASH_PATTERNS[slot]


# --------------------------------------------------------------------------- #
# Palette selection and the cap
# --------------------------------------------------------------------------- #


def test_the_palette_follows_the_declared_encoding() -> None:
    assert C.palette_for("categorical") == C.CATEGORICAL_TOKENS
    assert C.palette_for("sequential") == C.SEQUENTIAL_TOKENS


def test_an_undeclared_encoding_is_refused_rather_than_defaulted() -> None:
    """Defaulting would colour a peer chart from the ramp, asserting an order the series do
    not carry — silently."""
    with pytest.raises(ValueError, match="not a declared chart encoding"):
        C.palette_for("ordinal")


def test_everything_is_plotted_at_or_below_the_cap() -> None:
    for count in range(C.CATEGORICAL_LIMIT + 1):
        series = [f"s{index}" for index in range(count)]
        plotted, aggregated = C.split_for_plotting(series)
        assert plotted == tuple(series)
        assert aggregated == ()


def test_past_the_cap_the_four_largest_are_plotted_and_the_rest_aggregated() -> None:
    series = [f"s{index}" for index in range(9)]
    plotted, aggregated = C.split_for_plotting(series)
    assert plotted == ("s0", "s1", "s2", "s3")
    assert aggregated == ("s4", "s5", "s6", "s7", "s8")
    assert len(plotted) + 1 == C.CATEGORICAL_LIMIT


def test_the_declared_order_is_preserved_rather_than_re_sorted() -> None:
    """The ranking is the chart node's. A second ordering rule here could disagree with the
    one the document used."""
    plotted, _ = C.split_for_plotting(["z", "a", "m", "b", "y", "c"])
    assert plotted == ("z", "a", "m", "b")


# --------------------------------------------------------------------------- #
# OKLCH to sRGB
# --------------------------------------------------------------------------- #


def test_the_conversion_reproduces_the_two_extremes() -> None:
    assert C.oklch_to_hex("oklch(1 0 0)") == "#ffffff"
    assert C.oklch_to_hex("oklch(0 0 0)") == "#000000"


def test_every_token_converts_to_a_six_digit_hex() -> None:
    for theme in ("light", "dark"):
        for token in (*C.CATEGORICAL_TOKENS, *C.SEQUENTIAL_TOKENS, C.CAT_OTHER):
            value = C.hex_for_token(token, theme)
            assert re.fullmatch(r"#[0-9a-f]{6}", value), (theme, token, value)


def test_an_unparseable_colour_is_refused_rather_than_read_as_black() -> None:
    """A colour silently parsed as black is a chart that renders and is wrong, which is
    harder to notice than one that fails."""
    for bad in ("#1f6f78", "oklch(0.5 0.1 200 / 50%)", "rgb(1,2,3)", ""):
        with pytest.raises(ValueError, match="not an oklch"):
            C.parse_oklch(bad)


def test_an_unknown_token_is_refused() -> None:
    with pytest.raises(ValueError, match="not a palette token"):
        C.hex_for_token("--cat-9")


def test_the_contrast_helper_reproduces_the_canonical_ratio() -> None:
    assert C.contrast_ratio("oklch(1 0 0)", "oklch(0 0 0)") == pytest.approx(21, abs=0.1)


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_every_categorical_token_clears_the_contrast_floor(theme: str) -> None:
    """Recomputed on this side too, because the document's charts have to clear the same
    floor as the app's and the agent is what draws them."""
    for token, value in C.CATEGORICAL_VALUES[theme].items():
        for surface in C.SURFACE_VALUES[theme].values():
            ratio = C.contrast_ratio(value, surface)
            assert ratio >= C.MINIMUM_SURFACE_CONTRAST, (theme, token, ratio)


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_every_stroke_safe_ramp_step_clears_the_contrast_floor(theme: str) -> None:
    for token in C.SEQUENTIAL_STROKE_SAFE[theme]:
        value = C.SEQUENTIAL_VALUES[theme][token]
        for surface in C.SURFACE_VALUES[theme].values():
            ratio = C.contrast_ratio(value, surface)
            assert ratio >= C.MINIMUM_SURFACE_CONTRAST, (theme, token, ratio)


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_the_excluded_ramp_steps_genuinely_fail(theme: str) -> None:
    """Guard the guard: if the stroke-safe set were the whole ramp, the test above would
    pass by accident."""
    excluded = [
        token
        for token in C.SEQUENTIAL_TOKENS
        if token not in C.SEQUENTIAL_STROKE_SAFE[theme]
    ]
    assert excluded, theme
    for token in excluded:
        value = C.SEQUENTIAL_VALUES[theme][token]
        worst = min(
            C.contrast_ratio(value, surface) for surface in C.SURFACE_VALUES[theme].values()
        )
        assert worst < C.MINIMUM_SURFACE_CONTRAST, (theme, token, worst)


# --------------------------------------------------------------------------- #
# WCAG 2.1 contrast — a standing gate (Req 17.10)
# --------------------------------------------------------------------------- #
#
# design-system.md requires ≥3:1 for graphical objects (WCAG 1.4.11) and ≥4.5:1
# for inline value text (WCAG 1.4.3), checked against BOTH `--background` AND
# `--card`, in BOTH light and dark.
#
# This is the same posture `app/test/palette.static.test.ts` takes for the CVD
# margins — a standing gate rather than a step somebody remembers, because the
# palette was changed once already because measurement disagreed with the design.

WCAG_GRAPHICAL_OBJECT_FLOOR: Final[float] = 3.0
"""WCAG 2.1 SC 1.4.11 — graphical objects (plotted marks, lines, fill edges)."""

WCAG_TEXT_FLOOR: Final[float] = 4.5
"""WCAG 2.1 SC 1.4.3 — text (inline value labels rendered in the series colour)."""


def _relative_luminance_from_oklch(value: str) -> float:
    """WCAG 2.1 relative luminance, computed from an oklch() token.

    The WCAG formula defines relative luminance as 0.2126*R + 0.7152*G + 0.0722*B where
    R, G, B are *linear* sRGB values. Our pipeline goes oklch → oklab → linear sRGB and
    then applies those coefficients directly, which is correct: the WCAG formula's
    per-channel linearization step is exactly the inverse of the sRGB transfer, so going
    linear → gamma → linear would only add rounding.

    This helper exists to validate the conversion independently of `contrast_ratio`,
    which uses the same internal pipeline. If the helper and the contrast function agree
    on a value whose correct answer is known, both are correct.
    """
    l, c, h = C.parse_oklch(value)
    lab = (l, c * math.cos(math.radians(h)), c * math.sin(math.radians(h)))
    # OKLab → linear sRGB (Björn Ottosson's matrix)
    l_ = lab[0] + 0.3963377774 * lab[1] + 0.2158037573 * lab[2]
    m_ = lab[0] - 0.1055613458 * lab[1] - 0.0638541728 * lab[2]
    s_ = lab[0] - 0.0894841775 * lab[1] - 1.2914855480 * lab[2]
    long_, medium, short = l_**3, m_**3, s_**3
    r = max(0.0, min(1.0, 4.0767416621 * long_ - 3.3077115913 * medium + 0.2309699292 * short))
    g = max(0.0, min(1.0, -1.2684380046 * long_ + 2.6097574011 * medium - 0.3413193965 * short))
    b = max(0.0, min(1.0, -0.0041960863 * long_ - 0.7034186147 * medium + 1.7076147010 * short))
    return 0.2126 * r + 0.7152 * g + 0.0722 * b


def test_luminance_conversion_validated_against_known_pair() -> None:
    """Validate the OKLCH → relative luminance pipeline against a pair whose ratio is
    independently verifiable: `--cat-1` in light mode (oklch(0.52 0.105 223.128)) against
    pure white (oklch(1 0 0), luminance 1.0).

    White has luminance 1.0 by definition, so the contrast ratio is:
        (1.0 + 0.05) / (L_cat1 + 0.05)

    We compute it two ways — through `contrast_ratio` and through our independent
    luminance helper — and assert they agree and produce a specific range. The computed
    value is ~5.19:1, well above the 4.5:1 text floor and the 3.0:1 graphical floor.
    """
    cat_1_light = C.CATEGORICAL_VALUES["light"]["--cat-1"]  # oklch(0.52 0.105 223.128)
    white = "oklch(1 0 0)"

    # 1. White has luminance 1.0
    assert _relative_luminance_from_oklch(white) == pytest.approx(1.0, abs=1e-6)

    # 2. Black has luminance 0.0
    assert _relative_luminance_from_oklch("oklch(0 0 0)") == pytest.approx(0.0, abs=1e-6)

    # 3. Compute the ratio from the helper
    lum_cat_1 = _relative_luminance_from_oklch(cat_1_light)
    helper_ratio = (1.0 + 0.05) / (lum_cat_1 + 0.05)

    # 4. The module's own contrast_ratio must agree
    module_ratio = C.contrast_ratio(cat_1_light, white)
    assert module_ratio == pytest.approx(helper_ratio, rel=1e-6), (
        f"contrast_ratio disagrees with independent luminance computation: "
        f"{module_ratio:.4f} vs {helper_ratio:.4f}"
    )

    # 5. The ratio must be in a specific range — this pins the conversion against a
    #    value we can check by hand. `--cat-1` light is a mid-dark teal; against white
    #    the ratio is approximately 5.19:1.
    assert 5.0 < module_ratio < 5.5, (
        f"--cat-1 light against white should be ~5.19:1, got {module_ratio:.4f}"
    )


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_every_categorical_series_clears_3_to_1_for_graphical_objects(theme: str) -> None:
    """WCAG 1.4.11: graphical objects (plotted marks, line segments, area edges) must
    achieve ≥3:1 against the surface they sit on.

    Checked against BOTH `--background` AND `--card`, because a chart inside a card sits
    on `--card`, which in dark mode is 0.07L lighter than `--background` — enough to take
    a marginal series below the floor.

    Fails naming the series token, the surface token and the theme.
    """
    for token, value in C.CATEGORICAL_VALUES[theme].items():
        for surface_name, surface_value in C.SURFACE_VALUES[theme].items():
            ratio = C.contrast_ratio(value, surface_value)
            assert ratio >= WCAG_GRAPHICAL_OBJECT_FLOOR, (
                f"{token} on {surface_name} in {theme} mode: "
                f"{ratio:.3f}:1 < {WCAG_GRAPHICAL_OBJECT_FLOOR}:1"
            )


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_inline_value_labels_clear_4_5_to_1_in_foreground(theme: str) -> None:
    """WCAG 1.4.3: text (the direct labels rendered at each plotted point or bar segment)
    must achieve ≥4.5:1 against the surface.

    Inline value labels are rendered in `--foreground` (via `value_label_color`), NOT in
    the series colour. The categorical palette carries identity on the *mark* (a graphical
    object at 3:1); the numeral beside it takes foreground so it clears the text floor
    without constraining the palette's lightness ladder.

    Measured ratios that motivated this decision:
      --cat-2 on --background in light: 3.476:1 < 4.5:1 (would fail as series-coloured text)
      --cat-5 on --background in dark:  4.440:1 < 4.5:1 (would fail as series-coloured text)

    Moving the palette was rejected: the ladder is measured and load-bearing (even 0.06
    steps, one rank order across both themes, CVD worst case 0.083 against a 0.06 floor).
    Rendering labels in foreground is the correct fix — design-system.md already states
    colour is a redundant channel and every series carries a direct label.

    Fails naming the surface token and the theme.
    """
    foreground_value = C._FOREGROUND[theme]
    for surface_name, surface_value in C.SURFACE_VALUES[theme].items():
        ratio = C.contrast_ratio(foreground_value, surface_value)
        assert ratio >= WCAG_TEXT_FLOOR, (
            f"--foreground on {surface_name} in {theme} mode: "
            f"{ratio:.3f}:1 < {WCAG_TEXT_FLOOR}:1 (inline value label)"
        )


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_stroke_safe_sequential_steps_clear_3_to_1_naming_the_surface(theme: str) -> None:
    """WCAG 1.4.11 for the sequential ramp's stroke-safe subset — same as the existing
    test but with failure messages naming the surface.

    A sequential chart plots one ordered quantity, so its one stroke is rendered from the
    stroke-safe subset. Fills are unrestricted: a pale low end is a feature of a
    sequential scale, not a defect.
    """
    for token in C.SEQUENTIAL_STROKE_SAFE[theme]:
        value = C.SEQUENTIAL_VALUES[theme][token]
        for surface_name, surface_value in C.SURFACE_VALUES[theme].items():
            ratio = C.contrast_ratio(value, surface_value)
            assert ratio >= WCAG_GRAPHICAL_OBJECT_FLOOR, (
                f"{token} on {surface_name} in {theme} mode: "
                f"{ratio:.3f}:1 < {WCAG_GRAPHICAL_OBJECT_FLOOR}:1"
            )


@pytest.mark.parametrize("theme", ["light", "dark"])
def test_cat_other_clears_both_contrast_floors(theme: str) -> None:
    """The aggregate series `--cat-other` (mapped to `--muted-foreground`) is used for
    both plotted marks AND inline labels on an 'Other (N series)' aggregate, so it must
    clear both 3:1 and 4.5:1.

    Fails naming the surface and the theme.
    """
    value = C._MUTED_FOREGROUND[theme]
    for surface_name, surface_value in C.SURFACE_VALUES[theme].items():
        ratio = C.contrast_ratio(value, surface_value)
        assert ratio >= WCAG_TEXT_FLOOR, (
            f"--cat-other on {surface_name} in {theme} mode: "
            f"{ratio:.3f}:1 < {WCAG_TEXT_FLOOR}:1"
        )
