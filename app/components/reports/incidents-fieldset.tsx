"use client"

import { useId } from "react"
import { PlusIcon, TrashIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { messageText } from "@/lib/messages/catalog"
import {
  MAX_INCIDENT_CASE_LENGTH,
  MAX_INCIDENT_DATE_LENGTH,
  MAX_INCIDENT_TEXT_LENGTH,
  MAX_INCIDENTS,
  type Incident,
} from "@/lib/runs/input"

/**
 * "Incidents this period" on the run form: what happened this month, typed once and printed
 * into the report's Incident Report table in the Word file and both PDFs, ahead of its
 * blank rows (which stay fillable for anything added later).
 *
 * Optional, and empty by default — most months have nothing to report, and an empty list
 * prints the table's blank rows exactly as before. An entry left entirely blank is dropped
 * when the form is sent (`buildRunCreateBody`), so adding one and changing your mind costs
 * nothing.
 */

export const EMPTY_INCIDENT: Incident = { case: "", date: "", description: "", solution: "" }

export function IncidentsFieldset({
  incidents,
  onChange,
}: Readonly<{
  incidents: readonly Incident[]
  onChange: (incidents: Incident[]) => void
}>) {
  const baseId = useId()

  function update(index: number, field: keyof Incident, value: string) {
    onChange(incidents.map((incident, at) => (at === index ? { ...incident, [field]: value } : incident)))
  }

  return (
    <fieldset
      data-slot="run-form-incidents"
      className="flex flex-col gap-4 rounded-lg border border-border px-3 py-3"
    >
      <legend className="px-1 font-heading text-sm font-medium tracking-tight">
        {messageText("ui.run_form.incidents_heading", "en")}
      </legend>

      <FieldDescription>{messageText("ui.run_form.incidents_hint", "en")}</FieldDescription>

      {incidents.map((incident, index) => {
        const number = String(index + 1)
        const id = (field: string) => `${baseId}-${index}-${field}`
        return (
          <div
            key={index}
            data-slot="run-form-incident"
            className="flex flex-col gap-3 rounded-md border border-border/70 bg-muted/40 px-3 py-3"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium text-muted-foreground">
                {messageText("ui.run_form.incident_number", "en", { number })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={messageText("ui.run_form.incident_remove", "en", { number }) ?? undefined}
                onClick={() => onChange(incidents.filter((_, at) => at !== index))}
                className="text-muted-foreground hover:text-destructive"
              >
                <TrashIcon aria-hidden="true" />
              </Button>
            </div>

            <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <Field>
                <FieldLabel htmlFor={id("case")}>
                  {messageText("ui.run_form.incident_case_label", "en")}
                </FieldLabel>
                <Input
                  id={id("case")}
                  value={incident.case}
                  maxLength={MAX_INCIDENT_CASE_LENGTH}
                  onChange={(event) => update(index, "case", event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={id("date")}>
                  {messageText("ui.run_form.incident_date_label", "en")}
                </FieldLabel>
                <Input
                  id={id("date")}
                  value={incident.date}
                  maxLength={MAX_INCIDENT_DATE_LENGTH}
                  onChange={(event) => update(index, "date", event.target.value)}
                />
              </Field>
            </div>

            <Field>
              <FieldLabel htmlFor={id("description")}>
                {messageText("ui.run_form.incident_description_label", "en")}
              </FieldLabel>
              <Textarea
                id={id("description")}
                value={incident.description}
                maxLength={MAX_INCIDENT_TEXT_LENGTH}
                rows={2}
                onChange={(event) => update(index, "description", event.target.value)}
              />
            </Field>

            <Field>
              <FieldLabel htmlFor={id("solution")}>
                {messageText("ui.run_form.incident_solution_label", "en")}
              </FieldLabel>
              <Textarea
                id={id("solution")}
                value={incident.solution}
                maxLength={MAX_INCIDENT_TEXT_LENGTH}
                rows={2}
                onChange={(event) => update(index, "solution", event.target.value)}
              />
            </Field>
          </div>
        )
      })}

      {incidents.length < MAX_INCIDENTS ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          onClick={() => onChange([...incidents, { ...EMPTY_INCIDENT }])}
        >
          <PlusIcon aria-hidden="true" />
          {messageText("ui.run_form.incident_add", "en")}
        </Button>
      ) : null}
    </fieldset>
  )
}
