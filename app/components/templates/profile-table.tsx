"use client"

import Link from "next/link"
import {
  ProviderMark,
  SOURCE_NAMES,
} from "@/components/subscriptions/provider-mark"
import {
  CopyIcon,
  PencilSimpleIcon,
  PlayIcon,
  TrashIcon,
} from "@phosphor-icons/react/ssr"

import { Identifier } from "@/components/identifier"
import {
  formatEdited,
  presetStatus,
  sectionCount,
  TONE_CLASS,
} from "@/components/templates/preset-status"
import { SectionMarks } from "@/components/templates/section-marks"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { TemplateView } from "@/lib/db/views"
import { messageText } from "@/lib/messages/catalog"
import { cn } from "@/lib/utils"

/**
 * The report-profile list, as a table (task 2.1). Since the card gallery it is the
 * List view of `PresetLibrary`, which owns search, filters and the delete dialog; this
 * component draws the rows it is handed.
 *
 * ## Why a table rather than the cards it replaces
 *
 * A card gives every row the same visual weight, and most rows are not equal: a
 * real account carries a handful of published profiles and a long tail of
 * abandoned "Untitled profile · unsaved draft" ones. In columns the status and
 * the date line up, so the eye skips the tail instead of reading it. It is also
 * the shape search and filtering belong to — a filtered set of cards reflows,
 * while a filtered set of rows just gets shorter.
 *
 * No selection checkboxes. There is no bulk action to select *for* — delete is
 * per-row and refusable per-row (see below) — and a checkbox column that leads
 * nowhere is a control that has to be explained.
 *
 * ## What a row says about the preset
 *
 * Its sections as marks, read from the version a run would pin, so the outline is
 * visible without opening the builder; the customer it belongs to, where more than one
 * customer's presets are shown; its state as the same pill the cards use; and a run
 * action that opens the request form with the preset chosen. A draft that was never
 * saved has no version to run, so its run action is disabled and says why.
 */

export function ProfileTable({
  rows,
  customers,
  showCustomer = true,
  onDelete,
}: Readonly<{
  rows: readonly TemplateView[]
  /** Customer names by project id, for the customer column. */
  customers?: ReadonlyMap<string, string>
  /** False inside one customer, and for a team with one customer: the column would repeat itself. */
  showCustomer?: boolean
  onDelete: (template: TemplateView) => void
}>) {
  return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Profile</TableHead>
            <TableHead className="w-40">{messageText("ui.presets.col_sections", "en")}</TableHead>
            {showCustomer ? (
              <TableHead className="w-36">{messageText("ui.presets.col_customer", "en")}</TableHead>
            ) : null}
            <TableHead className="w-48">Status</TableHead>
            <TableHead className="w-28">Last edited</TableHead>
            <TableHead className="w-40 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.map((template) => {
            const status = presetStatus(template)
            return (
              <TableRow key={template.id}>
                <TableCell>
                  {/* A column, because `Identifier` is inline-flex: dropped straight
                      after the link it ran onto the end of the name. */}
                  <div className="flex flex-col items-start gap-0.5">
                  <span className="flex items-center gap-2">
                  <ProviderMark kind={template.provider} className="[&_svg]:size-4" />
                  <span className="sr-only">{SOURCE_NAMES[template.provider]} preset: </span>
                  <Link
                    href={`/report-profiles/${template.id}/edit`}
                    className="font-medium underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
                  >
                    {template.name}
                  </Link>
                  </span>
                  <span className="line-clamp-2 max-w-md text-xs whitespace-normal text-muted-foreground">
                    {template.description.trim() !== ""
                      ? template.description
                      : template.sectionTypes.length > 0
                        ? sectionCount(template.sectionTypes.length)
                        : null}
                  </span>
                  {template.currentVersionSha256 === null ? null : (
                    <Identifier
                      value={template.currentVersionSha256}
                      kind="digest"
                      label="Definition digest"
                      className="text-muted-foreground"
                    />
                  )}
                  </div>
                </TableCell>

                <TableCell>
                  {template.provider === "onprem" || template.sectionTypes.length === 0 ? (
                    <span className="text-xs text-muted-foreground">
                      {template.sectionTypes.length === 0
                        ? messageText("ui.presets.no_sections", "en")
                        : sectionCount(template.sectionTypes.length)}
                    </span>
                  ) : (
                    <SectionMarks provider={template.provider} types={template.sectionTypes} />
                  )}
                </TableCell>

                {showCustomer ? (
                  <TableCell className="text-sm">
                    {template.projectId && customers?.has(template.projectId) ? (
                      customers.get(template.projectId)
                    ) : (
                      <span className="text-muted-foreground">{messageText("ui.presets.no_customer", "en")}</span>
                    )}
                  </TableCell>
                ) : null}

                <TableCell>
                  <span
                    data-slot="preset-status"
                    data-tone={status.tone}
                    className={cn(
                      "inline-flex h-6 items-center rounded-full px-2 text-[11px] font-semibold",
                      TONE_CLASS[status.tone]
                    )}
                  >
                    {status.label}
                  </span>
                </TableCell>

                <TableCell className="text-sm text-muted-foreground">
                  {formatEdited(template.updatedAt)}
                </TableCell>

                <TableCell className="text-right">
                  {/*
                    `size="xs"` is a *text* button size — 24px tall with horizontal
                    padding for a label — and these carry an icon and no label, so each
                    row action was a 24px target. `icon-sm` is the square size for this,
                    at 32px with the glyph optically centred.

                    Not 44px: three actions sit side by side in a 48px row, and
                    expanding each to the WCAG target would overlap its neighbours,
                    which trades a small target for a mis-hit destructive one. Reaching
                    44 here needs the row to hold one control and a menu, which is a
                    bigger change than this pass.
                  */}
                  <div className="flex justify-end gap-1">
                    <Link
                      data-slot="button"
                      href={`/report-profiles/${template.id}/edit`}
                      aria-label={`Edit ${template.name}`}
                      className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
                    >
                      <PencilSimpleIcon aria-hidden="true" />
                    </Link>
                    {template.currentVersion === null ? (
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        disabled
                        aria-label={messageText("ui.presets.run_unavailable", "en", { name: template.name })}
                        title={messageText("ui.presets.run_unavailable", "en", { name: template.name })}
                      >
                        <PlayIcon aria-hidden="true" />
                      </Button>
                    ) : (
                      <Link
                        data-slot="button"
                        href={`/reports/new?template=${template.id}`}
                        aria-label={messageText("ui.presets.run", "en", { name: template.name })}
                        title={messageText("ui.presets.run", "en", { name: template.name })}
                        className={buttonVariants({ size: "icon-sm", variant: "ghost" })}
                      >
                        <PlayIcon aria-hidden="true" />
                      </Link>
                    )}
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Duplicate ${template.name}`}
                      disabled
                      title="Duplicating a profile is not built yet"
                    >
                      <CopyIcon aria-hidden="true" />
                    </Button>
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      aria-label={`Delete ${template.name}`}
                      onClick={() => onDelete(template)}
                    >
                      <TrashIcon aria-hidden="true" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}

        </TableBody>
      </Table>
  )
}
