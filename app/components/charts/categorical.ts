import {
  CAT_OTHER,
  CATEGORICAL_PLOTTED_LIMIT,
  CATEGORICAL_TOKENS,
  DASH_PATTERNS,
  MARKER_SHAPES,
  compareByCodePoint,
  slotForKey,
  type CategoricalToken,
  type DashPattern,
  type MarkerShape,
} from "@/components/charts/palette"

/**
 * One series' visual identity: colour, marker and dash (Requirements 22.8,
 * 22.9, 22.11).
 *
 * **Pure, and deliberately not `server-only`.** Requirement 22.7 renders charts
 * client-side from the structured spec, so this runs in the browser.
 *
 * ## This composes `palette.ts`'s assignment; it does not re-implement it
 *
 * `palette.ts#slotForKey` is an FNV-1a hash that agrees **byte-for-byte** with
 * `agent/src/reporting_agent/render/chartstyle.py`, so a series is the same
 * colour in the `.docx` chart image and in the in-app chart. A second assignment
 * here — even a defensible one, like sorting the keys and taking the index —
 * would make the two disagree, and the disagreement would be silent: both charts
 * would look fine, and only a consultant comparing the printed report to the
 * screen would notice teal had moved.
 *
 * That was the first version of this file, and it is why the import list above
 * is what it is. What this module adds is the *pairing*: a slot becomes a token
 * **and** a marker **and** a dash, which is Requirement 22.8's "nothing
 * distinguished by colour alone" applied at the one place a slot turns into
 * something drawable.
 *
 * ## Five is a cap, and the fifth slot is the aggregate
 *
 * Four plotted plus `Other`. Plotting five and aggregating into a sixth would
 * need a sixth hue, and a hue ring supports about five reliably separable hues
 * at the spacing this palette uses.
 */

export type SeriesStyle = {
  /** A CSS custom property **name**, e.g. `--cat-1`. Never a resolved colour. */
  readonly token: CategoricalToken | typeof CAT_OTHER
  readonly marker: MarkerShape
  readonly dash: DashPattern
  /** `true` for the aggregate slot, which stands for more than one series. */
  readonly aggregate: boolean
}

/**
 * The style for one slot.
 *
 * The marker and the dash vary in the aggregate slot too, so `Other` is
 * distinguishable from the fourth series without colour — which is the whole
 * point of carrying three channels rather than one.
 */
export function styleForSlot(slot: number): SeriesStyle {
  const bounded = Math.max(0, Math.min(slot, CATEGORICAL_TOKENS.length - 1))
  const aggregate = bounded >= CATEGORICAL_PLOTTED_LIMIT

  return {
    token: aggregate ? CAT_OTHER : CATEGORICAL_TOKENS[bounded]!,
    marker: MARKER_SHAPES[bounded]!,
    dash: DASH_PATTERNS[bounded]!,
    aggregate,
  }
}

/** The style for one series key (Requirement 22.11). */
export function styleForKey(key: string): SeriesStyle {
  return styleForSlot(slotForKey(key))
}

/**
 * Styles for a set of series keys, keyed by key.
 *
 * Iterated in code-point order so the map's own iteration order is stable across
 * two renders of the same set — a legend built from it does not reorder between
 * a server pass and hydration. The *assignment* does not depend on the order at
 * all: it is a hash of the key.
 */
export function assignSeries(
  keys: readonly string[]
): ReadonlyMap<string, SeriesStyle> {
  const ordered = [...new Set(keys)].sort(compareByCodePoint)

  return new Map(ordered.map((key) => [key, styleForKey(key)]))
}

/**
 * `var(--cat-1)`, for a `stroke` or a `fill`.
 *
 * A custom property reference rather than a resolved colour, so a chart follows
 * the viewer's theme without re-rendering — `globals.css` redefines every
 * `--cat-*` under the dark scheme, and a hex value baked in here would stay
 * light-mode teal on a dark page.
 */
export function cssVar(token: string): string {
  return `var(${token})`
}
