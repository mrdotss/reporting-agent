# reporting-agent

Collects Azure utilization metrics, renders a Word and PDF report from a user-designed
profile, and **proves every figure in the document traces back to collected data**. A
report that fails any check is withheld, not delivered.

## The rule

**No LLM ever produces a number.**

A deterministic pipeline collects an immutable snapshot, a compiler places every figure
from it, and a verifier proves the document and the snapshot agree. Models write prose and
answer questions, and nothing else: any digit in model prose that the compiler did not
place is a blocking finding.

## How it fits together

```
Browser ──▶ app/     Next.js 16 on our own server (systemd, behind Caddy)
              │      Postgres: users, workspaces, profiles, runs
              │      DynamoDB: Ask conversation history
              │  InvokeAgentRuntime
              ▼
            agent/   Python on Bedrock AgentCore Runtime (arm64, in our VPC)
                     collect → compile → render → verify, narration, Ask answers
                       ├─▶ Azure     Resource Graph, Monitor, Log Analytics, Advisor
                       ├─▶ S3        snapshots, raw archive, reports, verification records
                       └─▶ Bedrock   the models below; Ask runs behind a guardrail
```

| Part | Owns |
|---|---|
| [`app/`](app/README.md) | Sign-in, workspaces and roles, customers' Azure credentials, report profiles, the run state machine (Postgres is the source of truth), downloads, Ask. It never calls Azure and never renders a document. |
| [`agent/`](agent/README.md) | Every Azure call, the snapshot, the compiler, the renderers, the verifier, narration and Ask answers. It never touches Postgres. |
| [`.kiro/`](.kiro/) | The binding design: `steering/` for product, tech, structure and Azure facts; `specs/` for the requirements code comments cite as `Req n.m`. |

## Models

| Used for | Bedrock model id | Configured by |
|---|---|---|
| Report narration, prose review, Ask answers | `us.moonshotai.kimi-k3` | `RPT_PROSE_MODEL_ID` on the agent runtime (`RPT_CHAT_MODEL_ID` overrides Ask only) |
| Ask conversation titles | `moonshotai.kimi-k2.5` | `RPT_TITLE_MODEL_ID` in the app's environment |

Kimi K3 is offered only through an inference profile, so its id carries the `us.` prefix.
It rejects a `temperature` setting, so the agent leaves it out for that model
(`inference_config` in `agent/src/reporting_agent/narrate/summary.py`). It also reasons
before answering; that reasoning is never shown to anyone or stored.

## Run it locally

```bash
cd app   && pnpm install && pnpm db:migrate && pnpm dev
cd agent && uv venv --python 3.12 .venv && uv pip install --require-hashes -r requirements-dev.lock
```

Each half's README describes its environment variables and setup in full.

## Test

```bash
cd agent && LANG=C.UTF-8 .venv/bin/pytest   # agent suite, about 7 minutes
cd app   && pnpm vitest run                 # app suite
cd app   && pnpm build                      # catches server/client import mistakes the tests miss
```

- `LANG=C.UTF-8` is required: the end-to-end tests drive real LibreOffice.
- The app's Postgres suites are skipped unless `TEST_DATABASE_URL` points at the test
  database. `pnpm test:db:up` starts it; its URL is in `app/test/db/scratch-schema.ts`.

## Deploy

When a change spans both halves, ship in this order: **migration → app → agent runtime**.

**The app** deploys when a change merges to `main`. CodeBuild builds it, CodeDeploy installs
the release on our server, applies migrations, and restarts the `reporting-agent` service.
The app's settings live in `/etc/reporting-agent/app.env` and are read only when the service
starts, so restart it after editing them.

**The agent runtime** does not update on merge:

1. Run the agent suite on the commit you are shipping. The image build runs no tests.
2. Build the image: `aws codebuild start-build --project-name reporting-agent-build --source-version <sha>`.
3. Take the new `reporting-agent` image digest from ECR.
4. Call `update-agent-runtime` with that digest, passing back every other setting and
   environment variable, including `platformVersion: "V2"`. The call replaces the whole
   configuration; use boto3 with botocore 1.43.98 or later, because older SDKs and AWS CLI
   2.31.35 cannot send every field. See
   [`agent/README.md`](agent/README.md#deploying-to-agentcore-runtime).
5. Wait for `READY` (a few minutes on V2), then smoke-test a chat turn.

A profile change is not a deploy. Logos, confidentiality notices and number formatting are
pinned in each saved profile version, so re-save a profile for runs to pick up a change.

## Read more

- [`app/README.md`](app/README.md): the web app's environment, run state machine, tests and deployment
- [`agent/README.md`](agent/README.md): the runtime's pipeline, image build, AgentCore deployment and troubleshooting
- [`agent/AGENTCORE_INTEGRATION.md`](agent/AGENTCORE_INTEGRATION.md): the invoke contract, with its commands, payloads and events
- [`.kiro/steering/`](.kiro/steering/): the binding design documents
