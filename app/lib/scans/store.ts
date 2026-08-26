import "server-only"

import { randomUUID } from "node:crypto"

import { and, desc, eq } from "drizzle-orm"

import { getDb } from "@/lib/db"
import {
  connectedSubscriptions,
  subscriptionScans,
  type SubscriptionScan,
} from "@/lib/db/schema"
import { toScanView, type ScanView } from "@/lib/db/views"

// --- Errors -----------------------------------------------------------------

/**
 * No subscription with that id belongs to that user.
 *
 * Mirrors `SubscriptionNotFoundError` — same answer for an absent id and for one
 * that belongs to somebody else.
 */
export class ScanSubscriptionNotFoundError extends Error {
  constructor() {
    super(
      "No connected subscription with that id belongs to the signed-in user."
    )
    this.name = "ScanSubscriptionNotFoundError"
  }
}

// --- Types ------------------------------------------------------------------

/**
 * The three fields the scan route checks before accepting a POST: ownership
 * (proven by the query returning a row at all), `scope_verified` and
 * `secret_expires_at`.
 */
export type ScanSubscriptionState = {
  readonly scopeVerified: boolean
  readonly secretExpiresAt: Date
}

// --- Reads ------------------------------------------------------------------

/**
 * Read the subscription's `scope_verified` and `secret_expires_at`, scoped by
 * `user_id`.
 *
 * Throws {@link ScanSubscriptionNotFoundError} when no matching row exists.
 */
export async function readSubscriptionForScan(
  userId: string,
  subscriptionId: string
): Promise<ScanSubscriptionState> {
  const db = getDb()

  const [row] = await db
    .select({
      scopeVerified: connectedSubscriptions.scopeVerified,
      secretExpiresAt: connectedSubscriptions.secretExpiresAt,
    })
    .from(connectedSubscriptions)
    .where(
      and(
        eq(connectedSubscriptions.id, subscriptionId),
        eq(connectedSubscriptions.userId, userId)
      )
    )
    .limit(1)

  if (row === undefined) throw new ScanSubscriptionNotFoundError()

  return {
    scopeVerified: row.scopeVerified,
    secretExpiresAt: row.secretExpiresAt,
  }
}

// --- Writes -----------------------------------------------------------------

/**
 * Persist a new `queued` scan row and return its browser-safe projection.
 *
 * The caller is responsible for having already checked ownership, `scope_verified`
 * and `secret_expires_at` — this function writes, nothing more.
 */
export async function createScan(
  userId: string,
  connectedSubscriptionId: string
): Promise<ScanView> {
  const db = getDb()
  const id = randomUUID()
  const now = new Date()

  const [row] = await db
    .insert(subscriptionScans)
    .values({
      id,
      userId,
      connectedSubscriptionId,
      status: "queued",
      createdAt: now,
      updatedAt: now,
    })
    .returning()

  return toScanView(row as SubscriptionScan)
}

/**
 * Read the latest scan for a given subscription, scoped by `user_id`.
 *
 * Returns `null` when no scan exists for that pair — the caller handles the
 * not-yet-scanned state.
 */
export async function readLatestScan(
  userId: string,
  connectedSubscriptionId: string
): Promise<ScanView | null> {
  const db = getDb()

  const rows = await db
    .select()
    .from(subscriptionScans)
    .where(
      and(
        eq(subscriptionScans.userId, userId),
        eq(subscriptionScans.connectedSubscriptionId, connectedSubscriptionId)
      )
    )
    .orderBy(desc(subscriptionScans.createdAt))
    .limit(1)

  if (rows.length === 0) return null
  return toScanView(rows[0] as SubscriptionScan)
}
