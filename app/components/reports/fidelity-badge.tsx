import { Badge } from "@/components/ui/badge"
import { messageText } from "@/lib/messages/catalog"

/**
 * A resource's — or a connection's — `fidelity_tier`, as one badge with its
 * explanation.
 *
 * The tier is a **product-visible fact**, not an implementation detail: Azure platform
 * metrics give exact averages, minima and maxima with nothing installed in the guest,
 * but they do not give true percentiles, per-volume disk free space, or guest-observed
 * memory. Rather than pretend otherwise, every resource carries a tier and the report
 * says which one — so a right-sizing recommendation built on an estimated percentile is
 * honest about that.
 *
 * `title` carries the explanation rather than a custom tooltip, deliberately: a native
 * `title` is reachable by keyboard focus and by a screen reader without any of the
 * focus-management a floating tooltip needs, and the text is a sentence rather than an
 * interaction.
 *
 * Both tiers render in mist neutrals. `baseline` is not a *deficiency* — it is exact
 * avg/min/max with estimated percentiles, clearly labelled — so it takes `outline`
 * rather than anything that reads as a warning.
 */

const TIER_COPY: Readonly<
  Record<string, { readonly label: string; readonly title: string }>
> = Object.freeze({
  baseline: {
    label: messageText("ui.fidelity.baseline", "en") + " fidelity",
    title: messageText("ui.fidelity.baseline_title", "en") ?? "",
  },
  enhanced: {
    label: messageText("ui.fidelity.enhanced", "en") + " fidelity",
    title: messageText("ui.fidelity.enhanced_title", "en") ?? "",
  },
})

export function FidelityBadge({
  tier,
  count,
  className,
}: Readonly<{
  tier: string
  /** Resource count at this tier, when the surface is summarizing a snapshot. */
  count?: number
  className?: string
}>) {
  const copy = TIER_COPY[tier]

  return (
    <Badge
      data-slot="fidelity-badge"
      data-tier={tier}
      variant="outline"
      title={copy?.title}
      className={className}
    >
      {count === undefined ? null : (
        // Mono tabular, like every figure in this product: a column of counts lines up
        // and a changing value does not reflow its row.
        <span className="font-mono tabular-nums">{count}</span>
      )}
      {copy?.label ?? `${tier} fidelity`}
    </Badge>
  )
}
