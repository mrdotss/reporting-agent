# The styles-only theme documents

`agent/themes/` holds one Word package per preset, carrying **paragraph, character and table styles and
no content** (Req 8.1, 8.5). They are stylesheets that happen to be `.docx`, and they ship
inside the arm64 image.

> This file lives beside `agent/themes/` rather than inside it on purpose. Req 8.8 fails the
> guard if that directory contains anything other than exactly the required file names,
> which is what catches a stray `editorial (1).docx` or a `~$editorial.docx` Word lock file.
> Documentation is not worth loosening that rule for.

| file | preset | reading face | accent |
|---|---|---|---|
| `editorial.docx` | `editorial` | Liberation Serif | teal `0F6470` |
| `corporate.docx` | `corporate` | Liberation Sans | navy `1F3A5F` |
| `technical.docx` | `technical` | DejaVu Sans | slate `33556B` |
| `minimal.docx` | `minimal` | Liberation Sans | near-black `1A1A1A` |
| `ledger.docx` | `ledger` | IBM Plex Sans, figures in IBM Plex Mono | forest `245C45` |
| `signal.docx` | `signal` | Archivo headings over Liberation Sans | rust `A3401F` |
| `brief.docx` | `brief` | Source Serif 4 headings over Source Sans 3 | slate blue `3D4F8F` |

The last three came with the preset builder. Their faces are vendored under `agent/fonts/`
(see its README), and each carries treatments the first four do not:

| preset | cover | under a section heading | section number |
|---|---|---|---|
| `ledger` | accent band | double accent rule | inline |
| `signal` | full-bleed accent ground, set in white | nothing | large, in the accent |
| `brief` | title strip on page one, document control beneath it | single accent rule | inline |

`cover_style`, `heading_rule` and `display_numbers` on `ThemeSpec` drive both outputs: the
Word file through its built styles and `front_matter.cover_treatment`, and the reading copy
through `render/printcss.py`. Every theme also declares `Callout` and `Callout Attention`,
the two tones of a v4 callout.

A template's `design.preset` selects the **file**. A template's `design.table_style`
(`hairline` / `banded` / `bordered` / `open`) selects a **style inside** that file. The two are
orthogonal, so every theme defines all four data-table styles — a theme carrying only "its
own" look would fail the moment a template paired `technical` with `bordered`.

## A preset's own look: `design.style`

A v4 preset may also carry `design.style`, a set of overrides on top of its theme
(`STYLE_KEYS` in `compile/definition.py`): heading colour, a font pairing, text size, the
figures face, the table header, a mark-at-or-above threshold, chart palette, line, grid,
value labels, legend and threshold, the cover, section numbers, margins, the running header
and the callout treatment. **An absent key is the theme's choice**, so a preset with no
`style` draws exactly what it drew before; `tests/test_design_style.py` holds both halves of
that promise.

None of it is baked into the theme files. The Word output applies it at render time
(`docx._apply_style_options`, after the theme document is opened), the reading copy through
`printcss._style_rules`, and charts through `echarts.chart_options`. A chart or table slot
may carry its own `style` too (look, height, value labels, threshold; header, rows, marking),
which `blocks.base.apply_block_options` sets on the nodes that block emitted. Section numbers
and the running header exist only in the styled PDF; Word has neither.

The font pairings (`FONT_PAIRS` in `render/themes.py`) name only vendored or packaged faces,
so a pairing can never fall back to substitution in the image.

## Do not edit these files directly

The reviewable source is **`THEME_SPECS` in
`agent/src/reporting_agent/render/themes.py`** — a face, a palette and a type scale per
preset. The binaries are generated from it:

```bash
cd agent
PYTHONPATH=src .venv/bin/python -m reporting_agent.render.themes --write
```

`tests/test_themes.py::test_the_committed_document_is_byte_identical_to_a_fresh_build`
asserts each committed file equals a fresh build, so:

- editing the spec without regenerating fails the suite;
- editing a binary in Word fails the suite.

Either way the committed bytes and the reviewed source cannot drift apart, which is the only
honest reading of Req 8.1's *"tracked as source files and changed only through the same review
path as code"*. Committing four opaque binaries and calling them reviewed would not be.

## What every theme must declare

`python -m reporting_agent.render.themes --assert-build` checks all of it, and the Dockerfile
runs it so a failure aborts the build rather than surfacing as an unstyled delivered document
(Req 8.7).

- **`Figure`**, a *character* style (Req 8.2). Every figure is one run in it, which is how the
  Token_Extractor locates figures without re-parsing prose.
- **Every paragraph and table style the declared block types reference** (Req 8.3), imported
  from `compile/blocks/base.py`'s `PARAGRAPH_STYLES` and `TABLE_STYLES` rather than restated.
- **`PreviewNotice`**, for preview-mode renders.

### One subtlety worth preserving

The `Figure` style sets `<w:caps w:val="0"/>` and `<w:smallCaps w:val="0"/>` explicitly.
`w:caps` changes rendered glyphs while leaving the stored text alone, so a figure inheriting
caps from its paragraph style would sit in the `.docx` as `1.2 bytes` and appear in the `.pdf`
as `1.2 BYTES`. The PDF pass looks for each ledger `formatted` string as a contiguous
substring, so it would withhold a document that is entirely correct. Two presets set `w:caps`
on `Heading 4`, and a figure in a heading is ordinary — digits have no case, so without those
two switches the failure would appear only for units and estimator labels, on some presets,
for some metrics.

## Fonts

Every face named in a spec is installed in the image by the `liberation-*-fonts` and
`dejavu-*-fonts` packages (sans, serif and mono of each). A theme naming a font the container lacks renders through LibreOffice's
substitution, which changes line breaking and therefore pagination — so the Dockerfile's font
list and `THEME_SPECS` are one decision recorded in two files.
