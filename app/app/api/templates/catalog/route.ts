import {
  internalError,
  invalidInput,
  json,
  searchParamsObject,
  unauthorized,
} from "@/lib/api/response"
import { requireSessionForApi } from "@/lib/auth/guard"
import { METRIC_CATALOG, METRIC_CATALOG_VERSION } from "@/lib/templates/catalog"
import { templateQuerySchema } from "@/lib/templates/input"

import type { MetricCatalogSnapshot } from "@/lib/templates/definition"

/**
 * `GET /api/templates/catalog` — the Metric_Catalog's selectable items
 * (Requirement 5.6).
 *
 * Step 4 of the wizard presents metrics "from the Metric_Catalog entry for that
 * resource type rather than from a list held in the Web_App, so that one catalog
 * governs both halves". This route is that boundary: the catalog is
 * `agent/src/reporting_agent/catalog/metrics.v1.json`, imported at build time by
 * `lib/templates/catalog.ts` and served from here, so the list a consultant picks
 * from and the list the collector validates against are the same file.
 *
 * ## Why it is behind the session
 *
 * The catalog is not secret — it describes Azure's own platform metrics, and
 * every fact in it is public documentation. It requires a session anyway, for two
 * reasons that are about this deployment rather than about the data: an
 * unauthenticated endpoint is one more surface to reason about on every future
 * review, and this one would let an anonymous caller fingerprint which catalog
 * version a given deployment is running. Neither is severe; neither is worth
 * spending.
 *
 * ## `no-store`, on a response that never changes
 *
 * The shared {@link json} helper sets `Cache-Control: no-store` on everything,
 * and this is the one response in the app where that is genuinely pessimistic —
 * the body is a build-time constant, identical for every user. It is left alone
 * regardless. An exception here would be the precedent that makes the *next*
 * handler's exception a judgement call, and the body is ~20 KB fetched once per
 * wizard session. When the wizard's step 4 is slow, this will not be why.
 *
 * `export const runtime = "nodejs"` because the session guard opens a Postgres
 * connection. The catalog itself needs no runtime capability at all.
 */
export const runtime = "nodejs"

type CatalogResponseBody = {
  /** The catalog file's own declared version, so a client can cache-key on it. */
  readonly catalogVersion: string
  readonly resourceTypes: MetricCatalogSnapshot
}

export async function GET(request: Request): Promise<Response> {
  const user = await requireSessionForApi()
  if (user === null) return unauthorized()

  const query = templateQuerySchema.safeParse(searchParamsObject(request.url))
  if (!query.success) return invalidInput(query.error)

  try {
    return json(200, {
      catalogVersion: METRIC_CATALOG_VERSION,
      resourceTypes: METRIC_CATALOG,
    } satisfies CatalogResponseBody)
  } catch (thrown) {
    // Unreachable short of a serialization failure over a frozen constant, and
    // an uncaught throw here would return Next's own HTML error page to a
    // `fetch` expecting JSON.
    console.error(
      `[api/templates/catalog] GET failed: ` +
        `${thrown instanceof Error ? `${thrown.name}: ${thrown.message}` : typeof thrown}`
    )

    return internalError()
  }
}
