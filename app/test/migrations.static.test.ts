import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { describe, expect, test } from "vitest"
import { z } from "zod"

/**
 * The additive-migration guard (Req 9.5, 36.8).
 *
 * `lib/db/schema.ts` is the single source of truth and drizzle-kit generates the
 * SQL (Req 9.4). This suite reads that generated SQL from disk and refuses any
 * migration that **takes something away**: a `DROP` of a table, of a column, or
 * of an enum type that an earlier migration created. `report_runs` and the rows
 * around it are the audit trail for delivered documents, so the schema may only
 * grow (Req 36.8), and Postgres enums may only gain values — which makes a
 * `DROP TYPE` of a committed enum the same violation one level up.
 *
 * Static, like `boundaries.static.test.ts`: file text only, no database, no
 * skips. Paths resolve from this file rather than the working directory, so the
 * suite reads the same repository however Vitest was invoked.
 *
 * Two design notes worth stating, because they are the difference between a
 * guard and the appearance of one:
 *
 * **It fails on an empty scan.** With no migrations directory, or a directory
 * holding no `.sql` files, the real scan can never find a violation and would
 * report a clean pass over nothing. `readMigrationFiles` asserts a non-empty
 * set, the same rule the Boundary_Guard applies to its own scans (Req 6.11).
 *
 * **The detector is exercised against SQL that must fail it.** One committed
 * migration cannot violate an additive rule — there is nothing earlier for it to
 * remove — so a green suite here proves nothing on its own. The cases under
 * "the detector is not vacuous" run the same parser over fabricated *later*
 * migrations that drop what `0000` created, and assert it catches each of them.
 * Those fixtures live in this file as strings and are never written into
 * `lib/db/migrations/`, so the repository's real migration set stays exactly
 * what drizzle-kit generated.
 */

// --- Locating the committed migrations -------------------------------------

/** `app/`, resolved from this file, not from the cwd. */
const APP_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
)

const MIGRATIONS_DIR = "lib/db/migrations"
const JOURNAL_PATH = `${MIGRATIONS_DIR}/meta/_journal.json`

interface MigrationFile {
  readonly name: string
  readonly sql: string
}

/**
 * Every `.sql` file in `lib/db/migrations`, in applied order.
 *
 * Lexical order over code units *is* the applied order: drizzle-kit's
 * zero-padded `NNNN_name.sql` makes lexical and numeric order the same thing,
 * and comparing code units rather than a locale collation keeps that true on
 * every machine. The journal test below asserts that agreement against
 * `meta/_journal.json` rather than assuming it.
 */
function readMigrationFiles(): readonly MigrationFile[] {
  const dir = path.join(APP_ROOT, MIGRATIONS_DIR)

  expect(
    existsSync(dir) && statSync(dir).isDirectory(),
    `${MIGRATIONS_DIR} is missing from ${APP_ROOT}. Generate it from ` +
      `lib/db/schema.ts with \`pnpm db:generate\`; a guard that scans nothing ` +
      `passes while proving nothing (Req 6.11).`
  ).toBe(true)

  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".sql"))
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
    .map((name) => ({
      name,
      sql: readFileSync(path.join(dir, name), "utf8"),
    }))

  expect(
    files.length,
    `${MIGRATIONS_DIR} holds no .sql files, so this guard would pass by ` +
      `scanning nothing. Generate them with \`pnpm db:generate\`.`
  ).toBeGreaterThan(0)

  return files
}

/** drizzle-kit's journal, the record of which files it considers migrations. */
const JOURNAL_SCHEMA = z.object({
  entries: z.array(z.object({ idx: z.number().int(), tag: z.string().min(1) })),
})

/** The journal's file names, ordered by `idx`. */
function readJournalFileNames(): readonly string[] {
  const journal = path.join(APP_ROOT, JOURNAL_PATH)

  expect(existsSync(journal), `${JOURNAL_PATH} is missing`).toBe(true)

  return JOURNAL_SCHEMA.parse(JSON.parse(readFileSync(journal, "utf8")))
    .entries.slice()
    .sort((left, right) => left.idx - right.idx)
    .map((entry) => `${entry.tag}.sql`)
}

