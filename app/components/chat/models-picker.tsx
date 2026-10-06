"use client"

import { Radio } from "@base-ui/react/radio"
import { RadioGroup } from "@base-ui/react/radio-group"

import { CHAT_MODELS, isChatModelId, type ChatModelId } from "@/lib/chat/models"

/**
 * Which model answers the next question.
 *
 * Two choices that differ in one way a person understands — careful or fast — so both are
 * on screen as a segmented control rather than behind a menu. The full description is the
 * tooltip. It is the same radio group a form would use, so the arrow keys move between them.
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
    <RadioGroup
      value={value}
      onValueChange={(next) => isChatModelId(next) && onChange(next)}
      disabled={disabled}
      aria-label="Model for the next answer"
      className="inline-flex gap-0.5 rounded-lg bg-muted p-0.5"
    >
      {CHAT_MODELS.map((model) => (
        <Radio.Root
          key={model.id}
          value={model.id}
          title={model.detail}
          className="inline-flex h-7 cursor-pointer items-center gap-1 rounded-md px-2.5 text-meta whitespace-nowrap text-muted-foreground transition-[color,background-color,box-shadow] outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30 data-checked:bg-card data-checked:font-medium data-checked:text-foreground data-checked:ring-1 data-checked:ring-border data-disabled:cursor-not-allowed data-disabled:opacity-60"
        >
          {model.short}
          <span aria-hidden="true">·</span>
          {model.trait}
        </Radio.Root>
      ))}
    </RadioGroup>
  )
}
