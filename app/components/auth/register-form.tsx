"use client"

import { useActionState, useId, useState } from "react"
import { CheckIcon, CircleNotchIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { PasswordInput } from "@/components/auth/password-input"
import { Input } from "@/components/ui/input"
import { registerAction } from "@/lib/actions/auth"
import { PASSWORD_MIN } from "@/lib/validation"

/**
 * The registration form (Requirements 7.1, 7.2, 7.8; roles-and-ask-access Req 8).
 *
 * The second and last `"use client"` leaf in the `(auth)` group, and it is a
 * client module for the same single reason as the login form: `useActionState`
 * holds the rejection across the re-render. `registerAction` is a server
 * reference, so nothing behind it — argon2, the pool, the schemas — is bundled
 * for the browser.
 *
 * ## The hints say what to do, not where the limits are
 *
 * They used to print the policy's maxima — "at most 254 characters" under the
 * email, "at most 256" under the password — and a limit printed beside an empty
 * input reads as a requirement to meet: the form was reported as asking for
 * hundreds of characters. The hints now state the one bound a person has to
 * reach, {@link PASSWORD_MIN} imported from `lib/validation` like the schema's
 * own. The maxima are still enforced, and only the rejection that hits one
 * mentions it.
 *
 * ## Where a rejection is shown
 *
 * A policy rejection names its field and renders under that input, which is
 * marked `aria-invalid` and described by the message. "That email address is
 * not available" names no field and renders above the form: it must not say
 * anything more about why (Requirements 7.2, 7.12).
 *
 * `noValidate`, no `required` and no `minLength`: a browser refusing the
 * submission answers in its own bubble, in its own words, before the server's
 * message can — and the schema is the only thing entitled to decide what is
 * acceptable. The email input is controlled so a rejected submission keeps what
 * was typed (React resets an uncontrolled form after its action runs); the
 * password clears, as a secret should.
 *
 * `autoComplete="new-password"` is what tells a password manager to offer a
 * generated password rather than fill the existing one.
 */
export function RegisterForm() {
  const [state, formAction, isPending] = useActionState(
    registerAction,
    undefined
  )
  const [email, setEmail] = useState("")
  // Only the length is kept, so the password itself stays uncontrolled and clears
  // after a rejection; a new form state zeroes the meter when it does.
  const [passwordLength, setPasswordLength] = useState(0)
  const [seenState, setSeenState] = useState(state)
  if (seenState !== state) {
    setSeenState(state)
    setPasswordLength(0)
  }
  const longEnough = passwordLength >= PASSWORD_MIN

  const emailId = useId()
  const emailHintId = useId()
  const emailErrorId = useId()
  const passwordId = useId()
  const passwordHintId = useId()
  const passwordErrorId = useId()
  const errorId = useId()

  const rejection = state?.status === "error" ? state : null
  const formMessage =
    rejection !== null && rejection.field === undefined ? rejection.message : null
  const emailMessage = rejection?.field === "email" ? rejection.message : null
  const passwordMessage =
    rejection?.field === "password" ? rejection.message : null

  return (
    <form
      action={formAction}
      noValidate
      aria-label="Create an account"
      aria-describedby={formMessage === null ? undefined : errorId}
      aria-busy={isPending}
      className="flex flex-col gap-6"
    >
      <FieldError id={errorId}>{formMessage}</FieldError>

      <FieldGroup>
        <Field data-invalid={emailMessage === null ? undefined : true}>
          <FieldLabel htmlFor={emailId}>Email</FieldLabel>

          <Input
            id={emailId}
            name="email"
            type="email"
            autoComplete="email"
            autoCapitalize="none"
            spellCheck={false}
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            className="h-11"
            aria-invalid={emailMessage === null ? undefined : true}
            aria-describedby={
              emailMessage === null ? emailHintId : `${emailErrorId} ${emailHintId}`
            }
          />

          <FieldDescription id={emailHintId}>
            You sign in with this address.
          </FieldDescription>
          <FieldError id={emailErrorId}>{emailMessage}</FieldError>
        </Field>

        <Field data-invalid={passwordMessage === null ? undefined : true}>
          <FieldLabel htmlFor={passwordId}>Password</FieldLabel>

          <PasswordInput
            id={passwordId}
            name="password"
            autoComplete="new-password"
            onChange={(event) => setPasswordLength(event.target.value.length)}
            aria-invalid={passwordMessage === null ? undefined : true}
            aria-describedby={
              passwordMessage === null
                ? passwordHintId
                : `${passwordErrorId} ${passwordHintId}`
            }
          />

          <div className="flex items-center gap-3">
            <div aria-hidden="true" className="grid flex-1 grid-cols-12 gap-[3px]">
              {Array.from({ length: PASSWORD_MIN }, (_, index) => (
                <span
                  key={index}
                  className={
                    index < passwordLength
                      ? longEnough
                        ? "h-1 rounded-full bg-(--status-verified)"
                        : "h-1 rounded-full bg-primary"
                      : "h-1 rounded-full bg-border"
                  }
                />
              ))}
            </div>
            <FieldDescription
              id={passwordHintId}
              className={
                longEnough
                  ? "flex shrink-0 items-center gap-1 text-xs font-medium text-(--status-verified)"
                  : "shrink-0 text-xs"
              }
            >
              {longEnough ? <CheckIcon aria-hidden="true" weight="bold" className="size-3" /> : null}
              At least {PASSWORD_MIN} characters.
            </FieldDescription>
          </div>
          <FieldError id={passwordErrorId}>{passwordMessage}</FieldError>
        </Field>
      </FieldGroup>

      <Button type="submit" disabled={isPending} className="h-11 w-full text-[15px]">
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
