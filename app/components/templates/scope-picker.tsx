"use client"

import { X } from "@phosphor-icons/react"
import { useCallback, useId, useMemo, useRef, useState } from "react"

import { Input } from "@/components/ui/input"
import type { InventoryDimensions } from "@/lib/subscriptions/inventory-cache"
import {
  looksLikeAzureIdentifier,
  MAX_RESOURCE_GROUPS,
  MAX_RESOURCE_TYPES,
  MAX_TAG_FILTERS,
  RESOURCE_GROUP_MAX_LENGTH,
  RESOURCE_GROUP_MIN_LENGTH,
  RESOURCE_TYPE_MAX_LENGTH,
  TAG_KEY_MAX_LENGTH,
  TAG_KEY_MIN_LENGTH,
  TAG_VALUE_MAX_LENGTH,
} from "@/lib/templates/definition"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The four option kinds the spec requires. Each maps to a distinct stored shape.
 */
export type OptionKind =
  | "resource_type"
  | "resource_group"
  | "tag_key"
  | "tag_key_value"

/** One selectable option. `absent` means the inventory did not list it. */
export type ScopeOption = {
  readonly kind: OptionKind
  /** The display value. For tag_key_value, `${key}=${value}`. */
  readonly display: string
  /** Whether this option is in the current inventory response. */
  readonly present: boolean
}

/** The stored scope shape (matches ScopeSpec). */
export type ScopePickerValue = {
  readonly resource_types: readonly string[]
  readonly resource_groups: readonly string[]
  readonly tag_filters: readonly { key: string; value: string }[]
}

// ---------------------------------------------------------------------------
// Case folding — mirrors compile/scope.py
// ---------------------------------------------------------------------------

/**
 * Resource types and tag keys: case-insensitive (one option per case-folded key).
 * Tag values: case-sensitive (distinct options).
 */
function foldResourceType(v: string): string {
  return v.toLowerCase()
}
function foldTagKey(v: string): string {
  return v.toLowerCase()
}

// ---------------------------------------------------------------------------
// Deduplication helpers
// ---------------------------------------------------------------------------

/** Deduplicate by case-insensitive key, keeping the first occurrence. */
function deduplicateCaseInsensitive(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const v of values) {
    const folded = v.toLowerCase()
    if (!seen.has(folded)) {
      seen.add(folded)
      result.push(v)
    }
  }
  return result
}

// ---------------------------------------------------------------------------
// Validation helpers (same bounds as definition.ts's validator)
// ---------------------------------------------------------------------------

type ValidationResult = { valid: true } | { valid: false; message: string }

function validateResourceType(value: string): ValidationResult {
  if (value.length < 1 || value.length > RESOURCE_TYPE_MAX_LENGTH) {
    return {
      valid: false,
      message: `Resource type must be 1 to ${RESOURCE_TYPE_MAX_LENGTH} characters.`,
    }
  }
  if (looksLikeAzureIdentifier(value)) {
    return {
      valid: false,
      message:
        "This looks like a resource identifier, subscription id, or tenant id — a scope stores rules, not resource identifiers.",
    }
  }
  return { valid: true }
}

function validateResourceGroup(value: string): ValidationResult {
  if (
    value.length < RESOURCE_GROUP_MIN_LENGTH ||
    value.length > RESOURCE_GROUP_MAX_LENGTH
  ) {
    return {
      valid: false,
      message: `Resource group must be ${RESOURCE_GROUP_MIN_LENGTH} to ${RESOURCE_GROUP_MAX_LENGTH} characters.`,
    }
  }
  if (looksLikeAzureIdentifier(value)) {
    return {
      valid: false,
      message:
        "This looks like a resource identifier, subscription id, or tenant id — a scope stores rules, not resource identifiers.",
    }
  }
  return { valid: true }
}

function validateTagKey(value: string): ValidationResult {
  if (
    value.length < TAG_KEY_MIN_LENGTH ||
    value.length > TAG_KEY_MAX_LENGTH
  ) {
    return {
      valid: false,
      message: `Tag key must be ${TAG_KEY_MIN_LENGTH} to ${TAG_KEY_MAX_LENGTH} characters.`,
    }
  }
  if (looksLikeAzureIdentifier(value)) {
    return {
      valid: false,
      message:
        "This looks like a resource identifier, subscription id, or tenant id.",
    }
  }
  return { valid: true }
}

