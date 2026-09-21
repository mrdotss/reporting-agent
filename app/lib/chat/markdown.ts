/**
 * The little of Markdown an answer actually uses, parsed into blocks.
 *
 * Models write tables, headings, lists and emphasis; before this they reached the page as
 * literal `**bold**` and rows of pipes. A parser rather than a library, for one reason: an
 * answer's figures arrive as `⟦fig:f1⟧8.06%⟦/fig⟧` markers that must survive inside a table
 * cell or a bold run and still render as chips onto their provenance. This splits blocks
 * only, leaves every inline run as text, and {@link parseAnswer} takes it from there.
 *
 * Nothing here produces HTML. Blocks are data, and `components/chat/message-text.tsx`
 * renders them as React elements, so text a model wrote stays text whatever it contains.
 */

export type MarkdownAlign = "left" | "center" | "right"

export type MarkdownBlock =
  | { readonly kind: "paragraph"; readonly text: string }
  | { readonly kind: "heading"; readonly level: number; readonly text: string }
  | { readonly kind: "list"; readonly ordered: boolean; readonly items: readonly string[] }
  | {
      readonly kind: "table"
      readonly header: readonly string[]
      readonly align: readonly MarkdownAlign[]
      readonly rows: readonly (readonly string[])[]
    }
  | { readonly kind: "quote"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "rule" }
  | { readonly kind: "chart"; readonly id: string }

export type InlineSpan =
  | { readonly kind: "plain"; readonly text: string }
  | { readonly kind: "strong"; readonly text: string }
  | { readonly kind: "emphasis"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }

const CHART = /^⟦chart:(c\d{1,2})⟧$/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const FENCE = /^\s*(?:```|~~~)/
const QUOTE = /^\s*>\s?/
const BULLET = /^\s*[-*+]\s+/
const ORDERED = /^\s*\d{1,3}[.)]\s+/
const TABLE_ROW = /^\s*\|.*$/
const TABLE_RULE = /^\s*\|?[\s:|-]*-[\s:|-]*$/
const INLINE = /\*\*([^*]+)\*\*|__([^_]+)__|(?<![\w*])\*([^*\n]+)\*(?!\w)|`([^`]+)`/g

/** Cells of one `| a | b |` row, with the outer pipes dropped. */
function cells(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "")
  return trimmed.split("|").map((cell) => cell.trim())
}

function alignments(rule: string): MarkdownAlign[] {
  return cells(rule).map((cell) => {
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    if (left && right) return "center"
    return right ? "right" : "left"
  })
}

function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    RULE.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    TABLE_ROW.test(line) ||
    CHART.test(line.trim())
  )
}

export function parseMarkdown(text: string): MarkdownBlock[] {
  const lines = text.split("\n")
  const blocks: MarkdownBlock[] = []
  let at = 0

  while (at < lines.length) {
    const line = lines[at]

    if (line.trim().length === 0) {
      at += 1
      continue
    }

    const chart = CHART.exec(line.trim())
    if (chart !== null) {
      blocks.push({ kind: "chart", id: chart[1] })
      at += 1
      continue
    }

    if (FENCE.test(line)) {
      const body: string[] = []
      at += 1
      while (at < lines.length && !FENCE.test(lines[at])) {
        body.push(lines[at])
        at += 1
      }
      at += 1 // the closing fence, or the end of a still-streaming answer
      blocks.push({ kind: "code", text: body.join("\n") })
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({ kind: "heading", level: heading[1].length, text: heading[2].trim() })
      at += 1
      continue
    }

    // Before the rule test: a table's `|---|---|` separator also matches a horizontal rule.
    if (TABLE_ROW.test(line) && at + 1 < lines.length && TABLE_RULE.test(lines[at + 1])) {
      const header = cells(line)
      const align = alignments(lines[at + 1])
      const rows: string[][] = []
      at += 2
      while (at < lines.length && TABLE_ROW.test(lines[at])) {
        rows.push(cells(lines[at]))
        at += 1
      }
      blocks.push({ kind: "table", header, align, rows })
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ kind: "rule" })
      at += 1
      continue
    }

    if (QUOTE.test(line)) {
      const body: string[] = []
      while (at < lines.length && QUOTE.test(lines[at])) {
        body.push(lines[at].replace(QUOTE, ""))
        at += 1
      }
      blocks.push({ kind: "quote", text: body.join("\n") })
      continue
    }

    const ordered = ORDERED.test(line)
    if (ordered || BULLET.test(line)) {
      const marker = ordered ? ORDERED : BULLET
      const items: string[] = []
      while (at < lines.length && marker.test(lines[at])) {
        let item = lines[at].replace(marker, "")
        at += 1
        // A wrapped line belongs to the item it follows.
        while (at < lines.length && lines[at].trim().length > 0 && !startsBlock(lines[at])) {
          item += ` ${lines[at].trim()}`
          at += 1
        }
        items.push(item.trim())
      }
      blocks.push({ kind: "list", ordered, items })
      continue
    }

    const body: string[] = [line.trim()]
    at += 1
    while (at < lines.length && lines[at].trim().length > 0 && !startsBlock(lines[at])) {
      body.push(lines[at].trim())
      at += 1
    }
    blocks.push({ kind: "paragraph", text: body.join("\n") })
  }

  return blocks
}

/**
 * One line of text split into emphasis runs.
 *
 * Applied to the **plain** parts of an answer only — never across a figure marker — so a
 * stray asterisk inside a chip can never turn the rest of a sentence italic.
 */
export function parseInline(text: string): InlineSpan[] {
  const spans: InlineSpan[] = []
  let last = 0
  INLINE.lastIndex = 0

  for (let match = INLINE.exec(text); match !== null; match = INLINE.exec(text)) {
    if (match.index > last) spans.push({ kind: "plain", text: text.slice(last, match.index) })
    const [, strong, strongAlt, emphasis, code] = match
    if (strong !== undefined || strongAlt !== undefined) {
      spans.push({ kind: "strong", text: (strong ?? strongAlt) as string })
    } else if (emphasis !== undefined) {
      spans.push({ kind: "emphasis", text: emphasis })
    } else if (code !== undefined) {
      spans.push({ kind: "code", text: code })
    }
    last = match.index + match[0].length
  }

  if (last < text.length) spans.push({ kind: "plain", text: text.slice(last) })
  return spans
}
