# `agent/` — the reporting runtime

The deterministic collector that runs on **Bedrock AgentCore Runtime**. It owns every
Azure call, the collector, the snapshot builder and the object-store writes. No module
in this package calls a model, and no numeric it produces comes from one.

`app/` orchestrates, authorizes and displays. `agent/` collects and proves. If a figure
is being calculated in `app/`, the layering is wrong.

## Requirements

| | |
|---|---|
| Python | **3.12** exactly — see `.python-version` and `requires-python = "==3.12.*"` |
| Target platform | **`linux/arm64`** — AgentCore Runtime accepts nothing else |
| Dependencies | `pyproject.toml` declares them; `requirements.lock` pins the runtime closure with hashes and `requirements-dev.lock` pins the dev closure |

Python is pinned rather than ranged because one snapshot has to hash identically
across two operating-system processes. A minor-version difference is a difference in
`Decimal` and JSON behaviour, and the snapshot id is the whole audit trail.

## Local development

```bash
cd agent
uv venv --python 3.12 .venv                          # or: python3.12 -m venv .venv
uv pip install --require-hashes -r requirements-dev.lock # pytest + hypothesis + ruff
```

`requirements-dev.lock` is dev-only and never reaches the image; it covers the dev group
**and** the project's own dependencies, because a test suite needs the code under test.
So installing it is enough: every package the two locks share is pinned to the same
version, `tests/test_lock_consistency.py` asserts that, and installing
`requirements.lock` afterwards is a no-op that changes nothing. Install order does not
matter and is not a rule to remember.

`pyproject.toml` puts `src` on the pytest path rather than installing the project, which
is exactly what the image does: it copies `src/reporting_agent/` next to the entrypoint
and runs `python -m reporting_agent.main`. One import path, two environments.

```bash
.venv/bin/pytest                 # the suite
.venv/bin/pytest tests/property  # the hypothesis properties, ≥100 examples each
.venv/bin/ruff check .           # the linter — must exit clean before a commit
```

There is no task runner here on purpose, so those are the invocations: the venv's own
binaries, no wrapper. `ruff check` walks `src/` and `tests/` and nothing else — `.venv/`,
`.pytest_cache/` and `.ruff_cache/` are in ruff's default exclusions and `.hypothesis/`
holds no Python. **Linter only:** `ruff format` is deliberately not part of the workflow.
No Python formatter is established here, and adopting one would reformat the tree in a
change that is supposed to be tooling. The rule selection in `pyproject.toml` reflects
that — it leaves out `E501` and anything else a formatter would own.

Two of the enabled rules are project invariants rather than style
(`[tool.ruff.lint.flake8-tidy-imports.banned-api]`):

* **`DefaultAzureCredential` is banned outright** (Req 19.7). The credential is built
  from the invocation `context` only; an ambient chain would authenticate as the
  container's own identity against a customer's subscription. This **deliberately
  overlaps** the AST scan in `tests/test_boundaries.py`: ruff catches it in the editor,
  the test catches it in CI. The overlap is not redundancy — banned-api matches import
  paths and qualified attribute access, so it cannot see
  `getattr(identity, "DefaultAzureCredential")`, and the AST scan's exact-match check on
  string constants can.
* **`azure.monitor.query.MetricsQueryClient` is banned** because no pinned package
  exports that name — see the three-package split below.

The hypothesis profile lives in `tests/conftest.py` and is loaded by default:
`max_examples=100`, `deadline=None`, `print_blob=True`. `HealthCheck.filter_too_much`
and `HealthCheck.data_too_large` are never suppressed — a property that filters away
most of its generated input must fail rather than pass on what survived.

## Dependency locking

Two lock files, both committed, both fully pinned and hashed, so two builds of one commit
resolve identical versions:

| file | pins | who installs it |
|---|---|---|
| `requirements.lock` | the **runtime closure** — `[project.dependencies]` and nothing else | the image, with `--require-hashes` (see `Dockerfile`) |
| `requirements-dev.lock` | the **whole `[dependency-groups] dev` group** — `pytest`, `hypothesis`, `ruff` — plus the project's own dependencies | developers and CI only; **never** the image |

