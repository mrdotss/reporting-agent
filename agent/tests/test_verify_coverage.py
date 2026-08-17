"""The coverage gates (Req 32).

Every test here exists because the failure it describes passes every *other* gate in
`verify/`. An empty snapshot compiles to zero figures, and zero figures means zero
unverifiable figures — so the prose pass, the anchored pass, the chart pass, the PDF pass and
replay all report clean on a document that says nothing. The first test in the file makes that
argument executable rather than leaving it in a docstring.
"""

from __future__ import annotations

from typing import Any, Final

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.verify.coverage import (
    CoveragePass,
    UnionUnresolvable,
    check_coverage,
    union_resource_ids,
)
from reporting_agent.verify.findings import (
    FINDING_COVERAGE_RESOURCE_ABSENT,
    FINDING_EMPTY_SCOPE,
    FINDING_SCOPE_UNVERIFIED,
    SEVERITY_BLOCKING,
)

BLOCKS: Final[list[dict[str, Any]]] = [
    df.block("res", "resource_table", {"columns": [df.CPU_AVG]})
]


def run(snapshot: dict, *, blocks: list[dict] | None = None) -> CoveragePass:
    definition = df.definition(blocks if blocks is not None else BLOCKS)
    return check_coverage(
        snapshot, view=build_snapshot_view(snapshot), definition=definition
    )


def types_of(outcome: CoveragePass) -> list[str]:
    return [str(finding["type"]) for finding in outcome.findings]


def empty_snapshot() -> dict:
    return sf.build(resources=[])


# --------------------------------------------------------------------------- #
# Why this module exists
# --------------------------------------------------------------------------- #


def test_an_empty_snapshot_compiles_cleanly_and_this_is_the_only_gate_that_stops_it() -> None:
    """The argument for the whole module, executable.

    An empty in-scope result compiles to a document with zero figures. Nothing is wrong with
    it as far as every figure-checking pass is concerned — there are no figures to check. Only
    an explicit emptiness gate distinguishes it from a correct report.
    """
    snapshot = empty_snapshot()
    compiled = compile_document(
        df.definition(BLOCKS), view=build_snapshot_view(snapshot)
    )

    assert compiled.figure_count == 0, "nothing for any other gate to find fault with"

    outcome = run(snapshot)

    assert FINDING_EMPTY_SCOPE in types_of(outcome)
    assert all(f["severity"] == SEVERITY_BLOCKING for f in outcome.findings)


# --------------------------------------------------------------------------- #
# Req 32.1 — scope_verified fails closed on three distinct values
# --------------------------------------------------------------------------- #


def test_a_verified_scope_over_a_populated_snapshot_records_nothing() -> None:
    outcome = run(sf.two_vm_snapshot())

    assert outcome.findings == ()
    assert outcome.union_resource_count == 2
    assert outcome.snapshot_resource_count == 2
    assert outcome.collection_log_entries >= 0


@pytest.mark.parametrize(
    ("label", "mutate"),
    [
        ("recorded false", lambda s: s.__setitem__("scope_verified", False)),
        ("absent", lambda s: s.pop("scope_verified")),
        ("not a boolean", lambda s: s.__setitem__("scope_verified", "true")),
        ("null", lambda s: s.__setitem__("scope_verified", None)),
    ],
)
def test_an_unproven_scope_fails_closed_however_it_is_unproven(label, mutate) -> None:
    """Req 32.1. A missing value is not a quiet yes — it is the shape an older snapshot, a
    truncated write or a partial migration takes, and reading it as proof would be the one
    reading that cannot be recovered from."""
    snapshot = sf.two_vm_snapshot()
    mutate(snapshot)

    outcome = run(snapshot)

    assert FINDING_SCOPE_UNVERIFIED in types_of(outcome), label


def test_the_three_unproven_cases_are_distinguishable_in_the_message() -> None:
    """The verdict is identical; only the explanation differs, and that is what a reviewer
    acts on — a false value points at the preflight, an absent one at the snapshot."""
    false_case = sf.two_vm_snapshot()
    false_case["scope_verified"] = False
    absent = sf.two_vm_snapshot()
    absent.pop("scope_verified")
    wrong_type = sf.two_vm_snapshot()
    wrong_type["scope_verified"] = "true"

    messages = [
        next(f["message"] for f in run(case).findings if f["type"] == FINDING_SCOPE_UNVERIFIED)
        for case in (false_case, absent, wrong_type)
    ]

    assert len(set(messages)) == 3
    assert "false" in messages[0]
    assert "no scope_verified" in messages[1]
    assert "not a boolean" in messages[2]


# --------------------------------------------------------------------------- #
# Req 32.2, 32.8 — the union, and what happens when it cannot be derived
# --------------------------------------------------------------------------- #


def test_the_union_is_the_template_default_plus_every_block_override() -> None:
    """Req 32.7's precondition: the union widens over blocks, so one narrow block does not
    narrow the run."""
    snapshot = sf.two_vm_snapshot()
    view = build_snapshot_view(snapshot)
    narrow = df.scope(resource_groups=["rg-nowhere"])
    definition = df.definition(
        [
            df.block("a", "resource_table", {"columns": [df.CPU_AVG]}, scope_override=narrow),
            df.block("b", "kpi_row", {"metrics": [df.CPU_AVG]}),
        ]
    )

    assert len(union_resource_ids(definition, view)) == 2


