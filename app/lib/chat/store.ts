import "server-only"

import { randomBytes } from "node:crypto"
import {
  GetCommand,
  PutCommand,
  BatchWriteCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb"

import { chatHistoryTable, getDynamoClient } from "@/lib/aws/dynamo"
import type {
  ChatAttachments,
  ChatMessageView,
  ChatProposal,
  ChatProposalState,
  ChatThreadView,
} from "@/lib/chat/views"
import { requireAskLevel } from "@/lib/chat/access"
import { CHAT_TITLE_MAX } from "@/lib/chat/views"
import { WorkspaceAccessError } from "@/lib/workspaces/access"

/**
 * Chat history in DynamoDB (ask-chat Req 7), one table, two item kinds.
 *
 * | item    | PK            | SK              | GSI1PK        | GSI1SK             |
 * |---------|---------------|-----------------|---------------|--------------------|
 * | thread  | `THREAD#<id>` | `META`          | `WS#<wsId>`   | `<updatedAt>#<id>` |
 * | message | `THREAD#<id>` | `MSG#<id>`      | —             | —                  |
 *
 * A workspace's conversations are one GSI1 query, newest first; a conversation's messages
 * are one query on its partition, oldest first — message ids start with a fixed-width
 * base-36 timestamp, so key order is time order.
 *
 * ## Access is decided in Postgres, not here
 *
 * A thread is visible to the members of its workspace who may use Ask there, and to no one
 * else (roles-and-ask-access Req 6). DynamoDB holds no membership, so every read that
 * starts from an id resolves the thread first and then asks `requireAskLevel`, and starting
 * a thread needs the chat level. A thread in a workspace the user cannot use Ask in raises
 * {@link ChatThreadNotFoundError} — the same answer as an id that does not exist, so a
 * probe learns nothing from the difference.
 */

export class ChatThreadNotFoundError extends Error {
  constructor() {
    super("This conversation does not exist or you do not have access to it.")
    this.name = "ChatThreadNotFoundError"
  }
}

export class ChatProposalClosedError extends Error {
  constructor() {
    super("This report proposal has already been requested or dismissed.")
    this.name = "ChatProposalClosedError"
  }
}

export const DEFAULT_THREAD_TITLE = "New conversation"
export const THREAD_LIST_LIMIT = 50
const MESSAGE_READ_LIMIT = 400
const BATCH_WRITE_LIMIT = 25
const BATCH_WRITE_ATTEMPTS = 4

const THREAD_PREFIX = "THREAD#"
const META_SK = "META"
const MESSAGE_PREFIX = "MSG#"
const WORKSPACE_PREFIX = "WS#"
const GSI1 = "GSI1"

/** Ids are `<9 base-36 ms><16 hex>`: sortable by time, unguessable, URL-safe. */
const ID_PATTERN = /^[0-9a-z]{9}[0-9a-f]{16}$/

export function isChatId(value: string): boolean {
  return ID_PATTERN.test(value)
}

function newId(now: Date): string {
  return now.getTime().toString(36).padStart(9, "0") + randomBytes(8).toString("hex")
}

type ThreadItem = {
  PK: string
  SK: string
  GSI1PK: string
  GSI1SK: string
  kind: "thread"
  id: string
  workspaceId: string
  title: string
  createdBy: string
  createdAt: string
  updatedAt: string
  messageCount: number
  attachments: ChatAttachments
}

type MessageItem = {
  PK: string
  SK: string
  kind: "message"
} & Omit<ChatMessageView, "proposal"> & { proposal?: ChatProposal }

function toThreadView(item: Record<string, unknown>): ChatThreadView {
  const attachments = (item.attachments ?? {}) as Partial<ChatAttachments>
  return {
    id: String(item.id),
    workspaceId: String(item.workspaceId),
    title: String(item.title ?? DEFAULT_THREAD_TITLE),
    createdBy: String(item.createdBy),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
    messageCount: Number(item.messageCount ?? 0),
    attachments: {
      runIds: Array.isArray(attachments.runIds) ? attachments.runIds.map(String) : [],
      connectorIds: Array.isArray(attachments.connectorIds)
        ? attachments.connectorIds.map(String)
        : [],
      // Absent on a thread saved before live metrics existed.
      liveIds: Array.isArray(attachments.liveIds) ? attachments.liveIds.map(String) : [],
    },
  }
}

function toMessageView(item: Record<string, unknown>): ChatMessageView {
  const { PK: _pk, SK: _sk, kind: _kind, ...rest } = item
  void _pk
  void _sk
  void _kind
  const message = rest as unknown as ChatMessageView
  return {
    ...message,
    citations: message.citations ?? {},
    steps: message.steps ?? [],
  }
}

async function requireMembership(userId: string, workspaceId: string): Promise<void> {
  try {
    await requireAskLevel(userId, workspaceId, "read")
  } catch (thrown) {
    if (thrown instanceof WorkspaceAccessError) throw new ChatThreadNotFoundError()
    throw thrown
  }
}

export async function createThread(
  userId: string,
  workspaceId: string,
  attachments: ChatAttachments,
  now: Date = new Date()
): Promise<ChatThreadView> {
  await requireAskLevel(userId, workspaceId, "chat")

  const id = newId(now)
  const at = now.toISOString()
  const item: ThreadItem = {
    PK: THREAD_PREFIX + id,
    SK: META_SK,
    GSI1PK: WORKSPACE_PREFIX + workspaceId,
    GSI1SK: `${at}#${id}`,
    kind: "thread",
    id,
    workspaceId,
    title: DEFAULT_THREAD_TITLE,
    createdBy: userId,
    createdAt: at,
    updatedAt: at,
    messageCount: 0,
    attachments,
  }

  await getDynamoClient().send(
    new PutCommand({
      TableName: chatHistoryTable(),
      Item: item,
      ConditionExpression: "attribute_not_exists(PK)",
    })
  )
  return toThreadView(item)
}

/** A workspace's conversations, most recently active first. */
export async function listThreads(
  userId: string,
  workspaceId: string,
  limit: number = THREAD_LIST_LIMIT
): Promise<ChatThreadView[]> {
  await requireAskLevel(userId, workspaceId, "read")

  const result = await getDynamoClient().send(
    new QueryCommand({
      TableName: chatHistoryTable(),
      IndexName: GSI1,
      KeyConditionExpression: "GSI1PK = :workspace",
      ExpressionAttributeValues: { ":workspace": WORKSPACE_PREFIX + workspaceId },
      ScanIndexForward: false,
      Limit: limit,
    })
  )
  return (result.Items ?? []).map(toThreadView)
}

export async function readThread(userId: string, threadId: string): Promise<ChatThreadView> {
  if (!isChatId(threadId)) throw new ChatThreadNotFoundError()

  const result = await getDynamoClient().send(
    new GetCommand({
      TableName: chatHistoryTable(),
      Key: { PK: THREAD_PREFIX + threadId, SK: META_SK },
    })
  )
  if (result.Item === undefined) throw new ChatThreadNotFoundError()

  const thread = toThreadView(result.Item)
  await requireMembership(userId, thread.workspaceId)
  return thread
}

/** A conversation's messages, oldest first. The caller has already read the thread. */
export async function listMessages(thread: ChatThreadView): Promise<ChatMessageView[]> {
  const messages: ChatMessageView[] = []
  let cursor: Record<string, unknown> | undefined

  do {
    const result = await getDynamoClient().send(
      new QueryCommand({
        TableName: chatHistoryTable(),
        KeyConditionExpression: "PK = :thread AND begins_with(SK, :message)",
        ExpressionAttributeValues: {
          ":thread": THREAD_PREFIX + thread.id,
          ":message": MESSAGE_PREFIX,
        },
        ScanIndexForward: true,
        ExclusiveStartKey: cursor,
      })
    )
    messages.push(...(result.Items ?? []).map(toMessageView))
    cursor = result.LastEvaluatedKey
  } while (cursor !== undefined && messages.length < MESSAGE_READ_LIMIT)

  return messages
}

export type NewChatMessage = Omit<ChatMessageView, "id" | "threadId" | "createdAt">

/**
 * Append one message and touch the thread in one transaction, so the conversation list's
 * order and count can never disagree with the messages it holds.
 */
export async function appendMessage(
  thread: ChatThreadView,
  message: NewChatMessage,
  options: { readonly title?: string; readonly now?: Date } = {}
): Promise<{ message: ChatMessageView; thread: ChatThreadView }> {
  const now = options.now ?? new Date()
  const id = newId(now)
  const at = now.toISOString()
  const view: ChatMessageView = { ...message, id, threadId: thread.id, createdAt: at }
  const item: MessageItem = {
    PK: THREAD_PREFIX + thread.id,
    SK: MESSAGE_PREFIX + id,
    kind: "message",
    ...view,
  }

  const title = options.title?.slice(0, CHAT_TITLE_MAX)
  const names: Record<string, string> = {
    "#updatedAt": "updatedAt",
    "#gsi": "GSI1SK",
    "#count": "messageCount",
  }
  const values: Record<string, unknown> = {
    ":at": at,
    ":sk": `${at}#${thread.id}`,
    ":one": 1,
    ":zero": 0,
  }
  let update = "SET #updatedAt = :at, #gsi = :sk, #count = if_not_exists(#count, :zero) + :one"
  if (title !== undefined) {
    names["#title"] = "title"
    values[":title"] = title
    update += ", #title = :title"
  }

  await getDynamoClient().send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: chatHistoryTable(),
            Item: item,
            ConditionExpression: "attribute_not_exists(PK)",
          },
        },
        {
          Update: {
            TableName: chatHistoryTable(),
            Key: { PK: THREAD_PREFIX + thread.id, SK: META_SK },
            UpdateExpression: update,
            ConditionExpression: "attribute_exists(PK)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: values,
          },
        },
      ],
    })
  )

  return {
    message: view,
    thread: {
      ...thread,
      title: title ?? thread.title,
      updatedAt: at,
      messageCount: thread.messageCount + 1,
    },
  }
}

