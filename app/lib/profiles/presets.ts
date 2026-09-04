/**
 * Section metric presets, expanded to concrete metric items (Requirement 10.3).
 *
 * ## Why a preset is expanded at SAVE time and never stored by name
 *
 * A stored `preset: "standard_utilization"` would have to be resolved at compile
 * time, and the only catalogue available then is the one the running image ships:
 * `load_catalog()` reads a file baked into the container, and there is no per-run
 * catalogue pinning. Replay recompiles a **pinned** template version and demands a
 * byte-identical figure ledger, so editing a preset's metric set later would make
 * every previously-delivered report replay against a different set and fail
 * `REPLAY_MISMATCH` — retroactively, on documents that were correct when they were
 * issued. `catalog_version` on the snapshot records which catalogue ran; it does
 * not make `load_catalog()` return that one.
 *
 * So the preset is a UI tier, not a stored value: choosing one writes its metrics
 * into the section's own `metrics[]`, and the pinned version stays self-contained —
 * the same reasoning that pins a profile's own design values into the stored version
 * rather than dereferencing anything at render.
 *
 * **There is deliberately no `preset` key in the stored schema.** Which preset a
 * section currently matches is *derived* by comparing its metrics against the
 * catalogue ({@link matchPresetName}), so no field exists for a future reader to
 * wire into compile and reintroduce the replay hazard.
 *
 * ## What `"*"` ("Everything") expands to
 *
 * Every metric the Metric_Catalog declares for the section's resource types, at
 * that metric's **exact** statistics only — never a percentile. Two reasons, and
 * the first is the binding one:
 *
 * - Requirement 10.5 sets the picker's statistic set at Average / Maximum /
 *   Minimum. A percentile enters a selection only through Requirement 10.7's
 *   explicit path, which copies the catalogue's `estimator` and `fidelity_tier`
 *   onto that entry. "Everything" is a default, and a default that silently
 *   requested `p95` would put estimated percentiles into reports nobody asked for
 *   them in — the exact figure `azure-integration.md` warns makes an
 *   over-provisioned VM look right-sized.
 * - It keeps the expansion inside {@link MAX_METRIC_ITEMS_PER_ENTRY}. Percentiles
 *   would roughly double it.
 *
 * `"*"` had **no consumer anywhere** before this module — the agent's catalogue
 * loader validated presets and nothing ever read them — so this is the definition,
 * not a re-statement of one.
 */

import {
  MAX_METRIC_ITEMS_PER_ENTRY,
  type MetricCatalogSnapshot,
  type MetricSelectionItem,
} from "@/lib/templates/definition"

/** The catalogue fields preset expansion needs, structurally. */
export type PresetBearingEntry = {
  readonly key: string
  readonly needs_resource_types: readonly string[]
  readonly presets: Readonly<
    Record<
      string,
      readonly { readonly metric: string; readonly statistic: string }[] | "*"
    >
  >
}

/** One preset, expanded against the Metric_Catalog. */
export type ExpandedPreset = {
  /** The catalogue's own key, e.g. `standard_utilization`. */
  readonly name: string
  /** The label Requirement 10.3 names, e.g. `Standard utilization`. */
  readonly label: string
  readonly metrics: readonly MetricSelectionItem[]
}

/**
 * Requirement 10.3's labels, for the keys the catalogue actually declares.
 *
 * A key with no entry here falls back to a readable form of the key itself rather
 * than being hidden: a preset added to the catalogue should appear in the wizard
 * on the next deploy, not wait for this map to be updated.
 */
const PRESET_LABELS: Readonly<Record<string, string>> = {
  standard_utilization: "Standard utilization",
  capacity_planning: "Capacity planning",
  everything: "Everything",
}

/**
 * The preset a new section starts on.
 *
 * `standard_utilization` when the entry declares it — it is the reviewed default
 * and the first tier Requirement 10.3 lists — otherwise the entry's first declared
 * preset, so a metric-bearing section always starts with metrics rather than with
 * an empty selection that collects nothing.
 */
export const DEFAULT_PRESET_NAME = "standard_utilization"

