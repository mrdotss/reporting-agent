import { Instrument_Sans, Spline_Sans_Mono } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { workspaceUiEnabled } from "@/lib/workspaces/context"
import { cn } from "@/lib/utils"

/**
 * Two voices: the working face and the figure's face.
 *
 * **Instrument Sans** carries the interface and its headings. This is an operations
 * tool scanned between customer calls, so hierarchy comes from weight and ink rather
 * than from a second display family; it holds its shape at 11px in a table cell and
 * tightens cleanly at 30px.
 *
 * **Spline Sans Mono** is every figure, digest, resource id and date — always tabular,
 * because a numeral that shifts width as a run streams undercuts the claim that the
 * numbers are proven.
 *
 * `--font-heading` points at the sans rather than being dropped, so existing
 * `font-heading` call sites resolve to the working face instead of a fallback serif.
 */
const fontSans = Instrument_Sans({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-sans",
  display: "swap",
})

const fontHeading = Instrument_Sans({
  subsets: ["latin"],
  weight: ["500", "600", "700"],
  variable: "--font-heading",
  display: "swap",
})

const fontMono = Spline_Sans_Mono({
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
