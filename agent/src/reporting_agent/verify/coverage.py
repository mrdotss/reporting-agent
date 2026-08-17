"""The gate that stops a clean, fully verified, empty report (Req 32).

This is the shortest module in `verify/` and the one whose absence would be most expensive,
because the failure it catches passes every other gate in this package by construction:

    an expired client secret, or a role assignment one resource group too narrow
      → zero resources in scope
      → zero figures compiled
      → zero *unverifiable* figures
      → the prose pass finds no survivor, the anchored pass finds no mismatch, the
        chart pass has no chart, the PDF pass has no string to locate, replay
        reproduces an empty aggregation exactly
      → a document that passes, carries nothing, and looks authoritative.

Every one of those passes is working correctly. There is simply nothing for them to be
correct about. So emptiness has to be its own gate, and it has to fail closed.

## Fail closed, three times over

**`scope_verified`** false, **absent**, or recorded as something other than a boolean all
produce `scope_unverified` (Req 32.1). Subscription-scope read is unproven unless the
preflight proved it, and a missing value is not a quiet yes — it is the exact shape an older
snapshot, a truncated write or a partially migrated document takes.

**An unresolvable union** is `coverage_resource_absent` naming the rule (Req 32.8), not an
empty union quietly reported as complete coverage. "I could not work out what should be here"
and "nothing should be here" are opposite claims and only one of them is safe to act on.

**Zero Azure queries** (Req 32.5). The union set and the coverage assertion come from the
snapshot and the pinned version alone — and not because a query would be slow. The inventory
query is itself RBAC-filtered, so a principal holding Reader on one resource group of thirty
returns a complete-looking inventory of that one group. Re-querying would confirm the
incomplete answer with the same credential that made it incomplete.

One case that is **not** a failure: a single block whose scope matched nothing while the union
matched something (Req 32.7). That is ordinary compile output — the block renders its explicit
no-resources-matched row and the run carries on. Conflating it with an empty union would fail
every report containing one narrowly scoped section.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

from reporting_agent.compile.scope import ScopeRules, resolve, scope_rules_from_plain
from reporting_agent.compile.snapshot_view import SnapshotView
from reporting_agent.verify.findings import (
    FINDING_COVERAGE_RESOURCE_ABSENT,
    FINDING_EMPTY_SCOPE,
    FINDING_SCOPE_UNVERIFIED,
    Finding,
    record_finding,
)

__all__ = ["CoveragePass", "check_coverage", "union_resource_ids"]


@dataclass(frozen=True, slots=True)
class CoveragePass:
    """What one coverage pass observed.

    All three counts are recorded whether the pass passed or failed (Req 32.6), because "the
    union held 37 resources and the snapshot holds 37" and "the union could not be derived"
    are both answers a reviewer needs, and a result that omitted the counts on failure would
    give the second one no shape at all.
    """

    findings: tuple[Finding, ...]
    union_resource_count: int
    snapshot_resource_count: int
    collection_log_entries: int


class UnionUnresolvable(Exception):
    """The union scope could not be derived from the pinned version and the snapshot.

    Internal to this module: it exists so the several ways a definition's scope can refuse to
    parse converge on one outcome — `coverage_resource_absent` naming the rule — rather than
    on an empty set that reads like complete coverage.
    """


def union_resource_ids(
    definition: Mapping[str, object], view: SnapshotView
) -> tuple[str, ...]:
    """Every resource the pinned version's scopes resolve to, in ascending id order.

    The union of the template default and every block `scope_override`, each resolved against
    **this** snapshot — the same resolver the compile stage used, so the set the verifier
    asserts over is the set the document was compiled from rather than a second reading of
    the same rules.

    A block override that resolves to nothing contributes nothing and is not an error
    (Req 32.7). A rule that cannot be *parsed* is, and raises.
    """
    scopes: list[ScopeRules] = []
    try:
        scopes.append(scope_rules_from_plain(definition.get("scope"), at="scope"))
    except Exception as exc:
        raise UnionUnresolvable(f"the template default scope: {exc}") from exc

    blocks = definition.get("blocks")
    if isinstance(blocks, Sequence) and not isinstance(blocks, (str, bytes)):
        for ordinal, block in enumerate(blocks):
            if not isinstance(block, Mapping):
                continue
            override = block.get("scope_override")
            if override is None:
                continue
            at = f"blocks.{ordinal}.scope_override"
            try:
                scopes.append(scope_rules_from_plain(override, at=at))
            except Exception as exc:
                raise UnionUnresolvable(f"{at}: {exc}") from exc

    found: set[str] = set()
    for ordinal, rules in enumerate(scopes):
        try:
            found.update(resource.resource_id for resource in resolve(rules, view))
        except Exception as exc:
            raise UnionUnresolvable(
                f"scope rule {ordinal} could not be resolved against the snapshot: {exc}"
            ) from exc
    return tuple(sorted(found))


def check_coverage(
    snapshot: Mapping[str, object],
    *,
    view: SnapshotView,
    definition: Mapping[str, object],
) -> CoveragePass:
    """The three assertions, over the snapshot and the pinned version alone.

    `snapshot` is the **raw** document rather than only the view, because `SnapshotView`
    coerces `scope_verified` with `bool(...)` at build time and Req 32.1 wants the three
    unproven cases distinguishable in the message: recorded false, absent, and recorded as
    something that is not a boolean. The verdict is identical for all three; only the
    explanation differs, and that is the part a reviewer acts on.
    """
    findings: list[Finding] = []

    findings.extend(_scope_verified_findings(snapshot))

    present = {resource.resource_id for resource in view.resources}
    union: tuple[str, ...] = ()
    try:
        union = union_resource_ids(definition, view)
    except UnionUnresolvable as exc:
        findings.append(
            record_finding(
                FINDING_COVERAGE_RESOURCE_ABSENT,
                f"the run's union scope could not be resolved from the pinned template "
                f"version and the snapshot ({exc}); coverage is unknown rather than "
                f"complete, so the gate fails closed",
            )
        )
    else:
        findings.extend(
            record_finding(
                FINDING_COVERAGE_RESOURCE_ABSENT,
                f"the resource {resource_id!r} is in the run's union scope but absent from "
                f"the snapshot's resource set; the document cannot report on a resource the "
                f"snapshot does not carry",
                resource_id=resource_id,
            )
            for resource_id in union
            if resource_id not in present
        )

    if not present:
        findings.append(
            record_finding(
                FINDING_EMPTY_SCOPE,
                "the snapshot carries zero resources; zero resources compiles to zero "
                "figures and zero figures passes every other gate, so an empty snapshot is "
                "a failure rather than a report with nothing to say",
            )
        )

    return CoveragePass(
        findings=tuple(findings),
        union_resource_count=len(union),
        snapshot_resource_count=len(present),
        collection_log_entries=len(view.gaps),
    )


def _scope_verified_findings(snapshot: Mapping[str, object]) -> list[Finding]:
    """Req 32.1, with the three unproven cases named apart."""
    if "scope_verified" not in snapshot:
        why = "the snapshot records no scope_verified value"
    else:
        recorded = snapshot["scope_verified"]
        if recorded is True:
            return []
        why = (
            "the snapshot records scope_verified as false"
            if recorded is False
            else f"the snapshot's scope_verified is {type(recorded).__name__}, not a boolean"
        )

    return [
        record_finding(
            FINDING_SCOPE_UNVERIFIED,
            f"{why}. Subscription-scope read is unproven unless the preflight proved it, "
            f"and an unproven scope means the inventory this report rests on may be a "
            f"filtered view of the subscription rather than all of it",
        )
    ]
