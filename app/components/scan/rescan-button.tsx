"use client"

import { useCallback, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowsClockwiseIcon, SpinnerGapIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { messageText } from "@/lib/messages/catalog"
import type { Language } from "@/lib/messages/language"

/**
 * The "Re-scan" control on `/subscriptions/[id]/scan`.
 *
 * ## Why this is a client component and not a `<form action>`
 *
 * It used to be a native `<form method="post" action="/api/subscriptions/[id]/scan">`,
 * and that could never work: a native form POST sends
 * `application/x-www-form-urlencoded`, the route parses its body with
 * `readJsonBody`, and an urlencoded (here: empty) body is not JSON — so every
 * press answered `400 MALFORMED_BODY`. Worse, because a native form POST is a
 * NAVIGATION, the browser then *rendered that JSON error as the page*, leaving the
 * consultant on a raw error document with the API URL in the address bar and no way
 * back except the back button. The scan never ran, so the page it returned to still
 * showed no resources — which reads as "the subscription is empty" rather than "the
 * button is broken".
 *
 * Sending JSON from the client fixes both halves: the route gets the content type it
 * parses, and a failed scan stays on this page as a message beside the button.
 *
 * **The route is deliberately left JSON-only.** Teaching it to read `formData()`
 * would have been the smaller diff and is the wrong direction: every route in this
 * product takes JSON parsed by a named zod schema (`scanPostBodySchema`), and
 * `test/boundaries.static.test.ts` enforces that no route reads a multipart body.
 *
 * ## The cost of no-JS
 *
 * A native form is the one control that works without JavaScript, and this replaces
 * it with one that does not. That is an acceptable trade here and worth naming: the
 * surrounding page is already an interactive dashboard, and a control that appears
 * to work while silently never scanning is worse than one that needs JS.
 */
export function RescanButton({
  subscriptionId,
  language,
}: Readonly<{ subscriptionId: string; language: Language }>) {
  const router = useRouter()
  const [state, setState] = useState<
    { kind: "idle" } | { kind: "scanning" } | { kind: "error"; message: string }
  >({ kind: "idle" })

  const rescan = useCallback(async () => {
    setState({ kind: "scanning" })
    try {
      const response = await fetch(
        `/api/subscriptions/${encodeURIComponent(subscriptionId)}/scan`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // `scanPostBodySchema` is `z.object({}).strict()` — an empty object is
          // the whole body. Sent explicitly rather than omitted because omitting
          // it is what produced MALFORMED_BODY in the first place.
          body: JSON.stringify({}),
        }
      )

      if (!response.ok) {
        // The route's own message when it has one — it is the specific,
        // actionable text (SCOPE_UNVERIFIED, SECRET_EXPIRED), and replacing it
        // with a generic failure would discard the only thing the consultant can
        // act on.
        let message =
          messageText("ui.scan.rescan_failed", language) ??
          "The scan could not be started."
        try {
          const body = (await response.json()) as {
            error?: { message?: unknown }
          }
          if (typeof body.error?.message === "string") {
            message = body.error.message
          }
        } catch {
          // Keep the catalog message — a non-JSON error body is still an error,
          // and failing to parse it must not mask the failure itself.
        }
        setState({ kind: "error", message })
        return
      }

      // The scan is executed synchronously by the route, so the row is final by
      // the time this resolves. Refresh the server component rather than
      // reloading the window, so the rest of the page's state survives.
      setState({ kind: "idle" })
      router.refresh()
    } catch {
      setState({
        kind: "error",
        message:
          messageText("ui.scan.rescan_offline", language) ??
          "The scan could not be started. Check your connection.",
      })
    }
  }, [subscriptionId, router, language])

  return (
    <div className="ml-auto flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={state.kind === "scanning"}
        onClick={rescan}
      >
        {state.kind === "scanning" ? (
          <SpinnerGapIcon className="animate-spin" />
        ) : (
          <ArrowsClockwiseIcon />
        )}
        {state.kind === "scanning"
          ? messageText("ui.scan.rescan_running", language)
          : messageText("ui.scan.rescan", language)}
      </Button>

      {state.kind === "error" ? (
        <p
          role="alert"
          className="max-w-xs text-right text-xs text-destructive"
        >
          {state.message}
        </p>
      ) : null}
    </div>
  )
}
