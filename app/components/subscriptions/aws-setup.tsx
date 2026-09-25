"use client"

import { useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import {
  CheckCircleIcon,
  DownloadSimpleIcon,
  ShieldWarningIcon,
} from "@phosphor-icons/react"

import { CopyButton } from "@/components/subscriptions/copy-button"
import { Button, buttonVariants } from "@/components/ui/button"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"

export type AwsSetupProps = Readonly<{
  id: string
  displayName: string
  accountId: string
  roleArn: string
  externalId: string
  verified: boolean
  regions: readonly string[]
  cloudFormation: string
  cliScript: string
}>

type VerifyState =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "passed"; readonly regions: readonly string[] }
  | { readonly kind: "refused"; readonly message: string }

/**
 * Where an AWS connection is finished: the two ways to create the role, and Verify.
 *
 * The page is reachable from the connector list for as long as the connector exists, so a
 * consultant who sent the template to a customer can come back days later and verify —
 * and verify again after the customer changes the role.
 */
export function AwsSetup(props: AwsSetupProps) {
  const router = useRouter()
  const [state, setState] = useState<VerifyState>(
    props.verified ? { kind: "passed", regions: props.regions } : { kind: "idle" }
  )

  async function verify() {
    setState({ kind: "busy" })
    try {
      const response = await fetch(`/api/subscriptions/${encodeURIComponent(props.id)}/verify`, {
        method: "POST",
      })
      const body: unknown = await response.json().catch(() => null)
      if (response.ok) {
        const regions = (body as { regions?: unknown } | null)?.regions
        setState({
          kind: "passed",
          regions: Array.isArray(regions) ? regions.filter((r): r is string => typeof r === "string") : [],
        })
        router.refresh()
        return
      }
      const message = (body as { error?: { message?: unknown } } | null)?.error?.message
      setState({
        kind: "refused",
        message:
          typeof message === "string"
            ? message
            : "The role could not be verified. Check that the template was deployed in this account.",
      })
    } catch {
      setState({ kind: "refused", message: "The check could not reach the server. Try again." })
    }
  }

  return (
    <div className="flex flex-col gap-8">
      <section aria-labelledby="aws-setup-role" className="flex flex-col gap-3">
        <h2 id="aws-setup-role" className="text-section">
          1. Create the role in account{" "}
          <span className="font-mono tabular-nums">{props.accountId}</span>
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          Send one of these to the customer, or run it yourself if you can sign in to the
          account. Both create the same read-only role, trusted by this service only with
          this connection&apos;s external ID. It can list resources and read CloudWatch
          metrics; it cannot change anything or read data.
        </p>

        <dl className="grid max-w-prose grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Role</dt>
          <dd className="truncate font-mono text-xs leading-5">{props.roleArn}</dd>
          <dt className="text-muted-foreground">External ID</dt>
          <dd className="font-mono text-xs leading-5">{props.externalId}</dd>
        </dl>

        <Tabs defaultValue="cloudformation" className="flex min-w-0 flex-col gap-2">
          <TabsList>
            <TabsTrigger value="cloudformation">CloudFormation template</TabsTrigger>
            <TabsTrigger value="cli">AWS CLI script</TabsTrigger>
          </TabsList>
          <TabsContent value="cloudformation" className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              In the AWS console, open CloudFormation, choose Create stack with new
              resources, and upload this file. The external ID is already its default.
              Acknowledge that it creates an IAM role.
            </p>
            <Artifact
              value={props.cloudFormation}
              label="CloudFormation template"
              fileName="reporting-agent-reader.yaml"
              mime="application/x-yaml"
            />
          </TabsContent>
          <TabsContent value="cli" className="flex flex-col gap-2">
            <p className="text-sm text-muted-foreground">
              Paste into AWS CloudShell in the customer&apos;s account. It checks the account
              first, and running it again updates the role in place.
            </p>
            <Artifact
              value={props.cliScript}
              label="AWS CLI script"
              fileName="create-reader-role.sh"
              mime="text/x-shellscript"
            />
          </TabsContent>
        </Tabs>
      </section>

      <section aria-labelledby="aws-setup-verify" className="flex flex-col gap-3">
        <h2 id="aws-setup-verify" className="text-section">
          2. Verify
        </h2>
        <p className="max-w-prose text-sm text-muted-foreground">
          The reporting runtime assumes the role, asks IAM whether every required action
          is allowed — including any organization SCP — and lists the enabled regions.
        </p>

        <div aria-live="polite" className="flex flex-col gap-3">
          {state.kind === "passed" ? (
            <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm">
              <CheckCircleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-(--status-verified)" />
              <p>
                Verified. The role grants everything a report needs
                {state.regions.length > 0
                  ? `, across ${state.regions.length} enabled ${state.regions.length === 1 ? "region" : "regions"}.`
                  : "."}
              </p>
            </div>
          ) : null}
          {state.kind === "refused" ? (
            <div
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
            >
              <ShieldWarningIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
              <p>{state.message}</p>
            </div>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" onClick={verify} disabled={state.kind === "busy"}>
            {state.kind === "busy" ? "Verifying…" : state.kind === "passed" ? "Verify again" : "Verify the role"}
          </Button>
          {state.kind === "passed" ? (
            <Link
              href={`/subscriptions?c=${encodeURIComponent(props.id)}`}
              className={buttonVariants({ variant: "outline" })}
            >
              Go to the connection
            </Link>
          ) : null}
        </div>
      </section>
    </div>
  )
}

function Artifact({
  value,
  label,
  fileName,
  mime,
}: Readonly<{ value: string; label: string; fileName: string; mime: string }>) {
  function download() {
    const url = URL.createObjectURL(new Blob([value], { type: mime }))
    const anchor = document.createElement("a")
    anchor.href = url
    anchor.download = fileName
    anchor.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <pre
        tabIndex={0}
        aria-label={label}
        className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        {value}
      </pre>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={download}>
          <DownloadSimpleIcon aria-hidden="true" />
          Download {fileName}
        </Button>
        <CopyButton value={value} label={`Copy the ${label}`} />
      </div>
    </div>
  )
}
