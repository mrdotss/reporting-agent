import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"

import { AskAccessList } from "@/components/admin/ask-access-list"
import { FeedbackList } from "@/components/admin/feedback-list"
import { PageBody } from "@/components/app-shell/page-body"
import { ACCOUNT_LIST_LIMIT, isPlatformAdmin, listAccounts } from "@/lib/admin/platform"
import { requireSession } from "@/lib/auth/guard"
import { FEEDBACK_LIST_LIMIT, feedbackRecipient, listFeedback, openFeedbackCount } from "@/lib/feedback/store"
import { cn } from "@/lib/utils"

export const metadata: Metadata = {
  title: "Admin",
  description: "Choose which accounts can use Ask, and read what members send as feedback.",
}

const TABS = [
  { key: "ask", label: "Ask access" },
  { key: "feedback", label: "Feedback" },
] as const

type TabKey = (typeof TABS)[number]["key"]

function readTab(raw: string | string[] | undefined): TabKey {
  return TABS.find((tab) => tab.key === raw)?.key ?? "ask"
}

/**
 * `/admin` — who can use Ask (roles-and-ask-access Req 7), and the Feedback inbox.
 *
 * Not found for anyone who is not a platform admin (`RPT_PLATFORM_ADMIN_EMAILS`), so the
 * page does not confirm that it exists. The tab is in the URL (`?tab=`), like Workspace
 * settings, so the feedback email can link straight to the inbox.
 */
export default async function AdminPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>
}>) {
  const user = await requireSession()
  if (!isPlatformAdmin(user.email)) notFound()

  const tab = readTab((await searchParams).tab)
  const openCount = await openFeedbackCount(user)

  return (
    <PageBody kind="wide" className="gap-7">
      <header className="flex flex-col gap-1.5">
        <p className="text-micro text-muted-foreground uppercase">Admin</p>
        <h1 className="text-title">{tab === "ask" ? "Ask access" : "Feedback"}</h1>
        <p className="max-w-[68ch] text-meta text-muted-foreground">
          {tab === "ask" ? (
            <>
              Members of your workspaces use Ask there by their role: editors and up ask,
              viewers read. Turning Ask on for an account gives that account Ask in the
              workspaces it owns — not to the people it invites — and hides your
              workspaces&rsquo; conversations from it.
            </>
          ) : (
            <>
              What members send with Send feedback. Every message is saved here first, then
              emailed to <span className="font-mono">{feedbackRecipient()}</span> from the
              same address as the report emails.
            </>
          )}
        </p>
      </header>

      <nav aria-label="Admin sections">
        <ul className="inline-flex gap-0.5 rounded-[9px] bg-muted p-[3px]">
          {TABS.map(({ key, label }) => (
            <li key={key}>
              <Link
                href={`/admin?tab=${key}`}
                aria-current={tab === key ? "page" : undefined}
                className={cn(
                  "inline-flex h-7.5 items-center gap-1.5 rounded-md px-3 text-meta font-medium outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/30",
                  tab === key
                    ? "bg-card text-foreground shadow-[0_0_0_1px_var(--border),0_1px_2px_rgb(0_0_0/0.05)]"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {label}
                {key === "feedback" && openCount > 0 ? (
                  <span className="rounded-full bg-primary px-1.5 font-mono text-[11px] leading-4 text-primary-foreground tabular-nums">
                    {openCount}
                    <span className="sr-only"> open</span>
                  </span>
                ) : null}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {tab === "ask" ? (
        <AskAccessPanel userId={user.id} />
      ) : (
        <FeedbackPanel email={user.email} />
      )}
    </PageBody>
  )
}

async function AskAccessPanel({ userId }: Readonly<{ userId: string }>) {
  const accounts = await listAccounts()
  return (
    <AskAccessList
      accounts={accounts}
      currentUserId={userId}
      truncated={accounts.length >= ACCOUNT_LIST_LIMIT}
    />
  )
}

async function FeedbackPanel({ email }: Readonly<{ email: string }>) {
  const items = await listFeedback({ email }, "all")
  return <FeedbackList items={items} truncated={items.length >= FEEDBACK_LIST_LIMIT} />
}
