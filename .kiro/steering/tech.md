# Tech stack & setup

## Web app (`app/`)
- **Next.js 16** (App Router, TypeScript) + **React 19** — fullstack.
  > `app/AGENTS.md` is binding: this is **not** the Next.js in your training data.
  > Next 16 ships its own docs in-tree at **`node_modules/next/dist/docs/`**
  > (`01-app/`, `02-pages/`, `03-architecture/`, `04-community/`). Read the relevant
  > guide before writing route/caching/streaming code, and heed deprecations.
- **Tailwind v4** (CSS-first; `@tailwindcss/postcss`, no `tailwind.config`).
- **shadcn (Base UI variant)** — `@base-ui/react`, not Radix. See `design-system.md`.
- **PostgreSQL** + **Drizzle ORM** (migrations via drizzle-kit) — users, sessions,
  connected subscriptions, templates, report runs, snapshot/verification metadata.
- **Amazon DynamoDB** — **chat history only**: conversations + messages
  (high-write, fast key/GSI reads). Single-table design.
- **S3** — artifacts: snapshots (canonical JSON), figure ledgers, verification
  results, `.docx`, `.pdf`.
- **pnpm** as the package manager.

### Auth — a custom DB-session implementation, NOT Auth.js
Email/password with **argon2**, a **`sessions` table** in Postgres, and an
**httpOnly, Secure, SameSite=Lax cookie** carrying an opaque random session token.
Written by hand: create/rotate/revoke the row, read it in a server helper, delete
it on sign-out.

> **Do not add `next-auth`.** Read this carefully, because the sibling project
> will mislead you three separate ways:
>
> 1. `cold-agent/app/package.json` lists `next-auth@5.0.0-beta.31` **and**
>    `@auth/drizzle-adapter@^1.11.2` — and **no production module imports either
>    one**. Its `lib/auth.ts` imports only `node:crypto`, `drizzle-orm`,
>    `next/headers` and its own helpers, and mentions NextAuth solely in a comment
>    explaining why it is *not* used. The packages are dead weight.
> 2. Two of its own steering docs (`tech.md` and `structure.md`) describe an
>    "Auth.js v5 + `@auth/drizzle-adapter`" setup that **does not exist in its
>    code**, including an `api/auth/[...nextauth]/route.ts` handler it does not
>    have. That is a documentation bug, not a pattern to copy.
> 3. Grepping its source for `next-auth` **does** return hits — but they are stale
>    `vi.mock("next-auth/jwt")` calls in a test file, mocking modules the code
>    under test no longer imports. They are no-ops. Do not read them as evidence
>    the dependency is live.
>
> The dependency, the `AUTH_SECRET` convention, and the `[...nextauth]` route are
> all absent here on purpose.

Why hand-rolled: Credentials + **database** sessions is not natively supported by
Auth.js in v4 or v5. Every real implementation ends up writing the session row and
managing the cookie manually — so the adapter and the provider earn nothing but a
dependency and a misleading abstraction.

Rules: argon2id with sane params; token from `crypto.randomBytes(32)`, stored
**hashed** so a DB leak is not a session leak; absolute + idle expiry; rotate on
privilege change; revoke all sessions on password change; constant-time compare.

### AWS SDK v3 (the app's own cloud, not the customer's)
`@aws-sdk/client-bedrock-agentcore` (invoke the runtime), `@aws-sdk/client-s3` +
`@aws-sdk/s3-request-presigner` (artifact download), `@aws-sdk/client-dynamodb` +
`@aws-sdk/lib-dynamodb` (chat history), `@aws-sdk/client-bedrock-runtime` (AI
conversation titles — a direct Converse call, **not** the reporting runtime).

## Agent runtime (`agent/`)
Python **Strands** agent on **Bedrock AgentCore Runtime**, packaged as an
**arm64** container.

- `strands-agents` — agent + tool definitions.
- `bedrock-agentcore` — runtime entrypoint / SSE streaming.
- `azure-identity` — `ClientSecretCredential` (one instance, reused; see
  `azure-integration.md`).
- `azure-mgmt-resourcegraph` — inventory.
- `azure-mgmt-compute` — VM SKU capacity (vCPU / memory), for derived metrics.
- **`azure-monitor-querymetrics`** — `MetricsClient.query_resources` (batch).
- **`azure-monitor-query>=2`** — `MetricsQueryClient.list_metric_definitions`.
  > **Both are required.** `azure-monitor-query >= 2.0.0` **removed**
  > `MetricsClient`; batch metrics moved to the separate
  > `azure-monitor-querymetrics` package. Installing only one of the two will fail
  > at import in a way that looks like a version pin problem and is not.
