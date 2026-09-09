import { expect, test } from "vitest"
import { pinNumberFormat } from "@/lib/actions/templates"

test("new v3 versions pin GiB without mutating the previous definition", () => {
  const previous = { schema_version: 3, design: { number_format: { decimal_places: 2, group_thousands: true } } }
  expect(pinNumberFormat(previous)).toEqual({
    schema_version: 3,
    design: { number_format: { decimal_places: 2, group_thousands: true, trim_trailing_zeros: true, bytes_as_gib: true } },
  })
  expect(previous.design.number_format).not.toHaveProperty("bytes_as_gib")
})

test("older schema definitions retain their byte presentation", () => {
  const previous = { schema_version: 2, design: {} }
  expect(pinNumberFormat(previous)).toBe(previous)
})
