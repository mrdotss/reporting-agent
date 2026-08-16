"use client"

import * as React from "react"
import { MoonIcon, SunIcon } from "@phosphor-icons/react"
import { useTheme } from "next-themes"

import { Button } from "@/components/ui/button"

/**
 * A store that never changes, read to learn whether hydration has happened.
 *
 * `useSyncExternalStore` renders `getServerSnapshot` — `false` — on the server
 * *and* during hydration, then re-renders with `getSnapshot` — `true` — once the
 * tree is live. That is the one thing a `useState` + `useEffect` mounted flag
 * cannot do without calling `setState` inside an effect, which cascades a render
 * and which this project's `react-hooks/set-state-in-effect` rule refuses.
 *
 * `subscribe` returns an unsubscribe function and registers nothing, because the
 * value it reports transitions exactly once and React re-reads it after the
 * hydration commit on its own.
 */
const subscribeToNothing = () => () => {}

const isHydrated = () => true

const isNotHydrated = () => false

/**
 * The light/dark control in the sidebar rail (Requirement 7.8).
 *
 * A `"use client"` leaf, and the smallest one that can be: `useTheme` needs the
 * browser, so this file crosses the boundary and the rest of the shell does not.
 * The Phosphor import is the package's **default** entry, not `/ssr` — this is
 * already a client module, so the client build is the right one.
 *
 * It reuses the existing `next-themes` provider from
 * `components/theme-provider.tsx` rather than adding a second mechanism. That
 * provider also owns the `d` hotkey, and both paths call `setTheme` with the
 * same flip of `resolvedTheme`, so the button and the key cannot disagree about
 * what "toggle" means.
 *
 * ## The icon swap is CSS, not state
 *
 * Both glyphs are always in the markup; `dark:hidden` / `hidden dark:block`
 * decides which one paints. That matters for more than tidiness: `resolvedTheme`
 * is `undefined` until `next-themes` has mounted, so a state-driven swap renders
 * the wrong glyph on the server and corrects it after hydration — a visible
 * flip on every load, and a hydration mismatch if rendered naively. The `.dark`
 * class is applied by the provider's blocking script before first paint, so the
 * CSS swap is already correct when the page appears.
 *
 * ## How the state is announced
 *
 * `aria-pressed` — the ARIA toggle-button pattern — so a screen reader announces
 * "Dark theme, pressed" or "not pressed" and hears the change on activation. An
 * `aria-live` region would be a second, louder mechanism for the same fact.
 *
 * It is deliberately **absent** until the tree has hydrated, and the gate is not
 * optional: `next-themes` returns `resolvedTheme: undefined` on the server but a
 * resolved value on the *first* client render, so an ungated attribute appears
 * during hydration and mismatches the server's markup. Gating on
 * {@link subscribeToNothing} makes the server render and the hydration render
 * identical — no attribute — and adds the real state in the commit after.
 *
 * Until then the button is a plain button named "Dark theme", which is a missing
 * answer rather than a wrong one.
 */
export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme()

  const hydrated = React.useSyncExternalStore(
    subscribeToNothing,
    isHydrated,
    isNotHydrated
  )

  const isDark = resolvedTheme === "dark"

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label="Dark theme"
      aria-pressed={hydrated ? isDark : undefined}
      onClick={() => {
        setTheme(isDark ? "light" : "dark")
      }}
      className="shrink-0 text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent"
    >
      {/*
        `aria-hidden` on both: the button already has a name, and two glyphs in
        the accessible tree would read as two controls. Neither carries a
        `weight`, so both take the `regular` default declared once in
        `components/theme-provider.tsx`.
      */}
      <SunIcon aria-hidden="true" className="dark:hidden" />
      <MoonIcon aria-hidden="true" className="hidden dark:block" />
    </Button>
  )
}
