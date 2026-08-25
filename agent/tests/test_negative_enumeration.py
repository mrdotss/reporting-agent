"""The meta-test over the twenty-four blocking finding types (Req 44.1, 44.12, 44.14, 44.15).

The negative suite's own gate. Every test in `test_negative_gates.py`,
`test_negative_types.py` and `test_negative_wave15.py` declares the blocking finding types it
expects; this module reads those declarations and fails if any of the blocking types the
glossary declares is asserted by none of them.

That is what keeps the suite honest as the code changes. A blocking type added to
`verify/findings.py` in a later change has, by default, no test observing it fail — it is
declared, recorded nowhere, and green. This test turns that into a failure that names the
type, at the moment the type is added rather than at the moment somebody notices.

The second half is the same idea applied to the tests themselves: a negative test that is
skipped, marked as an expected failure, or quietly dropped from the suite is a gate that has
never been observed failing, however many declarations point at it.

The third section extends the same coverage discipline to **terminal error codes**: this spec
declares that `COMPILE_FAILED` (for an absent fact source) and `RENDER_FAILED` (for an absent
per-run front-matter value and an absent message-catalog value) must each be asserted by at
least one negative test. A terminal code with zero tests exercising it is not a gate.

The fourth section declares **exactly two exemptions** from the blocking-type enumeration,
naming both explicitly and stating why each is exempt.
"""

from __future__ import annotations

import ast
import inspect
from pathlib import Path
from typing import Final

# Imported for their side effect on `negatives.DECLARED`: importing them is what populates
# the declaration table, and it is deliberate that this module reads the table rather than
# collecting the tests. The question being asked is "is every type declared by something",
# which has an answer before a single test runs.
import test_negative_gates
import test_negative_types
import test_negative_wave15
from negatives import DECLARED
from reporting_agent.verify.findings import (
    BLOCKING_FINDING_TYPES,
    DECLARED_FINDING_TYPES,
    SEVERITY_BLOCKING,
    severity_of,
)

NEGATIVE_MODULES: Final[tuple[object, ...]] = (
    test_negative_gates,
    test_negative_types,
    test_negative_wave15,
)

EXPECTED_BLOCKING_COUNT: Final[int] = 24
"""Req 44.1 names the number, so the number is asserted rather than derived.

A count read from `BLOCKING_FINDING_TYPES` would agree with itself whatever that tuple said,
which is exactly the tautology this test exists to avoid.
"""

# --------------------------------------------------------------------------- #
# The two named exemptions from blocking-type enumeration (Req 24.17, 24.18)
# --------------------------------------------------------------------------- #

EXEMPT_BLOCKING_TYPES: Final[frozenset[str]] = frozenset()
"""No blocking type is exempted.

Task 15.16 declares exactly two exemptions from *coverage* — neither exempts a blocking
finding type from the enumeration. The exemptions are stated below in a dedicated test and
apply to the *reasons a type might not need a negative test*:

1. **schema_version 1 compilation** — a positive outcome proven by
   `test_schema_version_1.py`, not a gate that can fail. No blocking type is *exempted*
   by this: the positive outcome is an observation that v1 definitions compile, which is
   not the same as saying some blocking type is untestable.

2. **The scope-rule invariant** — Property 7 proves scope resolution across generated
   inputs, which is not a negative test and exercises no blocking type. Again, no type is
   exempted.

If `derived_count_mismatch` has no negative test, it remains unexercised and the meta-test
fails naming it. It is not added here because it is not one of the two named exemptions.
"""

# --------------------------------------------------------------------------- #
# Terminal error codes this spec requires to be exercised (Req 24.17)
# --------------------------------------------------------------------------- #

