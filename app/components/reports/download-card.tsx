"use client"

import { useCallback, useState } from "react"
import { DownloadSimpleIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { DOWNLOADABLE_LEAF_NAMES } from "@/lib/runs/artifacts"

/**
 * The two download controls, offered only behind a passing verification
 * (Requirement 40).
 *
 * ## The URL is minted at activation, never at render
 *
 * Requirement 40.1, and 40.3 explains why: a presigned URL is a **credential**,
 * and one placed in a server-rendered payload is a credential in the page
 * source, in the RSC flight data, and in whatever cached that response. Minting
 * at the click means the credential exists for the seconds it takes the browser
 * to follow it.
 *
 * That is also why this component holds no URL in state after the navigation.
 * There is no `useState<string>` carrying a link here — the fetched URL is a
 * local `const` inside the handler and is gone when it returns.
 *
 * ## The gate is upstream, and this is the second line rather than the first
 *
 * `page.tsx` renders this component only for a `completed` run with a `pass`
 * verification (Requirement 40.4), and `GET /api/artifact-url` re-checks all
 * four assertions before any storage call (40.2). Neither is redundant: a
 * control that is not rendered is not a control that cannot be reached, and the
 * route is what makes "no route and no action returns one" true.
 *
 * ## A failed mint keeps the control
 *
 * Requirement 40.7 — an unavailable object states that it is unavailable, leaves
 * the row and the verification unchanged, and **keeps the control available for
 * a further activation**. So the failure is a message beside the button, not a
 * disabled button: a transient S3 error should cost a retry, not the ability to
 * download a report that verified.
 */

type ArtifactUrlResponse = {
  readonly url?: string
  readonly error?: { readonly message?: string }
}

const LABEL: Readonly<
  Record<(typeof DOWNLOADABLE_LEAF_NAMES)[number], string>
> = {
  "report.docx": "Word document",
  "report.pdf": "PDF",
}

export function DownloadCard({
  artifactKeys,
}: Readonly<{
  /**
   * The run's recorded downloadable keys.
   *
   * Keys, never URLs — `RunView.artifactKeys` carries keys precisely so a run
   * payload can be rendered and cached without carrying a credential
   * (Requirement 40.3).
   */
  artifactKeys: readonly string[]
}>) {
  const [failed, setFailed] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)

  const download = useCallback(async (key: string) => {
    setFailed(null)
    setPending(key)

    try {
      const response = await fetch(
        `/api/artifact-url?key=${encodeURIComponent(key)}`
      )

      const body = (await response.json()) as ArtifactUrlResponse

      if (!response.ok || body.url === undefined) {
        // Requirement 40.7 — stated, and the control stays.
        setFailed(
          "That artifact is unavailable for download right now. Nothing about " +
            "the run or its verification changed; try again."
        )
        return
      }

      // Navigating rather than storing: the URL is used once, immediately, and
      // is never held anywhere this component could later render it.
      window.location.assign(body.url)
    } catch {
      setFailed(
        "The download could not be requested — the server could not be reached."
      )
    } finally {
      setPending(null)
    }
  }, [])

  const downloadable = artifactKeys.filter((key) =>
    DOWNLOADABLE_LEAF_NAMES.some((leaf) => key.endsWith(`/${leaf}`))
  )

  if (downloadable.length === 0) return null

  return (
    <section
      data-slot="download-card"
      className="flex flex-col gap-3 rounded-xl border border-border px-4 py-4"
    >
      <div className="flex flex-col gap-0.5">
        <h2 className="font-heading text-sm font-medium tracking-tight">
          Download
        </h2>

        <p className="max-w-prose text-sm text-muted-foreground">
          Every figure in these documents traced to the snapshot named above.
          Links are minted when you press the button and expire within five
          minutes.
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {downloadable.map((key) => {
          const leaf = DOWNLOADABLE_LEAF_NAMES.find((name) =>
            key.endsWith(`/${name}`)
          )

          return (
            <Button
              key={key}
              type="button"
              variant="outline"
              disabled={pending === key}
              onClick={() => void download(key)}
            >
              <DownloadSimpleIcon aria-hidden="true" />
              {pending === key
                ? "Preparing…"
                : leaf === undefined
                  ? key
                  : LABEL[leaf]}
            </Button>
          )
        })}
      </div>

      {failed === null ? null : (
        <p
          data-slot="download-error"
          aria-live="polite"
          className="max-w-prose text-sm text-muted-foreground"
        >
          {/*
            Mist neutrals, not `--destructive` (Requirement 39.6). An artifact
            that could not be fetched is not a document that could not be proven,
            and the token means only the second.
          */}
          {failed}
        </p>
      )}
    </section>
  )
}
