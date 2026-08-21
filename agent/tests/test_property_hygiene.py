"""Hygiene guards for the agent-side properties themselves (Req 42.2, 42.6, 42.8).

A property test that passes by testing nothing is worse than no test, because it reports
green. Every rule here exists to make one specific way of doing that a failure:

1. **No property is skipped or expected to fail** (Req 42.6). `@pytest.mark.skip`,
   `skipif`, `xfail`, a bare `pytest.skip(...)` in the body, and a leftover
   `@reproduce_failure(...)` — which replaces generation with one recorded example — are
   all rejected.
2. **No property declares fewer than 100 examples** (Req 42.2). `conftest.py` sets
   `max_examples=100` as the profile floor, so the failure mode is a per-test
   `@settings(max_examples=…)` that lowers it. A local override is permitted only if it
   raises the count.
3. **No property suppresses a filtering health check** (Req 42.6).
   `HealthCheck.filter_too_much` and `HealthCheck.data_too_large` are the mechanism by
   which hypothesis fails a property whose preconditions discard nearly every generated
   input. `suppress_health_check` must therefore appear nowhere — not in the profile, not
   on a test.
4. **A fixed counterexample stays fixed** (Req 42.8). Retention is enforced as a
   **ratchet**: {@link MINIMUM_DECLARED_EXAMPLES} records how many `@example` decorators
   each property module carries today, and the count may only grow. Adding an example is
   free; deleting one fails.

   A floor rather than "every property must carry an `@example`", because Req 42.8 is
   conditional — it obliges retention *when a defect was fixed* — and two of the 35
   properties here legitimately carry none: they assert a structural identity over
   generated input with no falsifying case to pin. A blanket rule would push a
   ceremonial `@example` onto them, which teaches the suite to satisfy the guard rather
   than the requirement. The ratchet enforces exactly what the requirement says: an
   example that was written down stays written down and keeps running.

Rules 1 to 3 are `ast`-based, and matched on **decorators and calls, not text**: every
one of these names appears in the prose of `conftest.py` and of the property modules,
explaining why it is absent, so a text scan would fail on the tree that documents the
rules best. Rule 4 counts decorators the same way.

Two further rules read what the run actually **did** rather than what the source says,
because the four above share one blind spot: every one of them passes over a property that
was written correctly and never executed.

5. **The set of properties executed equals the set this spec declares** (Req 45.7).
   `tests/property_ledger.py` names the agent-side set — design.md's Properties 1 to 7 —
   and the two foundation properties this spec re-runs as a regression gate. A property
   added to design.md and never registered fails, a module registered and absent from the
   tree fails, and a module in the tree belonging to no property fails.
6. **Each property records its framework, its accepted-example count, its precondition
   rejection fraction and its seed** (Req 45.8), taken from hypothesis's own statistics
   stream by `conftest.py` and printed in the terminal summary. Req 45.4's thresholds —
   100 accepted, generation not exhausted early, at most 20% rejected through a
   precondition — are then read off that ledger, so they are observable rather than
   assumed.

   Rule 6 is also what makes **the regression gate** (Req 45.2, 45.9) checkable: the
   foundation's Property 1 (count-weighted averaging, exact minimum and maximum roll-up)
   and Property 6 (local-day bucketing at the `Asia/Jakarta` UTC+07:00 offset) must be
   present, must execute at 100 accepted examples or more, and must be byte-for-byte the
   files the foundation committed — a digest, because "with their generators, their
   assertions and their declared examples unmodified" has no other machine-readable form.

There is also a **runtime** check of the loaded profile, because a static read of
`conftest.py` proves what was written and not what took effect: a second
`load_profile(...)` anywhere, or a `-p no:cacheprovider`-style surprise, would leave the
source correct and the run at 10 examples.

The scan structure, helpers and naming follow `tests/test_boundaries.py`. One idiom,
three guards.
"""

from __future__ import annotations

import ast
from pathlib import Path
from typing import NamedTuple

import pytest
from hypothesis import HealthCheck, settings

import property_ledger

AGENT_ROOT = Path(__file__).resolve().parent.parent
PROPERTY_ROOT = AGENT_ROOT / "tests" / "property"
CONFTEST = AGENT_ROOT / "tests" / "conftest.py"

# Req 42.2 — the floor, applied by the profile and re-asserted per test here.
MINIMUM_EXAMPLES = 100

# The decorator that marks a hypothesis property. Matched on the trailing segment, so
# `given`, `hypothesis.given` and `hyp.given` all count.
GIVEN = "given"
EXAMPLE = "example"
SETTINGS = "settings"

# Req 42.6 — the two health checks that must never be suppressed, and the keyword that
# would do it.
SUPPRESS_KEYWORD = "suppress_health_check"
REQUIRED_HEALTH_CHECKS = (HealthCheck.filter_too_much, HealthCheck.data_too_large)

# A recorded-failure replay decorator. Legitimate for ten minutes on one machine while
# reproducing a failure; committed, it replaces generation with a single example.
REPRODUCE_FAILURE = "reproduce_failure"

# Markers that stop a property from running, or accept its failure.
SKIPPING_MARKS = frozenset({"skip", "skipif", "xfail"})

