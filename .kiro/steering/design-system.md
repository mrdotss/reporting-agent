# Design system & agentic UX

Target: **an issuing room, not a dashboard.**

This product's thesis is that a number in a delivered report can be proved. A
deterministic pipeline collects into an immutable snapshot, a compiler emits figures
from that snapshot and nothing else, a verifier proves the document and the snapshot
agree, and nothing ships if a check fails. That is not a dashboard's job — it is a
**calibration certificate's** job. So the surface is built from the room where
certificates are written, sealed and entered into a register.

## The direction, in five decisions

1. **The app is shaped like the record it issues.** No sidebar. Navigation is a
   register bar and a tab strip on the same paper as the content, because a document
   has a header, not a rail. Five links never needed 256px and a second mobile
   rendering.
2. **The counterfoil is the signature element.** A record's identity and verdict —
   number, seal, window, state — sit in a narrow column behind a perforation rule, the
   way a counterfoil is torn from a receipt and retained. It is the one thing a reader
   consults before trusting anything beside it. `components/reports/counterfoil.tsx`.
3. **A digest is drawn as a seal, not as a string.** The snapshot id *is* the hash of
   the snapshot's bytes, which makes it the most load-bearing identifier on any screen.
   `components/ui/seal.tsx` gives it a well, a struck leading edge, an eight-character
   head at reading size and the full tail beneath — nothing hidden, nothing truncated.
4. **State is a struck stamp, not a pill.** Small caps, tracked, ruled on all four
   sides, in the state's own ink, with a dot so colour is never the only channel.
   A pill says "tag"; these are verdicts. `components/ui/stamp.tsx`.
5. **Figures are a ledger tally, not KPI cards.** One right edge, a dotted leader, and
   labels that get to be whole sentences. A box around a number adds a container the
   number did not need and shrinks its label to a two-word caption.

## Palette — the assay office

Inventoried from the physical room, and declared in `.workspace-design` in
`app/globals.css`. That scope is the app's own token layer and is deliberately separate
from two things it must not disturb: the vendored Luma preset in `:root`/`.dark`
(guarded by `globals-preset.static.test.ts`) and the `--cat-*` categorical chart
palette, whose lightness ladder is measured against three dichromacy simulations and
mirrored into the agent (`agent/tests/test_chartstyle.py` asserts all three agree).
**Charts belong to the rendered document; this palette is app chrome.**

| role | light | meaning |
|---|---|---|
| ground | `#ecefe8` | accountant's columnar pad — not cream, not slate |
| sheet | `#f5f7f2` | a page laid on the stack |
| well | `#e2e6dc` | inset. Inputs receive content |
| ink | `#18282c` | iron-gall, oxidised blue-black with a green cast |
| verdigris | `#2c6b5e` | oxidised copper. **The one accent. Means: traceable.** |
| vermilion | `#a03726` | the stamp. **Means: could not be proven. Nothing else.** |
| brass | `#856520` | a credential approaching expiry. Attention, not failure |

Status keeps its own four-step scale (`--status-*`), separate from the accent, so a
verified stamp and a primary button are never the same signal.

## Typography — three voices, each doing a job

| role | face | why |
|---|---|---|
| document | **Spectral** | the artifact is a printed document; the app's headings speak in its register so the two read as one object |
| interface | **Archivo** | a grotesk with institutional bones that holds at 11px in a table cell |
| figure | **IBM Plex Mono** | every figure, hash, identifier and timestamp — always tabular |

A serif is deliberate here. The previous system banned it, defending against an
inherited editorial-serif direction; that defence was right about the inheritance and
wrong about the merits, because this product's output really is a document.

The ramp is declared as Tailwind `@theme` tokens at the foot of `globals.css`:
`text-display · text-title · text-section · text-meta · text-micro`, plus
`text-figure` and `text-figure-sm`. Each carries its own line-height, tracking and
weight, because those are what drift when only the size is stated. **A bare `<h1>` is
the landing title and exactly one surface uses it**; every other page says
`text-title`.

## Depth — rules and tint. No shadows.

Paper does not cast a shadow on itself. Surfaces separate by a hairline or a few
percent of lightness. The one exception is an overlay, which still has to read as
*above*: `dialog.tsx`, `select.tsx` and `popover.tsx` carry a tight 1px ring of the
ink rather than a blur. Do not reintroduce `shadow-md` anywhere else, and do not try
to suppress it by overriding `--shadow-*` — Tailwind v4 inlines a shadow's value at
build time, so that override is a declaration that looks like it works and does not.

