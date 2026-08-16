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
 * ## Not a popover
 *
 * The design's registry set for this spec carries no dropdown or popover
 * primitive, and a menu here would earn nothing: it would hide two items behind
 * a disclosure, add a focus trap and a keyboard contract to get right, and
 * force this file across the client boundary. Identity and sign-out are two
 * lines; they sit in the rail's footer where they are already reachable by Tab.
 *
 * ## The email
 *
 * `font-mono` with `truncate`. Mono because an address is an identifier rather
 * than prose, matching how ids and figures are set everywhere else in this
 * product; truncated because a long address must not widen the rail or wrap into
 * a second line that pushes the sign-out control around. The `title` attribute
 * keeps the full value reachable on hover, and the text itself is never
 * abbreviated in the DOM, so a screen reader reads the whole address.
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
    <div className="flex min-w-0 flex-col gap-1">
      <div className="flex min-w-0 items-center gap-2 px-3 py-1">
        <UserCircleIcon
          aria-hidden="true"
          className="size-4 shrink-0 text-muted-foreground"
        />

        <span
          title={email}
          className="truncate font-mono text-xs text-sidebar-foreground/80"
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
          size="sm"
          className="w-full justify-start text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground dark:hover:bg-sidebar-accent"
        >
          <SignOutIcon aria-hidden="true" />
          Sign out
        </Button>
      </form>
    </div>
  )
}