// --- A minimal SQL scanner -------------------------------------------------

interface Statement {
  /** The statement with every comment removed. */
  readonly sql: string
  /** 1-based line of the statement's first non-blank character. */
  readonly line: number
}

/** `$$` or `$tag$`, opening a dollar-quoted body. */
const DOLLAR_QUOTE = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/

/**
 * Index just past the quoted run beginning at `index`, which must be `'` or `"`.
 * A doubled quote is an escaped quote and stays inside the run; an unterminated
 * run ends at the end of the text. That is the standard-conforming form
 * drizzle-kit emits.
 */
function skipQuoted(text: string, index: number): number {
  const quote = text[index]
  let cursor = index + 1

  while (cursor < text.length) {
    if (text[cursor] === quote) {
      if (text[cursor + 1] === quote) {
        cursor += 2
        continue
      }
      return cursor + 1
    }
    cursor += 1
  }
  return text.length
}

function countLines(text: string): number {
  let count = 0
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\n") count += 1
  }
  return count
}

/**
 * Split one migration file into comment-free statements.
 *
 * Comments come out first, and that ordering is the point: a `DROP TABLE` inside
 * a line comment or a block comment is not a schema change, and a guard that
 * flagged it would be a guard people learn to ignore.
 *
 * The scan is quote-aware rather than a set of regexes over raw text, for two
 * reasons that are the same reason twice — a delimiter only means what it says
 * outside a literal:
 *
 *   * `'--'` in a `DEFAULT` must not start a comment that swallows the rest of
 *     the line, which is where a naive stripper produces a **false negative**;
 *   * `;` inside a literal, a quoted identifier or a `$$` body is not a
 *     statement boundary, and a statement cut in half mis-attributes a
 *     `DROP COLUMN` to whichever `ALTER TABLE` happens to precede it.
 *
 * Splitting on `;` as well as on comments means drizzle-kit's
 * `--> statement-breakpoint` needs no special case: it is a `--` comment, so
 * comment removal handles it, and every generated statement ends in `;` anyway.
 * Hand-written fixtures separated only by `;` therefore parse identically to
 * generated files — which is what lets the synthetic cases below exercise this
 * same code path.
 */
function scanStatements(sql: string): readonly Statement[] {
  const statements: Statement[] = []

  let buffer = ""
  let line = 1
  let statementLine = 1
  let started = false
  let index = 0

  function append(text: string): void {
    if (!started && text.trim().length > 0) {
      started = true
      statementLine = line
    }
    buffer += text
  }

  function flush(): void {
    const text = buffer.trim()
    if (text.length > 0) statements.push({ sql: text, line: statementLine })
    buffer = ""
    started = false
  }

  while (index < sql.length) {
    const char = sql[index]

    if (char === "-" && sql[index + 1] === "-") {
      // Stops *at* the newline, so the general branch below counts the line.
      while (index < sql.length && sql[index] !== "\n") index += 1
      // A space, so `DROP/* x */TABLE` does not become `DROPTABLE`.
      append(" ")
      continue
    }

    if (char === "/" && sql[index + 1] === "*") {
      let depth = 0
      while (index < sql.length) {
        if (sql[index] === "/" && sql[index + 1] === "*") {
          depth += 1
          index += 2
          continue
        }
        if (sql[index] === "*" && sql[index + 1] === "/") {
          depth -= 1
          index += 2
          if (depth === 0) break
          continue
        }
        if (sql[index] === "\n") line += 1
        index += 1
      }
      append(" ")
      continue
    }

    if (char === "'" || char === '"') {
      const stop = skipQuoted(sql, index)
      const body = sql.slice(index, stop)
      append(body)
      line += countLines(body)
      index = stop
      continue
    }

    if (char === "$") {
      const opening = DOLLAR_QUOTE.exec(sql.slice(index))
      if (opening !== null) {
        const tag = opening[0]
        const closing = sql.indexOf(tag, index + tag.length)
        const stop = closing === -1 ? sql.length : closing + tag.length
        const body = sql.slice(index, stop)
        append(body)
        line += countLines(body)
        index = stop
        continue
      }
    }

    if (char === ";") {
      flush()
      index += 1
      continue
    }

    if (char === "\n") line += 1
    append(char)
    index += 1
  }

  flush()
  return statements
}

