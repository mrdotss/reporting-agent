import { PageBody } from "@/components/app-shell/page-body"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * What every authenticated page shows while its data is being read.
 *
 * ## Why this file exists
 *
 * Every page in this group is a server component that awaits Postgres — the
 * overview runs three queries plus a batched extras resolve, a run detail adds
 * two S3 reads. Without a `loading.tsx` the App Router has nothing to show for
 * that span, so a consultant clicking "Reports" got the *previous* page, frozen,
 * with no indication that anything had happened. The nav item appeared not to
 * work, and the usual response to a control that appears not to work is to click
 * it again.
 *
 * The shell is not in here on purpose. `layout.tsx` renders the rail, the header
 * and the project selector, and a layout does not re-render for a navigation
 * within its own segment — so the rail stays put, stays interactive, and only the
 * page body below it is replaced. That is also why this is page-shaped rather
 * than a centred spinner: the frame around it is still the real frame.
 *
 * ## Shaped, not generic
 *
 * The blocks below are the shape every page in this group actually has — an
 * eyebrow, a title, a line of description, then a band of content. Matching the
 * real layout means the page does not jump when the data arrives, which is the
 * whole difference between a skeleton and a spinner.
 *
 * `kind="wide"` because most pages in this group are, and a skeleton that is
 * narrower than its page would resize on arrival — the reflow this is meant to
 * prevent.
 */
export default function Loading() {
  return (
    <PageBody kind="wide">
      {/*
        `aria-hidden` with a single polite announcement beside it: a screen reader
        should hear "Loading" once, not read out fourteen empty boxes.
      */}
      <p className="sr-only" role="status" aria-live="polite">
        Loading
      </p>

      <div aria-hidden="true" className="flex flex-col gap-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-3 w-32 rounded-md" />
          <Skeleton className="h-7 w-72 rounded-lg" />
          <Skeleton className="h-4 w-96 max-w-full rounded-md" />
        </div>

        <div className="grid grid-cols-2 gap-px border-y border-border bg-border sm:grid-cols-4">
          {[0, 1, 2, 3].map((cell) => (
            <div
              key={cell}
              className="flex flex-col gap-2 bg-background px-5 py-6"
            >
              <Skeleton className="h-2.5 w-20 rounded-md" />
              <Skeleton className="h-7 w-12 rounded-md" />
              <Skeleton className="h-2.5 w-24 rounded-md" />
            </div>
          ))}
        </div>

        <div className="flex flex-col gap-3">
          <Skeleton className="h-4 w-40 rounded-md" />
          {[0, 1, 2, 3, 4].map((row) => (
            <div
              key={row}
              className="flex items-center gap-4 border-b border-border pb-3"
            >
              <Skeleton className="h-4 flex-1 rounded-md" />
              <Skeleton className="hidden h-4 w-40 rounded-md sm:block" />
              <Skeleton className="h-5 w-20 rounded-3xl" />
            </div>
          ))}
        </div>
      </div>
    </PageBody>
  )
}