export async function updateThread(
  thread: ChatThreadView,
  change: { readonly title?: string; readonly attachments?: ChatAttachments },
  now: Date = new Date()
): Promise<ChatThreadView> {
  const at = now.toISOString()
  const names: Record<string, string> = { "#updatedAt": "updatedAt", "#gsi": "GSI1SK" }
  const values: Record<string, unknown> = { ":at": at, ":sk": `${at}#${thread.id}` }
  const sets = ["#updatedAt = :at", "#gsi = :sk"]

  if (change.title !== undefined) {
    names["#title"] = "title"
    values[":title"] = change.title.slice(0, CHAT_TITLE_MAX)
    sets.push("#title = :title")
  }
  if (change.attachments !== undefined) {
    names["#attachments"] = "attachments"
    values[":attachments"] = change.attachments
    sets.push("#attachments = :attachments")
  }

  await getDynamoClient().send(
    new UpdateCommand({
      TableName: chatHistoryTable(),
      Key: { PK: THREAD_PREFIX + thread.id, SK: META_SK },
      UpdateExpression: "SET " + sets.join(", "),
      ConditionExpression: "attribute_exists(PK)",
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    })
  )

  return {
    ...thread,
    title: change.title?.slice(0, CHAT_TITLE_MAX) ?? thread.title,
    attachments: change.attachments ?? thread.attachments,
    updatedAt: at,
  }
}