// --- Identifiers -----------------------------------------------------------

/** A quoted or a bare SQL identifier. */
const IDENTIFIER = String.raw`(?:"(?:[^"]|"")*"|[A-Za-z_][A-Za-z0-9_$]*)`

/** `name`, `schema.name`, `"public"."name"`. */
const QUALIFIED_NAME = String.raw`${IDENTIFIER}(?:\s*\.\s*${IDENTIFIER})*`

/**
 * The object's own name, with any schema qualifier dropped and Postgres'
 * case-folding applied: a bare identifier folds to lower case, a quoted one
 * keeps exactly what it says.
 */
function bareName(qualified: string): string {
  const tokens = qualified.match(new RegExp(IDENTIFIER, "g")) ?? []
  const last = tokens.length === 0 ? qualified : tokens[tokens.length - 1]

  return last.startsWith('"')
    ? last.slice(1, -1).replace(/""/g, '"')
    : last.toLowerCase()
}

/**
 * Words that follow `ADD` or `DROP` in an `ALTER TABLE`, or open an item in a
 * `CREATE TABLE` body, without naming a column.
 *
 * `ALTER TABLE … DROP CONSTRAINT` and `ALTER COLUMN … DROP DEFAULT` are not
 * column removals, and drizzle-kit emits both legitimately when a constraint or
 * a default changes. Checked only for *unquoted* tokens, so a column that is
 * genuinely named `"check"` is still recognised as a column.
 */
const NOT_A_COLUMN_NAME = new Set([
  "cascade",
  "check",
  "constraint",
  "default",
  "exclude",
  "expression",
  "foreign",
  "generated",
  "identity",
  "if",
  "index",
  "like",
  "not",
  "null",
  "primary",
  "restrict",
  "table",
  "type",
  "unique",
])

/** The column this token names, or undefined when it names something else. */
function columnNameOf(token: string): string | undefined {
  if (token.startsWith('"')) return bareName(token)

  const folded = token.toLowerCase()
  return NOT_A_COLUMN_NAME.has(folded) ? undefined : folded
}

// --- Statement shapes ------------------------------------------------------

const CREATE_TABLE = new RegExp(
  String.raw`^CREATE\s+(?:(?:GLOBAL|LOCAL)\s+)?` +
    String.raw`(?:(?:TEMP|TEMPORARY|UNLOGGED)\s+)?TABLE\s+` +
    String.raw`(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED_NAME})\s*\(`,
  "i"
)

/**
 * A lookahead rather than `\b`: the name ends in `"` for a quoted identifier and
 * a quote is not a word character, so `\b` would never hold after
 * `CREATE TYPE "public"."run_status"` — the enum would go unregistered and its
 * later `DROP TYPE` would read as dropping something never created.
 */
const CREATE_TYPE = new RegExp(
  String.raw`^CREATE\s+TYPE\s+(${QUALIFIED_NAME})(?=\s|$)`,
  "i"
)

const ALTER_TABLE = new RegExp(
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?` +
    String.raw`(${QUALIFIED_NAME})\s+([\s\S]+)$`,
  "i"
)

const DROP_TABLE = new RegExp(
  String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$`,
  "i"
)

const DROP_TYPE = new RegExp(
  String.raw`^DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?([\s\S]+)$`,
  "i"
)

const ADD_COLUMN = new RegExp(
  String.raw`\bADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(${IDENTIFIER})`,
  "gi"
)

/** `COLUMN` is optional in Postgres, so `DROP "x"` drops a column too. */
const DROP_COLUMN = new RegExp(
  String.raw`\bDROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${IDENTIFIER})`,
  "gi"
)

const LEADING_IDENTIFIER = new RegExp(String.raw`^(${IDENTIFIER})`)