- `python-docx` — emit the **document AST** against a **styles-only** theme document.
- `pandas` — bucketing and roll-ups over collected series.
- **LibreOffice** (system package in the image, not a Python dep) — `.docx` → `.pdf`.

### Templates are not files the user provides
A template is a **versioned JSON definition** authored in the in-app drag/drop
builder and compiled to a **typed document AST**. `python-docx` emits that AST
against one of four **styles-only** theme documents in `agent/themes/`. Explicitly:

- **No `docxtpl`.** No Jinja inside a document, no `{{ placeholder }}` substitution.
- **No user-supplied `.docx`.** There is no template upload endpoint, in either half.
- **No user-facing template language** — so there is nothing to lint, and no way to
  author an expression that yields a number without provenance.

The theme files carry Word **paragraph, character and table styles and no content** —
stylesheets that happen to be `.docx`. Each must define the `Figure` character style
the renderer wraps figures in. See `structure.md` for the AST and block grammar.

PDF: convert **from the produced `.docx`** using **LibreOffice in the container**, so
Word and PDF cannot disagree. Never render the two independently from the ledger —
that is two chances to diverge. Headless LibreOffice in a container needs
`LANG=C.UTF-8` and `--norestore`, and its **user profile pre-warmed at image build
time**; a cold profile makes the first conversion of a container's life slow and
occasionally fails outright, which reads as a flaky render rather than a cold start.

## First-time setup

### `app/` — ALREADY SCAFFOLDED. Do not re-run init.
It exists, it builds clean, and it was created with:
```bash
pnpm dlx shadcn@latest init --preset b3f0SLkV6m --template next \
  --name app --no-monorepo -y
```
**Do not overwrite `app/components.json` or `app/app/globals.css.`** They carry the
preset's identity (see `design-system.md`); regenerating them silently changes the
whole design system. Additive edits to `globals.css` (appending new token blocks)
are fine and expected; replacing or reformatting the existing token values is not.

Current state — everything else is still to be added:

| Present | Version / note |
|---|---|
| `next` | 16.2.6 |
| `react` / `react-dom` | 19.2.4 |
| `@base-ui/react` | 1.7.0 |
| `tailwindcss` + `@tailwindcss/postcss` | v4 |
| `shadcn` | 4.16.1 — **a runtime dependency, not just a CLI** |
| `next-themes` | 0.4.6 (light/dark) |
| `tw-animate-css` | 1.4.0 |
| `class-variance-authority`, `clsx`, `tailwind-merge` | variants + `cn()` |
| `@phosphor-icons/react` | 2.1.10 |
| generated code | `components/ui/button.tsx`, `components/theme-provider.tsx`, `lib/utils.ts` |
| scripts | `dev`, `build`, `start`, `lint`, `format`, `typecheck` |

> `app/app/globals.css` does `@import "shadcn/tailwind.css"`, so **`shadcn` must
> stay in `dependencies`**. It is not a dev-only CLI here; pruning it breaks the
> build.

### `app/` — what to add
```bash
# from app/
pnpm add drizzle-orm pg zod argon2 \
  @aws-sdk/client-bedrock-agentcore @aws-sdk/client-s3 @aws-sdk/s3-request-presigner \
  @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @aws-sdk/client-bedrock-runtime
pnpm add -D drizzle-kit @types/pg
```
Then add scripts: `db:generate`, `db:migrate`, `db:push`.

Pull Base UI primitives from the registry as needed (`Sidebar`, `Sheet`, `Dialog`,
`Form`, `Input`, `Select`, `Popover`, `Table`, `Tabs`, `Badge`, `Progress`, plus the
chat primitives `Message` / `Message Scroller`). Add the shadcn **`chart`**
component for in-app charts — `pnpm dlx shadcn@latest add chart` pulls the Chart
components + **Recharts**. Adding components is safe; `init` is not.

The template builder needs a **drag-and-drop primitive**, deliberately not picked
here. The binding requirement when it is: **keyboard-accessible reordering is
mandatory**, not a follow-up (see `design-system.md`). Several popular DnD libraries
cannot do it at all, so this constraint decides the choice — evaluate against it
first rather than retrofitting a keyboard path later.

