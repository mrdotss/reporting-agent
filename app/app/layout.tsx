import { Geist, Geist_Mono, Inter } from "next/font/google"

import "./globals.css"
import { ThemeProvider } from "@/components/theme-provider"
import { workspaceUiEnabled } from "@/lib/workspaces/context"
import { cn } from "@/lib/utils"

const geistHeading = Geist({ subsets: ["latin"], variable: "--font-heading" })

const inter = Inter({ subsets: ["latin"], variable: "--font-sans" })

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
        inter.variable,
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
