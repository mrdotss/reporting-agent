import "server-only"

import { getPool } from "@/lib/db"

import { buildBoard, type Board, type BoardProject, type BoardRun } from "./board"
import { closePeriod, trailingMonths, type ClosePeriod } from "./period"

/** The zone every period is resolved in when a run does not say otherwise. */
export const CLOSE_TIMEZONE = "Asia/Jakarta"

/** How many months the period board shows, ending at the open one. */
export const BOARD_MONTHS = 6

/**
 * The close for one workspace: its open period and the board of customers under it.
 *
 * Two queries, both joined through `workspace_members` so a user who is not a member
 * reads nothing, whatever ids they pass.
 */
export async function loadClose(
  userId: string,
  workspace: { id: string; closeDay: number },
  now: Date = new Date()
): Promise<{ period: ClosePeriod; board: Board }> {
  const period = closePeriod(now, workspace.closeDay, CLOSE_TIMEZONE)
  const months = trailingMonths(period.month, BOARD_MONTHS)
  const first = `${months[0]}-01`

  const [projects, runs] = await Promise.all([
    getPool().query<BoardProject>(
      `select p.id, p.name, p.archived_at is not null as archived,
              to_char(p.created_at at time zone $3, 'YYYY-MM') as "createdMonth",
              (select c.display_name from connected_subscriptions c
                where c.project_id = p.id order by c.display_name limit 1) as connector,
              (select t.name from report_templates t
                where t.project_id = p.id order by t.name limit 1) as preset
         from projects p
         join workspace_members m on m.workspace_id = p.workspace_id and m.user_id = $1
        where p.workspace_id = $2
        order by p.created_at, p.id`,
      [userId, workspace.id, CLOSE_TIMEZONE]
    ),
    getPool().query<BoardRun>(
      `select r.id, r.project_id as "projectId",
              to_char(r.period_start, 'YYYY-MM') as month,
              r.status,
              to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as "createdAt",
              (select max(v.figure_count) from report_verifications v where v.run_id = r.id) as figures
         from report_runs r
         join workspace_members m on m.workspace_id = r.workspace_id and m.user_id = $1
        where r.workspace_id = $2
          and r.project_id is not null
          and r.period_start >= $3::date`,
      [userId, workspace.id, first]
    ),
  ])

  return {
    period,
    board: buildBoard(projects.rows, runs.rows, months, period.month),
  }
}
