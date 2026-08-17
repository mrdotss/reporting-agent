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
    "test_buckets_property.py": 10,
    "test_metrics_property.py": 9,
    "test_redaction_property.py": 26,
    # 21 as generated, plus the 5 retained counterexamples of Property 3.5's
    # single-sample near-edge defect (see the block above the examples in that file).
    "test_sketch_property.py": 26,
    "test_snapshot_property.py": 5,
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
}

# The sum of the map, restated so the total is pinned as well as each part. Recorded from
# the tree rather than computed from the map, so a whole entry deleted from the map is
# caught by the same assertion that catches an example deleted from a module.
MINIMUM_DECLARED_EXAMPLES_TOTAL = 98


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