The dev lock covers the runtime closure too, so the two files overlap almost entirely:
every package in `requirements.lock` also appears in `requirements-dev.lock`. **They must
name the same version for it**, or the closure the suite runs against is not the closure
the image runs. `tests/test_lock_consistency.py` asserts exactly that — any package in
both files is pinned to one version, and `pytest`, `hypothesis` and `ruff` are in the dev
lock and absent from the runtime lock.

**Neither is ever hand-edited.** They are output. Regenerate both in one pass, dev first,
because the runtime lock is resolved against it:

```bash
cd agent
uv pip compile pyproject.toml --group dev \
  --universal --python-version 3.12 --generate-hashes --emit-index-url \
  --output-file requirements-dev.lock

uv pip compile pyproject.toml \
  --universal --python-version 3.12 --generate-hashes --emit-index-url \
  --constraint requirements-dev.lock \
  --output-file requirements.lock
```

`--constraint requirements-dev.lock` is what makes the agreement structural rather than a
coincidence of when each file was last compiled. Without it the two locks drift, and not
because the resolver is non-deterministic: **uv reads an existing output file as
resolution preferences**, so re-compiling a lock that is a patch release behind happily
leaves it there. That is how `botocore`, `charset-normalizer`, `typing-inspection` and
`uvicorn` came to sit one patch apart in the two files. The constraint removes the stale
preference — the resulting `requirements.lock` is pin-for-pin identical to a from-scratch
resolution of `[project.dependencies]` alone, so nothing dev-only leaks into the image's
closure; the only thing that changes is that the skew cannot come back.

The constraint leaves a `# via -c requirements-dev.lock` annotation on every entry in
`requirements.lock`. That is uv's provenance comment, not something to tidy away.

`--universal` is what makes one lock serve both an x86 development machine and the
arm64 image: it carries the hashes for every platform's wheel of each pinned version,
and `pip` picks the one matching the marker. `--python-version 3.12` matters — a lock
resolved against another minor pins wheels the image will reject.

### Why the dev tools are hash-pinned too

`ruff` and `pytest` benefit, but **hypothesis is the motivation.** Its version decides
which inputs the properties generate and how a failing case shrinks, so drift is not
cosmetic — it changes what the suite actually explored. `tests/conftest.py` asserts at
**collection** that `max_examples` is 100, that `deadline` is None, and that
`HealthCheck.filter_too_much` and `HealthCheck.data_too_large` are unsuppressed. An
upgrade that re-semantics a health check either breaks those asserts outright or, worse,
quietly changes what the properties explore while still reporting green. The verification
claim this product makes rests on those properties, so the tool that generates them is
pinned by hash like anything else the claim depends on.

The image never sees this file. `Dockerfile` copies `requirements.lock` by name, and
`.dockerignore` excludes `requirements-dev.lock` from the build context outright, so a
future `COPY requirements*.lock ./` cannot pull the dev tools in by accident.

### The three Azure Monitor packages

`azure-monitor-query` 2.0.0 removed **both** `MetricsClient` and `MetricsQueryClient` and
is now logs-only, so the metrics surface lives in two other packages. All three are
pinned, together, in `pyproject.toml`, with the reasoning adjacent to the pins:

| pin | provides | used for |
|---|---|---|
| `azure-monitor-querymetrics>=1,<2` | `MetricsClient.query_resources` | batch metric values, regional data plane |
| `azure-mgmt-monitor==7.0.0` | `MonitorManagementClient.metric_definitions.list` · `.metrics.list` | metric definitions and the per-resource regional fallback |
| `azure-monitor-query>=2,<3` | `LogsQueryClient` | logs for the **enhanced tier only** |

Installing a subset fails at import in a way that reads like a version-pin problem and is
not — which is why the image asserts the split at **build** time rather than leaving it to
a deployed run, and `tests/test_dependency_pins.py` asserts it in the suite.

## Building the image

Every build command names `--platform linux/arm64`. AgentCore Runtime requires arm64,
and a build on an x86 host that omits the flag produces an image the runtime will not
start — it fails at launch, not at build, which is the expensive place to find out.

```bash
cd agent
docker buildx build --platform linux/arm64 -t reporting-agent:dev --load .
```

Push to ECR:

```bash
aws ecr get-login-password --region "$AWS_REGION" \
  | docker login --username AWS --password-stdin "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

docker buildx build --platform linux/arm64 \
  -t "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/reporting-agent:$TAG" \
  --push .
```

