"use client"

import { useId } from "react"

import { parseList, parseTagFilters } from "@/components/templates/step-scope"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import type { ScopeSpec } from "@/lib/templates/definition"

/**
 * The selected block's `scope_override`, with the inherited default above it
 * (Requirement 12.11).
 *
 * ## Inheriting and narrowed must not look the same
 *
 * The requirement's own words: the inherited template default is displayed
 * **above** the override in `--muted-foreground`, "so that inheriting and
 * narrowed are visually distinct states rather than the same empty field".
 *
 * That is not a styling preference. Without it, a block inheriting
 * `Microsoft.Compute/virtualMachines` and a block overriding it to *nothing*
 * both render an empty Resource types field — and those two are opposites. The
 * first collects VMs; the second, under Requirement 3.12's "an empty dimension
 * imposes no constraint", collects **every resource type in the subscription**.
 * A consultant who cleared the field to narrow the block would widen it to the
 * whole estate, and the report would still verify.
 *
 * So the default is shown as text above each field, and the override's presence
 * is an explicit toggle rather than an inference from emptiness.
 *
 * ## The toggle, not a heuristic
 *
 * `scope_override` is either absent or a whole `ScopeSpec` — the schema has no
 * partial override. Treating "every field blank" as "no override" would make it
 * impossible to express the legitimate override *"this block covers everything,
 * regardless of the template default"*, which is exactly the state above. The
 * checkbox says which of the two the consultant means.
 */

/** How a dimension of the inherited default reads above the field. */
function inheritedLine(values: readonly string[]): string {
  return values.length === 0
    ? "every one — the template default names none"
    : values.join(", ")
}

export function ScopeEditor({
  templateDefault,
  override,
  onChange,
}: Readonly<{
  templateDefault: ScopeSpec
  /** The block's own scope, or `null` when it inherits. */
  override: ScopeSpec | null
  onChange: (next: ScopeSpec | null) => void
}>) {
  const typesId = useId()
  const groupsId = useId()
  const tagsId = useId()
  const toggleId = useId()

  const set = (patch: Partial<ScopeSpec>) => {
    if (override === null) return
    onChange({ ...override, ...patch })
  }

  return (
    <div data-slot="scope-editor" className="flex flex-col gap-3">
      <label htmlFor={toggleId} className="flex items-center gap-2 text-sm">
        <input
          id={toggleId}
          type="checkbox"
          checked={override !== null}
          onChange={(event) =>
            onChange(
              event.target.checked
                ? // Seeded from the template default rather than from empty. An
                  // override that started blank would, on the very next save,
                  // widen the block to the whole subscription — see the module
                  // docstring. Starting from the default makes the first state
                  // of a new override equivalent to inheriting, so the
                  // consultant narrows from there.
                  { ...templateDefault }
                : null
            )
          }
        />
        Narrow this block&rsquo;s scope
      </label>

      {override === null ? (
        <div
          data-slot="inherited-scope"
          className="flex flex-col gap-1 rounded-lg border border-border px-3 py-2"
        >
          <p className="text-xs text-muted-foreground">
            Inheriting the template default:
          </p>

          <dl className="flex flex-col gap-0.5 text-xs text-muted-foreground">
            <div className="flex gap-2">
              <dt>Resource types</dt>
              <dd className="font-mono">
                {inheritedLine(templateDefault.resource_types)}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt>Resource groups</dt>
              <dd className="font-mono">
                {inheritedLine(templateDefault.resource_groups)}
              </dd>
            </div>
            <div className="flex gap-2">
              <dt>Tag filters</dt>
              <dd className="font-mono">
                {templateDefault.tag_filters.length === 0
                  ? "none"
                  : templateDefault.tag_filters
                      .map((filter) => `${filter.key}=${filter.value}`)
                      .join(", ")}
              </dd>
            </div>
          </dl>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Field>
            <FieldLabel htmlFor={typesId}>Resource types</FieldLabel>
            {/*
              Requirement 12.11 — the inherited value **above** the control, in
              muted text, so an empty override field and an inherited value are
              never the same thing on screen.
            */}
            <p
              data-slot="inherited-hint"
              className="text-xs text-muted-foreground"
            >
              Template default: {inheritedLine(templateDefault.resource_types)}
            </p>
            <Input
              id={typesId}
              defaultValue={override.resource_types.join(", ")}
              onBlur={(event) =>
                set({ resource_types: parseList(event.target.value) })
              }
            />
            <FieldDescription>
              Empty means <strong>every type</strong>, not none.
            </FieldDescription>
          </Field>

          <Field>
            <FieldLabel htmlFor={groupsId}>Resource groups</FieldLabel>
            <p
              data-slot="inherited-hint"
              className="text-xs text-muted-foreground"
            >
              Template default: {inheritedLine(templateDefault.resource_groups)}
            </p>
            <Input
              id={groupsId}
              defaultValue={override.resource_groups.join(", ")}
              onBlur={(event) =>
                set({ resource_groups: parseList(event.target.value) })
              }
            />
          </Field>

          <Field>
            <FieldLabel htmlFor={tagsId}>Tag filters</FieldLabel>
            <p
              data-slot="inherited-hint"
              className="text-xs text-muted-foreground"
            >
              Template default:{" "}
              {templateDefault.tag_filters.length === 0
                ? "none"
                : templateDefault.tag_filters
                    .map((filter) => `${filter.key}=${filter.value}`)
                    .join(", ")}
            </p>
            <Input
              id={tagsId}
              defaultValue={override.tag_filters
                .map((filter) => `${filter.key}=${filter.value}`)
                .join(", ")}
              onBlur={(event) =>
                set({ tag_filters: parseTagFilters(event.target.value) })
              }
            />
          </Field>
        </div>
      )}
    </div>
  )
}
