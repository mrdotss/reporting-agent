"use client"

import { createContext, useContext } from "react"

/**
 * What a figure chip needs to be clickable: its number in the answer, which figure is open
 * in the trace panel, and how to open one. An answer rendered without a provider (a streaming
 * turn, a test) draws plain chips that only show their tooltip.
 */
export type FigureTrace = {
  readonly numbers: ReadonlyMap<string, number>
  readonly selectedId: string | null
  readonly onSelect: (factId: string) => void
}

const FigureTraceContext = createContext<FigureTrace | null>(null)

export const FigureTraceProvider = FigureTraceContext.Provider

export function useFigureTrace(): FigureTrace | null {
  return useContext(FigureTraceContext)
}
