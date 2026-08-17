"""The shared definition corpus: one directory, read by both halves of the mirror.

`tests/fixtures/definitions/` holds the fixtures and `manifest.json` declares, for
each one, the mode it is validated in, the expected accept-or-reject verdict, the
expected `definition_sha256`, and — for a rejection — every expected offending block
`id` and field path (Req 2.6, 2.11).

**Not a test module.** It is the loader `tests/test_definition_corpus.py` imports and
the entry point `app/test/mirror.static.test.ts` spawns, which is the whole point:
there is **one** corpus directory, read across the monorepo path by both languages,
and **never a copy**. Two copies is how a mirror guard comes to compare each half
against itself and pass while the two halves disagree.

Run as a script to emit the agent half's verdicts as JSON on stdout:

```
PYTHONPATH=src .venv/bin/python tests/definition_corpus.py
```

That is exactly what the web test suite does. It prints **only** the JSON document,
so a caller can parse stdout without stripping a banner.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

TESTS_ROOT: Final[Path] = Path(__file__).resolve().parent
CORPUS_ROOT: Final[Path] = TESTS_ROOT / "fixtures" / "definitions"
MANIFEST_PATH: Final[Path] = CORPUS_ROOT / "manifest.json"

MANIFEST_VERSION: Final[int] = 1
VALIDATION_MODES: Final[frozenset[str]] = frozenset({"draft", "run"})
VERDICTS: Final[frozenset[str]] = frozenset({"accept", "reject"})

__all__ = [
    "CORPUS_ROOT",
    "MANIFEST_PATH",
    "MANIFEST_VERSION",
    "VALIDATION_MODES",
    "VERDICTS",
    "CorpusEntry",
    "Offender",
    "declared_block_types",
    "evaluate",
    "load_manifest",
    "verdict_payload",
]


@dataclass(frozen=True, slots=True)
class Offender:
    """One expected violation location: the block it belongs to, and the field path.

    `block_id` is `None` for a violation outside `blocks` entirely, and also for a
    block whose own `id` failed its bound — an id that is not a valid id cannot
    identify anything, so attributing the issue to it would be inventing a name.
    """

    block_id: str | None
    path: tuple[str | int, ...]

    def to_plain(self) -> dict[str, Any]:
        return {"block_id": self.block_id, "path": list(self.path)}

    @classmethod
    def from_plain(cls, raw: object, where: str) -> Offender:
        if not isinstance(raw, dict):
            raise ValueError(f"{where}: an offender must be a JSON object, got {raw!r}")
        block_id = raw.get("block_id")
        if block_id is not None and not isinstance(block_id, str):
            raise ValueError(f"{where}: `block_id` must be a string or null, got {block_id!r}")
        path = raw.get("path")
        if not isinstance(path, list) or not all(
            isinstance(segment, str) or (isinstance(segment, int) and not isinstance(segment, bool))
            for segment in path
        ):
            raise ValueError(
                f"{where}: `path` must be an array of strings and integers, got {path!r}"
            )
        return cls(block_id=block_id, path=tuple(path))


@dataclass(frozen=True, slots=True)
class CorpusEntry:
    """One manifest entry, plus the definition it names, loaded."""

    file: str
    mode: str
    verdict: str
    definition_sha256: str
    offenders: tuple[Offender, ...]
    document: Any

    @property
    def rejects(self) -> bool:
        return self.verdict == "reject"


def load_manifest() -> tuple[CorpusEntry, ...]:
    """Every declared fixture, in manifest order, with its definition loaded.

    Validated strictly at load time, and the validation includes both directions of
    the file-set comparison: every manifest entry names a file that exists, and every
    `.json` file in the directory other than the manifest is declared. A fixture
    nobody declared is a fixture neither half checks, which is a silent hole in the
    corpus rather than an extra file.
    """
    if not MANIFEST_PATH.is_file():
        raise FileNotFoundError(f"the corpus manifest is missing: {MANIFEST_PATH}")

    raw = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise ValueError("manifest.json must be a JSON object")
    if raw.get("manifest_version") != MANIFEST_VERSION:
        raise ValueError(
            f"manifest_version must be {MANIFEST_VERSION}, got "
            f"{raw.get('manifest_version')!r}"
        )

    declared = raw.get("fixtures")
    if not isinstance(declared, list) or not declared:
        raise ValueError("manifest.json must declare a non-empty `fixtures` array")

    entries: list[CorpusEntry] = []
    seen: set[str] = set()

    for index, entry in enumerate(declared):
        where = f"fixtures[{index}]"
        if not isinstance(entry, dict):
            raise ValueError(f"{where}: a manifest entry must be a JSON object")

        name = entry.get("file")
        if not isinstance(name, str) or not name.endswith(".json"):
            raise ValueError(f"{where}: `file` must name a .json fixture, got {name!r}")
        if name == MANIFEST_PATH.name:
            raise ValueError(f"{where}: the manifest cannot declare itself")
        if name in seen:
            raise ValueError(f"{where}: {name!r} is declared more than once")
        seen.add(name)

        mode = entry.get("mode")
        if mode not in VALIDATION_MODES:
            raise ValueError(f"{where}: `mode` must be one of {sorted(VALIDATION_MODES)}")

        verdict = entry.get("verdict")
        if verdict not in VERDICTS:
            raise ValueError(f"{where}: `verdict` must be one of {sorted(VERDICTS)}")

        digest = entry.get("definition_sha256")
        if not isinstance(digest, str) or len(digest) != 64 or digest != digest.lower():
            raise ValueError(
                f"{where}: `definition_sha256` must be 64 lowercase hexadecimal "
                f"characters, got {digest!r}"
            )

        raw_offenders = entry.get("offenders")
        if not isinstance(raw_offenders, list):
            raise ValueError(f"{where}: `offenders` must be an array")
        offenders = tuple(
            Offender.from_plain(item, f"{where}.offenders[{position}]")
            for position, item in enumerate(raw_offenders)
        )

        # An accepted fixture with declared offenders, or a rejected one with none, is a
        # manifest that contradicts itself — worth catching here rather than as a
        # confusing per-fixture assertion failure in two different test suites.
        if verdict == "accept" and offenders:
            raise ValueError(f"{where}: an accepted fixture declares no offenders")
        if verdict == "reject" and not offenders:
            raise ValueError(f"{where}: a rejected fixture must declare its offenders")

        path = CORPUS_ROOT / name
        if not path.is_file():
            raise FileNotFoundError(f"{where}: no fixture at {path}")

        entries.append(
            CorpusEntry(
                file=name,
                mode=mode,
                verdict=verdict,
                definition_sha256=digest,
                offenders=offenders,
                document=json.loads(path.read_text(encoding="utf-8")),
            )
        )

    on_disk = {path.name for path in CORPUS_ROOT.glob("*.json")} - {MANIFEST_PATH.name}
    undeclared = sorted(on_disk - seen)
    if undeclared:
        raise ValueError(
            f"these fixtures are not declared in manifest.json, so neither half checks "
            f"them: {undeclared}"
        )

    return tuple(entries)


def _sort_key(offender: Offender) -> tuple[bool, str, list[str]]:
    """A total order over offenders that does not compare an `int` against a `str`.

    A field path mixes string keys and integer indices, so the segments are compared
    as their string spellings. The order only has to be *stable across processes* —
    the comparison itself is against a set — and `PYTHONHASHSEED` differs between
    processes, so set iteration order is not that.
    """
    return (
        offender.block_id is not None,
        offender.block_id or "",
        [str(segment) for segment in offender.path],
    )


def _ordered(offenders: set[Offender]) -> tuple[Offender, ...]:
    return tuple(sorted(offenders, key=_sort_key))


def evaluate(entry: CorpusEntry) -> tuple[str, tuple[Offender, ...]]:
    """The agent half's verdict for one fixture: `("accept" | "reject", offenders)`.

    Offenders are **deduplicated and sorted**, because a location can legitimately
    carry two messages — an absent `schema_version` is both a missing required key and
    a non-integer — and the corpus compares *locations*, not message text. Message
    wording is deliberately not part of the contract: two languages writing the same
    sentence is a coincidence to maintain, not a property worth asserting.
    """
    from reporting_agent.compile.definition import collect_definition_issues

    issues = collect_definition_issues(entry.document, mode=entry.mode)
    offenders = {Offender(block_id=issue.block_id, path=tuple(issue.path)) for issue in issues}
    return ("reject" if issues else "accept", _ordered(offenders))


def declared_block_types(document: object) -> set[str]:
    """Every block `type` string appearing anywhere in `document`'s block tree,
    including inside a row's columns.

    Used for the corpus coverage check: every declared block type must appear in at
    least one fixture, or a type exists that no cross-language comparison ever
    exercises. Reads defensively, because a rejected fixture is deliberately
    malformed.
    """
    found: set[str] = set()

    def walk(blocks: object) -> None:
        if not isinstance(blocks, list):
            return
        for block in blocks:
            if not isinstance(block, dict):
                continue
            block_type = block.get("type")
            if isinstance(block_type, str):
                found.add(block_type)
            columns = block.get("columns")
            if isinstance(columns, list):
                for column in columns:
                    walk(column)

    if isinstance(document, dict):
        walk(document.get("blocks"))
    return found


def verdict_payload() -> dict[str, Any]:
    """The agent half's verdicts for the whole corpus, as plain data.

    What the script form prints and what `app/test/mirror.static.test.ts` parses. The
    digest is recomputed here rather than copied from the manifest: the point of the
    cross-language comparison is that this half *computes* the same content address
    the web half does (Property 11's cross-language half), and echoing the manifest's
    value would assert nothing.
    """
    from reporting_agent.compile.definition import canonical_digest

    fixtures: list[dict[str, Any]] = []
    for entry in load_manifest():
        verdict, offenders = evaluate(entry)
        fixtures.append(
            {
                "file": entry.file,
                "mode": entry.mode,
                "verdict": verdict,
                "definition_sha256": canonical_digest(entry.document),
                "offenders": [offender.to_plain() for offender in offenders],
            }
        )
    return {"manifest_version": MANIFEST_VERSION, "fixtures": fixtures}


if __name__ == "__main__":
    json.dump(verdict_payload(), sys.stdout, ensure_ascii=False, sort_keys=True)
    sys.stdout.write("\n")
