"use client"

import { useId, useMemo, useState } from "react"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"

import { Switch } from "@/components/ui/switch"
import type { AdminAccountView } from "@/lib/admin/views"

/**
 * Who can use Ask, and the switch that changes it (roles-and-ask-access Req 7).
 *
 * The admin arrives with one account in mind, so the list opens on a search over email and
 * every row leads with the address. What the account is — when it joined, how many
 * workspaces it owns, whether it already sits in the admin's own — is the quieter second
 * line, and the switch sits at the row's end, where the eye finishes. A platform admin's
 * row has no switch: their Ask comes from being one.
 *
 * A change is saved at once, and a row shows what the route saved rather than what was
 * asked for, so a refused change never looks applied.
 */

const DATE = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  year: "numeric",
  timeZone: "Asia/Jakarta",
})

const ROLE_LABEL = {
  owner: "Owner",
  admin: "Admin",
  editor: "Editor",
  viewer: "Viewer",
} as const

export function AskAccessList({
  accounts: initialAccounts,
  currentUserId,
  truncated,
}: Readonly<{
  accounts: readonly AdminAccountView[]
  currentUserId: string
  /** The server cut the list at its limit, newest accounts first. */
  truncated: boolean
}>) {
  const [accounts, setAccounts] = useState(initialAccounts)
  const [query, setQuery] = useState("")
  const [saving, setSaving] = useState<string | null>(null)
  const [failure, setFailure] = useState<{ userId: string; message: string } | null>(null)
  const listId = useId()

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return needle === ""
      ? accounts
      : accounts.filter((account) => account.email.toLowerCase().includes(needle))
  }, [accounts, query])

  const granted = accounts.filter((account) => account.grantedAt !== null).length

  async function change(account: AdminAccountView, enabled: boolean) {
    setSaving(account.userId)
    setFailure(null)
    try {
      const response = await fetch("/api/admin/ask-access", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId: account.userId, enabled }),
      })
      if (!response.ok) throw new Error(`status ${response.status}`)
      const saved = (await response.json()) as { grantedAt: string | null }
      setAccounts((current) =>
        current.map((row) =>
          row.userId === account.userId ? { ...row, grantedAt: saved.grantedAt } : row
        )
      )
    } catch {
      setFailure({
        userId: account.userId,
        message: enabled
          ? "Ask wasn’t turned on. Try again."
          : "Ask wasn’t turned off. Try again.",
      })
    } finally {
      setSaving(null)
    }
  }

  return (
    <section aria-labelledby={`${listId}-title`} className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 id={`${listId}-title`} className="text-section">
            Accounts
          </h2>
          <p className="text-meta text-muted-foreground">
            <span className="font-mono tabular-nums text-foreground">{granted}</span> of{" "}
            <span className="font-mono tabular-nums">{accounts.length}</span>{" "}
            {accounts.length === 1 ? "account has" : "accounts have"} Ask turned on
            {truncated ? " · newest accounts shown" : ""}
          </p>
        </div>

        <label
          htmlFor={`${listId}-search`}
          className="flex h-9 w-full items-center gap-2 rounded-lg border border-input bg-muted px-2.5 text-muted-foreground focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/30 sm:w-72"
        >
          <MagnifyingGlassIcon aria-hidden="true" className="size-4 shrink-0" />
          <span className="sr-only">Search accounts by email</span>
          <input
            id={`${listId}-search`}
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search by email"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>

      {shown.length === 0 ? (
        <p className="border-y border-border py-6 text-sm text-muted-foreground">
          {query.trim() === "" ? "No accounts yet." : "No account matches that email."}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-border border-y border-border">
          {shown.map((account) => {
            const statusId = `${listId}-status-${account.userId}`
            const grantedAt = account.grantedAt
            return (
              <li
                key={account.userId}
                data-slot="ask-access-row"
                className="flex flex-wrap items-center gap-x-6 gap-y-2 py-3.5"
              >
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                    <span className="break-all">{account.email}</span>
                    {account.userId === currentUserId ? <Tag>You</Tag> : null}
                    {account.admin ? <Tag>Admin</Tag> : null}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Joined {DATE.format(new Date(account.joinedAt))}
                    <span aria-hidden="true"> · </span>
                    owns{" "}
                    <span className="font-mono tabular-nums">{account.ownedWorkspaces}</span>{" "}
                    {account.ownedWorkspaces === 1 ? "workspace" : "workspaces"}
                    {account.homeRole === null || account.admin ? null : (
                      <>
                        <span aria-hidden="true"> · </span>
                        {ROLE_LABEL[account.homeRole]} in your workspace
                        {grantedAt === null ? "" : ", where Ask is now hidden from them"}
                      </>
                    )}
                  </p>
                </div>

                <div className="flex shrink-0 items-center gap-3">
                  <span id={statusId} className="text-xs text-muted-foreground">
                    {account.admin
                      ? "Always on"
                      : grantedAt === null
                        ? "Off"
                        : `On since ${DATE.format(new Date(grantedAt))}`}
                  </span>
                  {account.admin ? null : (
                    <Switch
                      checked={grantedAt !== null}
                      disabled={saving === account.userId}
                      onCheckedChange={(checked) => void change(account, checked)}
                      aria-label={`Ask for ${account.email}`}
                      aria-describedby={statusId}
                    />
                  )}
                </div>

                {failure?.userId === account.userId ? (
                  <p role="alert" className="basis-full text-xs text-destructive">
                    {failure.message}
                  </p>
                ) : null}
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}

function Tag({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <span className="rounded-md bg-muted px-1.5 py-0.5 text-xs font-normal text-muted-foreground">
      {children}
    </span>
  )
}
