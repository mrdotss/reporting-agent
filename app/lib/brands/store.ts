import "server-only"

import { randomUUID } from "node:crypto"

import { eq } from "drizzle-orm"

import { getDb } from "@/lib/db"
import { brands, type Brand } from "@/lib/db/schema"

/**
 * The brands store (Requirement 2.1).
 *
 * `import "server-only"` because this opens a connection. A client component
 * importing it should be a build error.
 *
 * ## `ensureBrand`
 *
 * Creates the default brand on first need, populated from the existing
 * `DesignSpec` defaults, so a new account is never asked to design a brand
 * before authoring a template. Idempotent — if a brand already exists for
 * the user, it returns that one.
 */

/**
 * Return the user's brand, creating a default one if none exists.
 *
 * The defaults match `EMPTY_DRAFT`'s design values — editorial preset, teal
 * accent, normal density, hairline tables, A4, 2 decimal places with grouping,
 * cover page on, no logo. A new account is therefore never presented with a
 * blank brand before they can author a template.
 */
export async function ensureBrand(userId: string): Promise<Brand> {
  const db = getDb()

  const [existing] = await db
    .select()
    .from(brands)
    .where(eq(brands.userId, userId))
    .limit(1)

  if (existing !== undefined) return existing

  const [inserted] = await db
    .insert(brands)
    .values({
      id: randomUUID(),
      userId,
      name: "Default",
      themePreset: "editorial",
      accentColor: "#1f6f78",
      logoKey: null,
      density: "normal",
      tableStyle: "hairline",
      pageSize: "A4",
      numberFormat: { decimal_places: 2, group_thousands: true },
      coverPage: true,
      defaultApproverNames: null,
      confidentialityNoticeId: null,
      confidentialityNotice: null,
    })
    .returning()

  if (inserted === undefined) {
    throw new Error("[brands] the insert returned no row")
  }

  return inserted
}

/**
 * Read the user's brand by id, scoped to the user.
 * Returns `undefined` for a brand that does not belong to this user.
 */
export async function getBrand(
  userId: string,
  brandId: string
): Promise<Brand | undefined> {
  const db = getDb()

  const [row] = await db
    .select()
    .from(brands)
    .where(eq(brands.id, brandId))
    .limit(1)

  if (row === undefined || row.userId !== userId) return undefined

  return row
}

/**
 * Update a brand's fields. Only provided fields are written.
 * Returns the updated row or `undefined` if not found / not owned.
 */
export async function updateBrand(
  userId: string,
  brandId: string,
  updates: Partial<
    Pick<
      Brand,
      | "name"
      | "themePreset"
      | "accentColor"
      | "logoKey"
      | "density"
      | "tableStyle"
      | "pageSize"
      | "numberFormat"
      | "coverPage"
      | "defaultApproverNames"
      | "confidentialityNoticeId"
      | "confidentialityNotice"
    >
  >
): Promise<Brand | undefined> {
  const db = getDb()

  // Verify ownership first
  const existing = await getBrand(userId, brandId)
  if (existing === undefined) return undefined

  const [updated] = await db
    .update(brands)
    .set(updates)
    .where(eq(brands.id, brandId))
    .returning()

  return updated
}
