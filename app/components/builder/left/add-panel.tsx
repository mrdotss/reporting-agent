"use client"

import { MagnifyingGlassIcon, TextTIcon } from "@phosphor-icons/react"
import { useMemo, useState } from "react"

import { useBuilder, useEnvironment } from "@/components/builder/context"
import {
  GROUP_ORDER,
  catalogueFor,
  sectionTitle,
  type CatalogueSection,
} from "@/lib/builder/catalogue"
import { offerable, missingInputs } from "@/lib/profiles/offerability"
import { cn } from "@/lib/utils"

/**
 * What can be put on the page: blocks into the selected section, and sections from the
 * provider's catalogue.
 *
 * Text is the block an author adds in this release. The catalogue's own blocks are already
 * on the page in every section — hidden ones come back from the outline — so the library
 * offers what is not there yet.
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
  const addText = useBuilder((state) => state.addText)
  const setLeftTab = useBuilder((state) => state.setLeftTab)
  const { scanTypeCounts, collectedFactSources } = useEnvironment()
  const [query, setQuery] = useState("")
  const language = definition.identity.language
  const sources = useMemo(() => new Set(collectedFactSources), [collectedFactSources])

  const targetSectionId = selection !== null && "sectionId" in selection ? selection.sectionId : null
  const targetSection = definition.sections.find((section) => section.id === targetSectionId)
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
        <p className="text-xs text-muted-foreground">
          {targetSection ? (
            <>Adds to the selected section, after the selected block.</>
          ) : (
            <>Select a section or block on the page first.</>
          )}
        </p>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            disabled={!targetSection || !(folded === "" || "text paragraph note".includes(folded))}
            onClick={() => {
              if (!targetSectionId) return
              addText(targetSectionId, selection?.kind === "block" ? selection.ref : undefined)
              setLeftTab("outline")
            }}
            className="flex flex-col items-start gap-2 rounded-lg border border-border bg-card p-2.5 text-left text-[12.5px] font-medium hover:border-input disabled:opacity-50"
          >
            <span className="grid h-8 w-full place-items-center rounded bg-muted text-muted-foreground">
              <TextTIcon aria-hidden className="size-4" />
            </span>
            Text
            <span className="text-[11px] font-normal text-muted-foreground">Words only, en and id</span>
          </button>
        </div>
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
