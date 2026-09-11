import { z } from "zod"
import { and,eq } from "drizzle-orm"
import { requireSessionForApi } from "@/lib/auth/guard"
import { json,unauthorized,invalidInput,notFound } from "@/lib/api/response"
import { getDb } from "@/lib/db"
import { connectedSubscriptions,reportTemplates } from "@/lib/db/schema"
import { accessWhere } from "@/lib/workspaces/access"
import { readLatestVersion } from "@/lib/templates/store"
import { resolvePeriod, type PeriodSpec } from "@/lib/templates/period"
const querySchema=z.object({connectedSubscriptionId:z.string().min(1).max(200),templateId:z.string().min(1).max(200),timezone:z.string().min(1).max(100) }).strict()
export const runtime = "nodejs"
export async function GET(request:Request){
 const user=await requireSessionForApi();if(!user)return unauthorized()
 const parsed=querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));if(!parsed.success)return invalidInput(parsed.error)
 const d=parsed.data
 const [pair]=await getDb().select({name:connectedSubscriptions.displayName}).from(reportTemplates).innerJoin(connectedSubscriptions,and(eq(connectedSubscriptions.id,d.connectedSubscriptionId),eq(connectedSubscriptions.projectId,reportTemplates.projectId),eq(connectedSubscriptions.workspaceId,reportTemplates.workspaceId))).where(and(eq(reportTemplates.id,d.templateId),accessWhere(reportTemplates,user.id),accessWhere(connectedSubscriptions,user.id))).limit(1)
 if(!pair)return notFound()
 const version=await readLatestVersion(user.id,d.templateId);if(!version)return json(422,{error:{message:"Save a profile version before requesting a report."}})
 const definition=version.definition as {period:PeriodSpec;design?:{preset?:string;page_size?:string};sections?:unknown[]}
 try {
 const period=resolvePeriod(definition.period,new Date(),d.timezone)
 if(!period.ok)return json(422,{error:{message:"This profile’s period cannot currently be collected. Review its Period settings."}})
 return json(200,{connection:pair.name,version:version.version,periodStart:period.start,periodEnd:period.end,timezone:d.timezone,theme:definition.design?.preset??"Document default",sections:definition.sections?.length??null})
 }catch{return json(400,{error:{message:"Choose a valid timezone and profile period."}})}
}
