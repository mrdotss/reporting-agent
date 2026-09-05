import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { ArrowLeftIcon } from "@phosphor-icons/react/ssr"

import { Button } from "@/components/ui/button"
import { requireSession } from "@/lib/auth/guard"
import { type MessageId, messageText } from "@/lib/messages/catalog"
import { groupScanTypes, type ScanGroup } from "@/lib/scans/grouping"
import { readLatestScan } from "@/lib/scans/store"
import { getConnectedSubscription } from "@/lib/subscriptions/store"
import {
  countsAreReported,
  mayContinue,
  readRegionCounts,
  readRegionProbes,
  readStringList,
  readTypeCounts,
  refusedRegions,
  scanGate,
} from "@/lib/scans/view"
import { CollectionProblems } from "@/components/scan/collection-problems"
import { RescanButton } from "@/components/scan/rescan-button"

/**
 * `/subscriptions/[id]/scan` — what is in this subscription (Requirements 4.5–4.9, 5.6).
 *
 * A **server** component with no client leaf yet. Everything the first paint needs is read
 * here: a scan is a stored row, not a stream, so there is nothing to subscribe to. A
 * re-scan is a form POST and the page re-reads.
 *
 * ## What this screen is for
 *
 * Every choice in the profile wizard used to be made blind — a metric list that offered
 * types the subscription does not contain, a section that turned out empty only in the
 * delivered PDF. This page is the thing that makes selection possible: step 2 of the wizard
 * is a view over these counts.
 *
 * ## The refusal is the point, not an edge case
 *
 * A scan that resolved zero resources does **not** offer Continue. That is the
 * authoring-time form of the `EMPTY_SCOPE` gate, and `azure-integration.md` records why it
 * has to exist at all: zero resources means zero figures, which means zero *unverifiable*
 * figures, so a run over an empty scope passes collection, compilation, rendering **and
 * verification** and delivers a clean, fully verified, empty report. Every gate green, the
 * artifact worthless. Refusing here puts the problem in front of the person who can still
 * fix it — a wrong subscription, a role assignment that is too narrow.
 *
 * ## The collection-problems panel
 *
 * Rendered from `region_probes` (requirements 5.3, 5.4), and it states a **risk** rather than
 * an observation: the probe is one request per region, so it has seen no per-resource
 * outcome. See `components/scan/collection-problems.tsx`.
 */

export const metadata: Metadata = { title: "Scan" }

type ScanPageProps = Readonly<{ params: Promise<{ id: string }> }>

const GROUP_LABEL_IDS: Readonly<Record<ScanGroup, MessageId>> = {
  compute: "ui.scan.group_compute",
  networking: "ui.scan.group_networking",
  data: "ui.scan.group_data",
  not_reportable: "ui.scan.group_not_reportable",
}