# Req 42.8 — the ratchet. The number of `@example` decorators each property module
# carries. Raise an entry when a counterexample is added; never lower one.
#
# Every module in `tests/property/` must appear here, which is what stops a new property
# module from arriving unguarded — the exhaustiveness assertion below covers that
# direction, so the map cannot silently fall behind the tree.
MINIMUM_DECLARED_EXAMPLES: dict[str, int] = {
    "test_accumulate_property.py": 11,
    # The four Req 2.7 near-miss spellings the design declares, each asserting rejection,
    # plus the missing-fixture case of Req 2.4.
    "test_catalog_evidence_property.py": 4,
    "test_buckets_property.py": 10,
    "test_metrics_property.py": 9,
    "test_redaction_property.py": 26,
    # 21 as generated, plus the 5 retained counterexamples of Property 3.5's
    # single-sample near-edge defect (see the block above the examples in that file).
    "test_sketch_property.py": 26,
    "test_snapshot_property.py": 5,
    # Property 2's three declared cases: the substring-shadowed ledger pair
    # (12.4% inside 112.4%), the same pair on the longest-first property, and the
    # three-run split of `1,234.56`. The two counterexamples Property 2 found against
    # the first implementation — a one-character allowlist entry punching a hole in an
    # unrelated token, and a GUID shredded by the identifier stage — are pinned as
    # named cases in `tests/test_verify_masking.py` rather than as `@example`
    # decorators, because both are about a fixed literal rather than a generated draw
    # and a generator that produced them would be a generator written backwards from
    # the answer.
    "test_tokens_property.py": 3,
    # Property 3's five declared cases. Three are the scale clause of Req 27 pinned as
    # examples rather than left to generation — 40 columns, 500 rows, and the degenerate
    # 1 × 0 table — because a 40 × 500 grid generated a hundred times would put the module
    # into the minutes for no additional coverage. The other two are the arguments the
    # module exists to make: the two-column table whose values are transposed across every
    # row (asserting the anchored pass fails *and* a containment check reports nothing),
    # and a four-column permutation carrying its headers, which is the case a positional
    # implementation gets backwards.
    "test_anchors_property.py": 5,
    # Property 4's one declared case: the minimal archive — one object, one resource, one
    # metric, one well-formed interval — pinned on the mutation property so a failure
    # there is readable rather than a shrink over a 24-object archive.
    "test_replay_property.py": 1,
    # Property 5's four declared cases. Three are the scale clause pinned deterministically
    # — 400 and 2,000 resources, where a "10% with no cap" selector would take 40 and 200,
    # and the degenerate empty snapshot — plus 400 again on the two-seed property, which is
    # the one a selector ignoring the seed fails.
    "test_drift_property.py": 4,
    # Property 6's four declared cases: the 60-block definition pinned on the three
    # compile-only properties, so the scale clause runs deterministically rather than
    # being generated into occasionally, and Req 3.7's named case — every block's scope
    # matching nothing while the union matches one resource.
    "test_ledger_property.py": 4,
    # Property 1's seven declared examples: 0, 0.000001, -0.5, 9007199254740993, 0.1,
    # 0.30000000000000004, and a number format whose decimal separator is `,` and
    # grouping separator is `.` — the last of which kills a formatter hard-coding
    # separators, and 0.30000000000000004 a formatter round-tripping through a binary
    # float. Either would fail verification on a report that is correct.
    "test_format_property.py": 7,
    # Property 7's three declared cases — a top-N metric missing for half the matched
    # resources, tag filters differing from the resource's tags only by the value's case
    # (no match) and only by the key's case (match) — plus the missing-metric case reused
    # on the permutation-invariance property, where an implementation that ordered by
    # arrival would show up as a different ranking for the same snapshot.
    "test_scope_property.py": 4,
    # The two cases the Req 5.4 narrowing's case-sensitivity defect was found with: the
    # lowercase respelling Resource Graph actually returns, and a swapped-case one that
    # disagrees with the catalog in both directions at once. Both on the fixture carrying
    # block scope overrides, so the scope union is assembled from more than one place.
    "test_metric_narrowing_property.py": 2,
}

# The sum of the map, restated so the total is pinned as well as each part. Recorded from
# the tree rather than computed from the map, so a whole entry deleted from the map is
# caught by the same assertion that catches an example deleted from a module.
MINIMUM_DECLARED_EXAMPLES_TOTAL = 114


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #


class Property(NamedTuple):
    """One hypothesis property: a function carrying a `@given` decorator."""

    module: Path
    name: str
    lineno: int
    node: ast.FunctionDef | ast.AsyncFunctionDef

    @property
    def label(self) -> str:
        return f"{_label(self.module)}:{self.lineno} {self.name}"


def _label(path: Path) -> str:
    """Agent-relative where possible; guard-the-guard cases live under `tmp_path`."""
    try:
        return str(path.relative_to(AGENT_ROOT))
    except ValueError:
        return str(path)


def _parse(path: Path) -> ast.Module:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _property_modules(root: Path = PROPERTY_ROOT) -> list[Path]:
    """Every property module. `__init__.py` is package plumbing, not a property."""
    return sorted(p for p in root.glob("*.py") if p.name != "__init__.py")


def _decorator_name(node: ast.expr) -> str:
    """The trailing dotted segment of a decorator, called or not.

    `@given(...)` → `given`; `@hypothesis.given(...)` → `given`;
    `@pytest.mark.skip` → `skip`. Matching the last segment rather than the full path is
    what makes the rules independent of how a module chose to import.
    """
    target = node.func if isinstance(node, ast.Call) else node
    while isinstance(target, ast.Attribute):
        return target.attr
    return target.id if isinstance(target, ast.Name) else ""


def _decorator_names(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    return [_decorator_name(d) for d in node.decorator_list]


def _is_pytest_mark(node: ast.expr) -> bool:
    """True for `@pytest.mark.<something>`, called or not."""
    target = node.func if isinstance(node, ast.Call) else node
    if not isinstance(target, ast.Attribute):
        return False
    return isinstance(target.value, ast.Attribute) and target.value.attr == "mark"


def _properties(modules: list[Path]) -> list[Property]:
    """Every `@given`-decorated function in these modules, nested ones included."""
    found: list[Property] = []
    for path in modules:
        for node in ast.walk(_parse(path)):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef) and GIVEN in _decorator_names(node):
                found.append(Property(path, node.name, node.lineno, node))
    return found


def _declared_example_count(path: Path) -> int:
    """How many `@example(...)` decorators this module carries, on any function."""
    total = 0
    for node in ast.walk(_parse(path)):
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
            total += sum(1 for name in _decorator_names(node) if name == EXAMPLE)
    return total


# --- The four offender scans ------------------------------------------------ #


def _skip_offenders(properties: list[Property]) -> list[str]:
    """Req 42.6 — a property that does not run, or whose failure is accepted."""
    offenders: list[str] = []
    for prop in properties:
        for decorator in prop.node.decorator_list:
            name = _decorator_name(decorator)
            if name in SKIPPING_MARKS and _is_pytest_mark(decorator):
                offenders.append(f"{prop.label} @pytest.mark.{name}")
            elif name == REPRODUCE_FAILURE:
                offenders.append(f"{prop.label} @{REPRODUCE_FAILURE}")

        for node in ast.walk(prop.node):
            if not isinstance(node, ast.Call):
                continue
            target = node.func
            if isinstance(target, ast.Attribute) and target.attr in {"skip", "xfail"}:
                if isinstance(target.value, ast.Name) and target.value.id == "pytest":
                    offenders.append(f"{prop.label} calls pytest.{target.attr}()")
    return offenders


