import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"

/**
 * Task 13.6 — the reservation-facts decision guard.
 *
 * Reader at subscription scope does not grant
 * `Microsoft.Capacity/reservationOrders/read`. The decision was to keep the two
 * reservation keys in the catalog and name the additional role in the onboarding
 * explainer, so a consultant knows up front what removes the gap.
 *
 * This test asserts:
 * 1. The facts catalog still declares `reservation_term` and
 *    `reservation_expires_at`, each carrying `additional_role`.
 * 2. The reader-role-explainer names the specific Azure built-in role that
 *    grants reservation read access: **Reservations Reader**.
 */

const thisDir = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(thisDir, "..")

function readProjectFile(relativePath: string): string {
  return readFileSync(path.join(projectRoot, relativePath), "utf8")
}

describe("reservation-facts decision (task 13.6)", () => {
  const EXPECTED_ROLE = "Reservations Reader"
  const RESERVATION_KEYS = ["reservation_term", "reservation_expires_at"]

  describe("facts catalog", () => {
    const catalogRaw = readProjectFile(
      "../agent/src/reporting_agent/catalog/facts.v1.json"
    )
    const catalog = JSON.parse(catalogRaw) as {
      resource_types: Record<
        string,
        {
          facts: Array<{
            key: string
            additional_role?: string
          }>
        }
      >
    }

    const vmFacts =
      catalog.resource_types["Microsoft.Compute/virtualMachines"]?.facts ?? []

    for (const key of RESERVATION_KEYS) {
      test(`declares ${key} with additional_role = "${EXPECTED_ROLE}"`, () => {
        const entry = vmFacts.find((f) => f.key === key)
        expect(entry, `${key} missing from VM facts`).toBeDefined()
        expect(entry!.additional_role).toBe(EXPECTED_ROLE)
      })
    }
  })

  describe("reader-role-explainer", () => {
    const explainerSource = readProjectFile(
      "components/subscriptions/reader-role-explainer.tsx"
    )

    test(`names the "${EXPECTED_ROLE}" role`, () => {
      expect(explainerSource).toContain(EXPECTED_ROLE)
    })

    test("explains that reservations require tenant-scope RBAC", () => {
      expect(explainerSource).toMatch(/tenant/i)
    })

    test("explains the gap is non-fatal", () => {
      // The copy must make clear that without this role the report still works
      // — the gap is recorded, not a failure.
      expect(explainerSource).toMatch(/gap|unaffected/i)
    })
  })
})
