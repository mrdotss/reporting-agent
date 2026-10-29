/**
 * The words the Describe screen marks while an outline drafts.
 *
 * Drafting gives no progress until the outline comes back, so the first stage of the
 * drafting animation reads the description back with the phrases a report usually turns
 * on marked one after another. The marks come from this fixed list, never from the model:
 * they say "we noticed this", not "this became a section". What the model actually made
 * of the description is shown afterwards, under "How we read it".
 */

/** Phrases worth marking, English and Indonesian, longest first so a phrase wins over its parts. */
const PHRASES: readonly string[] = [
  "open to the internet",
  "terbuka ke internet",
  "six-month trend",
  "tren enam bulan",
  "needs a decision",
  "perlu diputuskan",
  "headline counts",
  "angka utama",
  "monthly report",
  "laporan bulanan",
  "finance team",
  "tim keuangan",
  "capacity review",
  "tinjauan kapasitas",
  "what we run",
  "sits idle",
  "no backup",
  "a few pages",
  "one page",
  "satu halaman",
  "the board",
  "direksi",
  "engineers",
  "engineer",
  "executives",
  "eksekutif",
  "finance",
  "keuangan",
  "backups",
  "backup",
  "cadangan",
  "idle",
  "menganggur",
  "peaks",
  "puncak",
  "trend",
  "tren",
  "capacity",
  "kapasitas",
  "security",
  "keamanan",
  "utilisation",
  "utilization",
  "utilisasi",
  "cost",
  "biaya",
  "monthly",
  "bulanan",
  "weekly",
  "mingguan",
  "databases",
  "database",
  "storage",
]

export type NoticedSegment = Readonly<{ text: string; marked: boolean; order: number }>

const isWordChar = (char: string | undefined) => char !== undefined && /[\p{L}\p{N}]/u.test(char)

/**
 * The description cut into plain and marked runs, in reading order. `order` counts the
 * marked runs from 0 so each can start its sweep a beat after the one before; plain runs
 * carry -1. A phrase only matches on word boundaries, and the first phrase to claim a
 * span keeps it.
 */
export function noticedSegments(text: string, limit = 8): readonly NoticedSegment[] {
  const lower = text.toLowerCase()
  const claimed: Array<readonly [number, number]> = []
  for (const phrase of PHRASES) {
    let from = 0
    while (from <= lower.length) {
      const start = lower.indexOf(phrase, from)
      if (start < 0) break
      const end = start + phrase.length
      from = end
      if (isWordChar(lower[start - 1]) || isWordChar(lower[end])) continue
      if (claimed.some(([a, b]) => start < b && end > a)) continue
      claimed.push([start, end])
    }
  }
  const marks = claimed.sort((a, b) => a[0] - b[0]).slice(0, limit)
  const segments: NoticedSegment[] = []
  let position = 0
  marks.forEach(([start, end], order) => {
    if (start > position) segments.push({ text: text.slice(position, start), marked: false, order: -1 })
    segments.push({ text: text.slice(start, end), marked: true, order })
    position = end
  })
  if (position < text.length) segments.push({ text: text.slice(position), marked: false, order: -1 })
  return segments
}
