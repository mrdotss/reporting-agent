"use client"

import {
  ArrowDownIcon,
  ArrowUpIcon,
  EyeIcon,
  EyeSlashIcon,
  PlusIcon,
  RepeatIcon,
  TrashIcon,
} from "@phosphor-icons/react"
import { useEffect, useRef, useState, type ReactNode } from "react"

import { useBuilder, useIssues } from "@/components/builder/context"
import {
  expansionFor,
  resourceNoun,
  sectionEntry,
  sectionTitle,
  type CatalogueSection,
} from "@/lib/builder/catalogue"
import { issuesForSection } from "@/lib/builder/issues"
import {
  orderedSections,
  sectionLayout,
  type LayoutItem,
  type LayoutSlot,
  type SectionV4,
} from "@/lib/builder/model"
import { sampleResources } from "@/lib/builder/sample"
import { blockKey, type BlockRef, type Selection } from "@/lib/builder/store"
import { DENSITY_SCALE, PAGE_PX, PT, pageDesign, type PageDesign } from "@/lib/builder/theme"
import { cn } from "@/lib/utils"

import { AddedText, CatalogueBlock, Heading, px } from "./blocks"
import { blockLabel } from "./labels"

/**
 * The live page: every section in the order the report prints it, every visible block drawn
 * over the sample, each one selectable.
 *
 * Drawn at the printed size and scaled to fit the pane, so a line that wraps here wraps at
 * the same width on paper. It is not the delivered document — that is the runtime's — and
 * the sheet says "Sample data" so nobody reads these figures as theirs.
 */

function sameRef(a: BlockRef, b: BlockRef): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === "text" && b.kind === "text") return a.id === b.id
  if (a.kind === "slot" && b.kind === "slot") return a.slot === b.slot && a.inEach === b.inEach
  return true
}

function isSelected(selection: Selection, sectionId: string, ref: BlockRef): boolean {
  return selection?.kind === "block" && selection.sectionId === sectionId && sameRef(selection.ref, ref)
}

function useFitZoom(pageWidth: number): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement | null>(null)
  const [zoom, setZoom] = useState(1)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const width = entry?.contentRect.width ?? pageWidth
      setZoom(Math.min(1, Math.max(0.45, (width - 48) / pageWidth)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [pageWidth])
  return [ref, zoom]
}

export function Canvas() {
  const definition = useBuilder((state) => state.definition)
  const mode = useBuilder((state) => state.mode)
  const select = useBuilder((state) => state.select)
  const selection = useBuilder((state) => state.selection)
  const design = pageDesign(definition)
  const page = PAGE_PX[design.pageSize]
  const [desk, zoom] = useFitZoom(page.width)

  // What is selected in the outline or the issue list is brought into view on the page.
  // `nearest`, so a block clicked on the page itself does not move.
  useEffect(() => {
    if (selection === null || desk.current === null) return
    const selector =
      selection.kind === "block"
        ? `[data-block-key="${CSS.escape(`${selection.sectionId}|${blockKey(selection.ref)}`)}"]`
        : selection.kind === "section"
          ? `[data-section-id="${CSS.escape(selection.sectionId)}"]`
          : `[data-front="${selection.part}"]`
    desk.current.querySelector(selector)?.scrollIntoView({ block: "nearest", behavior: "smooth" })
  }, [desk, selection])
  const sections = orderedSections(definition)
  const language = definition.identity.language

  return (
    <div
      ref={desk}
      data-slot="builder-canvas"
      className="relative h-full overflow-auto bg-[radial-gradient(var(--border)_1px,transparent_1px)] [background-size:18px_18px]"
      onClick={(event) => {
        if (event.target === event.currentTarget) select(null)
      }}
    >
      <div className="flex flex-col items-center gap-6 px-6 py-8" style={{ zoom }}>
        {design.cover && <CoverSheet design={design} />}
        <article
          aria-label="Report page"
          className="relative bg-white shadow-[0_1px_3px_rgba(20,20,30,0.12),0_8px_24px_rgba(20,20,30,0.06)]"
          style={{
            width: page.width,
            minHeight: page.height,
            padding: `${72 * DENSITY_SCALE[design.density]}px 76px`,
            fontFamily: design.spec.face,
            fontSize: px(design.spec.bodyPt),
            lineHeight: design.spec.lineSpacing,
            color: design.spec.ink,
          }}
        >
          <SampleBadge />
          <FrontMatterRows design={design} />
          <div className="flex flex-col" style={{ gap: 18 * DENSITY_SCALE[design.density] }}>
            {sections.length === 0 && (
              <p className="rounded-md border border-dashed border-border p-6 text-center font-sans text-sm text-muted-foreground">
                No sections yet. Open <b>Add</b> on the left to put the first one on the page.
              </p>
            )}
            {sections.map((section, index) => {
              const entry = sectionEntry(definition.provider, section.type)
              if (!entry) return null
              return (
                <SectionView
                  key={section.id}
                  section={section}
                  entry={entry}
                  number={index + 1}
                  design={design}
                  editing={mode === "edit"}
                />
              )
            })}
          </div>
        </article>
        <p className="font-sans text-xs text-muted-foreground">
          {language === "id" ? "Contoh data" : "Sample data"} · {design.pageSize} ·{" "}
          {Math.round(zoom * 100)}%
        </p>
      </div>
    </div>
  )
}

