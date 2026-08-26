import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { describe, expect, test } from "vitest"

import { MESSAGE_ID_PATTERN, isMessageId } from "@/lib/messages/catalog"

/**
 * The message-literal guard for `app/components/reports/**` (Requirement 15.6, 15.9).
 *
 * ## Two complementary scans, each catching what the other cannot
 *
 * ### Scan 1 — Id-resolution guard (task 6.7)
 *
 * A regex-based static scan that catches id-shaped constants emitted raw
 * (not through `messageText()`). It ensures every already-migrated id is
 * resolved, not inlined.
 *
 * ### Scan 2 — Literal-detection guard (task 6.5)
 *
 * A TypeScript AST parse over `app/components/reports/` (recursive `.tsx`), using
 * `ts.createSourceFile`. It flags:
 *
 * - Every `ts.JsxText` node with non-whitespace content
 * - Every string literal inside a `ts.JsxExpression` that is a JSX **child**
 *   (not an attribute value)
 * - Every string literal assigned to `aria-label`, `title`, `alt` or
 *   `placeholder` attributes
 *
 * It does NOT flag: `className`, `data-*`, element or attribute names, or any
 * string that is a declared message id resolved via `messageText()`.
 *
 * An offender is any flagged literal that is not itself a declared string id.
 *
 * ## What neither guard can do
 *
 * A literal reaching a text position through a variable defined in another module
 * escapes both. It is a lint with a closure property, not a proof — the closure
 * being that within the scanned modules the catalog resolver is the only way to
 * obtain a string for those positions, and that task 6.4's self-guard stops the
 * declared site set from silently shrinking.
 */

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const REPORTS_DIR = path.join(appRoot, "components", "reports")
const SCAN_DIR = path.join(appRoot, "components", "scan")

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Recursively collect all .tsx files under a directory. */
function collectTsxFiles(dir: string): string[] {
  const results: string[] = []
  if (!existsSync(dir)) return results
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    const stat = statSync(full)
    if (stat.isDirectory()) {
      results.push(...collectTsxFiles(full))
    } else if (entry.endsWith(".tsx") && !entry.includes(".test.")) {
      results.push(full)
    }
  }
  return results.sort()
}

/** Extract const declarations whose value is a message id. */
function extractIdConstants(source: string): Map<string, string> {
  const constants = new Map<string, string>()
  // Match: const NAME = "ui.something.something" or similar with message-id pattern
  // Also matches: const NAME: MessageId = "ui.something"
  const constPattern =
    /(?:const|let)\s+([A-Z_][A-Z_0-9]*)\s*(?::\s*\w+)?\s*=\s*"([^"]+)"/g
  for (const match of source.matchAll(constPattern)) {
    const name = match[1]
    const value = match[2]
    if (MESSAGE_ID_PATTERN.test(value)) {
      constants.set(name, value)
    }
  }
  return constants
}

/**
 * Find references to an id-constant that are NOT inside a `messageText(NAME` call.
 *
 * The rule: every reference to an id-shaped constant must appear only as the first
 * argument to `messageText(`. Any other position is an offender.
 */
function findUnresolvedReferences(
  source: string,
  constantName: string
): { line: number; context: string }[] {
  const offenders: { line: number; context: string }[] = []
  const lines = source.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip the declaration line itself
    if (
      line.includes(`const ${constantName}`) ||
      line.includes(`let ${constantName}`)
    ) {
      continue
    }
    // Skip import lines
    if (line.trimStart().startsWith("import")) continue
    // Skip comment lines
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) {
      continue
    }

    // Find all occurrences of the constant name as a word boundary
    const namePattern = new RegExp(`\\b${constantName}\\b`, "g")
    for (const match of line.matchAll(namePattern)) {
      const idx = match.index
      // Check if this is the first argument to messageText(
      // Look backwards from the match to find `messageText(`
      const before = line.slice(0, idx).trimEnd()
      const isResolvedCall =
        before.endsWith("messageText(") ||
        before.endsWith("messageText(\n") ||
        // Multi-line: the constant is on a new line after messageText(
        // For this we check the preceding non-whitespace
        /messageText\(\s*$/.test(before) ||
        // Nested: the constant is inside a messageText() call as one of its arguments
        // e.g. messageText("id", lang, { key: messageText(CONST, ...)})
        // or messageText(cond ? CONST : OTHER, ...)
        /messageText\([^)]*$/.test(before)

      if (!isResolvedCall) {
        offenders.push({
          line: i + 1,
          context: line.trim().slice(0, 120),
        })
        break // One offender per line is enough
      }
    }
  }

  return offenders
}

