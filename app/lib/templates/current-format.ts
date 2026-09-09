/** Apply current display defaults to a new editable draft or preview, never an archived run. */
export function currentDisplayFormat(definition: unknown): unknown {
  if (!definition || typeof definition !== "object") return definition
  const def = definition as Record<string, unknown>
  if (def.schema_version !== 3 || !def.design || typeof def.design !== "object") return definition
  const design = def.design as Record<string, unknown>
  const format = design.number_format && typeof design.number_format === "object" ? design.number_format : {}
  return { ...def, design: { ...design, number_format: { ...format, trim_trailing_zeros: true, bytes_as_gib: true } } }
}
