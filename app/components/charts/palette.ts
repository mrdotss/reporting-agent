/**
 * The chart palette: which colour a series gets, and why.
 *
 * Pure data and pure functions. No React, no `server-only` — a colour is not a secret,
 * and both a server component rendering a report surface and a client chart need this.
 *
 * `agent/src/reporting_agent/render/chartstyle.py` holds the same values, because the
 * static images embedded in the `.docx` and the interactive charts in the app have to
 * agree. `agent/tests/test_chartstyle.py` reads this file and asserts they do, the same
 * way `test/mirror.static.test.ts` guards the definition schema across the two halves.
 *
 * ## Two palettes, chosen by the agent, never inferred here
 *
 * The chart node carries a declared `encoding`. A consumer that guessed from series
 * count would colour a one-series categorical chart from the sequential ramp and a
 * five-series sequential chart from the categorical set, both silently:
 *
 * - **`categorical`** — the series are peers. Comparing resources to each other, or
 *   unlike metrics on one resource. Gets `--cat-1` … `--cat-5`.
 * - **`sequential`** — one ordered quantity. A heatmap's density, a histogram's bars,
 *   utilization bands. Gets the preset's `--chart-1` … `--chart-5` ramp.
 *
 * A peer chart is never coloured from the ramp, because a lightness ramp asserts an
 * order peer series do not carry.
 *
 * ## Colour is assigned by stable key, never by array index
 *
 * {@link colorForKey} hashes the series' stable key — the metric key for a metric
 * series, the resource id for a resource series. So `cpu` is `--cat-1` in every chart
 * of one report, and a resource keeps its colour between a chart and the delta table
 * beside it. Index assignment would give the same resource a different colour in two
 * charts whose series happened to be ordered differently, which is worse than no
 * colour: a reader who has learned the mapping is then actively misled.
 *
 * ## Colour is a redundant cue, not the mechanism
 *
 * Every series also carries a direct label, and a line additionally carries a marker
 * shape and a dash pattern ({@link markerForPosition}, {@link dashForPosition}). That is what
 * makes the charts readable under colour-vision deficiency, in greyscale, and in a
 * photocopy. The palette's measured CVD margins are the backstop, not the guarantee.
 */

// --- The encodings ----------------------------------------------------------

export const CHART_ENCODINGS = ["categorical", "sequential"] as const

export type ChartEncoding = (typeof CHART_ENCODINGS)[number]

// --- The categorical palette ------------------------------------------------

/**
 * The five categorical tokens, in rank order by lightness — which is also the order
 * {@link colorForKey} assigns from.
 *
 * Five is the cap, deliberately. A hue ring supports about five reliably separable
 * hues at ~70° spacing; past that you must modulate lightness, at which point you have
 * reinvented the ramp and lost categorical parity. Above five series, aggregate — see
 * {@link CATEGORICAL_LIMIT} and {@link CAT_OTHER}.
 */
export const CATEGORICAL_TOKENS = [
  "--cat-1",
  "--cat-2",
  "--cat-3",
  "--cat-4",
  "--cat-5",
] as const

export type CategoricalToken = (typeof CATEGORICAL_TOKENS)[number]

/** The aggregate bucket for everything past the fifth series. */
export const CAT_OTHER = "--cat-other" as const

/** Req 22.9's cap. Four plotted plus one aggregate, never six hues. */
export const CATEGORICAL_LIMIT = CATEGORICAL_TOKENS.length

/**
 * How many real series are plotted before the rest are aggregated.
 *
 * Four, not five: the fifth slot is the `Other` aggregate, so the plotted set is
 * "the four largest plus everything else". Plotting five and aggregating into a sixth
 * would need a sixth hue.
 */
export const CATEGORICAL_PLOTTED_LIMIT = CATEGORICAL_LIMIT - 1

// --- The sequential ramp ----------------------------------------------------

/** The preset's own ramp, low to high. Fills may use every step. */
export const SEQUENTIAL_TOKENS = [
  "--chart-1",
  "--chart-2",
  "--chart-3",
  "--chart-4",
  "--chart-5",
] as const

export type SequentialToken = (typeof SEQUENTIAL_TOKENS)[number]

