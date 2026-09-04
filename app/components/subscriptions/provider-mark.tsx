import type { ReactNode } from "react"

/**
 * The three source marks, drawn rather than fetched.
 *
 * They were declared inside `source-picker.tsx`, which is the one surface that could
 * not show them where they matter most: the picker names a source you are about to
 * connect, and a *connected* one appeared as a name and three badges with nothing
 * saying which cloud it is. One estate is one provider today; the moment a second
 * lands, a list of connections without a mark per row is a list you have to read to
 * sort.
 *
 * Drawn, not fetched, for the reason the picker already gave: the artifact CSP admits
 * no image host, and a provider's real brand SVG should replace each one when someone
 * with the right to redistribute it drops the file in.
 */

export type SourceKind = "azure" | "aws" | "onprem"

export const AzureMark = (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M9.6 3.4h5.1L9.4 18.9l-6.9.1L9.6 3.4Z" fill="#3B9EDB" />
    <path d="M11.5 3.4h3.2l6.8 17.2h-6.3l-4.3-8.6 2.5-4.4-1.9-4.2Z" fill="#1D6FA8" />
  </svg>
)

export const AwsMark = (
  <svg width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M7 11.2c0 .3 0 .6.1.8l.5 1c0 .1.1.2.1.3 0 .1-.1.3-.3.4l-.7.5h-.3c-.1 0-.2 0-.3-.2l-.5-.5-.4-.6c-.5.6-1.2 1-2 1-.6 0-1-.2-1.4-.5-.3-.4-.5-.8-.5-1.4 0-.6.2-1.1.7-1.4.4-.4 1-.6 1.8-.6l1.3.2v-.5c0-.5-.1-.9-.3-1.1-.2-.2-.6-.3-1.2-.3l-.7.1-.8.2h-.2l-.2-.1v-.4l.1-.2.2-.2.9-.3 1-.1c.8 0 1.4.2 1.8.6.4.4.6.9.6 1.7v2.1Zm-2.7 1 .6-.1c.3-.1.5-.3.6-.5l.2-.4v-.6l-1-.1c-.4 0-.7 0-.9.2-.2.2-.3.4-.3.7 0 .3.1.5.2.6l.6.2Z"
      fill="#98A5B1"
    />
    <path
      d="M19.3 16.9c-2.3 1.7-5.7 2.6-8.6 2.6-4.1 0-7.8-1.5-10.6-4-.2-.2 0-.5.2-.3 3 1.7 6.7 2.8 10.5 2.8 2.6 0 5.4-.6 8-1.7.4-.2.7.3.5.6Zm1-1.1c-.3-.4-2-.2-2.7-.1-.2 0-.3-.2-.1-.3 1.3-.9 3.5-.7 3.8-.4.3.4-.1 2.5-1.3 3.5-.2.2-.4.1-.3-.1.3-.8.9-2.2.6-2.6Z"
      fill="#E8993B"
    />
  </svg>
)

export const OnPremMark = (
  <svg
    width="30"
    height="30"
    viewBox="0 0 24 24"
    fill="none"
    stroke="#98A5B1"
    strokeWidth="1.6"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <rect x="3" y="4" width="18" height="5" rx="1.2" />
    <rect x="3" y="11" width="18" height="5" rx="1.2" />
    <path d="M6.5 6.5h.01M6.5 13.5h.01M9.5 6.5h3M9.5 13.5h3" />
    <path d="M8 18v2M16 18v2M5 20h14" strokeLinecap="round" />
  </svg>
)

const MARKS: Readonly<Record<SourceKind, ReactNode>> = {
  azure: AzureMark,
  aws: AwsMark,
  onprem: OnPremMark,
}

/** What each source is called, for the mark's accessible name. */
export const SOURCE_NAMES: Readonly<Record<SourceKind, string>> = {
  azure: "Microsoft Azure",
  aws: "Amazon Web Services",
  onprem: "On-premises",
}

/**
 * One source's mark at the size a list row wants, labelled for a screen reader.
 *
 * The mark itself is `aria-hidden`; the name is carried by a sibling
 * `<span class="sr-only">`, so a reader hears "Microsoft Azure" rather than nothing
 * or a description of a path element.
 */
export function ProviderMark({
  kind,
  className = "",
}: Readonly<{ kind: SourceKind; className?: string }>) {
  return (
    <span
      data-slot="provider-mark"
      data-provider={kind}
      className={`inline-flex size-7 shrink-0 items-center justify-center [&>svg]:size-full ${className}`}
    >
      {MARKS[kind]}
      <span className="sr-only">{SOURCE_NAMES[kind]}</span>
    </span>
  )
}
