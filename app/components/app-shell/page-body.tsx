import { cn } from "@/lib/utils"

/**
 * How wide a page is, decided once per kind of page.
 *
 * ## Why this exists
 *
 * Seven pages each declared their own container — three at `max-w-3xl`, three at
 * `max-w-5xl`, three at `max-w-6xl` — and one rule in `globals.css` set
 * `max-width: 100%` on the shell's direct child and cancelled all of them. So no page
 * had the measure it asked for, every page ran to the shell's full 1500px whatever it
 * declared, and three different declared widths meant three different opinions about
 * how wide a page should be, none of them in effect.
 *
 * The override is gone. This is what replaces the nine separate declarations.
 *
 * ## Two kinds, not three
 *
 * The proposal said three — reading, table, workbench. Building it, table and workbench
 * turned out to be the same decision written twice: both fill the shell, and what
 * differs between the reports table and the profile wizard is their own internal grid,
 * not their width. A third name for a behaviour that already has one is the kind of
 * structure that looks like information and is not.
 *
 * - **`reading`** — a run, a wizard, a document. 68rem, centred, so a paragraph stays
 *   near 65 characters and a rail has somewhere to sit.
 * - **`wide`** — a table, a list, a summary. Fills the shell, because rows want the
 *   width and a centred table in a 1500px frame is two gutters and a stripe.
 */

export type PageKind = "reading" | "wide"

const WIDTH: Readonly<Record<PageKind, string>> = {
  reading: "max-w-[68rem]",
  wide: "max-w-none",
}

export function PageBody({
  kind,
  className,
  children,
}: Readonly<{
  kind: PageKind
  className?: string
  children: React.ReactNode
}>) {
  return (
    <div
      data-slot="page-body"
      data-page-kind={kind}
      className={cn("mx-auto flex w-full flex-col gap-6", WIDTH[kind], className)}
    >
      {children}
    </div>
  )
}
