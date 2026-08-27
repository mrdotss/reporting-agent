import { redirect } from "next/navigation"

/**
 * `/templates/[id]/edit` → `/report-profiles/[id]/edit` (task 3.14).
 *
 * Preserves the `id` segment across the redirect, so an old bookmark to a
 * specific template's editor lands on that same template's editor at the new
 * path rather than the list.
 */
type PageProps = Readonly<{ params: Promise<{ id: string }> }>

export default async function TemplateEditRedirectPage({
  params,
}: PageProps): Promise<never> {
  const { id } = await params
  redirect(`/report-profiles/${id}/edit`)
}