**Radii are 2–3px** (`--radius: 0.125rem`), because printed forms have square corners.

## Design DNA — the Luma preset (vendored; describes `:root`, not the app)

> **Read this heading carefully.** Everything in this section is still an accurate
> description of the preset tokens in `:root` and `.dark`, which ship exactly as
> generated and are guarded by `globals-preset.static.test.ts`. It is **no longer a
> description of what the app renders.** The app renders the assay-office palette
> above, declared in `.workspace-design`, which overrides every colour, the radius
> scale and all three typefaces.
>
> The preset is kept rather than regenerated for two reasons: the shadcn registry
> resolves components against it, and the `--cat-*` chart palette is derived from its
> primary and mirrored into the agent. Where this section and the direction above
> disagree — teal against verdigris, 10px against 2px, pills against ruled controls,
> "no serif anywhere" against Spectral — **the direction above wins**, and this section
> is describing the layer underneath it.
Initialized with `--preset b3f0SLkV6m`. The tokens below are transcribed from the
**actual** `app/components.json` and `app/app/globals.css` in this repo — they are
facts about the code, not aspirations.

### Colour (light)
| token | value | note |
|---|---|---|
| `--background` | `oklch(1 0 0)` | pure white |
| `--foreground` | `oklch(0.148 0.004 228.8)` | near-black, cool-biased |
| `--primary` | `oklch(0.52 0.105 223.128)` | **teal**, the one chromatic voice |
| `--primary-foreground` | `oklch(0.984 0.019 200.873)` | |
| `--muted` / `--accent` | `oklch(0.963 0.002 197.1)` | identical values |
| `--muted-foreground` | `oklch(0.56 0.021 213.5)` | |
| `--border` / `--input` | `oklch(0.925 0.005 214.3)` | hairline |
| `--ring` | `oklch(0.723 0.014 214.4)` | |
| `--destructive` | `oklch(0.577 0.245 27.325)` | the only high-chroma token |
| `--sidebar` | `oklch(0.987 0.002 197.1)` | a hair off `--background` |
| `--sidebar-primary` | `oklch(0.609 0.126 221.723)` | lighter, more saturated teal |

`mist` neutrals are **not** zinc: they carry a slight cool/teal cast (hue ~197–229
at very low chroma). Do not substitute `zinc`, `slate` or `gray` utilities for the
semantic tokens — the mismatch shows up as a dirty grey next to the real surfaces.

### Colour (dark)
`--background: oklch(0.148 0.004 228.8)`, `--card: oklch(0.218 0.008 223.9)`,
`--border: oklch(1 0 0 / 10%)`, `--input: oklch(1 0 0 / 15%)`,
`--destructive: oklch(0.704 0.191 22.216)`.

Two things worth knowing:
- **`--primary` gets *darker* in dark mode** — `oklch(0.45 0.085 224.283)` vs
  `0.52 0.105 223.128` in light. That is the preset's intent, not a bug. It means a
  filled primary button in dark mode relies on `--primary-foreground` for contrast,
  and **teal-on-dark text is not `--primary`** — use `--sidebar-primary`
  (`oklch(0.715 0.143 215.221)`) or a locally lifted teal for chromatic text and
  icons in dark mode.
- `menuColor: "default"`, `menuAccent: "subtle"` — menus sit on the default
  surface with a quiet accent. Do **not** build cold-agent's inverted dark menu.

### Radius — rounded, and the scale is multiplicative
`--radius: 0.625rem` (10px), and `@theme inline` derives the rest:

| token | factor | value |
|---|---|---|
| `--radius-sm` | ×0.6 | 0.375rem |
| `--radius-md` | ×0.8 | 0.5rem |
| `--radius-lg` | ×1 | **0.625rem** |
| `--radius-xl` | ×1.4 | 0.875rem |
| `--radius-2xl` | ×1.8 | 1.125rem |
| `--radius-3xl` | ×2.2 | 1.375rem |
| `--radius-4xl` | ×2.6 | 1.625rem |

The generated `button.tsx` uses **`rounded-4xl`** on an `h-9` control, i.e. buttons
are effectively **pills**. Cards, inputs, tables and panels are **not** — they sit
at `rounded-lg`/`rounded-xl`. Keep that contrast: *controls are pills, surfaces are
10–14px.* Rounding a data table into a pill is as wrong as squaring off a button.

### Typography — all sans, three faces
Wired in `app/app/layout.tsx` via `next/font`:

