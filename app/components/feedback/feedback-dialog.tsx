"use client"

import { useEffect, useId, useState } from "react"
import { usePathname } from "next/navigation"
import { CheckIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog"
import { Textarea } from "@/components/ui/textarea"
import {
  FEEDBACK_KINDS,
  FEEDBACK_KIND_LABEL,
  FEEDBACK_MESSAGE_MAX,
  type FeedbackKind,
} from "@/lib/feedback/input"
import { cn } from "@/lib/utils"

/**
 * Send feedback: a kind, a message, and two choices — attach the page you are on, and
 * whether the team may reply. It is saved and emailed to the team by `POST /api/feedback`.
 *
 * The sidebar owns the open state. The ⌘K menu opens it too, without a shared context, by
 * dispatching {@link OPEN_FEEDBACK_EVENT} on `window`; the dialog listens for it.
 */

export const OPEN_FEEDBACK_EVENT = "utilize:open-feedback"

export function openFeedback(): void {
  window.dispatchEvent(new Event(OPEN_FEEDBACK_EVENT))
}

const KIND_COPY: Record<FeedbackKind, { hint: string; prompt: string; placeholder: string }> = {
  idea: { hint: "Something to add", prompt: "What would you like to see?", placeholder: "It would help if…" },
  problem: {
    hint: "Something broke",
    prompt: "What went wrong?",
    placeholder: "What you did, what you expected, and what happened instead",
  },
  question: { hint: "Not sure how", prompt: "What would you like to know?", placeholder: "How do I…" },
  praise: { hint: "Something good", prompt: "What worked well?", placeholder: "I liked…" },
}

export function FeedbackDialog({
  open,
  onOpenChange,
  email,
}: Readonly<{
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The signed-in member's address, shown beside "you can reply to me". */
  email: string
}>) {
  const pathname = usePathname()
  const id = useId()
  const [kind, setKind] = useState<FeedbackKind>("problem")
  const [message, setMessage] = useState("")
  const [attachPage, setAttachPage] = useState(true)
  const [canReply, setCanReply] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const [sent, setSent] = useState(false)

  useEffect(() => {
    const show = () => onOpenChange(true)
    window.addEventListener(OPEN_FEEDBACK_EVENT, show)
    return () => window.removeEventListener(OPEN_FEEDBACK_EVENT, show)
  }, [onOpenChange])

  function reset() {
    setMessage("")
    setError("")
    setSent(false)
  }

  function change(next: boolean) {
    onOpenChange(next)
    // A closed dialog opens fresh, but a typed message survives an accidental close.
    if (!next && sent) reset()
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (message.trim() === "") {
      setError("Write a few words first.")
      return
    }
    setBusy(true)
    setError("")
    try {
      const response = await fetch("/api/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, message, pagePath: attachPage ? pathname : null, canReply }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(
          response.status === 429 && body?.error?.message ? body.error.message : "Your feedback wasn’t sent. Try again."
        )
      }
      setSent(true)
    } catch (thrown) {
      setError(thrown instanceof Error ? thrown.message : "Your feedback wasn’t sent. Try again.")
    } finally {
      setBusy(false)
    }
  }

  const copy = KIND_COPY[kind]

  return (
    <Dialog open={open} onOpenChange={change}>
      <DialogContent className="sm:max-w-[520px]">
        {sent ? (
          <div className="flex flex-col items-center gap-3 py-4 text-center">
            <span className="grid size-12 place-items-center rounded-full bg-primary/10 text-primary">
              <CheckIcon aria-hidden="true" className="size-6" weight="bold" />
            </span>
            <DialogTitle>Thanks, we got it</DialogTitle>
            <DialogDescription className="max-w-[38ch]">
              Your feedback is saved and on its way to the team.
              {canReply ? ` If we have a question, we’ll reply to ${email}.` : ""}
            </DialogDescription>
            <div className="mt-2 flex gap-2">
              <Button variant="outline" onClick={reset}>
                Send another
              </Button>
              <Button onClick={() => change(false)}>Done</Button>
            </div>
          </div>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <DialogTitle>Send feedback</DialogTitle>
              <DialogDescription>
                It goes straight to the Utilize Space team. We read every message.
              </DialogDescription>
            </div>

            <fieldset className="flex flex-col gap-2">
              <legend className="mb-2 text-sm font-medium">What kind of feedback?</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {FEEDBACK_KINDS.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={kind === option}
                    onClick={() => setKind(option)}
                    className={cn(
                      "flex flex-col items-start gap-0.5 rounded-lg border px-3 py-2 text-left outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30",
                      kind === option
                        ? "border-primary bg-primary/8 ring-1 ring-primary"
                        : "border-border hover:bg-muted"
                    )}
                  >
                    <span className="text-sm font-medium">{FEEDBACK_KIND_LABEL[option]}</span>
                    <span className="text-xs text-muted-foreground">{KIND_COPY[option].hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>

            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-message`} className="text-sm font-medium">
                {copy.prompt}
              </label>
              <Textarea
                id={`${id}-message`}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={copy.placeholder}
                maxLength={FEEDBACK_MESSAGE_MAX}
                aria-invalid={error !== "" && message.trim() === "" ? true : undefined}
                className="min-h-30 max-h-72 resize-y"
              />
              <span className="self-end font-mono text-xs text-muted-foreground tabular-nums">
                {message.length.toLocaleString("en-US")} / {FEEDBACK_MESSAGE_MAX.toLocaleString("en-US")}
              </span>
            </div>

            <div className="flex flex-col gap-3 text-sm">
              <label className="flex items-start gap-2.5">
                <Checkbox
                  checked={attachPage}
                  onCheckedChange={(checked) => setAttachPage(checked === true)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  Attach the page I’m on{" "}
                  <span className="font-mono text-xs break-all text-muted-foreground">{pathname}</span>
                </span>
              </label>
              <label className="flex items-start gap-2.5">
                <Checkbox
                  checked={canReply}
                  onCheckedChange={(checked) => setCanReply(checked === true)}
                  className="mt-0.5"
                />
                <span className="min-w-0">
                  You can reply to me at{" "}
                  <span className="font-mono text-xs break-all text-muted-foreground">{email}</span>
                </span>
              </label>
            </div>

            {error && (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => change(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={busy}>
                {busy ? "Sending…" : "Send feedback"}
              </Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
