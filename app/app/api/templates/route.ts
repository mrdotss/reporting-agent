import { NextResponse } from "next/server"

/**
 * `/api/templates` → `/api/report-profiles` (task 3.14).
 *
 * A 308 (permanent, method-preserving) rather than 307: every caller of this
 * route already knows to expect a redirect target that keeps the same method
 * and body, and 308 is the one status code that guarantees a client does not
 * silently downgrade a `POST` to a `GET` on the hop — which 302/303 permit and
 * this endpoint's `POST` (publish a version) cannot afford.
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

export async function POST(request: Request): Promise<NextResponse> {
  return redirectTo(request)
}
