"""The agent half of the Mirror_Guard's behavioural half (Req 2.6, 2.11, 1.3, 9.4).

`tests/fixtures/definitions/` is **one** corpus directory, read by both halves across
the monorepo path. This module runs every fixture through the `Block_Compiler`'s
validator and asserts the verdict, every offending block `id` and field path, and the
canonical digest against `manifest.json`. `app/test/mirror.static.test.ts` does the
same from the web side with the `Template_Validator`, *and* spawns this half to
compare the two directly.

**Why the manifest exists at all**, given that the web test compares the two halves
head to head: it is a third, independent declaration. Two validators can agree with
each other and both be wrong — a shared misreading of a bound, or a path convention
that drifted in both files at once. The manifest is reviewed as code and pins the
intent, so an agreed-upon regression fails here as well as passing there.

**Message text is deliberately not part of the contract.** The corpus compares
verdicts, offender locations and digests. Two languages producing byte-identical
prose is a coincidence to maintain rather than a property worth asserting, and pinning
it would make every wording improvement a two-file change with no gain in safety.
"""

from __future__ import annotations

import json

import pytest

from definition_corpus import (
    CORPUS_ROOT,
    MANIFEST_PATH,
    CorpusEntry,
    declared_block_types,
    evaluate,
    load_manifest,
)
from reporting_agent.compile.definition import (
    BLOCK_TYPES,
    assert_valid_pinned_definition,
    canonical_digest,
    collect_definition_issues,
    format_path,
)
from reporting_agent.errors import ErrorCode, TemplateInvalidError

# Req 2.11 — the corpus floor. Below this the coverage the guard claims is not
# something a reader can take on trust.
MINIMUM_CORPUS_SIZE = 20

CORPUS = load_manifest()

# The four rejection categories task 5.2 names explicitly. Declared by file name so a
# rename that quietly drops one fails here rather than leaving the corpus one category
# short with the same total count.
REQUIRED_REJECTIONS = (
    "reject-scope-carries-resource-id.json",
    "reject-row-nested-in-row.json",
    "reject-duplicate-id-inside-row-column.json",
    "reject-missing-schema-version.json",
)


def _label(entry: CorpusEntry) -> str:
    return entry.file


# --------------------------------------------------------------------------- #
# The corpus itself
# --------------------------------------------------------------------------- #


def test_the_corpus_directory_and_manifest_exist() -> None:
    """A guard that passes by reading nothing is the first failure mode to rule out."""
    assert CORPUS_ROOT.is_dir(), CORPUS_ROOT
    assert MANIFEST_PATH.is_file(), MANIFEST_PATH
    assert CORPUS, "manifest.json declares no fixtures"


def test_the_corpus_meets_its_size_floor() -> None:
    assert len(CORPUS) >= MINIMUM_CORPUS_SIZE, (
        f"the shared corpus holds {len(CORPUS)} fixtures; Req 2.11 asks for at least "
        f"{MINIMUM_CORPUS_SIZE}"
    )


def test_the_corpus_carries_both_verdicts() -> None:
    """An all-accept corpus proves neither half rejects anything, and an all-reject one
    proves neither accepts. Both verdicts have to be exercised for the comparison to
    mean anything."""
    verdicts = {entry.verdict for entry in CORPUS}
    assert verdicts == {"accept", "reject"}, sorted(verdicts)


def test_every_declared_block_type_appears_in_the_corpus() -> None:
    """Req 2.11 — every declared block type present at least once.

    A type no fixture carries is a type the cross-language comparison never exercises,
    so the two halves could disagree about its config schema indefinitely.
    """
    covered: set[str] = set()
    for entry in CORPUS:
        covered |= declared_block_types(entry.document)

    missing = sorted(set(BLOCK_TYPES) - covered)
    assert not missing, (
        f"these declared block types appear in no corpus fixture, so no fixture ever "
        f"compares the two halves' handling of them: {missing}"
    )


def test_the_corpus_carries_the_four_named_rejection_categories() -> None:
    declared = {entry.file: entry for entry in CORPUS}
    problems: list[str] = []
    for name in REQUIRED_REJECTIONS:
        entry = declared.get(name)
        if entry is None:
            problems.append(f"{name}: absent from the corpus")
        elif not entry.rejects:
            problems.append(f"{name}: declared as {entry.verdict}, expected reject")
    assert not problems, problems


