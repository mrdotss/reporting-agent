"use client"

import {
  ArrowDownIcon,
  ArrowUpIcon,
  CircleNotchIcon,
  CursorClickIcon,
  EyeIcon,
  EyeSlashIcon,
  SparkleIcon,
  TrashIcon,
  WarningIcon,
} from "@phosphor-icons/react"
import { useId, useMemo, useState, type ReactNode } from "react"

import { useBuilder, useBuilderStore, useEnvironment, useIssues } from "@/components/builder/context"
import {
  ADDED_BLOCKS,
  AGENT_REASONS,
  CALLOUT_TOKENS,
  blockHint,
  blockLabel,
  calloutConditionLabel,
} from "@/components/builder/canvas/labels"
import { CHART_STYLE_NAMES, Field, Segmented } from "@/components/builder/left/theme-panel"
import {
  columnLabel,
  declaredColumns,
  expansionFor,
  resourceNoun,
  sectionEntry,
  sectionTitle,
  type CatalogueSection,
  type Language,
  type Provider,
} from "@/lib/builder/catalogue"
import { issuesForSection } from "@/lib/builder/issues"
import {
  displayTitle,
  rankingOf,
  isEachEntry,
  isAddedEntry,
  sectionLayout,
  type MetricItem,
  type ScopeSelection,
  type SectionV4,
  type AddedEntry,
  type AddedKind,
  type CalloutCondition,
  type BlockStyle,
  type SlotEntry,
  avgAndPeakMetric,
} from "@/lib/builder/model"
import type { AgentTry, BlockRef, InspectorTab } from "@/lib/builder/store"
import { pageDesign } from "@/lib/builder/theme"
import { expandPresets, matchPresetName } from "@/lib/profiles/presets"
import { metricChoicesFor, toggleMetric, entryKey } from "@/lib/profiles/section-metrics"
import {
  AGENT_INSTRUCTION_MAX_LENGTH,
  BLOCK_CHART_HEIGHTS,
  CHART_SLOT_BLOCKS,
  CHART_STYLES,
  STYLE_THRESHOLD_MAX,
  STYLE_THRESHOLD_MIN,
  TABLE_SLOT_BLOCKS,
  containsNumeral,
  type MetricSelectionItem,
} from "@/lib/templates/definition"
import { cn } from "@/lib/utils"

import { DataNote } from "./data-notes"

/**
 * The selected thing's settings: Content (what it shows), Style (how it looks), Data (where
 * its figures come from).
 *
 * Typed text is checked as it is typed — words only — because a number someone types reads
 * exactly like one the snapshot proved, and the validator would refuse the preset anyway.
 */

const INPUT =
  "h-8 w-full rounded-md border border-input bg-background px-2.5 text-[13px] outline-none focus-visible:ring-2 focus-visible:ring-ring"

export function Inspector() {
  const selection = useBuilder((state) => state.selection)
  const definition = useBuilder((state) => state.definition)

  if (selection === null) return <EmptyInspector />
  if (selection.kind === "front") return <FrontInspector part={selection.part} />

  const section = definition.sections.find((candidate) => candidate.id === selection.sectionId)
  const entry = section ? sectionEntry(definition.provider, section.type) : undefined
  if (!section || !entry) return <EmptyInspector />
  if (selection.kind === "section") return <SectionInspector section={section} entry={entry} />
  return <BlockInspector section={section} entry={entry} ref_={selection.ref} />
}

function Tabs() {
  const tab = useBuilder((state) => state.inspectorTab)
  const setTab = useBuilder((state) => state.setInspectorTab)
  return (
    <Segmented<InspectorTab>
      label="Inspector"
      value={tab}
      options={[
        { value: "content", label: "Content" },
        { value: "style", label: "Style" },
        { value: "data", label: "Data" },
      ]}
      onChange={setTab}
    />
  )
}

function Header({ eyebrow, title, children }: Readonly<{ eyebrow: string; title: string; children?: ReactNode }>) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[11px] font-medium tracking-wide text-muted-foreground uppercase">{eyebrow}</span>
      <div className="flex items-start justify-between gap-2">
        <h2 className="text-[15px] leading-snug font-semibold">{title}</h2>
        {children}
      </div>
    </div>
  )
}

function EmptyInspector() {
  const definition = useBuilder((state) => state.definition)
  const issues = useIssues()
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-border p-4 text-[13px] text-muted-foreground">
        <CursorClickIcon aria-hidden className="size-5" />
        Select a block on the page, or a section in the outline, to change it here.
      </div>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[13px]">
        <dt className="text-muted-foreground">Provider</dt>
        <dd className="text-right font-medium">{definition.provider === "aws" ? "AWS" : "Azure"}</dd>
        <dt className="text-muted-foreground">Sections</dt>
        <dd className="text-right font-mono tabular-nums">{definition.sections.length}</dd>
        <dt className="text-muted-foreground">To fix</dt>
        <dd className="text-right font-mono tabular-nums">{issues.length}</dd>
      </dl>
      <p className="text-xs leading-relaxed text-muted-foreground">
        Keys: <kbd className="font-mono">⌘Z</kbd> undo, <kbd className="font-mono">⇧⌘Z</kbd> redo,{" "}
        <kbd className="font-mono">Alt ↑ ↓</kbd> move the selected block, <kbd className="font-mono">Esc</kbd> deselect.
      </p>
    </div>
  )
}

function FrontInspector({ part }: Readonly<{ part: "cover" | "control" | "toc" }>) {
  const setLeftTab = useBuilder((state) => state.setLeftTab)
  const titles = { cover: "Cover", control: "Document control", toc: "Contents" }
  const notes = {
    cover:
      "Report title, customer, period and an optional logo, subtitle and contact block. Each run fills in the period and the document number.",
    control: "Approvers, distribution and the revision row. Signatures are uploaded once and printed on every report.",
    toc: "Built from the section titles when the report is rendered, with the page each one starts on.",
  }
  return (
    <div className="flex flex-col gap-4">
      <Header eyebrow="Front matter" title={titles[part]} />
      <p className="text-[13px] leading-relaxed text-muted-foreground">{notes[part]}</p>
      <button
        type="button"
        onClick={() => setLeftTab("document")}
        className="inline-flex h-8 items-center justify-center rounded-md border border-input bg-card px-3 text-[13px] font-medium hover:bg-muted"
      >
        Edit under Document
      </button>
    </div>
  )
}

