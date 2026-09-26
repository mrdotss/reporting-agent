"use client"

import { useId } from "react"

import { Checkbox } from "@/components/ui/checkbox"
import { FieldDescription } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { messageText } from "@/lib/messages/catalog"
import { AWS_REGION_NAMES } from "@/lib/runs/regions"

/**
 * "Regions" on the run form, for an AWS connector: every enabled region (the default, and
 * what an AWS run collected before this existed) or only the ones ticked.
 *
 * The choices are the regions the account's last passing Verify listed, never a typed code,
 * so a run cannot ask for a region the connector was not checked against. The enqueue
 * refuses one anyway. `picked === null` is "every enabled region"; an empty array is a
 * choice not yet made, which the form refuses to send.
 */
export function RegionsFieldset({
  enabled,
  picked,
  onChange,
}: Readonly<{
  enabled: readonly string[]
  picked: readonly string[] | null
  onChange: (picked: string[] | null) => void
}>) {
  const baseId = useId()
  const total = String(enabled.length)
  const choosing = picked !== null

  return (
    <fieldset
      data-slot="run-form-regions"
      className="flex flex-col gap-3 rounded-lg border border-border px-3 py-3"
    >
      <legend className="px-1 font-heading text-sm font-medium tracking-tight">
        {messageText("ui.run_form.regions_heading", "en")}
      </legend>

      <RadioGroup
        value={choosing ? "some" : "all"}
        onValueChange={(value) => onChange(value === "some" ? [...(picked ?? [])] : null)}
        className="gap-2"
      >
        <label htmlFor={`${baseId}-all`} className="flex cursor-pointer items-start gap-2.5 text-sm">
          <RadioGroupItem id={`${baseId}-all`} value="all" className="mt-0.5" />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{messageText("ui.run_form.regions_all", "en")}</span>
            <span className="text-xs text-muted-foreground">
              {messageText("ui.run_form.regions_all_detail", "en", { count: total })}
            </span>
          </span>
        </label>
        <label htmlFor={`${baseId}-some`} className="flex cursor-pointer items-start gap-2.5 text-sm">
          <RadioGroupItem id={`${baseId}-some`} value="some" className="mt-0.5" />
          <span className="flex flex-col gap-0.5">
            <span className="font-medium">{messageText("ui.run_form.regions_some", "en")}</span>
            <span className="text-xs text-muted-foreground">
              {messageText("ui.run_form.regions_some_detail", "en")}
            </span>
          </span>
        </label>
      </RadioGroup>

      {choosing ? (
        <div className="flex flex-col gap-2 pl-6">
          <div
            role="group"
            aria-label={messageText("ui.run_form.regions_heading", "en") ?? undefined}
            className="grid grid-cols-1 gap-px overflow-hidden rounded-md border border-border/70 bg-border/60 sm:grid-cols-2"
          >
            {enabled.map((region) => {
              const id = `${baseId}-${region}`
              const checked = picked.includes(region)
              const place = AWS_REGION_NAMES[region]
              return (
                <label
                  key={region}
                  htmlFor={id}
                  className="flex cursor-pointer items-center gap-2.5 bg-card px-3 py-2 hover:bg-muted"
                >
                  <Checkbox
                    id={id}
                    checked={checked}
                    onCheckedChange={(value) =>
                      onChange(
                        value === true
                          ? [...picked, region].sort()
                          : picked.filter((entry) => entry !== region)
                      )
                    }
                  />
                  <span className="min-w-0 truncate">
                    <span className="font-mono text-sm">{region}</span>
                    {place === undefined ? null : (
                      <span className="text-xs text-muted-foreground"> · {place}</span>
                    )}
                  </span>
                </label>
              )
            })}
          </div>
          <FieldDescription aria-live="polite" className="tabular-nums">
            {picked.length === 0
              ? messageText("ui.run_form.regions_none_picked", "en")
              : messageText("ui.run_form.regions_picked", "en", { picked: String(picked.length), total })}
          </FieldDescription>
        </div>
      ) : null}
    </fieldset>
  )
}
