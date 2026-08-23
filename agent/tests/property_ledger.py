"""The property ledger: what ran, under which framework, and on what seed (Req 45.7, 45.8).

`tests/test_property_hygiene.py` proves things about the *source* of the property
modules — that none is skipped, that none lowers its example count, that no declared
counterexample was deleted. Every one of those reads a file. None of them can see
whether a property that was written actually **ran**, how many generated examples it
accepted, or how much of its input a precondition threw away.

Req 45.7 and Req 45.8 are exactly about that gap:

* **45.7** — the set of properties *executed* must equal the set this spec *declares*.
  A property added to design.md and never registered fails, and so does one registered
  and never run. The declaration lives in {@link SPEC_PROPERTIES} below, keyed by the
  design property number, so the two documents are compared rather than assumed equal.
* **45.8** — each property records its framework, its accepted-example count, its
  precondition rejection fraction and its seed **in the suite's own output**. Req 45.4's
  thresholds — 100 accepted, generation not exhausted, at most 20% rejected — are then
  observable in the terminal rather than asserted about in a comment.

`tests/conftest.py` fills this ledger from hypothesis's own statistics stream and prints
it in the terminal summary. `tests/test_property_hygiene.py` reads it back and gates on
it. This module holds the declarations and the arithmetic and imports neither, so it
stays importable from both.

## Why the thresholds are read per design property

Req 45.1 requires "a minimum of 100 accepted generated examples **per property**", and a
property here is a numbered thing in design.md — Property 5 is *"drift sample selection is
bounded and reproducible"*, realized as the eight assertion groups its acceptance criteria
5.1 to 5.8 name, one test function each. So the count that Req 45.1 bounds is the
property's, summed across its functions, and that is what {@link gate_property} checks.

The per-function numbers are recorded and printed too, and one per-function rule is
enforced: a function that stopped because it hit the example budget must have accepted the
full 100. What it deliberately does **not** do is fail a function whose generated space is
*finite and was exhausted* — see {@link EXHAUSTIVE_BY_CONSTRUCTION}.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

AGENT_ROOT = Path(__file__).resolve().parent.parent
PROPERTY_ROOT = AGENT_ROOT / "tests" / "property"

# Req 45.1 — the framework each half of the suite runs its properties under. Recorded on
# every execution rather than inferred, so a property that quietly moved to another engine
# shows up in the output.
HYPOTHESIS = "hypothesis"

# Req 45.1 / 45.4 — the floor and the ceiling.
MINIMUM_ACCEPTED = 100
MAXIMUM_REJECTION_FRACTION = 0.20

# hypothesis's own words for why a run stopped, from `ExitReason`. Two of them matter here:
#   - `finished` means the generated space ran out. Whether that is a defect depends
#     entirely on the property; see EXHAUSTIVE_BY_CONSTRUCTION.
#   - `max_iterations` is the pathological filter — under 1% of cases satisfied the
#     preconditions — and is always a defect.
EXHAUSTED = "nothing left to do"
STARVED = "but < 1% of test cases satisfied assumptions"


@dataclass(frozen=True)
class PropertyDeclaration:
    """One numbered property from design.md, and the modules that realize it."""

    title: str
    modules: tuple[str, ...]


# --------------------------------------------------------------------------- #
# Req 45.7 — the declared set
# --------------------------------------------------------------------------- #

# design.md's agent-side set for THIS spec: Properties 1 through 7, run with hypothesis.
# The mapping is module-level rather than function-level because a design property is a
# claim and each of its acceptance criteria is one test function asserting part of it —
# `tests/property/test_drift_property.py` is Property 5, all eight criteria of it.
SPEC_PROPERTIES: dict[int, PropertyDeclaration] = {
    1: PropertyDeclaration(
        "Formatting is total, deterministic and the single display path",
        ("test_format_property.py",),
    ),
    2: PropertyDeclaration(
        "Token extraction and prose masking",
        ("test_tokens_property.py",),
    ),
    3: PropertyDeclaration(
        "Anchored cell equality detects transposition",
        ("test_anchors_property.py",),
    ),
    4: PropertyDeclaration(
        "Replay produces a bit-identical snapshot digest",
        ("test_replay_property.py",),
    ),
    5: PropertyDeclaration(
        "Drift sample selection is bounded and reproducible",
        ("test_drift_property.py",),
    ),
    6: PropertyDeclaration(
        "The ledger and the document AST agree in both directions",
        ("test_ledger_property.py",),
    ),
    # Two modules, one property. `test_metric_narrowing_property.py` asserts that the
    # Req 5.4 narrowing is invariant under resource-type recasing — the same resolver,
    # over the same snapshot-only inputs, validating the same Req 3.12 and Req 5.4 as
    # `test_scope_property.py`. It is a separate file because its input is the shared
    # definition corpus rather than a generated snapshot, not because it is a separate
    # claim, and design.md declares no Property 13 for it to be.
    7: PropertyDeclaration(
        "Scope resolution is deterministic and snapshot-only",
        ("test_scope_property.py", "test_metric_narrowing_property.py"),
    ),
}

# --------------------------------------------------------------------------- #
# The breadth-and-document spec's own properties
# --------------------------------------------------------------------------- #
# A **separate map** from `SPEC_PROPERTIES`, and not a continuation of it, because the two
# specs number their properties independently from 1. The templates spec's Property 5 is
# "drift sample selection is bounded and reproducible"; this spec's Property 5 is "every
# catalog entry is evidenced". Merging them would need one of the two renumbered, which
# would put a number in this file that appears nowhere in the design document it is
# supposed to be checkable against — and the whole point of keying by number is that the
# registry and the design can be compared.
#
# Populated as the properties land. `test_property_hygiene.py` asserts every declared
# number is within this spec's range and that every declared module exists, rather than
# asserting the full set, because a spec in progress legitimately has fewer.
BREADTH_PROPERTIES: dict[int, PropertyDeclaration] = {
    1: PropertyDeclaration(
        "A fact round-trips through the archive",
        ("test_facts_property.py",),
    ),
    5: PropertyDeclaration(
        "Every catalog entry is evidenced",
        ("test_catalog_evidence_property.py",),
    ),
    6: PropertyDeclaration(
        "A text fact's check catches what numeric masking cannot",
        ("test_text_fact_property.py",),
    ),
}

BREADTH_PROPERTY_RANGE: range = range(1, 10)
"""The nine properties `design.md` declares for this spec.

