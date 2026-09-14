import { getPool } from "@/lib/db"

/**
 * `GET /api/health` — whether this process can serve, and which release it is.
 *
 * The deploy's `ValidateService` hook polls this after a restart, and it is strict about
 * two things:
 *
 * 1. **The release.** `RPT_RELEASE_ID` is written by the deploy before the restart, so a
 *    200 from the *old* process — still answering while the new one starts, or because
 *    the restart never happened — carries the old id and does not pass.
 * 2. **The database.** A release whose `DATABASE_URL` is wrong starts and serves pages
 *    until the first query, so the check runs one. It is bounded, so a slow database
 *    reads as unhealthy rather than hanging the hook until its own timeout.
 *
 * Unauthenticated on purpose — nothing here is sensitive. It names no host, no user and
 * no error detail; a failing check says only that the database did not answer.
 */

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const DATABASE_TIMEOUT_MS = 3000

export async function GET(): Promise<Response> {
  const release = process.env.RPT_RELEASE_ID ?? null

  try {
    await Promise.race([
      getPool().query("select 1"),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("timeout")), DATABASE_TIMEOUT_MS)
      ),
    ])
  } catch {
    return Response.json(
      { status: "unavailable", release, database: "unreachable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    )
  }

  return Response.json(
    { status: "ok", release, database: "ok" },
    { headers: { "Cache-Control": "no-store" } }
  )
}