/** The text between the parenthesis at `openIndex` and its match. */
function balancedBody(sql: string, openIndex: number): string {
  let depth = 0
  let index = openIndex

  while (index < sql.length) {
    const char = sql[index]

    if (char === "'" || char === '"') {
      index = skipQuoted(sql, index)
      continue
    }
    if (char === "(") {
      depth += 1
      index += 1
      continue
    }
    if (char === ")") {
      depth -= 1
      index += 1
      if (depth === 0) return sql.slice(openIndex + 1, index - 1)
      continue
    }
    index += 1
  }
  return sql.slice(openIndex + 1)
}

/**
 * Single-quoted literals emptied out; quoted identifiers left alone, because
 * they carry the names this scan is looking for.
 *
 * Applied to an `ALTER TABLE`'s action list before the `ADD`/`DROP` sweep below.
 * Without it, `ADD COLUMN "note" text DEFAULT 'x; DROP TABLE "report_runs"'`
 * reads as a column removal — a **false positive** on a migration that removes
 * nothing, which is the mirror image of the false negative the scanner's
 * quote-awareness prevents.
 */
function withoutLiterals(text: string): string {
  let out = ""
  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (char === "'") {
      index = skipQuoted(text, index)
      out += "''"
      continue
    }
    if (char === '"') {
      const stop = skipQuoted(text, index)
      out += text.slice(index, stop)
      index = stop
      continue
    }
    out += char
    index += 1
  }
  return out
}

/** Comma-separated items at paren depth zero, outside quotes. */
function splitTopLevel(text: string): readonly string[] {
  const items: string[] = []
  let current = ""
  let depth = 0
  let index = 0

  while (index < text.length) {
    const char = text[index]

    if (char === "'" || char === '"') {
      const stop = skipQuoted(text, index)
      current += text.slice(index, stop)
      index = stop
      continue
    }
    if (char === "(") depth += 1
    if (char === ")") depth -= 1
    if (char === "," && depth === 0) {
      items.push(current)
      current = ""
      index += 1
      continue
    }
    current += char
    index += 1
  }
  items.push(current)

  return items.map((item) => item.trim()).filter((item) => item.length > 0)
}

/** The leading qualified name of each comma-separated item in a `DROP` list. */
function droppedNames(list: string): readonly string[] {
  const leading = new RegExp(String.raw`^(${QUALIFIED_NAME})`)

  return splitTopLevel(list)
    .map((item) => leading.exec(item))
    .filter((matched): matched is RegExpExecArray => matched !== null)
    .map((matched) => bareName(matched[1]))
}

// --- The additive rule -----------------------------------------------------

type DroppedKind = "table" | "column" | "type"

interface Dropped {
  readonly kind: DroppedKind
  /** `table` for a table or a type, `table.column` for a column. */
  readonly object: string
  /** The lookup key into the accumulated creations. */
  readonly key: string
  /** For a column, the table it belongs to, so a known table still counts. */
  readonly table?: string
}

interface Violation extends Dropped {
  readonly migration: string
  readonly line: number
  /** The earlier migration that created the object, when there is one. */
  readonly createdBy?: string
}

/** Creations keyed by object, valued by the migration that made them. */
interface Created {
  readonly tables: Map<string, string>
  /** Keyed `table\u0000column`. */
  readonly columns: Map<string, string>
  readonly types: Map<string, string>
}

function emptyCreated(): Created {
  return { tables: new Map(), columns: new Map(), types: new Map() }
}

function columnKey(table: string, column: string): string {
  return `${table}\u0000${column}`
}

/** Everything one statement creates, appended to `into`. */
function collectCreations(statement: Statement, into: Created): void {
  const { sql } = statement

  const createdType = CREATE_TYPE.exec(sql)
  if (createdType !== null) {
    into.types.set(bareName(createdType[1]), "")
    return
  }

  const createdTable = CREATE_TABLE.exec(sql)
  if (createdTable !== null) {
    const table = bareName(createdTable[1])
    into.tables.set(table, "")

    const openIndex = createdTable.index + createdTable[0].length - 1
    for (const item of splitTopLevel(balancedBody(sql, openIndex))) {
      const leading = LEADING_IDENTIFIER.exec(item)
      if (leading === null) continue

      const column = columnNameOf(leading[1])
      if (column !== undefined) into.columns.set(columnKey(table, column), "")
    }
    return
  }

  const altered = ALTER_TABLE.exec(sql)
  if (altered === null) return

  const table = bareName(altered[1])
  const actions = withoutLiterals(altered[2])

  ADD_COLUMN.lastIndex = 0
  for (
    let matched = ADD_COLUMN.exec(actions);
    matched !== null;
    matched = ADD_COLUMN.exec(actions)
  ) {
    const column = columnNameOf(matched[1])
    if (column !== undefined) into.columns.set(columnKey(table, column), "")
  }
}

