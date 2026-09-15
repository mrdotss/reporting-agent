# Requirements — Ask (chat over verified usage)

## Introduction

The Ask page lets a workspace member attach verified reports and connector scans and ask
questions about usage, pricing and cost. It is backed by the existing AgentCore runtime
through a new `chat` command.

This spec **amends** the foundation spec's routing criteria (Req 14.2, 14.13) and the
narrator boundary (Req 19.2, 19.7), which were written when no model-facing command existed.
The amendment is narrow: every report command stays deterministic, and chat is bounded
structurally — no tools, no writes, a required guardrail, and an output filter that decides
every figure.

## Glossary

- **Fact** — a label and the exact string an artifact already holds: a ledger figure of a
  verified report, a count from a saved scan, or an Azure list price.
- **Grounding** — the facts, attachments and request targets one turn shows the model.
- **Request target** — a customer and connector pair a report may be proposed for, offered
  by the app under an opaque id.

## Requirement 1 — One model-facing command

1. THE Agent_Runtime SHALL accept a `chat` command, and `chat` SHALL be the only command whose
   handler reads `prompt` or reaches a model.
2. THE Agent_Runtime SHALL continue to ignore `prompt` on every other command, and SHALL
   continue to refuse a payload with no `command` without reaching a model.
3. THE `chat` command SHALL parse a closed payload — prompt (≤ 4000 characters), history
   (≤ 12 turns), attached runs (≤ 6), attached scans (≤ 4), request targets (≤ 50) — and
   IF the payload deviates, THEN it SHALL emit one terminal `error` and `done`.
4. THE `chat` command SHALL write no artifact and emit no `verification`, `report_file`,
   `chart` or `snapshot_ready` event. Its result SHALL ride on `delta` and on `done`.
5. THE `chat` invocation context SHALL carry no credential.

## Requirement 2 — Grounding is read from verified artifacts

1. THE runtime SHALL read an attached report's figures only when its verification record
   has status `pass` AND the SHA-256 of the stored ledger bytes equals that record's
   `ledger_sha256`; otherwise the report SHALL contribute no fact and SHALL be named in
   `done.unavailable_runs`.
2. THE app SHALL attach only runs in the asking user's workspace whose latest verification
   passed, and SHALL re-check both when each message is sent.
3. Live connector data SHALL be the connector's latest saved scan, projected by the app.

## Requirement 3 — Every figure in an answer is a fact or an estimate

1. THE runtime SHALL replace each fact reference the model writes with that fact's exact
   string, marked as a figure, and SHALL drop a reference to an id the turn did not issue.
2. THE runtime SHALL withhold, outside a marked estimate, every numeral the model typed that
   is not a fact string, an identifier, a date or a count of at most 31.
3. Computed values SHALL appear only inside a marked estimate, which the UI SHALL render as
   reasoning, never as a figure.
4. THE runtime SHALL strip marker characters from model output before rewriting, so neither
   the model nor grounding text can forge a figure.
5. `done.citations` SHALL name, for each fact used, its source and its snapshot path, scan
   id, or SKU and region.

## Requirement 4 — Pricing

1. List prices SHALL come from the public Azure Retail Prices API, looked up before the model
   call, only for VM sizes and regions named in an attached verified snapshot.
2. A SKU or region that is not a safe token SHALL NOT be queried.
3. Prices SHALL be labelled list-price estimates in USD, never the customer's bill; a failed
   lookup SHALL NOT fail the turn.

## Requirement 5 — Scope and prompt-injection defences

1. THE model call SHALL carry no tool configuration.
2. Grounding SHALL be fenced in an element whose tags carry a per-turn random nonce, with
   angle brackets, marker characters and line breaks removed from every value.
3. THE model call SHALL run through a Bedrock guardrail (prompt-attack filter) applied to the
   user's latest message only, and IF no guardrail is
   configured, THEN the `chat` command SHALL fail closed.
4. A guardrail intervention SHALL be replaced by the runtime's own refusal sentence, in
   Indonesian when the question is Indonesian and English otherwise.
5. Answers SHALL be in Indonesian when the user writes Indonesian, and English otherwise.

## Requirement 6 — Report requests are proposals

1. THE model MAY propose one report for a request target the app offered; any other proposal
   SHALL be discarded.
2. A proposal SHALL enqueue nothing. The user SHALL confirm it by choosing a preset, and the
   app SHALL enqueue through the existing run path with its permission, connector and
   provider checks.

## Requirement 8 — Live metrics

1. THE runtime SHALL accept a deterministic `list_resources` command that returns, on
   `done`, each machine a connector can see — resource id, name, type, region, resource
   group, size and power state — at most 500, with a flag when that bound truncated it.
2. THE collection scope SHALL accept an optional `resource_ids` list, applied beside the
   resource-group and tag filters; a snapshot SHALL record it only when requested, so every
   snapshot without one is byte-identical to before.
3. A live metrics pull SHALL collect picked machines (at most 20) over whole local days in
   Asia/Jakarta, ending no later than today and starting within Azure Monitor's 93-day
   retention, as a collection-only `generate_report`: a snapshot, no document, no
   verification.
4. THE app SHALL check every picked id against the connector's own listing, and SHALL
   require edit access to create a pull, the same bar as requesting a report.
5. A chat SHALL cite a pull's statistics as facts whose source is `live`, formatted by the
   report formatter, rendered as grey "Live" chips, and described to the model as not
   verified. The chat call SHALL still carry no credential and no tool list.

## Requirement 7 — History

1. Conversations SHALL be stored in DynamoDB (`rpt-chat-history`) and visible to every member
   of the workspace they belong to, and to no one else.
2. Conversations SHALL NOT be exportable.
3. One AgentCore runtime session id SHALL be reused for every turn of a conversation.
