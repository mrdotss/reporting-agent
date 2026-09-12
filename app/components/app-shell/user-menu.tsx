import { SignOutIcon, UserCircleIcon } from "@phosphor-icons/react/ssr"

import { Button } from "@/components/ui/button"
import { logoutAction } from "@/lib/actions/auth"

/**
 * Who is signed in, and the way out (Requirements 7.6, 7.8).
 *
 * A **server** component, and the reason is worth stating because it is not the
 * default for a component with a button in it: sign-out is a `<form>` posting to
 * a Server Function, so there is no client state to hold and nothing to
 * hydrate. It is rendered by the `(app)` layout and passed *through* the client
 * sidebar as `children`, which is what lets the sidebar own `usePathname`
 * without dragging this file into the browser bundle. The Phosphor import is
 * therefore `/ssr`, not the default entry.
 *
 * ## Still not a popover, and now laid out across
 *
 * A menu here would hide two items behind a disclosure, add a focus trap and a
 * keyboard contract to get right, and force this file across the client
 * boundary for nothing. That reasoning has not changed. What changed is where
 * it sits: there is no rail any more, so a two-line block in its footer is now
 * a two-line block inside a 48px register bar, which it overflowed — it
 * rendered on top of the tab strip below it.
 *
 * So it lays out **horizontally**: the address, truncated, and sign-out as an
 * icon-only control beside it. Two items, both still one Tab away, both fitting
 * the band they are in.
 *
 * ## The email
 *
 * `font-mono` with `truncate`. Mono because an address is an identifier rather
 * than prose, matching how ids and figures are set everywhere else in this
 * product; truncated because a long address must not push the register bar's
 * other controls around. It is capped at `max-w-44` and hidden below `sm`,
 * where the bar has no room for it and the icon alone still carries the action.
 * The `title` attribute keeps the full value reachable on hover, and the text
 * itself is never abbreviated in the DOM, so a screen reader reads the whole
 * address.
 */
type UserMenuProps = Readonly<{
  /**
   * The signed-in user's email, resolved by `requireSession()` in the layout.
   *
   * A prop rather than a `readSession()` call of its own: the layout has already
   * performed the authoritative check, and a second read would be a second
   * database round trip that could disagree with the first.
   */
  email: string
}>

export function UserMenu({ email }: UserMenuProps) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <div className="hidden min-w-0 items-center gap-1.5 sm:flex">
        <UserCircleIcon
          aria-hidden="true"
          className="size-3.5 shrink-0 text-muted-foreground"
        />

        <span
          title={email}
          className="max-w-44 truncate font-mono text-micro text-muted-foreground"
        >
          {email}
        </span>
      </div>

      {/*
        `logoutAction` takes no arguments and ignores the `FormData` a form
        submission passes, so it is usable directly as the form's action. A
        plain form rather than an `onClick` handler: sign-out is a state change
        on the server, it must not be a GET, and this way it works before — and
        without — hydration.
      */}
      <form action={logoutAction}>
        <Button
          type="submit"
          variant="ghost"
          size="icon-sm"
          aria-label="Sign out"
          title="Sign out"
          className="text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <SignOutIcon aria-hidden="true" />
        </Button>
      </form>
    </div>
  )
}
