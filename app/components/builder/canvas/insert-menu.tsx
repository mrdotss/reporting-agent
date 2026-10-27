"use client"

import { PlusIcon } from "@phosphor-icons/react"
import { useState } from "react"

import { ADDED_BLOCKS } from "@/components/builder/canvas/labels"
import { useBuilder } from "@/components/builder/context"
import { AddedIcon } from "@/components/builder/left/outline"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
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
        ADDED_BLOCKS[kind].label.toLowerCase().includes(folded)
    ),
  })).filter((group) => group.kinds.length > 0)

  const add = (kind: AddedKind) => {
    const id = addBlock(section.id, kind, after)
    onDone()
    if (id !== null) select({ kind: "block", sectionId: section.id, ref: { kind: "added", id } })
  }

  return (
    <div className="flex flex-col gap-1.5">
      <input
        type="search"
        autoFocus
        aria-label="Find a block"
        placeholder="Find a block"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          event.preventDefault()
          const first = groups.flatMap((group) => group.kinds).find((kind) => blockFit(definition, section, kind).ok)
          if (first !== undefined) add(first)
        }}
        className="h-8 rounded-md border border-border bg-card px-2.5 text-[13px] outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      />
      <div className="flex max-h-80 flex-col overflow-auto">
        {groups.length === 0 && <p className="p-2 text-[13px] text-muted-foreground">No block matches.</p>}
        {groups.map((group) => (
          <div key={group.label} className="flex flex-col">
            <span className="px-2 pt-2 pb-0.5 text-[11px] text-muted-foreground">{group.label}</span>
            {group.kinds.map((kind) => {
              const fit = blockFit(definition, section, kind)
              return (
                <button
                  key={kind}
                  type="button"
                  disabled={!fit.ok}
                  onClick={() => add(kind)}
                  className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent"
                >
                  <span className={cn("mt-0.5 grid size-6 shrink-0 place-items-center rounded bg-muted text-muted-foreground", !fit.ok && "opacity-50")}>
                    <AddedIcon kind={kind} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className={cn("text-[13px] font-medium", !fit.ok && "text-muted-foreground")}>
                      {ADDED_BLOCKS[kind].label}
                    </span>
                    <span className="text-[11px] leading-snug text-muted-foreground">
                      {fit.ok ? ADDED_BLOCKS[kind].blurb : fit.reason}
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