export default async function ScanPage({ params }: ScanPageProps) {
  const user = await requireSession()
  const { id } = await params

  // `getConnectedSubscription` rather than `readSubscriptionForScan`: that one returns
  // only the two fields the route's refusal gate needs and throws when absent, which is
  // right for a gate and wrong for a page that has a heading to render.
  const subscription = await getConnectedSubscription(user.id, id).catch(
    () => null
  )
  if (subscription === null) notFound()

  const scan = await readLatestScan(user.id, id)
  const language = "en" as const
  // Typed as `MessageId`, not `string`: the catalogue's keys are a literal union, so a
  // mistyped id is a compile error rather than a runtime throw on the one render that
  // reaches it.
  const t = (stringId: MessageId, values?: Record<string, string | number>) =>
    messageText(stringId, language, values)

  // No scan yet: the page states that and offers to take one. Deliberately not an error —
  // a subscription connected a minute ago has nothing to show and nothing wrong with it.
  //
  // **`reported` is why the figures below are not lengths.** These empty defaults exist to
  // keep the lists renderable; read as figures they say "0 types, 0 regions, 0 groups",
  // which is a claim about the subscription that no completed scan supports. A consultant
  // whose scan had just failed on a Resource Graph 400 read exactly that and took it for an
  // empty estate. `resourceCount` was already honest because a scan that did not complete
  // stores it as null; the other three were counting the placeholder.
  //
  // `status === "complete"` rather than `scan !== null`, because a **failed** scan is a
  // stored row — with `resourceCount: null` and no counts — and it is the case that misled.
  const counts = scan === null ? {} : readTypeCounts(scan.typeCounts)
  const childCounts = scan === null ? {} : readTypeCounts(scan.childTypeCounts)
  const groups = scan === null ? [] : readStringList(scan.resourceGroups)
  const regions = scan === null ? [] : readStringList(scan.regions)
  const declaredTypes = [...Object.keys(counts), ...Object.keys(childCounts)]
  const reported = countsAreReported(scan)
  const gate =
    scan === null
      ? ({ kind: "running" } as const)
      : scanGate({
          status: scan.status,
          resourceCount: scan.resourceCount,
          errorCode: scan.errorCode,
        })

  // Greying is decided by the catalogues, not by this page: `groupScanTypes` marks a type
  // greyed when neither catalogue declares it. Passing the scan's own keys as the declared
  // set would mark everything declared and lose requirement 4.7 entirely, so the declared
  // set is the union of the two count families — which is exactly the set the agent's
  // catalogues produced counts for.
  const grouped = groupScanTypes(counts, declaredTypes)

  return (
    <div className="mx-auto w-full max-w-5xl space-y-8 px-6 py-8">
      <div className="space-y-1">
        <Button
          variant="ghost"
          size="sm"
          render={<Link href="/subscriptions" />}
          className="-ml-2"
        >
          <ArrowLeftIcon />
          {subscription.displayName}
        </Button>
        <h1 className="font-heading text-xl font-medium tracking-tight">
          {t("ui.scan.heading")}
        </h1>
      </div>

      <section className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-border px-5 py-4">
        <Figure
          label={t("ui.scan.resources_label")}
          value={reported ? (scan?.resourceCount ?? null) : null}
        />
        <Figure
          label={t("ui.scan.types_label")}
          value={reported ? Object.keys(counts).length : null}
        />
        <Figure
          label={t("ui.scan.regions_label")}
          value={reported ? regions.length : null}
        />
        <Figure
          label={t("ui.scan.groups_label")}
          value={reported ? groups.length : null}
        />
        <RescanButton subscriptionId={id} language={language} />
      </section>

      {grouped.length > 0 && (
        <section className="space-y-6">
          {grouped.map((bucket) => (
            <div key={bucket.group} className="space-y-2">
              <h2 className="font-heading text-sm font-medium tracking-wide uppercase">
                {t(GROUP_LABEL_IDS[bucket.group])}{" "}
                <span className="font-mono text-muted-foreground tabular-nums">
                  {bucket.total}
                </span>
              </h2>
              <ul className="divide-y divide-border rounded-lg border border-border">
                {bucket.types.map((type) => (
                  <li
                    key={type.resourceType}
                    className="flex items-baseline justify-between px-4 py-2 text-sm"
                  >
                    <span
                      className={
                        type.greyed
                          ? "text-muted-foreground"
                          : "text-foreground"
                      }
                    >
                      {type.resourceType}
                    </span>
                    <span className="font-mono text-muted-foreground tabular-nums">
                      {type.count}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <p className="text-sm text-muted-foreground">
            {t("ui.scan.greyed_note")}
          </p>
        </section>
      )}

      {scan !== null &&
        (() => {
          const probes = readRegionProbes(scan.regionProbes)
          const refused = refusedRegions(probes)
          const regionCountMap = readRegionCounts(scan.regionCounts)
          return (
            <CollectionProblems
              refused={refused}
              resourcesByRegion={regionCountMap}
            />
          )
        })()}

      {gate.kind === "failed" && (
        <div className="space-y-1 rounded-lg border border-border px-5 py-4 text-sm">
          <p>{t("ui.scan.failed")}</p>
          {gate.code !== null && (
            <p className="font-mono text-xs text-muted-foreground">
              {t("ui.scan.failed_code", { code: gate.code })}
            </p>
          )}
        </div>
      )}

      {gate.kind === "running" && scan !== null && (
        <p className="rounded-lg border border-border px-5 py-4 text-sm text-muted-foreground">
          {t("ui.scan.running")}
        </p>
      )}

      {gate.kind === "empty" && (
        <p className="rounded-lg border border-border px-5 py-4 text-sm">
          {t("ui.scan.empty_scope")}
        </p>
      )}

      <p className="text-sm text-muted-foreground">
        {t("ui.scan.limits_note")}
      </p>

      {mayContinue(gate) && (
        <Button
          render={<Link href={`/report-profiles/new?scan=${scan?.id ?? ""}`} />}
        >
          {t("ui.scan.continue")}
        </Button>
      )}
    </div>
  )
}

/**
 * One figure in the summary bar. Mono and tabular, per `design-system.md`: a changing value
 * must not reflow its row, and an absent count renders as an em dash rather than as zero —
 * "not answered yet" and "none" are different facts.
 */
function Figure({
  label,
  value,
}: {
  // `string | undefined`, because `messageText` returns `undefined` for an id with no copy
  // in the active language. No `?? "Resources"` fallback: that would put English outside the
  // catalogue, which is the one thing the literal-copy guard exists to prevent. It cannot
  // happen in practice — the catalogue parity guard asserts every id is non-empty in both
  // languages — and if it ever did, a missing label is the honest presentation.
  label: string | undefined
  value: number | null
}) {
  return (
    <div className="space-y-0.5">
      <div className="text-xs tracking-wide text-muted-foreground uppercase">
        {label}
      </div>
      <div className="font-mono text-lg tabular-nums">{value ?? "—"}</div>
    </div>
  )
}
