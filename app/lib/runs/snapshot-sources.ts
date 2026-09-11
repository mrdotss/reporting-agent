import "server-only"

import { sql } from "drizzle-orm"
import { getDb } from "@/lib/db"

/** Worker-only: resolve artifact owners from persisted, same-project run records.
 * No owner identifier is accepted from a browser request. The current execution
 * identity must match the accepted run even if its requester has since left.
 */
export async function readSnapshotSources(
  executionUserId: string,
  runId: string,
  historicalRunIds: readonly string[]
): Promise<Record<string, string>> {
  if (historicalRunIds.length > 200) throw new Error("Too many historical sources")
  const ids = JSON.stringify(historicalRunIds)
  const result = await getDb().execute<{ id: string; user_id: string }>(sql`
    with recursive anchor as (
      select id,workspace_id,project_id,connected_subscription_id,reuse_snapshot_run_id
      from report_runs where id=${runId} and user_id=${executionUserId}
    ), source_chain as (
      select source.id,source.user_id,source.reuse_snapshot_run_id,1 depth,array[source.id] visited
      from report_runs source join anchor a on source.workspace_id=a.workspace_id
        and source.project_id=a.project_id and source.connected_subscription_id=a.connected_subscription_id
      where source.status='completed' and source.id<>a.id
        and (source.id=a.reuse_snapshot_run_id or source.id in (select jsonb_array_elements_text(${ids}::jsonb)))
      union all
      select source.id,source.user_id,source.reuse_snapshot_run_id,chain.depth+1,chain.visited||source.id
      from source_chain chain join report_runs source on source.id=chain.reuse_snapshot_run_id
      join anchor a on source.workspace_id=a.workspace_id and source.project_id=a.project_id
        and source.connected_subscription_id=a.connected_subscription_id
      where source.status='completed' and source.id<>a.id and chain.depth<24 and not(source.id=any(chain.visited))
    ) select distinct id,user_id from source_chain limit 1000
  `)
  return Object.fromEntries(result.rows.map(row => [row.id, row.user_id]))
}
