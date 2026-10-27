"use client"

import Link from "next/link"
import { PlusIcon, SparkleIcon, SquaresFourIcon, StackIcon, type Icon } from "@phosphor-icons/react"

import { Button, buttonVariants } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog"
import { useWorkspace } from "@/components/workspaces/workspace-context"
import { messageText } from "@/lib/messages/catalog"
import { can } from "@/lib/workspaces/policy"
import { cn } from "@/lib/utils"

/**
 * The three ways into a new preset: describe it, start from a starter, or a blank page.
 *
 * Shown twice on the presets page, as the quick-start row and behind the "New preset"
 * button, so a consultant who reaches for the button meets the same three doors. Every
 * door ends in the builder, which is unchanged: Describe it drafts an outline first, the
 * other two open the Start screen with a starter chosen.
 *
 * Disabled on the same terms as {@link NewTemplateButton}: no customer selected, an
 * archived customer, or a role that cannot edit.
 */

type Door = {
  key: "describe" | "starter" | "blank"
  href: string
  icon: Icon
  title: string
  body: string
  isNew?: boolean
}

function doors(): readonly Door[] {
  return [
    {
      key: "describe",
      href: "/report-profiles/describe",
      icon: SparkleIcon,
      title: messageText("ui.presets.quick_describe_title", "en") ?? "",
      body: messageText("ui.presets.quick_describe_body", "en") ?? "",
      isNew: true,
    },
    {
      key: "starter",
      href: "/report-profiles/new",
      icon: SquaresFourIcon,
      title: messageText("ui.presets.quick_starter_title", "en") ?? "",
      body: messageText("ui.presets.quick_starter_body", "en") ?? "",
    },
    {
      key: "blank",
      href: "/report-profiles/new?starter=blank",
      icon: StackIcon,
      title: messageText("ui.presets.quick_blank_title", "en") ?? "",
      body: messageText("ui.presets.quick_blank_body", "en") ?? "",
    },
  ]
}

function useCanCreate(): boolean {
  const workspace = useWorkspace()
  return !workspace || (!!workspace.projectId && !workspace.archived && can(workspace.role, "edit"))
}

function DoorCard({ door, disabled, stacked }: Readonly<{ door: Door; disabled: boolean; stacked?: boolean }>) {
  const Glyph = door.icon
  const content = (
    <>
      <span
        className={cn(
          "grid size-9 shrink-0 place-items-center rounded-lg",
          door.key === "describe" ? "bg-primary text-primary-foreground" : "bg-muted text-foreground"
        )}
      >
        <Glyph aria-hidden="true" className="size-[18px]" />
      </span>
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-2 text-sm font-semibold">
          {door.title}
          {door.isNew ? (
            <span className="text-[10px] font-semibold tracking-wide text-primary uppercase">
              {messageText("ui.presets.quick_new_badge", "en")}
            </span>
          ) : null}
        </span>
        <span className="text-xs leading-snug text-muted-foreground">{door.body}</span>
      </span>
    </>
  )
  const className = cn(
    "flex items-start gap-3 rounded-xl border border-border bg-card px-4 py-3.5 text-left",
    stacked && "w-full",
    disabled ? "opacity-50" : "hover:border-primary hover:bg-primary/5 focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
  )
  if (disabled) {
    return (
      <span aria-disabled="true" className={className}>
        {content}
      </span>
    )
  }
  return (
    <Link href={door.href} className={className}>
      {content}
    </Link>
  )
}

/** The quick-start row above the presets list. */
export function PresetQuickStarts() {
  const canCreate = useCanCreate()
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {doors().map((door) => (
          <DoorCard key={door.key} door={door} disabled={!canCreate} />
        ))}
      </div>
      {canCreate ? null : (
        <p className="text-xs text-muted-foreground">{messageText("ui.presets.quick_unavailable", "en")}</p>
      )}
    </div>
  )
}

const NEW_CARD_CLASS =
  "flex min-h-72 flex-col items-center justify-center gap-2 rounded-xl border-[1.5px] border-dashed border-border text-primary"

/**
 * "New preset", opening a chooser with the same three doors. As `card`, the trigger is
 * the dashed last tile of the presets gallery rather than a button.
 */
export function NewPresetChooser({ variant = "button" }: Readonly<{ variant?: "button" | "card" }>) {
  const canCreate = useCanCreate()
  const label = messageText("ui.presets.chooser_title", "en")
  const cardContent = (
    <>
      <PlusIcon aria-hidden="true" className="size-7" />
      <span className="text-sm font-semibold">{label}</span>
      <span className="text-xs text-muted-foreground">{messageText("ui.presets.new_card_body", "en")}</span>
    </>
  )
  if (!canCreate) {
    return variant === "card" ? (
      <span aria-disabled="true" className={cn(NEW_CARD_CLASS, "opacity-50")}>
        {cardContent}
      </span>
    ) : (
      <span aria-disabled="true" className={cn(buttonVariants(), "pointer-events-none opacity-50")}>
        <PlusIcon aria-hidden="true" />
        {label}
      </span>
    )
  }
  return (
    <Dialog>
      {variant === "card" ? (
        <DialogTrigger
          render={
            <button
              type="button"
              className={cn(
                NEW_CARD_CLASS,
                "cursor-pointer hover:border-primary hover:bg-primary/5 focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
              )}
            />
          }
        >
          {cardContent}
        </DialogTrigger>
      ) : (
        <DialogTrigger render={<Button />}>
          <PlusIcon aria-hidden="true" />
          {label}
        </DialogTrigger>
      )}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{label}</DialogTitle>
          <DialogDescription>{messageText("ui.presets.chooser_body", "en")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          {doors().map((door) => (
            <DoorCard key={door.key} door={door} disabled={false} stacked />
          ))}
        </div>
      </DialogContent>
    </Dialog>
  )
}