function SampleBadge() {
  return (
    <span className="absolute top-3 right-4 rounded-full bg-muted px-2 py-0.5 font-sans text-[10.5px] font-medium text-muted-foreground">
      Sample data
    </span>
  )
}

function CoverSheet({ design }: Readonly<{ design: PageDesign }>) {
  const definition = useBuilder((state) => state.definition)
  const selection = useBuilder((state) => state.selection)
  const select = useBuilder((state) => state.select)
  const page = PAGE_PX[design.pageSize]
  const { spec } = design
  const title = definition.identity.report_title?.trim() || definition.identity.name
  const customer = definition.identity.customer_name?.trim()
  const subtitle = (definition.front_matter.cover as { subtitle?: string } | undefined)?.subtitle
  const selected = selection?.kind === "front" && selection.part === "cover"
  return (
    <button
      type="button"
      aria-label="Cover page"
      data-front="cover"
      onClick={() => select({ kind: "front", part: "cover" })}
      className={cn(
        "relative block bg-white text-left shadow-[0_1px_3px_rgba(20,20,30,0.12),0_8px_24px_rgba(20,20,30,0.06)] outline-offset-4",
        selected ? "outline-2 outline-primary" : "hover:outline-1 hover:outline-primary/40"
      )}
      style={{ width: page.width, height: page.height * 0.62, fontFamily: spec.face, color: spec.ink, cursor: "pointer" }}
    >
      <span className="absolute inset-x-0 top-0" style={{ height: 14, background: spec.accent }} />
      <span className="absolute flex flex-col" style={{ left: 76, right: 76, bottom: 96, gap: 12 }}>
        <span style={{ fontSize: px(spec.smallPt + 1), letterSpacing: "0.14em", textTransform: "uppercase", color: spec.muted }}>
          {customer || "Customer name"} · {periodLabel(definition.period.kind, definition.identity.language)}
        </span>
        <span style={{ fontSize: px(spec.titlePt), fontWeight: 700, lineHeight: 1.1, color: spec.accent }}>{title}</span>
        {subtitle && <span style={{ fontSize: px(spec.subtitlePt), color: spec.muted }}>{subtitle}</span>}
      </span>
      <span className="absolute font-sans text-[10.5px] text-muted-foreground" style={{ left: 76, bottom: 40 }}>
        Cover · edit it under Document
      </span>
    </button>
  )
}

