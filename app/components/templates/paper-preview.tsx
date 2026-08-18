"use client"

import { InfoIcon } from "@phosphor-icons/react"

/**
 * The paper canvas — the composed document, approximately (Requirement 14).
 *
 * ## It holds no layout definition
 *
 * Requirement 14.1: the preview is emitted "from the same document AST the
 * Docx_Renderer emits from ... through the Html_Emitter", and this component
 * "SHALL hold no layout definition of its own". So it injects markup the
 * **agent** produced — `render/html.py` over `compiled.document`, stored as
 * `previews/<id>/preview.html` — and contributes styling only.
 *
 * The alternative was walking `ast.json` here in TypeScript, which is the third
 * layout definition 14.1 forbids: a heading's markup would then be decided in
 * two languages by two people who never compared them, and the divergence would
 * surface as a preview that quietly stopped resembling the document.
 *
 * ## `dangerouslySetInnerHTML`, and why it is defensible here
 *
 * The markup is produced by our own emitter, server-side, from a compiled AST
 * whose only numeric leaf is a `Figure`. It is not user input round-tripped
 * through a database: a consultant's `rich_text` reaches this string only after
 * `render/html.py` has escaped it, and the emitter's own suite asserts that.
 *
 * That said, the reason this is acceptable is the escaping in the emitter, not
 * anything this component does — so if the emitter ever stops escaping, this is
 * the injection point. `render/html.py`'s tests are the load-bearing part.
 *
 * ## The label is permanent, and that is a list of five separate things
 *
 * Requirement 14.2 spells them out because each is a way to get it wrong: on
 * **every** render, visible whenever any part of the canvas is, behind **no**
 * hover, **no** focus and **no** disclosure, with **no** dismiss control, and
 * surviving scrolling and re-render.
 *
 * So it is rendered unconditionally, above the page and inside the same sticky
 * container, with no state that could hide it and no button that could remove
 * it. There is deliberately no `onDismiss` prop — a component that cannot be
 * told to hide the label cannot be made to.
 *
 * ## No page numbers, and one permitted marker
 *
 * Requirement 14.3. The emitter determines no pagination — a browser does not
 * lay out Word's columns — so a page number here would be a guess, and "a wrong
 * page count is a promise the document breaks". The only marker allowed is one
 * standing for a `page_break` block the definition declares, and it carries no
 * number; the emitter emits that, and this component adds none.
 */

/**
 * The three divergences, named (Requirement 14.4).
 *
 * All three, in visible text, without hover or expansion — and named
 * specifically rather than as "some differences", because these three are
 * exactly what Word decides for itself and a browser cannot predict.
 */
export const PREVIEW_DIVERGENCES = [
  "pagination",
  "table column widths",
  "font metrics",
] as const

export function PaperPreview({
  html,
  emptyReason,
}: Readonly<{
  /** The `Html_Emitter`'s output for this compilation, or `null`. */
  html: string | null
  /** Why there is nothing to show, when `html` is `null`. */
  emptyReason?: string
}>) {
  return (
    <div data-slot="paper-preview" className="flex flex-col gap-2">
      {/*
        Requirement 14.2 — sticky, so it stays visible while the page below
        scrolls. `top-0` inside the scrolling container rather than the viewport,
        so it tracks the canvas rather than floating over unrelated content.
      */}
      <div
        data-slot="preview-label"
        className="sticky top-0 z-10 flex items-start gap-2 rounded-lg border border-border bg-background/95 px-3 py-2 backdrop-blur"
      >
        <InfoIcon aria-hidden="true" className="mt-0.5 size-4 shrink-0" />

        <div className="flex flex-col gap-0.5">
          <p className="text-sm font-medium">Preview — an approximation</p>

          <p className="max-w-prose text-xs text-muted-foreground">
            {/*
              Requirement 14.4's three, named. Requirement 14.6 forbids this
              surface from stating that an HTML rendering is what the consultant
              will receive — so the sentence says the opposite, and says which
              artifact is the deliverable.
            */}
            This approximates {PREVIEW_DIVERGENCES[0]}, {PREVIEW_DIVERGENCES[1]}{" "}
            and {PREVIEW_DIVERGENCES[2]}. The rendered{" "}
            <code className="font-mono">.pdf</code> is the delivered result.
          </p>
        </div>
      </div>

      {html === null ? (
        <div
          data-slot="paper-preview-empty"
          className="rounded-xl border border-dashed border-border px-4 py-10 text-center"
        >
          <p className="text-sm text-muted-foreground">
            {emptyReason ??
              "Nothing to preview yet. Compose at least one block on step 5."}
          </p>
        </div>
      ) : (
        <div
          data-slot="paper-page"
          // The page-like container: a fixed measure, generous padding and a
          // white ground, so the emitted markup sits on something shaped like
          // paper. Styling only — every element inside came from the emitter.
          className="rpt-paper mx-auto w-full max-w-[52rem] rounded-xl border border-border bg-white px-10 py-12 text-black shadow-sm"
          // See the module docstring. The escaping that makes this safe is
          // `render/html.py`'s, not this component's.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      )}
    </div>
  )
}
