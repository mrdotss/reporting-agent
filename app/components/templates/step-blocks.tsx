"use client"

import { BlockCanvas } from "@/components/templates/block-canvas"
import type { TemplateDefinition } from "@/lib/templates/definition"

/**
 * Step 5 — block composition (Requirement 11.1).
 *
 * A thin frame around the composer. The three-pane builder Requirement 12
 * specifies — palette, canvas, inspector, with the keyboard as the primary
 * reorder path — is task 13.3's, and this step is where it mounts. Until then
 * this renders the existing `block-canvas` in read-only form so step 5 exists,
 * carries the definition's current blocks, and is navigable, rather than being a
 * gap in a seven-step sequence Requirement 11.1 says has seven steps.
 *
 * What it must already be right about is the **draft rule**: a definition with
 * zero blocks is a valid draft (Requirement 11.4) and an invalid completion
 * (Requirement 11.10). Neither judgement is made here — `lib/templates/wizard.ts`
 * makes both — so this step shows the count and says what it means without
 * styling an empty document as an error.
 */
export function StepBlocks({
  definition,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
}>) {
  return (
    <div className="flex flex-col gap-3">
      <BlockCanvas blocks={definition.blocks} />

      <p className="max-w-prose text-xs text-muted-foreground">
        {definition.blocks.length === 0
          ? "This document is empty. A draft may be saved empty; a version may not — a report needs at least one block."
          : `${definition.blocks.length} block${definition.blocks.length === 1 ? "" : "s"}, in the order the document emits them.`}
      </p>
    </div>
  )
}