| role | face | variable | Tailwind |
|---|---|---|---|
| headings / display | **Geist** | `--font-heading` | `font-heading` |
| body / UI | **Inter** | `--font-sans` | `font-sans` (set on `<html>`) |
| numerals / ids / code | **Geist Mono** | `--font-mono` | see caveat |

No serif anywhere. Section labels are **sans, uppercase, tracked** — not tracked
serif. Hierarchy comes from size, weight and whitespace, not from a second voice.

> **Mono caveat:** `@theme inline` maps `--font-sans` and `--font-heading` but
> **not** `--font-mono`, even though `next/font` does set `--font-mono` on `<html>`.
> Before the first mono usage, add the one missing line to the existing
> `@theme inline` block — `--font-mono: var(--font-mono);` — so `font-mono`
> resolves deterministically rather than depending on stylesheet order. That is an
> **additive** one-line edit; it is not a licence to regenerate `globals.css`.

**Use mono for every figure.** Metric values, deltas, resource ids, snapshot
hashes, percentages and byte counts go in Geist Mono with **tabular alignment** so
columns of numbers line up and a changing value does not reflow its row. In a
product whose thesis is "the numbers are trustworthy", numerals that jitter as
they stream undercut the whole argument.

### Icons — Phosphor
`@phosphor-icons/react` 2.1.10. `components.json` sets `iconLibrary: "phosphor"`,
so generated components already expect it.

- **`rsc: true` matters.** Import from **`@phosphor-icons/react/ssr`** in server
  components; the default `@phosphor-icons/react` entry is the client build. Both
  export maps are present in the installed package (`./ssr`, `./dist/ssr/*`,
  `./dist/csr/*`). Getting this wrong shows up as a spurious "use client" cascade.
- Default weight **`regular`**. Use **`bold`** only for a genuinely emphatic state
  and **`fill`**/**`duotone`** only to mark an active/selected item. Never mix
  weights within one row of icons.
- Set the default once via `IconContext.Provider` (size, weight, `currentColor`)
  rather than repeating props per icon.
- Icons inherit `currentColor`. Don't hand them a hard-coded hue.

### Surfaces
Flat cards, hairline `--border`, generous whitespace, diffused shadows at most.
**No gradients, no heavy drop shadows, no glassmorphism.** One chromatic accent
(teal) plus `--destructive` for failure; everything else is mist neutral. If a
screen has three accent colours, it is wrong.

---

## Charts — a decision, not just documentation

### What the preset actually ships
`--chart-1` … `--chart-5`, **identical in both `:root` and `.dark`**:

| token | value | L | C | H |
|---|---|---|---|---|
| `--chart-1` | `oklch(0.872 0.007 219.6)` | 0.872 | 0.007 | 219.6 |
| `--chart-2` | `oklch(0.56 0.021 213.5)` | 0.560 | 0.021 | 213.5 |
| `--chart-3` | `oklch(0.45 0.017 213.2)` | 0.450 | 0.017 | 213.2 |
| `--chart-4` | `oklch(0.378 0.015 216)` | 0.378 | 0.015 | 216.0 |
| `--chart-5` | `oklch(0.275 0.011 216.9)` | 0.275 | 0.011 | 216.9 |

Hue spans 213.2–219.6 and chroma 0.007–0.021 — **effectively achromatic**. The only
axis that moves is lightness, 0.872 → 0.275. `--chart-2` is byte-identical to
`--muted-foreground`; `--chart-5` is byte-identical to dark-mode `--muted`. This is
not a chart palette. It is **the mist neutral ramp**, which is to say a
**sequential** scale.

### Why that is a problem for this product
Most charts here are **categorical**: comparing resources to each other (top VMs by
CPU), or comparing unlike metrics on one resource (CPU vs memory vs network). A
lightness ramp fails categorical encoding twice:

1. **It discriminates poorly at small sizes.** Adjacent steps differ by ~0.07–0.11
   L with no hue cue. In a 4px line, a legend swatch, or a sparkline in a table
   row, `--chart-3` and `--chart-4` are the same colour.
2. **It implies an order that does not exist.** A ramp says "these are rungs on one
   scale." There is no sense in which "network" is a *higher value of* "CPU". The
   encoding would be asserting a relationship the data does not contain — the exact
   category of quiet dishonesty this product exists to eliminate.

### The rule
**Keep the preset ramp for genuinely sequential/ordinal encodings. Add a
supplementary categorical palette for everything else.**

| encoding | palette |
|---|---|
| one metric over time (single series) | `--chart-*` ramp |
| heatmap density (hour × day utilization) | `--chart-*` ramp |
| distribution histogram / percentile bands | `--chart-*` ramp |
| utilization bands (low → high) | `--chart-*` ramp |
| multi-series line/area (CPU vs memory vs network) | **categorical** |
| resource-vs-resource comparison (top-N bars) | **categorical** |
| comparison delta tables (run A vs run B) | **categorical** |
| any legend where entries are peers | **categorical** |

### Sequential ramp — two fixes it needs
- **Light mode:** the ramp is correct as generated *for fills* — a pale low end is
  what a sequential scale should look like on white (heatmap cells, area bands,
  histogram bars). For **strokes, points and 1–2px marks**, drop `--chart-1`
  (L 0.872 on an L 1.0 background is invisible) and start at `--chart-2`.
- **Dark mode:** the preset does **not** re-map the ramp, so it runs the wrong way
  against its own surface — `--chart-5` (L 0.275) is nearly invisible on
  `--background` (L 0.148) and `--card` (L 0.218). Add `.dark` overrides that
  **reverse the lightness order** while keeping the same hue band, so the low end
  sits near the surface and the high end reads bright. General rule either way:
  *for strokes, skip whichever end of the ramp sits nearest the surface.*

### Categorical palette — five hues on a lightness ladder

Derived from the preset's teal primary by **rotating hue**, and spread across an
**even lightness ladder** so the set survives colour-vision deficiency. `--cat-1`
**is** `--primary` in light mode, byte for byte.

> **`app/app/globals.css` is the source of truth.** The block below is transcribed
> from it. `app/components/charts/palette.ts` and
> `agent/src/reporting_agent/render/chartstyle.py` hold the same values, and
> `agent/tests/test_chartstyle.py` reads all three and asserts they agree — so a
> change made in one place and not the others fails the suite rather than shipping
> as a chart whose colour differs between the app and the delivered document.

```css
/* Appended to app/app/globals.css. ADDITIVE — do not alter the preset tokens. */
:root {
  --cat-1: oklch(0.52 0.105 223.128); /* teal — identical to --primary */
  --cat-2: oklch(0.64 0.105 293);     /* violet */
  --cat-3: oklch(0.46 0.11 353);      /* magenta */
  --cat-4: oklch(0.58 0.105 66);      /* ochre */
  --cat-5: oklch(0.4 0.105 148);      /* green */
  --cat-other: var(--muted-foreground);
}

