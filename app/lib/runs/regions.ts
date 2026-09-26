/**
 * The AWS regions a run covers. **Pure**, and deliberately not `server-only`: the run form
 * and the enqueue read the same rules.
 *
 * An empty choice means **every enabled region**, which is what an AWS run collected before
 * this existed, so an unset choice changes nothing — not the scope, not the dedupe key, not
 * the snapshot a reuse can match. A non-empty choice is a sorted, de-duplicated subset of the
 * regions the account's own Verify recorded.
 */

export const MAX_RUN_REGIONS = 64

const AWS_REGION = /^[a-z]{2}(-[a-z]+)+-\d$/

export function isAwsRegion(value: string): boolean {
  return AWS_REGION.test(value)
}

/** The choice as the run records it: sorted, unique, and `[]` for every enabled region. */
export function normalizeRegions(selected: readonly string[] | undefined): string[] {
  return [...new Set((selected ?? []).map((region) => region.trim()).filter(Boolean))].sort()
}

/** The regions in `selected` that the account has not enabled, sorted. */
export function unknownRegions(selected: readonly string[], enabled: readonly string[]): string[] {
  const known = new Set(enabled)
  return normalizeRegions(selected).filter((region) => !known.has(region))
}

/** `scope` narrowed to `regions`, or `scope` itself when the run covers every region. */
export function withRegions<T extends object>(scope: T, regions: readonly string[]): T & { regions?: string[] } {
  const chosen = normalizeRegions(regions)
  return chosen.length === 0 ? scope : { ...scope, regions: chosen }
}

/**
 * Where each AWS region is, so a picker can say "ap-southeast-3 · Jakarta" rather than only
 * the code. Display text and nothing else: an unlisted region is still valid and shows its
 * code alone.
 */
export const AWS_REGION_NAMES: Readonly<Record<string, string>> = {
  "af-south-1": "Cape Town",
  "ap-east-1": "Hong Kong",
  "ap-east-2": "Taipei",
  "ap-northeast-1": "Tokyo",
  "ap-northeast-2": "Seoul",
  "ap-northeast-3": "Osaka",
  "ap-south-1": "Mumbai",
  "ap-south-2": "Hyderabad",
  "ap-southeast-1": "Singapore",
  "ap-southeast-2": "Sydney",
  "ap-southeast-3": "Jakarta",
  "ap-southeast-4": "Melbourne",
  "ap-southeast-5": "Malaysia",
  "ap-southeast-6": "New Zealand",
  "ap-southeast-7": "Thailand",
  "ca-central-1": "Canada Central",
  "ca-west-1": "Calgary",
  "eu-central-1": "Frankfurt",
  "eu-central-2": "Zurich",
  "eu-north-1": "Stockholm",
  "eu-south-1": "Milan",
  "eu-south-2": "Spain",
  "eu-west-1": "Ireland",
  "eu-west-2": "London",
  "eu-west-3": "Paris",
  "il-central-1": "Tel Aviv",
  "me-central-1": "UAE",
  "me-south-1": "Bahrain",
  "mx-central-1": "Mexico",
  "sa-east-1": "São Paulo",
  "us-east-1": "N. Virginia",
  "us-east-2": "Ohio",
  "us-west-1": "N. California",
  "us-west-2": "Oregon",
}
