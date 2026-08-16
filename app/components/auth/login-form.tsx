"use client"

import { useActionState, useId } from "react"
import { CircleNotchIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { loginAction } from "@/lib/actions/auth"

/**
 * The sign-in form (Requirements 7.4, 7.5, 7.8, 7.9).
 *
 * One of the two `"use client"` leaves in the `(auth)` group. The layout, both
 * pages and the card around this form stay server components; the only reason
 * this file crosses the boundary is `useActionState`, which needs the browser to
 * hold the rejection between the submission and the re-render. The Phosphor
 * import is the package's **default** entry here, not `/ssr` — this module is
 * already a client module, so the client build is the correct one.
 *
 * `loginAction` is imported from a `"use server"` module, which Next rewrites to
 * a server reference: argon2, the Postgres pool and the zod schemas behind it
 * never enter the client graph. That is also why this file must not import
 * anything from `lib/auth/*` or `lib/db/*` — those carry
 * `import "server-only"`, and naming one here is a build failure rather than a
 * leak (Requirement 6.1).
 *
 * ## One error region, and why there are no per-field slots
 *
 * Requirement 7.5 is structural here, not a wording choice. There is exactly one
 * {@link FieldError} in this form, fed by the action's single `message`, and no
 * field carries an error slot or `aria-invalid`. A shape with an `email` error
 * and a `password` error is a shape somebody eventually fills in — and the
 * moment one of them is filled in, the form has told an enumerator which half of
 * the submission was wrong. The action returns one frozen constant for all four
 * of its rejection paths; this renders that one message in one place.
 *
 * ## No `required`, no `minLength`, no `maxLength`
 *
 * Deliberate, and it follows from the same requirement. Native constraint
 * validation refuses a submission with a bubble attached to a **named field**
 * ("Please fill out this field"), so an empty submission would be answered by a
 * field-specific rejection while a wrong one is answered by a generic one — the
 * difference is observable. Letting the server answer every rejected submission
 * keeps one authority and one message. `type="email"` is kept, because a format
 * check on a value the visitor can see is not a statement about their
 * credentials, and mobile keyboards need it.
 *
 * A rejected submission clears both fields: React resets an uncontrolled form
 * once its action resolves. Correct for the password; the email is a re-type,
 * and preserving it would mean the action returning the submitted address, which
 * its closed `{ status, message }` result deliberately does not carry.
 */

/**
 * `returnToParam` arrives as a **prop**, not as an import.
 *
 * The name of the field has to match what `loginAction` reads with
 * `formData.get(RETURN_TO_PARAM)`, and that constant lives in
 * `lib/auth/guard.ts`, which is `server-only`. So the login page — a server
 * component — reads the query parameter with it, sanitizes the value, and hands
 * both down. The alternative is a second `"returnTo"` literal in this file,
 * which is how a deep link silently stops surviving sign-in: nothing breaks, the
 * visitor just always lands on the dashboard.
 *
 * `returnTo` is already `safeReturnTo`'d by the page. The action sanitizes it
 * again on arrival (Requirement 7.9) — this value is a convenience for the
 * visitor, never the authority.
 */
type LoginFormProps = Readonly<{
  returnToParam: string
  returnTo: string
}>

export function LoginForm({ returnToParam, returnTo }: LoginFormProps) {
  const [state, formAction, isPending] = useActionState(loginAction, undefined)

  const emailId = useId()
  const passwordId = useId()
  const errorId = useId()

  // Narrowed in the expression rather than through a boolean, so `state.message`
  // is reachable without asserting anything about `state`.
  const message = state?.status === "error" ? state.message : null

  return (
    <form
      action={formAction}
      aria-label="Sign in"
      aria-describedby={message === null ? undefined : errorId}
      aria-busy={isPending}
      className="flex flex-col gap-6"
    >
      {/*
        `FieldError` renders nothing until it has content, and carries
        `role="alert"`, so the message is announced when it appears without a
        region sitting empty in the accessible tree. It reads before the fields
        because a visitor who has just been refused should hear why before
        hearing "Email".
      */}
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
          />
        </Field>

        <Field>
          <FieldLabel htmlFor={passwordId}>Password</FieldLabel>

          <Input
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
          />
        </Field>
      </FieldGroup>

      <input type="hidden" name={returnToParam} value={returnTo} />

      <Button type="submit" disabled={isPending} className="w-full">
        {isPending ? (
          <CircleNotchIcon
            aria-hidden="true"
            className="motion-safe:animate-spin"
          />
        ) : null}

        {isPending ? "Signing in…" : "Sign in"}
      </Button>
    </form>
  )
}
