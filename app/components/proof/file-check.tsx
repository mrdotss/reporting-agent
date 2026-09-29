"use client"

import { useState } from "react"
import { CheckCircleIcon, WarningCircleIcon } from "@phosphor-icons/react"

/**
 * Check a file against the verified report's digests — in the browser. The file is hashed
 * with SHA-256 locally and never uploaded; only the answer is shown.
 */
type Match = "pdf" | "docx" | "styled"

const MATCHED: Record<Match, string> = {
  pdf: "the verified PDF",
  docx: "the verified Word file",
  styled: "the verified designed PDF",
}

export function FileCheck({
  pdfSha256,
  docxSha256,
  styledPdfSha256,
}: Readonly<{ pdfSha256: string; docxSha256: string; styledPdfSha256: string | null }>) {
  const [result, setResult] = useState<{ name: string; match: Match | null } | null>(null)
  const [busy, setBusy] = useState(false)

  async function check(file: File) {
    setBusy(true)
    try {
      const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer())
      const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
      const match: Match | null =
        hex === pdfSha256 ? "pdf" : hex === docxSha256 ? "docx" : styledPdfSha256 !== null && hex === styledPdfSha256 ? "styled" : null
      setResult({ name: file.name, match })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label
        htmlFor="proof-file"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault()
          const file = event.dataTransfer.files[0]
          if (file) void check(file)
        }}
        className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-border px-4 py-6 text-center hover:bg-muted/50"
      >
        <span className="text-sm font-medium">{busy ? "Checking…" : "Drop the report's PDF or Word file here"}</span>
        <span className="text-xs text-muted-foreground">or choose it. It is checked in your browser and never uploaded.</span>
        <input
          id="proof-file"
          type="file"
          accept=".pdf,.docx"
          className="sr-only"
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void check(file)
          }}
        />
      </label>
      {result === null ? null : result.match ? (
        <p aria-live="polite" className="flex items-start gap-2 text-sm text-(--status-verified)">
          <CheckCircleIcon aria-hidden="true" weight="fill" className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">{result.name}</span> is {MATCHED[result.match]}, unchanged.
          </span>
        </p>
      ) : (
        <p aria-live="polite" className="flex items-start gap-2 text-sm text-(--status-attention)">
          <WarningCircleIcon aria-hidden="true" weight="fill" className="mt-0.5 size-4 shrink-0" />
          <span>
            <span className="font-medium">{result.name}</span> does not match any file of this verified report. It may have
            been edited, or belong to a different report.
          </span>
        </p>
      )}
    </div>
  )
}
