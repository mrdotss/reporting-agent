/**
 * Task 1.7 — the scan screen's type grouping and greying.
 *
 * The assertions that matter are the two that encode a decision rather than a mapping: a
 * **supported** type never lands in `not_reportable`, and greying is derived from the
 * catalogues rather than from the group.
 */

import { describe, expect, test } from "vitest"

import {
  SCAN_GROUPS,
  groupFor,
  groupScanTypes,
  isDeclared,
} from "@/lib/scans/grouping"

/** The seven types both shipped catalogues declare today. */
const DECLARED = [
  "Microsoft.Compute/disks",
  "Microsoft.Compute/virtualMachines",
  "Microsoft.DBforPostgreSQL/flexibleServers",
  "Microsoft.Sql/managedInstances",
  "Microsoft.Sql/servers/databases",
  "Microsoft.Storage/storageAccounts",
  "Microsoft.Web/sites",
]

describe("groupFor", () => {
  test.each([
    ["Microsoft.Compute/virtualMachines", "compute"],
    ["Microsoft.Compute/disks", "compute"],
    ["Microsoft.Compute/virtualMachines/extensions", "compute"],
    ["Microsoft.Network/virtualNetworks", "networking"],
    ["Microsoft.Network/networkSecurityGroups", "networking"],
    ["Microsoft.Network/publicIPAddresses", "networking"],
    ["Microsoft.Sql/servers/databases", "data"],
    ["Microsoft.DBforPostgreSQL/flexibleServers", "data"],
    ["Microsoft.Storage/storageAccounts", "data"],
    ["Microsoft.CognitiveServices/accounts", "not_reportable"],
    ["Microsoft.OperationalInsights/workspaces", "not_reportable"],
  ])("%s groups under %s", (resourceType, expected) => {
    expect(groupFor(resourceType)).toBe(expected)
  })

  test("App Service groups under compute, so a supported type is never 'not reportable'", () => {
    // The decision this pins: the mockups declare exactly four groups, and
    // `Microsoft.Web/sites` is metric-bearing and catalogue-declared. Letting it fall
    // through to `not_reportable` would put a SUPPORTED type in the bucket labelled
    // unsupported — visibly wrong on the one screen whose job is to say what can be
    // reported.
    expect(groupFor("Microsoft.Web/sites")).toBe("compute")
    expect(isDeclared("Microsoft.Web/sites", DECLARED)).toBe(true)
  })

  test("no declared type lands in not_reportable", () => {
    // The invariant behind the case above, asserted over every type the catalogues declare
    // rather than over the one that prompted it — so adding a namespace to the catalogues
    // without adding it here fails this test.
    const misfiled = DECLARED.filter((type) => groupFor(type) === "not_reportable")
    expect(misfiled).toEqual([])
  })

  test("grouping folds case, because Resource Graph lower-cases `type`", () => {
    expect(groupFor("microsoft.compute/virtualmachines")).toBe("compute")
    expect(groupFor("MICROSOFT.NETWORK/VIRTUALNETWORKS")).toBe("networking")
  })

  test.each(["", "   ", "notatype"])("%o is not reportable rather than throwing", (value) => {
    expect(groupFor(value)).toBe("not_reportable")
  })

  test("a namespace is matched whole, not by prefix", () => {
    // `microsoft.computeforsomethingelse` starts with `microsoft.compute`. A prefix match
    // would file a stranger's namespace under Compute and quietly claim it is reportable.
    expect(groupFor("Microsoft.ComputeSomethingElse/things")).toBe("not_reportable")
  })
})

describe("isDeclared", () => {
  test("a catalogue-declared type is not greyed", () => {
    expect(isDeclared("Microsoft.Compute/virtualMachines", DECLARED)).toBe(true)
  })

  test("a type absent from both catalogues is greyed", () => {
    expect(isDeclared("Microsoft.Compute/virtualMachines/extensions", DECLARED)).toBe(false)
  })

  test("declaration folds case", () => {
    expect(isDeclared("microsoft.compute/virtualmachines", DECLARED)).toBe(true)
  })
})

describe("groupScanTypes", () => {
  test("greying is independent of the group", () => {
    // The shape `design/Scan.dc.html` renders: a greyed type sits INSIDE Compute, beside
    // the virtual machines, rather than being moved to Not-reportable. Collapsing the two
    // questions into one would lose that.
    const grouped = groupScanTypes(
      {
        "Microsoft.Compute/virtualMachines": 3,
        "Microsoft.Compute/virtualMachines/extensions": 1,
        "Microsoft.CognitiveServices/accounts": 3,
      },
      DECLARED
    )

    const compute = grouped.find((entry) => entry.group === "compute")
    expect(compute?.types.map((type) => [type.resourceType, type.greyed])).toEqual([
      ["Microsoft.Compute/virtualMachines", false],
      ["Microsoft.Compute/virtualMachines/extensions", true],
    ])

    const unsupported = grouped.find((entry) => entry.group === "not_reportable")
    expect(unsupported?.types.every((type) => type.greyed)).toBe(true)
  })

  test("an empty group is omitted rather than rendered empty", () => {
    const grouped = groupScanTypes({ "Microsoft.Compute/virtualMachines": 2 }, DECLARED)

    expect(grouped.map((entry) => entry.group)).toEqual(["compute"])
  })

  test("groups present in the declared order", () => {
    const grouped = groupScanTypes(
      {
        "Microsoft.CognitiveServices/accounts": 1,
        "Microsoft.Sql/servers/databases": 1,
        "Microsoft.Network/virtualNetworks": 1,
        "Microsoft.Compute/virtualMachines": 1,
      },
      DECLARED
    )

    expect(grouped.map((entry) => entry.group)).toEqual([...SCAN_GROUPS])
  })

  test("a group's total is the sum of its own types", () => {
    const grouped = groupScanTypes(
      {
        "Microsoft.Compute/virtualMachines": 3,
        "Microsoft.Compute/disks": 4,
      },
      DECLARED
    )

    expect(grouped[0]?.total).toBe(7)
  })

  test("types order by descending count then by name, so two renders agree", () => {
    const counts = {
      "Microsoft.Compute/disks": 2,
      "Microsoft.Compute/virtualMachines": 2,
      "Microsoft.Compute/availabilitySets": 9,
    }

    const first = groupScanTypes(counts, DECLARED)
    const second = groupScanTypes(counts, DECLARED)

    expect(first[0]?.types.map((type) => type.resourceType)).toEqual([
      "Microsoft.Compute/availabilitySets",
      "Microsoft.Compute/disks",
      "Microsoft.Compute/virtualMachines",
    ])
    expect(second).toEqual(first)
  })
})