def _module_level_skip_offenders(modules: list[Path]) -> list[str]:
    """A module-wide `pytestmark = pytest.mark.skip` skips every property in the file.

    Worth its own rule: it is invisible from any individual property's decorators, which
    is exactly where a reader looks.
    """
    offenders: list[str] = []
    for path in modules:
        for node in ast.walk(_parse(path)):
            if not isinstance(node, ast.Assign):
                continue
            if not any(
                isinstance(t, ast.Name) and t.id == "pytestmark" for t in node.targets
            ):
                continue
            values = node.value.elts if isinstance(node.value, ast.List | ast.Tuple) else [node.value]
            for value in values:
                name = _decorator_name(value)
                if name in SKIPPING_MARKS:
                    offenders.append(f"{_label(path)}:{node.lineno} pytestmark {name}")
    return offenders


def _lowered_example_offenders(properties: list[Property]) -> list[str]:
    """Req 42.2 — a local `@settings(max_examples=…)` below the profile floor.

    A non-literal value is an offender too. The guard cannot evaluate an expression, and
    failing closed on one it cannot read is the only answer that keeps the rule honest.
    """
    offenders: list[str] = []
    for prop in properties:
        for decorator in prop.node.decorator_list:
            if _decorator_name(decorator) != SETTINGS:
                continue
            if not isinstance(decorator, ast.Call):
                continue
            for keyword in decorator.keywords:
                if keyword.arg != "max_examples":
                    continue
                value = keyword.value
                if not (isinstance(value, ast.Constant) and isinstance(value.value, int)):
                    offenders.append(
                        f"{prop.label} declares max_examples as an expression the guard "
                        f"cannot read: {ast.unparse(value)}"
                    )
                elif value.value < MINIMUM_EXAMPLES:
                    offenders.append(
                        f"{prop.label} declares max_examples={value.value}, "
                        f"below the floor of {MINIMUM_EXAMPLES}"
                    )
    return offenders


def _suppression_offenders(modules: list[Path]) -> list[str]:
    """Req 42.6 — `suppress_health_check` used as a keyword anywhere in these modules."""
    offenders: list[str] = []
    for path in modules:
        for node in ast.walk(_parse(path)):
            if isinstance(node, ast.keyword) and node.arg == SUPPRESS_KEYWORD:
                offenders.append(f"{_label(path)} passes {SUPPRESS_KEYWORD}")
            elif (
                isinstance(node, ast.Assign)
                and any(
                    isinstance(t, ast.Name) and t.id == SUPPRESS_KEYWORD
                    for t in node.targets
                )
            ):
                offenders.append(f"{_label(path)}:{node.lineno} assigns {SUPPRESS_KEYWORD}")
    return offenders