Confirm what you actually produced before deploying, because this is the failure the
flag exists to prevent:

```bash
docker image inspect reporting-agent:dev --format '{{.Os}}/{{.Architecture}}'
# linux/arm64

docker manifest inspect \
  "$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/reporting-agent:$TAG"
# .manifests[].platform -> { "architecture": "arm64", "os": "linux" }
```

### What the build asserts before it will publish anything

Four assertions, each failing the build rather than a deployed run:

| assertion | catches |
|---|---|
| the three-package Azure Monitor split imports | a pin that fails at import in a way that reads like a version problem |
| `python -m reporting_agent.compile.ast --assert-build` | an AST in which a quantity can appear without provenance |
| `python -m reporting_agent.render.themes --assert-build` | a theme missing a referenced style, carrying content, or unopenable |
| `uname -m` is `aarch64`, `soffice` on `PATH`, `$LO_PROFILE` non-empty | an x86 image, absent LibreOffice, or a profile that was never warmed |

The first three run in the suite as well (`tests/test_dependency_pins.py`,
`tests/test_ast_guard.py`, `tests/test_themes.py`). They are repeated at build time
because `.dockerignore` excludes `tests/`, so a guard that only ran in the suite could
not stop a bad image from being published.

### LibreOffice, the fonts, and the pre-warmed profile

The image installs `libreoffice-writer` and `libreoffice-core` — no Calc, no Impress,
no JRE — plus `fonts-dejavu-core` and `fonts-liberation2`, which supply every face the
four themes name. A theme naming a font the container lacks renders through
LibreOffice's substitution, which changes line breaking and therefore pagination, so
the font list and `render/themes.py`'s `THEME_SPECS` are one decision in two files.

`LANG=C.UTF-8` is load-bearing. A comma-decimal locale rewrites every numeral
LibreOffice lays out, so the ledger's `formatted` strings stop being locatable in the
PDF and a correct document fails its own verification. `render/pdf.py` asserts the
value before starting the process rather than trusting the image.

The LibreOffice user profile is warmed at `$LO_PROFILE` **at build time** by converting
a document built through the real path — a theme opened with `python-docx`, saved, then
converted with `soffice`. A cold profile makes the first conversion of a container's
life slow and occasionally fail outright, and the same 300-second limit and single
attempt apply to that first conversion as to every later one, so there is no retry to
hide behind. The profile is used as-is at run time and never re-created; it carries
group `0` with group permissions mirroring the owner's, so whichever uid the runtime
supplies can take LibreOffice's lock files inside it.

## Building on CodeBuild instead

The `docker buildx` lines above work, and on an x86 host every one of them runs the
LibreOffice install, the font install and the profile warm-up through qemu. That is the
better part of an hour, and it first needs `binfmt_misc` handlers registered kernel-wide
through a privileged container — a change to the developer's machine that a build has no
business making.

`buildspec.yml` builds the same image on a **native arm64** CodeBuild host in a fraction
of the time and touches no local machine. `--platform linux/arm64` is still passed: on
that host it is a no-op, and that is the point, because the Dockerfile's `uname -m`
assertion then fails a project accidentally moved to an x86 compute type rather than
producing an image the runtime refuses to start.

```bash
aws iam create-role --role-name ReportingAgentCodeBuildRole \
  --assume-role-policy-document file://deploy/codebuild-trust.json
aws iam put-role-policy --role-name ReportingAgentCodeBuildRole \
  --policy-name ReportingAgentCodeBuildPolicy --policy-document file://deploy/codebuild-policy.json

aws codebuild create-project --cli-input-json file://deploy/codebuild-project.json --region "$AWS_REGION"
aws codebuild start-build --project-name reporting-agent-build --region "$AWS_REGION"
```

The build role needs `ecr:DescribeImages` as well as the push actions. The buildspec's
last line reads the pushed digest back so a runtime can be pinned to an exact image
rather than to a tag that moves under it, and a role carrying only the push actions
pushes successfully and then fails on that one call.

## Deploying to AgentCore Runtime

