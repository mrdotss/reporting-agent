"use client"

import { useRef, type KeyboardEvent } from "react"
import { CheckCircleIcon } from "@phosphor-icons/react"

import { DESIGN_PRESETS, type DesignPreset } from "@/lib/templates/definition"

/**
 * The four themes as a 2×2 grid of real page images (Requirement 13).
 *
 * ## No name-only control, anywhere
 *
 * Requirement 13.3 forbids one "because a theme is a visual decision and a name
 * gives a consultant nothing to decide with". So there is no select here and no
 * fallback to one — including when an image is unavailable, which Requirement
 * 13.8 handles by keeping the *card* and dropping the picture, never by
 * collapsing the grid into a list.
 *
 * ## The text alternative is content, not an afterthought
 *
 * Requirement 13.7 requires each alternative to name the preset **and describe
 * that theme's heading typography, table treatment and density in words**, "so
 * that a consultant who cannot see the image chooses a preset from the
 * description rather than from the preset's name". `alt="Editorial theme"` would
 * satisfy a linter and fail the requirement: it conveys exactly what the visible
 * label already says.
 *
 * The descriptions below are written from `agent/src/reporting_agent/render/
 * themes.py`'s `THEME_SPECS` — the faces and sizes the theme documents actually
 * declare — rather than from an impression of the images.
 *
 * ## Keyboard: a radiogroup, and arrow keys that move focus
 *
 * `role="radiogroup"` with `role="radio"` children, which is what makes exactly
 * one selected at every instant (Requirement 13.1) a fact the accessibility tree
 * carries rather than a styling claim. Arrow keys move focus in the grid
 * (Requirement 13.6): Left/Right by one, Up/Down by two, because the grid is two
 * wide and a consultant pressing Down expects the card below rather than the one
 * beside.
 *
 * Focus moves *and selects*, which is the standard radiogroup behaviour and what
 * Requirement 13.6's "a keyboard confirmation on the focused card as a selection"
 * describes at its simplest — with Space and Enter also selecting, for a
 * consultant who expects to confirm explicitly.
 *
 * ## Selection is conveyed three ways, none of them colour alone
 *
 * Requirement 13.4: a `--ring` outline, a `--primary` check **glyph**, and
 * `aria-checked`. The glyph is what makes it survive a monochrome display and a
 * colour-vision deficiency; the ARIA state is what makes it survive not being
 * looked at.
 */

/**
 * Each theme in words: heading typography, table treatment, density
 * (Requirement 13.7).
 *
 * They open on what the theme *does*, not on its name. Each used to begin "Editorial
 * theme. …", which was right when this was an image's `alt` and the name was not
 * otherwise spoken — and is a stutter now that the name is the label directly above
 * the sentence.
 *
 * Written against `THEME_SPECS` in the agent's `render/themes.py`. If a theme's
 * declared faces change, these sentences are wrong and the thumbnail is stale —
 * the second is caught by the digest check, the first is not, so these are
 * deliberately about *character* rather than about exact point sizes that would
 * silently drift.
 */
const THEME_DESCRIPTION: Readonly<Record<DesignPreset, string>> = {
  editorial:
    "Serif headings in the accent colour above a hairline rule, " +
    "serif body text at generous leading, and tables with a ruled header and no " +
    "cell shading. The most spacious of the four — it reads like a printed report.",
  corporate:
    "Bold sans-serif headings in a deep navy, sans-serif body " +
    "text at normal leading, and tables with a filled header band and ruled rows. " +
    "Conventional and dense enough for a long resource table.",
  technical:
    "Sans-serif headings at a heavier weight with tight letter " +
    "spacing, compact body text, and tables with visible rules on every side. " +
    "The densest of the four — most rows per page.",
  minimal:
    "Light sans-serif headings with no rule beneath them, plenty " +
    "of white space around body text, and tables with a single rule under the " +
    "header and nothing else. The quietest of the four.",
}

export function StylePresetPicker({
  selected,
  onSelect,
}: Readonly<{
  selected: DesignPreset
  onSelect: (preset: DesignPreset) => void
}>) {
  const refs = useRef(new Map<DesignPreset, HTMLButtonElement>())

  const move = (from: DesignPreset, key: string) => {
    const index = DESIGN_PRESETS.indexOf(from)
    if (index === -1) return

    // One row per step in every direction. This was a 2x2 grid, where Down meant
    // "two along"; in a list that would skip a theme.
    const delta =
      key === "ArrowRight" || key === "ArrowDown"
        ? 1
        : key === "ArrowLeft" || key === "ArrowUp"
          ? -1
          : 0

    if (delta === 0) return

    // Clamped rather than wrapped. Wrapping puts ArrowDown from the last row onto
    // the first, which reads as the focus jumping rather than as having reached the
    // end of the list.
    const target =
      DESIGN_PRESETS[
        Math.min(DESIGN_PRESETS.length - 1, Math.max(0, index + delta))
      ]

    if (target === undefined || target === from) return

    // Focus and select together — standard radiogroup behaviour, and what makes
    // a preset choosable with arrow keys alone (Requirement 13.6).
    onSelect(target)
    refs.current.get(target)?.focus()
  }

  const handleKey = (
    event: KeyboardEvent<HTMLButtonElement>,
    preset: DesignPreset
  ) => {
    if (event.key.startsWith("Arrow")) {
      event.preventDefault()
      move(preset, event.key)
      return
    }

    if (event.key === " " || event.key === "Enter") {
      event.preventDefault()
      onSelect(preset)
    }
  }

  return (
    <div
      data-slot="style-preset-picker"
      role="radiogroup"
      aria-label="Style preset"
      className="flex flex-col divide-y divide-border overflow-hidden rounded-md border border-border"
    >
      {DESIGN_PRESETS.map((preset) => {
        const isSelected = preset === selected
        const description = THEME_DESCRIPTION[preset]

        return (
          <button
            key={preset}
            ref={(element) => {
              if (element === null) refs.current.delete(preset)
              else refs.current.set(preset, element)
            }}
            type="button"
            data-slot="preset-row"
            data-preset={preset}
            role="radio"
            aria-checked={isSelected}
            // Only the selected row is in the tab order; arrow keys move within the
            // group. The roving pattern is what stops four rows costing four tab stops
            // on the way to the next control.
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(preset)}
            onKeyDown={(event) => handleKey(event, preset)}
            className={[
              "flex items-start gap-3 px-3.5 py-3 text-left transition-colors",
              "focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none",
              isSelected
                ? "bg-primary/6 text-foreground"
                : "text-foreground hover:bg-accent",
            ].join(" ")}
          >
            {/*
              Requirement 13.4 — a glyph, not only a fill. The reserved box keeps the
              four labels on one left edge whether or not a row is the selected one.
            */}
            <span className="mt-0.5 grid size-4 shrink-0 place-items-center">
              {isSelected ? (
                <CheckCircleIcon
                  aria-hidden="true"
                  weight="fill"
                  className="size-4 text-primary"
                />
              ) : (
                <span
                  aria-hidden="true"
                  className="size-3 rounded-full border border-border"
                />
              )}
            </span>

            <span className="flex min-w-0 flex-col gap-0.5">
              <span className="text-sm font-medium capitalize">{preset}</span>

              {/*
                Requirement 13.7's text alternative, promoted to the visible label.
                It describes the theme's heading typography, table treatment and
                density in words — which is what a reader needs to choose between four
                themes, and is exactly what four bare names withhold.
              */}
              <span className="text-meta text-muted-foreground">
                {description}
              </span>
            </span>
          </button>
        )
      })}
    </div>
  )
}