### `agent/` — to be created
arm64 container, `pyproject.toml`, AgentCore entrypoint. Pin
`azure-monitor-query>=2` **and** `azure-monitor-querymetrics` together.

The image also needs **LibreOffice**, an arm64 build of the fonts each theme
references, and a **pre-warmed LibreOffice profile** baked at build time. The four
`agent/themes/*.docx` files ship **in the image** — they are code, not user content,
so they are versioned in git and reviewed like code.

## Environment variables
Server-only unless noted. Commit **`.env.example`** with placeholders; real values
only in the git-ignored **`.env`**.

| Var | Purpose | Example |
|---|---|---|
| `DATABASE_URL` | Postgres connection | `postgres://user:pass@host:5432/reporting` |
| `APP_ENCRYPTION_KEY` | encrypt Azure `client_secret` at rest | (random 32 bytes, base64) |
| `AWS_REGION` | runtime + S3 + DynamoDB region | `us-east-1` |
| `RPT_RUNTIME_ARN` | AgentCore runtime ARN | `arn:aws:bedrock-agentcore:us-east-1:<ACCOUNT_ID>:runtime/<RUNTIME_ID>` |
| `RPT_ARTIFACT_BUCKET` | snapshots, ledgers, verifications, docx/pdf | `<ARTIFACT_BUCKET>` |
| `RPT_HISTORY_TABLE` | DynamoDB table for conversations + messages | `rpt-chat-history` |
| `RPT_TITLE_MODEL_ID` | Bedrock model for AI conversation titles (fast/cheap) | `moonshotai.kimi-k2.5` |
| AWS credentials | server identity: AgentCore + S3 + DynamoDB + Bedrock | env / profile / task role |

> **No `AUTH_SECRET`** — there is no Auth.js. Session tokens are random and stored
> hashed; nothing is signed.
>
> **No Azure credentials in env.** Azure `tenant_id` / `client_id` /
> `client_secret` are **per-customer data**, live encrypted in Postgres, and are
> passed to the runtime in the invoke payload's `context` — the same shape
> `cold-agent` uses for `role_arn` / `external_id`. Never hardcode
> `RPT_RUNTIME_ARN`; read `process.env`.

## What a green suite does not prove

Eighteen defects reached production against a suite of 5044 agent and 3336 web
tests. Not one was in code the tests ignored — every one was in code they covered
heavily. They survived because each test asserted **one half of a contract**. Fourteen
patterns, each of which has now cost a live run:

**A round trip is not two halves.** `collect/archive.py` serialized a `Decimal` to
its exact digit string and `verify/replay.py` re-read it as a `str` the numeric
parser rejected. Both halves were individually correct and individually tested. The
archive was write-only for a month. → Assert `write → read` end to end, and with
values that only a round trip can break: whole numbers survive the bug that
fractional values expose.

**A value's provenance is not its shape.** The verification result carried a
`template_version_id` that was well-formed, non-empty, and the wrong field entirely —
a run id where a foreign key wanted a template version row. Every shape assertion
passed. → When a value must come from a *particular* place, assert **which place**,
not that it looks right.

**An injected seam is an untested seam.** Every test passes `object_store`, so the
`or _s3_store(...)` fallback had no caller but a deployed container — and it drifted
to a keyword the constructor does not accept. The end-to-end test named that seam
and `monkeypatch.setattr`'d it away. → Production-only construction sites need a test
that *calls* them, plus a guard that fails when a new one appears.

**A test that names the wrong exception tests the wrong path.** A miswired
`CommandUnimplementedError(...)` raised a `TypeError` from its own constructor, so
three parametrized cases silently exercised one code path and a mutant survived. →
Assert the **specific** expected outcome per case, not merely that the outcome is
acceptable; a case that stops testing what it says should fail, not pass by another
route.

