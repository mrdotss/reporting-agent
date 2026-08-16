"use client"

import { useActionState, useId } from "react"
import { CircleNotchIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { registerAction } from "@/lib/actions/auth"
import {
  EMAIL_POLICY_MESSAGE,
  PASSWORD_MAX,
  PASSWORD_MIN,
} from "@/lib/validation"

/**
 * The registration form (Requirements 7.1, 7.2, 7.8, 7.11).
 *
 * The second and last `"use client"` leaf in the `(auth)` group, and it is a
 * client module for the same single reason as the login form: `useActionState`
 * holds the rejection across the re-render. `registerAction` is a server
 * reference, so nothing behind it — argon2, the pool, the schemas — is bundled
 * for the browser.
 *
 * ## The hints state the policy the server enforces
 *
 * {@link EMAIL_POLICY_MESSAGE} is rendered verbatim, and the password hint is
 * composed from {@link PASSWORD_MIN} and {@link PASSWORD_MAX}, both imported
 * from `lib/validation` — the same module `registerInputSchema` validates
 * against. A hint that restated "at least 12 characters" as its own literal is a
 * hint that keeps saying 12 after the policy moves to 16.
 *
 * The password hint is *composed* from the bounds rather than reusing
 * `PASSWORD_POLICY_MESSAGE`, because that constant is phrased as a rejection
 * ("… Its value and length are excluded from this message") and arrives from the
 * server in the error region below. Rendering it in both places would show the
 * same sentence twice on a rejected submission.
 *
 * ## One error region, no per-field slots
 *
 * As on the login form, and for the same reason: a single {@link FieldError} fed
 * by the action's single `message`. Registration has three rejections — an
 * unavailable email (Requirements 7.2, 7.12), an email that fails the format or
 * length check (7.11), and a password outside the policy (1.4) — and each is one
 * sentence about the policy it violated, not a marker on a field. There is no
 * `required` and no `minLength` here either: the browser refusing a submission
 * would answer with a bubble the server's message then contradicts, and the
 * schema is the only thing entitled to decide what is acceptable.
 *
 * `autoComplete="new-password"` is what tells a password manager to offer a
 * generated password rather than fill the existing one.
 */
export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(
    registerAction,
    undefined
  )

  const emailId = useId()
  const emailHintId = useId()
  const passwordId = useId()
  const passwordHintId = useId()
  const errorId = useId()

  const message = state?.status === "error" ? state.message : null

  return (
    <form
      action={formAction}
      aria-label="Create an account"
      aria-describedby={message === null ? undefined : errorId}
      aria-busy={isPending}
      className="flex flex-col gap-6"
    >
      <FieldError id={errorId}>{message}</FieldError>

      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={emailId}>Email</FieldLabel>

          <Input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            aria-describedby={emailHintId}
          />

          <FieldDescription id={emailHintId}>
            {EMAIL_POLICY_MESSAGE}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor={passwordId}>Password</FieldLabel>

          <Input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="new-password"
            aria-describedby={passwordHintId}
          />

          <FieldDescription id={passwordHintId}>
            At least {PASSWORD_MIN} characters, at most {PASSWORD_MAX}.
          </FieldDescription>
        </Field>
      </FieldGroup>

      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? (
          <CircleNotchIcon
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
        ) : null}

        {isPending ? "Creating account…" : "Create account"}
      </Button>
    </form>
  )
}
