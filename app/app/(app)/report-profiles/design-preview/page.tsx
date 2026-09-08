import { notFound } from "next/navigation"
import { DesignPreview } from "@/components/templates/design-preview/design-preview"
import { designPreviewEnabled } from "@/lib/design-preview/enabled"

export default function DesignPreviewPage() {
  if (!designPreviewEnabled()) notFound()
  return <DesignPreview />
}
