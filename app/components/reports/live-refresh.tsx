"use client"

import { useEffect } from "react"
import { useRouter } from "next/navigation"

/**
 * Re-reads a server-rendered page on an interval while something on it is still moving.
 *
 * The reports list is a server component: its rows come from SQL, not from a stream, so
 * a run in flight would otherwise read "In flight" until somebody reloaded. While
 * `active` is true this refreshes the route every `intervalMs`; once nothing is in flight
 * the page stops asking. A hidden tab is skipped, so a list left open in the background
 * costs nothing.
 */
export function LiveRefresh({
  active,
  intervalMs = 8000,
}: Readonly<{ active: boolean; intervalMs?: number }>) {
  const router = useRouter()

  useEffect(() => {
    if (!active) return
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") router.refresh()
    }, intervalMs)
    return () => window.clearInterval(timer)
  }, [active, intervalMs, router])

  return null
}