1. Build and push as above — `--platform linux/arm64` on every build line.
2. Create the execution role, then create or update the runtime against the pushed
   image URI:

   ```bash
   aws iam create-role --role-name ReportingAgentRuntimeRole \
     --assume-role-policy-document file://deploy/runtime-trust.json
   aws iam put-role-policy --role-name ReportingAgentRuntimeRole \
     --policy-name ReportingAgentRuntimePolicy --policy-document file://deploy/runtime-policy.json

   aws bedrock-agentcore-control create-agent-runtime \
     --cli-input-json file://deploy/runtime.json --region "$AWS_REGION"
   aws bedrock-agentcore-control get-agent-runtime \
     --agent-runtime-id <RUNTIME_ID> --region "$AWS_REGION"   # wait for READY
   ```

3. Put the resulting runtime ARN in the app's `RPT_RUNTIME_ARN`. The app reads it from
   `process.env` and never hardcodes it.

### `update-agent-runtime` is a full replace — read this before shipping a new image

**Every field you do not pass is deleted.** Omitting `--environment-variables`
removes all of them, and the container then dies at import on its own config guard,
in a crash loop, *before any handler exists* — so it cannot report the failure and
the runs handed to it simply never start.

Read the previous version and replay it whole:

```bash
V=$(aws bedrock-agentcore-control get-agent-runtime \
      --agent-runtime-id "$ID" --agent-runtime-version "$PREV" \
      --region "$AWS_REGION" --output json)
# Every field is replayed from $V. Pull each one whole — never with a --query
# projection, which is how the fields you forgot to name get deleted.
field() { printf '%s' "$V" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin)['$1']))"; }
ENV=$(field environmentVariables)
ARTIFACT=$(field agentRuntimeArtifact)
PROTOCOL=$(field protocolConfiguration)
LIFECYCLE=$(field lifecycleConfiguration)
METADATA=$(field metadataConfiguration)
ROLE_ARN=$(printf '%s' "$V" | python3 -c "import sys,json;print(json.load(sys.stdin)['roleArn'])")
DESC=$(printf '%s' "$V" | python3 -c "import sys,json;print(json.load(sys.stdin)['description'])")

# `requireServiceS3Endpoint` is returned by get and REJECTED by update for runtimes
# created after 2026-06-11. It is server-managed; strip it or the call fails.
NETWORK=$(printf '%s' "$V" | python3 -c "
import sys, json
n = json.load(sys.stdin)['networkConfiguration']
n.get('networkModeConfig', {}).pop('requireServiceS3Endpoint', None)
print(json.dumps(n))")

aws bedrock-agentcore-control update-agent-runtime \
  --agent-runtime-id "$ID" --region "$AWS_REGION" \
  --role-arn "$ROLE_ARN" --description "$DESC" \
  --agent-runtime-artifact "$ARTIFACT" --network-configuration "$NETWORK" \
  --protocol-configuration "$PROTOCOL" --lifecycle-configuration "$LIFECYCLE" \
  --metadata-configuration "$METADATA" \
  --environment-variables "$ENV"
```

**`--metadata-configuration` is not optional.** It carries `requireMMDSV2: true`,
and a full replace that omits it deletes it — silently relaxing the
instance-metadata posture rather than failing anything. It is the one field whose
loss the crash-loop symptom will *not* tell you about, which is why it is easy to
leave out and was left out of this recipe for the first twenty-odd deploys.

Do **not** assemble that snapshot with a `--query` projection. Reading only the
fields you remember to name is precisely how the ones you forgot get deleted — dump
the whole object. Then *verify* the result rather than trusting the call:

```bash
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$ID" \
  --region "$AWS_REGION" --output json | python3 -c "
import sys, json; d = json.load(sys.stdin)
print(d['agentRuntimeVersion'], d['status'])
print('env :', sorted(d.get('environmentVariables') or {}))
print('life:', d.get('lifecycleConfiguration'))
print('meta:', d.get('metadataConfiguration'))
print('net :', d['networkConfiguration']['networkModeConfig'])"
```

Better still, diff the whole object against a snapshot taken **before** the update:
every field but `agentRuntimeVersion` and `lastUpdatedAt` should be byte-identical.
A field-by-field eyeball only finds the fields you thought to print.

**Push before you build.** CodeBuild clones the repository at `main` — it never sees
your working tree. A build started with unpushed commits rebuilds the previous commit
and reports `SUCCEEDED`: a green build, a fresh image digest, a new runtime version,
and none of your changes in it. Pin it with `--source-version <sha>`, and confirm the
digest on `:latest` was pushed by *this* build rather than an earlier one.

