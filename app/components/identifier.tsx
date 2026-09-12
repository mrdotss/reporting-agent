import { cn } from "@/lib/utils"

/**
 * One way to render an identifier, used everywhere one appears.
 *
 * ## The masked id was thirty-two asterisks
 *
 * A subscription id is a uuid — 36 characters. `maskSubscriptionId` keeps the last four
 * and replaces the rest, so what reaches the browser is 32 identical mask characters
 * followed by four real ones. Rendered literally that is the widest, highest-contrast,
 * most repeated string on several screens, and it carries four characters of
 * information. On the run detail page it appeared three times.
 *
 * So the mask is drawn as a mask — a short fixed glyph — and the four characters that
 * mean something are set beside it. Nothing is revealed that was not already revealed:
 * the value arriving here is already masked, and this only shortens the part that is
 * already meaningless.
 *
 * ## Digests are truncated here, not at the call site
 *
 * Five call sites each sliced a digest to their own length — 12, 24, 12, 12, and a
 * separate constant in `snapshot-provenance.tsx`. A digest shown at four different
 * lengths in one app reads as four different kinds of thing. One length, declared once.
 *
 * ## The full value stays reachable
 *
 * `title` carries it for a pointer, and a visually-hidden span carries it for a screen
 * reader, so the shortening is presentational and nothing is lost. For a value somebody
 * needs to paste, `CopyDigest` is the control — this is for reading.
 */

/** How much of a digest is enough to tell two apart at a glance. */
export const DIGEST_VISIBLE = 12

/**
 * The glyph standing in for the masked run.
 *
 * Bullets set tight, not middle dots set loose. `····` with letter-spacing rendered as
 * four dots floating apart at 12px, which reads as a loading state rather than as a
 * redaction — the thing it stands for is a solid run of characters, so it should look
 * like one.
 */
const MASK_GLYPH = "••••"

export type IdentifierKind = "mask" | "digest"

export function Identifier({
  value,
  kind,
  className,
  label,
}: Readonly<{
  /**
   * The value as the server produced it — an already-masked subscription id, or a
   * full digest. Never an unmasked subscription id: masking is the server's job and
   * this component does not do it.
   */
  value: string
  kind: IdentifierKind
  className?: string
  /** What the value identifies, for the accessible name. */
  label?: string
}>) {
  // Everything up to and including the LAST mask character goes. `^[*]+` would not
  // do: a masked uuid can keep its separators — `****-****-…-****3301` — so the run
  // of mask characters is not contiguous, and stripping only the first run leaves
  // most of the mask on screen.
  const shown =
    kind === "mask"
      ? value.replace(/^.*[*·•]/, "")
      : value.slice(0, DIGEST_VISIBLE)

  const masked = kind === "mask" && shown.length < value.length

  return (
    <span
      data-slot="identifier"
      data-kind={kind}
      title={value}
      className={cn(
        "inline-flex items-baseline gap-1.5 font-mono text-xs tabular-nums",
        className
      )}
    >
      {masked ? (
        <span
          aria-hidden="true"
          className="tracking-tighter text-muted-foreground"
        >
          {MASK_GLYPH}
        </span>
      ) : null}

      <span aria-hidden="true">{shown}</span>

      {/* The whole value, for anything that reads rather than looks. */}
      <span className="sr-only">
        {label === undefined ? value : `${label}: ${value}`}
      </span>
    </span>
  )
}
