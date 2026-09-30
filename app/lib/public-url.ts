import "server-only"

import { requireEnv } from "@/lib/env"

/**
 * The address a customer reaches this app on: the links in a report email, and the proof
 * link printed in the report itself.
 *
 * `RPT_PUBLIC_BASE_URL` when set. `RPT_APP_BASE_URL` is the address the runtime calls back
 * on, and may be a private name no customer can resolve, so it is only the fallback. No
 * trailing slash.
 */
export function publicBaseUrl(): string {
  const configured = process.env.RPT_PUBLIC_BASE_URL?.trim()
  return (configured || requireEnv("RPT_APP_BASE_URL")).replace(/\/+$/, "")
}
