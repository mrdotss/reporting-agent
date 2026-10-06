import type { AttachableConnector, AttachableLive, AttachableRun, ChatSources } from "@/lib/chat/sources"
import type { ChatCitation, ChatMessageView, ChatThreadView } from "@/lib/chat/views"

/** One shared account for the Ask component tests: a report, a live pull, a connector. */

export const RUN: AttachableRun = {
  runId: "run-1",
  ownerId: "u1",
  attemptId: "a1",
  projectId: "p1",
  customerName: "FATechID",
  periodLabel: "August 2026",
  periodStart: "2026-08-01",
  presetName: "hinsandbox",
  provider: "aws",
  connectorLabel: "hinsandbox",
  resourceCount: 58,
  gapCount: 92,
  figureCount: 409,
  digest: "48e4a65a138a1111",
  verifiedAt: "2026-09-29T17:23:00Z",
}

export const OTHER_RUN: AttachableRun = { ...RUN, runId: "run-2", periodLabel: "July 2026", digest: "d6b394b90476aaaa", figureCount: 402 }

export const LIVE: AttachableLive = {
  id: "l1",
  ownerId: "u1",
  connectorId: "c1",
  connectorLabel: "hinsandbox",
  customerName: "FATechID",
  resourceNames: ["project-api", "jenkins-ci"],
  windowLabel: "7 days",
  periodStart: "2026-09-23",
  periodEnd: "2026-09-30",
  resourceCount: 2,
  gapCount: 0,
  collectedAt: "2026-09-30T09:14:55Z",
}

export const CONNECTOR: AttachableConnector = {
  id: "c1",
  label: "hinsandbox",
  provider: "aws",
  projectId: "p1",
  customerName: "FATechID",
  scan: { id: "s1", collectedAt: "2026-09-16T04:00:00Z", resourceCount: 58, typeCounts: {}, regionCounts: {}, truncated: false },
}

export const UNSCANNED: AttachableConnector = { ...CONNECTOR, id: "c2", label: "hin-prod", customerName: "HIN", scan: null }

export const SOURCES: ChatSources = { runs: [RUN, OTHER_RUN], connectors: [CONNECTOR, UNSCANNED], live: [LIVE] }

const cite = (id: string, source: string, label: string, extra: Partial<ChatCitation> = {}): ChatCitation => ({
  fact_id: id,
  source,
  label,
  formatted: id,
  ...extra,
})

export const CITATIONS: Record<string, ChatCitation> = {
  f1: cite("f1", "report", "CPU p95 · jenkins-ci", {
    run_id: "run-1",
    customer_name: "FATechID",
    period_display: "August 2026",
    snapshot_path: "resources/3/statistics/0",
  }),
  f2: cite("f2", "live", "CPU p95 · project-api", { connector_label: "hinsandbox", period_display: "23–30 Sep" }),
  f3: cite("f3", "price", "m5.xlarge · on-demand", { price_source: "AWS Price List", currency: "USD" }),
}

export const ANSWER_TEXT =
  "jenkins-ci ran at ⟦fig:f1⟧6.2%⟦/fig⟧ and project-api at ⟦fig:f2⟧4.1%⟦/fig⟧. At ⟦fig:f3⟧$0.192/h⟦/fig⟧ one size down saves ⟦est⟧about $70⟦/est⟧."

export const QUESTION: ChatMessageView = {
  id: "m1",
  threadId: "t1",
  role: "user",
  text: "Which instances look over-provisioned?",
  authorId: "u1",
  createdAt: "2026-09-30T07:02:00Z",
  citations: {},
  steps: [],
}

export const ANSWER: ChatMessageView = {
  id: "m2",
  threadId: "t1",
  role: "assistant",
  text: ANSWER_TEXT,
  authorId: "assistant",
  createdAt: "2026-09-30T07:03:00Z",
  citations: CITATIONS,
  steps: [],
  model: "kimi-k3",
  thoughtSeconds: 18,
}

export const THREAD: ChatThreadView = {
  id: "t1",
  workspaceId: "w1",
  title: "Over-provisioned VMs",
  createdBy: "u1",
  createdAt: "2026-09-30T07:02:00Z",
  updatedAt: "2026-09-30T07:03:00Z",
  messageCount: 2,
  attachments: { runIds: ["run-1"], connectorIds: [], liveIds: ["l1"] },
}
