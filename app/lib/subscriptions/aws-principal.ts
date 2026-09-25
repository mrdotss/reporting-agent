import "server-only"

import { isPrincipalArn } from "@/lib/subscriptions/aws-artifacts"

/**
 * The reporting runtime's IAM role, which every customer's reader role trusts.
 *
 * Configuration, read at call time like `RPT_PLATFORM_ADMIN_EMAILS`, and optional: unset or
 * malformed, the AWS connector is simply not offered. It is deployment-specific — the
 * runtime's role lives in the account the service runs in — so it cannot be a constant.
 */
export const AWS_CONNECTOR_PRINCIPAL_VAR = "RPT_AWS_CONNECTOR_PRINCIPAL_ARN"

export function awsConnectorPrincipal(): string | null {
  const value = (process.env[AWS_CONNECTOR_PRINCIPAL_VAR] ?? "").trim()
  return isPrincipalArn(value) ? value : null
}