function labelFor(name: string): string {
  const known = PRESET_LABELS[name]
  if (known !== undefined) return known
  const spaced = name.replaceAll("_", " ")
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

/** A stable identity for one metric item, for de-duplication and comparison. */
function itemKey(item: MetricSelectionItem): string {
  return `${item.metric ?? `derived:${item.derived ?? ""}`}\u0000${item.statistic}`
}

function resourceTypesFor(entry: PresetBearingEntry): readonly string[] {
  // A metric-bearing entry that declares no resource types has nothing to key its
  // metrics against, so it expands to nothing rather than to every type in the
  // catalogue — which would request the whole estate for one section.
  return entry.needs_resource_types
}

/**
 * Expand one named preset into concrete metric items.
 *
 * Returns `[]` when the preset is not declared, and drops any item the catalogue
 * does not declare for the section's resource types: the agent's catalogue loader
 * already rejects a preset naming an undeclared metric at load, so a miss here
 * means the two catalogues have drifted, and writing the item anyway would store a
 * selection `validateMetricSelectionAgainstCatalog` then refuses at publish.
 */
export function expandPreset(
  entry: PresetBearingEntry,
  presetName: string,
  catalog: MetricCatalogSnapshot
): readonly MetricSelectionItem[] {
  const declared = entry.presets[presetName]
  if (declared === undefined) return []

  const resourceTypes = resourceTypesFor(entry)
  if (resourceTypes.length === 0) return []

  const folded = new Set(resourceTypes.map((t) => t.toLowerCase()))
  const types = catalog.filter((rt) =>
    folded.has(rt.resourceType.toLowerCase())
  )

  const out: MetricSelectionItem[] = []
  const seen = new Set<string>()

  const push = (item: MetricSelectionItem) => {
    const key = itemKey(item)
    if (seen.has(key)) return
    seen.add(key)
    out.push(item)
  }

  if (declared === "*") {
    // Catalogue order throughout, because the stored definition is hashed for the
    // unchanged-digest comparison and a set-order-dependent expansion would make
    // two identical choices produce two versions.
    for (const rt of types) {
      for (const catalogEntry of rt.entries) {
        const percentileKeys = new Set(Object.keys(catalogEntry.percentiles))
        for (const statistic of catalogEntry.statistics) {
          if (percentileKeys.has(statistic)) continue
          push(
            catalogEntry.kind === "derived"
              ? { derived: catalogEntry.name, statistic }
              : { metric: catalogEntry.name, statistic }
          )
        }
      }
    }
    return out
  }

  for (const declaredItem of declared) {
    for (const rt of types) {
      const catalogEntry = rt.entries.find(
        (candidate) => candidate.name === declaredItem.metric
      )
      if (catalogEntry === undefined) continue
      if (!catalogEntry.statistics.includes(declaredItem.statistic)) continue

      const percentile = catalogEntry.percentiles[declaredItem.statistic]

      push({
        ...(catalogEntry.kind === "derived"
          ? { derived: catalogEntry.name }
          : { metric: catalogEntry.name }),
        statistic: declaredItem.statistic,
        // Requirement 10.7 — a percentile carries the catalogue's own estimator and
        // fidelity tier, copied rather than composed, so no surface can produce a
        // bare `p95`. `capacity_planning` declares one, so this is a live path.
        ...(percentile === undefined
          ? {}
          : {
              estimator: percentile.estimator,
              fidelity_tier: percentile.fidelityTier,
            }),
      })
    }
  }

  return out
}

/**
 * Every preset the entry declares, expanded, in catalogue-declared order.
 *
 * A preset whose expansion would exceed {@link MAX_METRIC_ITEMS_PER_ENTRY} is
 * **omitted**, not truncated: a truncated "Everything" is a silent lie about what
 * the report covers, and the validator would refuse the definition anyway. The
 * omission is visible — the preset simply does not appear as a choice.
 */
export function expandPresets(
  entry: PresetBearingEntry,
  catalog: MetricCatalogSnapshot
): readonly ExpandedPreset[] {
  const out: ExpandedPreset[] = []

  for (const name of Object.keys(entry.presets)) {
    const metrics = expandPreset(entry, name, catalog)
    if (metrics.length === 0) continue
    if (metrics.length > MAX_METRIC_ITEMS_PER_ENTRY) continue
    out.push({ name, label: labelFor(name), metrics })
  }

  return out
}

/**
 * Which preset a section's current metrics match, or `null` for `Custom`.
 *
 * Compared as a SET of `(metric|derived, statistic)` pairs, ignoring order and
 * ignoring the percentile metadata: order is an artifact of expansion, and
 * `estimator`/`fidelity_tier` are copied from the catalogue rather than chosen, so
 * two selections differing only in those are the same author decision.
 */
export function matchPresetName(
  metrics: readonly MetricSelectionItem[],
  presets: readonly ExpandedPreset[]
): string | null {
  const actual = new Set(metrics.map(itemKey))

  for (const preset of presets) {
    if (preset.metrics.length !== actual.size) continue
    if (preset.metrics.every((item) => actual.has(itemKey(item)))) {
      return preset.name
    }
  }

  return null
}
