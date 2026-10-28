import { ADDED_BLOCKS, CHART_STYLE_NAMES, blockLabel, calloutConditionLabel } from "@/components/builder/canvas/labels"
import {
  columnLabel,
  declaredColumns,
  expansionFor,
  resourceNoun,
  sectionEntry,
  type CatalogueSection,
  type Language,
} from "@/lib/builder/catalogue"
import {
  displayTitle,
  isAddedEntry,
  isEachEntry,
  sectionLayout,
  type AddedEntry,
  type DefinitionV4,
  type SectionV4,
  type SlotEntry,
} from "@/lib/builder/model"
import { createBuilderStore, type BlockRef } from "@/lib/builder/store"
import {
  AGENT_FALLBACKS,
  AGENT_INSTRUCTION_MAX_LENGTH,
  AGENT_LENGTHS,
  AGENT_VOICES,
  BLOCK_CHART_HEIGHTS,
  CALLOUT_CONDITIONS,
  CALLOUT_THRESHOLD_MAX,
  CALLOUT_THRESHOLD_MIN,
  CALLOUT_TONES,
  CHART_SLOT_BLOCKS,
  CHART_STYLES,
  HISTORICAL_LOOKBACK_MAX,
  HISTORICAL_LOOKBACK_MIN,
  SECTION_TEXT_MAX_LENGTH,
  SECTION_TITLE_MAX_LENGTH,
  STYLE_CHART_VALUES,
  STYLE_TABLE_HEADERS,
  STYLE_THRESHOLD_MAX,
  STYLE_THRESHOLD_MIN,
  TABLE_SLOT_BLOCKS,
  TABLE_STYLE_VALUES,
  TOP_N_MAX_COUNT,
  TOP_N_MIN_COUNT,
  sectionNeedsLookback,
  type MetricCatalogSnapshot,
} from "@/lib/templates/definition"

/**
 * Ask on a block: the settings one block has, as fields a model can be told about and a
 * person can read, and the one way an answer is put back.
 *
 * Shared by the server, which asks the model and checks its answer, and the builder, which
 * shows the before and after and applies it. An answer can only set a field listed here, to a
 * value the field allows; anything else is dropped before anyone sees it. Applying goes
 * through the builder store's own actions, so an Ask change is the same edit the inspector
 * would have made by hand, and passes the same validator.
 */

/** The longest wish Ask takes. */
export const ASK_REQUEST_MAX_LENGTH = 500

export type AskChoice = { readonly value: string; readonly label: string }

export type AskField =
  | { readonly key: string; readonly label: string; readonly type: "choice"; readonly options: readonly AskChoice[]; readonly clearable?: string }
  | { readonly key: string; readonly label: string; readonly type: "number"; readonly min: number; readonly max: number; readonly unit?: string; readonly clearable?: string }
  | { readonly key: string; readonly label: string; readonly type: "text"; readonly max: number }
  | { readonly key: string; readonly label: string; readonly type: "columns"; readonly options: readonly AskChoice[] }
  | { readonly key: string; readonly label: string; readonly type: "flag" }

/** A field's value: `null` for a cleared one (the block follows the theme, or it is off). */
export type AskValue = string | number | boolean | readonly string[] | null
export type AskValues = Readonly<Record<string, AskValue>>

export type AskBlock = {
  readonly cloud: "AWS" | "Azure"
  readonly section: string
  readonly block: string
  readonly fields: readonly AskField[]
  readonly values: AskValues
}

const HEIGHT_NAMES = { short: "Short", normal: "Normal", tall: "Tall" } as const
const VALUE_NAMES = { last: "Last value", peak: "Peak", none: "None" } as const
const HEADER_NAMES = { rule: "Rule", tint: "Tint", solid: "Solid", plain: "Plain" } as const
const ROW_NAMES = { hairline: "Hairline", banded: "Zebra", bordered: "Boxed", open: "Open" } as const
const TONE_NAMES = { info: "Information", attention: "Needs attention" } as const
const LENGTH_NAMES = { sentence: "One sentence", short: "A short paragraph", bullets: "Bullet points" } as const
const VOICE_NAMES = { plain: "Plain", executive: "Executive", technical: "Technical" } as const
const FALLBACK_NAMES = { omit: "Leave it out", note: "Print a note" } as const
const LANGUAGE_NAMES: Readonly<Record<Language, string>> = { en: "English", id: "Indonesian" }

function choices<T extends string>(values: readonly T[], names: Readonly<Record<T, string>>): AskChoice[] {
  return values.map((value) => ({ value, label: names[value] }))
}

