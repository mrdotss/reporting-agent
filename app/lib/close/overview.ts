import "server-only"

import { getPool } from "@/lib/db"

/**
 * The two reads the blocks under the close board need beyond the board itself: each
 * connector's health, and the workspace's recent activity.
 *
 * Both are joined through `workspace_members`, like `loadClose`, so a user who is not a
 * member reads nothing whatever ids they pass. Neither returns a credential or an
 * account id: a display name, a provider, dates and counts.
 */

export type ConnectorHealth = Readonly<{
  id: string
  displayName: string
  provider: "aws" | "azure"
  status: string
  /** ISO instant, Azure only. */
  secretExpiresAt: string | null
  /** ISO instant of the last completed scan, if any. */
  scannedAt: string | null
  resourceCount: number | null
}>

export type ActivityItem = Readonly<{
  key: string
  kind: "verified" | "failed" | "sent" | "opened" | "scanned"
  /** Customer or connector name. */
  subject: string
  /** `YYYY-MM` of the run's period, for report events. */
  month: string | null
  count: number | null
  /** ISO instant. */
  at: string
  href: string | null
}>

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`

export async function loadOverview(
  userId: string,
  workspaceId: string,
  limit = 6
): Promise<{ connectors: readonly ConnectorHealth[]; activity: readonly ActivityItem[] }> {
  const [connectors, activity] = await Promise.all([
    getPool().query<ConnectorHealth>(
      `select c.id, c.display_name as "displayName", c.provider, c.status,
              to_char(c.secret_expires_at at time zone 'UTC', ${ISO}) as "secretExpiresAt",
              to_char(s.completed_at at time zone 'UTC', ${ISO}) as "scannedAt",
              s.resource_count as "resourceCount"
         from connected_subscriptions c
         join workspace_members m on m.workspace_id = c.workspace_id and m.user_id = $1
         left join lateral (
           select x.completed_at, x.resource_count from subscription_scans x
            where x.connected_subscription_id = c.id and x.status = 'complete'
            order by x.completed_at desc nulls last limit 1
         ) s on true
        where c.workspace_id = $2
        order by c.created_at, c.id`,
      [userId, workspaceId]
    ),
    getPool().query<ActivityItem>(
      `select * from (
         select 'run:' || r.id as key,
                case when r.status = 'completed' then 'verified' else 'failed' end as kind,
                p.name as subject, to_char(r.period_start, 'YYYY-MM') as month,
                (select max(v.figure_count) from report_verifications v where v.run_id = r.id) as count,
                to_char(r.updated_at at time zone 'UTC', ${ISO}) as at,
                '/reports/' || r.id as href
           from report_runs r
           join projects p on p.id = r.project_id
           join workspace_members m on m.workspace_id = r.workspace_id and m.user_id = $1
          where r.workspace_id = $2 and r.status in ('completed', 'failed')
         union all
         select 'delivery:' || d.id || ':' || case when d.first_opened_at is null then 'sent' else 'opened' end,
                case when d.first_opened_at is null then 'sent' else 'opened' end,
                p.name, to_char(r.period_start, 'YYYY-MM'), null,
                to_char(coalesce(d.first_opened_at, d.created_at) at time zone 'UTC', ${ISO}),
                '/reports/' || r.id
           from report_deliveries d
           join report_runs r on r.id = d.run_id
           join projects p on p.id = r.project_id
           join workspace_members m on m.workspace_id = r.workspace_id and m.user_id = $1
          where r.workspace_id = $2 and d.status in ('sent', 'partial')
         union all
         select 'scan:' || s.id, 'scanned', c.display_name, null, s.resource_count,
                to_char(s.completed_at at time zone 'UTC', ${ISO}),
                '/subscriptions?c=' || c.id
           from subscription_scans s
           join connected_subscriptions c on c.id = s.connected_subscription_id
           join workspace_members m on m.workspace_id = s.workspace_id and m.user_id = $1
          where s.workspace_id = $2 and s.status = 'complete' and s.completed_at is not null
       ) events
       order by at desc
       limit $3`,
      [userId, workspaceId, limit]
    ),
  ])

  return { connectors: connectors.rows, activity: activity.rows }
}
