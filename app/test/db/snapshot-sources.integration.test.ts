import { randomUUID } from "node:crypto"
import { beforeAll, expect, test, vi } from "vitest"
import { drizzle } from "drizzle-orm/node-postgres"
import { withScratchSchema } from "./scratch-schema"
import * as schema from "@/lib/db/schema"
const db = withScratchSchema(import.meta.url)
vi.mock("@/lib/db", () => ({ getDb: () => drizzle(db.pool(), { schema }) }))
import { readSnapshotSources } from "@/lib/runs/snapshot-sources"
import { runCreateInputSchema } from "@/lib/runs/input"
let actor: string, teammate: string, connection: string, current: string, prior: string, foreign: string
beforeAll(async () => {
  if (!db.enabled) return
  ;[actor,teammate,connection,current,prior,foreign] = Array.from({length:6}, () => randomUUID())
  for (const id of [actor,teammate]) await db.query("insert into users(id,email,email_normalized,password_hash) values($1,$2,$2,'fixture')",[id,`${id}@example.test`])
  await db.query("insert into connected_subscriptions(id,user_id,display_name,subscription_id,tenant_id,client_id,client_secret_enc,secret_expires_at,status) values($1,$2,'Fixture',$1,'t','c','fixture',now()+interval '1 day','active')",[connection,actor])
  for (const [id,owner,projectOwner,status] of [[current,actor,actor,'collecting'],[prior,teammate,actor,'completed'],[foreign,teammate,teammate,'completed']]) {
    await db.query("insert into report_runs(id,user_id,workspace_id,project_id,connected_subscription_id,period_start,period_end,timezone,scope,status,dedupe_key,progress_token_hash) values($1,$2,$3,$4,$5,'2026-08-01','2026-08-31','UTC','{}',$6,$1,'fixture')",[id,owner,`imported-${projectOwner}`,`imported-project-${projectOwner}`,connection,status])
  }
  await db.query("update report_runs set reuse_snapshot_run_id=$1 where id=$2",[prior,current])
})
test("resolves a teammate's persisted artifact owner, excluding cross-project sources", async () => {
  expect(await readSnapshotSources(actor,current,[foreign,prior])).toEqual({[prior]:teammate})
})
test("wrong execution identity cannot resolve source owners", async () => {
  expect(await readSnapshotSources(teammate,current,[prior])).toEqual({})
})
test("revoked membership does not strand an accepted execution", async () => {
  await db.query("delete from workspace_members where user_id=$1",[actor])
  expect(await readSnapshotSources(actor,current,[])).toEqual({[prior]:teammate})
})
test("the public request cannot supply artifact owner mappings", () => {
  expect(runCreateInputSchema.safeParse({connectedSubscriptionId:connection,templateId:randomUUID(),timezone:'UTC',snapshot_source_actors:{[prior]:teammate}}).success).toBe(false)
})
