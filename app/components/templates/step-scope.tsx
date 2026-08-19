"use client"

import { useId } from "react"

import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { ScopeSpec, TemplateDefinition } from "@/lib/templates/definition"

/**
 * Step 2 — the template's default scope rules (Requirements 3.1, 3.12, 11.1).
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
 * ## Comma-separated text, not a chip editor
 *
 * A deliberate simplification at this step. The values are Azure resource type
 * names and resource group names — long, exact strings a consultant pastes rather
 * than picks — and a chip editor's value is in constraining a short vocabulary.
 * The parsing is one function, tested with the rest of the step, and trimming
 * empties is what keeps a trailing comma from becoming an empty entry the
 * validator then rejects.
 */

/** `"a, b , ,c"` → `["a", "b", "c"]`. A trailing comma is not an empty entry. */
export function parseList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
}

/** `[{key, value}]` → `"env=prod, tier=web"`. */
function formatTagFilters(filters: ScopeSpec["tag_filters"]): string {
  return filters.map((filter) => `${filter.key}=${filter.value}`).join(", ")
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
}: Readonly<{
  definition: TemplateDefinition
  onChange: (next: TemplateDefinition) => void
}>) {
  const typesId = useId()
  const groupsId = useId()
  const tagsId = useId()

  const set = (scope: Partial<ScopeSpec>) => {
    onChange({ ...definition, scope: { ...definition.scope, ...scope } })
  }

  return (
    <div className="flex flex-col gap-4">
      <Field>
        <FieldLabel htmlFor={typesId}>Resource types</FieldLabel>
        <Input
          id={typesId}
          defaultValue={definition.scope.resource_types.join(", ")}
          onBlur={(event) =>
            set({ resource_types: parseList(event.target.value) })
          }
          placeholder="Microsoft.Compute/virtualMachines"
        />
        <FieldDescription>
          Comma separated, fully qualified.{" "}
          <strong>Leave empty for every type</strong> — an empty dimension
          imposes no constraint.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={groupsId}>Resource groups</FieldLabel>
        <Input
          id={groupsId}
          defaultValue={definition.scope.resource_groups.join(", ")}
          onBlur={(event) =>
            set({ resource_groups: parseList(event.target.value) })
          }
          placeholder="rg-prod-sea, rg-prod-eu"
        />
        <FieldDescription>
          Comma separated. Leave empty for every resource group in the
          subscription.
        </FieldDescription>
      </Field>

      <Field>
        <FieldLabel htmlFor={tagsId}>Tag filters</FieldLabel>
        <Input
          id={tagsId}
          defaultValue={formatTagFilters(definition.scope.tag_filters)}
          onBlur={(event) =>
            set({ tag_filters: parseTagFilters(event.target.value) })
          }
          placeholder="env=prod, tier=web"
        />
        <FieldDescription>
          <code>key=value</code>, comma separated. A resource matches if{" "}
          <strong>any</strong> filter matches. Keys are compared ignoring case;
          values are not.
        </FieldDescription>
      </Field>

      <p className="max-w-prose text-xs text-muted-foreground">
        There is no control here for choosing a named resource, and that is
        deliberate: a template stores rules so the same one runs against every
        subscription you connect. A block can narrow this default further — that
        is its scope override, on step 5.
      </p>
    </div>
  )
}
