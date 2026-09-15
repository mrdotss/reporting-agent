import "server-only"

import {
  BedrockRuntimeClient,
  ConverseCommand,
} from "@aws-sdk/client-bedrock-runtime"

import { CHAT_TITLE_MAX } from "@/lib/chat/views"
import { requireEnv } from "@/lib/env"

/**
 * A conversation's title, written once after its first answer (tech.md: "titles come from
 * a direct Bedrock Converse call").
 *
 * A title is decoration. Any failure — throttling, an unset model, a blank answer — falls
 * back to the question itself, trimmed; nothing here can fail a turn. The output is
 * stripped to one plain line and rendered as text, never as markup.
 */

const TITLE_SYSTEM_PROMPT =
  "Write a short title, at most six words, for a conversation that starts with the " +
  "question below about cloud infrastructure usage reports. Use the question's language. " +
  "Return only the title: no quotes, no trailing punctuation."

const cache = globalThis as typeof globalThis & {
  __rptTitleClient?: BedrockRuntimeClient
  __rptTitleRegion?: string
}

function client(): BedrockRuntimeClient {
  const region = requireEnv("AWS_REGION")
  if (cache.__rptTitleClient !== undefined && cache.__rptTitleRegion === region) {
    return cache.__rptTitleClient
  }
  cache.__rptTitleClient = new BedrockRuntimeClient({ region })
  cache.__rptTitleRegion = region
  return cache.__rptTitleClient
}

export function fallbackTitle(prompt: string): string {
  const line = prompt.replace(/\s+/g, " ").trim()
  if (line.length <= 60) return line
  return `${line.slice(0, 57).trimEnd()}…`
}

export function cleanTitle(raw: string): string {
  return raw
    .replace(/[\r\n<>⟦⟧"“”]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.。!?]+$/, "")
    .slice(0, CHAT_TITLE_MAX)
}

export async function generateTitle(prompt: string): Promise<string> {
  try {
    const response = await client().send(
      new ConverseCommand({
        modelId: requireEnv("RPT_TITLE_MODEL_ID"),
        system: [{ text: TITLE_SYSTEM_PROMPT }],
        messages: [{ role: "user", content: [{ text: prompt.slice(0, 600) }] }],
        inferenceConfig: { maxTokens: 24, temperature: 0.2 },
      })
    )
    const text = (response.output?.message?.content ?? [])
      .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
      .join("")
    const title = cleanTitle(text)
    return title.length > 0 ? title : fallbackTitle(prompt)
  } catch {
    return fallbackTitle(prompt)
  }
}
