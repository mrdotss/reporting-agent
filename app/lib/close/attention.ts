import "server-only"

import type { CloseState } from "@/components/ui/status-mark"
import { getPool } from "@/lib/db"
import { resolveSubscriptionState } from "@/lib/subscriptions/state"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"

import { outstanding, type Board } from "./board"

/**
 * What stands between the open month and done.
 *
 * Three kinds of blocker, and only these three, because each is something the
 * consultant can act on from the item itself: a customer whose report failed or was
 * never requested, a connector whose secret is about to stop authenticating (the one
 * failure that produces a plausible-looking empty report), and a preset that cannot be
 * run because it names no customer.
 */
export type AttentionItem = Readonly<{
  key: string
  state: CloseState
  title: string
  body: string
  action: Readonly<
    | { kind: "request"; projectId: string; label: "Request" | "Retry" }
    | { kind: "link"; href: string; label: string }
  >
}>

export async function loadAttention(
  userId: string,
  workspaceId: string,
  board: Board,
  now: Date = new Date()
): Promise<readonly AttentionItem[]> {
  const items: AttentionItem[] = []

  for (const row of outstanding(board)) {
    const { state } = row.current
    if (state === "undelivered") {
      items.push({
        key: `customer:${row.project.id}`,
        state,
        title: row.project.name,
        body: "The latest run was not delivered, so no document went out.",
        action: { kind: "request", projectId: row.project.id, label: "Retry" },
      })
    } else if (state === "due") {
      items.push({
        key: `customer:${row.project.id}`,
        state,
        title: row.project.name,
        body: "This period hasn’t been requested yet.",
        action: { kind: "request", projectId: row.project.id, label: "Request" },
      })
    }
  }

  const [subscriptions, presets] = await Promise.all([
    listConnectedSubscriptions(userId, { workspaceId }),
    getPool().query<{ id: string; name: string }>(
      `select t.id, t.name
         from report_templates t
         join workspace_members m on m.workspace_id = t.workspace_id and m.user_id = $1
         join report_template_versions v on v.id = t.current_version_id
        where t.workspace_id = $2
          and coalesce(v.definition -> 'identity' ->> 'customer_name', '') = ''
        order by t.name`,
      [userId, workspaceId]
    ),
  ])

  for (const subscription of subscriptions) {
    const connectorState = resolveSubscriptionState(subscription, now)
    const href = "/subscriptions"
    if (connectorState.kind === "expiring") {
      items.push({
        key: `connector:${subscription.id}`,
        state: "attention",
        title: subscription.displayName,
        body: `Client secret expires in ${connectorState.wholeDaysRemaining} ${
          connectorState.wholeDaysRemaining === 1 ? "day" : "days"
        }. Runs start failing when it does.`,
        action: { kind: "link", href, label: "Rotate" },
      })
    } else if (connectorState.kind === "expired" || connectorState.kind === "disabled") {
      items.push({
        key: `connector:${subscription.id}`,
        state: "undelivered",
        title: subscription.displayName,
        body:
          connectorState.kind === "expired"
            ? "Client secret has expired. Runs against it return nothing until it’s rotated."
            : "Azure rejected this credential. Runs against it can’t authenticate.",
        action: { kind: "link", href, label: "Rotate" },
      })
    }
  }

  for (const preset of presets.rows) {
    items.push({
      key: `preset:${preset.id}`,
      state: "attention",
      title: `${preset.name} preset`,
      body: "No customer name, so a run can’t be requested from it.",
      action: {
        kind: "link",
        href: `/report-profiles/${preset.id}/edit`,
        label: "Fix",
      },
    })
  }

  return items
}
