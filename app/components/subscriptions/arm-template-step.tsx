import { CopyButton } from "@/components/subscriptions/copy-button"
import {
  READER_ROLE_NAME,
  readerRoleArmTemplate,
  subscriptionScope,
} from "@/lib/subscriptions/azure-artifacts"

/**
 * The generated ARM template (Requirements 11.2, 11.6, 11.8).
 *
 * The alternative to the `az` script, and it exists because the two are consumed
 * by different people. A platform team that reviews infrastructure as code will
 * not run a shell script somebody emailed them; they will read a template, put it
 * through their own pipeline, and diff it against what they expected. The template
 * is built as an object and `JSON.stringify`'d in
 * `lib/subscriptions/azure-artifacts.ts` precisely so that review is possible —
 * `resources` can be counted structurally rather than grepped for.
 *
 * Rendered verbatim, for the same reason {@link AzScriptStep} renders its script
 * verbatim: the "exactly one Reader assignment at subscription scope" property is
 * tested against the generator's output, and any reformatting here would put an
 * untested transformation between that property and the customer.
 *
 * **It is not a second grant.** The two artifacts are two ways to make the *same*
 * assignment; a customer runs one. The template deliberately takes only the
 * service principal's **object id** as a parameter and holds no credential of any
 * kind, which is also why it cannot stand alone — the principal has to exist
 * first, whether from the script above or from the customer's own tooling.
 */

type ArmTemplateStepProps = Readonly<{
  /** A validated Azure subscription GUID — see {@link AzScriptStep}. */
  subscriptionId: string
}>

export function ArmTemplateStep({ subscriptionId }: ArmTemplateStepProps) {
  const template = readerRoleArmTemplate(subscriptionId)
  const scope = subscriptionScope(subscriptionId)

  return (
    <section
      data-slot="arm-template-step"
      aria-labelledby="arm-template-step-heading"
      className="flex flex-col gap-3"
    >
      <div className="flex flex-col gap-1">
        <h3
          id="arm-template-step-heading"
          className="font-heading text-sm font-medium tracking-tight"
        >
          Option B — the ARM template
        </h3>

        <p className="text-sm text-muted-foreground">
          A subscription-scope deployment holding exactly one{" "}
          <code className="rounded-sm bg-muted px-1 py-0.5 font-mono text-xs">
            Microsoft.Authorization/roleAssignments
          </code>{" "}
          resource: {READER_ROLE_NAME} at{" "}
          <span className="font-mono text-xs tabular-nums">{scope}</span>. It
          takes one parameter — the object id of the service principal that will
          read the subscription — and contains no credential. Deploy this
          instead of the script, not as well as it.
        </p>
      </div>

      <pre
        tabIndex={0}
        aria-label={`ARM template granting ${READER_ROLE_NAME} at ${scope}`}
        className="max-h-96 overflow-auto rounded-lg border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
      >
        {template}
      </pre>

      <div className="flex justify-end">
        <CopyButton value={template} label="Copy the ARM template" />
      </div>
    </section>
  )
}
