"use client"

import Link from "next/link"
import { useMemo, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import {
  CopyIcon,
  MagnifyingGlassIcon,
  PencilSimpleIcon,
  TrashIcon,
} from "@phosphor-icons/react/ssr"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import type { TemplateView } from "@/lib/db/views"

/**
 * The report-profile list, as a table (task 2.1).
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
 * ## Deleting, and the refusal that is not an error
 *
 * `DELETE /api/report-profiles/[id]` answers `204`, or `409 TEMPLATE_PINNED`
 * when a run pinned one of the profile's versions. That refusal is a **fact
 * about the account**, not a failure of the request: reports exist, and they
 * stay replayable against the exact definition they were rendered from. So the
 * dialog states it in those terms rather than as an error, and leaves the
 * profile alone.
 *
 * The confirm does not ask the consultant to type the name. The action is
 * reversible in the only sense that matters — a profile with runs cannot be
 * deleted at all, and one without runs has produced nothing to lose.
 */

type Filter = "all" | "published" | "drafts"

/** A profile's state, as the one column that carries it. */
function statusOf(template: TemplateView): {
  label: string
  published: boolean
} {
  if (template.currentVersion === null) return { label: "Draft", published: false }
  return { label: `Version ${template.currentVersion}`, published: true }
}

function formatEdited(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
  })
}

export function ProfileTable({
  templates,
}: Readonly<{ templates: readonly TemplateView[] }>) {
  const router = useRouter()
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<Filter>("all")
  const [pending, startTransition] = useTransition()

  /** The profile the confirm dialog is about, or `null` when it is closed. */
  const [target, setTarget] = useState<TemplateView | null>(null)
  /** A refusal from the server, shown in place of the confirm. */
  const [refusal, setRefusal] = useState<string | null>(null)

  const counts = useMemo(() => {
    const published = templates.filter((t) => t.currentVersion !== null).length
    return { all: templates.length, published, drafts: templates.length - published }
  }, [templates])

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return templates
      .filter((t) =>
        filter === "all"
          ? true
          : filter === "published"
            ? t.currentVersion !== null
            : t.currentVersion === null
      )
      .filter(
        (t) =>
          needle === "" ||
          t.name.toLowerCase().includes(needle) ||
          t.description.toLowerCase().includes(needle)
      )
  }, [templates, query, filter])

  async function confirmDelete(template: TemplateView) {
    const response = await fetch(`/api/report-profiles/${template.id}`, {
      method: "DELETE",
    })

    if (response.status === 204) {
      setTarget(null)
      startTransition(() => router.refresh())
      return
    }

    // 409 TEMPLATE_PINNED carries the reason in its own body; anything else is
    // reported as itself rather than as a guess at what went wrong.
    const body = await response.json().catch(() => null)
    setRefusal(
      typeof body?.message === "string"
        ? body.message
        : `The profile could not be deleted (${response.status}).`
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <MagnifyingGlassIcon
            aria-hidden="true"
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search profiles…"
            aria-label="Search profiles by name or description"
            className="pl-9"
          />
        </div>

        <div className="flex gap-1.5" role="group" aria-label="Filter by state">
          {(
            [
              ["all", "All", counts.all],
              ["published", "Published", counts.published],
              ["drafts", "Drafts", counts.drafts],
            ] as const
          ).map(([value, label, count]) => (
            <Button
              key={value}
              size="sm"
              variant={filter === value ? "secondary" : "ghost"}
              aria-pressed={filter === value}
              onClick={() => setFilter(value)}
            >
              {label}{" "}
              <span className="font-mono tabular-nums opacity-65">{count}</span>
            </Button>
          ))}
        </div>

        <p
          aria-live="polite"
          className="ms-auto text-xs text-muted-foreground"
        >
          {rows.length} of {templates.length} shown
        </p>
      </div>

      {/* Table */}
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Profile</TableHead>
            <TableHead className="w-40">Status</TableHead>
            <TableHead className="w-36">Last edited</TableHead>
            <TableHead className="w-28 text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          {rows.map((template) => {
            const status = statusOf(template)
            return (
              <TableRow key={template.id}>
                <TableCell>
                  <Link
                    href={`/report-profiles/${template.id}/edit`}
                    className="font-medium underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:outline-none"
                  >
                    {template.name}
                  </Link>
                  {template.currentVersionSha256 === null ? null : (
                    <p className="font-mono text-xs text-muted-foreground">
                      {template.currentVersionSha256.slice(0, 12)}
                    </p>
                  )}
                </TableCell>

                <TableCell>
                  <Badge variant={status.published ? "outline" : "secondary"}>
                    {status.label}
                  </Badge>
                  {template.hasDraft ? (
                    <span className="ms-2 text-xs text-muted-foreground">
                      unsaved draft
                    </span>
                  ) : null}
                </TableCell>

                <TableCell className="text-sm text-muted-foreground">
                  {formatEdited(template.updatedAt)}
                </TableCell>

                <TableCell className="text-right">
                  <div className="flex justify-end gap-0.5">
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Edit ${template.name}`}
                      render={
                        <Link href={`/report-profiles/${template.id}/edit`} />
                      }
                    >
                      <PencilSimpleIcon aria-hidden="true" />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Duplicate ${template.name}`}
                      disabled
                      title="Duplicating a profile is not built yet"
                    >
                      <CopyIcon aria-hidden="true" />
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-label={`Delete ${template.name}`}
                      onClick={() => {
                        setRefusal(null)
                        setTarget(template)
                      }}
                    >
                      <TrashIcon aria-hidden="true" />
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            )
          })}

          {rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={4} className="py-14 text-center">
                <p className="font-heading text-sm font-medium">
                  {query.trim() === ""
                    ? "No profile in this filter"
                    : `No profile matches “${query.trim()}”`}
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Try a shorter search, or a different filter.
                </p>
              </TableCell>
            </TableRow>
          ) : null}
        </TableBody>
      </Table>

      {/* Delete confirmation, or the server's refusal in its place */}
      <Dialog
        open={target !== null}
        onOpenChange={(open) => {
          if (!open) {
            setTarget(null)
            setRefusal(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {refusal === null
                ? `Delete “${target?.name}”?`
                : `“${target?.name}” cannot be deleted`}
            </DialogTitle>
            <DialogDescription>
              {refusal ??
                "The profile stops being offered for new runs. Versions no run " +
                  "pinned are removed with it."}
            </DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                setTarget(null)
                setRefusal(null)
              }}
            >
              {refusal === null ? "Cancel" : "Close"}
            </Button>
            {refusal === null ? (
              <Button
                variant="destructive"
                disabled={pending}
                onClick={() => {
                  if (target !== null) void confirmDelete(target)
                }}
              >
                Delete profile
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
