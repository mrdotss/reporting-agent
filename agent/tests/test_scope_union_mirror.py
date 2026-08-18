"""The scope-union mirror, agent half (Req 3.3).

`compile/scope.py#union_scope` and `app/lib/templates/scope-union.ts#unionScope`
compute the same union, and they have to: the app derives a run's `scope` column from
the pinned definition and the agent keys its Req 5.4 metric narrowing off the same
union. Two halves that disagree about which resource types a run covers produce the
quietest failure this product has — a type present in one and absent from the other
requests no metric, the resources land in the snapshot carrying nothing, and every gate
passes because a resource with no figures is a resource with no *unverifiable* figures.

So both halves assert against one committed corpus rather than against each other.
`tests/fixtures/scope-union/cases.json` carries the inputs and the expected unions; this
file runs the Python implementation over them and the TypeScript suite runs its own.
A change to either half fails one of the two suites, which is the property a
generated-at-test-time comparison would not have: two implementations regenerated
together drift together and agree the whole way down.

The declaration halves are marked in both files with the `BEGIN SCOPE UNION` sentinel,
matching the convention `test/mirror.static.test.ts` uses for the block vocabulary.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pytest

from reporting_agent.compile.scope import scope_rules_from_plain, union_scope

CASES_PATH = Path(__file__).parent / "fixtures" / "scope-union" / "cases.json"


def _cases() -> list[dict[str, Any]]:
    document = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    cases = document["cases"]
    assert cases, "the scope-union corpus is empty"
    return list(cases)


@pytest.mark.parametrize("case", _cases(), ids=lambda case: case["name"])
def test_union_scope_matches_the_shared_corpus(case: dict[str, Any]) -> None:
    scopes = [scope_rules_from_plain(case["scope"], at="scope")]
    for ordinal, override in enumerate(case["overrides"]):
        scopes.append(
            scope_rules_from_plain(override, at=f"blocks.{ordinal}.scope_override")
        )

    result = union_scope(scopes)

    expected = case["expected"]
    assert list(result.resource_types) == expected["resource_types"]
    assert list(result.resource_groups) == expected["resource_groups"]
    assert dict(result.tag_filters) == expected["tag_filters"]


def test_the_corpus_covers_both_widening_directions() -> None:
    """A corpus of only-widening cases would pass against an implementation that
    always returned the empty union, and one of only-populated cases would pass
    against an implementation that never applied the empty-wins rule. Both have to
    be present for the parametrized test above to mean anything."""
    expectations = [case["expected"] for case in _cases()]

    assert any(expected["resource_types"] for expected in expectations)
    assert any(not expected["resource_types"] for expected in expectations)
    assert any(expected["tag_filters"] for expected in expectations)
    assert any(not expected["tag_filters"] for expected in expectations)


def test_no_expectation_carries_a_ranking() -> None:
    """Req 3.3 — the union ignores every top-N count and sort direction, so that one
    snapshot carries every resource any block needs *including* the candidates a
    top-N ordering discards. At least one case must supply one, so the absence below
    is a fact about the union rather than about the corpus."""
    cases = _cases()

    supplied = [
        case
        for case in cases
        if case["scope"].get("top_n") is not None
        or any(override.get("top_n") is not None for override in case["overrides"])
    ]
    assert supplied, "no case supplies a top_n, so nothing proves the union drops it"

    for case in cases:
        assert set(case["expected"]) == {
            "resource_types",
            "resource_groups",
            "tag_filters",
        }