const PERIODS: Readonly<Record<string, [string, string]>> = {
  last_24h: ["Last 24 hours", "24 jam terakhir"],
  last_7d: ["Last 7 days", "7 hari terakhir"],
  last_30d: ["Last 30 days", "30 hari terakhir"],
  last_full_month: ["Last full month", "Bulan penuh terakhir"],
  mtd: ["Month to date", "Bulan berjalan"],
  custom: ["A fixed window", "Rentang tetap"],
}

export function periodLabel(kind: string, language: "en" | "id"): string {
  const labels = PERIODS[kind] ?? PERIODS.last_full_month!
  return language === "id" ? labels[1] : labels[0]
}

function FrontMatterRows({ design }: Readonly<{ design: PageDesign }>) {
  const definition = useBuilder((state) => state.definition)
  const selection = useBuilder((state) => state.selection)
  const select = useBuilder((state) => state.select)
  const toc = (definition.front_matter.toc as { enabled?: boolean } | undefined)?.enabled !== false
  const rows: { part: "control" | "toc"; label: string }[] = [
    { part: "control", label: "Document control — approvers, distribution, revision" },
    ...(toc ? [{ part: "toc" as const, label: "Contents — built from the section headings" }] : []),
  ]
  return (
    <div className="mb-6 flex flex-col gap-1.5 font-sans">
      {rows.map((row) => {
        const selected = selection?.kind === "front" && selection.part === row.part
        return (
          <button
            key={row.part}
            type="button"
            data-front={row.part}
            onClick={() => select({ kind: "front", part: row.part })}
            className={cn(
              "flex items-center justify-between rounded-md border border-dashed px-3 py-1.5 text-left text-[11.5px] text-muted-foreground",
              selected ? "border-primary bg-primary/5 text-primary" : "border-border hover:border-primary/40"
            )}
            style={{ borderColor: selected ? undefined : design.spec.rule }}
          >
            {row.label}
            <span className="text-[10.5px]">Own page</span>
          </button>
        )
      })}
    </div>
  )
}

function SectionView({
  section,
  entry,
  number,
  design,
  editing,
}: Readonly<{
  section: SectionV4
  entry: CatalogueSection
  number: number
  design: PageDesign
  editing: boolean
}>) {
  const definition = useBuilder((state) => state.definition)
  const selection = useBuilder((state) => state.selection)
  const issues = issuesForSection(useIssues(), section.id)
  const layout = sectionLayout(section, entry)
  const selected = selection !== null && "sectionId" in selection && selection.sectionId === section.id
  const language = definition.identity.language

  return (
    <section
      aria-label={sectionTitle(entry, language)}
      data-section-id={section.id}
      className={cn("relative flex flex-col", selected && editing && "rounded-sm")}
      style={{ gap: 10 * DENSITY_SCALE[design.density] }}
    >
      {number > 1 && (
        <div className="-mx-[76px] mb-2 flex items-center gap-2 font-sans text-[10px] tracking-wide text-muted-foreground uppercase">
          <span className="h-px flex-1 border-t border-dashed border-border" />
          New page
          <span className="h-px flex-1 border-t border-dashed border-border" />
        </div>
      )}
      {issues.length > 0 && editing && (
        <span className="absolute -left-[60px] top-1 rounded-full bg-[var(--status-attention-soft,#f6ecd6)] px-1.5 font-sans text-[10px] font-semibold text-[var(--status-attention,#7e5104)]">
          {issues.length}
        </span>
      )}
      {layout.map((item, index) => (
        <LayoutItemView
          key={item.kind === "text" ? item.id : item.kind === "each" ? "each" : item.slot}
          item={item}
          index={index}
          section={section}
          entry={entry}
          number={number}
          design={design}
          editing={editing}
        />
      ))}
    </section>
  )
}

