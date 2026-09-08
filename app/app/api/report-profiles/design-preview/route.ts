import { requireSessionForApi } from "@/lib/auth/guard"
import { designPreviewEnabled } from "@/lib/design-preview/enabled"
import { PreviewRenderError, renderPreview } from "@/lib/design-preview/render"
import { previewSettingsSchema } from "@/lib/design-preview/settings"

export const runtime = "nodejs"

export async function POST(request: Request) {
  if (!designPreviewEnabled()) return new Response(null, { status: 404 })
  if (!(await requireSessionForApi()))
    return Response.json(
      { error: { message: "Sign in to render a design preview." } },
      { status: 401 }
    )
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return Response.json(
      {
        error: {
          stage: "validation",
          message: "The appearance settings must be JSON.",
        },
      },
      { status: 400 }
    )
  }
  const parsed = previewSettingsSchema.safeParse(body)
  if (!parsed.success)
    return Response.json(
      {
        error: {
          stage: "validation",
          message:
            "Check the appearance settings. Use a six-digit hex accent and the available options.",
        },
      },
      { status: 400 }
    )
  try {
    const result = await renderPreview(parsed.data, request.signal)
    return new Response(new Uint8Array(result.pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="design-preview-${parsed.data.preset}.pdf"`,
        "Cache-Control": "no-store",
      },
    })
  } catch (error) {
    const failure =
      error instanceof PreviewRenderError
        ? error
        : new PreviewRenderError(
            "pdf",
            "The preview could not be rendered. Try again."
          )
    return Response.json(
      { error: { stage: failure.stage, message: failure.message } },
      { status: 503 }
    )
  }
}
