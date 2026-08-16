import type { Metadata } from "next"
import Link from "next/link"
import { z } from "zod"

import { LoginForm } from "@/components/auth/login-form"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { RETURN_TO_PARAM } from "@/lib/auth/guard"
import { safeReturnTo } from "@/lib/validation"

/**
 * `/login` (Requirements 7.4, 7.5, 7.8, 7.9).
 *
 * A **server** component. It has one job beyond composition: resolve the
 * post-login return target, so the interactive leaf below it receives a value
 * that is already safe rather than a raw query parameter it would have to
 * sanitize in the browser.
 *
 * Being a server component is also what lets it name `RETURN_TO_PARAM` at all —
 * `lib/auth/guard.ts` carries `import "server-only"`, so the client form cannot
 * import that constant. The parameter *name* therefore travels down as a prop
 * (see {@link LoginForm}); the literal `"returnTo"` exists exactly once in this
 * app, in the module that also writes it into the redirect URL.
 */

export const metadata: Metadata = {
  title: "Sign in",
  description: "Sign in to the infrastructure utilization reporting workspace.",
}

/**
 * The search parameter, parsed at the boundary in the spirit of Requirement 7.7
 * — a search parameter is input, and this one arrives from a URL anybody can
 * type.
 *
 * `.catch(null)` rather than a failure branch: a repeated `?returnTo=` gives
 * `string[]`, and a crafted parameter should cost the visitor their deep link,
 * not their sign-in page. Whatever survives goes through {@link safeReturnTo},
 * which resolves anything that is not a single-slash same-origin path to
 * `/dashboard` (Requirement 7.9). Mirrors the shape `loginAction` applies to
 * the same field, and the action sanitizes again on arrival — this render is a
 * convenience for the visitor, never the authority.
 */
const returnToParamSchema = z.string().nullish().catch(null)

/**
 * `searchParams` is a **Promise** in Next 16 — synchronous access was removed
 * (`02-guides/upgrading/version-16.md`). Typed structurally rather than with the
 * generated `PageProps<'/login'>` helper so `pnpm typecheck` passes on a clean
 * checkout, before `next typegen` has produced `.next/types`.
 */
export default async function LoginPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>
}>) {
  const params = await searchParams
  const returnTo = safeReturnTo(
    returnToParamSchema.parse(params[RETURN_TO_PARAM])
  )

  return (
    <Card className="w-full max-w-sm rounded-xl border border-border shadow-none ring-0">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Sign in
        </CardTitle>

        <CardDescription>
          Use the email address and password you registered with.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <LoginForm returnToParam={RETURN_TO_PARAM} returnTo={returnTo} />
      </CardContent>

      <CardFooter>
        <p className="text-sm text-muted-foreground">
          No account yet?{" "}
          <Link
            href="/register"
            className="rounded-sm text-foreground underline underline-offset-4 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/30 dark:hover:text-sidebar-primary"
          >
            Create one
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
