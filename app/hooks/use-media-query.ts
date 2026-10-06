import { useSyncExternalStore } from "react"

/**
 * Whether a media query matches. The server and the first client render report `false`, so a
 * layout that needs the answer to choose between two components should treat `false` as
 * "the narrow one". An environment with no `matchMedia` (a test's document) reports `false`
 * and never changes.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (notify) => {
      if (typeof window.matchMedia !== "function") return () => {}
      const list = window.matchMedia(query)
      list.addEventListener("change", notify)
      return () => list.removeEventListener("change", notify)
    },
    () =>
      typeof window.matchMedia === "function"
        ? window.matchMedia(query).matches
        : false,
    () => false
  )
}
