import "server-only"

import {
  applyAsk,
  askBlock,
  askChanges,
  cleanAsk,
  type AskBlock,
  type AskChange,
  type AskField,
  type AskValues,
} from "@/components/builder/ask"
import { builderIssues } from "@/lib/builder/issues"
import type { DefinitionV4 } from "@/lib/builder/model"
import type { BlockRef } from "@/lib/builder/store"
import { converse } from "@/lib/presets/converse"
import { parseModelJson } from "@/lib/presets/outline"
import { METRIC_CATALOG } from "@/lib/templates/catalog"

/**
 * Ask on a block: one model call that turns a wish ("make it taller, top 5 only") into
 * settings the block already has.
 *
 * The model sees the block's fields, their allowed values and what they are now — the
 * block's settings, never a customer's figures — and answers with the fields to set. The
 * answer is cleaned against those fields (`cleanAsk`), then each change is tried on the
 * draft alone and dropped, with the validator's reason, if it adds an issue the draft did
 * not have. What comes back is a before and after; nothing is saved until the person
 * applies it in the builder.
 */

export type AskAnswer = {
  readonly set: AskValues
  readonly changes: readonly AskChange[]
  readonly summary: string
  readonly notApplied: readonly string[]
}

export class AskUnavailableError extends Error {
  constructor() {
    super("Ask could not answer just now. Nothing was changed.")
    this.name = "AskUnavailableError"
  }
}

export class AskBlockGoneError extends Error {
  constructor() {
    super("That block is no longer in the draft.")
    this.name = "AskBlockGoneError"
  }
}

function describeField(field: AskField): Record<string, unknown> {
  const base = { key: field.key, label: field.label }
  switch (field.type) {
    case "choice":
      return { ...base, values: field.options.map((option) => option.value), ...(field.clearable ? { null_means: field.clearable } : {}) }
    case "number":
      return { ...base, integer_from: field.min, to: field.max, ...(field.unit ? { unit: field.unit } : {}), ...(field.clearable ? { null_means: field.clearable } : {}) }
    case "text":
      return { ...base, text_max_characters: field.max }
    case "columns":
      return { ...base, ordered_list_of: field.options.map((option) => `${option.value} (${option.label})`) }
    case "flag":
      return { ...base, boolean: true }
  }
}

function systemPrompt(block: AskBlock): string {
  return [
    `You change the settings of one block in a ${block.cloud} cloud usage report preset.`,
    `The block is "${block.block}" in the section "${block.section}".`,
    "You may set ONLY these fields, each only to a value it allows:",
    JSON.stringify(block.fields.map(describeField)),
    "",
    "Their values now:",
    JSON.stringify(block.values),
    "",
    "Set only what the request asks to change. Leave every other field out.",
    "A field that allows null may be set to null to go back to what null_means.",
    "Words you write in a text field contain no digits: a report's numbers come from its data.",
    `Anything asked that no field can do, including what ${block.cloud} data or this block ` +
      "cannot show, goes in not_applied as a short sentence.",
    "Write summary and not_applied in the language of the request.",
    "",
    "Answer with one JSON object and nothing else:",
    '{"set": {"<key>": <value>}, "summary": "one sentence on what changes", "not_applied": ["short note"]}',
  ].join("\n")
}

function key(issue: { readonly path: readonly (string | number)[]; readonly message: string }): string {
  return `${issue.path.join(".")}|${issue.message}`
}

function strings(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "").slice(0, limit).map((item) => item.trim().slice(0, 300))
}

/**
 * Ask the model to change one block, and keep only what the draft can take.
 *
 * @throws AskBlockGoneError when the block is not in `definition`.
 * @throws AskUnavailableError when the model could not be reached or gave no answer.
 */
export async function askOnBlock(
  definition: DefinitionV4,
  sectionId: string,
  ref: BlockRef,
  request: string
): Promise<AskAnswer> {
  const block = askBlock(definition, sectionId, ref)
  if (block === null) throw new AskBlockGoneError()

  let raw: unknown = null
  try {
    raw = parseModelJson(await converse(systemPrompt(block), `Request:\n${request}`, 900))
  } catch (thrown) {
    console.error(`[presets/ask-block] model call failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`)
  }
  if (raw === null || typeof raw !== "object") throw new AskUnavailableError()
  const answer = raw as Record<string, unknown>

  const { set, dropped } = cleanAsk(block, answer.set)
  const notApplied = strings(answer.not_applied, 6)
  if (dropped.length > 0) notApplied.push("Some of the answer used settings this block does not have, so they were left out.")

  // Each change on its own first: one that brings a new issue is dropped with that issue's
  // words, so a bad title does not take a good height down with it.
  const before = new Set(builderIssues(definition).map(key))
  const kept: Record<string, AskValues[string]> = {}
  for (const [field, value] of Object.entries(set)) {
    const fresh = builderIssues(applyAsk(definition, METRIC_CATALOG, sectionId, ref, { [field]: value })).filter((issue) => !before.has(key(issue)))
    if (fresh.length === 0) kept[field] = value
    else notApplied.push(`${block.fields.find((candidate) => candidate.key === field)?.label ?? field}: ${fresh[0]!.message}`)
  }
  // And together, in case two that pass alone fail as a pair.
  const together = builderIssues(applyAsk(definition, METRIC_CATALOG, sectionId, ref, kept)).filter((issue) => !before.has(key(issue)))
  if (together.length > 0) {
    return { set: {}, changes: [], summary: "", notApplied: [...notApplied, together[0]!.message] }
  }

  return {
    set: kept,
    changes: askChanges(block, kept),
    summary: typeof answer.summary === "string" ? answer.summary.trim().slice(0, 300) : "",
    notApplied,
  }
}
