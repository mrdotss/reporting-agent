"use client"

import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"

import { ADDED_BLOCKS } from "@/components/builder/canvas/labels"
import { useBuilder, useEnvironment } from "@/components/builder/context"
import { BlockDrawing } from "@/components/builder/left/block-drawing"
import { BLOCK_INTENTS, blockFit } from "@/lib/builder/fit"
import { orderedSections } from "@/lib/builder/model"
import {
  GROUP_ORDER,
  catalogueFor,
  sectionEntry,
  sectionTitle,
  type CatalogueSection,
} from "@/lib/builder/catalogue"
import { offerable, missingInputs } from "@/lib/profiles/offerability"
import { cn } from "@/lib/utils"

/**
 * What can be put on the page: blocks into a section, and sections from the provider's
 * catalogue.
 *
 * Blocks are a gallery grouped by what the author wants the page to do (show a number,
 * rank, over time, compare, status, words, layout), each with a small drawing of its shape.
 * They go into the section chosen at the top, the selected one by default, after the
 * selected block. A block that does not fit that section stays in the gallery, greyed, with
 * the reason (`blockFit`). A section's own blocks are already on the page; hidden ones come
 * back from the outline.
 *
 * Only this provider's sections are listed: an AWS preset is offered Compute Optimizer's
 * rightsizing, an Azure one Advisor's recommendations, never the other's.
 */

const GROUP_LABELS: Readonly<Record<string, string>> = {
  summary: "Summary",
  inventory: "Inventory",
  utilisation: "Utilisation",
  closing: "Closing",
}

