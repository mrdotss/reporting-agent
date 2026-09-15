import "server-only"

import { desc, inArray } from "drizzle-orm"

import {
  COMMAND_CHAT,
  type ChatCommand,
  type ChatLiveAttachment,
  type ChatRequestTarget,
  type ChatRunAttachment,
  type ChatScanAttachment,
} from "@/lib/aws/agentcore"
import { answerPlainText, type ChatMessageView, type ChatThreadView } from "@/lib/chat/views"
import { monthName } from "@/lib/close/period"
import { getDb } from "@/lib/db"
import { reportVerifications } from "@/lib/db/schema"
import { toTemplateView, type ScanView, type TemplateView } from "@/lib/db/views"
import { listLivePulls } from "@/lib/live-metrics/execute"
import { windowLabel } from "@/lib/live-metrics/window"
import { resolveRunExtrasBatch } from "@/lib/runs/detail"
import { listOwnedRuns } from "@/lib/runs/state"
import { readLatestScan } from "@/lib/scans/store"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { listTemplates, readLatestVersionForView } from "@/lib/templates/store"
import { listProjects } from "@/lib/workspaces/store"

/**
 * What a conversation may read, decided in Postgres at the moment it is needed
 * (ask-chat Req 2, 6, 8).
 *
 * The runtime trusts the payload it is sent, so this module is where trust is earned:
 *
 * - a **report** is attachable only when it is a completed run in the workspace whose
 *   **latest** verification passed — the attempt id sent is that latest attempt's;
 * - a **connector** contributes only its latest *complete* saved scan, projected to counts;
 * - a **live metrics pull** is attachable once it completed, in this workspace; its figures
 *   are cited as live and unverified;
 * - a **request target** is a connector with a customer in this workspace, under an opaque
 *   id the runtime can echo but not invent.
 *
 * {@link buildChatTurn} re-reads all of them on every message, so a report whose
 * verification was superseded, or a connector removed, stops being read on the next turn
 * rather than living on in a thread's stored attachment list.
 */

export const ATTACHABLE_RUN_LIMIT = 100
export const HISTORY_TURNS = 12

export type AttachableRun = {
  readonly runId: string
  readonly ownerId: string
  readonly attemptId: string
  readonly projectId: string | null
  readonly customerName: string
  readonly periodLabel: string
  readonly periodStart: string
  readonly presetName: string | null
  readonly provider: string
  readonly connectorLabel: string
  readonly resourceCount: number | null
  readonly gapCount: number | null
  readonly figureCount: number
  readonly digest: string
  readonly verifiedAt: string
}

export type AttachableConnector = {
  readonly id: string
  readonly label: string
  readonly provider: string
  readonly projectId: string | null
  readonly customerName: string | null
  readonly scan: {
    readonly id: string
    readonly collectedAt: string
    readonly resourceCount: number | null
    readonly typeCounts: unknown
    readonly regionCounts: unknown
    readonly truncated: boolean | null
  } | null
}

export type AttachableLive = {
  readonly id: string
  readonly ownerId: string
  readonly connectorId: string
  readonly connectorLabel: string
  readonly customerName: string | null
  readonly resourceNames: readonly string[]
  readonly windowLabel: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly resourceCount: number | null
  readonly gapCount: number | null
  readonly collectedAt: string
}

export type ChatSources = {
  readonly runs: readonly AttachableRun[]
  readonly connectors: readonly AttachableConnector[]
  readonly live: readonly AttachableLive[]
}

/** The runtime's view of a proposal target, kept server-side and resolved at `done`. */
export type ProposalTarget = {
  readonly workspaceId: string
  readonly projectId: string
  readonly connectedSubscriptionId: string
  readonly customerName: string
  readonly connectorLabel: string
  readonly provider: string
}

export function periodLabel(start: string, end: string): string {
  const month = start.slice(0, 7)
  const wholeMonth = start.endsWith("-01") && end.slice(0, 7) === month
  return wholeMonth ? monthName(month) : `${start} – ${end}`
}

export async function listChatSources(userId: string, workspaceId: string): Promise<ChatSources> {
  const [runs, connectors] = await Promise.all([
    listAttachableRuns(userId, workspaceId),
    listAttachableConnectors(userId, workspaceId),
  ])
  const live = await listAttachableLive(userId, workspaceId, connectors)
  return { runs, connectors, live }
}

