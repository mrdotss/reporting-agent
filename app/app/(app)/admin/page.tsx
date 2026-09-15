import type { Metadata } from "next"
import { notFound } from "next/navigation"

import { AskAccessList } from "@/components/admin/ask-access-list"
import { PageBody } from "@/components/app-shell/page-body"
import { ACCOUNT_LIST_LIMIT, isPlatformAdmin, listAccounts } from "@/lib/admin/platform"
import { requireSession } from "@/lib/auth/guard"

export const metadata: Metadata = {
  title: "Admin",
  description: "Choose which accounts can use Ask.",
}

/**
 * `/admin` — who can use Ask (roles-and-ask-access Req 7).
 *
 * Not found for anyone who is not a platform admin (`RPT_PLATFORM_ADMIN_EMAILS`), so the
 * page does not confirm that it exists. It lists every account with the switch that grants
 * or removes Ask; the members of the admin's own workspaces already use Ask there by role.
 */
export default async function AdminPage() {
  const user = await requireSession()
  if (!isPlatformAdmin(user.email)) notFound()

  const accounts = await listAccounts()

  return (
    <PageBody kind="wide" className="gap-7">
      <header className="flex flex-col gap-1.5">
        <p className="text-micro text-muted-foreground uppercase">Admin</p>
        <h1 className="text-title">Ask access</h1>
        <p className="max-w-[68ch] text-meta text-muted-foreground">
          Members of your workspaces use Ask there by their role: editors and up ask, viewers
          read. Turning Ask on for an account gives that account Ask in the workspaces it owns
          — not to the people it invites — and hides your workspaces&rsquo; conversations from
          it.
        </p>
      </header>

      <AskAccessList
        accounts={accounts}
        currentUserId={user.id}
        truncated={accounts.length >= ACCOUNT_LIST_LIMIT}
      />
    </PageBody>
  )
}
