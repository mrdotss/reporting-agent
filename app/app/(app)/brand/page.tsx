import { requireSession } from "@/lib/auth/guard"
import { ensureBrand } from "@/lib/brands/store"
import { toBrandView } from "@/lib/db/views"
import { themeThumbnails } from "@/lib/templates/theme-thumbnails"
import { BrandEditor } from "@/components/brand/brand-editor"

/**
 * The Brand editor (Requirement 2.4).
 *
 * Server component that resolves the user's brand (creating the default on first
 * access) and passes the view plus theme thumbnails to the client-side editor.
 *
 * A Brand edit applies to the next report, never retroactively — stated in the
 * UI and enforced by `publishTemplateVersion`'s resolve-at-publish mechanism.
 */
export default async function BrandPage() {
  const user = await requireSession()
  const brand = await ensureBrand(user.id)
  const view = toBrandView(brand)
  const thumbnails = themeThumbnails()

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 p-6">
      <header className="flex flex-col gap-1">
        <h1 className="font-heading text-xl font-medium tracking-tight">
          Brand
        </h1>
        <p className="text-sm text-muted-foreground">
          Your consultancy&apos;s visual identity. Changes apply to the next
          report you generate — they never alter a report already delivered.
        </p>
      </header>
      <BrandEditor brand={view} thumbnails={thumbnails} />
    </div>
  )
}
