import type { Metadata } from "next"

import { AskWorkspace } from "@/components/chat/ask-workspace"
import { requireSession } from "@/lib/auth/guard"
import { listChatSources } from "@/lib/chat/sources"
import {
  ChatThreadNotFoundError,
  listMessages,
  listThreads,
  readThread,
} from "@/lib/chat/store"
import type { ChatMessageView, ChatThreadView } from "@/lib/chat/views"
import { selectedContext } from "@/lib/workspaces/context"
import { can } from "@/lib/workspaces/policy"

/**
 * `/ask` — ask about a customer's usage, grounded in verified reports, saved connector
 * scans and Azure list prices (ask-chat).
 *
 * Conversations are the selected workspace's and every member sees them. `?t=<id>` opens
 * one, so a teammate can be sent a link to a conversation.
 *
 * The history store is DynamoDB. A deployment that cannot reach it still renders the page
 * — with the reason stated — rather than an error screen, because the sources beside it
 * are Postgres and still correct.
 */

export const metadata: Metadata = {
  title: "Ask",
  description:
    "Ask questions about verified utilization reports, connector inventory and Azure " +
    "list prices, with every figure traced to its source.",
}

export default async function AskPage({
  searchParams,
}: Readonly<{
  searchParams: Promise<Record<string, string | string[] | undefined>>
}>) {
  const user = await requireSession()
  const { workspace } = await selectedContext(user.id)
  const params = await searchParams

  const sources = await listChatSources(user.id, workspace.id)

  let threads: ChatThreadView[] = []
  let historyUnavailable = false
  let initialThread: ChatThreadView | null = null
  let initialMessages: ChatMessageView[] = []

  try {
    threads = await listThreads(user.id, workspace.id)

    const requested = typeof params.t === "string" ? params.t : undefined
    if (requested !== undefined) {
      try {
        const thread = await readThread(user.id, requested)
        if (thread.workspaceId === workspace.id) {
          initialThread = thread
          initialMessages = await listMessages(thread)
        }
      } catch (thrown) {
        if (!(thrown instanceof ChatThreadNotFoundError)) throw thrown
      }
    }
  } catch (thrown) {
    historyUnavailable = true
    console.error(
      `[ask] reading chat history failed: ${thrown instanceof Error ? thrown.name : typeof thrown}`
    )
  }

  return (
    <AskWorkspace
      key={workspace.id}
      workspaceName={workspace.name}
      currentUserId={user.id}
      threads={threads}
      sources={sources}
      initialThread={initialThread}
      initialMessages={initialMessages}
      canRequest={can(workspace.role, "edit")}
      historyUnavailable={historyUnavailable}
    />
  )
}
