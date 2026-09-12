import { Archivo, IBM_Plex_Mono, Spectral } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { workspaceUiEnabled } from "@/lib/workspaces/context"
import { cn } from "@/lib/utils"

/**
 * Three voices, and each one is doing a job the other two cannot.
 *
 * This product issues a printed document and then proves it. The interface is the
 * room that issues it, so the type has to speak in three registers at once — the
 * document's, the instrument's, and the figure's.
 *
 * **Spectral** (`--font-heading`) is the document's voice. A serif, deliberately:
 * the artifact this app produces is a Word file and a PDF, and letting the app's
 * headings speak in that register makes the two read as one object rather than as a
 * tool and its output. Spectral is drawn for screen and has a plotted, slightly
 * technical cut, which keeps it from reading as an editorial flourish.
 *
 * **Archivo** (`--font-sans`) is the working voice — labels, tables, controls,
 * everything a consultant actually operates. A grotesk with institutional bones that
 * holds its shape at 11px in a table cell, which is where most of this app's text
 * lives.
 *
 * **IBM Plex Mono** (`--font-mono`) is every figure, hash, identifier and timestamp.
 * Engineered rather than decorative, with numerals that read cleanly at small sizes,
 * and always tabular: a numeral that shifts width as it streams undercuts the entire
 * argument this product is making.
 *
 * The previous build loaded Geist twice, under two variables, so `font-heading` and
 * `font-sans` resolved to the same face and every heading differed from body by
 * weight alone. Three families here are three families, not a third request for the
 * same one.
 */
const fontHeading = Spectral({
  subsets: ["latin"],
  weight: ["300", "400", "600"],
  style: ["normal", "italic"],
  variable: "--font-heading",
  display: "swap",
})

const fontSans = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap",
})

const fontMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap",
})

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={cn(
        "antialiased",
        "font-sans",
        fontSans.variable,
        fontHeading.variable,
        fontMono.variable
      )}
    >
      {/* The workspace palette is scoped **here**, not on a wrapper inside the shell.
          Radix renders every `Select`, `Dialog` and `Popover` through a portal attached to
          `document.body`, so a scope opened further down covered the trigger and not the
          menu it opens: the control took the new palette and its own options kept the old
          one, and the two drifted apart differently in each theme. A token scope has to
          sit above the portal root or it does not cover the portal. */}
      <body className={workspaceUiEnabled() ? "workspace-design" : undefined}>
        <ThemeProvider>{children}</ThemeProvider>
      </body>
    </html>
  )
}
