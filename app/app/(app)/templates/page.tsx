import { redirect } from "next/navigation"

/**
 * `/templates` → `/report-profiles` (task 3.14, Requirement 1.x — the rename).
 *
 * The route moved; this one exists only so a bookmark or an open tab resolves
 * rather than 404s. Permanent in intent — nothing in this product ever routes
 * a fresh link here again — but expressed as a runtime redirect rather than a
 * `next.config.ts` entry, matching this route's dynamic sibling below, which
 * cannot be a static config-level redirect at all.
 */
export default function TemplatesRedirectPage(): never {
  redirect("/report-profiles")
}
