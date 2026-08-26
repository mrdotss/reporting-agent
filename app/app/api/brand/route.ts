import { NextResponse } from "next/server"

import { requireSessionForApi } from "@/lib/auth/guard"
import { ensureBrand, updateBrand } from "@/lib/brands/store"
import { toBrandView } from "@/lib/db/views"

export const runtime = "nodejs"

/** GET /api/brand — return the user's brand (creating default if needed). */
export async function GET() {
  const user = await requireSessionForApi()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const brand = await ensureBrand(user.id)
  return NextResponse.json(toBrandView(brand))
}

/** PATCH /api/brand — update the user's brand fields. */
export async function PATCH(request: Request) {
  const user = await requireSessionForApi()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 })

  const brand = await ensureBrand(user.id)
  const body = (await request.json()) as Record<string, unknown>

  // Only allow known fields to be updated
  const allowedFields = [
    "name",
    "themePreset",
    "accentColor",
    "logoKey",
    "density",
    "tableStyle",
    "pageSize",
    "numberFormat",
    "coverPage",
    "defaultApproverNames",
    "confidentialityNoticeId",
  ] as const

  const updates: Record<string, unknown> = {}
  for (const key of allowedFields) {
    if (key in body) updates[key] = body[key]
  }

  if (Object.keys(updates).length === 0) {
    return NextResponse.json(toBrandView(brand))
  }

  const updated = await updateBrand(
    user.id,
    brand.id,
    updates as Parameters<typeof updateBrand>[2]
  )

  if (!updated) {
    return NextResponse.json({ error: "Not found" }, { status: 404 })
  }

  return NextResponse.json(toBrandView(updated))
}
