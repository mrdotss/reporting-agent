import { describe, expect, test } from "vitest"

import {
  AWS_REGION_NAMES,
  isAwsRegion,
  normalizeRegions,
  unknownRegions,
  withRegions,
} from "@/lib/runs/regions"

describe("the AWS regions a run covers", () => {
  test("a region code is a strict token", () => {
    expect(isAwsRegion("ap-southeast-3")).toBe(true)
    expect(isAwsRegion("us-gov-west-1")).toBe(true)
    for (const bad of ["", "useast1", "us-east-1 ", "US-EAST-1", "us-east-1,eu-west-1", "southeastasia"]) {
      expect(isAwsRegion(bad)).toBe(false)
    }
  })

  test("a choice is recorded sorted and unique, and nothing chosen is every region", () => {
    expect(normalizeRegions(["us-east-1", " ap-southeast-1", "us-east-1"])).toEqual([
      "ap-southeast-1",
      "us-east-1",
    ])
    expect(normalizeRegions(undefined)).toEqual([])
    expect(normalizeRegions([])).toEqual([])
  })

  test("a region the account has not enabled is named", () => {
    expect(unknownRegions(["eu-west-1", "us-east-1"], ["us-east-1", "ap-southeast-1"])).toEqual(["eu-west-1"])
    expect(unknownRegions([], ["us-east-1"])).toEqual([])
  })

  test("every region leaves the scope exactly as it was", () => {
    const scope = { resource_types: ["AWS::EC2::Instance"], resource_groups: [] }
    expect(withRegions(scope, [])).toBe(scope)
    expect(withRegions(scope, ["us-east-1", "ap-southeast-3"])).toEqual({
      ...scope,
      regions: ["ap-southeast-3", "us-east-1"],
    })
  })

  test("every named region is a valid code", () => {
    for (const region of Object.keys(AWS_REGION_NAMES)) expect(isAwsRegion(region)).toBe(true)
  })
})