**A `:latest` container URI resolves when the version is created, not when the image
is pushed.** A build alone changes nothing about a running runtime; it needs an
update to cut a version that re-resolves the tag. The useful corollary: building is
safe and deploying is the gate, which is what lets a build run in parallel with a
database migration that has to land first.

`deploy/*.example.json` are the committed templates; the real files beside them carry
account, bucket and runtime identifiers and are git-ignored.

**`RPT_ARTIFACT_BUCKET` is a bucket name, not a bucket and prefix.** Both halves pass it
straight into `Bucket=` — `storage/s3.py` and the app's `lib/aws/s3.ts` alike — so a
value like `my-bucket/my-prefix` fails every S3 call with `InvalidBucketName`. Keys are
already namespaced `<actor_id>/snapshots/…` and `<actor_id>/reports/…`, so a prefix earns
nothing the key layout does not already provide.

### A private certificate authority in front of the app

`RPT_APP_BASE_URL` is HTTPS, and the progress callback verifies it. `httpx` builds its
default context from **certifi** with an explicit `cafile`, which makes `SSL_CERT_FILE`
and `REQUESTS_CA_BUNDLE` inert — there is no environment-only way to add a root.

For a deployment where the app is reachable only on a private network, behind a
certificate the operator's own authority issued, mount the PEM and name it:

```
RPT_CA_BUNDLE=/etc/ssl/private-ca/root.pem
```

Optional; unset means the default trust store, which is what a publicly trusted
certificate needs. A path naming no readable file **raises** rather than falling back —
silently reverting to the default would fail verification on every callback of every run,
and Req 38.4 swallows callback failures, so the run would reach `TIMEOUT` with a complete
and verified report already in S3. There is deliberately no switch to disable
verification.

The alternative, which needs no configuration at all: give the app a name under a domain
you own and issue a publicly trusted certificate through a DNS-01 challenge. That works
for a host with no inbound public access, since DNS-01 proves domain control rather than
reachability, and it leaves the container's trust store untouched.

### Smoke-testing a fresh runtime

```bash
aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id <RUNTIME_ID> --region "$AWS_REGION"
```

`READY` says the container started, which is most of what can go wrong with an image.
To prove the process's own configuration as well, invoke it with a command it does not
accept:

```python
dp.invoke_agent_runtime(agentRuntimeArn=ARN, runtimeSessionId="a"*40, payload=json.dumps({"command": "ping"}))
```

A healthy runtime answers `200` with an SSE `error` event naming `UNSUPPORTED_COMMAND`
and the four commands it does accept. That single response proves more than it looks
like: the image is the right architecture, `Config.from_env()` found every variable in
`REQUIRED_ENV_VARS` — a missing one raises `MissingConfigError` at process start, so the
runtime would never have reached the router — and the SSE contract is intact.

The runtime's execution role needs `s3:PutObject` on the artifact bucket. The runtime
reads its own configuration from the environment once at process start; `config.py`
holds the authoritative list.

**No Azure credentials in the environment.** `tenant_id`, `client_id` and
`client_secret` are per-customer data. They live encrypted in the app's Postgres and
arrive in the invoke payload's `context`, decrypted server-side at invoke time. The
same applies to `progress_token`, which authorizes writes to the run state machine and
is treated exactly like a client secret.

## Troubleshooting

**The runtime will not start, or exits immediately.** Check the image platform first:
`docker manifest inspect <uri>` must report `arm64`/`linux`. An x86 image is the usual
cause. Rebuild with `docker buildx build --platform linux/arm64 -t <uri> --push .` —
note the flag; a rebuild without it reproduces the same failure.

**`pip install` fails with a hash mismatch.** `requirements.lock` was hand-edited, or it
was resolved for a different Python minor. Regenerate both locks with the `uv pip compile`
commands above and rebuild with `docker buildx build --platform linux/arm64 ...`.

**`tests/test_lock_consistency.py` fails.** The two locks name different versions for a
package they share, so the tested closure and the shipped closure disagree. The failure
message names the package and both versions. Do not edit a pin to match: regenerate both
locks in one pass as shown above — the `--constraint` is what keeps them agreeing.

**The container crash-loops on `MissingConfigError` right after a deploy.** An
`update-agent-runtime` dropped the environment variables — see the full-replace
warning above. Cut a new version replaying the previous one whole. Nothing is wrong
with the image.