def test_the_corpus_exercises_both_validation_modes() -> None:
    """A zero-block definition is a valid draft and an invalid run (Req 6.8), which is
    the one rule that differs between the two modes — so both have to be present or
    that rule is asserted in one direction only."""
    modes = {entry.mode for entry in CORPUS}
    assert modes == {"draft", "run"}, sorted(modes)


# --------------------------------------------------------------------------- #
# Verdict, offenders and digest, per fixture
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("entry", CORPUS, ids=_label)
def test_the_agent_verdict_matches_the_manifest(entry: CorpusEntry) -> None:
    verdict, offenders = evaluate(entry)
    assert verdict == entry.verdict, (
        f"{entry.file}: the Block_Compiler {verdict}s a fixture the manifest declares "
        f"as {entry.verdict}. Offenders found: "
        f"{[(o.block_id, format_path(o.path)) for o in offenders]}"
    )


@pytest.mark.parametrize("entry", CORPUS, ids=_label)
def test_the_agent_names_every_declared_offender_and_no_others(entry: CorpusEntry) -> None:
    """Req 2.7, 6.11 — one pass reporting **every** violation, each located by the
    offending block `id` and field path.

    Set equality rather than containment, in both directions: a missing offender is a
    validator that stopped early, and an extra one is a validator rejecting something
    the corpus never declared, which would make the web half disagree.
    """
    _, offenders = evaluate(entry)
    found = {(o.block_id, o.path) for o in offenders}
    expected = {(o.block_id, o.path) for o in entry.offenders}

    assert found == expected, (
        f"{entry.file}: offender locations differ from the manifest.\n"
        f"  missing: {sorted((b, format_path(p)) for b, p in expected - found)}\n"
        f"  extra:   {sorted((b, format_path(p)) for b, p in found - expected)}"
    )


@pytest.mark.parametrize("entry", CORPUS, ids=_label)
def test_the_agent_digest_matches_the_manifest(entry: CorpusEntry) -> None:
    """Req 9.4 — RFC 8785 canonical form, SHA-256, 64 lowercase hexadecimal characters.

    The manifest's pinned value is what makes a canonicalization change on *either*
    side of the mirror a test failure. `app/test/mirror.static.test.ts` closes the
    other half by asserting `definitionSha256` equals this same value.
    """
    digest = canonical_digest(entry.document)
    assert digest == entry.definition_sha256, (
        f"{entry.file}: canonical digest is {digest}, manifest declares "
        f"{entry.definition_sha256}"
    )
    assert len(digest) == 64
    assert digest == digest.lower()
    assert all(character in "0123456789abcdef" for character in digest)


def test_every_fixture_has_a_distinct_digest() -> None:
    """Two fixtures hashing alike would mean two files carrying the same definition, so
    one of them is testing nothing that the other does not."""
    by_digest: dict[str, list[str]] = {}
    for entry in CORPUS:
        by_digest.setdefault(entry.definition_sha256, []).append(entry.file)
    collisions = {digest: files for digest, files in by_digest.items() if len(files) > 1}
    assert not collisions, collisions


# --------------------------------------------------------------------------- #
# Req 2.8 — a pinned version that fails validation is terminal TEMPLATE_INVALID
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "entry", [entry for entry in CORPUS if entry.rejects], ids=_label
)
def test_a_rejected_fixture_raises_terminal_template_invalid(entry: CorpusEntry) -> None:
    """Req 2.8 — the pinned version failing validation at compile time raises the
    terminal `TEMPLATE_INVALID` naming every failing path, renders no document and
    writes no artifact.

    "Writes no artifact" is structural rather than asserted: `assert_valid_pinned_definition`
    is the compile stage's first statement and it raises before a `SnapshotView`, an
    AST or a ledger exists, so there is nothing written to un-write.
    """
    with pytest.raises(TemplateInvalidError) as caught:
        assert_valid_pinned_definition(entry.document, mode=entry.mode)

    error = caught.value
    assert error.code is ErrorCode.TEMPLATE_INVALID
    assert error.terminal is True

    # Every failing path is named, which is what makes one fix pass possible.
    message = str(error)
    for offender in entry.offenders:
        rendered = format_path(offender.path) or "<root>"
        assert rendered in message, (
            f"{entry.file}: the raised message does not name the failing path "
            f"{rendered!r}: {message}"
        )


