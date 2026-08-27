"use client"

import { useId } from "react"
import Link from "next/link"
import { usePathname } from "next/navigation"
import {
  FileTextIcon,
  GaugeIcon,
  type Icon,
  PlugsConnectedIcon,
  StackIcon,
  ShieldCheckIcon,
} from "@phosphor-icons/react"

import { ThemeToggle } from "@/components/app-shell/theme-toggle"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

/**
 * The sidebar rail of the authenticated shell (Requirements 7.6, 7.8).
 *
 * ## Why this one file is a client component
 *
 * `aria-current="page"` has to be decided from the current route, and the App
 * Router exposes the pathname to the browser only — there is no server-side
 * equivalent, and this app deliberately has no `proxy.ts`/`middleware.ts` that
 * could hand one down. So the rail reads `usePathname` and the rest of the shell
 * stays on the server: the `(app)` layout keeps the authoritative
 * `requireSession()` check, and `user-menu.tsx` stays a server component that
 * arrives here as {@link SidebarProps.children} rather than as an import. That
 * ordering is the point — a client component may *render* server-rendered
 * children, so the boundary sits at the smallest piece that needs the browser.
 *
 * Nothing secret crosses it. The rail receives no user data at all; the email is
 * inside the server-rendered footer it merely places.
 *
 * ## Luma, applied
 *
 * `bg-sidebar` — a hair off `--background` — with a hairline `--sidebar-border`
 * and no shadow, and every colour from the sidebar token family rather than
 * approximated from the main palette. Controls are pills: nav items are `h-9` at
 * `rounded-4xl`, matching `components/ui/button.tsx`, while surfaces stay at
 * 10–14px. The rail itself takes no radius — it is a full-height edge, not a
 * card.
 *
 * Active state carries **three** cues, only one of which is colour: the
 * `--sidebar-accent` surface, a `fill`-weight glyph, and the lifted teal
 * `--sidebar-primary` on that glyph. `fill` appears nowhere else, which is the
 * one use the design system reserves it for; every other icon in the rail is
 * `regular`.
 */

type NavItem = {
  readonly href: string
  readonly label: string
  readonly icon: Icon
}

/**
 * The rail's routes, in the order the work happens: connect a subscription,
 * produce a report, watch it land on the dashboard.
 *
 * `/report-profiles` sits between subscriptions and reports because that is the
 * order the work happens in: connect a customer, compose what to say about
 * them, run it. A consultant who has just connected a subscription and wants a
 * report next finds the step in between where they would look for it.
 */
const NAV_ITEMS: readonly NavItem[] = [
  { href: "/dashboard", label: "Dashboard", icon: GaugeIcon },
  { href: "/subscriptions", label: "Subscriptions", icon: PlugsConnectedIcon },
  { href: "/report-profiles", label: "Report Profiles", icon: StackIcon },
  { href: "/reports", label: "Reports", icon: FileTextIcon },
]

/**
 * Is `href` the section the current pathname sits in?
 *
 * Prefix-matched on a **segment** boundary, so `/reports/<runId>` marks
 * `/reports` and `/subscriptions/new` marks `/subscriptions`, while a sibling
 * route like `/reports-archive` would not match `/reports`. A bare
 * `startsWith(href)` gets that last case wrong and marks two items at once,
 * which `aria-current="page"` may not do.
 */
function isCurrent(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`)
}

type SidebarProps = Readonly<{
  /**
   * The rail's footer, supplied by the `(app)` layout as the server-rendered
   * `<UserMenu />`. Passed in rather than imported so it is not pulled across
   * this file's client boundary.
   */
  children: React.ReactNode
}>

export function AppSidebar({ children }: SidebarProps) {
  const pathname = usePathname()

  const navLabelId = useId()

  return (
    <aside className="flex shrink-0 flex-col gap-6 border-b border-sidebar-border bg-sidebar px-3 py-4 text-sidebar-foreground md:sticky md:top-0 md:h-svh md:w-64 md:gap-8 md:overflow-y-auto md:border-r md:border-b-0 md:px-4 md:py-6">
      <div className="flex items-center justify-between gap-2">
        <Link
          href="/dashboard"
          className="flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          {/*
            The same mark as the `(auth)` shell, so signing in does not change
            the product's face. `dark:text-sidebar-primary` because the preset
            makes `--primary` *darker* in dark mode — teal-on-dark text is
            `--sidebar-primary`, not `--primary`.
          */}
          <ShieldCheckIcon
            aria-hidden="true"
            className="size-5 shrink-0 text-primary dark:text-sidebar-primary"
          />

          <span className="truncate font-heading text-sm font-medium tracking-tight">
            Utilization Reporting
          </span>
        </Link>

        <ThemeToggle />
      </div>

      <div className="flex min-w-0 flex-col gap-2">
        {/*
          The visible section label *is* the navigation's accessible name, via
          `aria-labelledby`. A separate `aria-label` would be a second name to
          keep in sync with the one on screen.
        */}
        <h2
          id={navLabelId}
          className="px-3 text-xs font-medium tracking-widest text-muted-foreground uppercase"
        >
          Workspace
        </h2>

        {/*
          A real `<nav>` around a real list, in DOM order, so reading order
          matches the rail's visual order. It scrolls sideways on a narrow
          viewport rather than wrapping into a second row that would move the
          items around under the pointer.
        */}
        <nav aria-labelledby={navLabelId}>
          <ul className="flex flex-row gap-1 overflow-x-auto md:flex-col md:overflow-x-visible">
            {NAV_ITEMS.map(({ href, label, icon: ItemIcon }) => {
              const current = isCurrent(pathname, href)

              return (
                <li key={href}>
                  <Link
                    href={href}
                    aria-current={current ? "page" : undefined}
                    className={cn(
                      "flex h-9 items-center gap-2 rounded-4xl px-3 text-sm whitespace-nowrap transition-colors outline-none focus-visible:ring-3 focus-visible:ring-ring/30",
                      current
                        ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                        : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground"
                    )}
                  >
                    <ItemIcon
                      aria-hidden="true"
                      weight={current ? "fill" : "regular"}
                      className={cn(
                        "size-4 shrink-0",
                        current && "text-sidebar-primary"
                      )}
                    />

                    {label}
                  </Link>
                </li>
              )
            })}
          </ul>
        </nav>
      </div>

      <div className="flex min-w-0 flex-col gap-3 md:mt-auto">
        <Separator className="bg-sidebar-border" />

        {children}
      </div>
    </aside>
  )
}