function typed(key: string, label: string, max: number): AskField[] {
  return (["en", "id"] as const).map((language) => ({
    key: `${key}.${language}`,
    label: `${label} (${LANGUAGE_NAMES[language]})`,
    type: "text" as const,
    max,
  }))
}

function slotEntryOf(section: SectionV4, ref: BlockRef & { kind: "slot" }): SlotEntry | undefined {
  if (!ref.inEach) {
    return section.blocks?.find((block) => !isAddedEntry(block) && !isEachEntry(block) && block.slot === ref.slot) as
      | SlotEntry
      | undefined
  }
  const each = section.blocks?.find((block) => isEachEntry(block))
  return each && isEachEntry(each) ? each.blocks?.find((child) => child.slot === ref.slot) : undefined
}

function hiddenOf(section: SectionV4, entry: CatalogueSection, ref: BlockRef): boolean {
  const layout = sectionLayout(section, entry)
  const each = layout.find((item) => item.kind === "each")
  if (ref.kind === "each") return each?.kind === "each" && each.hidden
  if (ref.kind === "added") return false
  if (ref.inEach) return each?.kind === "each" && each.children.some((child) => child.slot === ref.slot && child.hidden)
  return layout.some((item) => item.kind === "slot" && item.slot === ref.slot && item.hidden)
}

/** The section settings any block's wish may reach: how many it ranks, which way, how far back. */
function sectionFields(section: SectionV4, fields: AskField[], values: Record<string, AskValue>) {
  const top = section.selection?.top_n
  if (top) {
    fields.push({ key: "section.top_n", label: "How many resources it ranks", type: "number", min: TOP_N_MIN_COUNT, max: TOP_N_MAX_COUNT })
    values["section.top_n"] = top.count
  }
  if (section.selection) {
    fields.push({
      key: "section.sort",
      label: "Order",
      type: "choice",
      options: [
        { value: "descending", label: "Highest first" },
        { value: "ascending", label: "Lowest first" },
      ],
      clearable: "The catalogue's order",
    })
    values["section.sort"] = section.selection.sort
  }
  if (sectionNeedsLookback(section.type)) {
    fields.push({ key: "section.lookback", label: "Months of history", type: "number", min: HISTORICAL_LOOKBACK_MIN, max: HISTORICAL_LOOKBACK_MAX, unit: "months" })
    values["section.lookback"] = section.lookback ?? null
  }
}