// --- Section ----------------------------------------------------------------------------

function SectionInspector({ section, entry }: Readonly<{ section: SectionV4; entry: CatalogueSection }>) {
  const definition = useBuilder((state) => state.definition)
  const tab = useBuilder((state) => state.inspectorTab)
  const removeSection = useBuilder((state) => state.removeSection)
  const moveSection = useBuilder((state) => state.moveSection)
  const issues = issuesForSection(useIssues(), section.id)
  const language = definition.identity.language

  return (
    <div className="flex flex-col gap-4">
      <Header eyebrow="Section" title={displayTitle(section, entry, language)}>
        {entry.position === "free" && (
          <span className="flex gap-0.5">
            <IconButton label="Move section up" onClick={() => moveSection(section.id, -1)}><ArrowUpIcon className="size-3.5" /></IconButton>
            <IconButton label="Move section down" onClick={() => moveSection(section.id, 1)}><ArrowDownIcon className="size-3.5" /></IconButton>
          </span>
        )}
      </Header>
      <Tabs />
      <IssueList issues={issues.map((issue) => issue.message)} />
      {tab === "content" && (
        <>
          <TitleFields section={section} slot="title" />
          {entry.metricBearing && <MetricsField section={section} entry={entry} />}
          {entry.drawsFromPriorRuns && <LookbackField section={section} provider={definition.provider} />}
        </>
      )}
      {tab === "style" && (
        <p className="text-[13px] leading-relaxed text-muted-foreground">
          Every section starts on a new page, under its title in the contents. Fonts, colours and
          table rules come from the theme on the left.
        </p>
      )}
      {tab === "data" && <SelectionFields section={section} entry={entry} provider={definition.provider} />}
      {entry.position !== "always" && (
        <button
          type="button"
          onClick={() => removeSection(section.id)}
          className="mt-2 inline-flex h-8 items-center justify-center gap-2 rounded-md text-[13px] font-medium text-destructive hover:bg-destructive/10"
        >
          <TrashIcon aria-hidden className="size-3.5" />
          Remove section
        </button>
      )}
    </div>
  )
}

function IssueList({ issues }: Readonly<{ issues: readonly string[] }>) {
  if (issues.length === 0) return null
  return (
    <ul className="flex flex-col gap-1.5 rounded-md bg-[var(--status-attention-soft,#f6ecd6)] p-2.5 text-xs text-[var(--status-attention,#7e5104)]">
      {issues.map((message) => (
        <li key={message} className="flex gap-1.5">
          <WarningIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
          {message}
        </li>
      ))}
    </ul>
  )
}

function IconButton({ label, onClick, children, disabled }: Readonly<{ label: string; onClick: () => void; children: ReactNode; disabled?: boolean }>) {
  return (
    <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-35">
      {children}
    </button>
  )
}

function TypedField({
  label,
  value,
  onChange,
  multiline = false,
  max,
  placeholder,
}: Readonly<{ label: string; value: string; onChange: (value: string) => void; multiline?: boolean; max: number; placeholder?: string }>) {
  const id = useId()
  const numeral = containsNumeral(value)
  const common = {
    id,
    value,
    maxLength: max,
    placeholder,
    "aria-invalid": numeral || undefined,
    "aria-describedby": numeral ? `${id}-numeral` : undefined,
    onChange: (event: { target: { value: string } }) => onChange(event.target.value),
  }
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      {multiline ? (
        <textarea {...common} rows={4} className={cn(INPUT, "h-auto min-h-[88px] py-1.5 leading-relaxed", numeral && "border-destructive")} />
      ) : (
        <input {...common} className={cn(INPUT, numeral && "border-destructive")} />
      )}
      {numeral && (
        <span id={`${id}-numeral`} className="text-[11.5px] text-destructive">
          Numbers can&rsquo;t be typed — every number in a report comes from the snapshot.
        </span>
      )}
    </div>
  )
}

function TitleFields({ section, slot }: Readonly<{ section: SectionV4; slot: string }>) {
  const definition = useBuilder((state) => state.definition)
  const setTitle = useBuilder((state) => state.setTitle)
  const entry = sectionEntry(definition.provider, section.type)
  const current = section.blocks?.find((block) => !isAddedEntry(block) && block.slot === slot) as SlotEntry | undefined
  const languages: Language[] = definition.identity.language === "id" ? ["id", "en"] : ["en", "id"]
  return (
    <Field label="Title" hint="Leave empty to print the catalogue title.">
      {languages.map((language) => (
        <TypedField
          key={language}
          label={language === "en" ? "English" : "Indonesian"}
          value={current?.title?.[language] ?? ""}
          placeholder={sectionTitle(entry, language)}
          max={120}
          onChange={(value) => setTitle(section.id, slot, language, value)}
        />
      ))}
    </Field>
  )
}