@pytest.mark.parametrize(
    "entry", [entry for entry in CORPUS if not entry.rejects], ids=_label
)
def test_an_accepted_fixture_passes_the_pinned_version_gate(entry: CorpusEntry) -> None:
    returned = assert_valid_pinned_definition(entry.document, mode=entry.mode)
    assert returned is entry.document, "the gate returns the definition unchanged"


def test_the_pinned_version_gate_defaults_to_run_mode() -> None:
    """A pinned version is by definition about to be run, so a zero-block draft — legal
    to save — must not pass the gate when the mode is left to its default."""
    draft = next(entry for entry in CORPUS if entry.mode == "draft")
    assert draft.verdict == "accept"
    with pytest.raises(TemplateInvalidError):
        assert_valid_pinned_definition(draft.document)


# --------------------------------------------------------------------------- #
# Req 5.9 — every scoped resource type carries a metric selection
# --------------------------------------------------------------------------- #
#
# The corpus covers this rule cross-language through
# `reject-scoped-type-with-no-metric-selection.json`, which is the half that matters most:
# it proves both validators name the same three offending paths, including the two
# case-variant spellings that must **not** offend. These are the named cases for the parts
# a fixture cannot express — the mode gating, and the unconstrained empty dimension.


def _vm_only_definition() -> dict[str, object]:
    """An accepted run-mode fixture, as the base to break."""
    entry = next(
        item
        for item in CORPUS
        if item.file == "accept-minimal-single-heading.json" and item.mode == "run"
    )
    return json.loads(json.dumps(entry.document))


def test_a_scoped_type_with_no_metric_selection_is_rejected_at_its_own_path() -> None:
    """Req 5.9 — reported where the scope names the type, not at `metrics`.

    Naming the location is the difference between an author fixing one field and an author
    hunting through eight blocks for whichever one introduced the type.
    """
    definition = _vm_only_definition()
    scope = definition["scope"]
    assert isinstance(scope, dict)
    scope["resource_types"] = [
        "Microsoft.Compute/virtualMachines",
        "Microsoft.Storage/storageAccounts",
    ]

    issues = collect_definition_issues(definition, mode="run")

    assert [format_path(issue.path) for issue in issues] == ["scope.resource_types.1"]
    assert "Microsoft.Storage/storageAccounts" in issues[0].message


def test_the_scoped_type_comparison_folds_case() -> None:
    """Req 3.12. Resource Graph lowercases `type`, so a `metrics` map seeded from observed
    inventory carries lowercase keys while the scope carries the catalog's spelling. An
    exact comparison would reject a definition that is entirely correct."""
    definition = _vm_only_definition()
    scope = definition["scope"]
    assert isinstance(scope, dict)
    scope["resource_types"] = ["MICROSOFT.COMPUTE/VIRTUALMACHINES"]
    definition["metrics"] = {
        "microsoft.compute/virtualmachines": [
            {"metric": "Percentage CPU", "statistic": "avg"}
        ]
    }

    assert collect_definition_issues(definition, mode="run") == []


def test_a_draft_may_carry_a_scoped_type_with_no_selection_yet() -> None:
    """Req 5.9 rejects a save that persists a **version** row. A draft persists none, and
    the wizard reaches scope at step 2 and metrics at step 4 — so enforcing this against a
    draft would refuse to save the ordinary half-authored template between those steps."""
    definition = _vm_only_definition()
    scope = definition["scope"]
    assert isinstance(scope, dict)
    scope["resource_types"] = [
        "Microsoft.Compute/virtualMachines",
        "Microsoft.Storage/storageAccounts",
    ]

    assert collect_definition_issues(definition, mode="draft") == []
    with pytest.raises(TemplateInvalidError):
        assert_valid_pinned_definition(definition)


def test_a_scope_naming_no_resource_type_is_not_an_issue() -> None:
    """Req 3.1 and 3.12 — an empty dimension is unconstrained, so which types it can
    contain is a fact about the subscription rather than about the definition. No validator
    can see it; the collector records a `metric_not_selected` gap instead."""
    definition = _vm_only_definition()
    scope = definition["scope"]
    assert isinstance(scope, dict)
    scope["resource_types"] = []

    assert collect_definition_issues(definition, mode="run") == []
