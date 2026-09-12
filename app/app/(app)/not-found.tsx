import Link from "next/link"
import { FileDashedIcon } from "@phosphor-icons/react/ssr"

import { PageBody } from "@/components/app-shell/page-body"
import { buttonVariants } from "@/components/ui/button"

/**
 * What a record that is not yours, or no longer exists, resolves to.
 *
 * ## Why this is not Next's default page
 *
 * `notFound()` is reached often enough here to be a real surface rather than an edge:
 * `reports/[runId]` calls it for any run the signed-in user does not own, and
 * deliberately — confirming that a run exists would itself be a fact about somebody
 * else's customer. Without this file all of that landed on Next's built-in
 * `404 · This page could not be found`, centred on a bare white page with no register
 * bar, no typography and no way back.
 *
 * ## What it does not say
 *
 * It does not distinguish "no such record" from "not your record", because the route
 * that sends most traffic here refuses to make that distinction on purpose. Saying
 * "you do not have access to this run" would leak precisely the fact `notFound()` was
 * chosen to withhold.
 */
export default function NotFound() {
  return (
    <PageBody kind="reading">
      <div className="flex flex-col items-start gap-5 py-10">
        <FileDashedIcon
          aria-hidden="true"
          className="size-7 text-muted-foreground"
        />

        <div className="flex flex-col gap-2">
          <h1 className="text-title">This record is not here.</h1>

          <p className="text-meta max-w-prose text-muted-foreground">
            It may have been removed, or it may belong to a workspace you are not a
            member of. Nothing was changed.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Link href="/reports" className={buttonVariants()}>
            All reports
          </Link>
          <Link
            href="/dashboard"
            className={buttonVariants({ variant: "outline" })}
          >
            Back to the overview
          </Link>
        </div>
      </div>
    </PageBody>
  )
}
