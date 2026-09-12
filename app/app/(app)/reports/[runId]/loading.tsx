import { PageBody } from "@/components/app-shell/page-body"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * A record's own skeleton.
 *
 * The group-level `loading.tsx` draws the register's shape — an eyebrow, a title, a
 * four-cell figure row, a table. On a record that is the wrong page: the content that
 * arrives is a counterfoil beside a two-column certificate, so the skeleton resolved
 * into a completely different layout and the page jumped, which is precisely the thing
 * a skeleton exists to prevent.
 *
 * This one is the certificate's shape — a stub on the left behind its perforation, the
 * record's title and two panels on the right — so the frame does not move when the
 * data lands. It sits at the route rather than in a shared component because that is
 * the only place Next will pick it up for this segment alone.
 */
export default function Loading() {
  return (
    <PageBody kind="wide">
      <p className="sr-only" role="status" aria-live="polite">
        Loading this record
      </p>

      <div aria-hidden="true" className="flex flex-col gap-6">
        <Skeleton className="h-3.5 w-24 rounded-sm" />

        <div className="flex flex-col gap-6 lg:flex-row lg:items-start">
          {/* The counterfoil, behind its perforation. */}
          <div className="flex shrink-0 flex-col gap-6 border-b border-dashed border-border pb-6 lg:w-64 lg:border-r lg:border-b-0 lg:pr-6 lg:pb-0">
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-2.5 w-10 rounded-sm" />
              <Skeleton className="h-14 w-full rounded-sm" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-2.5 w-14 rounded-sm" />
              <Skeleton className="h-4 w-44 rounded-sm" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Skeleton className="h-2.5 w-10 rounded-sm" />
              <Skeleton className="h-5 w-24 rounded-sm" />
            </div>
          </div>

          <div className="flex min-w-0 flex-1 flex-col gap-6">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-7 w-64 rounded-sm" />
              <Skeleton className="h-3.5 w-40 rounded-sm" />
            </div>

            {/* The verdict and the snapshot, side by side. */}
            <div className="grid items-start gap-6 lg:grid-cols-2">
              {[0, 1].map((panel) => (
                <div
                  key={panel}
                  className="flex flex-col gap-4 rounded-sm border border-border bg-card p-6"
                >
                  <Skeleton className="h-5 w-32 rounded-sm" />
                  <Skeleton className="h-4 w-full rounded-sm" />
                  <div className="grid grid-cols-2 gap-4">
                    <Skeleton className="h-10 rounded-sm" />
                    <Skeleton className="h-10 rounded-sm" />
                  </div>
                </div>
              ))}
            </div>

            <Skeleton className="h-20 w-full rounded-sm" />
          </div>
        </div>
      </div>
    </PageBody>
  )
}
