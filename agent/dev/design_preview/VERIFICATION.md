# Verification — 2026-09-07

- App API/component tests: **15 passed**. Covers development gating, authentication,
  invalid input, stage-specific errors, resetting presets, stale previews, duplicate
  clicks, settings changed during rendering, and retaining the previous PDF on failure.
- Python prototype and existing PDF regression tests: **59 passed, 1 skipped**.
  The skipped case checks behavior when WeasyPrint is unavailable; it was available
  in the verification environment.
- New app files: ESLint and Prettier checks passed. `git diff --check` passed.
- Whole-app TypeScript check reports an error in the unchanged
  `app/test/property-hygiene.static.test.ts:1325`: `string | undefined` is passed to
  a set accepting `string`. No prototype TypeScript errors were reported.

## Actual PDF output

| Sample | Pages | Result |
| --- | --- | --- |
| Corporate | 2 | All displayed figures located; A4; SVG charts |
| Editorial | 2 | All displayed figures located; A4; SVG charts |
| Technical | 2 | All displayed figures located; A4; SVG charts |
| Minimal | 2 | All displayed figures located; A4; grayscale SVG charts |
| Long resource names | 3 | Content continues without truncation |
| Missing daily samples | 2 | Null gaps preserved |
| Empty scope | 2 | Explicit availability notices; no invented zero figures |
| Zero daily readings | 2 | Valid bounded axes |
| Overflowing commentary | 3 | Every repeated paragraph retained |
| Tuned Letter / relaxed / bordered / mono / columns | 3 | Adjustments reach the actual PDF |

The default themes share the same existing chart-data hash and compiler-formatted
figures. The exported P95 includes its complete estimation qualifier and passes the
existing bounded figure-location helper. Chart SVGs contain vector paths, no bitmap
images, and no NaN coordinates. This does not claim full production verification for
prototype artifacts.

All eight default-theme pages were visually inspected after correcting axis pairing
and P95 card overflow. Screenshots and generated PDFs are in
`artifacts/design-preview/` (ignored). Extra pages in stress/tuned variants are
intentional flow behavior; only the default A4 sample is constrained to two pages.

## Browser walkthrough

Used agent-browser with a disposable local Postgres database, applying the existing
schema and creating a local-only test session. Verified the sign-in redirect,
authenticated rendering through the real API/Python/ECharts/WeasyPrint chain, PDF
embedding, changed-settings state, customized Letter/columns rendering, and a real
PDF download. The downloaded bytes were checked for two pages and the full P95 text.
No browser errors were reported. At 390px viewport width the document scroll width
was also 390px. The desktop preview was visually inspected with its native PDF viewer.

No cloud calls, deployment, production profile writes, or production runtime-image
changes were used. Pango and browser dependencies were unpacked under `/tmp` because
system package installation required a sudo password.

## Existing report Appearance integration — 2026-09-08

- All six saved chart designs now use the shared ECharts SVG engine, including the
  existing profile selector cards. The same SVG is rasterized for Word with resvg.
- All 24 theme/style combinations rendered through the actual Word and styled-PDF
  pipeline. Displayed ledger figures passed the existing bounded location check.
  Samples are under `artifacts/design-preview/production/`.
- Inspected all theme/style layout sheets and the final Editorial / Flat tint /
  Monospace PDF. Corrected crowded axis headings and wrapping of the full P95
  estimation qualifier. Low-utilization axes explicitly identify their zoom.
- App selector and prototype regression tests: 37 passed. Browser checked the
  authenticated existing Appearance step, Flat tint and Monospace selection;
  no browser errors. New app changes pass ESLint. The unchanged whole-app
  TypeScript error at `test/property-hygiene.static.test.ts:1325` remains.
- Six SVG/native-PNG tests passed locally and on ARM64 with the packaged Node and
  resvg dependencies. The ARM64 image passed the existing image build gates.
  Final drawing sources were mounted read-only for its chart smoke tests; the
  built local image predates the final source corrections. Rebuild before deployment.
- Final Python report regression suite: **132 passed, 1 skipped**.
- Fixed ZIP member timestamps after the existing Word byte-equality test exposed
  clock-dependent archive metadata. No verification assertion was removed.
- No deployment, production collection, or saved-profile schema migration was run.

## Appearance refinements — 2026-09-08

- Added a shadcn theme dropdown, color picker and accent swatches above the chart
  cards. Browser confirmed that all six SVG previews change after a swatch click.
- Clarified table border choices; Bordered produces vertical and horizontal cell
  rules, including document-control grids.
- Restored top-level chapter page starts in Word and styled PDF. A rendered
  two-chapter PDF test confirms separate pages.
- Centered plot margins; sparse series now have visible markers and exact supplied
  labels, without duplicating the final label. Seven chart tests passed.
- Historical selection unchanged: three requested prior periods may yield fewer
  eligible periods after verification, completion and overlap checks. Added this
  explanation beside the history-depth control.
- Report/history regression suite: 157 passed, 1 skipped; additional chapter
  pagination test passed (16 renderer tests including that new test).
- Existing Sections-screen lint findings (Date.now during render and unused
  _dropped) and the existing property-hygiene TypeScript error remain. Browser
  console also reports an existing ProfileTable Button/link semantics warning.
- These follow-up changes are not committed or deployed.

## Live themes and selected metrics — 2026-09-09

- Replaced static theme images with compact, keyboard-selectable live specimens.
  Accent, density and table choices update the specimens immediately. Browser
  verification found four live cards, no static preview images, correct accent
  updates and no horizontal overflow at an 800px viewport.
- VM charts preserve all selected metrics, separating CPU and memory by metric
  and respecting the chart series limit. Unavailable memory has a named notice.
- Historical charts now expand per VM and selected statistic. Standard selection
  renders both CPU Average and Maximum. Measured calendar months take precedence
  over prior-report fallback; this supersedes the prior-first behavior described
  above. Unmeasured internal months remain gaps, not invented observations.
- Compiler/history/catalog/messages suite: 215 passed. Selected-metric coverage
  subsequently expanded to three passing tests, including missing memory and a
  missing middle month. Renderer suite: 109 passed, 1 skipped. Node chart tests:
  7 passed. App appearance tests: 15 passed. Changed appearance components pass
  ESLint; the existing whole-app property-hygiene TypeScript error remains.
- The actual Word/PDF fixture produces five pages and eight charts: CPU and memory
  for two VMs, plus Average and Maximum history for each VM over three measured
  months. All displayed ledger figures passed the existing PDF location check.
  Visual inspection covered page layout and chart labels. Sparse endpoint labels
  align inward to avoid clipping. No Azure collection or model prose generation
  was used for this fixture.
- Reproduce with `PYTHONPATH=agent/src:agent/tests agent/.venv/bin/python
  agent/dev/design_preview/selection_samples.py` from the repository root, with
  the normal renderer system libraries installed. Outputs are ignored artifacts
  under `artifacts/design-preview/production/selected-metrics.{pdf,docx}`.
- These changes require a runtime rebuild and report regeneration to affect hosted
  output. No deployment or profile-schema migration was performed.