def _write(root: Path, relative: str, source: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# The scan sees something (the failure mode these guards are most prone to)
# --------------------------------------------------------------------------- #


def test_the_scan_finds_the_property_modules_and_their_properties() -> None:
    """Unlike `tests/test_boundaries.py`, this guard *does* assert non-emptiness.

    That guard has to be correct over a tree whose packages are still empty. These
    properties all exist — sections 9 and 11 landed them — so an empty scan here is a
    broken guard rather than a sparse tree.
    """
    assert PROPERTY_ROOT.is_dir(), PROPERTY_ROOT

    modules = _property_modules()
    assert modules, f"no property modules found under {PROPERTY_ROOT}"

    properties = _properties(modules)
    assert len(properties) >= len(modules), (
        "every property module must contribute at least one @given property; "
        f"found {len(properties)} across {len(modules)} modules"
    )

    # Named anchors: the six properties the design declares, one module each. A listing
    # that stopped reaching one of them would leave every rule below green over five.
    assert {path.name for path in modules} >= set(MINIMUM_DECLARED_EXAMPLES)


def test_every_property_module_is_registered_in_the_examples_ratchet() -> None:
    """Exhaustive in the direction that matters: a new module must be registered.

    Not the other direction — a module named in the map but absent from the tree fails
    the ratchet test below with a clearer message than an equality assertion here.
    """
    unregistered = {p.name for p in _property_modules()} - set(MINIMUM_DECLARED_EXAMPLES)
    assert not unregistered, (
        "these property modules carry no entry in MINIMUM_DECLARED_EXAMPLES, so their "
        "declared counterexamples are not ratcheted (Req 42.8); add each one with its "
        f"current @example count: {sorted(unregistered)}"
    )


# --------------------------------------------------------------------------- #
# Req 42.6 — no property is skipped, and none suppresses a filtering health check
# --------------------------------------------------------------------------- #


def test_no_property_is_skipped_or_expected_to_fail() -> None:
    offenders = _skip_offenders(_properties(_property_modules()))
    assert not offenders, (
        "a property that does not run reports green while proving nothing (Req 42.6); "
        "these are skipped, expected to fail, or replaying one recorded example:\n  "
        + "\n  ".join(offenders)
    )


def test_no_property_module_is_skipped_wholesale() -> None:
    offenders = _module_level_skip_offenders(_property_modules())
    assert not offenders, (
        "a module-level pytestmark skips every property in the file, invisibly from any "
        "one property's decorators:\n  " + "\n  ".join(offenders)
    )


# --------------------------------------------------------------------------- #
# Req 14.2 — the TOC proof may not be skipped either, and it is not a property
# --------------------------------------------------------------------------- #
#
# Everything above sweeps `tests/property/`. This one rule reaches outside it, at a module
# named explicitly, because criterion 14.2 makes the same demand of a test that is not a
# property: *"SHALL fail IF that test is absent, is skipped or is marked as an expected
# failure."*
#
# Named rather than swept, and the narrowness is the point. A rule banning `skipif` across
# the whole suite would be wrong — `tests/test_pdf.py` and several others legitimately skip
# on a missing binary, and `test_toc_harness.py` skips its LibreOffice cases the same way.
# What criterion 14.2 says is that **this** test does not get that latitude: a green suite on
# a machine with no converter has not proven that a page number in a delivered document is
# true, which is the one claim the whole table-of-contents evaluation exists to establish.
#
# So the module carries the cost instead: it asserts `soffice` is present rather than
# skipping. This rule is what stops that from being quietly relaxed into a skip later.

UNSKIPPABLE_MODULES: tuple[str, ...] = ("test_toc_proof.py",)
"""Modules outside `tests/property/` that criterion 14.2 forbids skipping.

A tuple with one member today. It is a declared list rather than a scan because the property
being asserted is *"this specific test always runs"*, and only a requirement can say which
tests those are — inferring it from the tree would make the rule a description of whatever
happens to be there."""


def _named_module_paths() -> list[Path]:
    return [AGENT_ROOT / "tests" / name for name in UNSKIPPABLE_MODULES]


def _named_module_skip_offenders(modules: list[Path]) -> list[str]:
    """Every skip route in `modules`: a decorator on any test, a module-level `pytestmark`,
    or a `pytest.skip` / `pytest.xfail` call in a body.

    Reuses the same three detectors the property rules use rather than a fourth scan, so a
    skip spelling that fools this rule would have to fool those too.
    """
    offenders = list(_module_level_skip_offenders(modules))

    for path in modules:
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                for decorator in node.decorator_list:
                    name = _decorator_name(decorator)
                    if name in SKIPPING_MARKS and _is_pytest_mark(decorator):
                        offenders.append(
                            f"{_label(path)}:{node.lineno} {node.name} @{name}"
                        )
            elif isinstance(node, ast.Call):
                target = node.func
                if (
                    isinstance(target, ast.Attribute)
                    and target.attr in {"skip", "xfail"}
                    and isinstance(target.value, ast.Name)
                    and target.value.id == "pytest"
                ):
                    offenders.append(
                        f"{_label(path)}:{node.lineno} pytest.{target.attr}(...)"
                    )
    return offenders


def test_the_unskippable_modules_exist_and_hold_tests() -> None:
    """A rule over an absent module is a rule that passes by scanning nothing — and criterion
    14.2 names *absence* as one of the three failures, so this is the requirement's own first
    clause rather than only a guard-the-guard."""
    for path in _named_module_paths():
        assert path.is_file(), (
            f"{path.name} is declared unskippable and does not exist; criterion 14.2 fails "
            f"the suite if the proof test is absent"
        )
        tree = _parse(path)
        tests = [
            node
            for node in ast.walk(tree)
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
            and node.name.startswith("test_")
        ]
        assert tests, f"{path.name} declares no test function"


def test_no_unskippable_module_is_skipped_or_expected_to_fail() -> None:
    offenders = _named_module_skip_offenders(_named_module_paths())
    assert not offenders, (
        "criterion 14.2 fails the suite if the table-of-contents proof is skipped or marked "
        "as an expected failure; a page number nothing proved is a claim this product does "
        "not make:\n  " + "\n  ".join(offenders)
    )


def test_no_unskippable_module_declares_a_bare_pass_body() -> None:
    """The third route to a test that proves nothing, and the quietest: a body that is only
    `pass`, or only a docstring, reports green having asserted nothing at all."""
    offenders: list[str] = []
    for path in _named_module_paths():
        for node in ast.walk(_parse(path)):
            if not (
                isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
                and node.name.startswith("test_")
            ):
                continue
            body = [
                statement
                for statement in node.body
                if not (
                    isinstance(statement, ast.Expr)
                    and isinstance(statement.value, ast.Constant)
                    and isinstance(statement.value.value, str)
                )
            ]
            if not body or all(isinstance(statement, ast.Pass) for statement in body):
                offenders.append(f"{_label(path)}:{node.lineno} {node.name}")

    assert not offenders, (
        "these tests in an unskippable module have empty bodies, which is a skip spelled "
        "without a marker:\n  " + "\n  ".join(offenders)
    )


def test_no_property_declares_fewer_examples_than_the_floor() -> None:
    offenders = _lowered_example_offenders(_properties(_property_modules()))
    assert not offenders, (
        f"every agent-side property runs at least {MINIMUM_EXAMPLES} generated examples "
        "(Req 42.2); the profile sets that floor and these override it downwards:\n  "
        + "\n  ".join(offenders)
    )


def test_no_property_module_suppresses_a_health_check() -> None:
    offenders = _suppression_offenders(_property_modules())
    assert not offenders, (
        "HealthCheck.filter_too_much and HealthCheck.data_too_large are how hypothesis "
        "fails a property whose preconditions discard nearly every generated input "
        "(Req 42.6); suppressing either turns that failure into a green run over almost "
        "nothing:\n  " + "\n  ".join(offenders)
    )


def test_the_profile_does_not_suppress_a_health_check_either() -> None:
    """The same rule at the one place it would apply to all 35 properties at once."""
    offenders = _suppression_offenders([CONFTEST])
    assert not offenders, (
        f"{_label(CONFTEST)} must register no suppress_health_check: it would apply to "
        "every property in the suite:\n  " + "\n  ".join(offenders)
    )


# --------------------------------------------------------------------------- #
# Req 42.2 / 42.4 / 42.6 — the profile that actually took effect
# --------------------------------------------------------------------------- #


def test_the_loaded_profile_meets_the_floor_at_runtime() -> None:
    """A static read of `conftest.py` proves what was written, not what took effect.

    `conftest.py` asserts this at import too. Re-asserting it as a test is what puts it
    in the report: a second `load_profile(...)` landing anywhere later would leave the
    source correct and the run at 10 examples, and this is the line that would say so.
    """
    assert settings.default.max_examples >= MINIMUM_EXAMPLES, settings.default.max_examples
    # Req 42.4 — the shrunk counterexample arrives with a decorator that re-runs it.
    assert settings.default.print_blob is True
    for check in REQUIRED_HEALTH_CHECKS:
        assert check not in settings.default.suppress_health_check, check


# --------------------------------------------------------------------------- #
# Req 42.8 — a fixed counterexample stays fixed
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(("module_name", "minimum"), sorted(MINIMUM_DECLARED_EXAMPLES.items()))
def test_declared_examples_are_retained(module_name: str, minimum: int) -> None:
    """The ratchet. Counts may grow; they may not shrink.

    An `@example` is the committed form of "this input broke us once" — the only form
    that runs for everyone on every subsequent execution. `.hypothesis/` is git-ignored,
    so the local example database is a convenience and never the record.
    """
    path = PROPERTY_ROOT / module_name
    assert path.is_file(), (
        f"{module_name} is registered in MINIMUM_DECLARED_EXAMPLES but absent; a "
        "property module that was renamed takes its declared counterexamples with it"
    )

    declared = _declared_example_count(path)
    assert declared >= minimum, (
        f"{module_name} declares {declared} @example decorators, down from {minimum} "
        "(Req 42.8). A counterexample that exposed a defect runs on every subsequent "
        "execution; raise the entry when you add one, never lower it"
    )


def test_the_ratchet_totals_match_the_tree_it_was_recorded_from() -> None:
    """A floor recorded from nothing would pass at nothing, so pin the total too.

    This catches what the per-module ratchet cannot: deleting an entry from
    `MINIMUM_DECLARED_EXAMPLES` along with the examples it was guarding. The per-module
    test would then simply not run for that module, and report green.
    """
    total = sum(_declared_example_count(p) for p in _property_modules())
    assert total >= MINIMUM_DECLARED_EXAMPLES_TOTAL, (
        f"the property suite declares {total} @example decorators, down from "
        f"{MINIMUM_DECLARED_EXAMPLES_TOTAL} (Req 42.8)"
    )
    assert sum(MINIMUM_DECLARED_EXAMPLES.values()) >= MINIMUM_DECLARED_EXAMPLES_TOTAL, (
        "MINIMUM_DECLARED_EXAMPLES no longer accounts for the recorded total; an entry "
        "was lowered or removed rather than the tree changing"
    )


# --------------------------------------------------------------------------- #
# Guard the guard — every predicate proven on synthetic modules under tmp_path
# --------------------------------------------------------------------------- #

_PROPERTY_HEADER = "from hypothesis import example, given, settings, strategies as st\nimport pytest\n\n"


@pytest.mark.parametrize(
    "source",
    [
        "@pytest.mark.skip\n@given(x=st.integers())\ndef test_p(x): pass",
        '@pytest.mark.skip(reason="flaky")\n@given(x=st.integers())\ndef test_p(x): pass',
        "@pytest.mark.skipif(True, reason='nope')\n@given(x=st.integers())\ndef test_p(x): pass",
        "@pytest.mark.xfail\n@given(x=st.integers())\ndef test_p(x): pass",
        "@pytest.mark.xfail(strict=False)\n@given(x=st.integers())\ndef test_p(x): pass",
        # The mark below `@given` rather than above it.
        "@given(x=st.integers())\n@pytest.mark.xfail\ndef test_p(x): pass",
        # A skip in the body reaches the same outcome without a decorator.
        "@given(x=st.integers())\ndef test_p(x):\n    pytest.skip('later')",
        "@given(x=st.integers())\ndef test_p(x):\n    if x > 3:\n        pytest.xfail('known')",
        # A committed replay decorator: generation is replaced by one recorded example.
        "@reproduce_failure('6.0', b'AA==')\n@given(x=st.integers())\ndef test_p(x): pass",
    ],
)
def test_the_scan_detects_a_property_that_does_not_run(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "test_offender_property.py", _PROPERTY_HEADER + source)
    assert _skip_offenders(_properties([module])), source


@pytest.mark.parametrize(
    "source",
    [
        "@given(x=st.integers())\ndef test_p(x): pass",
        "@given(x=st.integers())\n@example(x=0)\ndef test_p(x): pass",
        # `parametrize` is not a skip. `test_snapshot_property.py` uses it to run a
        # declared table of decimal strings, which is retention, not evasion.
        "@pytest.mark.parametrize('n', [1, 2])\n@given(x=st.integers())\ndef test_p(n, x): pass",
        # Raising a *skip* is the offence; asserting is not.
        "@given(x=st.integers())\ndef test_p(x):\n    assert x == x",
        # Prose naming the marks. conftest.py and these modules explain why they are
        # absent, so a text scan would fail on the tree that documents the rule best.
        "@given(x=st.integers())\ndef test_p(x):\n    \"\"\"Never xfail or skip this.\"\"\"",
        "# no pytest.mark.skip anywhere in this file\n@given(x=st.integers())\ndef test_p(x): pass",
    ],
)
def test_the_scan_permits_a_property_that_runs(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "test_permitted_property.py", _PROPERTY_HEADER + source)
    assert not _skip_offenders(_properties([module])), source


@pytest.mark.parametrize(
    "source",
    [
        "pytestmark = pytest.mark.skip\n@given(x=st.integers())\ndef test_p(x): pass",
        "pytestmark = pytest.mark.xfail(strict=True)\n@given(x=st.integers())\ndef test_p(x): pass",
        "pytestmark = [pytest.mark.skipif(True, reason='x')]\n@given(x=st.integers())\ndef test_p(x): pass",
    ],
)
def test_the_scan_detects_a_wholesale_module_skip(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "test_offender_property.py", _PROPERTY_HEADER + source)
    assert _module_level_skip_offenders([module]), source


def test_the_scan_permits_an_unrelated_module_level_mark(tmp_path: Path) -> None:
    module = _write(
        tmp_path,
        "test_permitted_property.py",
        _PROPERTY_HEADER
        + "pytestmark = pytest.mark.usefixtures('anyio_backend')\n"
        + "@given(x=st.integers())\ndef test_p(x): pass",
    )
    assert not _module_level_skip_offenders([module])


@pytest.mark.parametrize(
    "source",
    [
        "@settings(max_examples=10)\n@given(x=st.integers())\ndef test_p(x): pass",
        "@settings(max_examples=99)\n@given(x=st.integers())\ndef test_p(x): pass",
        "@settings(deadline=None, max_examples=1)\n@given(x=st.integers())\ndef test_p(x): pass",
        # Fails closed: the guard cannot evaluate an expression, so it refuses to guess.
        "@settings(max_examples=SOME_CONSTANT)\n@given(x=st.integers())\ndef test_p(x): pass",
        "@settings(max_examples=100 // 2)\n@given(x=st.integers())\ndef test_p(x): pass",
    ],
)
def test_the_scan_detects_a_lowered_example_count(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "test_offender_property.py", _PROPERTY_HEADER + source)
    assert _lowered_example_offenders(_properties([module])), source


@pytest.mark.parametrize(
    "source",
    [
        # No local override at all: the profile's floor applies, which is the shape every
        # property in this tree actually uses.
        "@given(x=st.integers())\ndef test_p(x): pass",
        "@settings(max_examples=100)\n@given(x=st.integers())\ndef test_p(x): pass",
        # Raising the count is always fine.
        "@settings(max_examples=500)\n@given(x=st.integers())\ndef test_p(x): pass",
        # A settings decorator that says nothing about the count.
        "@settings(deadline=None)\n@given(x=st.integers())\ndef test_p(x): pass",
    ],
)
def test_the_scan_permits_the_floor_and_anything_above_it(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "test_permitted_property.py", _PROPERTY_HEADER + source)
    assert not _lowered_example_offenders(_properties([module])), source


@pytest.mark.parametrize(
    "source",
    [
        "@settings(suppress_health_check=[HealthCheck.filter_too_much])\n@given(x=st.integers())\ndef test_p(x): pass",
        "@settings(suppress_health_check=[HealthCheck.data_too_large])\n@given(x=st.integers())\ndef test_p(x): pass",
        "@settings(max_examples=100, suppress_health_check=list(HealthCheck))\n@given(x=st.integers())\ndef test_p(x): pass",
        # In a registered profile, where it would apply to the whole suite.
        "settings.register_profile('x', settings(suppress_health_check=[HealthCheck.filter_too_much]))",
    ],
)
def test_the_scan_detects_a_suppressed_health_check(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "test_offender_property.py", _PROPERTY_HEADER + source)
    assert _suppression_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        "@settings(max_examples=100, deadline=None)\n@given(x=st.integers())\ndef test_p(x): pass",
        # Prose. `conftest.py` says "NO suppress_health_check" and explains why in three
        # sentences; a text scan would fail on exactly that.
        '"""There is deliberately no suppress_health_check here (Req 42.6)."""\n',
        "# Never pass suppress_health_check: see Req 42.6.\n",
        "assert HealthCheck.filter_too_much not in settings.default.suppress_health_check",
    ],
)
def test_the_scan_permits_prose_and_assertions_about_suppression(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "test_permitted_property.py", _PROPERTY_HEADER + source)
    assert not _suppression_offenders([module]), source