/** Everything one statement drops, whether or not it was ever created. */
function collectDrops(statement: Statement): readonly Dropped[] {
  const { sql } = statement

  const droppedType = DROP_TYPE.exec(sql)
  if (droppedType !== null) {
    return droppedNames(droppedType[1]).map((name) => ({
      kind: "type" as const,
      object: name,
      key: name,
    }))
  }

  const droppedTable = DROP_TABLE.exec(sql)
  if (droppedTable !== null) {
    return droppedNames(droppedTable[1]).map((name) => ({
      kind: "table" as const,
      object: name,
      key: name,
    }))
  }

  const altered = ALTER_TABLE.exec(sql)
  if (altered === null) return []

  const table = bareName(altered[1])
  const actions = withoutLiterals(altered[2])
  const dropped: Dropped[] = []

  DROP_COLUMN.lastIndex = 0
  for (
    let matched = DROP_COLUMN.exec(actions);
    matched !== null;
    matched = DROP_COLUMN.exec(actions)
  ) {
    const column = columnNameOf(matched[1])
    if (column === undefined) continue

    dropped.push({
      kind: "column",
      object: `${table}.${column}`,
      key: columnKey(table, column),
      table,
    })
  }
  return dropped
}

/**
 * Walk the migrations in applied order, accumulating what each one creates and
 * reporting every `DROP` of a table, a column or an enum type.
 *
 * A drop is checked against the creations of **strictly earlier** files, which
 * is Req 9.5's "a previously committed migration" read literally: a file that
 * creates something and drops it again takes nothing away from a schema anyone
 * has applied. Such a drop is still reported — with no `createdBy` — because a
 * *generated* migration has no additive reason to emit one, and a refusal that
 * needs inspecting is a far better failure than a parser gap that lets a real
 * removal through.
 *
 * `DROP INDEX` and `ALTER TABLE … DROP CONSTRAINT` are deliberately not
 * violations. Req 9.5 and 36.8 are about tables, columns and the enum types
 * they are declared with; drizzle-kit rewrites an index or a constraint whenever
 * its definition changes, and failing that would make the guard wrong on
 * ordinary work.
 */
function auditMigrations(files: readonly MigrationFile[]): {
  readonly created: Created
  readonly violations: readonly Violation[]
} {
  const created = emptyCreated()
  const violations: Violation[] = []

  for (const file of files) {
    const statements = scanStatements(file.sql)

    for (const statement of statements) {
      for (const dropped of collectDrops(statement)) {
        const registry =
          dropped.kind === "type"
            ? created.types
            : dropped.kind === "table"
              ? created.tables
              : created.columns

        const createdBy =
          registry.get(dropped.key) ??
          (dropped.table === undefined
            ? undefined
            : created.tables.get(dropped.table))

        violations.push({
          ...dropped,
          migration: file.name,
          line: statement.line,
          ...(createdBy === undefined ? {} : { createdBy }),
        })
      }
    }

    // Merged after the whole file is checked, so "previously committed" means an
    // earlier file rather than an earlier line.
    const fresh = emptyCreated()
    for (const statement of statements) collectCreations(statement, fresh)

    for (const [table] of fresh.tables) {
      if (!created.tables.has(table)) created.tables.set(table, file.name)
    }
    for (const [column] of fresh.columns) {
      if (!created.columns.has(column)) created.columns.set(column, file.name)
    }
    for (const [type] of fresh.types) {
      if (!created.types.has(type)) created.types.set(type, file.name)
    }
  }

  return { created, violations }
}

function formatViolation(violation: Violation): string {
  const origin =
    violation.createdBy === undefined
      ? "no earlier migration created it, and a generated migration has no " +
        "additive reason to drop one"
      : `created by ${violation.createdBy}`

  return (
    `${violation.migration}:${violation.line} drops ` +
    `${violation.kind} ${violation.object} (${origin})`
  )
}