function LayoutItemView({
  item,
  index,
  section,
  entry,
  number,
  design,
  editing,
}: Readonly<{
  item: LayoutItem
  index: number
  section: SectionV4
  entry: CatalogueSection
  number: number
  design: PageDesign
  editing: boolean
}>) {
  const definition = useBuilder((state) => state.definition)
  const language = definition.identity.language
  const provider = definition.provider

  if (item.kind === "text") {
    return (
      <Selectable section={section} ref_={{ kind: "text", id: item.id }} label="Text" editing={editing} index={index}>
        <AddedText design={design} text={item.entry.text[language]} />
      </Selectable>
    )
  }

  if (item.kind === "each") {
    if (item.hidden) {
      return editing ? <HiddenRow section={section} ref_={{ kind: "each" }} label={`Each ${resourceNoun(entry)}`} /> : null
    }
    const resource = sampleResources(provider)[0]!
    const count = sampleResources(provider).length
    return (
      <div
        className="relative rounded-lg border border-dashed px-4 pt-6 pb-3"
        style={{ borderColor: editing ? "rgba(47,60,126,.45)" : "transparent", padding: editing ? undefined : 0 }}
      >
        {editing && (
          <span className="absolute -top-2.5 left-3 inline-flex h-5 items-center gap-1.5 rounded-full bg-primary/10 px-2 font-sans text-[11px] font-semibold text-primary">
            <RepeatIcon aria-hidden className="size-3" />
            Repeats for each {resourceNoun(entry)} · 1 of {count} shown
          </span>
        )}
        <div className="flex flex-col" style={{ gap: 10 * DENSITY_SCALE[design.density] }}>
          {item.children.map((child, childIndex) => (
            <SlotView
              key={child.slot}
              child={child}
              inEach
              index={childIndex}
              section={section}
              entry={entry}
              number={number}
              design={design}
              editing={editing}
              resource={resource}
            />
          ))}
        </div>
      </div>
    )
  }

  return (
    <SlotView
      child={item}
      inEach={false}
      index={index}
      section={section}
      entry={entry}
      number={number}
      design={design}
      editing={editing}
    />
  )
}

function SlotView({
  child,
  inEach,
  index,
  section,
  entry,
  number,
  design,
  editing,
  resource,
}: Readonly<{
  child: LayoutSlot
  inEach: boolean
  index: number
  section: SectionV4
  entry: CatalogueSection
  number: number
  design: PageDesign
  editing: boolean
  resource?: ReturnType<typeof sampleResources>[number]
}>) {
  const definition = useBuilder((state) => state.definition)
  const ref: BlockRef = { kind: "slot", slot: child.slot, inEach }
  const expansion = expansionFor(entry, child.slot)
  const label = blockLabel(entry, child.slot)
  if (!expansion) return null
  if (child.hidden) {
    return editing ? <HiddenRow section={section} ref_={ref} label={label} /> : null
  }
  return (
    <Selectable section={section} ref_={ref} label={label} editing={editing} index={index} required={child.shape.required}>
      <CatalogueBlock
        provider={definition.provider}
        design={design}
        language={definition.identity.language}
        entry={entry}
        expansion={expansion}
        section={section}
        settings={child.entry}
        number={number}
        resource={resource}
      />
    </Selectable>
  )
}

function HiddenRow({ section, ref_, label }: Readonly<{ section: SectionV4; ref_: BlockRef; label: string }>) {
  const toggleHidden = useBuilder((state) => state.toggleHidden)
  return (
    <div className="flex items-center justify-between gap-2 rounded-md border border-dashed border-[#c9c9c2] px-2.5 py-1 font-sans text-[11.5px] text-[#76777e]">
      <span className="inline-flex items-center gap-1.5">
        <EyeSlashIcon aria-hidden className="size-3.5" />
        Hidden · {label}
      </span>
      <button
        type="button"
        className="font-semibold text-primary hover:underline"
        onClick={() => toggleHidden(section.id, ref_)}
      >
        Show
      </button>
    </div>
  )
}

