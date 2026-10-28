import { describe, expect, test } from "vitest"

import { fleetMix, fleetMixSegment } from "./fleet-mix"
import { sampleResources } from "./sample"

/** The runtime's rule (`compile/snapshot_view.py::fleet_mix_segment`), case for case. */
describe("fleetMixSegment", () => {
  test.each([
    ["AWS::EC2::Instance", "t3a.xlarge", "running", "burstable"],
    ["AWS::EC2::Instance", "c5.4xlarge", "running", "compute"],
    ["AWS::EC2::Instance", "m6i.large", "running", "general"],
    ["AWS::EC2::Instance", "r7g.large", "running", "memory"],
    ["AWS::EC2::Instance", "inf2.xlarge", "running", "accelerated"],
    ["AWS::EC2::Instance", "i4i.large", "running", "storage"],
    ["AWS::EC2::Instance", "t4g.small", "stopped", "stopped"],
    ["AWS::RDS::DBInstance", "db.m7g.large", "available", "general"],
    ["AWS::EC2::Instance", "", "running", "other"],
    ["microsoft.compute/virtualmachines", "Standard_B2ts_v2", "running", "burstable"],
    ["microsoft.compute/virtualmachines", "Standard_E8s_v5", "running", "memory"],
    ["microsoft.compute/virtualmachines", "Standard_D4s_v5", "deallocated", "stopped"],
    ["microsoft.compute/virtualmachines", "Standard_Q9", "running", "other"],
  ])("%s %s %s is %s", (type, sku, state, segment) => {
    expect(fleetMixSegment(type, sku, state)).toBe(segment)
  })
})

describe("fleetMix", () => {
  test("the sample splits by family with the stopped machine last", () => {
    expect(fleetMix(sampleResources("aws"), "aws")).toEqual([
      { type: "AWS::EC2::Instance", counts: { burstable: 1, general: 1, stopped: 1 } },
    ])
    expect(fleetMix(sampleResources("azure"), "azure")).toEqual([
      { type: "Microsoft.Compute/virtualMachines", counts: { general: 1, memory: 1, stopped: 1 } },
    ])
  })

  test("types without a size family are left out", () => {
    const volume = { name: "vol-1", avg: 0, peak: 0, type: "AWS::EC2::Volume", cells: { power_state: "" } }
    expect(fleetMix([volume], "aws")).toEqual([])
  })
})