// --- Fixtures for the vacuity check ----------------------------------------

/** Sorts after any real migration, so the fabricated file is the later one. */
const SYNTHETIC = "9999_synthetic_later_migration.sql"
const SYNTHETIC_SECOND = "9999_synthetic_second_migration.sql"

interface ExpectedViolation {
  readonly kind: DroppedKind
  readonly object: string
  /** Whether an earlier migration is on record as having created it. */
  readonly previouslyCreated: boolean
}

function summarise(violations: readonly Violation[]): ExpectedViolation[] {
  return violations.map((violation) => ({
    kind: violation.kind,
    object: violation.object,
    previouslyCreated: violation.createdBy !== undefined,
  }))
}

/** The committed migrations, plus one fabricated file appended after them. */
function verdictOnSyntheticTail(sql: string): ExpectedViolation[] {
  const { violations } = auditMigrations([
    ...readMigrationFiles(),
    { name: SYNTHETIC, sql },
  ])

  return summarise(
    violations.filter((violation) => violation.migration === SYNTHETIC)
  )
}

interface DetectorCase {
  readonly label: string
  readonly sql: string
  readonly expected: readonly ExpectedViolation[]
}

const DETECTOR_CASES: readonly DetectorCase[] = [
  {
    label: "DROP TABLE of a table 0000 created",
    sql: `DROP TABLE "report_runs";`,
    expected: [
      { kind: "table", object: "report_runs", previouslyCreated: true },
    ],
  },
  {
    label: "DROP TABLE IF EXISTS of a table 0000 created",
    sql: `DROP TABLE IF EXISTS "report_runs" CASCADE;`,
    expected: [
      { kind: "table", object: "report_runs", previouslyCreated: true },
    ],
  },
  {
    label: "every name in a comma-separated DROP TABLE list",
    sql: `DROP TABLE "report_runs", "sessions";`,
    expected: [
      { kind: "table", object: "report_runs", previouslyCreated: true },
      { kind: "table", object: "sessions", previouslyCreated: true },
    ],
  },
  {
    label: "ALTER TABLE … DROP COLUMN of a column 0000 created",
    sql: `ALTER TABLE "report_runs" DROP COLUMN "dedupe_key";`,
    expected: [
      {
        kind: "column",
        object: "report_runs.dedupe_key",
        previouslyCreated: true,
      },
    ],
  },
  {
    label: "DROP COLUMN IF EXISTS of a column 0000 created",
    sql: `ALTER TABLE "report_runs" DROP COLUMN IF EXISTS "dedupe_key";`,
    expected: [
      {
        kind: "column",
        object: "report_runs.dedupe_key",
        previouslyCreated: true,
      },
    ],
  },
  {
    label: "DROP with the optional COLUMN keyword omitted",
    sql: `ALTER TABLE "report_runs" DROP "progress_token_hash";`,
    expected: [
      {
        kind: "column",
        object: "report_runs.progress_token_hash",
        previouslyCreated: true,
      },
    ],
  },
  {
    label: "DROP TYPE of an enum 0000 created — enums may only gain values",
    sql: `DROP TYPE "public"."run_status";`,
    expected: [{ kind: "type", object: "run_status", previouslyCreated: true }],
  },
  {
    label: "an unqualified DROP TYPE of the same enum",
    sql: `DROP TYPE IF EXISTS run_error_code;`,
    expected: [
      { kind: "type", object: "run_error_code", previouslyCreated: true },
    ],
  },
  {
    label: "a DROP inside a line comment is not a schema change",
    sql: `-- DROP TABLE "report_runs";\nSELECT 1;`,
    expected: [],
  },
  {
    label: "a DROP inside drizzle's breakpoint comment is not one either",
    sql:
      `ALTER TABLE "report_runs" ADD COLUMN "note" text;` +
      `--> statement-breakpoint DROP TABLE "report_runs";\n`,
    expected: [],
  },
  {
    label: "a DROP inside a block comment is not a schema change",
    sql: `/* ALTER TABLE "report_runs" DROP COLUMN "dedupe_key"; */\nSELECT 1;`,
    expected: [],
  },
  {
    label: "a comment before a real DROP does not hide it",
    // The other direction of comment handling, and the one that fails on an
    // implementation that merely anchors its patterns: the statement begins with
    // the comment, so a DROP is only reachable once the comment is gone.
    sql: `/* squashed into 0000 */ DROP TABLE "report_runs";`,
    expected: [
      { kind: "table", object: "report_runs", previouslyCreated: true },
    ],
  },
  {
    label: "a `--` inside a literal does not hide a DROP later on that line",
    sql:
      `ALTER TABLE "report_runs" ADD COLUMN "note" text DEFAULT '--'; ` +
      `DROP TABLE "report_runs";`,
    expected: [
      { kind: "table", object: "report_runs", previouslyCreated: true },
    ],
  },
  {
    label: "a `/*` inside a literal does not hide a DROP after it",
    sql:
      `ALTER TABLE "report_runs" ADD COLUMN "note" text DEFAULT '/*'; ` +
      `ALTER TABLE "report_runs" DROP COLUMN "claimed_by";`,
    expected: [
      {
        kind: "column",
        object: "report_runs.claimed_by",
        previouslyCreated: true,
      },
    ],
  },
  {
    label: "a DROP inside a literal is not a schema change",
    // Both halves of the quote-awareness: a `;` inside a literal must not split
    // the statement, and the DDL inside it must not read as an action on the
    // table the statement names.
    sql:
      `ALTER TABLE "report_runs" ADD COLUMN "note" text ` +
      `DEFAULT 'x; DROP COLUMN "dedupe_key"';`,
    expected: [],
  },
  {
    label: "ADD COLUMN is additive",
    sql: `ALTER TABLE "report_runs" ADD COLUMN "note" text;`,
    expected: [],
  },
  {
    label: "DROP INDEX is not a table or column removal",
    sql: `DROP INDEX "report_runs_user_id_idx";`,
    expected: [],
  },
  {
    label: "DROP CONSTRAINT is not a column removal",
    sql: `ALTER TABLE "report_runs" DROP CONSTRAINT "report_runs_dedupe_key_ck";`,
    expected: [],
  },
  {
    label: "ALTER COLUMN … DROP DEFAULT is not a column removal",
    sql: `ALTER TABLE "report_runs" ALTER COLUMN "timezone" DROP DEFAULT;`,
    expected: [],
  },
  {
    label: "ALTER COLUMN … DROP NOT NULL is not a column removal",
    sql: `ALTER TABLE "report_runs" ALTER COLUMN "scope" DROP NOT NULL;`,
    expected: [],
  },
  {
    label: "a file that creates a table and drops it again is refused anyway",
    sql:
      `CREATE TABLE "scratch" ("id" text PRIMARY KEY NOT NULL);` +
      `--> statement-breakpoint\nDROP TABLE "scratch";`,
    expected: [{ kind: "table", object: "scratch", previouslyCreated: false }],
  },
]

