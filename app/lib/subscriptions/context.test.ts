import { describe, expect, test } from "vitest"

import { connectorContext } from "@/lib/subscriptions/context"

describe("connectorContext", () => {
  test("an AWS connector sends its role and external ID, and no Azure field", () => {
    const context = connectorContext({
      provider: "aws",
      subscriptionId: "123456789012",
      roleArn: "arn:aws:iam::123456789012:role/reporting-agent/ReportingAgentReader",
      externalId: "rpt-5c1e9b7a2f8d4c36a0e4b91d7f2a6c58",
      fidelityTier: "baseline",
      regions: ["us-east-1"],
    })
    expect(context).toEqual({
      provider: "aws",
      subscription_id: "123456789012",
      role_arn: "arn:aws:iam::123456789012:role/reporting-agent/ReportingAgentReader",
      external_id: "rpt-5c1e9b7a2f8d4c36a0e4b91d7f2a6c58",
      tenant_id: "",
      client_id: "",
      client_secret: "",
      fidelity_tier: "baseline",
      log_analytics_workspace_id: null,
    })
  })

  test("an Azure connector sends its credential, and no AWS field", () => {
    const context = connectorContext({
      provider: "azure",
      subscriptionId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
      tenantId: "11111111-2222-3333-4444-555555555555",
      clientId: "66666666-7777-8888-9999-000000000000",
      clientSecret: "fixture-secret",
      fidelityTier: "enhanced",
      logAnalyticsWorkspaceId: null,
    })
    expect(context.provider).toBe("azure")
    expect(context.client_secret).toBe("fixture-secret")
    expect(context).not.toHaveProperty("role_arn")
    expect(context).not.toHaveProperty("external_id")
  })
})