function MetricsField({ section, entry }: Readonly<{ section: SectionV4; entry: CatalogueSection }>) {
  const { catalog } = useEnvironment()
  const edit = useBuilder((state) => state.edit)
  const selection = (section.metrics ?? []) as readonly MetricSelectionItem[]
  const presets = useMemo(
    () => expandPresets({ key: entry.key, needs_resource_types: entry.needsResourceTypes, presets: entry.presets }, catalog),
    [catalog, entry]
  )
  const matched = matchPresetName(selection, presets)
  const groups = metricChoicesFor(entry.needsResourceTypes, catalog, selection)
  const setMetrics = (next: readonly MetricSelectionItem[]) =>
    edit((draft) => {
      const target = draft.sections.find((candidate) => candidate.id === section.id)
      if (target) target.metrics = [...next] as MetricItem[]
    })

  return (
    <Field label="Metrics" hint="Every chart, summary and table in this section shows these.">
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => (
          <button
            key={preset.name}
            type="button"
            aria-pressed={matched === preset.name}
            onClick={() => setMetrics(preset.metrics)}
            className={cn(
              "h-7 rounded-md border border-border px-2 text-xs",
              matched === preset.name ? "border-primary bg-primary/10 font-semibold text-primary" : "hover:bg-muted"
            )}
          >
            {preset.label}
          </button>
        ))}
        {matched === null && <span className="h-7 rounded-md bg-muted px-2 text-xs leading-7">Custom</span>}
      </div>
      <details className="rounded-md border border-border">
        <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium">
          Choose metrics one by one <span className="font-mono text-muted-foreground tabular-nums">({selection.length})</span>
        </summary>
        <div className="flex max-h-64 flex-col gap-2 overflow-auto px-2.5 pb-2">
          {groups.map((group) => (
            <fieldset key={group.resourceType} className="flex flex-col gap-1">
              <legend className="font-mono text-[11px] text-muted-foreground">{group.resourceType.split(/[/:]/).pop()}</legend>
              {group.choices.map((choice) => (
                <label key={entryKey(choice.entry, choice.statistic)} className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={choice.selected}
                    onChange={(event) => setMetrics(toggleMetric(selection, choice.entry, choice.statistic, event.target.checked))}
                  />
                  {choice.entry.name} <span className="text-muted-foreground">({choice.statistic})</span>
                  {choice.estimated && <span className="text-[11px] text-muted-foreground">est.</span>}
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </details>
    </Field>
  )
}

function LookbackField({ section, provider }: Readonly<{ section: SectionV4; provider: Provider }>) {
  const edit = useBuilder((state) => state.edit)
  const { metricsHistorySince } = useEnvironment()
  const id = useId()
  const value = section.lookback ?? 3
  return (
    <Field
      label="Months of history"
      hint={
        provider === "aws"
          ? value > 3
            ? "AWS keeps detailed metrics for about three months, so earlier months read “Not measured”."
            : "Read from earlier verified reports of this preset."
          : metricsHistorySince
            ? `Exported metrics reach back to ${metricsHistorySince.slice(0, 10)}.`
            : "Azure keeps metrics for 93 days. Export them to Log Analytics to report further back."
      }
    >
      <input
        id={id}
        aria-label="Months of history"
        type="number"
        min={2}
        max={24}
        value={value}
        onChange={(event) =>
          edit((draft) => {
            const target = draft.sections.find((candidate) => candidate.id === section.id)
            if (target) target.lookback = Math.max(2, Math.min(24, Math.round(Number(event.target.value) || 2)))
          })
        }
        className={cn(INPUT, "w-24 font-mono tabular-nums")}
      />
    </Field>
  )
}

function ChipsInput({ label, values, onChange, placeholder }: Readonly<{ label: string; values: readonly string[]; onChange: (values: string[]) => void; placeholder: string }>) {
  const id = useId()
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-1.5">
        {values.map((value) => (
          <span key={value} className="inline-flex h-6 items-center gap-1 rounded-md bg-muted pr-1 pl-2 text-xs">
            {value}
            <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter((v) => v !== value))} className="grid size-4 place-items-center rounded text-muted-foreground hover:bg-background">
              ×
            </button>
          </span>
        ))}
      </div>
      <input
        id={id}
        aria-label={`Add to ${label}`}
        placeholder={placeholder}
        className={INPUT}
        onKeyDown={(event) => {
          if (event.key !== "Enter") return
          const value = event.currentTarget.value.trim()
          if (value && !values.includes(value)) onChange([...values, value])
          event.currentTarget.value = ""
        }}
      />
    </Field>
  )
}

function SelectionFields({ section, entry, provider }: Readonly<{ section: SectionV4; entry: CatalogueSection; provider: Provider }>) {
  const edit = useBuilder((state) => state.edit)
  const selection: ScopeSelection = section.selection ?? {
    resource_types: [...entry.needsResourceTypes],
    tag_filters: [],
    resource_groups: [],
    top_n: null,
    sort: null,
  }
  const update = (patch: Partial<ScopeSelection>) =>
    edit((draft) => {
      const target = draft.sections.find((candidate) => candidate.id === section.id)
      if (!target) return
      const next = { ...selection, ...patch } as ScopeSelection
      if (next.locations && next.locations.length === 0) delete (next as { locations?: unknown }).locations
      target.selection = next as typeof target.selection
    })
  const firstMetric = section.metrics?.[0]

  return (
    <div className="flex flex-col gap-4">
      <DataNote kind="section" provider={provider} entry={entry} />
      <ChipsInput
        label={provider === "aws" ? "Regions" : "Locations"}
        values={selection.locations ?? []}
        placeholder={provider === "aws" ? "ap-southeast-1, then Enter" : "southeastasia, then Enter"}
        onChange={(locations) => update({ locations })}
      />
      <ChipsInput
        label="Tags (any of)"
        values={selection.tag_filters.map((tag) => `${tag.key}=${tag.value}`)}
        placeholder="env=prod, then Enter"
        onChange={(values) =>
          update({
            tag_filters: values.flatMap((value) => {
              const [key, ...rest] = value.split("=")
              return key && rest.length ? [{ key: key.trim(), value: rest.join("=").trim() }] : []
            }),
          })
        }
      />
      {provider === "azure" && (
        <ChipsInput label="Resource groups" values={selection.resource_groups} placeholder="rg-app-prod, then Enter" onChange={(resource_groups) => update({ resource_groups })} />
      )}
      {entry.metricBearing && firstMetric && (
        <Field label="Top resources only" hint="Ranks by the section's first metric. Ties go to the resource id.">
          <div className="flex items-center gap-2">
            <input
              aria-label="How many resources"
              type="number"
              min={1}
              max={500}
              placeholder="All"
              value={selection.top_n?.count ?? ""}
              onChange={(event) => {
                const count = Math.round(Number(event.target.value))
                update({
                  top_n: count >= 1
                    ? { count: Math.min(500, count), metric: firstMetric.metric ?? firstMetric.derived ?? "", statistic: firstMetric.statistic }
                    : null,
                })
              }}
              className={cn(INPUT, "w-24 font-mono tabular-nums")}
            />
            <Segmented
              label="Order"
              value={selection.sort ?? "descending"}
              options={[
                { value: "descending", label: "Highest" },
                { value: "ascending", label: "Lowest" },
              ]}
              onChange={(sort) => update({ sort })}
            />
          </div>
        </Field>
      )}
    </div>
  )
}

// --- Block --------------------------------------------------------------------------------

function BlockInspector({ section, entry, ref_ }: Readonly<{ section: SectionV4; entry: CatalogueSection; ref_: BlockRef }>) {
  const definition = useBuilder((state) => state.definition)
  const tab = useBuilder((state) => state.inspectorTab)
  const toggleHidden = useBuilder((state) => state.toggleHidden)
  const moveBlock = useBuilder((state) => state.moveBlock)
  const removeAdded = useBuilder((state) => state.removeAdded)
  const select = useBuilder((state) => state.select)
  const language = definition.identity.language
  const layout = sectionLayout(section, entry)

  const added =
    ref_.kind === "added"
      ? (section.blocks?.find((b) => isAddedEntry(b) && b.id === ref_.id) as AddedEntry | undefined)
      : undefined
  const title =
    ref_.kind === "added"
      ? ADDED_BLOCKS[added?.kind ?? "text"].label
      : ref_.kind === "each"
        ? `For each ${resourceNoun(entry)}`
        : blockLabel(entry, ref_.slot)
  const eachItem = layout.find((item) => item.kind === "each")
  const hidden =
    ref_.kind === "each"
      ? eachItem?.kind === "each" && eachItem.hidden
      : ref_.kind === "slot" && ref_.inEach
        ? eachItem?.kind === "each" && eachItem.children.some((child) => child.slot === ref_.slot && child.hidden)
        : ref_.kind === "slot" && layout.some((item) => item.kind === "slot" && item.slot === ref_.slot && item.hidden)
  const required = ref_.kind === "slot" && expansionFor(entry, ref_.slot)?.block === "heading" && ref_.slot === "title"

  return (
    <div className="flex flex-col gap-4">
      <Header eyebrow={displayTitle(section, entry, language)} title={title}>
        <span className="flex gap-0.5">
          <IconButton label="Move up" onClick={() => moveBlock(section.id, ref_, -1)}><ArrowUpIcon className="size-3.5" /></IconButton>
          <IconButton label="Move down" onClick={() => moveBlock(section.id, ref_, 1)}><ArrowDownIcon className="size-3.5" /></IconButton>
          {ref_.kind === "added" ? (
            <IconButton label="Remove" onClick={() => removeAdded(section.id, ref_.id)}><TrashIcon className="size-3.5" /></IconButton>
          ) : (
            <IconButton label={hidden ? "Show" : "Hide"} disabled={required} onClick={() => toggleHidden(section.id, ref_)}>
              {hidden ? <EyeSlashIcon className="size-3.5" /> : <EyeIcon className="size-3.5" />}
            </IconButton>
          )}
        </span>
      </Header>
      {hidden && <p className="rounded-md bg-muted px-2.5 py-1.5 text-xs text-muted-foreground">Hidden — it won&rsquo;t print.</p>}
      <Tabs />
      {tab === "content" && <BlockContent section={section} entry={entry} ref_={ref_} />}
      {tab === "style" && <BlockLook section={section} entry={entry} ref_={ref_} />}
      {tab === "data" && (
        <DataNote kind="block" provider={definition.provider} entry={entry} ref_={ref_} added={added?.kind} />
      )}
      <button type="button" onClick={() => select({ kind: "section", sectionId: section.id })} className="self-start text-xs font-medium text-primary hover:underline">
        Section settings
      </button>
    </div>
  )
}

function BlockContent({ section, entry, ref_ }: Readonly<{ section: SectionV4; entry: CatalogueSection; ref_: BlockRef }>) {
  const definition = useBuilder((state) => state.definition)
  const setText = useBuilder((state) => state.setText)
  const select = useBuilder((state) => state.select)
  const setInspectorTab = useBuilder((state) => state.setInspectorTab)

  if (ref_.kind === "added") {
    const block = section.blocks?.find((b) => isAddedEntry(b) && b.id === ref_.id) as AddedEntry | undefined
    if (block?.kind === "callout") return <CalloutContent section={section} block={block} />
    if (block?.kind === "agent") return <AgentContent section={section} entry={entry} block={block} />
    if (block && block.kind !== "text") return <AddedContent section={section} entry={entry} kind={block.kind} />
    const languages: Language[] = definition.identity.language === "id" ? ["id", "en"] : ["en", "id"]
    return (
      <Field label="Words" hint="The report's language is required; the other is optional. Numbers are refused.">
        {languages.map((language) => (
          <TypedField
            key={language}
            label={language === "en" ? "English" : "Indonesian"}
            multiline
            max={2000}
            value={block?.text?.[language] ?? ""}
            onChange={(value) => setText(section.id, ref_.id, language, value)}
          />
        ))}
      </Field>
    )
  }

  if (ref_.kind === "each") {
    return (
      <p className="text-[13px] leading-relaxed text-muted-foreground">
        These blocks repeat once for every {resourceNoun(entry)} the section selects. Narrow which
        ones under <b>Data</b> in the section settings — by region, tag, or the top few.
      </p>
    )
  }

  const expansion = expansionFor(entry, ref_.slot)
  if (expansion?.block === "heading" && expansion.per === "section") {
    return <TitleFields section={section} slot={ref_.slot} />
  }
  if (expansion?.block === "resource_table" && declaredColumns(expansion).length > 0) {
    return <ColumnsField section={section} entry={entry} ref_={ref_} />
  }
  const metricDriven = ["timeseries_chart", "metric_summary", "top_n_table", "historical_trend"].includes(expansion?.block ?? "")
  return (
    <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-muted-foreground">
      <p>{blockHint(entry, ref_.slot) || "This block prints as the catalogue lays it out."}</p>
      {metricDriven && (
        <button
          type="button"
          onClick={() => {
            select({ kind: "section", sectionId: section.id })
            setInspectorTab("content")
          }}
          className="self-start text-xs font-medium text-primary hover:underline"
        >
          Change the section&rsquo;s metrics
        </button>
      )}
    </div>
  )
}

function ColumnsField({ section, entry, ref_ }: Readonly<{ section: SectionV4; entry: CatalogueSection; ref_: BlockRef & { kind: "slot" } }>) {
  const definition = useBuilder((state) => state.definition)
  const setColumns = useBuilder((state) => state.setColumns)
  const expansion = expansionFor(entry, ref_.slot)
  const declared = declaredColumns(expansion)
  const each = section.blocks?.find((b) => isEachEntry(b))
  const settings = (ref_.inEach
    ? (each && isEachEntry(each) ? each.blocks : [])?.find((b) => b.slot === ref_.slot)
    : section.blocks?.find((b) => !isAddedEntry(b) && b.slot === ref_.slot)) as SlotEntry | undefined
  const chosen = settings?.columns ?? declared.map((column) => column.id)
  const ordered = [...chosen, ...declared.map((c) => c.id).filter((id) => !chosen.includes(id))]
  const language = definition.identity.language

  const write = (next: string[]) => {
    const same = next.length === declared.length && next.every((id, index) => id === declared[index]?.id)
    setColumns(section.id, ref_, same ? null : next)
  }

  return (
    <Field label="Columns, in print order" hint="Untick to leave a column out. The resource name always prints.">
      <ul className="flex flex-col gap-0.5">
        {ordered.map((id, index) => {
          const column = declared.find((candidate) => candidate.id === id)
          if (!column) return null
          const on = chosen.includes(id)
          return (
            <li key={id} className="flex items-center gap-2 rounded-md px-1 py-0.5 text-[13px] hover:bg-muted">
              <input
                type="checkbox"
                aria-label={columnLabel(column, language)}
                checked={on}
                disabled={on && chosen.length === 1}
                onChange={(event) => write(event.target.checked ? [...chosen, id] : chosen.filter((c) => c !== id))}
              />
              <span className={cn("flex-1", !on && "text-muted-foreground")}>{columnLabel(column, language)}</span>
              {on && (
                <span className="flex">
                  <IconButton label={`Move ${columnLabel(column, language)} up`} disabled={index === 0} onClick={() => {
                    const next = [...chosen]
                    const at = next.indexOf(id)
                    if (at > 0) [next[at - 1], next[at]] = [next[at]!, next[at - 1]!]
                    write(next)
                  }}><ArrowUpIcon className="size-3" /></IconButton>
                  <IconButton label={`Move ${columnLabel(column, language)} down`} disabled={chosen.indexOf(id) === chosen.length - 1} onClick={() => {
                    const next = [...chosen]
                    const at = next.indexOf(id)
                    if (at < next.length - 1) [next[at + 1], next[at]] = [next[at]!, next[at + 1]!]
                    write(next)
                  }}><ArrowDownIcon className="size-3" /></IconButton>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {settings?.columns && (
        <button type="button" onClick={() => setColumns(section.id, ref_, null)} className="self-start text-xs font-medium text-primary hover:underline">
          Reset to the catalogue&rsquo;s columns
        </button>
      )}
    </Field>
  )
}

const HEIGHT_NAMES: Readonly<Record<(typeof BLOCK_CHART_HEIGHTS)[number], string>> = { short: "Short", normal: "Normal", tall: "Tall" }
const VALUE_NAMES = { last: "Last value", peak: "Peak", none: "None" } as const
const HEADER_NAMES = { rule: "Rule", tint: "Tint", solid: "Solid", plain: "Plain" } as const
const ROW_NAMES = { hairline: "Hairline", banded: "Zebra", bordered: "Boxed", open: "Open" } as const

/**
 * A chart's or a table's own look, over the document's (`slot.style`). Each control shows
 * what prints; choosing the document's value drops the key, so the block keeps following
 * the theme for everything it has not changed.
 */
function BlockLook({ section, entry, ref_ }: Readonly<{ section: SectionV4; entry: CatalogueSection; ref_: BlockRef }>) {
  const definition = useBuilder((state) => state.definition)
  const setSlotStyle = useBuilder((state) => state.setSlotStyle)
  const design = pageDesign(definition)
  const block = ref_.kind === "slot" ? expansionFor(entry, ref_.slot)?.block : undefined
  const chart = (CHART_SLOT_BLOCKS as readonly string[]).includes(block ?? "")
  const table = (TABLE_SLOT_BLOCKS as readonly string[]).includes(block ?? "")
  if (ref_.kind !== "slot" || (!chart && !table)) {
    return <p className="text-[13px] leading-relaxed text-muted-foreground">This block follows the theme: its face, accent and spacing. Change those under Theme.</p>
  }
  const each = section.blocks?.find((b) => isEachEntry(b))
  const own = ((ref_.inEach
    ? (each && isEachEntry(each) ? each.blocks : [])?.find((b) => b.slot === ref_.slot)
    : section.blocks?.find((b) => !isAddedEntry(b) && b.slot === ref_.slot)) as SlotEntry | undefined)?.style
  const set = <K extends keyof BlockStyle>(key: K, value: BlockStyle[K], documentValue: BlockStyle[K]) =>
    setSlotStyle(section.id, ref_, { [key]: value === documentValue ? undefined : value })

  const threshold = (key: "threshold" | "mark_at_or_above", label: string, documentValue: number | null) => {
    const value = own?.[key] ?? documentValue
    return (
      <div className="flex flex-col gap-1.5">
        <label className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
          {label}
          <span className="flex items-center gap-1.5">
            <input
              type="number"
              aria-label={label}
              min={STYLE_THRESHOLD_MIN}
              max={STYLE_THRESHOLD_MAX}
              placeholder="Off"
              value={value ?? ""}
              onChange={(event) => {
                if (event.target.value === "") return setSlotStyle(section.id, ref_, { [key]: undefined })
                const next = Math.round(Number(event.target.value))
                if (next >= STYLE_THRESHOLD_MIN && next <= STYLE_THRESHOLD_MAX) set(key, next, documentValue ?? undefined)
              }}
              className="h-7 w-14 rounded-md border border-input bg-background px-1.5 text-right font-mono text-xs text-foreground"
            />
            %
          </span>
        </label>
        <span className="text-[11.5px] leading-snug text-muted-foreground">
          {own?.[key] !== undefined
            ? `This block's own. The document's is ${documentValue === null ? "off" : `${documentValue}%`}.`
            : documentValue === null
              ? "Off in the document. Type a value to set one for this block."
              : "The document's. Type a value to change it here only."}
        </span>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2 rounded-md bg-muted px-2.5 py-1.5 text-xs">
        <span className="text-muted-foreground">{own ? "Its own look" : "Follows the theme"}</span>
        {own && (
          <button type="button" onClick={() => setSlotStyle(section.id, ref_, null)} className="font-medium text-primary hover:underline">
            Reset to the theme
          </button>
        )}
      </div>
      {chart ? (
        <>
          <Field label="Look">
            <select
              aria-label="Chart look"
              value={own?.look ?? design.chartStyle}
              onChange={(event) => set("look", event.target.value as BlockStyle["look"], design.chartStyle)}
              className="h-8 rounded-md border border-input bg-background px-2 text-[13px]"
            >
              {CHART_STYLES.map((style) => (
                <option key={style} value={style}>
                  {CHART_STYLE_NAMES[style]}
                  {style === design.chartStyle ? " (document)" : ""}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Height">
            <Segmented
              label="Chart height"
              value={own?.height ?? "normal"}
              options={BLOCK_CHART_HEIGHTS.map((value) => ({ value, label: HEIGHT_NAMES[value] }))}
              onChange={(value) => set("height", value, "normal")}
            />
          </Field>
          <Field label="Value labels">
            <Segmented
              label="Value labels"
              value={own?.values ?? design.look.chartValues}
              options={(["last", "peak", "none"] as const).map((value) => ({ value, label: VALUE_NAMES[value] }))}
              onChange={(value) => set("values", value, design.look.chartValues)}
            />
          </Field>
          {threshold("threshold", "Threshold line at", design.look.chartThreshold)}
        </>
      ) : (
        <>
          <Field label="Rows">
            <Segmented
              label="Table rows"
              value={own?.rows ?? design.tableStyle}
              options={(["hairline", "banded", "bordered", "open"] as const).map((value) => ({ value, label: ROW_NAMES[value] }))}
              onChange={(value) => set("rows", value, design.tableStyle)}
            />
          </Field>
          <Field label="Header">
            <Segmented
              label="Table header"
              value={own?.header ?? design.look.tableHeader}
              options={(["rule", "tint", "solid", "plain"] as const).map((value) => ({ value, label: HEADER_NAMES[value] }))}
              onChange={(value) => set("header", value, design.look.tableHeader)}
            />
          </Field>
          {threshold("mark_at_or_above", "Mark values at or above", design.look.markAtOrAbove)}
        </>
      )}
    </div>
  )
}

/** What an added catalogue block shows, and the section setting that decides it. */
function AddedContent({
  section,
  entry,
  kind,
}: Readonly<{ section: SectionV4; entry: CatalogueSection; kind: Exclude<AddedKind, "text"> }>) {
  const select = useBuilder((state) => state.select)
  const setInspectorTab = useBuilder((state) => state.setInspectorTab)
  const rank = rankingOf(section, entry)
  const ranking = rank ? `${rank.metric} (${rank.statistic})` : "the section's first metric"
  const lines: Record<Exclude<AddedKind, "text">, string> = {
    key_figures: "One row for each of the section's metrics: its highest value in the period, and which resource reached it.",
    top_list: section.selection?.top_n
      ? `The section's own top ${section.selection.top_n.count}, ranked by ${ranking}.`
      : `The top ten resources, ranked by ${ranking}. Set a top-N under the section's Data tab to change how many.`,
    month_vs_month: `Each resource's ${ranking} in the previous verified report of this preset, beside this period's, with the direction it moved. The first report has no earlier one, and says so.`,
    coverage: "Every gap the run recorded, grouped by type, with the resources it affects. The appendix prints the same record.",
    page_break: "The next block starts on a new page in the delivered document.",
    callout: "",
    heatmap: `One row for each of the section's top resources (up to twelve), one cell per day, shaded by ${ranking}.`,
    sparklines: `The section's top five resources by ${ranking}: each one's shape over the period as a small line, with its average, estimated P95 and peak beside it.`,
    avg_vs_peak: avgAndPeakMetric(section)
      ? `Each resource's average and peak ${avgAndPeakMetric(section)}, busiest by peak first, up to twelve rows. Both dots are figures from the snapshot.`
      : "Needs a metric the section collects both an average and a maximum of. Add the missing statistic under the section's metrics.",
    agent: "",
  }
  const readsMetrics = kind !== "coverage" && kind !== "page_break"
  return (
    <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-muted-foreground">
      <p>{lines[kind]}</p>
      {readsMetrics && (
        <button
          type="button"
          onClick={() => {
            select({ kind: "section", sectionId: section.id })
            setInspectorTab("content")
          }}
          className="self-start text-xs font-medium text-primary hover:underline"
        >
          Change the section&rsquo;s metrics
        </button>
      )}
    </div>
  )
}

/** A callout: when it prints, how it reads, and the words — with the tokens its condition fills. */
function CalloutContent({ section, block }: Readonly<{ section: SectionV4; block: AddedEntry }>) {
  const definition = useBuilder((state) => state.definition)
  const setCallout = useBuilder((state) => state.setCallout)
  const setText = useBuilder((state) => state.setText)
  const thresholdId = useId()
  const entry = sectionEntry(definition.provider, section.type)
  const when = block.when ?? "coverage_gaps"
  const conditions: CalloutCondition[] = [
    ...(entry?.metricBearing ? (["peak_at_or_above"] as const) : []),
    "without_backup",
    "housekeeping",
    "stopped",
    "coverage_gaps",
  ]
  const rank = rankingOf(section, entry)
  const languages: Language[] = definition.identity.language === "id" ? ["id", "en"] : ["en", "id"]
  return (
    <div className="flex flex-col gap-4">
      <Field label="Prints when">
        <div role="radiogroup" aria-label="Condition" className="flex flex-col gap-1">
          {conditions.map((condition) => (
            <label key={condition} className="flex items-center gap-2 rounded-md px-1.5 py-1 text-[13px] hover:bg-muted">
              <input
                type="radio"
                name={`callout-${block.id}`}
                checked={when === condition}
                onChange={() => setCallout(section.id, block.id, { when: condition })}
              />
              {calloutConditionLabel(condition, definition.provider)}
            </label>
          ))}
        </div>
      </Field>
      {when === "peak_at_or_above" && (
        <Field
          label="Threshold"
          hint={`Prints when any resource's ${rank ? `${rank.metric} (${rank.statistic})` : "ranking metric"} is at or above this, in the metric's own unit. The threshold itself never prints.`}
        >
          <input
            id={thresholdId}
            aria-label="Threshold"
            type="number"
            min={1}
            max={100}
            value={block.threshold ?? 80}
            onChange={(event) =>
              setCallout(section.id, block.id, {
                threshold: Math.max(1, Math.min(100, Math.round(Number(event.target.value) || 1))),
              })
            }
            className={cn(INPUT, "w-24 font-mono tabular-nums")}
          />
        </Field>
      )}
      <Field label="Tone">
        <Segmented
          label="Tone"
          value={block.tone ?? "info"}
          options={[
            { value: "info", label: "Note" },
            { value: "attention", label: "Attention" },
          ]}
          onChange={(tone) => setCallout(section.id, block.id, { tone })}
        />
      </Field>
      <Field
        label="Words"
        hint={`Numbers are refused; these fill from the snapshot: ${CALLOUT_TOKENS[when].map((token) => `{${token}}`).join(", ")}.`}
      >
        {languages.map((language) => (
          <TypedField
            key={language}
            label={language === "en" ? "English" : "Indonesian"}
            multiline
            max={2000}
            value={block.text?.[language] ?? ""}
            onChange={(value) => setText(section.id, block.id, language, value)}
          />
        ))}
      </Field>
    </div>
  )
}


const LENGTH_NAMES = { sentence: "One sentence", short: "Short paragraph", bullets: "Points" } as const
const VOICE_NAMES = { plain: "Plain", executive: "Executive", technical: "Technical" } as const

/**
 * An agent paragraph: what to ask, what it reads, how long, in what voice, and what stands
 * in when its words are refused. Try it writes it against a connection's latest report.
 */
function AgentContent({
  section,
  entry,
  block,
}: Readonly<{ section: SectionV4; entry: CatalogueSection; block: AddedEntry }>) {
  const definition = useBuilder((state) => state.definition)
  const setAgent = useBuilder((state) => state.setAgent)
  const setAgentText = useBuilder((state) => state.setAgentText)
  const languages: Language[] = definition.identity.language === "id" ? ["id", "en"] : ["en", "id"]
  const reads = block.reads ?? []
  const layout = sectionLayout(section, entry)
  // What it can read: the section's blocks, in print order, but not another agent paragraph.
  const readable = [
    ...layout.flatMap((item) =>
      item.kind === "slot"
        ? [{ ref: item.slot, label: blockLabel(entry, item.slot) }]
        : item.kind === "each"
          ? item.children.map((child) => ({ ref: child.slot, label: `${blockLabel(entry, child.slot)} · each ${resourceNoun(entry)}` }))
          : item.kind === "added" && item.entry.kind !== "agent"
            ? [{ ref: item.id, label: ADDED_BLOCKS[item.entry.kind].label }]
            : []
    ),
  ].filter((option) => option.ref !== "title")
  const toggle = (ref: string) =>
    setAgent(section.id, block.id, {
      reads: reads.includes(ref) ? reads.filter((value) => value !== ref) : [...reads, ref],
    })

  return (
    <div className="flex flex-col gap-4">
      <Field
        label="Instruction"
        hint="What the agent should say about these figures. It may name a number, such as a threshold, but that number never prints — if the agent repeats it, or writes any number it was not shown, its words are refused. Try it shows you the result."
      >
        {languages.map((language) => (
          <InstructionField
            key={language}
            label={language === "en" ? "English" : "Indonesian"}
            value={block.instruction?.[language] ?? ""}
            onChange={(value) => setAgentText(section.id, block.id, "instruction", language, value)}
          />
        ))}
      </Field>
      <Field label="Reads" hint={reads.length === 0 ? "Nothing chosen: it reads the whole section." : "Only these blocks' figures are shown to the agent."}>
        <div className="flex flex-wrap gap-1.5">
          {readable.map((option) => {
            const on = reads.includes(option.ref)
            return (
              <button
                key={option.ref}
                type="button"
                aria-pressed={on}
                onClick={() => toggle(option.ref)}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[12px]",
                  on ? "border-primary bg-primary/10 font-medium text-primary" : "border-border text-muted-foreground hover:border-input"
                )}
              >
                {option.label}
              </button>
            )
          })}
        </div>
      </Field>
      <Field label="Length">
        <Segmented
          label="Length"
          value={block.length ?? "short"}
          options={(["sentence", "short", "bullets"] as const).map((value) => ({ value, label: LENGTH_NAMES[value] }))}
          onChange={(length) => setAgent(section.id, block.id, { length })}
        />
      </Field>
      <Field label="Voice">
        <Segmented
          label="Voice"
          value={block.voice ?? "plain"}
          options={(["plain", "executive", "technical"] as const).map((value) => ({ value, label: VOICE_NAMES[value] }))}
          onChange={(voice) => setAgent(section.id, block.id, { voice })}
        />
      </Field>
      <Field
        label="If it cannot be written"
        hint="The report still delivers either way, and the report's page lists what was left out and why."
      >
        <Segmented
          label="Fallback"
          value={block.fallback ?? "omit"}
          options={[
            { value: "omit", label: "Leave it out" },
            { value: "note", label: "Print a note" },
          ]}
          onChange={(fallback) => setAgent(section.id, block.id, { fallback })}
        />
        {block.fallback === "note" &&
          languages.map((language) => (
            <TypedField
              key={language}
              label={`Note · ${language === "en" ? "English" : "Indonesian"}`}
              multiline
              max={2000}
              value={block.note?.[language] ?? ""}
              onChange={(value) => setAgentText(section.id, block.id, "note", language, value)}
            />
          ))}
      </Field>
      <TryAgent section={section} block={block} />
    </div>
  )
}

/** An instruction: like typed text, but a number is allowed — it is a prompt, never printed. */
function InstructionField({ label, value, onChange }: Readonly<{ label: string; value: string; onChange: (value: string) => void }>) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-xs font-medium text-muted-foreground">{label}</label>
      <textarea
        id={id}
        value={value}
        maxLength={AGENT_INSTRUCTION_MAX_LENGTH}
        rows={3}
        placeholder="e.g. Say which machines ran hot at peak and whether that needs attention."
        onChange={(event) => onChange(event.target.value)}
        className={cn(INPUT, "h-auto min-h-[72px] py-1.5 leading-relaxed")}
      />
    </div>
  )
}

/** Try it: the one paragraph, written now against a connection's latest report. */
function TryAgent({ section, block }: Readonly<{ section: SectionV4; block: AddedEntry }>) {
  const store = useBuilderStore()
  const { templateId, previewSources } = useEnvironment()
  const language = useBuilder((state) => state.definition.identity.language)
  const blockId = `${section.id}__${block.id}`
  const lastTry = useBuilder((state) => state.agentTries[blockId])
  const setAgentTry = useBuilder((state) => state.setAgentTry)
  const ready = previewSources.filter((source) => source.period !== null)
  const [sourceId, setSourceId] = useState<string | undefined>(ready[0]?.id)
  const [busy, setBusy] = useState(false)
  const [problem, setProblem] = useState<string | null>(null)
  const instruction = block.instruction?.[language]?.trim() ?? ""
  const issues = useIssues()
  const blocking = issues.length > 0

  const run = async () => {
    if (!sourceId) return
    setBusy(true)
    setProblem(null)
    try {
      const response = await fetch(`/api/report-profiles/${templateId}/agent-try`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ connectedSubscriptionId: sourceId, definition: store.getState().definition, blockId }),
      })
      const body = (await response.json()) as {
        outcome?: AgentTry["outcome"]
        reason?: string
        text?: string
        figures?: number
        error?: { message?: string }
      }
      if (!response.ok || body.outcome === undefined) {
        setProblem(body.error?.message ?? "The agent could not be asked just now. The draft is kept.")
        return
      }
      setAgentTry(blockId, {
        outcome: body.outcome,
        reason: body.reason ?? "",
        text: body.text ?? "",
        figures: body.figures ?? 0,
        instruction,
        at: new Date().toISOString(),
      })
    } catch {
      setProblem("The server could not be reached. The draft is kept.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-semibold">Try it with real figures</span>
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy || !sourceId || !instruction || blocking}
          title={blocking ? "Fix what the builder lists under “to fix” first." : undefined}
          className="inline-flex h-7 items-center gap-1.5 rounded-md bg-primary px-2.5 text-[12.5px] font-medium text-primary-foreground disabled:opacity-50"
        >
          {busy ? <CircleNotchIcon className="size-3.5 animate-spin" /> : <SparkleIcon className="size-3.5" />}
          {busy ? "Writing…" : lastTry ? "Try again" : "Try it"}
        </button>
      </div>
      {ready.length === 0 ? (
        <p className="text-[11.5px] leading-snug text-muted-foreground">
          Needs a connection of this provider with a completed report. Run any preset against one first.
        </p>
      ) : (
        ready.length > 1 && (
          <select
            aria-label="Connection to try against"
            value={sourceId}
            onChange={(event) => setSourceId(event.target.value)}
            className={cn(INPUT, "h-8")}
          >
            {ready.map((source) => (
              <option key={source.id} value={source.id}>
                {source.name}
              </option>
            ))}
          </select>
        )
      )}
      {problem && <p role="alert" className="text-[11.5px] text-destructive">{problem}</p>}
      {lastTry && (
        <div className="flex flex-col gap-1">
          <span className="text-[11px] font-medium text-muted-foreground">
            Last try ·{" "}
            {lastTry.outcome === "written"
              ? `from ${lastTry.figures} figures, every number checked`
              : lastTry.outcome === "note"
                ? "not written — your note prints instead"
                : "not written — nothing prints in its place"}
          </span>
          <p className="text-[12.5px] leading-relaxed whitespace-pre-line">
            {lastTry.outcome === "written" ? lastTry.text : AGENT_REASONS[lastTry.reason] ?? "Not written."}
          </p>
          {lastTry.instruction !== instruction && (
            <span className="text-[11px] text-muted-foreground">The instruction changed since this try.</span>
          )}
          <span className="text-[11px] text-muted-foreground">
            Not saved, and not what the report prints: every run writes its own.
          </span>
        </div>
      )}
    </div>
  )
}
