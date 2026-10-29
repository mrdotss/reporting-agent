import type { Metadata } from "next"
import Link from "next/link"

import { RegisterForm } from "@/components/auth/register-form"
import { AuthFormColumn } from "@/components/auth/auth-form-column"
import { AuthPanel } from "@/components/auth/auth-panel"

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
    "Create an account to connect your environment and produce verified " +
    "utilization reports.",
}

export default function RegisterPage() {
  return (
    <>
      <AuthPanel kind="register" />
      <AuthFormColumn
        title="Create your account"
        description="Then connect your environment, read-only."
        footer={
          <>
            Already have an account?{" "}
            <Link href="/login" className="rounded-sm font-semibold text-primary underline-offset-4 outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/30">
              Sign in
            </Link>
          </>
        }
      >
        <RegisterForm />
      </AuthFormColumn>
    </>
  )
}
