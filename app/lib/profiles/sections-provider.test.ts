import { describe, expect, test } from "vitest"

import {
  AZURE_SECTIONS,
  sectionByKey,
  sectionsFor,
} from "@/lib/profiles/sections"
import {
  ALWAYS_SECTION_KEY_BY_PROVIDER,
  FIXED_SECTION_KEYS_BY_PROVIDER,
  SECTION_KEYS_BY_PROVIDER,
  SUPPORTED_PROVIDERS,
} from "@/lib/templates/definition"

describe("each provider's section catalogue", () => {
  test("AWS presets offer the AWS sections, and Azure presets keep theirs", () => {
    const aws = sectionsFor("aws").map((s) => s.key)
    expect(aws).toEqual([
      "aws_account",
      "regions",
      "ec2_instances",
      "ebs_volumes",
      "rds_instances",
      "ec2_utilization",
      "historical_ec2_utilization",
      "rds_utilization",
      "ebs_activity",
      "incident_report",
      "coverage_and_verification",
    ])
    expect(sectionsFor("azure")).toBe(AZURE_SECTIONS)
    expect(sectionsFor("onprem")).toEqual([])
  })

  test("a key resolves within its own provider only", () => {
    expect(sectionByKey("ec2_utilization", "aws")?.needs_resource_types).toEqual([
      "AWS::EC2::Instance",
    ])
    expect(sectionByKey("ec2_utilization")).toBeUndefined()
    expect(sectionByKey("vm_utilization", "aws")).toBeUndefined()
  })

  test("the validator knows both providers' keys and positions", () => {
    expect(SUPPORTED_PROVIDERS).toEqual(["azure", "aws"])
    expect(SECTION_KEYS_BY_PROVIDER.aws).toContain("rds_instances")
    expect(FIXED_SECTION_KEYS_BY_PROVIDER.aws).toEqual(["incident_report"])
    expect(ALWAYS_SECTION_KEY_BY_PROVIDER.aws).toBe("coverage_and_verification")
    expect(FIXED_SECTION_KEYS_BY_PROVIDER.azure).toEqual([
      "backup_report",
      "incident_report",
      "recommendations",
    ])
  })
})
