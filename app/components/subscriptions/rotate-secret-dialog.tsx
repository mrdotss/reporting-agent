"use client"

import { useCallback, useId, useMemo, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowsClockwiseIcon, CircleNotchIcon } from "@phosphor-icons/react"
import { z } from "zod"

import {
  SecretExpiryField,
  isAcceptedExpiry,
  localDateTimeToIso,
} from "@/components/subscriptions/secret-expiry-field"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  CLIENT_SECRET_MESSAGE,
  SECRET_EXPIRY_MESSAGE,
} from "@/lib/subscriptions/input"

/**
 * Rotate a connected subscription's client secret (Requirements 13.3, 13.7, 13.8).
 *
 * The remedy the expired state has to offer, and the one every other state may
 * offer: an Azure service-principal secret has a maximum lifetime of 24 months and
 * is commonly issued for 6 to 12, so rotation is routine rather than exceptional.
 * There is no analogue in a role-ARN integration, which is why this control exists
 * at all.
 *
 * ## What this does *not* do
 *
 * It does not decide anything. `POST /api/subscriptions/[id]/secret` replaces the
 * ciphertext, records the submitted expiry and **re-runs the preflight**, setting
 * `scope_verified` from that result (Requirement 13.8) — so a rotated secret that
 * cannot prove read at subscription scope leaves the row `pending` rather than
 * quietly `active`, and this dialog learns that from the route's answer. Nothing
 * about the row's state is computed in the browser.
 *
 * It also does not save a *connection*, which is why Requirement 11.10 does not
 * reach it: the row already exists, and the flag it lands on comes from the route's
 * own preflight rather than from anything submitted here.
 *
 * ## `--destructive`, and where it is allowed
 *
 * Requirement 13.6 reserves the token for the expired state, so {@link emphasis} is
 * a two-valued prop rather than a colour the caller passes: `expired` gets the
 * `destructive` trigger, everything else gets `outline`. A subscription three weeks
 * from expiry offers the same action in mist neutrals — the action is identical, the
 * urgency is not, and red on an approaching expiry spends the token that means *this
 * document could not be proven*.
 *
 * ## The secret
 *
 * Held in this component's state while the dialog is open, sent once over TLS, and
 * cleared the moment the request resolves either way. `type="password"`,
 * `autoComplete="off"`, never in a URL, never logged.
 */

/** The error envelope every route handler answers in (`lib/api/response.ts`). */
const apiErrorSchema = z.object({
  error: z.object({ message: z.string(), code: z.string().optional() }),
})

type RotateSecretDialogProps = Readonly<{
  /** The `connected_subscriptions` row id — not the Azure subscription id. */
  subscriptionId: string
  /** The connection's label, so the dialog names what is being rotated. */
  displayName: string
  /**
   * `expired` is the only value that earns `--destructive` (Requirement 13.6).
   *
   * Covers Requirement 13.3's two triggers — at or after the recorded expiry, and
   * `status = 'disabled'` because Azure rejected the credential.
   */
  emphasis: "expired" | "neutral"
  /** The page-render instant, as ISO 8601 — see `connect-wizard.tsx`. */
  nowIso: string
}>

export function RotateSecretDialog({
  subscriptionId,
  displayName,
  emphasis,
  nowIso,
}: RotateSecretDialogProps) {
  const router = useRouter()

  const now = useMemo(() => new Date(nowIso), [nowIso])

  const [open, setOpen] = useState(false)
  const [clientSecret, setClientSecret] = useState("")
  const [expiresAtLocal, setExpiresAtLocal] = useState("")
  const [problem, setProblem] = useState<string | null>(null)
  const [invalidField, setInvalidField] = useState<
    "clientSecret" | "secretExpiresAt" | null
  >(null)
  const [rotating, setRotating] = useState(false)

  const secretId = useId()
  const expiryId = useId()
  const problemId = useId()

  const reset = useCallback(() => {
    setClientSecret("")
    setExpiresAtLocal("")
    setProblem(null)
    setInvalidField(null)
  }, [])

  const rotate = useCallback(async () => {
    if (clientSecret.length === 0) {
      setInvalidField("clientSecret")
      setProblem(CLIENT_SECRET_MESSAGE)
      return
    }

    if (!isAcceptedExpiry(expiresAtLocal, now)) {
      setInvalidField("secretExpiresAt")
      setProblem(SECRET_EXPIRY_MESSAGE)
      return
    }

    setInvalidField(null)
    setProblem(null)
    setRotating(true)

    try {
      const response = await fetch(
        `/api/subscriptions/${encodeURIComponent(subscriptionId)}/secret`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientSecret,
            secretExpiresAt: localDateTimeToIso(expiresAtLocal),
          }),
        }
      )

      if (!response.ok) {
        let body: unknown
        try {
          body = (await response.json()) as unknown
        } catch {
          body = undefined
        }

        const parsed = apiErrorSchema.safeParse(body)

        setProblem(
          parsed.success
            ? parsed.data.error.message
            : "The secret could not be rotated. The stored secret is unchanged."
        )
        return
      }

      reset()
      setOpen(false)
      // The row's state — `scope_verified`, `status`, the recorded expiry — was
      // decided by the route's own preflight, so the screen is re-rendered from
      // the row rather than patched from this response.
      router.refresh()
    } catch {
      setProblem(
        "The request did not reach the server, so the stored secret is unchanged."
      )
    } finally {
      // Cleared on every path: a failed rotation leaves the dialog open for a
      // correction, and it must not leave the plaintext sitting in state behind a
      // closed dialog either.
      setClientSecret("")
      setRotating(false)
    }
  }, [clientSecret, expiresAtLocal, now, reset, router, subscriptionId])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) reset()
      }}
    >
      <DialogTrigger
        render={
          <Button
            type="button"
            variant={emphasis === "expired" ? "destructive" : "outline"}
            size="sm"
          />
        }
      >
        <ArrowsClockwiseIcon aria-hidden="true" />
        Rotate the secret
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rotate the client secret</DialogTitle>

          <DialogDescription>
            Issue a new client secret for {displayName} in Azure, then paste it
            here with the expiry Azure reported. The stored secret is replaced,
            no earlier copy is kept, and the permissions assertion is re-run
            with the new secret — so read at subscription scope has to hold
            again before this connection is usable.
          </DialogDescription>
        </DialogHeader>

        <form
          aria-label="Rotate the client secret"
          aria-busy={rotating}
          aria-describedby={problem === null ? undefined : problemId}
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault()
            void rotate()
          }}
        >
          <FieldError id={problemId}>{problem}</FieldError>

          <FieldGroup>
            <Field>
              <FieldLabel htmlFor={secretId}>New client secret</FieldLabel>

              <Input
                id={secretId}
                name="clientSecret"
                type="password"
                value={clientSecret}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={invalidField === "clientSecret" || undefined}
                onChange={(event) => setClientSecret(event.target.value)}
              />
            </Field>

            <SecretExpiryField
              id={expiryId}
              value={expiresAtLocal}
              invalid={invalidField === "secretExpiresAt"}
              now={now}
              onValueChange={setExpiresAtLocal}
            />
          </FieldGroup>

          <DialogFooter showCloseButton>
            <Button type="submit" disabled={rotating}>
              {rotating ? (
                <CircleNotchIcon
                  aria-hidden="true"
                  className="motion-safe:animate-spin"
                />
              ) : null}

              {rotating ? "Rotating…" : "Rotate and re-verify"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