export class ChatThreadNotYoursError extends Error {
  constructor() {
    super("only the person who started a conversation can delete it")
    this.name = "ChatThreadNotYoursError"
  }
}

/**
 * Delete a conversation and every message in it.
 *
 * **Only its author may.** A conversation is shared with everyone who can use Ask in the
 * workspace, so deleting is not a personal tidy-up: it removes the thread for all of them.
 * The author is the one person who cannot be surprised by that.
 *
 * The messages go first and the thread's own item last, so an interrupted delete leaves a
 * thread with fewer messages rather than orphaned messages with no thread to authorize
 * reading them.
 */
export async function deleteThread(userId: string, threadId: string): Promise<void> {
  const thread = await readThread(userId, threadId)
  await requireAskLevel(userId, thread.workspaceId, "chat")
  if (thread.createdBy !== userId) throw new ChatThreadNotYoursError()

  const table = chatHistoryTable()
  let cursor: Record<string, unknown> | undefined
  do {
    const result = await getDynamoClient().send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: "PK = :thread AND begins_with(SK, :message)",
        ExpressionAttributeValues: {
          ":thread": THREAD_PREFIX + threadId,
          ":message": MESSAGE_PREFIX,
        },
        ProjectionExpression: "PK, SK",
        ExclusiveStartKey: cursor,
      })
    )
    const keys = (result.Items ?? []).map((item) => ({ PK: item.PK, SK: item.SK }))
    for (let from = 0; from < keys.length; from += BATCH_WRITE_LIMIT) {
      await deleteKeys(table, keys.slice(from, from + BATCH_WRITE_LIMIT))
    }
    cursor = result.LastEvaluatedKey
  } while (cursor !== undefined)

  await deleteKeys(table, [{ PK: THREAD_PREFIX + threadId, SK: META_SK }])
}

