"use client"

import { useState } from "react"

import { Input } from "@/components/ui/input"

/**
 * A password input with a Show / Hide toggle inside its right edge.
 *
 * The toggle is a plain `type="button"`, so it never submits, and its name says what a
 * press will do. Every other prop goes to the input, which keeps its id, name,
 * autocomplete and aria wiring exactly as the form set them.
 */
export function PasswordInput(props: Readonly<Omit<React.ComponentProps<"input">, "type">>) {
  const [shown, setShown] = useState(false)
  return (
    <div className="relative">
      <Input {...props} type={shown ? "text" : "password"} className="h-11 pr-16" />
      <button
        type="button"
        onClick={() => setShown((value) => !value)}
        aria-label={shown ? "Hide password" : "Show password"}
        aria-pressed={shown}
        className="absolute top-1.5 right-1.5 h-8 rounded-md px-2.5 text-xs font-medium text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        {shown ? "Hide" : "Show"}
      </button>
    </div>
  )
}
