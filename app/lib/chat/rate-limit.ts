/**
 * A per-user sliding window for chat messages (ask-chat Req 5; the runtime's own quota is
 * per agent, not per user).
 *
 * In memory, per process. The app runs as one instance, and a limit that resets on a
 * deploy is still a limit: its job is to stop one tab or one script from spending the
 * workspace's model budget, not to meter billing.
 */

export const CHAT_MESSAGES_PER_WINDOW = 20
export const CHAT_WINDOW_MS = 60_000

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>()

  constructor(
    private readonly limit: number = CHAT_MESSAGES_PER_WINDOW,
    private readonly windowMs: number = CHAT_WINDOW_MS
  ) {}

  /** Record a hit for `key` and say whether it is within the limit. */
  allow(key: string, now: number = Date.now()): boolean {
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < this.windowMs)
    if (recent.length >= this.limit) {
      this.hits.set(key, recent)
      return false
    }
    recent.push(now)
    this.hits.set(key, recent)
    return true
  }
}

const cache = globalThis as typeof globalThis & { __rptChatLimiter?: SlidingWindowLimiter }

export function chatLimiter(): SlidingWindowLimiter {
  cache.__rptChatLimiter ??= new SlidingWindowLimiter()
  return cache.__rptChatLimiter
}