function validateTagValue(value: string): ValidationResult {
  if (value.length > TAG_VALUE_MAX_LENGTH) {
    return {
      valid: false,
      message: `Tag value must be at most ${TAG_VALUE_MAX_LENGTH} characters.`,
    }
  }
  if (looksLikeAzureIdentifier(value)) {
    return {
      valid: false,
      message:
        "This looks like a resource identifier, subscription id, or tenant id.",
    }
  }
  return { valid: true }
}

// ---------------------------------------------------------------------------
// Option computation
// ---------------------------------------------------------------------------

/**
 * Builds the selectable options for one dimension, merging the stored values with
 * the inventory response.
 *
 * **The picker never writes.** It renders stored values as selected whether or not
 * the inventory response contains them, marks absent ones, and removes only on
 * explicit removal.
 */
function buildOptions(
  kind: "resource_type" | "resource_group",
  stored: readonly string[],
  inventoryValues: readonly string[] | undefined
): ScopeOption[] {
  const fold = kind === "resource_type" ? foldResourceType : foldResourceType // both case-insensitive
  const inventoryFolded = new Set(
    (inventoryValues ?? []).map((v) => fold(v))
  )

  // Start with stored values (always present, always selected)
  const seen = new Set<string>()
  const options: ScopeOption[] = []

  for (const v of stored) {
    const folded = fold(v)
    if (seen.has(folded)) continue
    seen.add(folded)
    options.push({
      kind,
      display: v,
      present: inventoryFolded.has(folded),
    })
  }

  // Add inventory values not already stored
  for (const v of inventoryValues ?? []) {
    const folded = fold(v)
    if (seen.has(folded)) continue
    seen.add(folded)
    options.push({ kind, display: v, present: true })
  }

  return options
}

/**
 * Build tag options. Tags are more complex: a key alone stores `{key, value: ""}`,
 * meaning "carries this tag"; a key+value stores both.
 *
 * Case folding: tag keys are case-insensitive (one option per folded key),
 * tag values are case-sensitive.
 */
function buildTagOptions(
  stored: readonly { key: string; value: string }[],
  inventoryKeys: readonly string[] | undefined
): ScopeOption[] {
  // Build a lookup of what's available in inventory
  const inventoryKeyFolded = new Set(
    (inventoryKeys ?? []).map((k) => foldTagKey(k))
  )

  // For keys, deduplicate case-insensitively
  const seenKeys = new Set<string>()
  const keyOptions: ScopeOption[] = []

  // Show stored key-only entries (value === "")
  for (const filter of stored) {
    if (filter.value !== "") continue
    const folded = foldTagKey(filter.key)
    if (seenKeys.has(folded)) continue
    seenKeys.add(folded)
    keyOptions.push({
      kind: "tag_key",
      display: filter.key,
      present: inventoryKeyFolded.has(folded),
    })
  }

  // Add inventory keys not already stored
  for (const k of inventoryKeys ?? []) {
    const folded = foldTagKey(k)
    if (seenKeys.has(folded)) continue
    seenKeys.add(folded)
    keyOptions.push({ kind: "tag_key", display: k, present: true })
  }

  // For key=value pairs (value !== ""), show as tag_key_value options
  // Tag values are case-sensitive → distinct options
  const seenPairs = new Set<string>()
  const pairOptions: ScopeOption[] = []

  for (const filter of stored) {
    if (filter.value === "") continue
    const pairKey = `${foldTagKey(filter.key)}=${filter.value}`
    if (seenPairs.has(pairKey)) continue
    seenPairs.add(pairKey)
    pairOptions.push({
      kind: "tag_key_value",
      display: `${filter.key}=${filter.value}`,
      present: inventoryKeyFolded.has(foldTagKey(filter.key)),
    })
  }

  return [...keyOptions, ...pairOptions]
}

// ---------------------------------------------------------------------------
// DimensionPicker — the sub-component for one dimension
// ---------------------------------------------------------------------------

type DimensionPickerProps = {
  readonly label: string
  readonly description: string
  readonly emptyDescription: string
  readonly placeholder: string
  readonly options: ScopeOption[]
  readonly selected: readonly string[]
  readonly onAdd: (value: string) => ValidationResult | undefined
  readonly onRemove: (value: string) => void
  readonly maxItems: number
  readonly foldForMatch: (v: string) => string
}

