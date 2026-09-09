import { expect, test } from "vitest"
import { currentDisplayFormat } from "./current-format"

test("an existing v3 draft and its preview adopt GiB without mutating the saved version", () => {
  const saved = { schema_version: 3, design: { preset: "editorial", number_format: { decimal_places: 3, group_thousands: false } } }
  const draft = currentDisplayFormat(saved)
  expect(draft).toEqual({ schema_version: 3, design: { preset: "editorial", number_format: { decimal_places: 3, group_thousands: false, bytes_as_gib: true, trim_trailing_zeros: true } } })
  expect(saved.design.number_format).not.toHaveProperty("bytes_as_gib")
  expect(currentDisplayFormat(draft)).toEqual(draft)
})