export async function listAttachableRuns(
  userId: string,
  workspaceId: string
): Promise<AttachableRun[]> {
  const [runs, projects, connectors] = await Promise.all([
    listOwnedRuns(userId, { workspaceId, statuses: ["completed"], limit: ATTACHABLE_RUN_LIMIT }),
    listProjects(userId, workspaceId),
    listConnectedSubscriptions(userId, { workspaceId }),
  ])
  if (runs.length === 0) return []

  const [verifications, extras] = await Promise.all([
    getDb()
      .select({
        runId: reportVerifications.runId,
        attemptId: reportVerifications.attemptId,
        status: reportVerifications.status,
        figureCount: reportVerifications.figureCount,
        snapshotSha256: reportVerifications.snapshotSha256,
        createdAt: reportVerifications.createdAt,
      })
      .from(reportVerifications)
      .where(inArray(reportVerifications.runId, runs.map((run) => run.id)))
      .orderBy(desc(reportVerifications.createdAt)),
    resolveRunExtrasBatch(runs),
  ])

  // The first row per run is its latest attempt, because the read is newest first.
  const latest = new Map<string, (typeof verifications)[number]>()
  for (const row of verifications) {
    if (!latest.has(row.runId)) latest.set(row.runId, row)
  }

  const projectName = new Map(projects.map((project) => [project.id, project.name]))
  const connectorOf = new Map(connectors.map((connector) => [connector.id, connector]))

  return runs.flatMap((run): AttachableRun[] => {
    const verification = latest.get(run.id)
    if (verification === undefined || verification.status !== "pass") return []
    const connector = connectorOf.get(run.connectedSubscriptionId)

    return [
      {
        runId: run.id,
        ownerId: run.userId,
        attemptId: verification.attemptId,
        projectId: run.projectId,
        customerName:
          run.customerName ??
          (run.projectId === null ? undefined : projectName.get(run.projectId)) ??
          connector?.displayName ??
          "Unassigned",
        periodLabel: periodLabel(run.periodStart, run.periodEnd),
        periodStart: run.periodStart,
        presetName: extras.get(run.id)?.templateName ?? null,
        provider: connector?.provider ?? "azure",
        connectorLabel: connector?.displayName ?? "Removed connector",
        resourceCount: run.resourceCount,
        gapCount: run.gapCount,
        figureCount: verification.figureCount,
        digest: verification.snapshotSha256.slice(0, 12),
        verifiedAt: verification.createdAt.toISOString(),
      },
    ]
  })
}

export async function listAttachableConnectors(
  userId: string,
  workspaceId: string
): Promise<AttachableConnector[]> {
  const [connectors, projects] = await Promise.all([
    listConnectedSubscriptions(userId, { workspaceId }),
    listProjects(userId, workspaceId),
  ])
  const projectOf = new Map(projects.map((project) => [project.id, project]))

  return await Promise.all(
    connectors.map(async (connector): Promise<AttachableConnector> => {
      const scan = await readLatestScan(userId, connector.id)
      const project = connector.projectId ? projectOf.get(connector.projectId) : undefined
      return {
        id: connector.id,
        label: connector.displayName,
        provider: connector.provider,
        projectId: connector.projectId ?? null,
        customerName: project?.name ?? null,
        scan: completeScan(scan),
      }
    })
  )
}

/** The workspace's completed live metrics pulls, newest first, labelled by connector. */
export async function listAttachableLive(
  userId: string,
  workspaceId: string,
  connectors: readonly AttachableConnector[]
): Promise<AttachableLive[]> {
  const pulls = await listLivePulls(userId, workspaceId)
  const connectorOf = new Map(connectors.map((connector) => [connector.id, connector]))
  return pulls.map((pull) => {
    const connector = connectorOf.get(pull.connectedSubscriptionId)
    return {
      id: pull.id,
      ownerId: pull.userId,
      connectorId: pull.connectedSubscriptionId,
      connectorLabel: connector?.label ?? "Removed connector",
      customerName: connector?.customerName ?? null,
      resourceNames: [...pull.resourceNames],
      windowLabel: windowLabel({ start: pull.periodStart, end: pull.periodEnd }),
      periodStart: pull.periodStart,
      periodEnd: pull.periodEnd,
      resourceCount: pull.resourceCount,
      gapCount: pull.gapCount,
      collectedAt: (pull.completedAt ?? pull.createdAt).toISOString(),
    }
  })
}

function completeScan(scan: ScanView | null): AttachableConnector["scan"] {
  if (scan === null || scan.status !== "complete" || scan.completedAt === null) return null
  return {
    id: scan.id,
    collectedAt: scan.completedAt,
    resourceCount: scan.resourceCount,
    typeCounts: scan.typeCounts,
    regionCounts: scan.regionCounts,
    truncated: scan.truncated,
  }
}