def test_the_example_counter_counts_decorators_not_mentions(tmp_path: Path) -> None:
    module = _write(
        tmp_path,
        "test_counted_property.py",
        _PROPERTY_HEADER
        + '"""This docstring mentions @example twice: @example."""\n'
        + "# and a comment mentioning @example\n"
        + "@given(x=st.integers())\n@example(x=0)\n@example(x=1)\ndef test_p(x): pass\n"
        + "@given(y=st.integers())\n@example(y=2)\ndef test_q(y): pass\n",
    )
    assert _declared_example_count(module) == 3


def test_the_ratchet_fails_on_a_deleted_example(tmp_path: Path) -> None:
    """The whole point of the floor, proven rather than asserted about."""
    two = _write(
        tmp_path,
        "test_two_property.py",
        _PROPERTY_HEADER + "@given(x=st.integers())\n@example(x=0)\n@example(x=1)\ndef test_p(x): pass\n",
    )
    assert _declared_example_count(two) == 2

    one = _write(
        tmp_path,
        "test_one_property.py",
        _PROPERTY_HEADER + "@given(x=st.integers())\n@example(x=0)\ndef test_p(x): pass\n",
    )
    assert _declared_example_count(one) == 1
    assert _declared_example_count(one) < _declared_example_count(two)


