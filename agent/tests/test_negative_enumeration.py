"""The meta-test over the sixteen blocking finding types (Req 44.1, 44.12, 44.14, 44.15).

The negative suite's own gate. Every test in `test_negative_gates.py` and
`test_negative_types.py` declares the blocking finding types it expects; this module reads
those declarations and fails if any of the sixteen types the glossary declares is asserted by
none of them.

That is what keeps the suite honest as the code changes. A blocking type added to
`verify/findings.py` in a later change has, by default, no test observing it fail — it is
declared, recorded nowhere, and green. This test turns that into a failure that names the
type, at the moment the type is added rather than at the moment somebody notices.

The second half is the same idea applied to the tests themselves: a negative test that is
skipped, marked as an expected failure, or quietly dropped from the suite is a gate that has
never been observed failing, however many declarations point at it.
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
from negatives import DECLARED
from reporting_agent.verify.findings import (
    BLOCKING_FINDING_TYPES,
    DECLARED_FINDING_TYPES,
    SEVERITY_BLOCKING,
    severity_of,
)

NEGATIVE_MODULES: Final[tuple[object, ...]] = (test_negative_gates, test_negative_types)

EXPECTED_BLOCKING_COUNT: Final[int] = 24
"""Req 44.1 names the number, so the number is asserted rather than derived.

A count read from `BLOCKING_FINDING_TYPES` would agree with itself whatever that tuple said,
which is exactly the tautology this test exists to avoid.
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


# --------------------------------------------------------------------------- #
# Req 44.1 — every blocking type is asserted by at least one test
# --------------------------------------------------------------------------- #


def test_the_glossary_declares_exactly_twenty_three_blocking_types() -> None:
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
    """
    asserted: set[str] = set()
    for expected in DECLARED.values():
        asserted |= expected

    unexercised = sorted(set(BLOCKING_FINDING_TYPES) - asserted)
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
