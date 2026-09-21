/**
 * The models a person can pick to answer an Ask question.
 *
 * The ids are names, not Bedrock model ids: the runtime maps each one through its own
 * allow-list (`CHAT_MODEL_CHOICES` in `agent/src/reporting_agent/narrate/chat.py`), so the
 * browser can only ever choose between these. Keep the two lists the same.
 */

export const CHAT_MODELS = [
  {
    id: "kimi-k3",
    label: "Kimi K3",
    short: "K3",
    detail: "Thinks it through first. Most careful.",
  },
  {
    id: "kimi-k2.5",
    label: "Kimi K2.5",
    short: "K2.5",
    detail: "Answers straight away. Fastest.",
  },
] as const

export type ChatModelId = (typeof CHAT_MODELS)[number]["id"]

export const CHAT_MODEL_IDS = CHAT_MODELS.map((model) => model.id) as [ChatModelId, ...ChatModelId[]]

export const DEFAULT_CHAT_MODEL: ChatModelId = "kimi-k3"

export function isChatModelId(value: unknown): value is ChatModelId {
  return typeof value === "string" && (CHAT_MODEL_IDS as readonly string[]).includes(value)
}

export function chatModelLabel(id: string | undefined): string | undefined {
  return CHAT_MODELS.find((model) => model.id === id)?.label
}
