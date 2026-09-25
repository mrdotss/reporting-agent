import "server-only"

import type { AgentInvokeContext } from "@/lib/aws/agentcore"
import type { ResolvedConnectorCredentials } from "@/lib/subscriptions/store"

/**
 * The connector half of a runtime `context`, for either provider.
 *
 * Azure sends its tenant, client and secret. AWS sends the role to assume and its external
 * id, with the Azure fields empty: the runtime routes on `provider` and never reads them.
 * One function, so no invocation site can build an AWS context that still carries a stale
 * Azure field or the other way round.
 */
export type ConnectorContextFields = Pick<
  AgentInvokeContext,
  | "subscription_id"
  | "tenant_id"
  | "client_id"
  | "client_secret"
  | "fidelity_tier"
  | "log_analytics_workspace_id"
  | "provider"
  | "role_arn"
  | "external_id"
>

export function connectorContext(credentials: ResolvedConnectorCredentials): ConnectorContextFields {
  if (credentials.provider === "aws") {
    return {
      provider: "aws",
      subscription_id: credentials.subscriptionId,
      role_arn: credentials.roleArn,
      external_id: credentials.externalId,
      tenant_id: "",
      client_id: "",
      client_secret: "",
      fidelity_tier: credentials.fidelityTier,
      log_analytics_workspace_id: null,
    }
  }

  // No `provider` key: absent is Azure to the runtime, so an Azure context stays the
  // closed twelve fields it was before AWS existed.
  return {
    subscription_id: credentials.subscriptionId,
    tenant_id: credentials.tenantId,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    fidelity_tier: credentials.fidelityTier,
    log_analytics_workspace_id: credentials.logAnalyticsWorkspaceId,
  }
}
