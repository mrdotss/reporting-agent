import { NextResponse } from "next/server"

/**
 * `/api/templates/[id]/preview` → `/api/report-profiles/[id]/preview` (task 3.14).
 */
export const runtime = "nodejs"

export async function POST(request: Request): Promise<NextResponse> {
  const url = new URL(request.url)
  url.pathname = url.pathname.replace(/^\/api\/templates/, "/api/report-profiles")
  return NextResponse.redirect(url, 308)
}