/**
 * The ramp steps that clear 3:1 against the surface, per theme, and so are safe for a
 * **stroke, point or 1–2px mark**. Fills are not restricted: a pale low end is exactly
 * what a sequential scale should look like as a heatmap cell or an area band.
 *
 * The general rule is "skip whichever end of the ramp sits nearest the surface", and
 * these are the measured consequences of it:
 *
 * - **light** — `--chart-1` is L 0.872 on an L 1.0 background and measures **1.47:1**.
 *   Invisible. Start at `--chart-2`.
 * - **dark** — the ramp is reversed in `globals.css` so its pale end sits near the
 *   surface, which is right for fills and leaves only the top two steps strokeable
 *   (`--chart-4` at 4.27:1, `--chart-5` at 13.41:1). Two is enough: a sequential chart
 *   plots one ordered quantity, so it has one line, not five.
 */
export const SEQUENTIAL_STROKE_SAFE = {
  light: ["--chart-2", "--chart-3", "--chart-4", "--chart-5"],
  dark: ["--chart-4", "--chart-5"],
} as const satisfies Record<"light" | "dark", readonly SequentialToken[]>

// --- Redundant channels -----------------------------------------------------

/**
 * Marker shapes, one per categorical slot. Paired with colour so a series is
 * identifiable without it.
 */
export const MARKER_SHAPES = [
  "circle",
  "square",
  "triangle",
  "diamond",
  "cross",
] as const

export type MarkerShape = (typeof MARKER_SHAPES)[number]

/**
 * Dash patterns in SVG `stroke-dasharray` form, one per categorical slot. The first is
 * solid, so a single-series chart is not gratuitously dashed.
 */
export const DASH_PATTERNS = ["0", "6 3", "2 2", "8 3 2 3", "4 2 1 2"] as const

export type DashPattern = (typeof DASH_PATTERNS)[number]

// --- Assignment by stable key -----------------------------------------------

/**
 * A small, stable, order-independent hash of a series key.
 *
 * FNV-1a, 32-bit, over the key's **UTF-8 bytes**. Chosen because it has to agree
 * byte-for-byte with `chartstyle.py`'s implementation, and FNV-1a is short enough to
 * transliterate without either side drifting. It is not a security hash.
 *
 * Two details are load-bearing, and the first was a real bug caught by the cross-language
 * guard rather than by review:
 *
 * - **`TextEncoder`, not `charCodeAt`.** `charCodeAt(i) & 0xff` reads a UTF-16 code unit
 *   and masks it to a byte, which agrees with Python's `key.encode("utf-8")` for ASCII
 *   and diverges for everything else — so a tag value with an accent used as a series key
 *   would take one colour in the app and a different one in the document. UTF-8 is the
 *   only byte sequence both languages agree on without qualification.
 * - **`>>> 0` after each step.** JavaScript's bitwise operators coerce to *signed* 32-bit,
 *   so without it the value would go negative and stop matching Python's arbitrary
 *   precision masked to 32 bits.
 */
