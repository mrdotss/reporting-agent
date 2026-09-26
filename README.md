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
                       ├─▶ AWS       a customer's read-only role, assumed with an external ID
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
| Ask's "what I'm about to do" sentence | `us.moonshotai.kimi-k3` | `RPT_INTENT_MODEL_ID` on the agent runtime (unset: no sentence) |
| Ask conversation titles | `moonshotai.kimi-k2.5` | `RPT_TITLE_MODEL_ID` in the app's environment |

In Ask, people pick the answer model beside the send button: **Kimi K3** (thinks first,
the default) or **Kimi K2.5** (answers straight away). Only those two: the runtime maps the
choice through its own allow-list (`CHAT_MODEL_CHOICES` in `agent/…/narrate/chat.py`, mirrored
in `app/lib/chat/models.ts`), and the browser never sends a model id.

Kimi K3 is offered only through an inference profile, so its id carries the `us.` prefix.
It rejects a `temperature` setting, so the agent leaves it out for that model
(`inference_config` in `agent/src/reporting_agent/narrate/summary.py`). It also reasons
before answering. Ask shows that reasoning live in a "Thinking" panel with every number
masked (`agent/src/reporting_agent/chat/thinking.py`), and never stores it; the saved answer
keeps only how long it thought. While it thinks, a second, short Kimi K3 call writes one sentence on
what the assistant is about to do, digit-free and behind the same guardrail.

### Skills

The runtime carries vendored agent skills (`agent/src/reporting_agent/skills/vendor/`, refreshed
with `python agent/dev/vendor_skills.py` at pinned commits, licences alongside):

- **no-ai-slop** (MIT): its word and pattern lists are added to every narration prompt and to Ask,
  below the figure rules. The model still never types a number.
- **Azure** (Microsoft Agent Skills, CC-BY-4.0) and **AWS** (agent toolkit, Apache-2.0), about 50
  curated skills: **Ask only**. The attachments decide the cloud; a fast model picks at most two
  skills and two pages, read only from learn.microsoft.com or docs.aws.amazon.com. Each skill and
  page is a step in the answer's timeline and listed under the answer. Product knowledge stays out
  of reports, whose narrative may carry no number the compiler did not place.

### AWS connections

A customer grants AWS access by deploying a read-only IAM role, `ReportingAgentReader` at
path `/reporting-agent/`, that trusts only the runtime's role and only with the
connection's external ID. The setup page generates a CloudFormation template and a CLI
script for it. No secret is stored and nothing expires. The actions the role grants live in
[`agent/src/reporting_agent/aws/reader_policy.v1.json`](agent/src/reporting_agent/aws/reader_policy.v1.json),
which both the templates and the runtime's preflight read. The preflight proves the grant
with IAM's own policy simulation, including any organization SCP.

AWS is offered only when the app's `RPT_AWS_CONNECTOR_PRINCIPAL_ARN` names the runtime's
role, and the runtime's role policy allows `sts:AssumeRole` on
`arn:aws:iam::*:role/reporting-agent/ReportingAgentReader`.

A run on an AWS connector collects EC2 instances, EBS volumes and RDS instances from
CloudWatch's `GetMetricData`, per region. CloudWatch's `Sum`, `SampleCount`, `Minimum` and
`Maximum` fold into the same accumulators Azure's `Total`, `Count`, `Minimum` and `Maximum`
do, and each call is archived so the verifier replays AWS figures exactly as it replays
Azure's.

An AWS preset uses its own section catalogue (`providers.aws` in `sections.v1.json`):
- account and region summaries;
- VPCs with their subnets, EC2 instances with their network configuration, Elastic IPs;
- the security groups attached to something, with inbound and outbound rules;
- EBS volumes and RDS databases;
- EC2, RDS and EBS utilization, with the EC2 historical trend;
- AWS Backup coverage, incidents and Compute Optimizer rightsizing;
- coverage and verification.

Resource details are facts from three sources: the same describe calls as the inventory,
AWS Backup's protected resources, and Compute Optimizer's EC2 findings. Each source is
archived once per run and replayed like every other fact; an account with no AWS Backup
plan or no Compute Optimizer enrollment gets that stated as a gap, not an error. A run
covers every region the account has enabled.

Ask prices an AWS report's EC2 instance types (Linux and Windows, license included) and
RDS classes (by engine and Single- or Multi-AZ) from the AWS Price List, through the
runtime's own role, which needs `pricing:GetProducts`.

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
