import { SparkleIcon } from "@phosphor-icons/react/ssr"

import { AGENT_REASONS } from "@/lib/builder/agent-reasons"
import { messageText } from "@/lib/messages/catalog"
import type { AgentParagraphOutcome } from "@/lib/runs/agent"

/**
 * The agent paragraphs a delivered report does not carry, and why — read from the runtime's
 * `agent.json`. The report delivered either way: a paragraph the agent could not write
 * costs that paragraph, and the preset's note stood in for it or nothing did. This is where
 * the consultant learns which, before the customer reads the document.
 *
 * Mist neutral, like the secret-expiry banner: nothing here is a failure of the report, and
 * `--destructive` means a document that could not be proven. Renders nothing when every
 * paragraph was written.
 */
export function AgentNotes({ outcomes }: Readonly<{ outcomes: readonly AgentParagraphOutcome[] }>) {
  const missing = outcomes.filter((outcome) => outcome.outcome !== "written")
  if (missing.length === 0) return null
  const written = outcomes.length - missing.length
  const title =
    missing.length === 1
      ? messageText("ui.agent_notes.title_one", "en")
      : messageText("ui.agent_notes.title_many", "en", { count: missing.length })
  return (
    <section
      aria-labelledby="agent-notes-title"
      data-slot="agent-notes"
      className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted px-3.5 py-3 text-sm"
    >
      <div className="flex items-start gap-2">
        <SparkleIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="flex flex-col gap-0.5">
          <h2 id="agent-notes-title" className="font-medium">
            {title}
          </h2>
          <p className="text-meta text-muted-foreground">
            {messageText("ui.agent_notes.body", "en")}{" "}
            {written > 0 ? messageText("ui.agent_notes.written", "en", { written, total: outcomes.length }) : null}
          </p>
        </div>
      </div>
      <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-background">
        {missing.map((outcome) => (
          <li key={outcome.blockId} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-3">
            <span className="shrink-0 font-medium sm:w-48 sm:truncate">
              {outcome.sectionTitle || messageText("ui.agent_notes.untitled_section", "en")}
            </span>
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">
                {outcome.outcome === "note"
                  ? messageText("ui.agent_notes.note_printed", "en")
                  : messageText("ui.agent_notes.left_out", "en")}
              </span>{" "}
              {AGENT_REASONS[outcome.reason] ?? AGENT_REASONS.empty}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}