/**
 * Find string literals that look like message ids but are used raw (not via a const).
 * These are inline literal ids that should have been extracted to a const.
 */
function findInlineLiteralIds(source: string): { line: number; id: string }[] {
  const offenders: { line: number; id: string }[] = []
  const lines = source.split("\n")

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // Skip comments and imports
    if (line.trimStart().startsWith("//") || line.trimStart().startsWith("*")) {
      continue
    }
    if (line.trimStart().startsWith("import")) continue

    // Find string literals matching the id pattern that are NOT:
    // 1. In a const declaration (already covered above)
    // 2. The first argument to messageText(
    // 3. In a type annotation or type assertion
    const literalPattern = /"((?:ui|doc|chart)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)"/g
    for (const match of line.matchAll(literalPattern)) {
      const id = match[1]
      const idx = match.index

      // Skip if it's a const declaration
      if (/(?:const|let)\s+\w+\s*(?::\s*\w+)?\s*=\s*$/.test(line.slice(0, idx))) {
        continue
      }

      // Skip if it's the first argument to messageText(
      const before = line.slice(0, idx).trimEnd()
      if (
        before.endsWith("messageText(") ||
        /messageText\(\s*$/.test(before)
      ) {
        continue
      }

      // Skip if it's in a Record/object key position (like GAP_TYPE_COPY_IDS)
      if (/:\s*\{?\s*$/.test(line.slice(idx + match[0].length))) continue
      // Skip object property values in type-like structures
      if (before.endsWith("labelId:") || before.endsWith("noteId:")) continue

      offenders.push({ line: i + 1, id })
    }
  }

  return offenders
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("message-literal guard: app/components/reports/**", () => {
  const files = collectTsxFiles(REPORTS_DIR)

  test("the scan is not vacuous", () => {
    expect(
      files.length,
      "no .tsx files found under app/components/reports/"
    ).toBeGreaterThan(0)
  })

  test("every id-shaped constant is used only via messageText() resolution", () => {
    const allOffenders: {
      file: string
      constant: string
      references: { line: number; context: string }[]
    }[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const constants = extractIdConstants(source)

      for (const [name] of constants) {
        const unresolved = findUnresolvedReferences(source, name)
        if (unresolved.length > 0) {
          allOffenders.push({
            file: path.relative(appRoot, file),
            constant: name,
            references: unresolved,
          })
        }
      }
    }

    if (allOffenders.length > 0) {
      const report = allOffenders
        .map(
          (o) =>
            `  ${o.file}: ${o.constant} used outside messageText() at:\n` +
            o.references
              .map((r) => `    line ${r.line}: ${r.context}`)
              .join("\n")
        )
        .join("\n")

      expect.fail(
        `${allOffenders.length} id-constant(s) referenced outside messageText() resolution:\n${report}\n\n` +
          "The rule: an id-shaped constant must appear ONLY as the first argument to " +
          "messageText(id, language). Using it in a template literal, JSX child, or " +
          "any other position emits the raw id string rather than its resolved copy."
      )
    }
  })

  test("no inline message-id literal is used outside messageText() or a const declaration", () => {
    const allOffenders: {
      file: string
      occurrences: { line: number; id: string }[]
    }[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const inlineIds = findInlineLiteralIds(source)
      if (inlineIds.length > 0) {
        allOffenders.push({
          file: path.relative(appRoot, file),
          occurrences: inlineIds,
        })
      }
    }

    if (allOffenders.length > 0) {
      const report = allOffenders
        .map(
          (o) =>
            `  ${o.file}:\n` +
            o.occurrences
              .map((occ) => `    line ${occ.line}: "${occ.id}"`)
              .join("\n")
        )
        .join("\n")

      expect.fail(
        `${allOffenders.length} file(s) use inline message-id literals outside resolution:\n${report}\n\n` +
          "Extract the id to a const and resolve it via messageText()."
      )
    }
  })

  test("every id-constant's value is a declared catalog entry", () => {
    const undeclared: { file: string; constant: string; value: string }[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const constants = extractIdConstants(source)

      for (const [name, value] of constants) {
        if (!isMessageId(value)) {
          undeclared.push({
            file: path.relative(appRoot, file),
            constant: name,
            value,
          })
        }
      }
    }

    if (undeclared.length > 0) {
      const report = undeclared
        .map((u) => `  ${u.file}: ${u.constant} = "${u.value}"`)
        .join("\n")

      expect.fail(
        `${undeclared.length} id-constant(s) refer to undeclared catalog entries:\n${report}\n\n` +
          "Add the id to app/lib/messages/catalog.ts (and the agent's catalog.v1.json)."
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Scan 2: Literal-detection guard (task 6.5)
// ---------------------------------------------------------------------------
// Uses TypeScript AST (`ts.createSourceFile`) to flag raw English strings that
// were never migrated into the message catalog.

/** Attributes whose string values ARE user-facing copy (flag them). */
const USER_FACING_ATTRS = new Set(["aria-label", "title", "alt", "placeholder"])

/** Attributes that are never user-facing copy (skip them). */
const STRUCTURAL_ATTRS = new Set([
  "className",
  "id",
  "htmlFor",
  "role",
  "type",
  "key",
  "href",
  "src",
  "rel",
  "name",
  "method",
  "action",
  "target",
  "autoComplete",
  "inputMode",
  "crossOrigin",
  "as",
  "sizes",
  "media",
  "integrity",
  "referrerPolicy",
  "loading",
  "decoding",
  "fetchPriority",
  "slot",
  "tabIndex",
  "style",
  "variant",
  "weight",
  "size",
])

/** True if a string is purely whitespace, a number/symbol, or trivially non-copy. */
function isTrivial(text: string): boolean {
  const trimmed = text.trim()
  if (trimmed === "") return true
  // Pure punctuation, operators, or single special chars
  if (/^[·—–…\-+×÷=<>|/\\{}[\](),.;:!?@#$%^&*`~'"0-9\s]+$/.test(trimmed)) return true
  // Very short fragments that are structural: things like " / ", " · ", " — "
  if (trimmed.length <= 3 && !/[a-zA-Z]{2,}/.test(trimmed)) return true
  return false
}

/** True if this is a `data-*` attribute name. */
function isDataAttr(name: string): boolean {
  return /^data[A-Z-]/.test(name) || name.startsWith("data-")
}

type LiteralOffender = {
  line: number
  text: string
  kind: "jsx-text" | "jsx-child-expr" | "user-facing-attr"
}

/**
 * Walk a TypeScript AST and find unmigrated literals.
 */
function detectUnmigratedLiterals(source: string, filePath: string): LiteralOffender[] {
  const sf = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TSX
  )

  const offenders: LiteralOffender[] = []

  function getLine(node: ts.Node): number {
    return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
  }

  /**
   * Is this node inside a `messageText(...)` call, meaning it's already resolved?
   */
  function isInsideMessageTextCall(node: ts.Node): boolean {
    let current: ts.Node | undefined = node.parent
    while (current) {
      if (
        ts.isCallExpression(current) &&
        ts.isIdentifier(current.expression) &&
        current.expression.text === "messageText"
      ) {
        return true
      }
      // Also check property access like `obj.messageText(...)`
      if (
        ts.isCallExpression(current) &&
        ts.isPropertyAccessExpression(current.expression) &&
        current.expression.name.text === "messageText"
      ) {
        return true
      }
      current = current.parent
    }
    return false
  }

  /**
   * Is this node's value a reference to a const that holds a message id?
   * (Already handled by scan 1 — skip here to avoid double-counting.)
   */
  function isIdConstReference(node: ts.Node): boolean {
    if (ts.isIdentifier(node)) {
      // We can't easily resolve the const's value from pure AST, but
      // if it matches the naming pattern of our id constants (ALL_CAPS),
      // and it's used inside messageText, it's fine.
      return /^[A-Z_][A-Z_0-9]+$/.test(node.text)
    }
    return false
  }

  function visit(node: ts.Node): void {
    // 1. JsxText — any non-whitespace text content in JSX
    if (ts.isJsxText(node)) {
      const text = node.text
      if (!isTrivial(text)) {
        offenders.push({
          line: getLine(node),
          text: text.trim().slice(0, 80),
          kind: "jsx-text",
        })
      }
    }

    // 2. String literal inside a JsxExpression that is a JSX CHILD
    if (ts.isJsxExpression(node) && node.expression) {
      const parent = node.parent
      const isChild =
        parent &&
        (ts.isJsxElement(parent) || ts.isJsxFragment(parent))

      if (isChild) {
        // Check if the expression is a plain string literal
        if (ts.isStringLiteral(node.expression)) {
          const val = node.expression.text
          if (!isTrivial(val) && !isMessageId(val) && !isInsideMessageTextCall(node)) {
            offenders.push({
              line: getLine(node),
              text: val.slice(0, 80),
              kind: "jsx-child-expr",
            })
          }
        }
        // Template literal in child position
        if (ts.isTemplateExpression(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression)) {
          const fullText = node.expression.getText(sf)
          // Only flag if it contains English words
          if (/[a-zA-Z]{2,}/.test(fullText) && !isInsideMessageTextCall(node)) {
            offenders.push({
              line: getLine(node),
              text: fullText.slice(0, 80),
              kind: "jsx-child-expr",
            })
          }
        }
      }
    }

    // 3. String literal assigned to user-facing attributes
    if (ts.isJsxAttribute(node)) {
      const attrName = node.name.getText(sf)

      // Skip structural/non-copy attributes
      if (STRUCTURAL_ATTRS.has(attrName) || isDataAttr(attrName)) {
        return // Don't recurse into children
      }

      if (USER_FACING_ATTRS.has(attrName) && node.initializer) {
        if (ts.isStringLiteral(node.initializer)) {
          const val = node.initializer.text
          if (!isTrivial(val) && !isMessageId(val)) {
            offenders.push({
              line: getLine(node),
              text: val.slice(0, 80),
              kind: "user-facing-attr",
            })
          }
        }
        // JsxExpression with a string literal
        if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
          if (ts.isStringLiteral(node.initializer.expression)) {
            const val = node.initializer.expression.text
            if (!isTrivial(val) && !isMessageId(val) && !isInsideMessageTextCall(node.initializer)) {
              offenders.push({
                line: getLine(node),
                text: val.slice(0, 80),
                kind: "user-facing-attr",
              })
            }
          }
        }
      }
    }

    ts.forEachChild(node, visit)
  }

  visit(sf)
  return offenders
}

describe("literal-detection guard: app/components/reports/** (task 6.5)", () => {
  const files = collectTsxFiles(REPORTS_DIR)

  test("the scan is not vacuous — files exist and are parseable", () => {
    expect(
      files.length,
      "no .tsx files found under app/components/reports/"
    ).toBeGreaterThan(0)

    // Confirm at least one file parses without error
    const source = readFileSync(files[0], "utf8")
    const sf = ts.createSourceFile(
      files[0],
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    expect(sf.statements.length).toBeGreaterThan(0)
  })

  test("no unmigrated English literal in a text-emitting position", () => {
    const allOffenders: {
      file: string
      literals: LiteralOffender[]
    }[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const literals = detectUnmigratedLiterals(source, file)
      if (literals.length > 0) {
        allOffenders.push({
          file: path.relative(appRoot, file),
          literals,
        })
      }
    }

    if (allOffenders.length > 0) {
      const totalCount = allOffenders.reduce((sum, o) => sum + o.literals.length, 0)
      const report = allOffenders
        .map(
          (o) =>
            `  ${o.file} (${o.literals.length}):\n` +
            o.literals
              .map((l) => `    line ${l.line} [${l.kind}]: "${l.text}"`)
              .join("\n")
        )
        .join("\n")

      expect.fail(
        `${totalCount} unmigrated literal(s) across ${allOffenders.length} file(s):\n${report}\n\n` +
          "Migrate each literal to a ui.* catalog id resolved via messageText()."
      )
    }
  })
})

// ---------------------------------------------------------------------------
// Scan roots extended to app/components/scan/** (task 1.7)
// ---------------------------------------------------------------------------
// Both guards apply: scan components use the same catalog pattern and must not
// contain raw English literals in text positions or unresolved id-shaped constants.

describe("message-literal guard: app/components/scan/**", () => {
  const files = collectTsxFiles(SCAN_DIR)

  test("the scan is not vacuous", () => {
    expect(
      files.length,
      "no .tsx files found under app/components/scan/"
    ).toBeGreaterThan(0)
  })

  test("every id-shaped constant is used only via messageText() resolution", () => {
    const allOffenders: {
      file: string
      constant: string
      references: { line: number; context: string }[]
    }[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const constants = extractIdConstants(source)

      for (const [name] of constants) {
        const unresolved = findUnresolvedReferences(source, name)
        if (unresolved.length > 0) {
          allOffenders.push({
            file: path.relative(appRoot, file),
            constant: name,
            references: unresolved,
          })
        }
      }
    }

    if (allOffenders.length > 0) {
      const report = allOffenders
        .map(
          (o) =>
            `  ${o.file}: ${o.constant} used outside messageText() at:\n` +
            o.references
              .map((r) => `    line ${r.line}: ${r.context}`)
              .join("\n")
        )
        .join("\n")

      expect.fail(
        `${allOffenders.length} id-constant(s) referenced outside messageText() resolution:\n${report}\n\n` +
          "The rule: an id-shaped constant must appear ONLY as the first argument to " +
          "messageText(id, language). Using it in a template literal, JSX child, or " +
          "any other position emits the raw id string rather than its resolved copy."
      )
    }
  })

  test("no inline message-id literal is used outside messageText() or a const declaration", () => {
    const allOffenders: {
      file: string
      occurrences: { line: number; id: string }[]
    }[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const inlineIds = findInlineLiteralIds(source)
      if (inlineIds.length > 0) {
        allOffenders.push({
          file: path.relative(appRoot, file),
          occurrences: inlineIds,
        })
      }
    }

    if (allOffenders.length > 0) {
      const report = allOffenders
        .map(
          (o) =>
            `  ${o.file}:\n` +
            o.occurrences
              .map((occ) => `    line ${occ.line}: "${occ.id}"`)
              .join("\n")
        )
        .join("\n")

      expect.fail(
        `${allOffenders.length} file(s) use inline message-id literals outside resolution:\n${report}\n\n` +
          "Extract the id to a const and resolve it via messageText()."
      )
    }
  })

  test("every id-constant's value is a declared catalog entry", () => {
    const undeclared: { file: string; constant: string; value: string }[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const constants = extractIdConstants(source)

      for (const [name, value] of constants) {
        if (!isMessageId(value)) {
          undeclared.push({
            file: path.relative(appRoot, file),
            constant: name,
            value,
          })
        }
      }
    }

    if (undeclared.length > 0) {
      const report = undeclared
        .map((u) => `  ${u.file}: ${u.constant} = "${u.value}"`)
        .join("\n")

      expect.fail(
        `${undeclared.length} id-constant(s) refer to undeclared catalog entries:\n${report}\n\n` +
          "Add the id to app/lib/messages/catalog.ts (and the agent's catalog.v1.json)."
      )
    }
  })
})

describe("literal-detection guard: app/components/scan/** (task 1.7)", () => {
  const files = collectTsxFiles(SCAN_DIR)

  test("the scan is not vacuous — files exist and are parseable", () => {
    expect(
      files.length,
      "no .tsx files found under app/components/scan/"
    ).toBeGreaterThan(0)

    // Confirm at least one file parses without error
    const source = readFileSync(files[0], "utf8")
    const sf = ts.createSourceFile(
      files[0],
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TSX
    )
    expect(sf.statements.length).toBeGreaterThan(0)
  })

  test("no unmigrated English literal in a text-emitting position", () => {
    const allOffenders: {
      file: string
      literals: LiteralOffender[]
    }[] = []

    for (const file of files) {
      const source = readFileSync(file, "utf8")
      const literals = detectUnmigratedLiterals(source, file)
      if (literals.length > 0) {
        allOffenders.push({
          file: path.relative(appRoot, file),
          literals,
        })
      }
    }

    if (allOffenders.length > 0) {
      const totalCount = allOffenders.reduce((sum, o) => sum + o.literals.length, 0)
      const report = allOffenders
        .map(
          (o) =>
            `  ${o.file} (${o.literals.length}):\n` +
            o.literals
              .map((l) => `    line ${l.line} [${l.kind}]: "${l.text}"`)
              .join("\n")
        )
        .join("\n")

      expect.fail(
        `${totalCount} unmigrated literal(s) across ${allOffenders.length} file(s):\n${report}\n\n` +
          "Migrate each literal to a ui.* catalog id resolved via messageText()."
      )
    }
  })
})
