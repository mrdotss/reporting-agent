"use client"

import * as React from "react"
import { IconContext, type IconProps } from "@phosphor-icons/react"
import { ThemeProvider as NextThemesProvider, useTheme } from "next-themes"

/**
 * The Phosphor defaults, declared **once** (Requirement 7.8).
 *
 * A module constant rather than an inline object, so the context value is
 * referentially stable and a re-render of this provider does not invalidate every
 * icon below it.
 *
 * The values are exactly what the package's SSR build hardcodes, and that is the
 * whole reason to state them. `IconContext` is read by `IconBase` — the **client**
 * build, i.e. `@phosphor-icons/react` — while `SSRBase`, behind
 * `@phosphor-icons/react/ssr`, ignores context entirely and applies
 * `currentColor` / `1em` / `regular` / not-mirrored of its own. Since `rsc: true`
 * means most icons in this app come from `/ssr`, a provider carrying anything
 * else would style only *some* icons and the two halves of the app would quietly
 * disagree. Pinning the client defaults to the SSR build's constants is what
 * keeps them from drifting apart if a future Phosphor release changes
 * `IconBase`'s fallbacks.
 *
 * So per-icon `weight` stays meaningful — `fill` marks an active item, and
 * everything else inherits `regular` from here — and sizing is done with
 * Tailwind's `size-*`, which overrides the `1em` attribute in CSS. That is how
 * `components/ui/button.tsx` already sizes its glyphs.
 */
const ICON_DEFAULTS: IconProps = {
  color: "currentColor",
  size: "1em",
  weight: "regular",
  mirrored: false,
}

function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      {...props}
    >
      <ThemeHotkey />

      {/*
        Hosted here rather than in a provider of its own: `IconContext` is a React
        context, so it needs a client component, and this is already the one
        client boundary the root layout wraps the whole tree in. A second
        top-level provider would add a file and a nesting level to declare four
        values.
      */}
      <IconContext.Provider value={ICON_DEFAULTS}>
        {children}
      </IconContext.Provider>
    </NextThemesProvider>
  )
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) {
    return false
  }

  return (
    target.isContentEditable ||
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT"
  )
}

function ThemeHotkey() {
  const { resolvedTheme, setTheme } = useTheme()

  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.repeat) {
        return
      }

      if (event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      if (event.key.toLowerCase() !== "d") {
        return
      }

      if (isTypingTarget(event.target)) {
        return
      }

      setTheme(resolvedTheme === "dark" ? "light" : "dark")
    }

    window.addEventListener("keydown", onKeyDown)

    return () => {
      window.removeEventListener("keydown", onKeyDown)
    }
  }, [resolvedTheme, setTheme])

  return null
}

export { ThemeProvider }
