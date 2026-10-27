"use client"

import Link from "next/link"
import {
  CopyIcon,
  DotsThreeIcon,
  PlayIcon,
  StackPlusIcon,
  TrashIcon,
} from "@phosphor-icons/react"

import { PresetSketch } from "@/components/templates/preset-sketch"
import {
  formatEditedShort,
  isEmptyPreset,
  presetStatus,
  sectionCount,
  SOURCE_DOT_CLASS,
  TONE_CLASS,
} from "@/components/templates/preset-status"
import { SOURCE_SHORT_NAMES } from "@/components/subscriptions/provider-mark"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { sectionEntry, sectionTitle } from "@/lib/builder/catalogue"
import type { TemplateView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import { cn } from "@/lib/utils"

/**
 * One preset as a card: a sketch of its first pages, its source and state, its name,
 * a few of its sections by name, and run, edit and more.
 *
 * What the list row carried and the card does not: the version digest, which moves
 * into More, and "unsaved draft", which the state pill replaces. The customer line
 * appears only where presets from more than one customer are shown together.
 */

const TAGS_SHOWN = 3

/**
 * Section names for the tags: what tells one preset from another, so not the At a glance
 * summary most presets open with or the appendix every preset ends with.
 */
function sectionTags(template: TemplateView): { shown: string[]; rest: number } {
  if (template.provider === "onprem") return { shown: [], rest: template.sectionTypes.length }
  const provider = template.provider
  const chosen = template.sectionTypes.filter((type) => {
    const entry = sectionEntry(provider, type)
    return entry?.position !== "always" && entry?.group !== "summary"
  })
  const shown = chosen.slice(0, TAGS_SHOWN).map((type) => sectionTitle(sectionEntry(provider, type), "en"))
  return { shown, rest: chosen.length - shown.length }
}

async function copyDigest(value: string) {
  try {
    await navigator.clipboard.writeText(value)
  } catch {
    // A denied clipboard permission leaves the List view, which shows the digest.
  }
}

export function PresetCard({
  template,
  customer,
  onDelete,
}: Readonly<{
  template: TemplateView
  /** The customer's name, or `undefined` when the page shows one customer's presets only. */
  customer?: string
  onDelete: (template: TemplateView) => void
}>) {
  const status = presetStatus(template)
  const empty = isEmptyPreset(template)
  const tags = sectionTags(template)
  const editHref = `/report-profiles/${template.id}/edit`
  const meta = [
    empty ? messageText("ui.presets.no_sections", "en") : sectionCount(template.sectionTypes.length),
    customer,
  ].filter(Boolean)

  return (
    <article
      data-slot="preset-card"
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-card text-card-foreground"
    >
      <div className="relative">
        <PresetSketch name={template.name} provider={template.provider} types={template.sectionTypes} />
        <span className="absolute top-2.5 left-2.5 flex h-6 items-center gap-1.5 rounded-full bg-card px-2 text-[11px] font-semibold">
          <span aria-hidden="true" className={cn("size-2 rounded-full", SOURCE_DOT_CLASS[template.provider])} />
          {SOURCE_SHORT_NAMES[template.provider]}
        </span>
        <span
          data-slot="preset-status"
          data-tone={status.tone}
          className={cn(
            "absolute top-2.5 right-2.5 flex h-6 items-center rounded-full px-2 text-[11px] font-semibold",
            TONE_CLASS[status.tone]
          )}
        >
          {status.label}
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-2 px-4 pt-3.5 pb-4">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-[15px] leading-snug font-semibold">
            <Link
              href={editHref}
              className="underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
            >
              {template.name}
            </Link>
          </h2>
          <span className="text-xs text-muted-foreground">{meta.join(" · ")}</span>
          {template.description.trim() === "" ? null : (
            <span className="line-clamp-2 text-xs text-muted-foreground">{template.description}</span>
          )}
        </div>

        <ul className="flex flex-wrap gap-1" aria-label={messageText("ui.presets.col_sections", "en")}>
          {empty ? (
            <li className="inline-flex h-[22px] items-center rounded-md border border-dashed border-border px-2 text-[11px] text-muted-foreground">
              {messageText("ui.presets.empty_card", "en")}
            </li>
          ) : (
            <>
              {tags.shown.map((title, index) => (
                <li
                  key={`${title}-${index}`}
                  className="inline-flex h-[22px] max-w-40 items-center truncate rounded-md bg-muted px-2 text-[11px] text-foreground"
                  title={title}
                >
                  <span className="truncate">{title}</span>
                </li>
              ))}
              {tags.rest > 0 ? (
                <li className="inline-flex h-[22px] items-center rounded-md bg-muted px-2 font-mono text-[11px] text-muted-foreground tabular-nums">
                  +{tags.rest}
                </li>
              ) : null}
            </>
          )}
        </ul>

        <div className="mt-auto flex items-center gap-1.5 border-t border-border/60 pt-2.5">
          <span className="flex-1 text-xs text-muted-foreground">
            {messageText("ui.presets.edited", "en", { date: formatEditedShort(template.updatedAt) })}
          </span>

          {template.currentVersion === null ? (
            <Button
              size="icon-sm"
              variant="outline"
              disabled
              aria-label={messageText("ui.presets.run_unavailable", "en", { name: template.name })}
              title={messageText("ui.presets.run_unavailable", "en", { name: template.name })}
            >
              <PlayIcon aria-hidden="true" weight="fill" />
            </Button>
          ) : (
            <Link
              data-slot="button"
              href={`/reports/new?template=${template.id}`}
              aria-label={messageText("ui.presets.run", "en", { name: template.name })}
              title={messageText("ui.presets.run", "en", { name: template.name })}
              className={buttonVariants({ size: "icon-sm", variant: "outline" })}
            >
              <PlayIcon aria-hidden="true" weight="fill" className="text-primary" />
            </Link>
          )}

          <Link
            data-slot="button"
            href={editHref}
            aria-label={messageText("ui.presets.edit_named", "en", { name: template.name })}
            className={buttonVariants({ size: "sm", variant: "outline" })}
          >
            {messageText("ui.presets.edit", "en")}
          </Link>

          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="outline"
                  aria-label={messageText("ui.presets.more", "en", { name: template.name })}
                />
              }
            >
              <DotsThreeIcon aria-hidden="true" weight="bold" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-auto min-w-64">
              {template.currentVersionSha256 === null ? null : (
                <DropdownMenuItem onClick={() => void copyDigest(template.currentVersionSha256 ?? "")}>
                  <CopyIcon aria-hidden="true" />
                  {messageText("ui.presets.copy_digest", "en")}
                  <span className="ml-auto pl-3 font-mono text-xs whitespace-nowrap text-muted-foreground">
                    {template.currentVersionSha256.slice(0, 8)}
                  </span>
                </DropdownMenuItem>
              )}
              <DropdownMenuItem disabled title={messageText("ui.presets.duplicate_unavailable", "en")}>
                <StackPlusIcon aria-hidden="true" />
                {messageText("ui.presets.duplicate", "en")}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={() => onDelete(template)}>
                <TrashIcon aria-hidden="true" />
                {messageText("ui.presets.delete", "en")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </article>
  )
}
