import localFont from "next/font/local"

/**
 * The faces `ledger`, `signal` and `brief` name, loaded from the same files the runtime
 * image installs (`agent/fonts/`, pinned by checksum), so the canvas draws the face the
 * delivered PDF is set in.
 *
 * Local rather than `next/font/google`: a build that fetches from Google can fail or drift
 * with the network, and these are the exact bytes LibreOffice and WeasyPrint lay out with.
 * `preload: false` because only one theme's faces are on a page at a time; the browser
 * fetches a file the first time a glyph needs it. The Liberation and DejaVu faces the first
 * four themes name stay system fonts, as they always were.
 */

export const plexSans = localFont({
  src: [
    { path: "../../../agent/fonts/IBMPlexSans-Regular.ttf", weight: "400", style: "normal" },
    { path: "../../../agent/fonts/IBMPlexSans-Italic.ttf", weight: "400", style: "italic" },
    { path: "../../../agent/fonts/IBMPlexSans-SemiBold.ttf", weight: "600", style: "normal" },
    { path: "../../../agent/fonts/IBMPlexSans-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-plex-sans",
  display: "swap",
  preload: false,
})

export const plexMono = localFont({
  src: [
    { path: "../../../agent/fonts/IBMPlexMono-Regular.ttf", weight: "400", style: "normal" },
    { path: "../../../agent/fonts/IBMPlexMono-Medium.ttf", weight: "500", style: "normal" },
    { path: "../../../agent/fonts/IBMPlexMono-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
  preload: false,
})

export const archivo = localFont({
  src: [
    { path: "../../../agent/fonts/Archivo-Regular.ttf", weight: "400", style: "normal" },
    { path: "../../../agent/fonts/Archivo-Bold.ttf", weight: "700", style: "normal" },
    { path: "../../../agent/fonts/Archivo-ExtraBold.ttf", weight: "800", style: "normal" },
    { path: "../../../agent/fonts/Archivo-Black.ttf", weight: "900", style: "normal" },
  ],
  variable: "--font-archivo",
  display: "swap",
  preload: false,
})

export const sourceSerif = localFont({
  src: [
    { path: "../../../agent/fonts/SourceSerif4-Regular.ttf", weight: "400", style: "normal" },
    { path: "../../../agent/fonts/SourceSerif4-Semibold.ttf", weight: "600", style: "normal" },
    { path: "../../../agent/fonts/SourceSerif4-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-source-serif",
  display: "swap",
  preload: false,
})

export const sourceSans = localFont({
  src: [
    { path: "../../../agent/fonts/SourceSans3-Regular.ttf", weight: "400", style: "normal" },
    { path: "../../../agent/fonts/SourceSans3-It.ttf", weight: "400", style: "italic" },
    { path: "../../../agent/fonts/SourceSans3-Semibold.ttf", weight: "600", style: "normal" },
    { path: "../../../agent/fonts/SourceSans3-Bold.ttf", weight: "700", style: "normal" },
  ],
  variable: "--font-source-sans",
  display: "swap",
  preload: false,
})

/** Every theme face's CSS variable, for the element the builder or Start screen renders in. */
export const THEME_FONT_VARIABLES = [plexSans, plexMono, archivo, sourceSerif, sourceSans]
  .map((font) => font.variable)
  .join(" ")
