import {
  collectDefinitionIssues,
  type FieldIssue,
} from "@/lib/templates/definition"

import { sectionEntry } from "./catalogue"
import { isAddedEntry, isEachEntry, type DefinitionV4, type EachEntry, type SlotEntry } from "./model"
import type { BlockRef, LeftTab, Selection } from "./store"

/**
 * What stands between a draft and a version, each with the place that fixes it.
 *
 * The validator in run mode — the same check `publishTemplateVersion` applies — plus the
 * three things a draft may lack but a version may not, which the old wizard checked in
 * `completionProblems`:
 * - a customer name;
 * - metrics on every section that reports them;
 * - at least one section.
 *
 * Each issue is mapped back from its field path to a section, a block or a panel, so the
 * "N to fix" list opens the thing that needs fixing rather than naming a path.
 */

export type BuilderIssue = {
  readonly message: string
  readonly path: readonly (string | number)[]
  /** Where clicking the issue goes: a section or block on the page, or a left panel. */
  readonly target: { readonly selection: Selection } | { readonly tab: LeftTab }
  readonly label: string
}

function targetOf(
  definition: DefinitionV4,
  path: readonly (string | number)[]
): BuilderIssue["target"] {
  if (path[0] === "design") return { tab: "theme" }
  if (path[0] !== "sections" || typeof path[1] !== "number") return { tab: "document" }

  const section = definition.sections[path[1]]
  if (section === undefined) return { tab: "outline" }
  if (path[2] !== "blocks" || typeof path[3] !== "number") {
    return { selection: { kind: "section", sectionId: section.id } }
  }

  const block = section.blocks?.[path[3]]
  let ref: BlockRef | null = null
  if (block !== undefined && isAddedEntry(block)) ref = { kind: "added", id: block.id }
  else if (block !== undefined && isEachEntry(block)) {
    const child = path[4] === "blocks" && typeof path[5] === "number"
      ? (block as EachEntry).blocks?.[path[5]]
      : undefined
    ref = child ? { kind: "slot", slot: child.slot, inEach: true } : { kind: "each" }
  } else if (block !== undefined) ref = { kind: "slot", slot: (block as SlotEntry).slot, inEach: false }

  return ref === null
    ? { selection: { kind: "section", sectionId: section.id } }
    : { selection: { kind: "block", sectionId: section.id, ref } }
}

function labelOf(definition: DefinitionV4, path: readonly (string | number)[]): string {
  if (path[0] === "identity") return "Document details"
  if (path[0] === "front_matter") return "Front matter"
  if (path[0] === "period") return "Report period"
  if (path[0] === "design") return "Theme"
  if (path[0] === "sections" && typeof path[1] === "number") {
    const section = definition.sections[path[1]]
    const entry = section ? sectionEntry(definition.provider, section.type) : undefined
    return entry ? entry.key.replaceAll("_", " ") : "A section"
  }
  return "The preset"
}

export function builderIssues(definition: DefinitionV4): BuilderIssue[] {
  const found: FieldIssue[] = [...collectDefinitionIssues(definition, { mode: "run" })]

  const customer = definition.identity.customer_name
  if (typeof customer !== "string" || customer.trim() === "") {
    found.push({
      path: ["identity", "customer_name"],
      message: "Name the customer this report is for. A run cannot be requested without one.",
    })
  }

  definition.sections.forEach((section, index) => {
    const entry = sectionEntry(definition.provider, section.type)
    if (entry?.metricBearing && (section.metrics ?? []).length === 0) {
      found.push({
        path: ["sections", index, "metrics"],
        message:
          "This section reports metrics but none are chosen, so the run would collect nothing for it.",
      })
    }
  })

  if (definition.sections.length === 0) {
    found.push({ path: ["sections"], message: "Add at least one section." })
  }

  return found.map((issue) => ({
    message: issue.message,
    path: issue.path,
    target: targetOf(definition, issue.path),
    label: labelOf(definition, issue.path),
  }))
}

/** The issues that belong to one section, for its outline row and inspector. */
export function issuesForSection(issues: readonly BuilderIssue[], sectionId: string): BuilderIssue[] {
  return issues.filter(
    (issue) =>
      "selection" in issue.target &&
      issue.target.selection !== null &&
      "sectionId" in issue.target.selection &&
      issue.target.selection.sectionId === sectionId
  )
}