**A capability is not a call site.** This one has now happened **seven times** —
`emit_front_matter`, `authored_matches`, `liftDefinition`, `FrontMatterForm`,
`StepDesign`, `resource_attribute_text` and `_resource_ordinal` were each written,
unit-tested, and reached by nothing. The last two are the sharpest, because both sat
*mid-pipeline* rather than at an edge: `read_column_entries` validated a
`kind: "attribute"` column against `COLUMN_ATTRIBUTES`, `resource_attribute_text`
could render every one of the seven, and `compile_resource_table` in between read only
the `metric` and `fact` entries — so `azure_subscription` and `resource_groups`, which
differ precisely in their attribute columns, both delivered as the identical blank
`Resource | Count` table over all 23 resources. `_resource_ordinal` is the same shape
with a comment admitting it: `expand_sections` wrote it "so the block compiler can pick
the right one" and no compiler ever did, so a `per: "resource"` section rendered its
whole scope once per resource — three NSGs, three byte-identical rule tables. `StepDesign`
is the clearest: the wizard shell received the server-resolved `thumbnails` prop and
bound it to `_thumbnails`, so four committed theme images and a tested picker sat
behind a surface no consultant could reach, and every delivered report used the
draft default. The same shape at field scale — `ApproverEntry.company` was declared
and collected and the pipeline never read it, so a column headed "Company" rendered
the person's job title. → A unit test proves a component works; it says nothing
about whether anything calls it. Assert the **wiring**: that the step renders, that
the resolver carries the field, that the emitter reaches the value. An unused export
in a feature branch is a missing call site, not a spare part.

**A mirror pair drifts on whichever side is quieter.** `render/toc.py` classified a
contents page by requiring a leader run of dots; `verify/toc.py` stated the same
rule and accepted any whitespace. Both were tested, on fixtures each half had
written for itself. The loose half matched an ordinary table row and failed a
correct run. → When two modules encode one rule, one of them owns the constant and
the other imports it, or a test reads both and asserts they agree. Two independent
statements of one rule is one rule and one latent bug.

**A fixture can be too small to express the failure.** Every chart fixture in the
suite plots a handful of points and the end-to-end fixture plots **one**, so when the
companion table was reshaped to a row per series with a column per x, every test saw a
two-column table and passed. A real July is 32 columns, and LibreOffice lays those out
too narrow for their text to survive the PDF conversion: the next live run returned 146
`pdf_figure_missing` findings — every figure of that table — on a `.docx` whose other
twenty tables all resolved.

**And then it happened again, one dimension over.** The replacement shape was measured
at a month of rows and every figure survived — with the synthetic fixture's *short*
values. The next live run, ef01a404, returned 30 findings, one per day of July, all in
the single column holding `3,187,970,789.00 bytes` beside four columns of `0.20%`. Word
divides a table's width equally unless told otherwise, so the memory column got exactly
as much room as the percentages and LibreOffice wrapped every value inside its cell.
Every character was on the page; none was findable, because `verify/pdf.py` matches the
ledger string contiguously and the break fell in the middle of the number.

→ A shape that scales with the data has to be tested at the size the data actually
reaches, in **every** dimension it scales in — rows, columns, and the width of the
values themselves — and for anything that must survive `docx → pdf`, tested *through the
conversion*. `render/tablefit.py` now owns both the sizing and a measured page budget,
with the LibreOffice measurements recorded beside the constant; `test_tablefit.py` holds
the arithmetic and `test_docx.py` the round trip.

A postscript worth its own line, because it nearly shipped: the first fix sized columns
**in proportion** to their content, which is correct only while the total fits. Past
that it scales everything down by one factor, so a six-character `79.88%` beside a
thirty-eight-character `0.25% (p95, est. from hourly averages)` was squeezed to four and
wrapped — a column Word's own equal division had handled perfectly well, broken by the
sizing meant to help it. The allocator water-fills instead: a column is cut only when
every column still in the running is getting the same share. **A fix that improves the
common case by making the bad case worse is not a fix**, and the only reason this one
was caught is that the end-to-end guard was mutation-checked and turned out to pass
against the unfixed code — its fixture had three columns, and it takes six.

**A fixture can be too clean to express the failure.** The lifetime bound had a test
asserting exactly the right thing — "a fact collected in the same second the
invocation began is inside the run" — that passed throughout, because its fixture
instant carried no microseconds and the production clock always does. The stored
`collected_at` is truncated to whole seconds while the bound is not; the comparison
was between two precisions and the fixture could not represent the gap. → When a
test's subject is a **boundary**, the fixture has to carry the messiness the real
value has. Round numbers hide exactly the class of bug boundaries produce. The same
shape reappeared in the revision row: every fixture supplied a note, so
`note + f" ({author})"` was only ever exercised with both halves present, and since
schema_version 3 derives the revision from a run count the note is *always* empty —
every delivered document carried a value cell reading " (Mayer Reflino Sitorus)", a
parenthetical qualifying nothing.

