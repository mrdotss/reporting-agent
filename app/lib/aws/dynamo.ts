import "server-only"

import { DynamoDBClient } from "@aws-sdk/client-dynamodb"
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb"

import { requireEnv } from "@/lib/env"

/**
 * The DynamoDB document client for chat history (ask-chat Req 7).
 *
 * Cached on `globalThis` per region, for the reason `lib/aws/s3.ts` caches its client:
 * Next's dev server re-evaluates modules on every hot reload while the process survives,
 * so a module-level `const` would leak a client per edit.
 *
 * `removeUndefinedValues` because an optional field left `undefined` on a view is an
 * absence, and DynamoDB refuses an attribute whose value is `undefined` rather than
 * omitting it.
 */
const cache = globalThis as typeof globalThis & {
  __rptDynamoClient?: DynamoDBDocumentClient
  __rptDynamoRegion?: string
}

export function getDynamoClient(): DynamoDBDocumentClient {
  const region = requireEnv("AWS_REGION")

  if (cache.__rptDynamoClient !== undefined && cache.__rptDynamoRegion === region) {
    return cache.__rptDynamoClient
  }

  const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
    marshallOptions: { removeUndefinedValues: true },
  })
  cache.__rptDynamoClient = client
  cache.__rptDynamoRegion = region
  return client
}

/** The chat history table, read per call so a missing variable fails where it is needed. */
export function chatHistoryTable(): string {
  return requireEnv("RPT_HISTORY_TABLE")
}