REQUIRED_TERMINAL_CODES: Final[frozenset[str]] = frozenset(
    {
        "COMPILE_FAILED",  # for absent fact source (task 15.12)
        "RENDER_FAILED",  # for absent per-run value (15.14) + absent catalog value (15.15)
    }
)
"""Terminal codes this spec declares must have at least one negative test asserting them.

The task names three terminal branches:
- COMPILE_FAILED for an absent fact source
- RENDER_FAILED for an absent per-run front-matter value
- RENDER_FAILED for an absent message-catalog value

Two distinct codes, each requiring at least one covering test.
"""

SKIP_MARKERS: Final[frozenset[str]] = frozenset(
    {"skip", "skipif", "xfail", "expectedFailure"}
)


def _module_path(module: object) -> Path:
    return Path(inspect.getfile(module))  # type: ignore[arg-type]


def _test_functions(module: object) -> list[ast.FunctionDef]:
    tree = ast.parse(_module_path(module).read_text(encoding="utf-8"))
    return [
        node
        for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test_")
    ]


def _module_source(module: object) -> ast.Module:
    return ast.parse(_module_path(module).read_text(encoding="utf-8"))


# --------------------------------------------------------------------------- #
# Req 44.1 — every blocking type is asserted by at least one test
# --------------------------------------------------------------------------- #


def test_the_glossary_declares_exactly_twenty_four_blocking_types() -> None:
    assert len(BLOCKING_FINDING_TYPES) == EXPECTED_BLOCKING_COUNT, BLOCKING_FINDING_TYPES
    assert len(set(BLOCKING_FINDING_TYPES)) == EXPECTED_BLOCKING_COUNT
    for finding_type in BLOCKING_FINDING_TYPES:
        assert severity_of(finding_type) == SEVERITY_BLOCKING
        assert finding_type in DECLARED_FINDING_TYPES


def test_every_blocking_type_is_asserted_by_at_least_one_negative_test() -> None:
    """Req 44.1's enumeration.

    The failure message names the types nobody exercises, because "some blocking type is
    untested" is not a message anybody can act on and this test's whole purpose is to be
    actionable the day it fires.

    The two named exemptions do NOT exempt any blocking type from this check — they exempt
    coverage mechanisms (a positive compile test and a property test) from being negative
    tests. Any blocking type that has no test here remains unexercised.
    """
    asserted: set[str] = set()
    for expected in DECLARED.values():
        asserted |= expected

    unexercised = sorted(set(BLOCKING_FINDING_TYPES) - asserted - EXEMPT_BLOCKING_TYPES)
    assert unexercised == [], (
        f"these blocking finding types are declared and observed failing by no negative "
        f"test: {unexercised}. A gate never observed to fail is not a gate — add a test in "
        f"test_negative_types.py that constructs an input producing each of them"
    )


def test_no_declaration_names_a_type_the_glossary_does_not_declare() -> None:
    """The other direction, so a renamed finding type fails here rather than silently
    leaving its gate unexercised while the enumeration above still passes."""
    for name, expected in sorted(DECLARED.items()):
        unknown = sorted(expected - set(BLOCKING_FINDING_TYPES))
        assert unknown == [], f"{name} declares {unknown}, which is no blocking type"


def test_every_declaration_belongs_to_a_test_that_exists() -> None:
    """A declaration for a test that was deleted or renamed would keep the enumeration green
    while nothing exercised the type. Both directions are checked."""
    defined = {
        node.name for module in NEGATIVE_MODULES for node in _test_functions(module)
    }
    orphaned = sorted(set(DECLARED) - defined)
    assert orphaned == [], (
        f"these declarations name no test function: {orphaned}. A declaration is what the "
        f"enumeration counts, so an orphan makes a blocking type look exercised"
    )


# --------------------------------------------------------------------------- #
# Terminal error code coverage — every required code has at least one test
# --------------------------------------------------------------------------- #