def test_the_property_detector_finds_given_however_it_was_imported(tmp_path: Path) -> None:
    module = _write(
        tmp_path,
        "test_imports_property.py",
        "import hypothesis\nfrom hypothesis import given, strategies as st\n\n"
        "@given(x=st.integers())\ndef test_bare(x): pass\n"
        "@hypothesis.given(x=st.integers())\ndef test_dotted(x): pass\n"
        "def test_not_a_property(): pass\n",
    )
    names = {prop.name for prop in _properties([module])}
    assert names == {"test_bare", "test_dotted"}


def test_the_module_listing_excludes_package_plumbing(tmp_path: Path) -> None:
    _write(tmp_path, "__init__.py", '"""Package."""\n')
    real = _write(
        tmp_path,
        "test_real_property.py",
        _PROPERTY_HEADER + "@given(x=st.integers())\ndef test_p(x): pass\n",
    )
    assert _property_modules(tmp_path) == [real]


# --------------------------------------------------------------------------- #
# Req 45.7 — the set executed equals the set declared (the static half)
# --------------------------------------------------------------------------- #


def test_the_declared_property_set_covers_the_tree_in_both_directions() -> None:
    """Req 45.7. Three failures, and they are three different mistakes.

    A module in `tests/property/` belonging to no declared property is a property added to
    the design and never registered — it runs, but nothing checks that it ran, and nothing
    would notice if it stopped. A declared module absent from the tree is a rename that
    took its property's identity with it. And the spec's own set has to be Properties 1 to
    7 exactly, because design.md's Req 45.7 clause is about *that* enumeration rather than
    about however many files happen to exist.
    """
    unclassified = property_ledger.unclassified_modules()
    assert not unclassified, (
        "these property modules belong to no declared property, so nothing asserts that "
        "they ran (Req 45.7); register each one in tests/property_ledger.py under the "
        f"design property it realizes: {sorted(unclassified)}"
    )

    missing = property_ledger.undeclared_modules()
    assert not missing, (
        "these modules are declared in tests/property_ledger.py and absent from "
        f"{PROPERTY_ROOT}; a renamed property module takes its declaration with it "
        f"(Req 45.7): {sorted(missing)}"
    )

    assert set(property_ledger.SPEC_PROPERTIES) == set(range(1, 8)), (
        "this spec declares agent-side Properties 1 through 7 (Req 45.1); the registry "
        f"declares {sorted(property_ledger.SPEC_PROPERTIES)}"
    )
    assert set(property_ledger.FOUNDATION_GATE) == {1, 6}, (
        "the regression gate is the foundation's Property 1 and Property 6 (Req 45.2); "
        f"the registry declares {sorted(property_ledger.FOUNDATION_GATE)}"
    )

    # Every declared module carries at least one `@given` property. This is the other half
    # of "registered and never run": a module that was emptied out would otherwise satisfy
    # both directions above while contributing nothing.
    for module, owner in sorted(property_ledger.declared_modules().items()):
        found = _properties([PROPERTY_ROOT / module])
        assert found, f"{module} is declared as {owner} and carries no @given property"


def test_the_examples_ratchet_and_the_property_registry_name_the_same_modules() -> None:
    """The two maps in play are indexed differently and must agree on the tree.

    `MINIMUM_DECLARED_EXAMPLES` is keyed by module and ratchets Req 42.8; the registry is
    keyed by design property number and enumerates Req 45.7's set. Nothing forces them to
    agree, so a module added to one and not the other would be half-guarded — ratcheted but
    unregistered, or registered but with its counterexamples free to be deleted.
    """
    assert set(MINIMUM_DECLARED_EXAMPLES) == set(property_ledger.declared_modules()), (
        "MINIMUM_DECLARED_EXAMPLES and the property registry disagree about which modules "
        "exist; symmetric difference: "
        f"{sorted(set(MINIMUM_DECLARED_EXAMPLES) ^ set(property_ledger.declared_modules()))}"
    )


# --------------------------------------------------------------------------- #
# Req 45.8 — the four recorded values, and the thresholds read off them
# --------------------------------------------------------------------------- #


