/**
 * The shell both public auth pages render into (Requirement 7.8).
 *
 * A **server** component, and it stays one. Each page fills the two columns itself —
 * the navy `AuthPanel` on the left and its form on the right — because the panel
 * says something different on each page. Below `lg` the panel is hidden and the form
 * column carries a small wordmark of its own.
 *
 * `min-h-svh`, not `min-h-screen`: on mobile browsers `100vh` includes the
 * retracting toolbar, which pushes a vertically centered form off centre until the
 * user scrolls.
 */
export default function AuthLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <main className="grid min-h-svh bg-background lg:grid-cols-2">{children}</main>
  )
}