/** One batch, retrying whatever DynamoDB hands back unprocessed. */
async function deleteKeys(table: string, keys: readonly Record<string, unknown>[]): Promise<void> {
  let pending = keys.map((Key) => ({ DeleteRequest: { Key } }))
  for (let attempt = 0; attempt < BATCH_WRITE_ATTEMPTS && pending.length > 0; attempt += 1) {
    const result = await getDynamoClient().send(
      new BatchWriteCommand({ RequestItems: { [table]: pending } })
    )
    const unprocessed = result.UnprocessedItems?.[table] ?? []
    pending = unprocessed as typeof pending
  }
  if (pending.length > 0) {
    throw new Error(`the table left ${pending.length} item(s) of the conversation undeleted`)
  }
}

export async function readMessage(
  thread: ChatThreadView,
  messageId: string
): Promise<ChatMessageView | undefined> {
  if (!isChatId(messageId)) return undefined
  const result = await getDynamoClient().send(
    new GetCommand({
      TableName: chatHistoryTable(),
      Key: { PK: THREAD_PREFIX + thread.id, SK: MESSAGE_PREFIX + messageId },
    })
  )
  return result.Item === undefined ? undefined : toMessageView(result.Item)
}

/**
 * Close an open proposal. Conditional, so two teammates confirming the same proposal at
 * once enqueue one run between them: the second write fails and says so.
 */
export async function closeProposal(
  thread: ChatThreadView,
  messageId: string,
  state: Exclude<ChatProposalState, "open">,
  runId?: string
): Promise<void> {
  const names: Record<string, string> = { "#proposal": "proposal", "#state": "state" }
  const values: Record<string, unknown> = { ":state": state, ":open": "open" }
  let update = "SET #proposal.#state = :state"
  if (runId !== undefined) {
    names["#run"] = "runId"
    values[":run"] = runId
    update += ", #proposal.#run = :run"
  }

  try {
    await getDynamoClient().send(
      new UpdateCommand({
        TableName: chatHistoryTable(),
        Key: { PK: THREAD_PREFIX + thread.id, SK: MESSAGE_PREFIX + messageId },
        UpdateExpression: update,
        ConditionExpression: "attribute_exists(#proposal) AND #proposal.#state = :open",
        ExpressionAttributeNames: names,
        ExpressionAttributeValues: values,
      })
    )
  } catch (thrown) {
    if (thrown instanceof Error && thrown.name === "ConditionalCheckFailedException") {
      throw new ChatProposalClosedError()
    }
    throw thrown
  }
}