def _collected_property_modules(session: pytest.Session) -> set[str]:
    """Which property modules this invocation actually collected.

    Read from the session rather than assumed, so a targeted run — `pytest
    tests/test_property_hygiene.py` while iterating — reports honestly that the ledger gate
    had nothing to evaluate instead of failing on the absence of a run it was not given.
    """
    collected: set[str] = set()
    for item in session.items:
        path = Path(str(getattr(item, "path", "") or item.fspath))
        if path.parent == PROPERTY_ROOT:
            collected.add(path.name)
    return collected


def test_every_executed_property_recorded_its_framework_count_fraction_and_seed(
    request: pytest.FixtureRequest,
) -> None:
    """Req 45.8, and through it Req 45.1 and 45.4.

    The ledger is filled by `conftest.py` from hypothesis's statistics stream as each
    property runs, and `tests/property/` sorts before `tests/test_property_hygiene.py`, so
    by the time this executes in a full run every property has already reported.

    An empty ledger over a session that *did* collect property modules is itself the
    failure: it means the collector callback never fired, which is the one way this whole
    mechanism can report green while observing nothing.
    """
    collected = _collected_property_modules(request.session)
    ledger = property_ledger.executions()

    if not collected:
        # A targeted invocation — `pytest tests/test_property_hygiene.py` while iterating.
        # There is nothing to gate, and the one thing worth asserting is that the ledger
        # agrees: property executions with no property module collected would mean the
        # ledger is carrying state from somewhere other than this run.
        assert not [
            e for e in ledger if e.module in property_ledger.declared_modules()
        ], "no property module was collected, yet the ledger holds property executions"
        return

    assert ledger, (
        f"{len(collected)} property modules were collected and the ledger is empty; "
        "conftest.py's statistics observer did not fire, so every threshold below would "
        "pass over nothing (Req 45.8)"
    )

    recorded = {e.module for e in ledger}
    unrecorded = collected - recorded
    assert not unrecorded, (
        "these property modules were collected and recorded no execution, so their "
        f"properties were registered and never ran (Req 45.7): {sorted(unrecorded)}"
    )

    offenders: list[str] = []
    for number, declaration in sorted(property_ledger.SPEC_PROPERTIES.items()):
        if not set(declaration.modules) & collected:
            continue
        offenders += property_ledger.gate_property(f"Property {number}", declaration, ledger)
    for number, declaration in sorted(property_ledger.FOUNDATION_GATE.items()):
        if not set(declaration.modules) & collected:
            continue
        offenders += property_ledger.gate_property(
            f"foundation Property {number}", declaration, ledger
        )

    assert not offenders, (
        "the recorded executions do not meet the thresholds Req 45.1 and Req 45.4 "
        "declare:\n  " + "\n  ".join(offenders)
    )


# --------------------------------------------------------------------------- #
# Req 45.2 / 45.9 — the regression gate
# --------------------------------------------------------------------------- #


def test_the_foundation_regression_gate_is_present_and_unmodified() -> None:
    """Req 45.2 — the two gate modules are byte-for-byte the foundation's.

    The compile and verify stages consume what these two protect. A count-weighted average
    that regresses produces a document that verifies *perfectly* against a wrong number,
    because the verifier compares the rendered string to the ledger and both came from the
    same wrong value; a bucket boundary that drifts by the UTC+07:00 offset silently
    re-attributes every daily figure. Neither failure is visible in the artifact.

    So this spec re-runs them rather than restating them, and "unmodified" is checked as a
    digest. Editing either file is allowed and is a decision: raise the recorded digest in
    the same change, deliberately.
    """
    offenders = property_ledger.gate_foundation_sources()
    assert not offenders, "\n  ".join(["", *offenders])


def test_the_foundation_regression_gate_executed(request: pytest.FixtureRequest) -> None:
    """Req 45.9 — absent, unexecuted or failing, and the report names which one.

    A failing foundation property fails on its own; what this covers is the quieter two.
    Absent is covered by the digest test above (a missing file has no digest); this one
    covers *unexecuted* — the module present, collected, and contributing nothing.
    """
    collected = _collected_property_modules(request.session)
    ledger = property_ledger.executions()

    for number, declaration in sorted(property_ledger.FOUNDATION_GATE.items()):
        for module in declaration.modules:
            assert (PROPERTY_ROOT / module).is_file(), (
                f"foundation Property {number} ({declaration.title}) is absent from this "
                f"spec's suite: {module} does not exist (Req 45.9)"
            )
            if not collected:
                continue
            assert module in collected, (
                f"foundation Property {number} ({declaration.title}) was not collected by "
                f"an invocation that collected {sorted(collected)}; the regression gate "
                "cannot be satisfied by a suite the two protected properties are not in "
                "(Req 45.9)"
            )
            mine = [e for e in ledger if e.module == module]
            assert mine, (
                f"foundation Property {number} ({declaration.title}) was collected and "
                f"did not execute: {module} recorded no accepted example (Req 45.9)"
            )
            accepted = sum(e.accepted for e in mine)
            assert accepted >= property_ledger.MINIMUM_ACCEPTED, (
                f"foundation Property {number} ({declaration.title}) accepted {accepted} "
                f"generated examples, below the {property_ledger.MINIMUM_ACCEPTED} "
                "Req 45.2 requires of the regression gate"
            )


# --------------------------------------------------------------------------- #
# Guard the guard — the ledger gates proven on synthetic executions
# --------------------------------------------------------------------------- #


def _execution(**overrides: object) -> property_ledger.Execution:
    """A clean execution: 100 accepted, nothing rejected, stopped on the budget."""
    fields: dict[str, object] = {
        "nodeid": "tests/property/test_synthetic_property.py::test_p",
        "module": "test_synthetic_property.py",
        "function": "test_p",
        "framework": property_ledger.HYPOTHESIS,
        "accepted": 100,
        "rejected": 0,
        "overrun": 0,
        "seed": "12345",
        "stopped_because": "settings.max_examples=100",
    }
    fields.update(overrides)
    return property_ledger.Execution(**fields)  # type: ignore[arg-type]


def test_a_clean_execution_passes_the_gate() -> None:
    assert property_ledger.gate_execution(_execution()) == []


@pytest.mark.parametrize(
    "overrides",
    [
        # Below the floor, having spent its whole budget: the ordinary regression.
        {"accepted": 99},
        {"accepted": 0},
        # Exhausted early and not declared as a finite space.
        {"accepted": 12, "stopped_because": property_ledger.EXHAUSTED},
        # The pathological filter, which hypothesis names in its own words.
        {
            "accepted": 100,
            "stopped_because": (
                "settings.max_examples=100, but < 1% of test cases satisfied assumptions"
            ),
        },
        # No seed recorded: the failure would not be re-runnable (Req 45.3).
        {"seed": ""},
        # A property that quietly moved to another engine.
        {"framework": "fast-check"},
    ],
)
def test_the_gate_detects_a_thin_execution(overrides: dict[str, object]) -> None:
    assert property_ledger.gate_execution(_execution(**overrides)), overrides


