"use client"

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { CHAT_MODELS, isChatModelId, type ChatModelId } from "@/lib/chat/models"

/**
 * Which model answers the next question.
 *
 * The trigger carries the short name only — it sits inside the composer's own border, where
 * a full label and its description would not fit — and the list opens upward with the
 * descriptions, away from the window's bottom edge.
 */
export function ModelPicker({
  value,
  onChange,
  disabled = false,
}: Readonly<{
  value: ChatModelId
  onChange: (value: ChatModelId) => void
  disabled?: boolean
}>) {
  return (
    <Select
      value={value}
      onValueChange={(next) => isChatModelId(next) && onChange(next)}
      disabled={disabled}
    >
      <SelectTrigger
        size="sm"
        aria-label="Model for the next answer"
        className="h-7 gap-1 border-transparent bg-transparent px-2 text-meta text-muted-foreground hover:bg-muted data-popup-open:bg-muted"
      >
        <SelectValue>
          {(current) => CHAT_MODELS.find((model) => model.id === current)?.short ?? ""}
        </SelectValue>
      </SelectTrigger>
      <SelectContent side="top" align="end" sideOffset={6} className="w-auto min-w-60">
        {CHAT_MODELS.map((model) => (
          <SelectItem key={model.id} value={model.id}>
            <span className="flex flex-col gap-0.5">
              <span>{model.label}</span>
              <span className="text-xs font-normal text-muted-foreground">{model.detail}</span>
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
