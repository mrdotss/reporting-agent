"use client"

import { BlockComposer } from "@/components/templates/block-composer"
import type { TemplateDefinition } from "@/lib/templates/definition"

/**
 * Step 5 — block composition (Requirements 11.1, 12).
 *
 * A thin frame around {@link BlockComposer}, which owns the three panes and
 * every action. This step's own contribution is the sentence below the
 * composer, and it is there for one reason: a definition with zero blocks is a
 * **valid draft** (Requirement 11.4) and an **invalid version** (Requirement
 * 11.10), and a consultant looking at an empty canvas has no way to know which
 * of those they are in.
 *
 * Neither judgement is made here — `lib/templates/wizard.ts` makes both — so an
 * empty document is described rather than styled as an error.
 */
export function StepBlocks({
  definition,
  onChange,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
}>) {
  return (
    <div className="flex flex-col gap-3">
      <BlockComposer definition={definition} onChange={onChange} />

      <p className="max-w-prose text-xs text-muted-foreground">
        {definition.blocks.length === 0
          ? "This document is empty. A draft may be saved empty; a version may not — a report needs at least one block."
          : `${definition.blocks.length} top-level block${definition.blocks.length === 1 ? "" : "s"}.`}
      </p>
    </div>
  )
}