Declared as the range rather than as the count so a property numbered 0 or 10 fails the
registry check instead of being silently accepted as the tenth."""

# --------------------------------------------------------------------------- #
# Req 45.2 / 45.9 — the regression gate
# --------------------------------------------------------------------------- #

# The two foundation properties this spec re-runs **unchanged**. Not restated as new
# properties, because the point is that the code the compile and verify stages consume has
# not regressed: a wrong average formats into a document that then verifies perfectly
# against it, and a bucket boundary off by the UTC+07:00 offset silently re-attributes
# every daily figure.
FOUNDATION_GATE: dict[int, PropertyDeclaration] = {
    1: PropertyDeclaration(
        "Count-weighted averaging and exact minimum/maximum roll-up",
        ("test_accumulate_property.py",),
    ),
    6: PropertyDeclaration(
        "Local-day bucketing at the Asia/Jakarta UTC+07:00 offset",
        ("test_buckets_property.py",),
    ),
}

# Req 45.2 — "with their generators, their assertions and their declared examples
# unmodified by this spec". A digest is the only form of that sentence a suite can check.
#
# Raising one of these is not forbidden, it is *deliberate*: a change to either file is a
# change to a foundation property, and it has to be made as such rather than as a side
# effect of working on this spec. The failure message names which file moved.
FOUNDATION_SOURCE_DIGESTS: dict[str, str] = {
    "test_accumulate_property.py": (
        "90718903063a54c07a50c1fa7413c696f3b6aba739444043a5ad7e6db56c0e10"
    ),
    "test_buckets_property.py": (
        "4101b6d90f8c784364c99f8c00a828fe0b2db59c2fb6e28c1ed4eed87423a675"
    ),
}

# The remaining foundation properties. Declared for one reason: together with the two maps
# above they partition `tests/property/`, so a module that belongs to no property at all
# fails {@link unclassified_modules} instead of sitting outside every gate.
FOUNDATION_OTHER: dict[int, PropertyDeclaration] = {
    2: PropertyDeclaration(
        "JCS canonicalization and content addressing are stable",
        ("test_snapshot_property.py",),
    ),
    3: PropertyDeclaration(
        "Sketch quantiles are bounded in error and in state",
        ("test_sketch_property.py",),
    ),
    4: PropertyDeclaration(
        "Batch planning respects the points budget and loses nothing",
        ("test_metrics_property.py",),
    ),
    5: PropertyDeclaration(
        "Registered secrets cannot reach an event, a log record or an error",
        ("test_redaction_property.py",),
    ),
}

# --------------------------------------------------------------------------- #
# Finite generated spaces
# --------------------------------------------------------------------------- #

# Req 45.4 fails a property whose "generation is reported as exhausted before 100 cases
# are accepted", and the failure mode it is aimed at is real: a generator that keeps
# running out is a generator that tested a corner of its domain and reported green.
#
# Four functions in this tree stop for the opposite reason. Each draws from
# `st.sampled_from` over a domain that is finite *by construction* — three spellings of a
# tag key crossed with three of its value, four spellings of a resource type crossed with
# three of a resource group — so "nothing left to do" means hypothesis enumerated the
# **entire** input space and the claim holds for every input that exists. That is strictly
# stronger than 100 samples of it, and widening the domain to reach 100 draws would mean
# generating spellings the product does not have, which is a generator written to satisfy
# a counter.
#
# So they are declared here, each with the size of the space it exhausts, and every
# *other* function that exhausts early fails. Adding an entry is a decision with a reason
# attached; the guard-the-guard tests in `test_property_hygiene.py` prove that an
# undeclared exhaustion still fails.
EXHAUSTIVE_BY_CONSTRUCTION: dict[str, str] = {
    "test_scope_property.py::test_tag_keys_fold_and_tag_values_do_not": (
        "3 spellings of a tag key × 3 of its value × 3 of the filter key × 3 of the "
        "filter value = 81 inputs, which is every input the claim is about"
    ),
    "test_scope_property.py::test_resource_types_and_resource_groups_fold_case": (
        "4 spellings of one resource type × 3 of one resource group = 12 inputs"
    ),
    "test_metric_narrowing_property.py::test_recasing_every_resource_type_leaves_the_request_identical": (
        "every accepted fixture of the shared definition corpus × every declared "
        "recasing — the corpus is the domain, so exhausting it is the assertion"
    ),
    "test_drift_property.py::test_two_distinct_seeds_differ_above_the_cap": (
        "one resource count above the 25-resource cap plus the declared 400, because "
        "the claim is about two seeds over one snapshot rather than about the count, "
        "and 100 draws would build 100 snapshots of 300 resources to re-assert it"
    ),
}


# --------------------------------------------------------------------------- #
# The ledger
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Execution:
    """What one property function actually did, as hypothesis reported it.

    Every count excludes the shrink phase, which only runs on failure, and the explicit
    phase, which is where `@example` decorators run. That second exclusion is Req 45.5 in
    arithmetic: a retained counterexample runs **in addition to** the 100-case minimum
    rather than counting toward it, and hypothesis keeps the two apart in its own
    statistics, so this ledger does too.

    **`rejected` and `overrun` are different facts and are not added together.** Req 45.4
    bounds the cases "rejected through a precondition", which is hypothesis's `invalid`
    status: `assume(...)` returned false, or a strategy's `.filter(...)` did. `overrun` is
    a case whose *draw* exceeded the byte budget before the assertions were reached — a
    statement about the size of the generated value, not about a precondition discarding
    it, and the health check that governs it is `HealthCheck.data_too_large`, which
    `conftest.py` never suppresses. Folding the two into one ratio would put every property
    that generates a large structure — a 40 × 500 table, a 2,000-resource snapshot — a few
    points from a ceiling it has nothing to do with, and the number would move run to run
    because generation is not derandomized.
    """

    nodeid: str
    module: str
    function: str
    framework: str
    accepted: int
    rejected: int
    overrun: int
    seed: str
    stopped_because: str

    @property
    def key(self) -> str:
        """`module.py::function` — stable across the absolute path pytest reports."""
        return f"{self.module}::{self.function}"

    @property
    def generated(self) -> int:
        """Cases a precondition could have judged: the accepted ones and the rejected."""
        return self.accepted + self.rejected

    @property
    def rejection_fraction(self) -> float:
        return self.rejected / self.generated if self.generated else 0.0

    @property
    def exhausted(self) -> bool:
        return EXHAUSTED in self.stopped_because

    @property
    def starved(self) -> bool:
        return STARVED in self.stopped_because


_LEDGER: dict[str, Execution] = {}


def record(execution: Execution) -> None:
    _LEDGER[execution.nodeid] = execution


def executions() -> tuple[Execution, ...]:
    return tuple(_LEDGER.values())


def execution_for(nodeid: str) -> Execution | None:
    return _LEDGER.get(nodeid)


def case_counts(stats: dict) -> tuple[int, int, int]:
    """`(accepted, rejected, overrun)` from one hypothesis statistics dictionary.

    hypothesis does not promise this format is stable, which is why it is read in exactly
    one place. `status` is `valid`, `invalid`, `overrun` or `interesting`; `invalid` is a
    case a precondition threw away, `overrun` a case whose draw ran past the byte budget,
    and `interesting` a failure — which pytest is already reporting by other means.
    """
    accepted = rejected = overrun = 0
    for name, phase in stats.items():
        if not name.endswith("-phase") or name == "shrink-phase":
            continue
        for case in phase.get("test-cases", ()):
            if case["status"] == "valid":
                accepted += 1
            elif case["status"] == "invalid":
                rejected += 1
            elif case["status"] == "overrun":
                overrun += 1
    return accepted, rejected, overrun


# --------------------------------------------------------------------------- #
# Classification
# --------------------------------------------------------------------------- #


def declared_modules() -> dict[str, str]:
    """Every declared module, mapped to the property label that claims it."""
    owners: dict[str, str] = {}
    for number, declaration in SPEC_PROPERTIES.items():
        for module in declaration.modules:
            owners[module] = f"Property {number}"
    for number, declaration in BREADTH_PROPERTIES.items():
        for module in declaration.modules:
            owners[module] = f"breadth Property {number}"
    for number, declaration in FOUNDATION_GATE.items():
        for module in declaration.modules:
            owners[module] = f"foundation Property {number}"
    for number, declaration in FOUNDATION_OTHER.items():
        for module in declaration.modules:
            owners[module] = f"foundation Property {number}"
    return owners


def property_modules(root: Path = PROPERTY_ROOT) -> tuple[str, ...]:
    """Every property module on disk. `__init__.py` is package plumbing."""
    return tuple(sorted(p.name for p in root.glob("*.py") if p.name != "__init__.py"))


def unclassified_modules(root: Path = PROPERTY_ROOT) -> tuple[str, ...]:
    owners = declared_modules()
    return tuple(name for name in property_modules(root) if name not in owners)


def undeclared_modules(root: Path = PROPERTY_ROOT) -> tuple[str, ...]:
    """Declared modules that are not on disk — a rename that lost its property."""
    present = set(property_modules(root))
    return tuple(sorted(name for name in declared_modules() if name not in present))


def source_digest(module: str, root: Path = PROPERTY_ROOT) -> str:
    return hashlib.sha256((root / module).read_bytes()).hexdigest()


# --------------------------------------------------------------------------- #
# The gates
# --------------------------------------------------------------------------- #


def gate_execution(execution: Execution) -> list[str]:
    """Req 45.4 and 45.8, per function. Empty means clean."""
    offenders: list[str] = []

    if execution.framework != HYPOTHESIS:
        offenders.append(
            f"{execution.key} recorded framework {execution.framework!r}; every "
            f"agent-side property runs under {HYPOTHESIS!r} (Req 45.1)"
        )
    if not execution.seed:
        offenders.append(
            f"{execution.key} recorded no seed, so its execution cannot be reproduced "
            "(Req 45.3, 45.8)"
        )
    if execution.accepted == 0:
        offenders.append(f"{execution.key} accepted no generated example at all")
    if execution.starved:
        offenders.append(
            f"{execution.key} stopped because under 1% of its generated cases satisfied "
            f"its preconditions: {execution.stopped_because!r} (Req 45.4)"
        )
    if execution.exhausted and execution.accepted < MINIMUM_ACCEPTED:
        reason = EXHAUSTIVE_BY_CONSTRUCTION.get(execution.key)
        if reason is None:
            offenders.append(
                f"{execution.key} exhausted its generated space after "
                f"{execution.accepted} accepted examples, below the floor of "
                f"{MINIMUM_ACCEPTED} (Req 45.4). If the space is finite by "
                "construction and exhausting it *is* the assertion, declare it in "
                "EXHAUSTIVE_BY_CONSTRUCTION with the size of the space; otherwise widen "
                "the generator"
            )
    elif execution.accepted < MINIMUM_ACCEPTED:
        offenders.append(
            f"{execution.key} accepted {execution.accepted} generated examples, below "
            f"the floor of {MINIMUM_ACCEPTED}, stopping because "
            f"{execution.stopped_because!r} (Req 45.1, 45.4)"
        )
    return offenders


def gate_property(label: str, declaration: PropertyDeclaration, ledger: tuple[Execution, ...]) -> list[str]:
    """Req 45.1 and 45.4 at the grain design.md declares: the whole property."""
    offenders: list[str] = []
    mine = [e for e in ledger if e.module in declaration.modules]

    if not mine:
        offenders.append(
            f"{label} ({declaration.title}) executed no property at all; it is declared "
            f"over {list(declaration.modules)} and nothing from there reached the ledger "
            "(Req 45.7, 45.9)"
        )
        return offenders

    ran = {e.module for e in mine}
    for module in declaration.modules:
        if module not in ran:
            offenders.append(
                f"{label} declares {module} and no property in it executed (Req 45.7)"
            )

    accepted = sum(e.accepted for e in mine)
    rejected = sum(e.rejected for e in mine)
    generated = accepted + rejected
    fraction = rejected / generated if generated else 0.0

    for execution in mine:
        offenders.extend(gate_execution(execution))

    if accepted < MINIMUM_ACCEPTED:
        offenders.append(
            f"{label} accepted {accepted} generated examples across "
            f"{len(mine)} functions, below the floor of {MINIMUM_ACCEPTED} (Req 45.1)"
        )
    if fraction > MAXIMUM_REJECTION_FRACTION:
        offenders.append(
            f"{label} rejected {rejected} of {generated} generated examples through a "
            f"precondition ({fraction:.1%}), above the ceiling of "
            f"{MAXIMUM_REJECTION_FRACTION:.0%} (Req 45.4)"
        )
    return offenders


def gate_foundation_sources(root: Path = PROPERTY_ROOT) -> list[str]:
    """Req 45.2 — the two gate modules are byte-for-byte the foundation's."""
    offenders: list[str] = []
    for module, expected in FOUNDATION_SOURCE_DIGESTS.items():
        path = root / module
        if not path.is_file():
            offenders.append(
                f"{module} is absent, so foundation Property "
                f"{_foundation_number(module)} cannot run in this spec's suite (Req 45.9)"
            )
            continue
        actual = source_digest(module, root)
        if actual != expected:
            offenders.append(
                f"{module} no longer matches the digest recorded for it: expected "
                f"{expected}, found {actual}. This spec re-runs foundation Property "
                f"{_foundation_number(module)} with its generators, assertions and "
                "declared examples unmodified (Req 45.2); changing that file is a change "
                "to a foundation property and the digest above has to move with it"
            )
    return offenders


