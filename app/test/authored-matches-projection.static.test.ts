import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

/**
 * Projection guard for `report_profile_authored_matches` (task 3.10,
 * Requirement 9.5).
 *
 * This table carries real customer resource ids (`matchedResourceIds`) and is
 * declared "not projected to the browser" in its own schema docstring — unlike
 * every other guarded table, there is no `toXView` narrowing function to test,
 * because there is supposed to be **no view at all**. So the guard here is
 * structural rather than a projection-shape assertion: `lib/db/views.ts` must
 * never import the table or reference any of its columns, and no route under
 * `app/api/` may read it either. A future view added "just to show the count"
 * would reintroduce exactly the resource-id leak this table's docstring rules
 * out — this test is what makes reintroducing it fail immediately rather than
 * silently.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url))
const appRoot = path.resolve(testDir, "..")

function read(relativePath: string): string {
  return readFileSync(path.join(appRoot, relativePath), "utf8")
}

describe("report_profile_authored_matches is never projected to the browser", () => {
  test("lib/db/views.ts does not import the table", () => {
    const views = read("lib/db/views.ts")
    expect(views).not.toContain("reportProfileAuthoredMatches")
    expect(views).not.toContain("report_profile_authored_matches")
  })

  test("lib/db/views.ts references none of the table's own columns", () => {
    const views = read("lib/db/views.ts")
    // Names distinctive enough that a legitimate, unrelated view would not
    // collide with them — matchedResourceIds and matchedCount are specific to
    // this one table.
    expect(views).not.toContain("matchedResourceIds")
    expect(views).not.toContain("matched_resource_ids")
    expect(views).not.toContain("matchedCount")
  })
})
