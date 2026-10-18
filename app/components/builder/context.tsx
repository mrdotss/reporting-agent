"use client"

import { createContext, useContext, useMemo, useState, type ReactNode } from "react"
import { useStore } from "zustand"
import { useStoreWithEqualityFn } from "zustand/traditional"

import { builderIssues, type BuilderIssue } from "@/lib/builder/issues"
import type { DefinitionV4 } from "@/lib/builder/model"
import { createBuilderStore, type BuilderState, type BuilderStore } from "@/lib/builder/store"
import type { MetricCatalogSnapshot } from "@/lib/templates/definition"
import type { PreviewSource } from "@/lib/templates/input"

/**
 * One store per open preset, shared by every panel through context.
 *
 * Created once per mount from the draft the server resolved, so a second preset opened in
 * another tab has its own store and the two cannot leak into each other.
 */

export type BuilderEnvironment = {
  readonly templateId: string
  readonly catalog: MetricCatalogSnapshot
  /** Resource-type counts from the latest scan of a connection of this provider, if any. */
  readonly scanTypeCounts?: Readonly<Record<string, number>>
  /** The fact sources the runtime collects, for which sections can be offered at all. */
  readonly collectedFactSources: readonly string[]
  /** How far back exported metrics reach on that connection (Azure), ISO date or null. */
  readonly metricsHistorySince: string | null
  readonly latestVersion: number | null
  /** The connections Preview PDF can render against: this provider's, with their latest report. */
  readonly previewSources: readonly PreviewSource[]
}

type Context = { store: BuilderStore; environment: BuilderEnvironment }

const BuilderContext = createContext<Context | null>(null)

export function BuilderProvider({
  initial,
  environment,
  children,
}: Readonly<{ initial: DefinitionV4; environment: BuilderEnvironment; children: ReactNode }>) {
  const [store] = useState(() => createBuilderStore({ initial, catalog: environment.catalog }))
  const value = useMemo(() => ({ store, environment }), [store, environment])
  return <BuilderContext.Provider value={value}>{children}</BuilderContext.Provider>
}

function useContextValue(): Context {
  const value = useContext(BuilderContext)
  if (value === null) throw new Error("useBuilder must be used inside <BuilderProvider>")
  return value
}

export function useBuilder<T>(selector: (state: BuilderState) => T): T {
  return useStore(useContextValue().store, selector)
}

export function useBuilderStore(): BuilderStore {
  return useContextValue().store
}

export function useEnvironment(): BuilderEnvironment {
  return useContextValue().environment
}

export function useHistory(): { canUndo: boolean; canRedo: boolean; undo: () => void; redo: () => void } {
  const store = useBuilderStore()
  return useStoreWithEqualityFn(
    store.temporal,
    (state) => ({
      canUndo: state.pastStates.length > 0,
      canRedo: state.futureStates.length > 0,
      undo: state.undo,
      redo: state.redo,
    }),
    (a, b) => a.canUndo === b.canUndo && a.canRedo === b.canRedo
  )
}

export function useIssues(): BuilderIssue[] {
  const definition = useBuilder((state) => state.definition)
  return useMemo(() => builderIssues(definition), [definition])
}
