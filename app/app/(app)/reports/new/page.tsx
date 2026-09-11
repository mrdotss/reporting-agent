import Link from "next/link"
import { notFound } from "next/navigation"
import { requireSession } from "@/lib/auth/guard"
import { selectedContext,workspaceUiEnabled } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"
import { listConnectedSubscriptions } from "@/lib/subscriptions/store"
import { listTemplates,readLatestVersionForView } from "@/lib/templates/store"
import { toTemplateView } from "@/lib/db/views"
import { RunForm } from "@/components/reports/run-form"
export default async function NewReportPage(){
 const user=await requireSession();if(!workspaceUiEnabled())notFound()
 const {workspace,project}=await selectedContext(user.id)
 if(!project||project.archivedAt||!can(workspace.role,"edit"))return <div className="space-y-3"><h1>Select an active customer project.</h1><p className="text-muted-foreground">Report requests require Editor access or higher.</p><Link href="/projects" className="text-primary underline">View projects</Link></div>
 const scope={workspaceId:workspace.id,projectId:project.id}
 const [subscriptions,rows]=await Promise.all([listConnectedSubscriptions(user.id,scope),listTemplates(user.id,scope)])
 const templates=await Promise.all(rows.map(async r=>toTemplateView(r,(await readLatestVersionForView(user.id,r.id))??null)))
 return <div className="space-y-7"><div><Link href="/reports" className="text-sm text-muted-foreground">← All reports</Link><h1 className="mt-4">Prepare your next report.</h1><p className="mt-2 text-sm text-muted-foreground">Choose a saved profile and review its period, scope, and document settings.</p></div><RunForm subscriptions={subscriptions} templates={templates} nowIso={new Date().toISOString()}/></div>
}