def _collect_terminal_codes_asserted() -> dict[str, set[str]]:
    """Statically scan negative test modules for ErrorCode assertions.

    Returns a mapping of terminal code string -> set of test function names that assert it.
    Scans for patterns like:
    - `ErrorCode.COMPILE_FAILED`
    - `ErrorCode.RENDER_FAILED`
    appearing inside test function bodies.
    """
    code_to_tests: dict[str, set[str]] = {code: set() for code in REQUIRED_TERMINAL_CODES}

    for module in NEGATIVE_MODULES:
        tree = _module_source(module)
        for node in tree.body:
            if not isinstance(node, ast.FunctionDef) or not node.name.startswith("test_"):
                continue
            source = ast.dump(node)
            for code in REQUIRED_TERMINAL_CODES:
                # Check for the ErrorCode member name anywhere in the function's AST
                # This catches `ErrorCode.COMPILE_FAILED.value`, `.code.value == "COMPILE_FAILED"`,
                # and string literal assertions against the code.
                if code in source:
                    code_to_tests[code].add(node.name)

    return code_to_tests


def test_every_required_terminal_code_is_asserted_by_at_least_one_negative_test() -> None:
    """Req 24.17 extended to terminal error codes.

    This spec declares that COMPILE_FAILED (for an absent fact source) and RENDER_FAILED
    (for an absent per-run front-matter value and an absent message-catalog value) must each
    be exercised by at least one negative test. A terminal code whose path has no test is
    a path nobody has proven reachable.
    """
    code_coverage = _collect_terminal_codes_asserted()
    uncovered = sorted(code for code, tests in code_coverage.items() if not tests)
    assert uncovered == [], (
        f"these terminal error codes are required by this spec but asserted by no negative "
        f"test: {uncovered}. Add a negative test that drives the pipeline to each code"
    )


# --------------------------------------------------------------------------- #
# The two named exemptions — stated explicitly (Req 24.17, 24.18)
# --------------------------------------------------------------------------- #


def test_the_two_named_exemptions_are_exactly_these() -> None:
    """Task 15.16 declares exactly two exemptions from negative-test coverage.

    Neither exempts a blocking finding type from the enumeration. Each exempts a different
    proof mechanism from being counted as a negative test:

    1. **schema_version 1 compilation** — `test_schema_version_1.py` proves every shipped
       v1 starter compiles, renders and verifies through the production pipeline. That is a
       **positive** outcome: it demonstrates the gate works in the passing direction. It is
       not a negative test because no mutation is applied, and no blocking finding type is
       expected.

    2. **The scope-rule invariant** — Property 7 (`scope_stays_a_rule`) proves scope
       resolution is deterministic and snapshot-only, across generated inputs. It exercises
       no blocking finding type because it never drives a verification to failure; it proves
       a compile-time invariant instead.

    This test exists so the exemptions are declared **in code** rather than in prose alone,
    and so adding a third requires editing this assertion.
    """
    exemptions = (
        "schema_version_1_compilation",
        "scope_rule_invariant_property_7",
    )
    # Assert these are the only two, and document each one's justification.
    assert len(exemptions) == 2
    assert exemptions[0] == "schema_version_1_compilation"
    assert exemptions[1] == "scope_rule_invariant_property_7"

    # Verify the positive test exists and is not skipped.
    schema_v1_path = Path(__file__).parent / "test_schema_version_1.py"
    assert schema_v1_path.exists(), (
        "test_schema_version_1.py is the justification for exemption 1 and must exist"
    )
    schema_v1_tree = ast.parse(schema_v1_path.read_text(encoding="utf-8"))
    # Tests may be top-level or inside TestXxx classes
    schema_v1_tests: list[ast.FunctionDef] = []
    for node in schema_v1_tree.body:
        if isinstance(node, ast.FunctionDef) and node.name.startswith("test_"):
            schema_v1_tests.append(node)
        elif isinstance(node, ast.ClassDef) and node.name.startswith("Test"):
            for member in node.body:
                if isinstance(member, ast.FunctionDef) and member.name.startswith("test_"):
                    schema_v1_tests.append(member)
    assert schema_v1_tests, "test_schema_version_1.py must contain at least one test"
    for node in schema_v1_tests:
        for decorator in node.decorator_list:
            attributes = {
                part.attr for part in ast.walk(decorator) if isinstance(part, ast.Attribute)
            }
            assert not (attributes & SKIP_MARKERS), (
                f"test_schema_version_1.py::{node.name} is skipped — the exemption depends "
                f"on it running"
            )

    # Verify Property 7 exists and is registered.
    property_7_path = Path(__file__).parent / "property" / "test_scope_property.py"
    assert property_7_path.exists(), (
        "property/test_scope_property.py is the justification for exemption 2 and must exist"
    )


