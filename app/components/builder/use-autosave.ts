"use client"

import { useCallback, useEffect, useRef, useState } from "react"

import { useBuilderStore } from "@/components/builder/context"
import type { DefinitionV4 } from "@/lib/builder/model"

/**
 * The draft saved as it is edited: one `PATCH` a moment after the last change, carrying the
 * revision it was based on so an edit made elsewhere is refused rather than overwritten.
 *
 * The preset's name is the list's name too, so a changed `identity.name` is sent as a rename
 * in the same request.
 */

export type SaveState =
  | { readonly kind: "idle" }
  | { readonly kind: "saving" }
  | { readonly kind: "saved"; readonly at: number }
  | { readonly kind: "failed"; readonly message: string }

const DELAY_MS = 900

export function useAutosave({
  templateId,
  initialRevision,
  initialName,
}: Readonly<{ templateId: string; initialRevision: number; initialName: string }>) {
  const store = useBuilderStore()
  const [state, setState] = useState<SaveState>({ kind: "idle" })
  const revisionRef = useRef(initialRevision)
  const storedName = useRef(initialName)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inFlight = useRef<Promise<boolean> | null>(null)

  const save = useCallback(async (): Promise<boolean> => {
    if (timer.current) {
      clearTimeout(timer.current)
      timer.current = null
    }
    if (inFlight.current) await inFlight.current
    const definition: DefinitionV4 = store.getState().definition
    const name = definition.identity.name.trim()
    const rename = name.length >= 1 && name.length <= 120 && name !== storedName.current
    setState({ kind: "saving" })
    const request = (async () => {
      try {
        const response = await fetch(`/api/report-profiles/${templateId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            draftDefinition: definition,
            expectedRevision: revisionRef.current,
            ...(rename ? { name } : {}),
          }),
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { error?: { message?: string } }
          setState({
            kind: "failed",
            message:
              response.status === 409
                ? "This preset was changed somewhere else. Reload to see the latest before editing."
                : (body.error?.message ?? "The draft was not saved. Nothing you changed is lost."),
          })
          return false
        }
        const saved = (await response.json()) as { template?: { draftRevision?: number } }
        revisionRef.current = saved.template?.draftRevision ?? revisionRef.current
        if (rename) storedName.current = name
        setState({ kind: "saved", at: Date.now() })
        return true
      } catch {
        setState({ kind: "failed", message: "The server could not be reached. Nothing you changed is lost." })
        return false
      }
    })()
    inFlight.current = request
    const ok = await request
    inFlight.current = null
    return ok
  }, [store, templateId])

  useEffect(
    () =>
      store.subscribe((current, previous) => {
        if (current.definition === previous.definition) return
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(() => void save(), DELAY_MS)
      }),
    [save, store]
  )

  // A pending save goes out before the page is left.
  useEffect(() => {
    const flush = () => {
      if (timer.current) void save()
    }
    window.addEventListener("beforeunload", flush)
    return () => window.removeEventListener("beforeunload", flush)
  }, [save])

  return { state, save, revisionRef }
}