.dark {
  /* The same five hues and the same rank order, lifted 0.16 to clear the dark
     surface. --cat-1 is deliberately NOT --primary here: the preset's --primary
     gets *darker* in dark mode (0.45 vs 0.52), so matching it would put a chart
     series below the 3:1 contrast floor. */
  --cat-1: oklch(0.68 0.105 223.128);
  --cat-2: oklch(0.8 0.105 293);
  --cat-3: oklch(0.62 0.11 353);
  --cat-4: oklch(0.74 0.105 66);
  --cat-5: oklch(0.56 0.105 148);
  --cat-other: var(--muted-foreground);

  /* Reverse the preset's sequential ramp for dark surfaces (see above). */
  --chart-1: oklch(0.275 0.011 216.9);
  --chart-2: oklch(0.378 0.015 216);
  --chart-3: oklch(0.45 0.017 213.2);
  --chart-4: oklch(0.56 0.021 213.5);
  --chart-5: oklch(0.872 0.007 219.6);
}

@theme inline {
  --color-cat-1: var(--cat-1);
  --color-cat-2: var(--cat-2);
  --color-cat-3: var(--cat-3);
  --color-cat-4: var(--cat-4);
  --color-cat-5: var(--cat-5);
  --color-cat-other: var(--cat-other);
}
```

#### Do not restore equal lightness. It was measured, and it failed.

This document originally specified these five hues at **roughly constant
lightness** — `--cat-1` 0.52, `--cat-2` 0.53, `--cat-3` 0.52, `--cat-5` 0.54 — on
the reasoning that holding L and C constant keeps multi-series charts reading as
one product. That reasoning is sound aesthetically and **wrong perceptually**, and
the numbers are not close:

| pair (light mode) | simulation | equal lightness | shipped ladder |
|---|---|---|---|
| `--cat-1` teal vs `--cat-2` violet | deuteranopia | **ΔE 0.021** | 0.118 |
| `--cat-4` ochre vs `--cat-5` green | protanopia | ΔE 0.033 | 0.127 |
| `--cat-3` magenta vs `--cat-5` green | deuteranopia | ΔE 0.057 | **0.083** |
| worst of all 10 pairs × 3 simulations × **both themes** | — | **0.020** | **0.083** |

Measured as OKLab ΔE after a Machado et al. (2009) severity-1.0 dichromacy
simulation. About **one just-noticeable difference is 0.02**, so at equal lightness
`--cat-1` and `--cat-2` are *the same colour* to a deuteranopic reader comparing two
series. Note also that the pair this document predicted would be worst — ochre
against green — is only the second worst; teal against violet is the one that fails
hardest, and no amount of looking at the swatches reveals that.

The shipped ladder's own worst case is `--cat-3` against `--cat-5` under
deuteranopia at 0.083 — four times the equal-lightness worst, and the number the
0.06 floor in the test suite sits below on purpose: the floor is the line a future
edit must not cross, not a restatement of today's measurement.

**The cause is structural, not a bad choice of hues.** Under dichromacy a hue
rotation collapses onto a single axis. Five hues distinguished *only* by hue
therefore have almost nothing left to tell them apart, whatever the hues are — so
there is no equal-lightness five-hue set that passes. The fix is the one this
document already sanctions two sections down: *"if it fails, separate them by
lightness rather than adding a sixth hue."*

Two properties of the ladder are load-bearing and must survive any future edit:

- **Even 0.06 steps**, so the stagger reads as deliberate rather than arbitrary.
- **One rank order in both themes** — `--cat-5` < `--cat-3` < `--cat-1` < `--cat-4`
  < `--cat-2`. Optimising each theme independently produced *better* CVD margins and
  **inverted the visual hierarchy on theme toggle**, so the same series was the
  lightest in one theme and among the darkest in the other. That was rejected: a
  smaller margin is better than a hierarchy that flips.

It still reads categorical to normal vision, which is what the equal-lightness rule
was protecting: the closest two hues sit **60° apart** (the test floor is 55°), so hue
remains the cue a normal-sighted reader sees first, and colour is a **redundant**
channel anyway — every series also carries a direct label, and every line a marker
shape and a dash pattern.

`app/test/palette.static.test.ts` recomputes all of the above from the OKLCH values
on every run, asserts every pair clears a 0.06 floor, and **includes the
equal-lightness set as a negative case** so its failure is a standing test rather
than a paragraph. Changing these values without moving those numbers is not
possible.

**Five is still the cap, and now for a second reason.** A hue ring supports about
five reliably separable hues at ~70° spacing; past that lightness has to move — and
lightness is already spent, on the ladder above. So:

- **More than five series → aggregate.** Top 4 + `--cat-other` ("Other"), or switch
  to **small multiples**. This is better dataviz regardless of palette, and it
  keeps the report honest about which resources actually matter.
- Assign categorical colours **by stable key**, never by array index. `cpu` must be
  `--cat-1` in every chart in the report; a resource must keep its colour between
  the chart and the delta table. Colour that shifts between two views of the same
  data is worse than no colour.

#### Inline value labels take `--foreground`, not the series colour. It was measured, and it failed.

The standing WCAG contrast gate (`agent/tests/test_chartstyle.py`) found two real
failures on its first run:

| series | surface | theme | measured | floor |
|---|---|---|---|---|
| `--cat-2` (violet, L 0.64) | `--background` | light | **3.476:1** | 4.5:1 |
| `--cat-5` (green, L 0.56) | `--background` | dark | **4.440:1** | 4.5:1 |

Both clear the **3:1 graphical-object** floor (WCAG 1.4.11) — the marks are fine.
They miss **4.5:1 for text** (WCAG 1.4.3), which is what an inline value label is:
a specific numeral the reader must be able to read, not a decoration whose absence
could be inferred from axis position.

**Moving the palette was rejected.** The lightness ladder is measured and
load-bearing: even 0.06 steps, one rank order across both themes, CVD worst case
0.083 against a 0.06 floor the palette was already changed once to reach.
Optimising each theme independently inverted the visual hierarchy on theme toggle
and was rejected (see above). There is no token edit that fixes the text contrast
without reopening a problem already closed.

**The fix: render every inline value label in `--foreground`.** The categorical
palette carries identity on the **mark** (line, bar, marker) — a graphical object,
correctly checked at 3:1. The numeral beside it is text whose job is to be read;
its identity is established by proximity to the mark it annotates, not by sharing
the mark's hue.

`--foreground` on `--background`:
- light: `oklch(0.148 0.004 228.8)` on white → **~16.7:1**
- dark: `oklch(0.987 0.002 197.1)` on `oklch(0.148 0.004 228.8)` → **~19.5:1**

Both exceed the floor by a factor of three. `design-system.md` already argues colour
is a **redundant** channel — "every series carries a direct label" — so the label's
typographic legibility is the invariant, and this is how the invariant is enforced
without constraining the palette.

The gate still asserts **both** floors: 3:1 for every categorical token as a
graphical object, and 4.5:1 for `--foreground` as the colour inline value labels
actually use. `chartstyle.value_label_color(theme)` is the accessor; `charts.py`
calls it for every `annotate(...)` that renders a figure's `formatted` string.

### Non-negotiables for every chart
- **Never rely on colour alone.** Every series carries a **direct label** at the
  line end or on the bar — legends are a fallback, not the mechanism. Pair colour
  with **shape** (marker) and **dash pattern** for lines.
- **A fallback drawn unconditionally is not a fallback.** The legend is emitted
  only when the direct labels are *not* there to be read, and `label_indices` is
  what decides that rather than a second statement of the rule. Drawn on every
  multi-series chart it was a boxed duplicate sitting on the plotted lines and on
  the very labels it repeated.
- **The end label needs a gutter, and the gutter is a budget.** The axes stop at
  `_AXES_RIGHT`, leaving the rest of the fixed figure width for the labels; a label
  longer than `END_LABEL_MAX_CHARS` is **elided in the middle, never at the tail**,
  because two series of one resource differ only in their last few characters —
  cutting `(avg)` and `(max)` gives both the same label. The budget is **counted,
  never measured**: reading font metrics at render time makes the emitted PNG
  host-dependent, which is the same reason `subplots_adjust` is fixed rather than
  `tight_layout`.
- **Cap the printed tick labels.** A month ticked at every point is 31 rotated
  labels in six inches, which reads as a diagonal band rather than as a scale. Keep
  every k-th, evenly stepped; the companion table carries every point's x value
  regardless, so nothing is lost by not printing them all.
- **Deltas use glyph + magnitude, not hue.** `▲`/`▼` (Phosphor arrows) plus the
  signed value in mono. **Colour must not encode good/bad for utilization** — CPU
  rising is not "bad", and disk free space falling is not the same kind of "down"
  as network throughput falling. The direction glyph states the direction; the
  prose states whether it matters.
- **`--destructive` is reserved for verification failure and hard errors.** Never
  for "high utilization", never for a negative delta. If red appears on a report
  page, it means *this document could not be proven*, and that meaning must not be
  diluted.
- **Check both themes.** Every series against `--background` **and** `--card`, in
  light **and** dark. Target ≥3:1 against the surface for graphical objects
  (WCAG 1.4.11), and ≥4.5:1 for any inline value text.
- **Check colour-vision deficiency.** Simulate deuteranopia, protanopia and
  tritanopia over **all ten pairs**, not only adjacent ones: colour is assigned by
  stable key, so any two of the five can co-occur in one chart. `--cat-4` ochre vs
  `--cat-5` green was expected to be the pair most at risk under red-green
  deficiency and measurement disagreed — teal vs violet fails hardest at equal
  lightness, and the shipped ladder's worst pair is magenta vs green. **This check
  has been run and the palette was changed because of it** (see the categorical
  palette section); `app/test/palette.static.test.ts` re-runs it on every commit
  against a 0.06 ΔE floor, so it is a standing gate rather than a pre-flight step
  somebody has to remember.
- Axis labels, gridlines and ticks come from `--muted-foreground` / `--border`.
  Gridlines never compete with data.
- Chart titles in `font-heading`; all numerals in `font-mono`, tabular.
- Every chart rendered in the app derives from the **same figure ledger** as the
  document. A chart is a view of verified figures, not a second computation.

---

## Agentic chat anatomy
Build from the shadcn Base UI registry (`Message`, `Message Scroller`, …).

1. **Agent intro / empty state** — product name, a small model badge, a short
   capability list (Collect utilization · Compose a report · Verify every
   figure · Compare runs), and a connected-subscription chip showing
   `scope_verified` state.
2. **Message list** — user turns as subtle right-aligned `--secondary` bubbles at
   `rounded-2xl`; assistant as plain left-aligned prose with inline `code` chips and
   markdown tables. Use `Message Scroller` for anchored auto-scroll that follows
   streaming without jumping.
3. **Live activity timeline** — the signature agentic element. Render `tool` and
   `progress` events as a compact, collapsible step list attached to the in-progress
   turn:
   - each step = Phosphor icon + the event's `status` phrase + a small `label` badge
     ("Inventory" / "Metrics" / "Compile" / "Render" / "Verify" / "Upload");
   - spinner while a step is open (`start` seen, no `end`), check on `end`, matched
     by `id`;
   - **`progress` events carry counts** — show `142 / 200 resources` with a thin
     `--primary` progress bar. A report run is minutes long; an indeterminate
     spinner for four minutes reads as a hang.
   - on `done`, collapse into a one-line summary ("Collected 200 resources ·
     compiled 1,480 figures · verified · saved") that re-expands.
4. **Message actions** — copy · regenerate · thumbs up/down under each assistant
   turn.
5. **Artifact cards** — on `report_file`, presign server-side and render a card with
   a file-type icon (DOCX/PDF), filename, size, Download. **Render only once the
   presigned URL is ready**, not on the marker. Charts arrive as `chart` events and
   render **client-side from the structured spec** — no image, no presign.
6. **Composer** — text input, attach affordance, circular send. Disabled with a
   "Connect a subscription to start" hint when none is connected, and disabled with
   an explicit reason when the selected subscription's `scope_verified` is false or
   its secret has expired.
7. **Suggestions** — prompt chips that vary their wording per render ("Summarize
   July for prod", "Which VMs are over-provisioned?", "Compare against June",
   "Explain the memory figure for sql-01").

## Report & verification surfaces
The verification result is a **first-class UI object**, not a log line. This is the
screen that distinguishes the product.

- **Verification panel** — pass/fail at the top, stated plainly: *"1,480 figures ·
  every figure traced to snapshot `a3f9…` · verified"*. On failure, list every
  unmatched numeric token with its location in the document, and say clearly that
  the report was **not** delivered. Success is quiet; failure is loud and specific.
- **Fidelity badges** — `baseline` / `enhanced` per resource, with a tooltip
  explaining what the tier does and does not support. A resource whose percentiles
  are estimated says so **wherever a percentile is shown**.
- **Estimator labels come from the ledger.** Render the figure's pre-formatted
  label; never compose your own. The UI must never print a bare "p95".
- **Gap list** — `collection_log` entries grouped by type (permission denied ·
  metric not emitted · VM deallocated · region unreachable), each with the
  resources affected. A gap is neutral information, not an error state — style it in
  mist neutrals, not `--destructive`.
- **Snapshot provenance** — snapshot id (mono, truncated with copy), collection
  window in **Asia/Jakarta** with the offset shown, grain, and resource counts.
- **Secret expiry warning** — a persistent banner on the subscription and run
  screens as `secret_expires_at` approaches, and an unmissable state once expired.
  An expired secret is the failure mode most likely to produce a plausible-looking
  empty report, so it gets its own visual weight.
- **Comparison view** — a delta table using the categorical palette, direction
  glyphs, mono tabular numerals, and both runs' snapshot ids in the header. Rows
  where fidelity tiers differ between runs are marked as **not comparable** rather
  than shown as a delta.

## Template builder surface — superseded, and why it is recorded rather than deleted

**This surface no longer exists, and nothing should be built against it.** A profile
is authored through the six-step wizard (`identity · sections · period · document ·
appearance · preview`), not a three-pane block builder.

`.kiro/specs/restructure-the-template-to-report-flow-around/requirements.md` states
the change in one line: **"A section is the unit the author manipulates; blocks are
no longer an authoring concept."** The recorded decision behind it is a new
top-level `sections[]` array at `schema_version` 3, with `blocks[]` kept only so v1
and v2 definitions still compile. `64dba7c` is the commit that moved the wizard to
the v3 model and left the builder without a call site.

What this section used to specify — a left palette of typed blocks, a centre canvas
with drag-reorder and a drop indicator, a right inspector carrying the block's
config schema and its scope override, and a row splitter refusing nested rows — is
therefore **historical**. `Requirement 6` and the `Block_Composer` requirement in
`.kiro/specs/reporting-agent-templates-reports/requirements.md` describe the same
superseded surface; they are not live requirements.

The components that satisfied them are still in `components/templates/` and are
**unreachable** — a closed island of fourteen modules rooted at `step-blocks.tsx`,
which nothing imports: `block-composer`, `block-canvas`, `block-canvas-item`,
`block-palette`, `block-inspector`, `row-splitter`, `move-announcer`, and, reachable
only through the inspector, `config-picker`, `scope-editor`, `step-scope`,
`scope-picker`, `step-metrics` and `metric-picker`. They are pending deletion. Do
not import one back into the wizard to reuse a control: the wizard's equivalents are
`step-sections.tsx` and `step-appearance.tsx`.

The paragraph is kept rather than deleted because the builder's components sat in
the repository for months after they stopped being reachable, and a reader finding
them needs to know they are dead rather than unfinished. Two rules from it do
survive, and they moved rather than lapsed:

- **The paper preview is emitted from the same AST as the `.docx`.** That is still
  true, still load-bearing, and now lives in the wizard's preview step — see
  *HTML preview vs rendered PDF* below.
- **A zero-resource block still renders.** Still true of a zero-resource *section*;
  see that section below.

### Style preset picker — real thumbnails
**Render the four themes as actual page images and show them as a 2×2 grid of
selectable cards.** Editorial · Corporate · Technical · Minimal. Not names in a
select: a theme is a visual decision, and a dropdown of words gives the user nothing
to decide with. Selected card takes a `--ring` and a `--primary` check.

Below the grid, the per-template tuning: accent colour, density
(compact/normal/relaxed), table style (hairline/banded/bordered), number format,
cover page toggle, logo, page size.

**It lives on step 4 of the profile wizard, with the front matter**, because
`lib/profiles/wizard.ts` maps both `front_matter` and `design` to that step: a
`design.*` validation issue opens step 4, so a picker anywhere else would be a
surface the wizard never navigates to when its own field fails. Front matter first,
appearance second — what the document *says* before what it *looks like*.

**The picker being built is not the picker being reachable.** `StepDesign`,
`StylePresetPicker`, the thumbnail resolver and four committed page images all
existed and were tested for weeks while nothing imported them: the shell took the
server-resolved `thumbnails` prop and bound it to `_thumbnails`. Every profile
silently shipped the draft default, and the delivered documents were editorial
because nothing could select anything else. A picker with no call site is a
dropdown of one.

### HTML preview vs rendered PDF — say it plainly
**The HTML preview is an approximation. The rendered PDF is the truth.** They diverge
on **pagination, table column widths and font metrics** — precisely the three things
Word decides for itself and a browser cannot predict.

- Label the canvas as a preview **permanently, in the UI**. Not a tooltip, not a
  first-run hint.
- **"Render real preview"** runs the true `python-docx → LibreOffice → PDF` pipeline
  against the latest snapshot and shows the actual artifact inline. That surface is
  the only one allowed to imply "this is what you will get".
- **Never show page numbers or a page count in the HTML preview.** Implying
  pagination the HTML emitter cannot determine is worse than omitting it — a wrong
  page count is a promise the document will break.

### A zero-resource section still renders
A section whose scope matches nothing shows an explicit **"No resources matched this
scope"** row, in mist neutrals, not `--destructive` — it is information, not an
error. It must never collapse to nothing: a vanished section is indistinguishable
from one the author never configured, both in the wizard and in the delivered
document.

### Accessibility — reordering
The builder solved this with a drag-and-drop library and a keyboard escape hatch.
The wizard's section list solves it by **not having a drag gesture at all**: reorder
is a pair of up/down buttons, which is keyboard-reachable because it is a button.
That is the cheaper answer and it is the one that shipped.

What still binds, and what `step-sections.tsx` already satisfies:

- **Every reorder is reachable from the keyboard.** A real `<button>` per direction,
  each with an accessible name naming the section it moves.
- **Announce every move** through an `aria-live="polite"` region: "Utilization moved
  to position 3 of 7." Implemented as `announceMove` writing into
  `#section-move-announcer`.
- The list is a real list in the DOM order it renders in, so reading order matches
  document order.
- A section the catalogue pins (`position !== "free"`) offers no move control rather
  than a control that refuses — and nothing may swap past one.

## Motion & quality bar
Heavy section whitespace, clear type hierarchy, custom cubic-bezier transitions,
gentle enter/reveal, tactile button feedback (the preset's `active:translate-y-px`
is already in `button.tsx` — keep it). `tw-animate-css` is installed; use it rather
than hand-rolling keyframes. Respect `prefers-reduced-motion`.

Streaming numerals must not animate. A count-up on a verified figure is decoration
pretending to be data.

Accessibility: stream status through an `aria-live="polite"` region; full keyboard
support; visible focus via `--ring`; every chart has a text alternative (the
underlying figures are already tabular — expose the table).