function DimensionPicker({
  label,
  description,
  emptyDescription,
  placeholder,
  options,
  selected,
  onAdd,
  onRemove,
  maxItems,
  foldForMatch,
}: DimensionPickerProps) {
  const inputId = useId()
  const listboxId = useId()
  const announceId = useId()
  const [inputValue, setInputValue] = useState("")
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const selectedFolded = useMemo(
    () => new Set(selected.map(foldForMatch)),
    [selected, foldForMatch]
  )

  const isSelected = useCallback(
    (display: string) => selectedFolded.has(foldForMatch(display)),
    [selectedFolded, foldForMatch]
  )

  const [announcement, setAnnouncement] = useState("")

  const handleSelect = useCallback(
    (display: string) => {
      if (isSelected(display)) return
      if (selected.length >= maxItems) {
        setError(`At most ${maxItems} entries allowed.`)
        return
      }
      const result = onAdd(display)
      if (result && !result.valid) {
        setError(result.message)
      } else {
        setError(null)
        setAnnouncement(`${display} added.`)
      }
    },
    [isSelected, selected.length, maxItems, onAdd]
  )

  const handleRemove = useCallback(
    (display: string) => {
      onRemove(display)
      setAnnouncement(`${display} removed.`)
    },
    [onRemove]
  )

  const handleFreeEntry = useCallback(() => {
    const trimmed = inputValue.trim()
    if (trimmed === "") return
    if (isSelected(trimmed)) {
      // Duplicate — one entry not two
      setInputValue("")
      return
    }
    if (selected.length >= maxItems) {
      setError(`At most ${maxItems} entries allowed.`)
      return
    }
    const result = onAdd(trimmed)
    if (result && !result.valid) {
      setError(result.message)
    } else {
      setError(null)
      setInputValue("")
      setAnnouncement(`${trimmed} added.`)
    }
  }, [inputValue, isSelected, selected.length, maxItems, onAdd])

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault()
        handleFreeEntry()
      }
    },
    [handleFreeEntry]
  )

  // Filter options to those matching the current input text
  const filteredOptions = useMemo(() => {
    const term = inputValue.toLowerCase()
    if (term === "") return options
    return options.filter((opt) => opt.display.toLowerCase().includes(term))
  }, [options, inputValue])

  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={inputId} className="text-sm font-medium text-foreground">
        {label}
      </label>

      {/* Selected values as removable chips */}
      {selected.length > 0 && (
        <div
          className="flex flex-wrap gap-1.5"
          role="list"
          aria-label={`Selected ${label.toLowerCase()}`}
        >
          {selected.map((value) => {
            const opt = options.find(
              (o) => foldForMatch(o.display) === foldForMatch(value)
            )
            const present = opt?.present ?? false
            return (
              <span
                key={value}
                role="listitem"
                className={`inline-flex items-center gap-1 rounded-4xl border px-2.5 py-0.5 text-xs font-medium ${
                  present
                    ? "border-border bg-muted text-foreground"
                    : "border-border bg-muted text-muted-foreground italic"
                }`}
              >
                {value}
                {!present && (
                  <span className="text-[10px]">(not in this subscription)</span>
                )}
                <button
                  type="button"
                  onClick={() => handleRemove(value)}
                  className="ml-0.5 inline-flex items-center rounded-full p-0.5 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  aria-label={`Remove ${value}`}
                >
                  <X size={12} weight="bold" />
                </button>
              </span>
            )
          })}
        </div>
      )}

      {/* Free entry input */}
      <div className="relative">
        <Input
          ref={inputRef}
          id={inputId}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value)
            setError(null)
          }}
          onKeyDown={handleKeyDown}
          onBlur={handleFreeEntry}
          placeholder={placeholder}
          aria-controls={listboxId}
          aria-describedby={announceId}
          className="w-full"
        />
      </div>

      {error && (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      )}

      {/* Option list from inventory */}
      {filteredOptions.length > 0 && (
        <ul
          id={listboxId}
          role="listbox"
          aria-label={`Available ${label.toLowerCase()}`}
          className="max-h-48 overflow-y-auto rounded-lg border border-border bg-background"
        >
          {filteredOptions.map((opt) => {
            const sel = isSelected(opt.display)
            return (
              <li
                key={`${opt.kind}:${opt.display}`}
                role="option"
                aria-selected={sel}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault()
                    if (sel) handleRemove(opt.display)
                    else handleSelect(opt.display)
                  }
                }}
                onClick={() => {
                  if (sel) handleRemove(opt.display)
                  else handleSelect(opt.display)
                }}
                className={`flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                  sel
                    ? "bg-primary/10 text-foreground"
                    : "hover:bg-accent text-foreground"
                } ${!opt.present ? "italic text-muted-foreground" : ""}`}
              >
                <span
                  className={`inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border ${
                    sel
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-border"
                  }`}
                  aria-hidden="true"
                >
                  {sel && (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  )}
                </span>
                <span className="flex-1 truncate">{opt.display}</span>
                {!opt.present && (
                  <span className="shrink-0 text-[10px] text-muted-foreground">
                    not present
                  </span>
                )}
              </li>
            )
          })}
        </ul>
      )}

      <p className="text-xs text-muted-foreground">
        {description}{" "}
        <strong>{emptyDescription}</strong>
      </p>

      {/* aria-live announcer for selections/removals */}
      <div
        id={announceId}
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ScopePicker — the main export
// ---------------------------------------------------------------------------

