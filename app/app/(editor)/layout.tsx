import { Toaster } from "@/components/ui/sonner"
import { TooltipProvider } from "@/components/ui/tooltip"
import { requireSession } from "@/lib/auth/guard"

/**
 * The full-screen editors: the preset builder, outside the app's rail and header.
 *
 * A builder needs the whole window — an outline, a page at its printed size and an
 * inspector side by side — and the shell's rail and 80rem column leave it too little. The
 * builder carries its own top bar with a way back to Presets.
 *
 * Still a route guard: `requireSession()` runs on every render, as the app layout's does,
 * for the same reason — only the session row can say a request is still signed in.
 */
export default async function EditorLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  await requireSession()
  return (
    <TooltipProvider>
      {children}
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