def _foundation_number(module: str) -> str:
    for number, declaration in FOUNDATION_GATE.items():
        if module in declaration.modules:
            return str(number)
    return "?"


# --------------------------------------------------------------------------- #
# Req 45.8 — the output
# --------------------------------------------------------------------------- #

def format_table(ledger: tuple[Execution, ...] | None = None) -> list[str]:
    """The four recorded values per property, plus the roll-up each threshold reads.

    Printed by `tests/conftest.py`'s terminal summary, which is what makes Req 45.4's
    thresholds observable in the suite's own output rather than asserted about in prose.
    """
    ledger = executions() if ledger is None else ledger
    owners = declared_modules()
    lines = [
        f"Property ledger — {len(ledger)} executions "
        f"(Req 45.8: framework, accepted examples, precondition rejection fraction, seed)",
    ]

    grouped: dict[str, list[Execution]] = {}
    for execution in ledger:
        grouped.setdefault(owners.get(execution.module, "unregistered"), []).append(execution)

    for label in sorted(grouped, key=_label_order):
        mine = sorted(grouped[label], key=lambda e: e.key)
        accepted = sum(e.accepted for e in mine)
        rejected = sum(e.rejected for e in mine)
        generated = accepted + rejected
        fraction = rejected / generated if generated else 0.0
        lines.append(
            f"{label}: {accepted} accepted, {rejected} rejected by a precondition "
            f"({fraction:.1%}) across {len(mine)} functions"
        )
        for execution in mine:
            note = ""
            if execution.exhausted:
                note = (
                    "  [space exhausted; declared finite]"
                    if execution.key in EXHAUSTIVE_BY_CONSTRUCTION
                    else "  [space exhausted]"
                )
            if execution.overrun:
                note += f"  [{execution.overrun} oversized draws]"
            lines.append(
                f"    {execution.framework:<10} "
                f"{execution.accepted:>6} accepted "
                f"{execution.rejected:>6} rejected "
                f"{execution.rejection_fraction:>7.1%}  "
                f"seed={execution.seed}  {execution.key}"
                f"  ({execution.stopped_because}){note}"
            )
    return lines


def _label_order(label: str) -> tuple[int, int, str]:
    """Spec properties first, then the foundation ones, then anything unregistered."""
    if label.startswith("Property "):
        return (0, int(label.removeprefix("Property ")), label)
    if label.startswith("foundation Property "):
        return (1, int(label.removeprefix("foundation Property ")), label)
    return (2, 0, label)
