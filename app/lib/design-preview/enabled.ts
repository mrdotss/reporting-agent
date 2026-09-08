import "server-only"

export function designPreviewEnabled(): boolean {
  return (
    process.env.NODE_ENV === "development" &&
    process.env.REPORT_DESIGN_PREVIEW === "1"
  )
}
