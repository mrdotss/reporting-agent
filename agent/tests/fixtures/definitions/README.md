# The shared template-definition corpus

One directory, read by **both** halves of the mirror, and **never copied**.

- `agent/tests/test_definition_corpus.py` runs every fixture through the
  `Block_Compiler`'s validator (`reporting_agent.compile.definition`).
- `app/test/mirror.static.test.ts` runs every fixture through the
  `Template_Validator` (`lib/templates/definition.ts`) **and** spawns the agent
  half to compare the two head to head.

Two copies is how a mirror guard comes to compare each half against itself: one
copy drifts, both suites stay green, and the disagreement the guard exists to
catch is the one thing neither of them sees. So these files live once and the web
suite reaches across the monorepo path for them.

## What a fixture is

A plain template definition — the JSON body of a `report_template_versions.definition`
column. Not a recorded HTTP response, so `fixtures/__init__.py`'s `load_response`
does not apply here; `definition_corpus.py` is the loader.

Fixtures are named for what they assert: `accept-*` for a definition both
validators must accept, `reject-*` for one both must reject.

## `manifest.json`

Every fixture is declared, and an undeclared `.json` file in this directory is a
**test failure** in both halves — a fixture nobody declared is a fixture nobody
checks.

```jsonc
{
  "file": "reject-row-nested-in-row.json",
  "mode": "run",                    // "draft" | "run" — zero blocks is a valid
                                    //   draft and an invalid run (Req 6.8)
  "verdict": "reject",
  "definition_sha256": "0176…",     // RFC 8785 canonical form, SHA-256, 64
                                    //   lowercase hex (Req 9.4)
  "offenders": [                    // every expected violation LOCATION
    { "block_id": "inner-row", "path": ["blocks", 0, "columns", 0, 0, "type"] }
  ]
}
```

Three things about `offenders` are deliberate:

- **Locations, not messages.** Two languages producing byte-identical prose is a
  coincidence to maintain rather than a property worth asserting. Wording is free
  to improve on either side; the path and the block it belongs to are the
  contract.
- **The complete set, compared as a set.** A missing location means a validator
  stopped early (Req 2.7, 6.11); an extra one means a validator rejects something
  the corpus never declared. Both directions are asserted.
- **`block_id` is `null`** for a violation outside `blocks`, and for a block whose
  own `id` failed its bound — an id that is not a valid id cannot identify
  anything. `reject-block-id-too-long.json` pins that case.

## Why the manifest exists when the two halves are compared directly

It is a third, independent declaration. Two validators can agree with each other
and both be wrong — a shared misreading of a bound, or a path convention that
drifted in both files at once. The manifest is reviewed as code, so an
agreed-upon regression fails against it.

## Editing the corpus

Adding a fixture means adding its manifest entry in the same change: both suites
fail otherwise. Changing a fixture's bytes changes its `definition_sha256`, which
is pinned on purpose — a digest that moved without anyone intending it is exactly
what the pin is for.

## The `schema_version` fixtures, and the two that look redundant

Eleven fixtures cover the version-conditional key sets. Nine are what you would expect —
an accepted version 2 with a full front matter, one with the separators left to default from
`id`, and rejections for an absent `front_matter`, a `cover` block in `blocks`, an absent
`identity.language`, a version-1 definition carrying either `front_matter` or a separator, a
front matter with five simultaneous defects, and a resolved separator pair that collides.

Two exist because the nine left a real divergence undetected, and both are worth keeping for
that reason rather than for coverage:

- **`reject-schema-version-2-subtitle-astral-over-bound.json`** — a subtitle of 101 astral
  characters: 101 code points and **202** UTF-16 code units. It is over the 200-unit bound and
  under a 200-code-point one, so a half measuring code points accepts it. Every other
  string-bound fixture is ASCII, where the two measurements agree.
- **`reject-schema-version-2-document-number-cannot-vary.json`** — a document-number pattern
  naming only declared placeholders and none that varies between two runs of one template over
  one resolved period. The `{quarter}` case in the five-defect fixture reports **two** issues at
  that one path, and the comparison is over a set of *locations*, so it cannot distinguish a
  validator that dropped the varying-placeholder rule from one that kept it.

Both were added after a mutation pass over the guard: with the other nine in place, a
`TOC_MAX_LEVEL` moved to 9 failed, a dropped `startsWith("doc.")` failed, and those two
mutations passed. A fixture set that cannot fail for the reason a validator can drift is not a
corpus.
