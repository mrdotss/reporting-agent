import "server-only"

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime"

import { requireEnv } from "@/lib/env"
import {
  catalogueBrief,
  currentOutline,
  parseModelJson,
  starterOutline,
  themeBrief,
  validateOutline,
  type DescribeInput,
  type Outline,
} from "@/lib/presets/outline"

/**
 * Describe it's drafting call: one direct Bedrock Converse call from the app, as titles
 * are (`lib/chat/title.ts`), not a turn on the agent runtime. The call reads no customer
 * data — only the description and the section catalogue — so it needs none of the
 * runtime's credentials or verification, and adding it costs no runtime release.
 *
 * The model is `RPT_PRESET_MODEL_ID` when set, otherwise the title model.
 *
 * What comes back is checked by `validateOutline` before anyone sees it. A first draft
 * the model cannot produce falls back to the starter the description names, and says
 * so; a refine has no such fallback, so it fails and the outline on screen stays.
 */

const cache = globalThis as typeof globalThis & {
  __rptPresetClient?: BedrockRuntimeClient
  __rptPresetRegion?: string
}

function client(): BedrockRuntimeClient {
  const region = requireEnv("AWS_REGION")
  if (cache.__rptPresetClient !== undefined && cache.__rptPresetRegion === region) {
    return cache.__rptPresetClient
  }
  cache.__rptPresetClient = new BedrockRuntimeClient({ region })
  cache.__rptPresetRegion = region
  return cache.__rptPresetClient
}

function modelId(): string {
  const preset = process.env.RPT_PRESET_MODEL_ID?.trim()
  return preset ? preset : requireEnv("RPT_TITLE_MODEL_ID")
}

const LENGTH_GUIDE: Readonly<Record<DescribeInput["length"], string>> = {
  short: "3 to 5 sections, a brief a reader finishes in a few minutes",
  standard: "5 to 8 sections",
  detailed: "8 to 12 sections, a full review",
}

function systemPrompt(input: DescribeInput): string {
  const cloud = input.provider === "aws" ? "AWS" : "Microsoft Azure"
  return [
    `You draft the outline of a monthly cloud usage report preset for ${cloud}.`,
    "Choose sections ONLY from this catalogue, by key. Never invent a section. A " +
      "verification appendix is always added after them; do not list it.",
    catalogueBrief(input.provider),
    "",
    "Themes (the document's look):",
    themeBrief(),
    "",
    `Audience: ${input.audience}. Length: ${LENGTH_GUIDE[input.length]}.`,
    "Period is last_full_month (a calendar month) or last_30d (a rolling 30 days).",
    "contents is whether the document has a contents page; false suits a short brief.",
    "language is the document's language: id (Indonesian) when the description asks for " +
      "Indonesian or is written in Indonesian, otherwise en.",
    "Anything asked for that no section, theme or period can express (a tone of voice, " +
      "hiding identifiers, a language, a delivery schedule, a section that does not exist) " +
      "goes in not_applied as a short sentence, so the person knows it was not applied. " +
      "List only what the description actually asks for; an empty list is normal.",
    "In every text you write, name sections by their title, never by their key.",
    "Write name, summary, why, understood, not_applied and change_note in the language " +
      "of the description.",
    "",
    "Answer with one JSON object and nothing else:",
    '{"name": "...", "summary": "one sentence", "audience": "executive|technical|mixed", ' +
      '"theme": "<theme>", "period": "last_full_month|last_30d", "contents": true, "language": "en|id", ' +
      '"sections": [{"key": "<catalogue key>", "why": "one short line", "lookback": 6}], ' +
      '"understood": ["short note"], "not_applied": ["short note"], "change_note": "..."}',
    "lookback is only for sections that need it. change_note only when refining.",
  ].join("\n")
}

function userPrompt(input: DescribeInput, current: Outline | null): string {
  const description = `Description:\n${input.description}`
  if (current === null || input.instruction === undefined) return description
  const outline = {
    name: current.name,
    summary: current.summary,
    audience: current.audience,
    theme: current.theme,
    period: current.period,
    contents: current.contents,
    language: current.language,
    sections: current.sections.filter((section) => section.key !== "coverage_and_verification").map((section) => ({
      key: section.key,
      why: section.why,
      ...(section.lookback ? { lookback: section.lookback } : {}),
    })),
  }
  return [
    description,
    "",
    `Current outline:\n${JSON.stringify(outline)}`,
    "",
    `Change it as follows, keep everything else, and say what changed in change_note:\n${input.instruction}`,
  ].join("\n")
}

export class DescribeUnavailableError extends Error {
  constructor() {
    super("The outline could not be changed just now. The current outline is kept.")
    this.name = "DescribeUnavailableError"
  }
}

async function ask(input: DescribeInput, current: Outline | null): Promise<Outline | null> {
  const response = await client().send(
    new ConverseCommand({
      modelId: modelId(),
      system: [{ text: systemPrompt(input) }],
      messages: [{ role: "user", content: [{ text: userPrompt(input, current) }] }],
      inferenceConfig: { maxTokens: 1600, temperature: 0.2 },
    })
  )
  const text = (response.output?.message?.content ?? [])
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("")
  return validateOutline(parseModelJson(text), input)
}

/**
 * Draft an outline, or refine the one on screen.
 *
 * @throws DescribeUnavailableError when a refine could not be made.
 */
export async function describePreset(input: DescribeInput): Promise<Outline> {
  const current = input.instruction === undefined ? null : currentOutline(input.current, input)
  const refining = current !== null
  let drafted: Outline | null = null
  try {
    drafted = await ask(input, current)
  } catch (thrown) {
    console.error(
      `[presets/describe] model call failed: ` +
        `${thrown instanceof Error ? thrown.name : typeof thrown}`
    )
  }
  if (drafted !== null) return drafted
  if (refining) throw new DescribeUnavailableError()
  return starterOutline(input)
}