// ---------------------------------------------------------------------------

describe("Requirements 9.4, 9.5 — the migration set is scannable", () => {
  test("the scanned set is not empty", () => {
    // A guard that passes by checking nothing is the failure mode these tests
    // are most prone to (Req 6.11). `readMigrationFiles` asserts it too, so
    // every test below inherits the rule; this one states it.
    expect(readMigrationFiles().length).toBeGreaterThan(0)
  })

  test("the .sql files are exactly the journal's entries, in the same order", () => {
    // Lexical order is taken as applied order above. This is the assertion that
    // makes that safe, and it also catches a file drizzle-kit does not know
    // about — which would be a hand-written migration (Req 9.4).
    expect(readMigrationFiles().map(({ name }) => name)).toEqual(
      readJournalFileNames()
    )
  })

  test("the parser registers the objects the committed schema declares", () => {
    // Without this the suite could pass by parsing nothing: a `collectCreations`
    // that recognises no table would leave every registry empty, and every drop
    // would then look like a drop of something never created.
    const { created } = auditMigrations(readMigrationFiles())

    expect([...created.tables.keys()].sort()).toEqual([
      "connected_subscriptions",
      "login_attempts",
      "report_runs",
      "report_template_versions",
      "report_templates",
      "report_verifications",
      "sessions",
      "users",
    ])

    expect([...created.types.keys()].sort()).toEqual([
      "fidelity_tier",
      "run_error_code",
      "run_status",
      "subscription_status",
      "verification_status",
    ])

    // The audit-trail columns Req 36.8 protects, plus the secret-bearing column
    // on the subscription table.
    for (const [table, column] of [
      ["report_runs", "dedupe_key"],
      ["report_runs", "progress_token_hash"],
      ["report_runs", "claimed_by"],
      ["report_runs", "phase_deadline"],
      ["report_runs", "error_code"],
      ["connected_subscriptions", "client_secret_enc"],
      ["sessions", "session_token_hash"],
      ["users", "password_hash"],
    ] as const) {
      expect(
        created.columns.has(columnKey(table, column)),
        `the parser did not register ${table}.${column}, so a DROP of it ` +
          `would not be recognised as removing committed state`
      ).toBe(true)
    }
  })
})

