"use client"

import { ScopeEditor } from "@/components/templates/scope-editor"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { BLOCK_CONFIG, type BlockType } from "@/lib/templates/blocks"
import { blockTypeLabel } from "@/lib/templates/composer"
import type {
  LeafBlock,
  ScopeSpec,
  TemplateBlock,
} from "@/lib/templates/definition"

/**
 * The inspector — the selected block's config and its scope override
 * (Requirements 12.1, 12.11).
 *
 * ## The form is generated from `BLOCK_CONFIG`, not hand-written per type
 *
 * Sixteen block types with hand-written forms is sixteen places for a field to
 * be missing, and the failure is invisible: a `top_n_table` whose `count` field
 * the inspector forgot is a block a consultant cannot configure and can still
 * save, which then fails at compile. Reading the field list from `BLOCK_CONFIG`
 * — the same declaration the validator and the mirror guard read — means a field
 * added to the schema appears here without an edit.
 *
 * ## Its limits, stated rather than hidden
 *
 * `BLOCK_CONFIG` is deliberately **shallow**: it declares field *names*,
 * required-ness and enumerated values, not types. So this renders a text input
 * for anything that is not an enum, and a select for anything that is. A field
 * whose real type is a list of metric references gets a text input carrying
 * JSON — which is honest and usable, and is not the finished affordance a
 * consultant deserves for picking metrics.
 *
 * That is a known gap rather than an oversight: the metric-reference picker
 * needs the Metric_Catalog and the definition's own selection together, which is
 * a composition step 4 already performs and this pane would have to repeat. It
 * is worth building; it is not worth blocking the composer on.
 *
 * ## A row has no config, and says so
 *
 * A `row` carries its columns on the block itself (Requirement 6.2), and the
 * reducer refuses a `patchConfig` against one with `row_has_no_config`. The
 * column count is edited on the canvas, by `row-splitter.tsx`, where the row is
 * — so this pane points there rather than offering a second control for it.
 */

/** The two lists `BLOCK_CONFIG` declares for a type, plus its enums. */
function schemaFor(type: BlockType) {
  return BLOCK_CONFIG[type]
}

function fieldValue(
  config: Readonly<Record<string, unknown>>,
  name: string
): string {
  const value = config[name]

  if (value === undefined || value === null) return ""
  if (typeof value === "string") return value
  if (typeof value === "number" || typeof value === "boolean")
    return String(value)

  // A list or an object — rendered as JSON so it is at least editable rather
  // than silently uneditable. See the module docstring's note on the gap.
  return JSON.stringify(value)
}

/**
 * Parse a field back out of its input.
 *
 * A value that parses as JSON becomes that JSON; everything else stays a string.
 * That is what lets the JSON-carrying fields round-trip while a plain heading
 * stays a plain string — and it is why `"2026"` typed into a text field becomes
 * the number `2026`, which the validator will accept or reject on its own terms
 * rather than this component guessing.
 */
function parseFieldValue(raw: string): unknown {
  const trimmed = raw.trim()
  if (trimmed === "") return ""

  if (
    trimmed.startsWith("{") ||
    trimmed.startsWith("[") ||
    trimmed === "true" ||
    trimmed === "false" ||
    /^-?\d+(\.\d+)?$/.test(trimmed)
  ) {
    try {
      return JSON.parse(trimmed) as unknown
    } catch {
      return raw
    }
  }

  return raw
}

export function BlockInspector({
  block,
  templateDefault,
  onPatchConfig,
  onPatchScope,
}: Readonly<{
  block: TemplateBlock | null
  templateDefault: ScopeSpec
  onPatchConfig: (blockId: string, config: Record<string, unknown>) => void
  onPatchScope: (blockId: string, scope: ScopeSpec | null) => void
}>) {
  if (block === null) {
    return (
      <div
        data-slot="block-inspector"
        role="region"
        aria-label="Block inspector"
        className="rounded-xl border border-border px-3 py-3"
      >
        <p className="text-sm text-muted-foreground">
          Select a block on the canvas to configure it.
        </p>
      </div>
    )
  }

  const isRow = block.type === "row"
  const schema = schemaFor(block.type)
  const config = isRow ? {} : (block as LeafBlock).config
  const fields = [...schema.required, ...schema.optional]

  const patch = (name: string, raw: string) => {
    if (isRow) return
    onPatchConfig(block.id, {
      ...(block as LeafBlock).config,
      [name]: parseFieldValue(raw),
    })
  }

  return (
    <div
      data-slot="block-inspector"
      role="region"
      aria-label="Block inspector"
      className="flex flex-col gap-4 rounded-xl border border-border px-3 py-3"
    >
      <div className="flex flex-col gap-0.5">
        <h3 className="font-heading text-sm font-medium tracking-tight">
          {blockTypeLabel(block.type)}
        </h3>
        <p className="font-mono text-xs text-muted-foreground">{block.id}</p>
      </div>

      {isRow ? (
        <p className="text-sm text-muted-foreground">
          A row carries its columns on the block itself, not in a config. Set
          the column count on the row, on the canvas.
        </p>
      ) : fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          This block takes no configuration — everything it prints is derived
          from the snapshot and the pinned version.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {fields.map((name) => {
            const required = (schema.required as readonly string[]).includes(
              name
            )
            const enumValues = (
              schema.enums as Record<string, readonly string[]>
            )[name]

            return (
              <Field key={name}>
                <FieldLabel htmlFor={`${block.id}-${name}`}>
                  <span className="font-mono text-xs">{name}</span>
                  {required ? null : (
                    <span className="text-muted-foreground"> · optional</span>
                  )}
                </FieldLabel>

                {enumValues === undefined ? (
                  <Input
                    id={`${block.id}-${name}`}
                    defaultValue={fieldValue(config, name)}
                    onBlur={(event) => patch(name, event.target.value)}
                  />
                ) : (
                  <select
                    id={`${block.id}-${name}`}
                    value={fieldValue(config, name)}
                    onChange={(event) => patch(name, event.target.value)}
                    className="h-9 w-full rounded-lg border border-input bg-transparent px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    <option value="">—</option>
                    {enumValues.map((value) => (
                      <option key={value} value={value}>
                        {value}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            )
          })}

          <FieldDescription>
            A field carrying a list is edited as JSON for now. The validator
            decides whether the value is acceptable — this pane does not guess.
          </FieldDescription>
        </div>
      )}

      {isRow ? null : (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <h4 className="text-xs font-medium">Scope</h4>

          <ScopeEditor
            templateDefault={templateDefault}
            override={(block as LeafBlock).scope_override ?? null}
            onChange={(next) => onPatchScope(block.id, next)}
          />
        </div>
      )}
    </div>
  )
}
