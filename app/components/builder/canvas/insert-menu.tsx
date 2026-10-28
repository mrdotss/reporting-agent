"use client"

import { PlusIcon } from "@phosphor-icons/react"
import { useState } from "react"

import { ADDED_BLOCKS } from "@/components/builder/canvas/labels"
import { useBuilder } from "@/components/builder/context"
import { BlockDrawing } from "@/components/builder/left/block-drawing"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { sectionEntry, sectionTitle } from "@/lib/builder/catalogue"
import { BLOCK_INTENTS, blockFit } from "@/lib/builder/fit"
import type { AddedKind, SectionV4 } from "@/lib/builder/model"
import { blockKey, type BlockRef } from "@/lib/builder/store"
import { cn } from "@/lib/utils"

/**
 * The + between two blocks on the page, and the menu it opens: every block, grouped as in
 * the Add panel, put straight after the block above.
 *
 * The same menu opens with / on a selected block. A block that does not fit the section is
 * listed with its reason rather than left out.
 */

export function InsertBetween({
  section,
  after,
}: Readonly<{ section: SectionV4; after: BlockRef }>) {
  const insertAt = useBuilder((state) => state.insertAt)
  const openInsert = useBuilder((state) => state.openInsert)
  const open =
    insertAt !== null && insertAt.sectionId === section.id && blockKey(insertAt.after) === blockKey(after)

  return (
    <div
      className={cn(
        "absolute inset-x-0 -bottom-[11px] z-[4] flex h-3.5 items-center gap-2 transition-opacity focus-within:pointer-events-auto focus-within:opacity-100",
        open
          ? "pointer-events-auto opacity-100"
          : "pointer-events-none opacity-0 group-hover/block:pointer-events-auto group-hover/block:opacity-100"
      )}
    >
      <span className="h-px flex-1 bg-primary/35" />
      <Popover open={open} onOpenChange={(next) => openInsert(next ? { sectionId: section.id, after } : null)}>
        <PopoverTrigger
          aria-label="Add a block here"
          onClick={(event) => event.stopPropagation()}
          className="inline-flex h-5 items-center gap-1 rounded-full border border-primary/40 bg-white px-2 font-sans text-[11px] font-semibold text-primary"
        >
          <PlusIcon aria-hidden className="size-3" />
          Add block
        </PopoverTrigger>
        <PopoverContent align="center" className="w-72 gap-2 p-2 font-sans">
          {open && <BlockMenu section={section} after={after} onDone={() => openInsert(null)} />}
        </PopoverContent>
      </Popover>
      <span className="h-px flex-1 bg-primary/35" />
    </div>
  )
}

function BlockMenu({
  section,
  after,
  onDone,
}: Readonly<{ section: SectionV4; after: BlockRef; onDone: () => void }>) {
  const definition = useBuilder((state) => state.definition)
  const addBlock = useBuilder((state) => state.addBlock)
  const select = useBuilder((state) => state.select)
  const [query, setQuery] = useState("")
  const folded = query.trim().toLowerCase()

  const groups = BLOCK_INTENTS.map((intent) => ({
    label: intent.label,
    kinds: intent.kinds.filter(
      (kind) =>
        folded === "" ||
        intent.label.toLowerCase().includes(folded) ||
        ADDED_BLOCKS[kind].label.toLowerCase().includes(folded) ||
        ADDED_BLOCKS[kind].hint.toLowerCase().includes(folded)
    ),
  })).filter((group) => group.kinds.length > 0)

  const add = (kind: AddedKind) => {
    const id = addBlock(section.id, kind, after)
    onDone()
    if (id !== null) select({ kind: "block", sectionId: section.id, ref: { kind: "added", id } })
  }

  const into = sectionTitle(sectionEntry(definition.provider, section.type), definition.identity.language)

  return (
    <div className="flex flex-col gap-1.5">
      <label className="flex h-8 items-center gap-1.5 border-b border-border px-1.5">
        <span aria-hidden className="font-mono text-[13px] text-primary">
          /
        </span>
        <input
          type="search"
          autoFocus
          aria-label={`Find a block to add into ${into}`}
          placeholder="Find a block"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.preventDefault()
          const first = groups.flatMap((group) => group.kinds).find((kind) => blockFit(definition, section, kind).ok)
          if (first !== undefined) add(first)
        }}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none"
        />
        <span className="max-w-[45%] shrink-0 truncate text-[11px] text-muted-foreground">into {into}</span>
      </label>
      <div className="flex max-h-80 flex-col overflow-auto">
        {groups.length === 0 && <p className="p-2 text-[13px] text-muted-foreground">No block matches.</p>}
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col">
            <span className="px-2 pt-2 pb-0.5 text-[10.5px] font-semibold tracking-[0.06em] text-muted-foreground uppercase">
              {group.label}
            </span>
            {group.kinds.map((kind) => {
              const fit = blockFit(definition, section, kind)
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={!fit.ok}
                  title={fit.ok ? undefined : fit.reason}
                  onClick={() => add(kind)}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <span className="w-11 shrink-0 overflow-hidden rounded-md border border-border">
                    <BlockDrawing kind={kind} muted={!fit.ok} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className={cn("text-[13px] font-semibold", !fit.ok && "text-muted-foreground")}>
                      {ADDED_BLOCKS[kind].label}
                    </span>
                    <span className="text-[11px] leading-snug text-muted-foreground">
                      {fit.ok ? ADDED_BLOCKS[kind].hint : fit.short}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
