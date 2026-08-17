# The four styles-only theme documents

`agent/themes/` holds four Word packages carrying **paragraph, character and table styles and
no content** (Req 8.1, 8.5). They are stylesheets that happen to be `.docx`, and they ship
inside the arm64 image.

> This file lives beside `agent/themes/` rather than inside it on purpose. Req 8.8 fails the
> guard if that directory contains anything other than exactly the four required file names,
> which is what catches a stray `editorial (1).docx` or a `~$editorial.docx` Word lock file.
> Documentation is not worth loosening that rule for.

| file | preset | reading face | accent |
|---|---|---|---|
| `editorial.docx` | `editorial` | Liberation Serif | teal `0F6470` |
| `corporate.docx` | `corporate` | Liberation Sans | navy `1F3A5F` |
| `technical.docx` | `technical` | DejaVu Sans | slate `33556B` |
| `minimal.docx` | `minimal` | Liberation Sans | near-black `1A1A1A` |

A template's `design.preset` selects the **file**. A template's `design.table_style`
(`hairline` / `banded` / `bordered`) selects a **style inside** that file. The two are
orthogonal, so every theme defines all three data-table styles — a theme carrying only "its
own" look would fail the moment a template paired `technical` with `bordered`.

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

Every face named in a spec is installed in the image by `fonts-liberation2` and
`fonts-dejavu-core`. A theme naming a font the container lacks renders through LibreOffice's
substitution, which changes line breaking and therefore pagination — so the Dockerfile's font
list and `THEME_SPECS` are one decision recorded in two files.