/**
 * The presets a proposal for this customer and connector may be requested with: runnable
 * (a version exists) and written for the connector's source.
 */
export async function listProposalPresets(
  userId: string,
  scope: { readonly workspaceId: string; readonly projectId: string },
  provider: string
): Promise<TemplateView[]> {
  const rows = await listTemplates(userId, scope)
  const views = await Promise.all(
    rows.map(async (row) =>
      toTemplateView(row, (await readLatestVersionForView(userId, row.id)) ?? null)
    )
  )
  return views.filter(
    (template) => template.provider === provider && template.currentVersion !== null
  )
}

export type ChatTurn = {
  readonly command: ChatCommand
  readonly targets: ReadonlyMap<string, ProposalTarget>
  readonly attachedRuns: number
  readonly attachedScans: number
  readonly attachedLive: number
}

/**
 * The `chat` payload for one message, re-authorized now (ask-chat Req 2.2).
 *
 * `history` is the thread's last turns as plain text — markers stripped, failed turns
 * skipped — so the runtime never receives a figure chip it did not itself produce.
 */
export async function buildChatTurn(a: {
  readonly userId: string
  readonly thread: ChatThreadView
  readonly prompt: string
  readonly previous: readonly ChatMessageView[]
}): Promise<ChatTurn> {
  const [sources, projects] = await Promise.all([
    listChatSources(a.userId, a.thread.workspaceId),
    listProjects(a.userId, a.thread.workspaceId),
  ])
  const { runs, connectors, live } = sources

  const wantedRuns = new Set(a.thread.attachments.runIds)
  const wantedConnectors = new Set(a.thread.attachments.connectorIds)
  const wantedLive = new Set(a.thread.attachments.liveIds ?? [])

  const runAttachments: ChatRunAttachment[] = runs
    .filter((run) => wantedRuns.has(run.runId))
    .map((run) => ({
      run_id: run.runId,
      owner_actor_id: run.ownerId,
      verification_attempt_id: run.attemptId,
      customer_name: run.customerName,
      period_display: run.periodLabel,
      provider: run.provider,
    }))

  const scanAttachments: ChatScanAttachment[] = connectors.flatMap((connector) =>
    wantedConnectors.has(connector.id) && connector.scan !== null
      ? [
          {
            scan_id: connector.scan.id,
            connector_label: connector.label,
            provider: connector.provider,
            collected_at: connector.scan.collectedAt,
            inventory: {
              resourceCount: connector.scan.resourceCount,
              typeCounts: connector.scan.typeCounts,
              regionCounts: connector.scan.regionCounts,
              truncated: connector.scan.truncated,
            },
          },
        ]
      : []
  )

  const liveAttachments: ChatLiveAttachment[] = live
    .filter((pull) => wantedLive.has(pull.id))
    .map((pull) => ({
      pull_id: pull.id,
      owner_actor_id: pull.ownerId,
      connector_label: pull.connectorLabel,
      window_display: pull.windowLabel,
      collected_at: pull.collectedAt,
    }))

  const activeProjects = new Map(
    projects.filter((project) => !project.archivedAt).map((project) => [project.id, project])
  )
  const targets = new Map<string, ProposalTarget>()
  const requestTargets: ChatRequestTarget[] = []
  for (const connector of connectors) {
    const project = connector.projectId ? activeProjects.get(connector.projectId) : undefined
    if (project === undefined) continue
    const targetId = `t${targets.size + 1}`
    targets.set(targetId, {
      workspaceId: a.thread.workspaceId,
      projectId: project.id,
      connectedSubscriptionId: connector.id,
      customerName: project.name,
      connectorLabel: connector.label,
      provider: connector.provider,
    })
    requestTargets.push({
      target_id: targetId,
      customer_name: project.name,
      connector_label: connector.label,
      provider: connector.provider,
    })
  }

  const history = a.previous
    .filter((message) => !message.failed && message.text.trim().length > 0)
    .slice(-HISTORY_TURNS)
    .map((message) => ({
      role: message.role,
      text: answerPlainText(message.text).slice(0, 4000),
    }))

  return {
    command: {
      command: COMMAND_CHAT,
      prompt: a.prompt,
      history,
      attachments: { runs: runAttachments, scans: scanAttachments, live: liveAttachments },
      request_targets: requestTargets.slice(0, 50),
    },
    targets,
    attachedRuns: runAttachments.length,
    attachedScans: scanAttachments.length,
    attachedLive: liveAttachments.length,
  }
}
