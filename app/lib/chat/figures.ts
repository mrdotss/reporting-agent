import type { ChatCitation } from "@/lib/chat/views"

/**
 * The figures an answer quotes, numbered in the order the reader meets them.
 *
 * An answer carries a marker around every figure it quotes (`⟦fig:f1⟧8.06%⟦/fig⟧`), and
 * the message carries what each marker's id came from. The number printed beside a chip,
 * the row in "Figures in this answer" and the title of the trace panel all come from this
 * one list, so they cannot disagree. Pure: no clock, no network, nothing the model wrote
 * is read except the markers' own text.
 */

const FIGURE = /⟦fig:(f\d{1,4})⟧([^⟦⟧]*)⟦\/fig⟧/g
const ESTIMATE_OPEN = /⟦est⟧/g

export type AnswerFigure = {
  /** 1-based, in order of first appearance. */
  readonly number: number
  readonly factId: string
  /** The verified string, as the first marker printed it. */
  readonly text: string
  /** `undefined` when the message records no source for the id. */
  readonly citation: ChatCitation | undefined
}

export function answerFigures(
  text: string,
  citations: Readonly<Record<string, ChatCitation>>
): AnswerFigure[] {
  const figures: AnswerFigure[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(FIGURE)) {
    const factId = match[1]!
    if (seen.has(factId)) continue
    seen.add(factId)
    figures.push({
      number: figures.length + 1,
      factId,
      text: match[2] ?? "",
      citation: citations[factId],
    })
  }
  return figures
}

/** Figure id → number, for the chips inside the text. */
export function figureNumbers(
  figures: readonly AnswerFigure[]
): ReadonlyMap<string, number> {
  return new Map(figures.map((figure) => [figure.factId, figure.number]))
}

/** How many spans of the answer are the assistant's own working rather than a quoted figure. */
export function estimateCount(text: string): number {
  return [...text.matchAll(ESTIMATE_OPEN)].length
}

export type FigureTally = {
  /** Read from a verified report, a saved scan or a price list. */
  readonly traced: number
  /** Collected on request and never verified. */
  readonly live: number
  /** A figure the message records no source for. */
  readonly unsourced: number
  readonly estimates: number
}

export function tallyFigures(
  figures: readonly AnswerFigure[],
  estimates: number
): FigureTally {
  let traced = 0
  let live = 0
  let unsourced = 0
  for (const figure of figures) {
    if (figure.citation === undefined) unsourced += 1
    else if (figure.citation.source === "live") live += 1
    else traced += 1
  }
  return { traced, live, unsourced, estimates }
}

export function addTallies(a: FigureTally, b: FigureTally): FigureTally {
  return {
    traced: a.traced + b.traced,
    live: a.live + b.live,
    unsourced: a.unsourced + b.unsourced,
    estimates: a.estimates + b.estimates,
  }
}

/** `4 traced · 1 live · 4 estimates`, naming only what the answer holds. */
export function tallyLine(tally: FigureTally): string {
  const parts = [
    tally.traced > 0 ? `${tally.traced} traced` : null,
    tally.live > 0 ? `${tally.live} live` : null,
    tally.unsourced > 0 ? `${tally.unsourced} without a source` : null,
    tally.estimates > 0
      ? `${tally.estimates} ${tally.estimates === 1 ? "estimate" : "estimates"}`
      : null,
  ].filter(Boolean)
  return parts.length === 0 ? "No figures cited" : parts.join(" · ")
}
