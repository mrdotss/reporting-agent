import { notFound } from "next/navigation"
import { requireSession } from "@/lib/auth/guard"
import { selectedContext, workspaceUiEnabled } from "@/lib/workspaces/context"
import { getPool } from "@/lib/db"
import { ProjectManager } from "@/components/workspaces/project-manager"
export default async function ProjectsPage(){
 const user=await requireSession()
 if(!workspaceUiEnabled())notFound()
 const context=await selectedContext(user.id)
 const {rows}=await getPool().query(`select p.id,p.name,p.description,p.archived_at as "archivedAt",
 (select count(*)::int from connected_subscriptions c where c.project_id=p.id) connections,
 (select count(*)::int from report_templates t where t.project_id=p.id) profiles,
 (select count(*)::int from report_runs r where r.project_id=p.id) reports
 from projects p join workspace_members m on m.workspace_id=p.workspace_id where p.workspace_id=$1 and m.user_id=$2 order by p.created_at`,[context.workspace.id,user.id])
 return <ProjectManager projects={rows}/>
}