**A reader of one schema version is a reader of none.** `report_pipeline.py` resolved
`historical_trend` blocks by walking `definition["blocks"]` — the v2 shape. Every
profile the wizard writes is v3 and carries `sections`, so the walk returned the empty
set, no prior run was ever selected, and every trend printed "No prior verified period
is available for this trend." against a database holding eleven passing July runs.
Nothing raised, no gate fired, and no test failed: an empty trend is a state the block
is *supposed* to be able to reach, so the defect's only symptom was a correct-looking
report with an empty section. It survived because the walker was a **second reading**
of the definition, written beside the compiler rather than inside it. → When one thing
must be read twice, the second reader belongs in the module that owns the rules and
calls the same helpers the first one does — and the guard is not "the second reader
returns something", it is "the second reader and the real expansion agree", which is
the only assertion the mutant fails.

**A generator's pools are the only shapes the property tests.** Property 6 was written
to prove a text fact's check catches what numeric masking cannot, and it generated
three value shapes: digit-free words, identifier-like tokens, and dotted addresses. Each
fails masking in its own documented way. **A bare numeral was not among them** — and a
bare numeral is the one shape that survives every masking stage and looks exactly like a
figure missing from the ledger. So a security-rules table full of ports and priorities
returned twenty-one blocking findings on a delivered run, every value of which was
collected, anchored and proven. → A property over "shapes of value" is only as strong as
its list of shapes, and the shape most likely to be missing is the one nobody thought of
as a shape. Enumerate them against the *failure modes*, not against the examples you
happen to have.

**A filter that excludes by the wrong key excludes more than it names.**
`_non_child_projections` removed a child type's fact keys from the main inventory
query's projection clause — correctly, since a child's expression names an identifier
only its own `mv-expand` binds. It excluded **by key**. The moment a first-class type
declared a key a child type already had, both projections went, the column was silently
absent, and the table that needed it printed a no-data notice on data that had been
collected. → When a rule is about *which module owns a thing*, key the exclusion on the
owner, not on the thing's name. A name collision is not an ownership claim.

**The design artifact is the specification, and re-reading it is cheaper than
implementing against memory.** Twice in one session a rendering "defect" was about to be
fixed in the direction *away* from the approved mock: the two stacked chart panels the
artifact deliberately draws, and the section numbers the artifact prints in the contents
and not in the body. Both were caught by opening `design/proposed/ReportA.dc.html`
before writing code, and one had already been half-implemented. → Before changing how
something looks, read the artifact for that thing. A remembered design is a design that
has drifted.

The through-line: **a test that cannot fail for the reason the code can break is not
a test.** Mutation-check anything load-bearing — reintroduce the defect and watch it
go red — because that is the only evidence the assertion is connected to the
behaviour.

## Guardrails
- All AWS SDK calls and all secret access happen **server-side only**. All Azure
  SDK calls happen **inside the agent container** only.
- The SSE relay route runs on the **Node runtime** (`export const runtime =
  "nodejs"`) with buffering disabled (`Content-Type: text/event-stream`,
  `Cache-Control: no-cache`, `X-Accel-Buffering: no`).
- Minimum backend IAM: `bedrock-agentcore:InvokeAgentRuntime` on the runtime ARN;
  `s3:GetObject` on the artifact bucket (presign); DynamoDB
  `GetItem/PutItem/UpdateItem/DeleteItem/Query` on `RPT_HISTORY_TABLE` + its GSI;
  `bedrock:InvokeModel` on `RPT_TITLE_MODEL_ID`. The runtime's execution role
  additionally needs `s3:PutObject` **and `s3:PutObjectTagging`** on the artifact
  bucket — the writer tags every object with the actor id, and tagging is a
  *separate* action that `PutObject` does not imply. Omitting it fails the run at
  the first snapshot write, after the whole collection has been spent.
- **Report runs are long** — inventory + metrics + render + verify is minutes, not
  seconds, at a few hundred resources. Keep the stream open, emit `progress` and
  `heartbeat`, and show the live activity timeline until `done`. Never rely on a
  request timeout being generous.
- **Report generation is a deterministic `command`, not a `prompt`.** The UI's
  "Generate report" button must not go through the model. See
  `agentcore-integration.md`.
- `pnpm lint` + `pnpm typecheck` clean before any commit. `pnpm format` uses
  `prettier-plugin-tailwindcss`, so class order is enforced — do not fight it.
- Add every new var to **`.env.example`** in the same change.
