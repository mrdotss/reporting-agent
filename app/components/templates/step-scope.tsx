"use client"

import { ScopePicker, type ScopePickerValue } from "@/components/templates/scope-picker"
import type { InventoryDimensions } from "@/lib/subscriptions/inventory-cache"
import type { ScopeSpec, TemplateDefinition } from "@/lib/templates/definition"

/**
 * Step 2 — the template's default scope rules (Requirements 3.1, 3.12, 9.5, 9.6,
 * 9.7, 10.1–10.11).
 *
 * ## Rules, never resources, and the UI has to say so
 *
 * Requirement 1.3 rejects a definition carrying a fully qualified Azure resource
 * id in any scope field, and Requirement 1.2 makes a template's meaning
 * independent of which subscription a run selects. That is the property that lets
 * one template serve every connected customer — so this step offers **resource
 * types, tag filters and resource groups** and offers no way to pick a named
 * resource, and the description says why rather than leaving a consultant looking
 * for the resource picker.
 *
 * ## An empty dimension is unconstrained, and that is not obvious
 *
 * Requirement 3.12 reads an empty dimension as imposing no constraint, so leaving
 * resource types blank collects **every** type rather than none. A consultant who
 * read it the other way would build a template they believed was narrow and get a
 * report over the whole subscription, so each field states its empty meaning.
 *
 * ## The scope picker replaces comma-separated text
 *
 * The previous implementation used comma-separated text controls (`parseList` and
 * `parseTagFilters`). The scope picker now presents the connected subscription's
 * inventory as selectable options, while retaining free entry with identical bounds
 * and validation. A picked value stores the same rule a manually entered value does
 * — character-identical — and one entry not two on a duplicate.
 *
 * ## The picker never writes
 *
 * It renders stored values as selected whether or not the inventory response
 * contains them, marks absent ones as "not present in this subscription", and
 * removes a value only on explicit removal. Opening a template against a second
 * subscription's inventory edits no rule.
 */

/** `"a, b , ,c"` → `["a", "b", "c"]`. A trailing comma is not an empty entry. */
export function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
}

/**
 * `"env=prod, tier=web"` → `[{key, value}]`.
 *
 * An entry with no `=` contributes a filter with an **empty value**, which the
 * validator accepts (Requirement 3.1 bounds a tag value at 0 to 256 characters —
 * zero is a legal length, and it means "has this tag at all"). Dropping the entry
 * instead would silently discard something the consultant typed.
 */
export function parseTagFilters(
  value: string
): { key: string; value: string }[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map((entry) => {
      const index = entry.indexOf("=")
      if (index === -1) return { key: entry, value: "" }

      return {
        key: entry.slice(0, index).trim(),
        value: entry.slice(index + 1).trim(),
      }
    })
}

export function StepScope({
  definition,
  onChange,
  inventory,
  inventoryUnavailableReason,
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
  /**
   * The inventory dimensions from the selected subscription, or undefined if no
   * subscription is selected or the endpoint is unavailable.
   */
  inventory?: InventoryDimensions
  /** Why inventory is unavailable. Shown to the user. */
  inventoryUnavailableReason?: string
}>) {
  const pickerValue: ScopePickerValue = {
    resource_types: definition.scope.resource_types,
    resource_groups: definition.scope.resource_groups,
    tag_filters: definition.scope.tag_filters as { key: string; value: string }[],
  }

  const handleChange = (next: ScopePickerValue) => {
    const scope: ScopeSpec = {
      ...definition.scope,
      resource_types: next.resource_types,
      resource_groups: next.resource_groups,
      tag_filters: next.tag_filters,
    }
    onChange({ ...definition, scope })
  }

  return (
    <ScopePicker
      value={pickerValue}
      onChange={handleChange}
      inventory={inventory}
      inventoryUnavailableReason={inventoryUnavailableReason}
    />
  )
}
