import { Geist, Geist_Mono } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { workspaceUiEnabled } from "@/lib/workspaces/context"
import { cn } from "@/lib/utils"

/**
 * One family for headings and for body, and it is the one already being paid for.
 *
 * `--font-sans` was Inter — the default face of a decade of admin panels, downloaded
 * as a third family alongside Geist and Geist Mono. Geist was already loaded for
 * headings, has tabular figures, and holds its shape at 12px in a table cell, which is
 * where most of this app's text actually lives. Dropping Inter removes a font request
 * rather than adding one.
 */
const geist = Geist({
  subsets: ["latin"],
  variable: "--font-sans",
})

const geistHeading = Geist({ subsets: ["latin"], variable: "--font-heading" })

const fontMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
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
        fontMono.variable,
        "font-sans",
        geist.variable,
        geistHeading.variable
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
