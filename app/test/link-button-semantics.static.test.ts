import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, test } from "vitest"

const projectRoot = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)
const EXCLUDED = new Set(["node_modules", ".next", "dist", "build"])

/** Every `.tsx` under a directory, relative to the project root. */
function listTsx(relativeDirectory: string): readonly string[] {
  const found: string[] = []
  const walk = (relative: string): void => {
    const absolute = path.join(projectRoot, relative)
    if (!existsSync(absolute)) return
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (EXCLUDED.has(entry.name)) continue
        walk(path.join(relative, entry.name))
        continue
      }
      if (entry.isFile() && entry.name.endsWith(".tsx")) {
        found.push(path.join(relative, entry.name))
      }
    }
  }
  walk(relativeDirectory)
  return found
}

/**
 * Navigation is a link, however it is painted.
 *
 * Three ways to render a control that goes somewhere, measured rather than assumed:
 *
 * | form                                    | role   | type            | console |
 * |-----------------------------------------|--------|-----------------|---------|
 * | `<Button render={<Link/>}>`             | link   | `type="button"` | 1 error |
 * | `<Button nativeButton={false} …>`       | button | —               | clean   |
 * | `<Link className={buttonVariants()}>`   | link   | —               | clean   |
 *
 * The middle row is the trap, and it is the one that looks like the fix: Base UI's error
 * asks for `nativeButton={false}`, and setting it silences the error by putting
 * `role="button"` on an anchor — telling a screen reader that a thing which navigates
 * instead activates something. `type="button"` on an `<a>` in the first row is merely
 * meaningless; announcing the wrong role is a lie.
 *
 * So neither: a link stays a link and takes the button's clothes. `buttonVariants` is the
 * same class list the component applies, and `data-slot="button"` is what
 * `globals.css` keys the workspace radius on — dropping it silently un-styles the control
 * under `.workspace-design` while every test still passes.
 *
 * Scanned rather than asserted per component, because the next one written is the one
 * that matters and no per-component test covers a component that does not exist yet.
 */

const BUTTON_WITH_RENDER = /<Button\b((?:[^>]|\n)*?)(?=\/?>)/g

function offendersIn(source: string): readonly string[] {
  const found: string[] = []
  for (const match of source.matchAll(BUTTON_WITH_RENDER)) {
    const props = match[1]
    if (!/render=\{<Link\b/.test(props)) continue
    const href = /href=\{?["`]?([^"`}\s]+)/.exec(props)?.[1] ?? "(dynamic)"
    found.push(href)
  }
  return found
}

describe("a control that navigates is a link, not a button wearing an href", () => {
  test("no call site routes a Link through the Button primitive", () => {
    const files = [...listTsx("components"), ...listTsx("app")].filter(
      (file) => !file.includes(".test.")
    )

    expect(files.length).toBeGreaterThan(0)

    const offenders = files.flatMap((file) => {
      const source = readFileSync(path.join(projectRoot, file), "utf8")
      return offendersIn(source).map((href) => `${file} -> ${href}`)
    })

    expect(
      offenders,
      'these navigate through Button — use <Link data-slot="button" ' +
        "className={buttonVariants(…)}> so the role stays `link`"
    ).toEqual([])
  })

  test("the scan recognises both forms, so it cannot pass by finding nothing", () => {
    // A guard on the guard: a regex that matched neither shape would report an empty
    // offender list forever, which reads exactly like success.
    const bad = `<Button variant="outline" render={<Link href="/x" />}>Go</Button>`
    // `nativeButton={false}` is NOT a pass: it silences Base UI's error by announcing
    // the anchor as a button, which is the defect rather than the fix.
    const alsoBad = `<Button nativeButton={false} render={<Link href="/x" />}>Go</Button>`
    const good = `<Link data-slot="button" href="/x" className={buttonVariants()}>Go</Link>`
    const unrelated = `<Button onClick={fn}>Go</Button>`

    expect(offendersIn(bad)).toEqual(["/x"])
    expect(offendersIn(alsoBad)).toEqual(["/x"])
    expect(offendersIn(good)).toEqual([])
    expect(offendersIn(unrelated)).toEqual([])
  })
})
