import { CopyButton } from "@/components/subscriptions/copy-button"
import {
  READER_ROLE_NAME,
  readerRoleAzCliScript,
  subscriptionScope,
} from "@/lib/subscriptions/azure-artifacts"

/**
 * The generated `az` CLI script (Requirements 11.1, 11.6, 11.8).
 *
 * Renders what `lib/subscriptions/azure-artifacts.ts` produced and adds nothing
 * to it. That module is pure, and it is where "exactly one role assignment, role
 * Reader, scope `/subscriptions/<id>`" is a property test rather than a review
 * item — so this file must not post-process the string. A component that trimmed,
 * re-indented or re-templated the script would put a second generator between the
 * tested one and the customer's terminal.
 *
 * No `"use client"` directive. The wizard is a client component and imports this,
 * so it lands in the browser bundle either way; leaving the directive off means
 * the same component is still usable from a server surface (a printable copy of
 * the onboarding pack, say) without being rewritten. The only genuinely
 * interactive part is {@link CopyButton}, which carries the directive itself.
 *
 * ## The subscription id is shown, and no secret can be
 *
 * Requirement 11.6 has two halves and they are met differently. The id is shown
 * because it is *rendered here and inside the script* — a consultant sending this
 * to a customer must be able to see which subscription it targets, and a customer
 * running it must be able to check. The absence of a secret is structural: at the
 * moment this script is generated **no client secret exists yet**. Step 3 of the
 * script is what creates one, on the customer's own machine, printed once to their
 * own terminal. There is no value for this component to leak.
 *
 * ## `<pre>` and the mono face
 *
 * A script is read character by character — a lost space inside a quoted shell
 * variable changes what it does — so it is set in Geist Mono inside a
 * `<pre>` with `whitespace-pre` and no wrapping reflow of significant leading
 * space. `tabIndex={0}` because the block scrolls horizontally, and a scrollable
 * region that cannot be focused cannot be scrolled from the keyboard.
 */

type AzScriptStepProps = Readonly<{
  /**
   * A validated Azure subscription GUID.
   *
   * The caller gates on `isSubscriptionId` before rendering this step —
   * `readerRoleAzCliScript` throws `InvalidSubscriptionIdError` for anything
   * else, which is its shell-injection gate and not something to catch here.
   */
  subscriptionId: string
}>

export function AzScriptStep({ subscriptionId }: AzScriptStepProps) {
  const script = readerRoleAzCliScript(subscriptionId)
  const scope = subscriptionScope(subscriptionId)

  return (
    <section
      data-slot="az-script-step"
      aria-labelledby="az-script-step-heading"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <h3
          id="az-script-step-heading"
          className="font-heading text-sm font-medium tracking-tight"
        >
          Option A — the Azure CLI script
        </h3>

        <p className="text-sm text-muted-foreground">
          Whoever owns the subscription runs this with{" "}
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">
            az login
          </code>{" "}
          already done. It creates one app registration, issues one client
          secret, and makes exactly one role grant: {READER_ROLE_NAME} at{" "}
          <span className="font-mono text-xs tabular-nums">{scope}</span>. Azure
          prints the secret once and cannot show it again, so it has to be
          copied into the next step straight away.
        </p>
      </div>

      <pre
        tabIndex={0}
        aria-label={`az CLI script granting ${READER_ROLE_NAME} at ${scope}`}
        className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        {script}
      </pre>

      <div className="flex justify-end">
        <CopyButton value={script} label="Copy the az CLI script" />
      </div>
    </section>
  )
}
