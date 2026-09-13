import { PageBody } from "@/components/app-shell/page-body"
import { Skeleton } from "@/components/ui/skeleton"

export default function Loading() {
  return (
    <PageBody kind="wide">
      <p className="sr-only" role="status" aria-live="polite">
        Loading this report
      </p>

      <div aria-hidden="true" className="flex flex-col gap-6">
        <Skeleton className="h-3.5 w-20 rounded-md" />

        {/* The header: period, title with its status, the connector line. */}
        <div className="flex flex-col gap-2">
          <Skeleton className="h-2.5 w-24 rounded-md" />
          <div className="flex items-center gap-3">
            <Skeleton className="h-7 w-64 rounded-md" />
            <Skeleton className="h-5.5 w-20 rounded-md" />
          </div>
          <Skeleton className="h-3.5 w-72 rounded-md" />
        </div>

        {/* The verdict and the snapshot, side by side. */}
        <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          {[0, 1].map((panel) => (
            <div
              key={panel}
              className="flex flex-col gap-4 rounded-xl border border-border bg-card p-5"
            >
              <Skeleton className="h-5 w-32 rounded-md" />
              <Skeleton className="h-4 w-full rounded-md" />
              <div className="grid grid-cols-3 gap-3">
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
                <Skeleton className="h-12 rounded-lg" />
              </div>
            </div>
          ))}
        </div>

        {/* The phase track. */}
        <div className="grid grid-cols-6 gap-1.5 rounded-xl border border-border bg-card p-5">
          {[0, 1, 2, 3, 4, 5].map((phase) => (
            <div key={phase} className="flex flex-col gap-2">
              <Skeleton className="h-1.5 rounded-full" />
              <Skeleton className="h-3 w-16 rounded-md" />
            </div>
          ))}
        </div>
      </div>
    </PageBody>
  )
}
