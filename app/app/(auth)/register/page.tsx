import type { Metadata } from "next"
import Link from "next/link"

import { RegisterForm } from "@/components/auth/register-form"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"

/**
 * `/register` (Requirements 7.1, 7.2, 7.8, 7.11).
 *
 * A **server** component with no dynamic input: unlike `/login` it reads no
 * search parameter, because registration is never the resumption of an
 * interrupted request — `registerAction` lands on the dashboard, not on a
 * `returnTo` target — so there is nothing here to await and nothing to
 * sanitize.
 */

export const metadata: Metadata = {
  title: "Create an account",
  description:
    "Create an account to connect an Azure subscription and produce verified " +
    "utilization reports.",
}

export default function RegisterPage() {
  return (
    <Card className="w-full max-w-sm rounded-xl border border-border shadow-none ring-0">
      <CardHeader>
        <CardTitle role="heading" aria-level={2}>
          Create an account
        </CardTitle>

        <CardDescription>
          One account, then connect an Azure subscription read-only.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <RegisterForm />
      </CardContent>

      <CardFooter>
        <p className="text-sm text-muted-foreground">
          Already registered?{" "}
          <Link
            href="/login"
            className="rounded-sm text-foreground underline underline-offset-4 outline-none hover:text-primary focus-visible:ring-3 focus-visible:ring-ring/30 dark:hover:text-sidebar-primary"
          >
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  )
}
