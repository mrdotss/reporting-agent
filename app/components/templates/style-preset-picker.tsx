"use client"

import { useRef, type KeyboardEvent } from "react"
import Image from "next/image"
import { CheckCircleIcon } from "@phosphor-icons/react"

import { DESIGN_PRESETS, type DesignPreset } from "@/lib/templates/definition"
import type { ThemeThumbnail } from "@/lib/templates/theme-thumbnails"

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

const GRID_COLUMNS = 2

/**
 * Each theme in words: heading typography, table treatment, density
 * (Requirement 13.7).
 *
 * Written against `THEME_SPECS` in the agent's `render/themes.py`. If a theme's
 * declared faces change, these sentences are wrong and the thumbnail is stale —
 * the second is caught by the digest check, the first is not, so these are
 * deliberately about *character* rather than about exact point sizes that would
 * silently drift.
 */
const THEME_DESCRIPTION: Readonly<Record<DesignPreset, string>> = {
  editorial:
    "Editorial theme. Serif headings in the accent colour above a hairline rule, " +
    "serif body text at generous leading, and tables with a ruled header and no " +
    "cell shading. The most spacious of the four — it reads like a printed report.",
  corporate:
    "Corporate theme. Bold sans-serif headings in a deep navy, sans-serif body " +
    "text at normal leading, and tables with a filled header band and ruled rows. " +
    "Conventional and dense enough for a long resource table.",
  technical:
    "Technical theme. Sans-serif headings at a heavier weight with tight letter " +
    "spacing, compact body text, and tables with visible rules on every side. " +
    "The densest of the four — most rows per page.",
  minimal:
    "Minimal theme. Light sans-serif headings with no rule beneath them, plenty " +
    "of white space around body text, and tables with a single rule under the " +
    "header and nothing else. The quietest of the four.",
}

export function StylePresetPicker({
  selected,
  thumbnails,
  onSelect,
}: Readonly<{
  selected: DesignPreset
  thumbnails: readonly ThemeThumbnail[]
  onSelect: (preset: DesignPreset) => void
}>) {
  const refs = useRef(new Map<DesignPreset, HTMLButtonElement>())

  const move = (from: DesignPreset, key: string) => {
    const index = DESIGN_PRESETS.indexOf(from)
    if (index === -1) return

    const delta =
      key === "ArrowRight"
        ? 1
        : key === "ArrowLeft"
          ? -1
          : key === "ArrowDown"
            ? GRID_COLUMNS
            : key === "ArrowUp"
              ? -GRID_COLUMNS
              : 0

    if (delta === 0) return

    // Clamped rather than wrapped. Wrapping in a 2×2 grid puts ArrowRight from
    // the last card onto the first, which reads as the focus jumping rather than
    // as having reached the end.
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
      className="grid grid-cols-1 gap-3 sm:grid-cols-2"
    >
      {thumbnails.map((thumbnail) => {
        const preset = thumbnail.preset
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
            data-slot="preset-card"
            data-preset={preset}
            data-image={thumbnail.src === null ? "unavailable" : "present"}
            role="radio"
            aria-checked={isSelected}
            // Only the selected card is in the tab order; arrow keys move within
            // the group. The roving pattern is what stops a four-card grid
            // costing four tab stops on the way to the next control.
            tabIndex={isSelected ? 0 : -1}
            onClick={() => onSelect(preset)}
            onKeyDown={(event) => handleKey(event, preset)}
            className={[
              "flex flex-col gap-2 rounded-xl border p-2 text-left focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none",
              isSelected ? "border-primary ring-2 ring-ring" : "border-border",
            ].join(" ")}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm capitalize">{preset}</span>

              {/*
                Requirement 13.4 — a glyph, not only a border colour. Hidden from
                the reader because `aria-checked` already carries the state, and
                announcing it twice is noise.
              */}
              {isSelected ? (
                <CheckCircleIcon
                  aria-hidden="true"
                  weight="fill"
                  className="size-4 text-primary"
                />
              ) : null}
            </div>

            {thumbnail.src === null ? (
              <div
                data-slot="preset-image-unavailable"
                // Requirement 13.8 — the name, the description, and an explicit
                // statement. Still a card, still selectable, still in the grid.
                className="flex min-h-[16rem] flex-col justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-4"
              >
                <p className="text-sm">Page image unavailable</p>
                <p className="text-xs text-muted-foreground">{description}</p>
              </div>
            ) : (
              <Image
                src={thumbnail.src}
                // Requirement 13.7 — the description *is* the alternative.
                alt={description}
                // The raster's own intrinsic size, so the card shows the page
                // shape rather than a crop of it (Requirement 13.1). Declaring
                // both is also what lets the browser reserve the space before
                // the file arrives, so selecting a preset does not reflow the
                // grid under the pointer.
                width={720}
                height={1019}
                // Requirement 13.1's floor of 240 CSS pixels, held at every
                // breakpoint: one column below `sm`, two above, and the grid's
                // own gutters are what the calculation subtracts.
                sizes="(min-width: 640px) 20rem, 100vw"
                className="w-full min-w-[240px] rounded-lg border border-border bg-white"
              />
            )}
          </button>
        )
      })}
    </div>
  )
}