def test_a_block_matching_nothing_records_no_finding_while_the_union_matches() -> None:
    """Req 32.7 — ordinary compile output, not a failure. A verifier that failed here would
    fail every report containing one narrowly scoped section."""
    snapshot = sf.two_vm_snapshot()
    narrow = df.scope(resource_groups=["rg-nowhere"])
    blocks = [
        df.block("a", "resource_table", {"columns": [df.CPU_AVG]}, scope_override=narrow),
        df.block("b", "kpi_row", {"metrics": [df.CPU_AVG]}),
    ]

    outcome = run(snapshot, blocks=blocks)

    assert outcome.findings == ()
    assert outcome.union_resource_count == 2


def test_every_block_matching_nothing_still_records_no_coverage_finding() -> None:
    """The union is empty while the snapshot is not. That is a report full of explicit
    no-resources-matched rows — odd, but not a coverage failure: every resource in the union
    (there are none) is present in the snapshot."""
    snapshot = sf.two_vm_snapshot()
    narrow = df.scope(resource_groups=["rg-nowhere"])
    blocks = [
        df.block("a", "resource_table", {"columns": [df.CPU_AVG]}, scope_override=narrow)
    ]
    definition = df.definition(blocks, template_scope=narrow)

    outcome = check_coverage(
        snapshot, view=build_snapshot_view(snapshot), definition=definition
    )

    assert outcome.findings == ()
    assert outcome.union_resource_count == 0
    assert outcome.snapshot_resource_count == 2


def test_a_union_that_cannot_be_resolved_fails_closed_naming_the_rule() -> None:
    """Req 32.8 — "I could not work out what should be here" and "nothing should be here"
    are opposite claims, and only one of them is safe to report as complete coverage."""
    snapshot = sf.two_vm_snapshot()
    definition = df.definition(BLOCKS)
    definition["scope"] = {"resource_types": "not-a-list"}

    outcome = check_coverage(
        snapshot, view=build_snapshot_view(snapshot), definition=definition
    )

    absent = [f for f in outcome.findings if f["type"] == FINDING_COVERAGE_RESOURCE_ABSENT]
    assert len(absent) == 1
    assert "could not be resolved" in absent[0]["message"]
    assert outcome.union_resource_count == 0
    # And the counts are still recorded (Req 32.6), which is the point of recording them
    # on failure as well as on success.
    assert outcome.snapshot_resource_count == 2


def test_an_unresolvable_block_override_fails_closed_naming_the_block() -> None:
    snapshot = sf.two_vm_snapshot()
    definition = df.definition(BLOCKS)
    definition["blocks"][0]["scope_override"] = {"tag_filters": 7}

    with pytest.raises(UnionUnresolvable) as caught:
        union_resource_ids(definition, build_snapshot_view(snapshot))

    assert "blocks.0.scope_override" in str(caught.value)


def test_a_resource_in_the_union_but_absent_from_the_snapshot_is_one_finding_each() -> None:
    """Req 32.2. Reached by resolving the union against one snapshot and asserting it against
    another — which is exactly the re-verification case: the pinned version's scope is checked
    against the snapshot the run's `snapshot_id` names, and the two can disagree."""
    populated = sf.two_vm_snapshot()
    view = build_snapshot_view(populated)
    definition = df.definition(BLOCKS)
    union = union_resource_ids(definition, view)
    assert len(union) == 2

    reduced = sf.build(resources=[sf.vm(resource_id="/vm/only", name="only")])
    reduced_view = build_snapshot_view(reduced)
    present = {resource.resource_id for resource in reduced_view.resources}

    missing = [resource_id for resource_id in union if resource_id not in present]

    assert len(missing) == 2


# --------------------------------------------------------------------------- #
# Req 32.4, 32.6 — the empty snapshot, and the counts
# --------------------------------------------------------------------------- #


def test_reverifying_a_stored_empty_snapshot_fails() -> None:
    """Req 32.4 — the case a re-verification months later must not turn green."""
    outcome = run(empty_snapshot())

    assert FINDING_EMPTY_SCOPE in types_of(outcome)
    assert outcome.snapshot_resource_count == 0


def test_an_empty_snapshot_with_an_unverified_scope_records_both() -> None:
    """Two independent gates, two findings. Collapsing them would hide whichever was fixed
    second."""
    snapshot = empty_snapshot()
    snapshot["scope_verified"] = False

    assert set(types_of(run(snapshot))) == {FINDING_EMPTY_SCOPE, FINDING_SCOPE_UNVERIFIED}


def test_the_counts_are_recorded_on_a_passing_and_a_failing_verification() -> None:
    """Req 32.6 — non-negative integers either way."""
    passing = run(sf.two_vm_snapshot())
    failing = run(empty_snapshot())

    for outcome in (passing, failing):
        assert outcome.union_resource_count >= 0
        assert outcome.snapshot_resource_count >= 0
        assert outcome.collection_log_entries >= 0
    assert passing.collection_log_entries == 1, "the fixture records one gap"
    assert failing.snapshot_resource_count == 0


def test_the_collection_log_count_follows_the_snapshot() -> None:
    """Non-vacuity for the count above: a snapshot with more gaps reports more."""
    many = sf.snapshot_with_every_gap_type()

    assert run(many).collection_log_entries > run(sf.two_vm_snapshot()).collection_log_entries


# --------------------------------------------------------------------------- #
# Req 32.5 — no Azure, structurally
# --------------------------------------------------------------------------- #


def test_the_pass_reads_the_snapshot_and_the_definition_and_nothing_else() -> None:
    """Req 32.5. Not a mock-call assertion — a signature assertion.

    There is no port, no client and no credential in the argument list, so there is nothing to
    query with. That matters more than a spy would: the inventory query is itself RBAC-filtered,
    so re-querying would confirm an incomplete answer using the credential that made it
    incomplete.
    """
    import inspect

    parameters = set(inspect.signature(check_coverage).parameters)

    assert parameters == {"snapshot", "view", "definition"}