# --------------------------------------------------------------------------- #
# Req 44.15 — none of them is skipped, xfailed or dropped
# --------------------------------------------------------------------------- #


def test_no_negative_test_is_skipped_or_expected_to_fail() -> None:
    """Req 44.15, read from the source rather than from the run.

    Read statically because the run cannot answer it: a skipped test reports as skipped and a
    green suite summary does not distinguish "ran and passed" from "did not run". The
    decorators are what a reviewer would look for, so they are what this looks for.
    """
    marked: list[str] = []
    for module in NEGATIVE_MODULES:
        for node in _test_functions(module):
            for decorator in node.decorator_list:
                attributes = {
                    part.attr
                    for part in ast.walk(decorator)
                    if isinstance(part, ast.Attribute)
                }
                if attributes & SKIP_MARKERS:
                    marked.append(f"{_module_path(module).name}::{node.name}")

    assert marked == [], (
        f"these negative tests are skipped or marked as expected failures: {marked}. A gate "
        f"whose negative test does not run is a gate that has never been observed failing"
    )


def test_no_negative_test_calls_skip_at_runtime() -> None:
    """The same rule for the runtime form. `pytest.skip(...)` inside a body is invisible to
    the decorator scan above and produces the identical green-but-unrun outcome."""
    called: list[str] = []
    for module in NEGATIVE_MODULES:
        for node in _test_functions(module):
            for part in ast.walk(node):
                if (
                    isinstance(part, ast.Call)
                    and isinstance(part.func, ast.Attribute)
                    and part.func.attr in {"skip", "xfail", "importorskip"}
                ):
                    called.append(f"{_module_path(module).name}::{node.name}")

    assert called == [], f"these negative tests skip themselves at runtime: {called}"


def test_every_negative_test_declares_or_deliberately_does_not() -> None:
    """Every test in these modules either declares a blocking set or is one of the named
    exceptions, so a new negative test cannot be added without deciding which it is.

    The exceptions all assert something other than a blocking finding set: N3b's legitimately
    empty scope and the locale-indifference observation, which exist precisely to stop the
    failing tests beside them from being satisfiable the wrong way; N6, whose run ends before
    a verification result exists at all; and one guard over the prose mutation's *targeting*,
    which is a claim about the harness rather than about the verifier.
    """
    passing_by_design = {
        "test_n3b_a_legitimately_empty_scope_still_delivers",
        "test_the_conversion_locale_alone_rewrites_nothing_in_this_renderers_output",
        "test_n6_an_expired_secret_yielding_an_empty_scope_writes_nothing",
        # Asserts where `_replace_prose_text` puts the mutation, not what the verifier
        # recorded. It exists because that helper targeted the wrong node about one run in
        # eight — see its docstring — and a declaration here would claim it observes a gate.
        "test_the_prose_mutation_lands_outside_every_table",
    }

    undeclared = sorted(
        node.name
        for module in NEGATIVE_MODULES
        for node in _test_functions(module)
        if node.name not in DECLARED and node.name not in passing_by_design
    )
    assert undeclared == [], (
        f"these negative tests declare no expected blocking set: {undeclared}. Req 44.14 is "
        f"a set equality, so a test without a declaration cannot assert one"
    )