describe("Requirements 9.5, 36.8 — no committed migration removes anything", () => {
  test("no migration drops a table, a column or an enum type", () => {
    const { violations } = auditMigrations(readMigrationFiles())

    // Formatted rather than raw, so a failure names the file, the line and the
    // migration that created the object instead of printing an object graph.
    expect(violations.map(formatViolation)).toEqual([])
  })
})

describe("the detector is not vacuous", () => {
  // One committed migration cannot violate an additive rule, so the checks
  // above cannot fail today. These run the same parser over fabricated *later*
  // migrations. The fixtures are strings in this file and are never written to
  // lib/db/migrations/.

  test("the case set covers both verdicts", () => {
    const refused = DETECTOR_CASES.filter(({ expected }) => expected.length > 0)
    const allowed = DETECTOR_CASES.filter(
      ({ expected }) => expected.length === 0
    )

    expect(refused.length).toBeGreaterThan(0)
    expect(allowed.length).toBeGreaterThan(0)
  })

  test.each(DETECTOR_CASES)("$label", ({ sql, expected }) => {
    expect(verdictOnSyntheticTail(sql)).toEqual(expected)
  })

  test("a violation names the migration, the line and the earlier creator", () => {
    const { violations } = auditMigrations([
      ...readMigrationFiles(),
      {
        name: SYNTHETIC,
        sql:
          `ALTER TABLE "report_runs" ADD COLUMN "note" text;\n` +
          `--> statement-breakpoint\n` +
          `ALTER TABLE "report_runs" DROP COLUMN "dedupe_key";\n`,
      },
    ])

    expect(violations.map(formatViolation)).toEqual([
      `${SYNTHETIC}:3 drops column report_runs.dedupe_key ` +
        `(created by 0000_low_ogun.sql)`,
    ])
  })

  test("a column added by one migration and dropped by the next is caught", () => {
    // Proves the accumulation spans files rather than only reading the first
    // one: `note` exists nowhere in the committed set.
    const { violations } = auditMigrations([
      ...readMigrationFiles(),
      { name: SYNTHETIC, sql: `ALTER TABLE "report_runs" ADD "note" text;` },
      {
        name: SYNTHETIC_SECOND,
        sql: `ALTER TABLE "report_runs" DROP COLUMN "note";`,
      },
    ])

    expect(violations.map(formatViolation)).toEqual([
      `${SYNTHETIC_SECOND}:1 drops column report_runs.note ` +
        `(created by ${SYNTHETIC})`,
    ])
  })

  test("a type added by one migration and dropped by the next is caught", () => {
    const { violations } = auditMigrations([
      ...readMigrationFiles(),
      {
        name: SYNTHETIC,
        sql: `CREATE TYPE "public"."gap_type" AS ENUM('deallocated');`,
      },
      { name: SYNTHETIC_SECOND, sql: `DROP TYPE "public"."gap_type";` },
    ])

    expect(violations.map(formatViolation)).toEqual([
      `${SYNTHETIC_SECOND}:1 drops type gap_type (created by ${SYNTHETIC})`,
    ])
  })
})