export function hashKey(key: string): number {
  let hash = 0x811c9dc5
  for (const byte of new TextEncoder().encode(key)) {
    hash ^= byte
    // Math.imul for the FNV-1a 32-bit prime: a plain `*` loses precision once the
    // intermediate product exceeds 2^53.
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

/**
 * The categorical slot a key *prefers*, in `[0, CATEGORICAL_LIMIT)`.
 *
 * The preference, not the answer: five slots and unbounded keys means collisions are
 * ordinary, so {@link assignColors} may move a key to the next free slot.
 */
export function slotForKey(key: string): number {
  return hashKey(key) % CATEGORICAL_LIMIT
}

/**
 * Compare two keys by Unicode code point.
 *
 * `Array.prototype.sort()` on strings orders by UTF-16 **code unit**, which disagrees
 * with Python's `sorted()` for anything outside the basic multilingual plane — a
 * surrogate pair sorts before U+E000 in JavaScript and after it in Python. Series keys
 * here are metric names and Azure resource ids, so it would not currently bite; making
 * the order explicit costs nothing and keeps `chartstyle.py` a transliteration rather
 * than an approximation.
 */
export function compareByCodePoint(a: string, b: string): number {
  const left = [...a]
  const right = [...b]
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    const difference =
      (left[index].codePointAt(0) ?? 0) - (right[index].codePointAt(0) ?? 0)
    if (difference !== 0) return difference
  }
  return left.length - right.length
}

/**
 * Assign a colour to every series in one chart, deterministically.
 *
 * ## Why the whole set is resolved at once
 *
 * Resolving one key at a time cannot work, and the failure is quiet. Given two keys that
 * both prefer slot 2, a per-key walk asks "is slot 2 taken by another key's *preferred*
 * slot?", answers yes for both, and moves both to slot 3 — so the chart still draws two
 * series in one colour, now in a slot neither of them wanted. One pass over the whole
 * set, with each assignment recorded before the next is computed, is the only way the
 * result is a genuine bijection.
 *
 * ## Why the pass runs in sorted order
 *
 * The order has to be a property of the *set*, not of the array the caller happened to
 * build, or the same chart rendered from a differently-ordered list would assign
 * different colours — which is precisely the index-assignment defect this function
 * exists to avoid. Sorting by code point gives one canonical order for one set.
 *
 * A consequence worth being honest about: with five slots and arbitrary keys, a key's
 * colour cannot be *globally* fixed and collision-free at the same time. `cpu` keeps its
 * preferred slot in every chart unless a colliding key that sorts earlier is also
 * present. Stability across two views of *the same series set* — a chart and the delta
 * table beside it — is exact, and that is the case the requirement is about.
 *
 * Past the cap the slots run out; the remaining keys fall back to their preferred slot
 * and will collide. Callers cap first with {@link splitForPlotting}, and the aggregate
 * takes {@link CAT_OTHER} rather than a sixth hue.
 */
export function assignColors(
  keys: readonly string[]
): ReadonlyMap<string, CategoricalToken> {
  const ordered = [...new Set(keys)].sort(compareByCodePoint)
  const used = new Set<number>()
  const assigned = new Map<string, CategoricalToken>()

  for (const key of ordered) {
    let slot = slotForKey(key)
    for (
      let attempt = 0;
      attempt < CATEGORICAL_LIMIT && used.has(slot);
      attempt += 1
    ) {
      slot = (slot + 1) % CATEGORICAL_LIMIT
    }
    used.add(slot)
    assigned.set(key, CATEGORICAL_TOKENS[slot])
  }
  return assigned
}

/**
 * The categorical token for one series.
 *
 * `siblings` is the other series in the same chart, so the result is collision-free
 * within it. Omit it for a single-series chart.
 */
export function colorForKey(
  key: string,
  siblings: readonly string[] = []
): CategoricalToken {
  const token = assignColors([key, ...siblings]).get(key)
  // Unreachable: `key` is always in the set handed to assignColors.
  return token ?? CATEGORICAL_TOKENS[slotForKey(key)]
}

/** The marker shape for the series drawn `index`-th in this chart's plotted order. */
export function markerForPosition(index: number): MarkerShape {
  return MARKER_SHAPES[index % MARKER_SHAPES.length]
}

/**
 * The dash pattern for the series drawn `index`-th in this chart's plotted order.
 *
 * ## Why position and not the colour's slot
 *
 * Both were read off the series' colour slot, which is `hash(stable key) % 5`. Req 22.8
 * requires that of the **colour**, so one metric carries one hue across every chart in a
 * report; it says nothing about the dash, and the coupling cost two things:
 *
 * - `DASH_PATTERNS[0]` is `"0"` so that a single-series chart is not gratuitously dashed
 *   — the claim its own comment made. It was not true: of seven realistic single-series
 *   keys, six hashed to a non-zero slot and drew a lone dash-dot line.
 * - A two-series chart drew both lines dashed, so neither read as the one being followed.
 *
 * Position fixes both by construction, and no two series in one chart can share a
 * pattern — which is all Req 22.10 asks for. Colour is untouched and still keyed.
 *
 * Mirrored in `agent/src/reporting_agent/render/chartstyle.py`, which draws the same
 * series into the `.docx`: the two must not disagree about which line is dashed.
 */
export function dashForPosition(index: number): DashPattern {
  return DASH_PATTERNS[index % DASH_PATTERNS.length]
}

// --- Palette selection ------------------------------------------------------

/**
 * The palette for a declared encoding.
 *
 * Takes the encoding the chart node carries and nothing else — not the series count,
 * not the chart type. Req 22.7 is explicit that the agent decides and the client must
 * not guess.
 */
export function paletteFor(
  encoding: ChartEncoding
): readonly (CategoricalToken | SequentialToken)[] {
  return encoding === "categorical" ? CATEGORICAL_TOKENS : SEQUENTIAL_TOKENS
}

/** A CSS `var()` reference for a token, for a `style` prop or a Recharts `fill`. */
export function cssVar(token: string): string {
  return `var(${token})`
}

/**
 * Split a series list into the ones plotted individually and the ones aggregated.
 *
 * `ordered` must already be in the node's declared ordering — the agent ranks by the
 * chart's declared ordering statistic with ties broken by ascending stable key, and
 * re-sorting here would be a second ordering rule that could disagree with the one the
 * document used.
 */
export function splitForPlotting<T>(ordered: readonly T[]): {
  plotted: readonly T[]
  aggregated: readonly T[]
} {
  if (ordered.length <= CATEGORICAL_LIMIT) {
    return { plotted: ordered, aggregated: [] }
  }
  return {
    plotted: ordered.slice(0, CATEGORICAL_PLOTTED_LIMIT),
    aggregated: ordered.slice(CATEGORICAL_PLOTTED_LIMIT),
  }
}

// --- The tokens' literal values ---------------------------------------------

/**
 * The OKLCH values `globals.css` declares, per theme.
 *
 * Duplicated from the stylesheet on purpose, and the duplication is guarded rather than
 * hoped about: `test/palette.static.test.ts` parses `globals.css` and asserts these
 * match, and `agent/tests/test_chartstyle.py` asserts the Python half matches too.
 *
 * They are needed as data because two consumers cannot read a CSS custom property:
 * the contrast and colour-vision assertions in the test suite, and `chartstyle.py`,
 * which hands matplotlib a concrete colour for an image embedded in a Word file where
 * no stylesheet exists.
 */
export const CATEGORICAL_VALUES = {
  light: {
    "--cat-1": "oklch(0.52 0.105 223.128)",
    "--cat-2": "oklch(0.64 0.105 293)",
    "--cat-3": "oklch(0.46 0.11 353)",
    "--cat-4": "oklch(0.58 0.105 66)",
    "--cat-5": "oklch(0.4 0.105 148)",
  },
  dark: {
    "--cat-1": "oklch(0.68 0.105 223.128)",
    "--cat-2": "oklch(0.8 0.105 293)",
    "--cat-3": "oklch(0.62 0.11 353)",
    "--cat-4": "oklch(0.74 0.105 66)",
    "--cat-5": "oklch(0.56 0.105 148)",
  },
} as const satisfies Record<"light" | "dark", Record<CategoricalToken, string>>

/** The sequential ramp's values, per theme. Dark is the reversal, not the preset order. */
export const SEQUENTIAL_VALUES = {
  light: {
    "--chart-1": "oklch(0.872 0.007 219.6)",
    "--chart-2": "oklch(0.56 0.021 213.5)",
    "--chart-3": "oklch(0.45 0.017 213.2)",
    "--chart-4": "oklch(0.378 0.015 216)",
    "--chart-5": "oklch(0.275 0.011 216.9)",
  },
  dark: {
    "--chart-1": "oklch(0.275 0.011 216.9)",
    "--chart-2": "oklch(0.378 0.015 216)",
    "--chart-3": "oklch(0.45 0.017 213.2)",
    "--chart-4": "oklch(0.56 0.021 213.5)",
    "--chart-5": "oklch(0.872 0.007 219.6)",
  },
} as const satisfies Record<"light" | "dark", Record<SequentialToken, string>>

/**
 * The surfaces a chart mark has to be legible against.
 *
 * Both, not just `--background`: a chart inside a `Card` sits on `--card`, which in
 * dark mode is a full 0.07 lighter — enough to take a marginal series below 3:1.
 */
export const SURFACE_VALUES = {
  light: {
    "--background": "oklch(1 0 0)",
    "--card": "oklch(1 0 0)",
  },
  dark: {
    "--background": "oklch(0.148 0.004 228.8)",
    "--card": "oklch(0.218 0.008 223.9)",
  },
} as const satisfies Record<
  "light" | "dark",
  Record<"--background" | "--card", string>
>

/**
 * Reserved for verification failure and hard errors, and excluded from every chart set.
 *
 * If red appears on a report page it means *this document could not be proven*. Using
 * it for "high utilization" or a negative delta would dilute the one meaning that has
 * to survive: CPU rising is not "bad", and disk free space falling is not the same kind
 * of "down" as network throughput falling.
 */
export const DESTRUCTIVE_VALUES = {
  light: "oklch(0.577 0.245 27.325)",
  dark: "oklch(0.704 0.191 22.216)",
} as const

/**
 * The floor the palette was designed against, asserted by the test suite.
 *
 * `MINIMUM_SURFACE_CONTRAST` is WCAG 1.4.11's ratio for a graphical object.
 * `MINIMUM_CVD_DELTA_E` is an OKLab distance: about one JND is 0.02, so 0.06 is three
 * times the margin, and the palette as shipped measures 0.083 at its worst pair under
 * any of deuteranopia, protanopia and tritanopia. The floor sits below the measured
 * value on purpose — it is the line a future edit must not cross, not a restatement of
 * today's number.
 */
export const MINIMUM_SURFACE_CONTRAST = 3
export const MINIMUM_CVD_DELTA_E = 0.06