export type ScopePickerProps = {
  readonly value: ScopePickerValue
  readonly onChange: (next: ScopePickerValue) => void
  /**
   * The inventory dimensions from the selected subscription, or undefined if no
   * subscription is selected or the endpoint is unavailable. The picker never writes
   * and records nothing identifying the subscription.
   */
  readonly inventory: InventoryDimensions | undefined
  /**
   * If set, explains why inventory is unavailable (endpoint error, no subscription
   * selected, etc.). Shown as a hint above the free-entry controls.
   */
  readonly inventoryUnavailableReason?: string
}

/**
 * The scope picker for the template wizard's step 2 (Requirements 9.5, 9.6, 9.7,
 * 10.1–10.11).
 *
 * ## The four option kinds → four stored shapes
 *
 * - **resource type** → `scope.resource_types` (string)
 * - **resource group** → `scope.resource_groups` (string)
 * - **tag key alone** → `scope.tag_filters` entry with `{ key, value: "" }` (a
 *   zero-length value means "carries this tag" — no wildcard token invented)
 * - **tag key + value** → `scope.tag_filters` entry with `{ key, value }`
 *
 * ## The picker never writes
 *
 * It renders stored values as selected whether or not the inventory response
 * contains them, marks absent ones as "not present in this subscription", and
 * removes a value only on explicit removal. Opening a template against a second
 * subscription's inventory edits no rule.
 *
 * ## Case folding follows compile/scope.py
 *
 * - Resource types and tag **keys** differing only by case = ONE option
 * - Tag **values** differing by case = DISTINCT options
 *
 * ## Records nothing identifying the subscription.
 */
