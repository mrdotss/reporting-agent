import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon } from "@phosphor-icons/react/ssr"

import { PageBody } from "@/components/app-shell/page-body"
import { AwsSetup } from "@/components/subscriptions/aws-setup"
import { AwsMark } from "@/components/subscriptions/provider-mark"
import { Card, CardContent } from "@/components/ui/card"
import { requireSession } from "@/lib/auth/guard"
import { awsOnboardingArtifacts } from "@/lib/subscriptions/aws-artifacts"
import { awsConnectorPrincipal } from "@/lib/subscriptions/aws-principal"
import {
  readAwsConnectorSetup,
  SubscriptionNotFoundError,
} from "@/lib/subscriptions/store"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

export const metadata: Metadata = {
  title: "Set up an AWS connection",
  description: "Create the read-only role in the customer's AWS account, then verify it.",
}

/**
 * The AWS setup page. Server-rendered from the stored connector: the external id is read
 * here and put into the template, never sent by or chosen in the browser. `connect`
 * access only, as creating the connector was; anyone else gets a 404.
 */
export default async function AwsSetupPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const user = await requireSession()
  const principalArn = awsConnectorPrincipal()
  if (principalArn === null) notFound()

  const { id } = await params
  let setup
  try {
    setup = await readAwsConnectorSetup(user.id, id)
  } catch (thrown) {
    if (thrown instanceof SubscriptionNotFoundError || thrown instanceof WorkspaceAccessError) notFound()
    throw thrown
  }

  const artifacts = awsOnboardingArtifacts({
    accountId: setup.accountId,
    externalId: setup.externalId,
    principalArn,
  })

  return (
    <PageBody kind="reading">
      <header className="flex flex-col gap-3">
        <Link
          href="/subscriptions"
          className="flex w-fit items-center gap-1.5 rounded-lg text-sm text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-4" />
          Connections
        </Link>
        <div className="flex items-center gap-3">
          {AwsMark}
          <div className="flex min-w-0 flex-col gap-0.5">
            <h1 className="text-title text-balance">{setup.displayName}</h1>
            <p className="text-sm text-muted-foreground">
              {setup.scopeVerified ? "Connected" : "Waiting for the customer's role"}
            </p>
          </div>
        </div>
      </header>

      <Card className="min-w-0">
        <CardContent>
          <AwsSetup
            id={setup.id}
            displayName={setup.displayName}
            accountId={setup.accountId}
            roleArn={artifacts.roleArn}
            externalId={setup.externalId}
            verified={setup.scopeVerified}
            regions={setup.regions}
            cloudFormation={artifacts.cloudFormation}
            cliScript={artifacts.cliScript}
          />
        </CardContent>
      </Card>
    </PageBody>
  )
}