/** What one block can be asked to change, and what it is now. `null` when the block is gone. */
export function askBlock(definition: DefinitionV4, sectionId: string, ref: BlockRef): AskBlock | null {
  const section = definition.sections.find((candidate) => candidate.id === sectionId)
  const entry = section && sectionEntry(definition.provider, section.type)
  if (!section || !entry) return null
  const language = definition.identity.language
  const fields: AskField[] = []
  const values: Record<string, AskValue> = {}
  let block: string

  if (ref.kind === "added") {
    const added = section.blocks?.find((candidate) => isAddedEntry(candidate) && candidate.id === ref.id) as AddedEntry | undefined
    if (!added) return null
    block = ADDED_BLOCKS[added.kind].label
    if (added.kind === "text" || added.kind === "callout") {
      fields.push(...typed("text", "Words", SECTION_TEXT_MAX_LENGTH))
      values["text.en"] = added.text?.en ?? ""
      values["text.id"] = added.text?.id ?? ""
    }
    if (added.kind === "callout") {
      const conditions = Object.fromEntries(
        CALLOUT_CONDITIONS.map((when) => [when, calloutConditionLabel(when, definition.provider === "aws" ? "aws" : "azure")])
      ) as Record<(typeof CALLOUT_CONDITIONS)[number], string>
      fields.push(
        { key: "when", label: "Prints when", type: "choice", options: choices(CALLOUT_CONDITIONS, conditions) },
        { key: "tone", label: "Tone", type: "choice", options: choices(CALLOUT_TONES, TONE_NAMES) },
        { key: "threshold", label: "Threshold (only when a resource reaches one)", type: "number", min: CALLOUT_THRESHOLD_MIN, max: CALLOUT_THRESHOLD_MAX, unit: "%" }
      )
      values.when = added.when ?? null
      values.tone = added.tone ?? null
      values.threshold = added.threshold ?? null
    }
    if (added.kind === "agent") {
      fields.push(
        ...typed("instruction", "What the agent writes", AGENT_INSTRUCTION_MAX_LENGTH),
        { key: "length", label: "Length", type: "choice", options: choices(AGENT_LENGTHS, LENGTH_NAMES) },
        { key: "voice", label: "Voice", type: "choice", options: choices(AGENT_VOICES, VOICE_NAMES) },
        { key: "fallback", label: "When it cannot write", type: "choice", options: choices(AGENT_FALLBACKS, FALLBACK_NAMES) },
        ...typed("note", "The note it prints instead", SECTION_TEXT_MAX_LENGTH)
      )
      values["instruction.en"] = added.instruction?.en ?? ""
      values["instruction.id"] = added.instruction?.id ?? ""
      values.length = added.length ?? null
      values.voice = added.voice ?? null
      values.fallback = added.fallback ?? null
      values["note.en"] = added.note?.en ?? ""
      values["note.id"] = added.note?.id ?? ""
    }
  } else if (ref.kind === "each") {
    block = `For each ${resourceNoun(entry)}`
    fields.push({ key: "hidden", label: "Hidden", type: "flag" })
    values.hidden = hiddenOf(section, entry, ref)
  } else {
    block = blockLabel(entry, ref.slot)
    const expansion = expansionFor(entry, ref.slot)
    const own = slotEntryOf(section, ref)
    const required = expansion?.block === "heading" && ref.slot === "title"
    if (!required) {
      fields.push({ key: "hidden", label: "Hidden", type: "flag" })
      values.hidden = hiddenOf(section, entry, ref)
    }
    if (expansion?.block === "heading" && expansion.per === "section" && !ref.inEach) {
      fields.push(...typed("title", "Title", SECTION_TITLE_MAX_LENGTH))
      values["title.en"] = own?.title?.en ?? ""
      values["title.id"] = own?.title?.id ?? ""
    }
    const declared = declaredColumns(expansion)
    if (expansion?.block === "resource_table" && declared.length > 0) {
      fields.push({
        key: "columns",
        label: "Columns, in print order",
        type: "columns",
        options: declared.map((column) => ({ value: column.id, label: columnLabel(column, language) })),
      })
      values.columns = own?.columns ?? declared.map((column) => column.id)
    }
    const kind = expansion?.block ?? ""
    if ((CHART_SLOT_BLOCKS as readonly string[]).includes(kind)) {
      const theme = "The theme's"
      fields.push(
        { key: "style.look", label: "Chart look", type: "choice", options: choices(CHART_STYLES, CHART_STYLE_NAMES), clearable: theme },
        { key: "style.height", label: "Chart height", type: "choice", options: choices(BLOCK_CHART_HEIGHTS, HEIGHT_NAMES), clearable: "Normal" },
        { key: "style.values", label: "Value labels", type: "choice", options: choices(STYLE_CHART_VALUES, VALUE_NAMES), clearable: theme },
        { key: "style.threshold", label: "Threshold line at", type: "number", min: STYLE_THRESHOLD_MIN, max: STYLE_THRESHOLD_MAX, unit: "%", clearable: theme }
      )
      values["style.look"] = own?.style?.look ?? null
      values["style.height"] = own?.style?.height ?? null
      values["style.values"] = own?.style?.values ?? null
      values["style.threshold"] = own?.style?.threshold ?? null
    }
    if ((TABLE_SLOT_BLOCKS as readonly string[]).includes(kind)) {
      const theme = "The theme's"
      fields.push(
        { key: "style.rows", label: "Table rows", type: "choice", options: choices(TABLE_STYLE_VALUES, ROW_NAMES), clearable: theme },
        { key: "style.header", label: "Table header", type: "choice", options: choices(STYLE_TABLE_HEADERS, HEADER_NAMES), clearable: theme },
        { key: "style.mark_at_or_above", label: "Mark values at or above", type: "number", min: STYLE_THRESHOLD_MIN, max: STYLE_THRESHOLD_MAX, unit: "%", clearable: theme }
      )
      values["style.rows"] = own?.style?.rows ?? null
      values["style.header"] = own?.style?.header ?? null
      values["style.mark_at_or_above"] = own?.style?.mark_at_or_above ?? null
    }
  }

  sectionFields(section, fields, values)
  return {
    cloud: definition.provider === "aws" ? "AWS" : "Azure",
    section: displayTitle(section, entry, language),
    block,
    fields,
    values,
  }
}

function same(a: AskValue | undefined, b: AskValue | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null)
}

/**
 * Keeps what an answer may set: listed fields, allowed values, and only what differs from
 * now. Everything else is named in `dropped`, by the key the model used.
 */
export function cleanAsk(block: AskBlock, raw: unknown): { readonly set: AskValues; readonly dropped: readonly string[] } {
  const set: Record<string, AskValue> = {}
  const dropped: string[] = []
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { set, dropped }
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    const field = block.fields.find((candidate) => candidate.key === key)
    const clean = field === undefined ? undefined : cleanValue(field, value)
    if (clean === undefined) {
      dropped.push(key)
      continue
    }
    if (!same(clean, block.values[key])) set[key] = clean
  }
  return { set, dropped }
}

