import { NextResponse } from "next/server"

/**
 * `/api/templates/[id]` → `/api/report-profiles/[id]` (task 3.14).
 *
 * 308 (permanent, method-preserving) — see the sibling redirect at
 * `/api/templates/route.ts` for why 308 specifically, over 302/303/307.
 */
export const runtime = "nodejs"

function redirectTo(request: Request): NextResponse {
  const url = new URL(request.url)
  url.pathname = url.pathname.replace(/^\/api\/templates/, "/api/report-profiles")
  return NextResponse.redirect(url, 308)
}

export async function GET(request: Request): Promise<NextResponse> {
  return redirectTo(request)
}

export async function PATCH(request: Request): Promise<NextResponse> {
  return redirectTo(request)
}

export async function POST(request: Request): Promise<NextResponse> {
  return redirectTo(request)
}

export async function DELETE(request: Request): Promise<NextResponse> {
  return redirectTo(request)
}