**A run fails with `AccessDenied` on the first snapshot write.** The execution role
needs `s3:PutObjectTagging` as well as `s3:PutObject`: the writer tags every object
with the actor id, and tagging is a separate action `PutObject` does not imply. The
role is assumed fresh per invocation, so fixing the policy takes effect on the next
run with **no rebuild**.

**`REPLAY_MISMATCH` on a run whose numbers look right.** The document is probably
correct and the verifier is disagreeing with itself. Reproduce it offline — replay is
pure, so it needs no Azure and no runtime:

```bash
aws s3 cp "s3://$BUCKET/<actor>/snapshots/<runId>/" ./run --recursive
PYTHONPATH=src python -c "
import json, pathlib
from reporting_agent.verify.replay import replay, plan_from_snapshot
from reporting_agent.catalog.loader import load_catalog
d = pathlib.Path('run')
doc = json.loads((d/'snapshot.json').read_text())
r = replay([(i, p.read_bytes()) for i, p in enumerate(sorted((d/'raw').glob('*.json.gz')))],
           plan=plan_from_snapshot(doc, catalog=load_catalog()))
print(r.outcome)
print(json.dumps(r.document, indent=2, sort_keys=True)[:400] if r.document else 'no document')"
```

`ReplayResult.document` is the recomputed snapshot, returned so you can **diff it
against the stored one** rather than only being told they differ. Pass the raw
gzipped bytes — `replay` decompresses them itself.

**`ImportError` on a metrics client.** The three-package Azure Monitor pin is wrong. All of
`azure-monitor-querymetrics` (batch metric values), `azure-mgmt-monitor` (metric
definitions and the per-resource fallback) and `azure-monitor-query` (logs, enhanced tier
only) must be installed. `azure-monitor-query` >=2 exports neither `MetricsClient` nor
`MetricsQueryClient`, so an import of either from that package is the usual cause; see the
comment beside the pins in `pyproject.toml` for which class comes from which package, and
run `pytest tests/test_dependency_pins.py` to confirm the split.

## Layout

```
agent/
  pyproject.toml        pins, including all three Azure Monitor packages
  requirements.lock     the fully pinned, hashed closure installed into the image
  requirements-dev.lock the dev closure — pytest, hypothesis, ruff; never in the image
                        (compiled first; requirements.lock is resolved against it)
  .python-version       3.12
  src/reporting_agent/
    main.py             the entrypoint and command router
    report_pipeline.py  collect -> compile -> render -> verify, in order
    catalog/            the declarative metric catalog and its loader
    providers/          the provider protocol and the id -> factory registry
    azure/              the ONLY package that may import an Azure SDK
    collect/            accumulate · sketch · bucket · archive · snapshot · log
    compile/            definition + snapshot -> typed document AST
    render/             python-docx against a styles-only theme, then PDF
    verify/             the gates: anchors · masking · charts · replay · pdf · coverage
    compare/            two snapshots -> a delta, as a pure function
    narrate/            the only package that may reach Bedrock. Prose only.
    storage/            the ObjectStore protocol and its boto3 implementation
  themes/               editorial · corporate · technical · minimal — STYLES, no content
  tests/
    conftest.py         the hypothesis profile
    test_lock_consistency.py  one version per package across both locks
    fixtures/definitions/     the shared corpus — read by the web suite too
    fakes/              the Azure ports and ObjectStore, faked
    property/           the hypothesis properties
```

`agent.py` and `tools/` do not exist on purpose. **There is no Strands agent and no
tool registry.** Every command is deterministic, so a payload without a recognised
`command` is a terminal error rather than something to route to a model. The only
model calls in the whole runtime are two single-shot Bedrock Converse calls inside
`narrate/`, and neither of them may return a number.

### Module boundaries that are enforced, not conventions

- **`azure/` is the only package that may import an Azure SDK.** A static test fails
  the build otherwise.
- **`verify/replay.py` may import only pure modules.** If replay can reach the
  network it is no longer proving determinism — it is re-collecting. The import
  closure is walked by a test, transitively.
- **`narrate/` is the only package that may reach Bedrock.** Same enforcement.
- The **figure ledger and the render context are the same object**, so they cannot
  disagree about what was rendered.
