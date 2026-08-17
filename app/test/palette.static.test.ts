/**
 * The chart palette's accessibility guarantees, computed rather than asserted.
 *
 * Every claim `components/charts/palette.ts` makes about contrast and colour-vision
 * separability is recomputed here from the OKLCH values, through a real colour pipeline:
 * OKLCH → OKLab → linear sRGB → WCAG relative luminance for contrast, and OKLCH →
 * linear sRGB → a Machado dichromacy matrix → OKLab for separability.
 *
 * That is the difference between a palette that is accessible and a palette somebody
 * said was accessible. The first version of these values — the equal-lightness set
 * `design-system.md` specifies — passes every contrast check and fails separability
 * badly: `--cat-1` teal against `--cat-2` violet measures an OKLab ΔE of **0.021**
 * under deuteranopia, which is about one just-noticeable difference. A deuteranopic
 * reader comparing two series would be reading one colour. No amount of review catches
 * that; only arithmetic does.
 *
 * ## Why the maths lives in the test rather than in a dependency
 *
 * `culori` or `colorjs.io` would do this in three lines. Neither is worth adding to a
 * production bundle's dependency tree for a build-time assertion, and both would put
 * the definition of "contrast" inside a package that can change under a bump. The
 * conversions below are the published matrices, transcribed, with the source named.
 *
 * ## What this does not claim
 *
 * A simulation is a model. Machado et al. at severity 1.0 approximates dichromacy, not
 * every real observer, and no numeric threshold substitutes for testing with people.
 * These assertions catch the specific, mechanical failure of two tokens collapsing onto
 * one perceived colour — which is the failure that actually ships.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"

import { describe, expect, it } from "vitest"

import {
  CATEGORICAL_LIMIT,
  CATEGORICAL_PLOTTED_LIMIT,
  CATEGORICAL_TOKENS,
  CATEGORICAL_VALUES,
  CAT_OTHER,
  CHART_ENCODINGS,
  DASH_PATTERNS,
  DESTRUCTIVE_VALUES,
  MARKER_SHAPES,
  MINIMUM_CVD_DELTA_E,
  MINIMUM_SURFACE_CONTRAST,
  SEQUENTIAL_STROKE_SAFE,
  SEQUENTIAL_TOKENS,
  SEQUENTIAL_VALUES,
  SURFACE_VALUES,
  assignColors,
  colorForKey,
  compareByCodePoint,
  cssVar,
  dashForKey,
  hashKey,
  markerForKey,
  paletteFor,
  slotForKey,
  splitForPlotting,
} from "@/components/charts/palette"

// --------------------------------------------------------------------------- //
// Colour science
// --------------------------------------------------------------------------- //

type Triple = readonly [number, number, number]

/** Parse `oklch(L C H)`. Only the space-separated, no-alpha form this codebase writes. */
function parseOklch(value: string): Triple {
  const match = /^oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)$/.exec(value)
  if (!match) throw new Error(`not an oklch() colour: ${value}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

function oklchToOklab([l, c, h]: Triple): Triple {
  const radians = (h * Math.PI) / 180
  return [l, c * Math.cos(radians), c * Math.sin(radians)]
}

/** Björn Ottosson's OKLab → linear sRGB. */
function oklabToLinearSrgb([L, a, b]: Triple): Triple {
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b
  const s_ = L - 0.0894841775 * a - 1.291485548 * b
  const l = l_ ** 3
  const m = m_ ** 3
  const s = s_ ** 3
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ]
}

/** Linear sRGB → OKLab, for measuring a distance after a simulation. */
function linearSrgbToOklab([r, g, b]: Triple): Triple {
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
  const cbrt = (v: number) => (v >= 0 ? Math.cbrt(v) : -Math.cbrt(-v))
  const l_ = cbrt(l)
  const m_ = cbrt(m)
  const s_ = cbrt(s)
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ]
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

/**
 * WCAG 2.x relative luminance.
 *
 * Computed from **linear** sRGB directly: the WCAG formula's per-channel linearization
 * step is exactly the inverse of the sRGB transfer function, so going linear → gamma →
 * linear again would only add rounding.
 */
function relativeLuminance(linear: Triple): number {
  const [r, g, b] = linear.map(clamp01) as unknown as Triple
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}

function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(oklabToLinearSrgb(oklchToOklab(parseOklch(a))))
  const lb = relativeLuminance(oklabToLinearSrgb(oklchToOklab(parseOklch(b))))
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la]
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Machado, Oliveira and Fernandes (2009), severity 1.0, applied to linear RGB.
 *
 * Preferred over Viénot-Brettel-Mollon here because the matrices are published for a
 * severity scale and are a straight 3×3 on linear RGB, so there is nothing to get
 * subtly wrong in transcription.
 */
const DICHROMACY = {
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
} as const

type Dichromacy = keyof typeof DICHROMACY

const DICHROMACIES = Object.keys(DICHROMACY) as Dichromacy[]

function simulate(colour: string, kind: Dichromacy): Triple {
  const linear = oklabToLinearSrgb(oklchToOklab(parseOklch(colour))).map(
    clamp01
  ) as unknown as Triple
  const m = DICHROMACY[kind]
  return [
    clamp01(m[0][0] * linear[0] + m[0][1] * linear[1] + m[0][2] * linear[2]),
    clamp01(m[1][0] * linear[0] + m[1][1] * linear[1] + m[1][2] * linear[2]),
    clamp01(m[2][0] * linear[0] + m[2][1] * linear[1] + m[2][2] * linear[2]),
  ]
}

function deltaE(a: string, b: string, kind?: Dichromacy): number {
  const first = kind
    ? linearSrgbToOklab(simulate(a, kind))
    : oklchToOklab(parseOklch(a))
  const second = kind
    ? linearSrgbToOklab(simulate(b, kind))
    : oklchToOklab(parseOklch(b))
  return Math.hypot(
    first[0] - second[0],
    first[1] - second[1],
    first[2] - second[2]
  )
}

// --------------------------------------------------------------------------- //
// Guard the maths before trusting it
// --------------------------------------------------------------------------- //

describe("the colour pipeline", () => {
  it("converts the two extremes of OKLCH lightness to the expected luminance", () => {
    const white = relativeLuminance(
      oklabToLinearSrgb(oklchToOklab(parseOklch("oklch(1 0 0)")))
    )
    const black = relativeLuminance(
      oklabToLinearSrgb(oklchToOklab(parseOklch("oklch(0 0 0)")))
    )
    expect(white).toBeCloseTo(1, 2)
    expect(black).toBeCloseTo(0, 4)
  })

  it("reproduces the canonical 21:1 black-on-white contrast", () => {
    expect(contrastRatio("oklch(1 0 0)", "oklch(0 0 0)")).toBeCloseTo(21, 1)
  })

  it("reports no distance between a colour and itself, under every simulation", () => {
    const colour = CATEGORICAL_VALUES.light["--cat-1"]
    expect(deltaE(colour, colour)).toBeCloseTo(0, 10)
    for (const kind of DICHROMACIES) {
      expect(deltaE(colour, colour, kind)).toBeCloseTo(0, 10)
    }
  })

  it("collapses red and green under deuteranopia but not under normal vision", () => {
    // The sanity check that proves the simulation does something: a red/green pair that
    // is far apart normally must come much closer under a red-green deficiency.
    const red = "oklch(0.55 0.22 25)"
    const green = "oklch(0.55 0.22 145)"
    const normal = deltaE(red, green)
    const simulated = deltaE(red, green, "deuteranopia")
    expect(normal).toBeGreaterThan(0.3)
    expect(simulated).toBeLessThan(normal / 2)
  })

  it("refuses a colour value it cannot parse rather than scoring it as black", () => {
    expect(() => parseOklch("#1f6f78")).toThrow(/not an oklch/)
    expect(() => parseOklch("oklch(0.5 0.1 200 / 50%)")).toThrow(/not an oklch/)
  })
})

// --------------------------------------------------------------------------- //
// The stylesheet and the module agree
// --------------------------------------------------------------------------- //

const GLOBALS_CSS = readFileSync(
  join(process.cwd(), "app", "globals.css"),
  "utf8"
)

/** The value of `token` inside the `:root` or `.dark` block, whichever is asked for. */
function declaredValue(token: string, theme: "light" | "dark"): string {
  const selector = theme === "light" ? ":root" : "\\.dark"
  // Every block for the selector, because the categorical tokens are appended in a
  // second `:root` / `.dark` pair rather than edited into the preset's own.
  const blocks = [
    ...GLOBALS_CSS.matchAll(new RegExp(`${selector}\\s*\\{([^}]*)\\}`, "g")),
  ].map((match) => match[1])
  let found: string | undefined
  for (const block of blocks) {
    const match = new RegExp(`${token}:\\s*([^;]+);`).exec(block)
    // Last declaration wins, which is what the cascade does.
    if (match) found = match[1].trim()
  }
  if (found === undefined) {
    throw new Error(`${token} is not declared for ${theme} in globals.css`)
  }
  return found
}

describe("globals.css declares what palette.ts says it declares", () => {
  it.each(["light", "dark"] as const)(
    "declares every categorical token in %s",
    (theme) => {
      for (const token of CATEGORICAL_TOKENS) {
        expect(declaredValue(token, theme)).toBe(
          CATEGORICAL_VALUES[theme][token]
        )
      }
    }
  )

  it.each(["light", "dark"] as const)(
    "declares every sequential token in %s",
    (theme) => {
      for (const token of SEQUENTIAL_TOKENS) {
        expect(declaredValue(token, theme)).toBe(
          SEQUENTIAL_VALUES[theme][token]
        )
      }
    }
  )

  it.each(["light", "dark"] as const)(
    "declares the surfaces in %s",
    (theme) => {
      expect(declaredValue("--background", theme)).toBe(
        SURFACE_VALUES[theme]["--background"]
      )
      expect(declaredValue("--card", theme)).toBe(
        SURFACE_VALUES[theme]["--card"]
      )
    }
  )

  it("maps every categorical token into the theme so a utility class exists", () => {
    for (const token of CATEGORICAL_TOKENS) {
      expect(GLOBALS_CSS).toContain(
        `--color-cat-${token.slice(-1)}: var(${token});`
      )
    }
    expect(GLOBALS_CSS).toContain("--color-cat-other: var(--cat-other);")
  })

  it("reverses the sequential ramp for dark surfaces", () => {
    // The preset ships one ramp for both themes, so unchanged it runs the wrong way
    // against its own dark surface. The reversal is the fix, and it must actually be a
    // reversal rather than a re-typing.
    const light = SEQUENTIAL_TOKENS.map(
      (token) => SEQUENTIAL_VALUES.light[token]
    )
    const dark = SEQUENTIAL_TOKENS.map((token) => SEQUENTIAL_VALUES.dark[token])
    expect(dark).toEqual([...light].reverse())
  })

  it("leaves --cat-1 exactly equal to --primary in light mode", () => {
    // A single-series chart should be the product's accent colour, not a near-miss.
    expect(parseOklch(CATEGORICAL_VALUES.light["--cat-1"])).toEqual(
      parseOklch(declaredValue("--primary", "light"))
    )
  })

  it("does not make --cat-1 equal --primary in dark mode, deliberately", () => {
    // The preset's --primary gets *darker* in dark mode (0.45 vs 0.52), so matching it
    // would push a chart series below the contrast floor. Asserted so the divergence
    // reads as a decision rather than as an oversight somebody later "fixes".
    const primary = declaredValue("--primary", "dark")
    expect(CATEGORICAL_VALUES.dark["--cat-1"]).not.toBe(primary)
    expect(
      contrastRatio(primary, SURFACE_VALUES.dark["--background"])
    ).toBeLessThan(MINIMUM_SURFACE_CONTRAST)
    expect(
      contrastRatio(
        CATEGORICAL_VALUES.dark["--cat-1"],
        SURFACE_VALUES.dark["--background"]
      )
    ).toBeGreaterThanOrEqual(MINIMUM_SURFACE_CONTRAST)
  })

  it("changes none of the preset's own token values", () => {
    // The appended block must be additive. These are the preset's identity, and a
    // regenerated stylesheet silently changing them is the failure this guards.
    expect(declaredValue("--primary", "light")).toBe(
      "oklch(0.52 0.105 223.128)"
    )
    expect(declaredValue("--muted-foreground", "light")).toBe(
      "oklch(0.56 0.021 213.5)"
    )
    expect(declaredValue("--radius", "light")).toBe("0.625rem")
    expect(declaredValue("--destructive", "light")).toBe(
      DESTRUCTIVE_VALUES.light
    )
    expect(declaredValue("--destructive", "dark")).toBe(DESTRUCTIVE_VALUES.dark)
  })
})

// --------------------------------------------------------------------------- //
// Contrast (WCAG 1.4.11)
// --------------------------------------------------------------------------- //

describe("every chart colour is legible against every surface", () => {
  it.each(["light", "dark"] as const)(
    "clears 3:1 for every categorical token against both surfaces in %s",
    (theme) => {
      const failures: string[] = []
      for (const token of CATEGORICAL_TOKENS) {
        for (const surface of ["--background", "--card"] as const) {
          const ratio = contrastRatio(
            CATEGORICAL_VALUES[theme][token],
            SURFACE_VALUES[theme][surface]
          )
          if (ratio < MINIMUM_SURFACE_CONTRAST) {
            failures.push(
              `${theme} ${token} on ${surface} = ${ratio.toFixed(2)}:1`
            )
          }
        }
      }
      expect(failures).toEqual([])
    }
  )

  it.each(["light", "dark"] as const)(
    "clears 3:1 for every stroke-safe sequential step in %s",
    (theme) => {
      const failures: string[] = []
      for (const token of SEQUENTIAL_STROKE_SAFE[theme]) {
        for (const surface of ["--background", "--card"] as const) {
          const ratio = contrastRatio(
            SEQUENTIAL_VALUES[theme][token],
            SURFACE_VALUES[theme][surface]
          )
          if (ratio < MINIMUM_SURFACE_CONTRAST) {
            failures.push(
              `${theme} ${token} on ${surface} = ${ratio.toFixed(2)}:1`
            )
          }
        }
      }
      expect(failures).toEqual([])
    }
  )

  it("excludes from the stroke-safe set exactly the steps that fail", () => {
    // Guard the guard: if SEQUENTIAL_STROKE_SAFE were simply the whole ramp, the test
    // above would pass only by accident. Every *excluded* step must genuinely fail.
    for (const theme of ["light", "dark"] as const) {
      const safe = new Set<string>(SEQUENTIAL_STROKE_SAFE[theme])
      const excluded = SEQUENTIAL_TOKENS.filter((token) => !safe.has(token))
      expect(excluded.length).toBeGreaterThan(0)
      for (const token of excluded) {
        const worst = Math.min(
          contrastRatio(
            SEQUENTIAL_VALUES[theme][token],
            SURFACE_VALUES[theme]["--background"]
          ),
          contrastRatio(
            SEQUENTIAL_VALUES[theme][token],
            SURFACE_VALUES[theme]["--card"]
          )
        )
        expect(worst).toBeLessThan(MINIMUM_SURFACE_CONTRAST)
      }
    }
  })

  it("would fail the unreversed dark ramp, which is why it is reversed", () => {
    // The concrete defect: with the preset's own ordering, the high end of the scale is
    // the end you cannot see on a dark surface.
    const unreversed = SEQUENTIAL_VALUES.light
    const belowFloor = SEQUENTIAL_TOKENS.filter(
      (token) =>
        contrastRatio(unreversed[token], SURFACE_VALUES.dark["--background"]) <
        MINIMUM_SURFACE_CONTRAST
    )
    expect(belowFloor).toEqual(["--chart-3", "--chart-4", "--chart-5"])
  })
})

// --------------------------------------------------------------------------- //
// Colour-vision deficiency
// --------------------------------------------------------------------------- //

describe("categorical tokens stay separable under colour-vision deficiency", () => {
  const pairs = CATEGORICAL_TOKENS.flatMap((a, index) =>
    CATEGORICAL_TOKENS.slice(index + 1).map((b) => [a, b] as const)
  )

  it("checks all ten pairs, not only adjacent ones", () => {
    // Colour is assigned by stable key, so any two of the five can co-occur in one
    // chart. Checking only neighbours would leave real combinations unverified.
    expect(pairs).toHaveLength(10)
  })

  it.each(["light", "dark"] as const)(
    "keeps every pair above the delta-E floor under every simulation in %s",
    (theme) => {
      const failures: string[] = []
      for (const [a, b] of pairs) {
        for (const kind of DICHROMACIES) {
          const distance = deltaE(
            CATEGORICAL_VALUES[theme][a],
            CATEGORICAL_VALUES[theme][b],
            kind
          )
          if (distance < MINIMUM_CVD_DELTA_E) {
            failures.push(
              `${theme} ${a}/${b} under ${kind} = ${distance.toFixed(4)}`
            )
          }
        }
      }
      expect(failures).toEqual([])
    }
  )

  it("records the measured worst case, so a regression is visible as a number", () => {
    let worst = Number.POSITIVE_INFINITY
    for (const theme of ["light", "dark"] as const) {
      for (const [a, b] of pairs) {
        for (const kind of DICHROMACIES) {
          worst = Math.min(
            worst,
            deltaE(
              CATEGORICAL_VALUES[theme][a],
              CATEGORICAL_VALUES[theme][b],
              kind
            )
          )
        }
      }
    }
    // As shipped: 0.083, at --cat-3 against --cat-5 under deuteranopia.
    expect(worst).toBeGreaterThan(0.08)
    expect(worst).toBeLessThan(0.1)
  })

  it("would fail the equal-lightness palette design-system.md specifies", () => {
    // The reason the shipped values stagger lightness. This is not a hypothetical: it
    // is the specified palette, measured. --cat-1 teal against --cat-2 violet under
    // deuteranopia is about one just-noticeable difference — one colour, to that reader.
    const equalLightness = {
      "--cat-1": "oklch(0.52 0.105 223)",
      "--cat-2": "oklch(0.53 0.105 293)",
      "--cat-3": "oklch(0.52 0.11 353)",
      "--cat-4": "oklch(0.58 0.105 66)",
      "--cat-5": "oklch(0.54 0.105 148)",
    } as const

    const worstPair = deltaE(
      equalLightness["--cat-1"],
      equalLightness["--cat-2"],
      "deuteranopia"
    )
    expect(worstPair).toBeLessThan(0.03)
    expect(worstPair).toBeLessThan(MINIMUM_CVD_DELTA_E)

    // And the pair the doc predicted would be worst also fails, just less badly.
    expect(
      deltaE(equalLightness["--cat-4"], equalLightness["--cat-5"], "protanopia")
    ).toBeLessThan(MINIMUM_CVD_DELTA_E)
  })

  it("keeps one lightness rank order across both themes", () => {
    // Optimising each theme separately produced better margins and inverted the visual
    // hierarchy on theme toggle, which is worse than a smaller margin: the same series
    // would be the lightest in one theme and among the darkest in the other.
    const rank = (theme: "light" | "dark") =>
      [...CATEGORICAL_TOKENS]
        .sort(
          (a, b) =>
            parseOklch(CATEGORICAL_VALUES[theme][a])[0] -
            parseOklch(CATEGORICAL_VALUES[theme][b])[0]
        )
        .join(",")
    expect(rank("light")).toBe(rank("dark"))
  })

  it("spreads lightness evenly, so the stagger reads as deliberate", () => {
    for (const theme of ["light", "dark"] as const) {
      const lightnesses = CATEGORICAL_TOKENS.map(
        (token) => parseOklch(CATEGORICAL_VALUES[theme][token])[0]
      ).sort((a, b) => a - b)
      const gaps = lightnesses
        .slice(1)
        .map((value, index) => value - lightnesses[index])
      for (const gap of gaps) expect(gap).toBeCloseTo(0.06, 5)
    }
  })

  it("keeps the five hues far enough apart to read as peers to normal vision", () => {
    // The stagger must not become the mechanism: hue is still what a normal-vision
    // reader sees first, which is what keeps the set categorical rather than a ramp.
    const hues = CATEGORICAL_TOKENS.map(
      (token) => parseOklch(CATEGORICAL_VALUES.light[token])[2]
    ).sort((a, b) => a - b)
    const gaps = hues.slice(1).map((value, index) => value - hues[index])
    gaps.push(360 - hues[hues.length - 1] + hues[0])
    for (const gap of gaps) expect(gap).toBeGreaterThan(55)
  })
})

// --------------------------------------------------------------------------- //
// --destructive is reserved
// --------------------------------------------------------------------------- //

describe("--destructive is reserved for verification failure", () => {
  it.each(["light", "dark"] as const)(
    "appears in neither the categorical nor the sequential set in %s",
    (theme) => {
      const used = [
        ...CATEGORICAL_TOKENS.map((token) => CATEGORICAL_VALUES[theme][token]),
        ...SEQUENTIAL_TOKENS.map((token) => SEQUENTIAL_VALUES[theme][token]),
      ]
      expect(used).not.toContain(DESTRUCTIVE_VALUES[theme])
    }
  )

  it.each(["light", "dark"] as const)(
    "is not even approached by a chart colour in %s",
    (theme) => {
      // Exact inequality is too weak: a token a hair away from --destructive would read
      // as red on the page and dilute the one meaning red has to carry.
      for (const token of CATEGORICAL_TOKENS) {
        expect(
          deltaE(CATEGORICAL_VALUES[theme][token], DESTRUCTIVE_VALUES[theme])
        ).toBeGreaterThan(MINIMUM_CVD_DELTA_E)
      }
    }
  )
})

// --------------------------------------------------------------------------- //
// Assignment by stable key
// --------------------------------------------------------------------------- //

describe("colour is assigned by stable key, never by index", () => {
  it("gives one key one colour regardless of the other series present", () => {
    // The property that matters: a resource keeps its colour between the chart and the
    // delta table beside it, and between two charts whose series are ordered
    // differently. Index assignment would break exactly this.
    expect(colorForKey("cpu")).toBe(colorForKey("cpu"))
    expect(colorForKey("/subscriptions/x/prod-sql-01")).toBe(
      colorForKey("/subscriptions/x/prod-sql-01")
    )
  })

  it("is independent of the position a key appears in", () => {
    const first = ["cpu", "memory", "network"]
    const reordered = ["network", "cpu", "memory"]
    for (const key of first) {
      expect(colorForKey(key, first)).toBe(colorForKey(key, reordered))
    }
  })

  it("gives different keys different slots often enough to be useful", () => {
    // Not a uniformity proof, just a check that the hash is not degenerate.
    const slots = new Set(
      [
        "cpu",
        "memory",
        "network-in",
        "network-out",
        "disk-read",
        "disk-write",
        "prod-web-01",
        "prod-sql-01",
      ].map((key) => slotForKey(key))
    )
    expect(slots.size).toBeGreaterThan(1)
  })

  it("never returns a colour outside the five categorical tokens", () => {
    for (let index = 0; index < 500; index += 1) {
      expect(CATEGORICAL_TOKENS).toContain(colorForKey(`series-${index}`))
    }
  })

  it("resolves a collision rather than showing two series in one colour", () => {
    // Five slots means collisions are ordinary, and a two-series chart drawn in one
    // colour reads as a rendering bug rather than as a hash collision.
    //
    // This is the test that caught the first implementation. Resolving one key at a
    // time, it asked "is my preferred slot taken by another key's *preferred* slot?",
    // answered yes for both colliding keys, and moved both to the same next slot — so
    // the collision survived, relocated.
    const colliding: string[] = []
    for (let index = 0; index < 5000 && colliding.length < 1; index += 1) {
      const key = `k${index}`
      if (slotForKey(key) === slotForKey("cpu")) colliding.push(key)
    }
    expect(colliding.length).toBeGreaterThan(0)

    const series = ["cpu", colliding[0]]
    const assigned = series.map((key) => colorForKey(key, series))
    expect(new Set(assigned).size).toBe(series.length)
  })

  it.each([2, 3, 4, 5])(
    "keeps every series distinct for %i series, over many key sets",
    (count) => {
      // Exhaustive enough to hit collisions repeatedly rather than relying on one
      // hand-picked pair.
      for (let seed = 0; seed < 200; seed += 1) {
        const series = Array.from({ length: count }, (_, i) => `s${seed}-${i}`)
        const assigned = series.map((key) => colorForKey(key, series))
        expect(
          new Set(assigned).size,
          `seed ${seed}: ${assigned.join(",")}`
        ).toBe(count)
      }
    }
  )

  it("assigns a bijection for any set at or below the cap", () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const keys = Array.from({ length: 5 }, (_, i) => `key-${seed}-${i}`)
      const assignment = assignColors(keys)
      expect(assignment.size).toBe(keys.length)
      expect(new Set(assignment.values()).size).toBe(keys.length)
    }
  })

  it("gives one assignment for one set regardless of the array order", () => {
    // The canonical order is a property of the set, not of the array the caller built.
    // Without that, the same chart rendered from a differently-ordered list would
    // assign different colours — the index-assignment defect, reintroduced.
    const keys = ["memory", "cpu", "network-out", "disk-read", "network-in"]
    const forward = assignColors(keys)
    const backward = assignColors([...keys].reverse())
    const shuffled = assignColors([keys[2], keys[0], keys[4], keys[1], keys[3]])
    for (const key of keys) {
      expect(backward.get(key)).toBe(forward.get(key))
      expect(shuffled.get(key)).toBe(forward.get(key))
    }
  })

  it("ignores duplicate keys rather than consuming two slots", () => {
    const assignment = assignColors(["cpu", "cpu", "memory"])
    expect(assignment.size).toBe(2)
  })

  it("orders keys by code point, matching Python's sorted()", () => {
    expect(compareByCodePoint("a", "b")).toBeLessThan(0)
    expect(compareByCodePoint("b", "a")).toBeGreaterThan(0)
    expect(compareByCodePoint("a", "a")).toBe(0)
    expect(compareByCodePoint("a", "ab")).toBeLessThan(0)
    // The case JavaScript's default string sort gets wrong: an astral-plane character
    // is above U+E000 by code point and below it by UTF-16 code unit.
    expect(compareByCodePoint("\u{1F600}", "\uE000")).toBeGreaterThan(0)
    expect(["\u{1F600}", "\uE000"].sort()[0]).toBe("\u{1F600}")
  })

  it("hashes UTF-8 bytes, not UTF-16 code units", () => {
    // The bug the cross-language guard caught. `charCodeAt(i) & 0xff` agrees with
    // Python's `key.encode("utf-8")` for ASCII and diverges for everything else, so a
    // tag value with an accent used as a series key would take one colour in the app and
    // a different one in the delivered document.
    //
    // Asserted as a property rather than against a magic number: a key whose UTF-8
    // encoding is longer than its UTF-16 length must hash as the longer byte sequence.
    const key = "üñî"
    expect(new TextEncoder().encode(key)).toHaveLength(6)
    expect(key).toHaveLength(3)

    const utf16Masked = (input: string) => {
      let hash = 0x811c9dc5
      for (let index = 0; index < input.length; index += 1) {
        hash ^= input.charCodeAt(index) & 0xff
        hash = Math.imul(hash, 0x01000193) >>> 0
      }
      return hash >>> 0
    }
    expect(hashKey(key)).not.toBe(utf16Masked(key))

    // And the two agree for ASCII, which is why the divergence was invisible in review.
    expect(hashKey("cpu")).toBe(utf16Masked("cpu"))
  })

  it("hashes deterministically and stays a 32-bit unsigned integer", () => {
    // The Python half must agree byte for byte, so the value has to be well defined.
    for (const key of ["", "cpu", "a".repeat(300), "prod-sql-01", "üñî"]) {
      const value = hashKey(key)
      expect(value).toBe(hashKey(key))
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(0xffffffff)
    }
  })

  it("gives the FNV-1a offset basis for the empty string", () => {
    expect(hashKey("")).toBe(0x811c9dc5)
  })

  it("pairs each colour with a marker and a dash from the same slot", () => {
    // The redundancy has to be consistent, or a legend swatch and a line would
    // disagree about which series they belong to.
    for (const key of ["cpu", "memory", "prod-web-01"]) {
      const slot = CATEGORICAL_TOKENS.indexOf(colorForKey(key))
      expect(markerForKey(key)).toBe(MARKER_SHAPES[slot])
      expect(dashForKey(key)).toBe(DASH_PATTERNS[slot])
    }
  })

  it("declares one marker and one dash per categorical slot", () => {
    expect(MARKER_SHAPES).toHaveLength(CATEGORICAL_LIMIT)
    expect(DASH_PATTERNS).toHaveLength(CATEGORICAL_LIMIT)
    expect(new Set(MARKER_SHAPES).size).toBe(CATEGORICAL_LIMIT)
    expect(new Set(DASH_PATTERNS).size).toBe(CATEGORICAL_LIMIT)
  })

  it("leaves the first dash pattern solid", () => {
    // A single-series chart should not be gratuitously dashed.
    expect(DASH_PATTERNS[0]).toBe("0")
  })
})

// --------------------------------------------------------------------------- //
// Palette selection and the five-series cap
// --------------------------------------------------------------------------- //

describe("the palette follows the declared encoding", () => {
  it("selects the categorical set for peers and the ramp for one ordered quantity", () => {
    expect(paletteFor("categorical")).toEqual(CATEGORICAL_TOKENS)
    expect(paletteFor("sequential")).toEqual(SEQUENTIAL_TOKENS)
  })

  it("never selects the ramp for a categorical chart, whatever its series count", () => {
    // Req 22.7: the agent decides, the client must not guess. A lightness ramp asserts
    // an order peer series do not carry.
    for (const encoding of CHART_ENCODINGS) {
      const palette = paletteFor(encoding)
      const isRamp = palette === SEQUENTIAL_TOKENS
      expect(isRamp).toBe(encoding === "sequential")
    }
  })

  it("declares exactly the two encodings the event vocabulary carries", () => {
    expect([...CHART_ENCODINGS]).toEqual(["categorical", "sequential"])
  })

  it("emits a var() reference a style prop can consume", () => {
    expect(cssVar("--cat-1")).toBe("var(--cat-1)")
    expect(cssVar(CAT_OTHER)).toBe("var(--cat-other)")
  })
})

describe("above five series the rest are aggregated", () => {
  it("plots everything when the count is at or below the cap", () => {
    for (let count = 0; count <= CATEGORICAL_LIMIT; count += 1) {
      const series = Array.from({ length: count }, (_, i) => `s${i}`)
      const { plotted, aggregated } = splitForPlotting(series)
      expect(plotted).toEqual(series)
      expect(aggregated).toEqual([])
    }
  })

  it("plots the four largest and aggregates the rest past the cap", () => {
    const series = Array.from({ length: 9 }, (_, i) => `s${i}`)
    const { plotted, aggregated } = splitForPlotting(series)
    expect(plotted).toEqual(["s0", "s1", "s2", "s3"])
    expect(aggregated).toEqual(["s4", "s5", "s6", "s7", "s8"])
    expect(plotted).toHaveLength(CATEGORICAL_PLOTTED_LIMIT)
  })

  it("leaves room for the aggregate inside the five-colour cap", () => {
    // Four plotted plus one Other is five, so no sixth hue is ever needed.
    expect(CATEGORICAL_PLOTTED_LIMIT + 1).toBe(CATEGORICAL_LIMIT)
  })

  it("preserves the declared order rather than re-sorting", () => {
    // The agent ranks by the node's declared ordering statistic with ties broken by
    // ascending stable key. Re-sorting here would be a second ordering rule that could
    // disagree with the one the document used.
    const series = ["z", "a", "m", "b", "y", "c"]
    expect(splitForPlotting(series).plotted).toEqual(["z", "a", "m", "b"])
  })

  it("uses the muted foreground for the aggregate rather than a sixth hue", () => {
    expect(declaredValue("--cat-other", "light")).toBe(
      "var(--muted-foreground)"
    )
    expect(declaredValue("--cat-other", "dark")).toBe("var(--muted-foreground)")
  })
})
