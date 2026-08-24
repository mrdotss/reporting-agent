import type { Icon } from "@phosphor-icons/react/lib"
import {
  CalendarDotsIcon,
  EyeIcon,
  LockKeyIcon,
  ShieldCheckIcon,
  TreeStructureIcon,
} from "@phosphor-icons/react/ssr"

/**
 * The role explanation the customer reads (Requirements 11.3, 11.4, 11.5).
 *
 * **This copy is the product, not decoration.** Customers push back on Reader,
 * legitimately — it exposes resource configuration and not only metrics — and a
 * customer who is surprised by that revokes access mid-engagement. So this
 * component answers the argument in advance, and it answers it honestly: it says
 * what Reader gives, why a narrower role does not work, and what it does *not*
 * grant.
 *
 * A **server** component, and deliberately so. It holds no state, so the four
 * statements arrive in the initial HTML rather than after hydration — which is
 * what a consultant sharing this page, or printing it for a change request,
 * actually gets. Phosphor comes from `@phosphor-icons/react/ssr` for the same
 * reason: `rsc: true` makes the default entry the client build, and importing it
 * here would push this file across the boundary for four glyphs.
 *
 * The wizard renders it as a **prop** rather than importing it, the same
 * arrangement the `(app)` layout uses for `<UserMenu />` inside the client
 * sidebar. That is what keeps this file server-rendered while the step machine
 * around it lives in the browser.
 *
 * ## The four statements, and why each is here
 *
 * | # | Statement | Requirement |
 * |---|---|---|
 * | 1 | Reader, at **subscription** scope | 11.3 |
 * | 2 | `Monitoring Reader` alone does not grant Resource Graph inventory, and inventory identifies the resources metrics are collected for | 11.3 |
 * | 3 | Reader exposes resource configuration in addition to metrics | 11.4 |
 * | 4 | The connection is read-only; no role permitting a write is requested | 11.5 |
 *
 * The `Icon` type comes from `@phosphor-icons/react/lib` as an `import type`, so it
 * is erased at build time and the only runtime import is the `/ssr` one. The `/ssr`
 * entry does not re-export the type, and reaching for the default entry to get it
 * would put the client build's module specifier in a server component.
 *
 * Statement 2 is the one that reads like an implementation detail and is not: a
 * customer offering `Monitoring Reader` instead is offering something that
 * cannot enumerate the estate, and a collector with no inventory has nothing to
 * collect metrics *for*. Saying so is what turns "we need more access" into a
 * technical fact the customer can check.
 *
 * Statement 3 is the concession. It is stated plainly rather than buried,
 * because the alternative is the customer discovering it themselves.
 */

type ExplainerPoint = {
  readonly icon: Icon
  readonly heading: string
  readonly body: string
}

/**
 * The four statements, in the order a customer's objection arrives: what is
 * needed, why the narrower role fails, what it costs them, and what it does not
 * allow.
 *
 * A data list rather than four hand-written blocks, so no statement can be
 * dropped by editing the markup around it, and so the count is assertable.
 */
const EXPLAINER_POINTS: readonly ExplainerPoint[] = [
  {
    icon: ShieldCheckIcon,
    heading: "Reader, at subscription scope",
    body:
      "The service principal needs the built-in Reader role assigned at " +
      "subscription scope — that is, at /subscriptions/<id> itself. An " +
      "assignment scoped to a resource group is not sufficient and is " +
      "rejected before the connection is accepted.",
  },
  {
    icon: TreeStructureIcon,
    heading: "Monitoring Reader alone is not enough",
    body:
      "Monitoring Reader alone does not grant Azure Resource Graph inventory. " +
      "Inventory is required to identify the resources metrics are collected " +
      "for, so without it there is nothing to collect metrics for — the run " +
      "would find no resources at all.",
  },
  {
    icon: EyeIcon,
    heading: "Reader exposes resource configuration",
    body:
      "Reader exposes resource configuration in addition to metrics: names, " +
      "sizes, SKUs, tags, resource groups and power state. That is more than " +
      "metrics alone, and the SKU capacity is what makes a memory percentage " +
      "or a per-core figure possible at all.",
  },
  {
    icon: LockKeyIcon,
    heading: "The connection is read-only",
    body:
      "The connection is read-only. No role permitting a write is requested, " +
      "the generated script and template assign exactly one role, and nothing " +
      "this product does can create, modify, resize or delete a resource in " +
      "the subscription.",
  },
  {
    icon: CalendarDotsIcon,
    heading: "Reservation data requires an additional role",
    body:
      "Reservation term and expiry information requires the " +
      "Reservations Reader role, assigned at the tenant scope. " +
      "Reservations are tenant-level resources with their own RBAC " +
      "separate from subscriptions, so Reader at subscription scope " +
      "does not grant access to them. Without this role the report " +
      "records a gap for reservation fields — the remaining data is " +
      "unaffected.",
  },
]

export function ReaderRoleExplainer() {
  return (
    <section
      data-slot="reader-role-explainer"
      aria-labelledby="reader-role-explainer-heading"
      className="flex flex-col gap-4"
    >
      <div className="flex flex-col gap-1">
        <h3
          id="reader-role-explainer-heading"
          className="font-heading text-sm font-medium tracking-tight"
        >
          What access this needs, and why
        </h3>

        <p className="text-sm text-muted-foreground">
          Send this to whoever owns the subscription. It is the whole of what is
          requested.
        </p>
      </div>

      {/*
        A real `<dl>`: each point is a term and its explanation, which is what a
        screen reader then announces as a pair rather than as eight unrelated
        blocks. Mist neutrals and a hairline border throughout — none of this is
        an error state, so `--destructive` appears nowhere.
      */}
      <dl className="flex flex-col gap-4">
        {EXPLAINER_POINTS.map(({ icon: PointIcon, heading, body }) => (
          <div
            key={heading}
            className="flex gap-3 rounded-lg border border-border bg-muted/40 px-3 py-3"
          >
            <PointIcon
              aria-hidden="true"
              className="mt-0.5 size-4 shrink-0 text-primary dark:text-sidebar-primary"
            />

            <div className="flex min-w-0 flex-col gap-1">
              <dt className="text-sm font-medium">{heading}</dt>
              <dd className="text-sm text-muted-foreground">{body}</dd>
            </div>
          </div>
        ))}
      </dl>
    </section>
  )
}