export function AddPanel() {
  const definition = useBuilder((state) => state.definition)
  const selection = useBuilder((state) => state.selection)
  const addSection = useBuilder((state) => state.addSection)
  const addBlock = useBuilder((state) => state.addBlock)
  const select = useBuilder((state) => state.select)
  const setLeftTab = useBuilder((state) => state.setLeftTab)
  const { scanTypeCounts, collectedFactSources } = useEnvironment()
  const [query, setQuery] = useState("")
  const language = definition.identity.language
  const sources = useMemo(() => new Set(collectedFactSources), [collectedFactSources])

  // The section a block goes into: the one picked here, else the one selected on the page,
  // else the first. Nothing has to be selected before a block can be added. A pick holds
  // until something else is selected on the page.
  const selectedSectionId = selection !== null && "sectionId" in selection ? selection.sectionId : null
  const [picked, setPicked] = useState<{ readonly id: string; readonly while: string | null } | null>(null)
  const chosen = picked !== null && picked.while === selectedSectionId ? picked.id : null
  const targetSection =
    definition.sections.find((section) => section.id === (chosen ?? selectedSectionId)) ??
    orderedSections(definition)[0]
  const targetSectionId = targetSection?.id ?? null
  const used = new Set(definition.sections.map((section) => section.type))

  const available = catalogueFor(definition.provider).filter(
    (entry) => entry.position !== "always" && (entry.repeatable || !used.has(entry.key))
  )
  const folded = query.trim().toLowerCase()
  const matches = (entry: CatalogueSection) =>
    folded === "" ||
    sectionTitle(entry, language).toLowerCase().includes(folded) ||
    entry.key.includes(folded)

  return (
    <div className="flex flex-col gap-4 pb-4">
      <label className="flex h-8 items-center gap-2 rounded-md border border-border bg-card px-2.5">
        <MagnifyingGlassIcon aria-hidden className="size-3.5 text-muted-foreground" />
        <input
          type="search"
          aria-label="Search blocks and sections"
          placeholder="Search blocks and sections"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
      </label>

      <div className="flex flex-col gap-2">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">Blocks</span>
        {definition.sections.length === 0 ? (
          <p className="text-xs text-muted-foreground">Add a section below first. Blocks go inside a section.</p>
        ) : (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">Adds into</span>
            <select
              aria-label="Section the block goes into"
              value={targetSection?.id ?? ""}
              onChange={(event) => setPicked({ id: event.target.value, while: selectedSectionId })}
              className="h-7 min-w-0 flex-1 rounded-md border border-border bg-card px-1.5 text-[12.5px] text-foreground"
            >
              {orderedSections(definition).map((section) => (
                <option key={section.id} value={section.id}>
                  {sectionTitle(sectionEntry(definition.provider, section.type), language)}
                </option>
              ))}
            </select>
          </label>
        )}
        {BLOCK_INTENTS.map((intent) => {
          const kinds = intent.kinds.filter(
            (kind) =>
              folded === "" ||
              intent.label.toLowerCase().includes(folded) ||
              ADDED_BLOCKS[kind].label.toLowerCase().includes(folded) ||
              ADDED_BLOCKS[kind].hint.toLowerCase().includes(folded) ||
              ADDED_BLOCKS[kind].blurb.toLowerCase().includes(folded)
          )
          if (kinds.length === 0) return null
          return (
            <div key={intent.label} className="flex flex-col gap-1.5">
              <span className="px-0.5 pt-1.5 text-[11px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
                {intent.label}
              </span>
              <div className="grid grid-cols-2 gap-2">
                {kinds.map((kind) => {
                  const fit = blockFit(definition, targetSection, kind)
                  return (
                    <button
                      key={kind}
                      type="button"
                      disabled={!fit.ok}
                      title={fit.ok ? undefined : fit.reason}
                      aria-describedby={fit.ok ? undefined : `fit-${kind}`}
                      onClick={() => {
                        if (!targetSection) return
                        const id = addBlock(
                          targetSection.id,
                          kind,
                          selection?.kind === "block" && selection.sectionId === targetSection.id ? selection.ref : undefined
                        )
                        if (id !== null) select({ kind: "block", sectionId: targetSection.id, ref: { kind: "added", id } })
                        setLeftTab("outline")
                      }}
                      className={cn(
                        "flex flex-col items-start gap-1.5 rounded-[10px] border border-border bg-card p-2 text-left hover:border-input",
                        !fit.ok && "cursor-not-allowed border-dashed bg-muted/40 text-muted-foreground hover:border-border"
                      )}
                    >
                      <BlockDrawing kind={kind} muted={!fit.ok} />
                      <span className="text-[13px] leading-tight font-semibold">{ADDED_BLOCKS[kind].label}</span>
                      {fit.ok ? (
                        <span className="text-[11px] leading-snug text-muted-foreground">{ADDED_BLOCKS[kind].hint}</span>
                      ) : (
                        <span id={`fit-${kind}`} className="text-[11px] leading-snug">
                          <span className="sr-only">{fit.reason}</span>
                          <span aria-hidden>{fit.short}</span>
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
          )
        })}
        <p className="text-[11px] leading-normal text-muted-foreground">
          Drawings are sample shapes, not your figures. A block that doesn&apos;t fit the chosen section stays
          here with the reason. On the page, use + between blocks, or press / with a block selected.
        </p>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Sections from the catalogue
        </span>
        {GROUP_ORDER.map((group) => {
          const entries = available.filter((entry) => entry.group === group && matches(entry))
          if (entries.length === 0) return null
          return (
            <div key={group} className="flex flex-col">
              <span className="px-1.5 pt-2 pb-0.5 text-[11px] text-muted-foreground">{GROUP_LABELS[group]}</span>
              {entries.map((entry) => {
                const missing = scanTypeCounts ? missingInputs(
                  { needs_resource_types: entry.needsResourceTypes, needs_fact_sources: entry.needsFactSources },
                  scanTypeCounts,
                  sources
                ) : []
                const ready = !scanTypeCounts || offerable(
                  { needs_resource_types: entry.needsResourceTypes, needs_fact_sources: entry.needsFactSources },
                  scanTypeCounts,
                  sources
                )
                return (
                  <button
                    key={entry.key}
                    type="button"
                    onClick={() => {
                      addSection(entry.key, targetSectionId ?? undefined)
                      setLeftTab("outline")
                    }}
                    title={ready ? undefined : `The connected account has none of: ${missing.join(", ")}`}
                    className={cn(
                      "flex min-h-[30px] items-center gap-2 rounded-md px-1.5 text-left text-[13px] hover:bg-muted",
                      !ready && "text-muted-foreground"
                    )}
                  >
                    <span className="truncate">{sectionTitle(entry, language)}</span>
                    {!ready && <span className="ml-auto shrink-0 text-[11px]">Nothing found yet</span>}
                  </button>
                )
              })}
            </div>
          )
        })}
      </div>
    </div>
  )
}
