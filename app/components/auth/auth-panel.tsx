import { CheckIcon, GaugeIcon, LockSimpleIcon } from "@phosphor-icons/react/ssr"

/**
 * The navy half of the sign-in and register pages.
 *
 * A server component. Sign in shows what the product proves — one figure traced to
 * its snapshot — and Create account shows the three steps that follow the form. The
 * panel names no cloud: the same page serves a team with one environment and a
 * provider with many, on AWS or Azure.
 *
 * The figure is an illustration, labelled as one, never a real customer's number: this
 * page is public.
 */
export function AuthPanel({ kind }: Readonly<{ kind: "signin" | "register" }>) {
  return (
    <aside className="relative hidden flex-col justify-between gap-12 overflow-hidden bg-(--auth-panel) px-14 py-10 text-(--auth-panel-foreground) lg:flex">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(color-mix(in_oklab,var(--auth-panel-foreground)_9%,transparent)_1px,transparent_1px)] bg-size-[22px_22px]"
      />

      <Wordmark />

      {kind === "signin" ? <SignInStory /> : <RegisterSteps />}

      <p className="relative flex items-center gap-2 text-meta text-(--auth-panel-muted)">
        <LockSimpleIcon aria-hidden="true" className="size-4" />
        {kind === "signin"
          ? "Read-only access to your environment"
          : "We only ask for read access. Nothing in your environment is changed."}
      </p>
    </aside>
  )
}

function Wordmark() {
  return (
    <div className="relative flex items-center gap-2.5">
      <span className="grid size-9 place-items-center rounded-lg bg-(--auth-panel-foreground) text-(--auth-panel)">
        <GaugeIcon aria-hidden="true" weight="duotone" className="size-5" />
      </span>
      <span className="text-[17px] font-semibold tracking-[-0.01em]">Utilize Space</span>
    </div>
  )
}

function SignInStory() {
  return (
    <div className="relative flex max-w-[30rem] flex-col gap-7">
      <h2 className="text-[2.5rem] leading-[1.08] font-semibold tracking-[-0.03em] text-balance">
        Monthly reports on your environment, checkable figure by figure.
      </h2>
      <p className="max-w-[46ch] text-base leading-relaxed text-(--auth-panel-muted)">
        Every figure in a delivered report traces to an immutable snapshot of the
        environment it came from.
      </p>

      <figure
        aria-label="An example of a traced figure"
        className="flex flex-col gap-3.5 rounded-xl border border-(--auth-panel-foreground)/15 bg-(--auth-panel-foreground)/[0.06] p-4.5"
      >
        <div className="flex items-center justify-between gap-3">
          <span className="text-meta text-(--auth-panel-muted)">Example · Capacity review, September</span>
          <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-(--auth-panel-verified)/15 px-2.5 text-xs font-semibold text-(--auth-panel-verified)">
            <CheckIcon aria-hidden="true" weight="bold" className="size-3" />
            Verified
          </span>
        </div>
        <div className="flex items-baseline gap-2.5">
          <span className="font-mono text-[2.125rem] font-medium tracking-[-0.03em]">179</span>
          <span className="text-sm text-(--auth-panel-muted)">resources scanned</span>
        </div>
        <div className="flex items-center gap-2.5">
          <span aria-hidden="true" className="size-2.5 shrink-0 rounded-full border-2 border-(--auth-panel-accent)" />
          <span
            aria-hidden="true"
            className="h-px flex-1 bg-[linear-gradient(90deg,var(--auth-panel-accent)_50%,transparent_50%)] bg-size-[8px_1px] opacity-70"
          />
          <span className="rounded-md bg-(--auth-panel-foreground)/[0.08] px-2 py-1 font-mono text-xs">
            snapshot 3f9a1c0be27d
          </span>
        </div>
      </figure>
    </div>
  )
}

const STEPS = [
  {
    title: "Create your account",
    body: "An email and a password. You can invite your team later.",
  },
  {
    title: "Connect your environment, read-only",
    body: "Give the app read access, and it scans what is there.",
  },
  {
    title: "Request a report",
    body: "Pick a preset, and every figure in the result traces back to a snapshot.",
  },
] as const

function RegisterSteps() {
  return (
    <div className="relative flex max-w-[30rem] flex-col gap-8">
      <h2 className="text-[2.25rem] leading-[1.1] font-semibold tracking-[-0.03em] text-balance">
        Your first report in three steps
      </h2>
      <ol className="flex flex-col gap-5.5">
        {STEPS.map((step, index) => (
          <li key={step.title} className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-4">
            <span
              className={
                index === 0
                  ? "grid size-9 place-items-center rounded-full bg-(--auth-panel-foreground) text-sm font-semibold text-(--auth-panel)"
                  : "grid size-9 place-items-center rounded-full border border-(--auth-panel-foreground)/30 text-sm font-semibold"
              }
            >
              {index + 1}
            </span>
            <div className="flex flex-col gap-0.5 pt-1.5">
              <span className="text-base font-semibold">{step.title}</span>
              <span className="text-sm leading-relaxed text-(--auth-panel-muted)">{step.body}</span>
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}