function Selectable({
  section,
  ref_,
  label,
  editing,
  index,
  required = false,
  children,
}: Readonly<{
  section: SectionV4
  ref_: BlockRef
  label: string
  editing: boolean
  index: number
  required?: boolean
  children: ReactNode
}>) {
  const selection = useBuilder((state) => state.selection)
  const select = useBuilder((state) => state.select)
  const moveBlock = useBuilder((state) => state.moveBlock)
  const toggleHidden = useBuilder((state) => state.toggleHidden)
  const removeText = useBuilder((state) => state.removeText)
  const addText = useBuilder((state) => state.addText)
  const selected = isSelected(selection, section.id, ref_)

  if (!editing) return <div>{children}</div>

  return (
    <div className="group/block relative" data-block-key={`${section.id}|${blockKey(ref_)}`}>
      <button
        type="button"
        aria-label={`Select ${label}`}
        aria-pressed={selected}
        onClick={() => select({ kind: "block", sectionId: section.id, ref: ref_ })}
        className={cn(
          "absolute -inset-x-2.5 -inset-y-1.5 z-[1] rounded-md",
          selected ? "shadow-[inset_0_0_0_2px_var(--primary)]" : "hover:shadow-[inset_0_0_0_1px_color-mix(in_oklab,var(--primary)_35%,transparent)]"
        )}
      />
      {selected && (
        <>
          <span className="absolute -top-[18px] -left-2.5 z-[2] h-[17px] rounded-t px-1.5 font-sans text-[10.5px] leading-[17px] font-semibold text-primary-foreground bg-primary">
            {label}
          </span>
          <span className="absolute -top-5 -right-2.5 z-[3] flex gap-px rounded-md bg-foreground p-0.5 shadow-lg">
            <ToolbarButton label="Move up" disabled={index === 0} onClick={() => moveBlock(section.id, ref_, -1)}>
              <ArrowUpIcon className="size-3.5" />
            </ToolbarButton>
            <ToolbarButton label="Move down" onClick={() => moveBlock(section.id, ref_, 1)}>
              <ArrowDownIcon className="size-3.5" />
            </ToolbarButton>
            {ref_.kind === "text" ? (
              <ToolbarButton label="Remove" onClick={() => removeText(section.id, ref_.id)}>
                <TrashIcon className="size-3.5" />
              </ToolbarButton>
            ) : (
              <ToolbarButton label={required ? "A section title cannot be hidden" : "Hide"} disabled={required} onClick={() => toggleHidden(section.id, ref_)}>
                <EyeIcon className="size-3.5" />
              </ToolbarButton>
            )}
          </span>
        </>
      )}
      <div className="relative">{children}</div>
      <InsertLine onAdd={() => addText(section.id, ref_)} />
    </div>
  )
}

function ToolbarButton({
  label,
  disabled,
  onClick,
  children,
}: Readonly<{ label: string; disabled?: boolean; onClick: () => void; children: ReactNode }>) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation()
        onClick()
      }}
      className="grid h-[22px] w-6 place-items-center rounded text-background hover:bg-background/20 disabled:opacity-35"
    >
      {children}
    </button>
  )
}

function InsertLine({ onAdd }: Readonly<{ onAdd: () => void }>) {
  return (
    <div className="pointer-events-none absolute inset-x-0 -bottom-[11px] z-[4] flex h-3.5 items-center gap-2 opacity-0 transition-opacity group-hover/block:pointer-events-auto group-hover/block:opacity-100 focus-within:pointer-events-auto focus-within:opacity-100">
      <span className="h-px flex-1 bg-primary/35" />
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation()
          onAdd()
        }}
        className="inline-flex h-5 items-center gap-1 rounded-full border border-primary/40 bg-white px-2 font-sans text-[11px] font-semibold text-primary"
      >
        <PlusIcon aria-hidden className="size-3" />
        Add text
      </button>
      <span className="h-px flex-1 bg-primary/35" />
    </div>
  )
}

export { Heading, PT }