function cleanValue(field: AskField, value: unknown): AskValue | undefined {
  switch (field.type) {
    case "flag":
      return typeof value === "boolean" ? value : undefined
    case "text":
      return typeof value === "string" && value.length <= field.max ? value.trim() : undefined
    case "choice":
      if (value === null) return field.clearable ? null : undefined
      return typeof value === "string" && field.options.some((option) => option.value === value) ? value : undefined
    case "number":
      if (value === null) return field.clearable ? null : undefined
      return typeof value === "number" && Number.isInteger(value) && value >= field.min && value <= field.max ? value : undefined
    case "columns": {
      if (!Array.isArray(value) || value.length === 0) return undefined
      const known = new Set(field.options.map((option) => option.value))
      const columns = value.filter((column): column is string => typeof column === "string" && known.has(column))
      return columns.length === value.length && new Set(columns).size === columns.length ? columns : undefined
    }
  }
}

/** One changed setting, as the before and after a person reads. */
export type AskChange = { readonly key: string; readonly label: string; readonly before: string; readonly after: string }

function shown(field: AskField, value: AskValue | undefined): string {
  if (value === null || value === undefined || value === "") {
    if (field.type === "choice" || field.type === "number") return field.clearable ?? "Not set"
    return field.type === "text" ? "Empty" : "Not set"
  }
  if (field.type === "flag") return value ? "Yes" : "No"
  if (field.type === "choice") return field.options.find((option) => option.value === value)?.label ?? String(value)
  if (field.type === "columns" && Array.isArray(value)) {
    return value.map((column) => field.options.find((option) => option.value === column)?.label ?? column).join(", ")
  }
  if (field.type === "number") return `${String(value)}${field.unit === "%" ? "%" : field.unit ? ` ${field.unit}` : ""}`
  return String(value)
}

export function askChanges(block: AskBlock, set: AskValues): AskChange[] {
  return block.fields.flatMap((field) =>
    field.key in set
      ? [{ key: field.key, label: field.label, before: shown(field, block.values[field.key]), after: shown(field, set[field.key]) }]
      : []
  )
}

/**
 * The draft with `set` applied to the block, through the store's own actions on a copy.
 * The builder replaces its draft with the result in one edit, so one undo takes it back.
 */
export function applyAsk(
  definition: DefinitionV4,
  catalog: MetricCatalogSnapshot,
  sectionId: string,
  ref: BlockRef,
  set: AskValues
): DefinitionV4 {
  const store = createBuilderStore({ initial: definition, catalog })
  const actions = store.getState()
  const block = askBlock(definition, sectionId, ref)
  if (block === null) return definition

  for (const [key, value] of Object.entries(set)) {
    const [head, rest] = key.split(".") as [string, string | undefined]
    const language = rest === "en" || rest === "id" ? (rest as Language) : undefined
    if (key === "hidden") {
      if (value !== block.values.hidden) actions.toggleHidden(sectionId, ref)
    } else if (key === "columns" && Array.isArray(value)) {
      actions.setColumns(sectionId, ref, value as string[])
    } else if (head === "style" && rest !== undefined) {
      actions.setSlotStyle(sectionId, ref, { [rest]: value ?? undefined })
    } else if (head === "title" && ref.kind === "slot" && language) {
      actions.setTitle(sectionId, ref.slot, language, String(value ?? ""))
    } else if (ref.kind === "added" && head === "text" && language) {
      actions.setText(sectionId, ref.id, language, String(value ?? ""))
    } else if (ref.kind === "added" && (head === "instruction" || head === "note") && language) {
      actions.setAgentText(sectionId, ref.id, head, language, String(value ?? ""))
    } else if (ref.kind === "added" && (key === "when" || key === "tone" || key === "threshold")) {
      actions.setCallout(sectionId, ref.id, { [key]: value ?? undefined })
    } else if (ref.kind === "added" && (key === "length" || key === "voice" || key === "fallback")) {
      actions.setAgent(sectionId, ref.id, { [key]: value ?? undefined })
    } else if (head === "section") {
      actions.edit((draft) => {
        const section = draft.sections.find((candidate) => candidate.id === sectionId)
        if (!section) return
        if (rest === "top_n" && section.selection?.top_n && typeof value === "number") section.selection.top_n.count = value
        if (rest === "sort" && section.selection) section.selection.sort = value as "descending" | "ascending" | null
        if (rest === "lookback") {
          if (typeof value === "number") section.lookback = value
          else delete section.lookback
        }
      })
    }
  }
  return store.getState().definition
}
