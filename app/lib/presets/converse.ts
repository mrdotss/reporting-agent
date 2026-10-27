import "server-only"

import { BedrockRuntimeClient, ConverseCommand } from "@aws-sdk/client-bedrock-runtime"

import { requireEnv } from "@/lib/env"

/**
 * The preset helpers' one model call: a direct Bedrock Converse from the app, for Describe
 * it and Ask on a block. Neither reads customer data, so neither goes through the runtime.
 *
 * The model is `RPT_PRESET_MODEL_ID` when set, otherwise the title model.
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

/** One system and one user message; the reply's text. Throws what the client throws. */
export async function converse(system: string, user: string, maxTokens: number): Promise<string> {
  const response = await client().send(
    new ConverseCommand({
      modelId: modelId(),
      system: [{ text: system }],
      messages: [{ role: "user", content: [{ text: user }] }],
      inferenceConfig: { maxTokens, temperature: 0.2 },
    })
  )
  return (response.output?.message?.content ?? [])
    .map((block) => ("text" in block && typeof block.text === "string" ? block.text : ""))
    .join("")
}