export function ScopePicker({
  value,
  onChange,
  inventory,
  inventoryUnavailableReason,
}: ScopePickerProps) {
  // Build options for each dimension
  const typeOptions = useMemo(
    () =>
      buildOptions(
        "resource_type",
        value.resource_types,
        inventory?.resource_types.values
      ),
    [value.resource_types, inventory?.resource_types.values]
  )

  const groupOptions = useMemo(
    () =>
      buildOptions(
        "resource_group",
        value.resource_groups,
        inventory?.resource_groups.values
      ),
    [value.resource_groups, inventory?.resource_groups.values]
  )

  const tagOptions = useMemo(
    () =>
      buildTagOptions(
        value.tag_filters,
        inventory?.tag_keys.values
      ),
    [
      value.tag_filters,
      inventory?.tag_keys.values,
    ]
  )

  // Handlers for resource types
  const addResourceType = useCallback(
    (v: string): ValidationResult | undefined => {
      const result = validateResourceType(v)
      if (!result.valid) return result
      // Deduplicate case-insensitively
      const existing = value.resource_types.map(foldResourceType)
      if (existing.includes(foldResourceType(v))) return undefined
      onChange({
        ...value,
        resource_types: [...value.resource_types, v],
      })
      return undefined
    },
    [value, onChange]
  )

  const removeResourceType = useCallback(
    (v: string) => {
      const folded = foldResourceType(v)
      onChange({
        ...value,
        resource_types: value.resource_types.filter(
          (t) => foldResourceType(t) !== folded
        ),
      })
    },
    [value, onChange]
  )

  // Handlers for resource groups
  const addResourceGroup = useCallback(
    (v: string): ValidationResult | undefined => {
      const result = validateResourceGroup(v)
      if (!result.valid) return result
      const existing = value.resource_groups.map(foldResourceType)
      if (existing.includes(foldResourceType(v))) return undefined
      onChange({
        ...value,
        resource_groups: [...value.resource_groups, v],
      })
      return undefined
    },
    [value, onChange]
  )

  const removeResourceGroup = useCallback(
    (v: string) => {
      const folded = foldResourceType(v)
      onChange({
        ...value,
        resource_groups: value.resource_groups.filter(
          (g) => foldResourceType(g) !== folded
        ),
      })
    },
    [value, onChange]
  )

  // Handlers for tag filters
  const addTagFilter = useCallback(
    (display: string): ValidationResult | undefined => {
      const eqIdx = display.indexOf("=")
      let key: string
      let tagValue: string
      if (eqIdx === -1) {
        // Tag key alone → { key, value: "" }
        key = display.trim()
        tagValue = ""
      } else {
        key = display.slice(0, eqIdx).trim()
        tagValue = display.slice(eqIdx + 1).trim()
      }

      // Validate key
      const keyResult = validateTagKey(key)
      if (!keyResult.valid) return keyResult

      // Validate value
      if (tagValue !== "") {
        const valResult = validateTagValue(tagValue)
        if (!valResult.valid) return valResult
      }

      // Deduplicate: key is case-insensitive, value is case-sensitive
      const foldedKey = foldTagKey(key)
      const duplicate = value.tag_filters.some(
        (f) => foldTagKey(f.key) === foldedKey && f.value === tagValue
      )
      if (duplicate) return undefined

      onChange({
        ...value,
        tag_filters: [...value.tag_filters, { key, value: tagValue }],
      })
      return undefined
    },
    [value, onChange]
  )

  const removeTagFilter = useCallback(
    (display: string) => {
      const eqIdx = display.indexOf("=")
      let key: string
      let tagValue: string
      if (eqIdx === -1) {
        key = display.trim()
        tagValue = ""
      } else {
        key = display.slice(0, eqIdx).trim()
        tagValue = display.slice(eqIdx + 1).trim()
      }
      const foldedKey = foldTagKey(key)
      onChange({
        ...value,
        tag_filters: value.tag_filters.filter(
          (f) => !(foldTagKey(f.key) === foldedKey && f.value === tagValue)
        ),
      })
    },
    [value, onChange]
  )

  // Derive selected lists for each dimension
  const selectedTypes = useMemo(
    () => deduplicateCaseInsensitive(value.resource_types as string[]),
    [value.resource_types]
  )

  const selectedGroups = useMemo(
    () => deduplicateCaseInsensitive(value.resource_groups as string[]),
    [value.resource_groups]
  )

  const selectedTags = useMemo(() => {
    const results: string[] = []
    const seen = new Set<string>()
    for (const f of value.tag_filters) {
      const display = f.value === "" ? f.key : `${f.key}=${f.value}`
      const dedupKey = `${foldTagKey(f.key)}=${f.value}`
      if (seen.has(dedupKey)) continue
      seen.add(dedupKey)
      results.push(display)
    }
    return results
  }, [value.tag_filters])

  const showUnavailableHint =
    inventoryUnavailableReason || inventory === undefined

  return (
    <div className="flex flex-col gap-6">
      {showUnavailableHint && (
        <p className="rounded-lg border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
          {inventoryUnavailableReason ??
            "No subscription is selected — enter values directly below."}{" "}
          Stored values are retained.
        </p>
      )}

      <DimensionPicker
        label="Resource types"
        description="Comma separated, fully qualified."
        emptyDescription="Leave empty for every type — an empty dimension imposes no constraint."
        placeholder="Microsoft.Compute/virtualMachines"
        options={typeOptions}
        selected={selectedTypes}
        onAdd={addResourceType}
        onRemove={removeResourceType}
        maxItems={MAX_RESOURCE_TYPES}
        foldForMatch={foldResourceType}
      />

      <DimensionPicker
        label="Resource groups"
        description="Leave empty for every resource group in the subscription."
        emptyDescription="An empty dimension imposes no constraint and collects every value."
        placeholder="rg-prod-sea"
        options={groupOptions}
        selected={selectedGroups}
        onAdd={addResourceGroup}
        onRemove={removeResourceGroup}
        maxItems={MAX_RESOURCE_GROUPS}
        foldForMatch={foldResourceType}
      />

      <DimensionPicker
        label="Tag filters"
        description="key=value (comma separated). A resource matches if any filter matches. Keys compared ignoring case; values are not."
        emptyDescription="An empty dimension imposes no constraint."
        placeholder="env=prod"
        options={tagOptions}
        selected={selectedTags}
        onAdd={addTagFilter}
        onRemove={removeTagFilter}
        maxItems={MAX_TAG_FILTERS}
        foldForMatch={(v: string) => {
          // For tags: key is case-insensitive, value is case-sensitive
          const eqIdx = v.indexOf("=")
          if (eqIdx === -1) return foldTagKey(v) + "="
          return foldTagKey(v.slice(0, eqIdx)) + "=" + v.slice(eqIdx + 1)
        }}
      />

      <p className="max-w-prose text-xs text-muted-foreground">
        There is no control here for choosing a named resource, and that is
        deliberate: a template stores rules so the same one runs against every
        subscription you connect. A block can narrow this default further — that
        is its scope override, on step 5.
      </p>
    </div>
  )
}