def test_an_exhausted_space_passes_only_when_it_is_declared() -> None:
    """The one exception, and the proof that it is an exception rather than a hole.

    `EXHAUSTIVE_BY_CONSTRUCTION` is a small map with a written reason per entry. An
    undeclared exhaustion fails; a declared one passes; and the declared key has to match
    the function that actually exhausted, so an entry cannot cover a different property.
    """
    declared = next(iter(property_ledger.EXHAUSTIVE_BY_CONSTRUCTION))
    module, _, function = declared.partition("::")

    exempt = _execution(
        nodeid=f"tests/property/{declared}",
        module=module,
        function=function,
        accepted=12,
        stopped_because=property_ledger.EXHAUSTED,
    )
    assert property_ledger.gate_execution(exempt) == []

    # The same numbers under a different function name are not covered by that entry.
    other = _execution(accepted=12, stopped_because=property_ledger.EXHAUSTED)
    assert property_ledger.gate_execution(other)

    # And every declared entry names a function that exists, so the map cannot drift into
    # exempting nothing while looking like it exempts something.
    for key in property_ledger.EXHAUSTIVE_BY_CONSTRUCTION:
        name, _, target = key.partition("::")
        found = {p.name for p in _properties([PROPERTY_ROOT / name])}
        assert target in found, f"{key} names no @given property in {name}"


def test_the_property_gate_reads_the_aggregate_and_not_one_function() -> None:
    """Req 45.1 bounds a *property*, and a property is several functions.

    Design.md's Property 5 is one claim asserted by the eight functions its acceptance
    criteria name. So 100 accepted examples is a floor on the claim, and a function whose
    finite space is exhausted in two draws does not sink a property that accepted five
    hundred — while a property that accepted ninety in total still fails.
    """
    declaration = property_ledger.PropertyDeclaration("synthetic", ("test_synthetic_property.py",))

    thin = (_execution(function="test_a", accepted=45), _execution(function="test_b", accepted=45))
    assert property_ledger.gate_property("Property 99", declaration, thin)

    fat = (
        _execution(function="test_a", accepted=100),
        _execution(
            function="test_b",
            accepted=2,
            stopped_because=property_ledger.EXHAUSTED,
        ),
    )
    offenders = property_ledger.gate_property("Property 99", declaration, fat)
    # `test_b` is an undeclared exhaustion, so it is reported — and the aggregate floor is
    # not what reported it.
    assert offenders
    assert not any("accepted 102 generated examples" in line for line in offenders)


def test_the_property_gate_reports_a_property_that_never_ran() -> None:
    declaration = property_ledger.PropertyDeclaration("synthetic", ("test_synthetic_property.py",))
    offenders = property_ledger.gate_property("Property 99", declaration, ())
    assert offenders and "executed no property at all" in offenders[0]


def test_the_precondition_ceiling_is_read_over_rejections_and_not_oversized_draws() -> None:
    """Req 45.4's ceiling is about preconditions, and `overrun` is not one.

    An `invalid` case is one `assume(...)` or `.filter(...)` threw away. An `overrun` case
    is one whose *draw* ran past the byte budget before any assertion was reached — a
    statement about the size of the generated value, governed by
    `HealthCheck.data_too_large`, which the profile never suppresses. Adding the two
    together would put every property that generates a 40 × 500 table or a 2,000-resource
    snapshot within a couple of points of a ceiling it has nothing to do with.
    """
    declaration = property_ledger.PropertyDeclaration("synthetic", ("test_synthetic_property.py",))

    oversized = (_execution(accepted=100, rejected=0, overrun=80),)
    assert property_ledger.gate_property("Property 99", declaration, oversized) == []

    filtered = (_execution(accepted=100, rejected=26, overrun=0),)
    offenders = property_ledger.gate_property("Property 99", declaration, filtered)
    assert any("through a precondition" in line for line in offenders), offenders


def test_the_foundation_digest_gate_fails_on_a_changed_file(tmp_path: Path) -> None:
    """The digest ratchet, proven rather than asserted about."""
    for module in property_ledger.FOUNDATION_SOURCE_DIGESTS:
        (tmp_path / module).write_bytes((PROPERTY_ROOT / module).read_bytes())
    assert property_ledger.gate_foundation_sources(tmp_path) == []

    first = next(iter(property_ledger.FOUNDATION_SOURCE_DIGESTS))
    (tmp_path / first).write_bytes((PROPERTY_ROOT / first).read_bytes() + b"\n# drift\n")
    offenders = property_ledger.gate_foundation_sources(tmp_path)
    assert offenders and first in offenders[0]

    (tmp_path / first).unlink()
    absent = property_ledger.gate_foundation_sources(tmp_path)
    assert absent and "is absent" in absent[0]


def test_the_case_counter_separates_accepted_rejected_and_oversized() -> None:
    """The one place hypothesis's statistics format is read, so it gets its own test."""
    stats = {
        "reuse-phase": {"test-cases": [{"status": "valid"}]},
        "generate-phase": {
            "test-cases": [
                {"status": "valid"},
                {"status": "valid"},
                {"status": "invalid"},
                {"status": "overrun"},
                {"status": "overrun"},
            ]
        },
        # Shrinking only happens on a failure, and its cases are not generation.
        "shrink-phase": {"test-cases": [{"status": "interesting"}, {"status": "valid"}]},
        "stopped-because": "settings.max_examples=100",
    }
    assert property_ledger.case_counts(stats) == (3, 1, 2)


def test_the_ledger_table_records_all_four_values_for_every_execution() -> None:
    """Req 45.8 — the output itself, checked for the four values it has to carry."""
    lines = property_ledger.format_table(
        (
            _execution(function="test_a"),
            _execution(function="test_b", accepted=140, rejected=10, overrun=3, seed="777"),
        )
    )
    rendered = "\n".join(lines)

    assert property_ledger.HYPOTHESIS in rendered          # framework
    assert "140 accepted" in rendered                      # accepted example count
    assert "6.7%" in rendered                              # precondition rejection fraction
    assert "seed=777" in rendered                          # the seed that reproduces it
    assert "3 oversized draws" in rendered
