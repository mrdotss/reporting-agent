"use client"

import { useCallback, useState } from "react"
import { CaretDownIcon, DownloadSimpleIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { DOWNLOADABLE_LEAF_NAMES } from "@/lib/runs/artifacts"

/**
 * The downloads, as one control, offered only behind a passing verification
 * (Requirement 40).
 *
 * One "Download" button that opens the artifacts, rather than a card of three buttons:
 * the report header is where a reader looks for it, and three buttons there compete with
 * the title. Each item names what it is and its file type.
 *
 * ## The URL is minted at activation, never at render
 *
 * Requirement 40.1, and 40.3 explains why: a presigned URL is a **credential**. Minting
 * at the click means the credential exists for the seconds it takes the browser to follow
 * it, and this component holds no URL in state — the fetched URL is a local `const`
 * inside the handler.
 *
 * ## The gate is upstream, and this is the second line rather than the first
 *
 * `page.tsx` renders this only for a `completed` run with a `pass` verification
 * (Requirement 40.4), and `GET /api/artifact-url` re-checks before any storage call.
 *
 * ## A failed mint keeps the control
 *
 * Requirement 40.7 — an unavailable object states that it is unavailable and keeps the
 * control available for a further activation, so the failure is a message beside the
 * button, not a disabled button.
 */

type ArtifactUrlResponse = {
  readonly url?: string
  readonly error?: { readonly message?: string }
}

const LABEL: Readonly<
  Record<(typeof DOWNLOADABLE_LEAF_NAMES)[number], { name: string; ext: string }>
> = {
  "report.docx": { name: "Word document", ext: ".docx" },
  "report.pdf": { name: "PDF", ext: ".pdf" },
  // The reading copy (requirements 23.11-23.15), laid out by a print stylesheet rather
  // than converted from the Word file — named for what distinguishes it to a reader.
  "report-styled.pdf": { name: "PDF (designed)", ext: ".pdf" },
}

export function DownloadCard({
  artifactKeys,
}: Readonly<{
  /** The run's recorded downloadable keys. Keys, never URLs (Requirement 40.3). */
  artifactKeys: readonly string[]
}>) {
  const [failed, setFailed] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const download = useCallback(async (key: string) => {
    setFailed(null)
    setPending(key)

    try {
      const response = await fetch(`/api/artifact-url?key=${encodeURIComponent(key)}`)
      const body = (await response.json()) as ArtifactUrlResponse

      if (!response.ok || body.url === undefined) {
        // Requirement 40.7 — stated, and the control stays.
        setFailed(
          "That artifact is unavailable for download right now. Nothing about " +
            "the run or its verification changed; try again."
        )
        return
      }

      // Navigating rather than storing: the URL is used once, immediately.
      window.location.assign(body.url)
    } catch {
      setFailed("The download could not be requested — the server could not be reached.")
    } finally {
      setPending(null)
    }
  }, [])

  const downloadable = artifactKeys.filter((key) =>
    DOWNLOADABLE_LEAF_NAMES.some((leaf) => key.endsWith(`/${leaf}`))
  )

  if (downloadable.length === 0) return null

  return (
    <div data-slot="download-card" className="flex flex-col items-end gap-1.5">
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button disabled={pending !== null} />}>
          <DownloadSimpleIcon aria-hidden="true" />
          {pending === null ? "Download" : "Preparing…"}
          <CaretDownIcon aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-56">
          {downloadable.map((key) => {
            const leaf = DOWNLOADABLE_LEAF_NAMES.find((name) => key.endsWith(`/${name}`))
            const label = leaf === undefined ? { name: key, ext: "" } : LABEL[leaf]
            return (
              <DropdownMenuItem key={key} onClick={() => void download(key)}>
                <DownloadSimpleIcon aria-hidden="true" />
                {label.name}
                <span className="ml-auto pl-4 font-mono text-xs text-muted-foreground">
                  {label.ext}
                </span>
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuContent>
      </DropdownMenu>

      {failed === null ? null : (
        <p
          data-slot="download-error"
          aria-live="polite"
          className="max-w-xs text-right text-xs text-muted-foreground"
        >
          {/* Neutral, not `--destructive` (Requirement 39.6): an artifact that could not
              be fetched is not a document that could not be proven. */}
          {failed}
        </p>
      )}
    </div>
  )
}
