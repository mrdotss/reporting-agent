import { NextResponse } from "next/server"

/**
 * `/api/templates/catalog` → `/api/report-profiles/catalog` (task 3.14).
 */
export const runtime = "nodejs"

export async function GET(request: Request): Promise<NextResponse> {
  const url = new URL(request.url)
  url.pathname = url.pathname.replace(/^\/api\/templates/, "/api/report-profiles")
  return NextResponse.redirect(url, 308)
}
