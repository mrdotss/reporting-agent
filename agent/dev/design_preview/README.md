# Report design preview

A local, authenticated design lab for the styled PDF. It is separate from the
production report pipeline and the saved-profile Word/LibreOffice preview.

## Run the app preview

From the repository root, prepare Python 3.12 and the existing agent dependencies:

```sh
python3.12 -m venv agent/.venv
agent/.venv/bin/python -m pip install -r agent/requirements.lock
```

WeasyPrint also needs native libraries and fonts. On Ubuntu 24.04:

```sh
sudo apt-get install libpango-1.0-0 libpangoft2-1.0-0 fonts-liberation2 fonts-dejavu-core
```

Use the app's existing local database and sign-in setup, then:

```sh
cd app
pnpm install --frozen-lockfile
REPORT_DESIGN_PREVIEW=1 pnpm dev
```

Sign in and visit `/report-profiles/design-preview`, or follow **Open design lab**
on the Report Profiles page. Both page and API are unavailable unless
`NODE_ENV=development` and `REPORT_DESIGN_PREVIEW=1`. The flag is optional and is
intentionally absent from the production environment contract.

Choose a theme, adjust its settings, and click **Render preview**. The embedded PDF
and download use the same bytes. Changing a theme resets its coordinated defaults;
changing a control marks the last result outdated. Failed renders retain that result.
No profile, run, cloud artifact, or production report is written.

## Generate review artifacts without the app

From `app/`:

```sh
pnpm exec tsx scripts/design-preview.ts
pnpm exec tsx scripts/design-preview.ts ../artifacts/design-preview --stress
```

The first command produces four two-page PDFs plus HTML, SVG, and figure manifests.
The second also renders long names, empty scope, missing daily samples, zero daily
readings, overflowing commentary, and a tuned Letter/columns example. Generated
files live in the ignored `artifacts/design-preview/` directory.

Verify the actual PDFs from the repository root:

```sh
PYTHONPATH=agent/src agent/.venv/bin/python agent/dev/design_preview/verify_samples.py
```

The inspection uses the existing PDF text extraction and bounded figure-location
helpers. It checks displayed figures, page counts, page dimensions, vector charts,
retained overflowing text, and data hashes across the default themes. It is a
prototype check, not a claim that these samples passed the complete production gate.

## Renderer contract

The Node route validates a closed set of appearance fields. It starts the fixed
`agent/.venv/bin/python` executable with JSON on stdin and an absolute script path;
there is no shell, configurable executable, caller-supplied HTML, or fixture selector
in the HTTP API. Compilation has a 20-second budget; PDF rendering has 40 seconds.
Processes are killed on timeout, outputs are limited to 12 MiB, and client aborts
cancel work. Errors identify validation, compilation, chart, or PDF stages.

`preview.py prepare` compiles the committed `sample.json` with the existing
`compile_document`, snapshot view, and figure ledger. Its chart specification carries
compiler-selected points, formatted labels, panel membership, units, and the existing
`chart_data_hash`. ECharts 6.0.0 draws this data as SVG with explicit axes, no animation,
no smoothing, and no interpolation across missing days. `preview.py pdf` renders the
assembled HTML through the existing WeasyPrint wrapper. The sample generator uses
exactly the same Node rendering function as the API.

The fixture was built with the repository's snapshot builder and compile-test factories.
It represents a synthetic August 2026 Azure environment with three VMs. The daily CPU
pattern is fixed; the P95 is an explicitly estimated fixture input, not a percentile
recomputed from daily averages. Internal stress variants intentionally mutate fixture
inputs before compilation and are not real collected snapshots.

The prototype supports English, CPU average/peak panels, installed Liberation/DejaVu
fonts, A4/Letter, and the four current preset identifiers. It does not change the
production theme documents, add a database migration, or install Node in the agent
runtime image. Production packaging, localization, all chart styles, and full-report
rollout remain future work.

For this workspace's current session, the native libraries used during verification
also remain under `/tmp/report-design-libs`. Until those temporary files are removed,
you can use them without a system package installation:

```sh
cd app
LD_LIBRARY_PATH=/tmp/report-design-libs/usr/lib/x86_64-linux-gnu REPORT_DESIGN_PREVIEW=1 pnpm dev
```

Use the standard system-library installation above for a durable local setup.
See `VERIFICATION.md` for the recorded test and browser results.

## Existing report Appearance controls

The existing report renderer now uses `agent/chart-renderer` for all six saved chart
styles. Install local chart dependencies with `cd agent/chart-renderer && npm ci`
and use Node.js 24. The agent Dockerfile packages Node, ECharts 6.1.0, and resvg
2.6.2, and runs SVG/PNG smoke tests during the build. Rebuild and deploy the agent
image to activate these changes in a hosted runtime. Existing artifacts are not
rewritten.

The app cards and server share the chart drawing module. Python still owns series
selection, formatted values, companion tables, and chart-data hashes. Sequential and single-resource, single-metric
charts use the selected accent; resource comparisons retain compiler-selected colors.
The SVG is embedded in the styled PDF and rasterized for Word. Saved theme, accent,
density, table style, chart font, and page size reach the output renderers.

Run `PYTHONPATH=agent/src agent/.venv/bin/python agent/dev/design_preview/production_samples.py`
from the repository root to produce all 24 real-pipeline samples under
`artifacts/design-preview/production/`. The fixture makes no Azure calls.
