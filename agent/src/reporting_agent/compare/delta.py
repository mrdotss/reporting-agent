"""The Delta_Compiler: a `comparison_delta` block, from two pinned snapshots.

    compile_delta(...) -> DeltaTable

**Two stored snapshots and no Azure call** (Req 16.7). A delta between two runs only means
something if both snapshots are pinned, so this reads the snapshots the two completed runs
recorded and never re-collects — the same reasoning `report_verifications` applies to
`snapshot_sha256`: a report is an audit artifact, so every input to it is pinned, not just the
data.

## The delta is a figure, and its provenance is the later run's position

`value = later - earlier`, emitted as a **figure** like every other quantity. Its
`snapshot_path` addresses the **later** run's value, and `derived_from` names both runs'
positions plus the formula, so a reader can follow the subtraction to both operands.

That is the one place this package performs arithmetic on snapshot values, and it is why the
derivation travels on the figure: a difference with no stated operands is an assertion. Both
`snapshot_id`s are emitted in the block for the same reason — a delta whose two anchors are not
named cannot be re-checked.

## Two rows that are not deltas, and why neither is omitted

* **Differing fidelity tiers** (Req 16.8). A `baseline` percentile is estimated from hourly
  averages; an `enhanced` one is computed from guest samples. Subtracting one from the other
  produces a number whose units are the same and whose meaning is not — it would read as a
  change in the infrastructure when it is a change in the measurement. The row says **not
  comparable**, carries no delta figure, and records the advisory `fidelity_not_comparable`.
* **Present in one snapshot only** (Req 16.15). A machine created or decommissioned between the
  two runs. The row names **which** snapshot it is absent from and carries no delta figure.

Neither is omitted, and that is the same rule as the empty-scope row: a row that vanished is
indistinguishable from a resource that was never in scope, and the reader cannot tell "this
machine appeared last month" from "we did not look".
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Final

from reporting_agent.compile.estimators import (
    COMPARISON_DELTA_ESTIMATOR as DELTA_ESTIMATOR,
)
from reporting_agent.compile.snapshot_view import (
    DerivedSource,
    SnapshotValue,
    SnapshotView,
    pointer,
)

__all__ = [
    "ADVISORY_FIDELITY_NOT_COMPARABLE",
    "DELTA_ESTIMATOR",
    "DELTA_FORMULA",
    "DELTA_NAMESPACE",
    "DeltaKind",
    "DeltaResolver",
    "DeltaRow",
    "DeltaTable",
    "compile_delta",
    "delta_pointer",
    "qualified",
]

DELTA_NAMESPACE: Final[str] = "$delta"
"""The reserved pointer namespace a compile-time difference is addressed under.

`Figure.__post_init__` re-resolves every `snapshot_path` and requires the addressed value to
equal the figure's own. A delta is **not** a value stored at any single position — it is
arithmetic over two — so it needs an address of its own, on exactly the terms
`compile/snapshot_view.py`'s derived cardinalities do.

The address **is** the derivation:

    /$delta/<earlier snapshot id>/<later snapshot id>/<resource id>/<metric>/<statistic>/value

Both anchors, the resource, the metric and the statistic, all in the pointer. A reader holding
the two snapshots can locate both operands from the address alone, and :class:`DeltaResolver`
resolves it during compilation so the figure's provenance is checked rather than asserted.

The alternative was emitting the delta as **text**, which would put a numeric token in the
document that the verifier finds and cannot match — withholding the whole report. Arithmetic the
document format forces gets an address; arithmetic nobody asked for still gets none."""

ADVISORY_FIDELITY_NOT_COMPARABLE: Final[str] = "fidelity_not_comparable"
"""The advisory the verification result carries for a row whose two tiers differ (Req 16.8).

**Advisory, not blocking**: the report is still deliverable and still honest — it says the row
is not comparable. A blocking finding would withhold a document whose only flaw is that the
customer improved their instrumentation between two runs."""

DELTA_FORMULA: Final[str] = "later - earlier"
DELTA_SOURCE_KIND: Final[str] = "run_snapshot"


class DeltaKind:
    """Why a row carries no delta figure, or that it carries one.

    A plain class of string constants rather than an enum, matching
    `collect/log.py`'s treatment of `gap_type` and for the same reason: these travel into plain
    data, and an enum member would need converting at every boundary.
    """

    COMPARABLE: Final[str] = "comparable"
    FIDELITY_DIFFERS: Final[str] = "fidelity_differs"
    ABSENT_FROM_EARLIER: Final[str] = "absent_from_earlier"
    ABSENT_FROM_LATER: Final[str] = "absent_from_later"
    NO_VALUE: Final[str] = "no_value"


@dataclass(frozen=True, slots=True)
class DeltaRow:
    """One resource's comparison across the two runs.

    `delta` is the `SnapshotValue`-shaped difference the block emits as a figure, and it is
    `None` for every kind but :attr:`DeltaKind.COMPARABLE` — there is no shape in which a
    not-comparable row carries a number.
    """

    resource_id: str
    resource_name: str
    kind: str
    earlier: SnapshotValue | None = None
    later: SnapshotValue | None = None
    delta: SnapshotValue | None = None
    earlier_tier: str = ""
    later_tier: str = ""
    note: str = ""

    @property
    def is_comparable(self) -> bool:
        return self.kind == DeltaKind.COMPARABLE


@dataclass(frozen=True, slots=True)
class DeltaTable:
    """Every row, plus the two anchors and the advisories the verification result records."""

    run_a: str
    run_b: str
    snapshot_a: str
    snapshot_b: str
    metric: str
    statistic: str
    rows: tuple[DeltaRow, ...] = ()
    advisories: tuple[tuple[str, str], ...] = field(default_factory=tuple)
    """`(advisory, resource_id)` pairs, in row order — what the verification result carries."""

    def resolver(self, base: SnapshotView) -> DeltaResolver:
        """A resolver that answers for this run's snapshot **and** for these deltas.

        A **superset** of `base`, deliberately: every other block in the same document still
        resolves normally, so binding this for the comparison block's compilation widens what
        resolves rather than swapping the snapshot underneath the document.
        """
        return DeltaResolver(
            base=base,
            deltas={
                row.delta.pointer: row.delta
                for row in self.rows
                if row.delta is not None
            },
        )


@dataclass(frozen=True, slots=True)
class DeltaResolver:
    """`base`'s values, plus the compile-time deltas at their reserved addresses.

    Satisfies `compile/ast.py`'s `SnapshotResolver` protocol, which is the whole point: a delta
    figure's declared provenance is **checked at construction** against the value the address
    holds, exactly like a stored value's. Nothing here is exempt from the re-resolution rule; the
    rule is simply given an address it can resolve.
    """

    base: SnapshotView
    deltas: Mapping[str, SnapshotValue]

    def resolve_all(self, raw_pointer: str) -> tuple[SnapshotValue, ...]:
        found = self.deltas.get(raw_pointer)
        if found is not None:
            return (found,)
        return self.base.resolve_all(raw_pointer)


def compile_delta(
    *,
    run_a: str,
    run_b: str,
    earlier: SnapshotView,
    later: SnapshotView,
    metric: str,
    statistic: str,
    resource_ids: Sequence[str] | None = None,
) -> DeltaTable:
    """Compare `metric`/`statistic` across two pinned snapshots.

    `earlier` and `later` are the snapshots the two completed runs recorded; `run_a` and `run_b`
    are their run ids, carried through so the block can name both anchors.

    `resource_ids` narrows the comparison to a block's resolved scope, and it is a sequence of
    **ids** rather than of resolved resources for a reason worth stating: a resource present in
    only one of the two snapshots has no `ResourceView` in the other, and a caller that resolved
    its scope against one side would silently drop exactly the rows Req 16.15 exists to require.
    The block therefore resolves its scope against **both** views and hands over the union.

    When it is `None` the comparison covers the union of both snapshots' resources, ordered by
    resource id.

    Pure: two views in, a table out. No Azure call, no clock, no I/O.
    """
    by_id_earlier = {resource.resource_id: resource for resource in earlier.resources}
    by_id_later = {resource.resource_id: resource for resource in later.resources}

    if resource_ids is None:
        candidates = tuple(sorted(set(by_id_earlier) | set(by_id_later)))
    else:
        candidates = tuple(resource_ids)

    rows: list[DeltaRow] = []
    advisories: list[tuple[str, str]] = []

    for resource_id in candidates:
        in_earlier = by_id_earlier.get(resource_id)
        in_later = by_id_later.get(resource_id)
        name = (in_later or in_earlier).name if (in_later or in_earlier) else resource_id

        if in_earlier is None:
            rows.append(
                DeltaRow(
                    resource_id=resource_id,
                    resource_name=name,
                    kind=DeltaKind.ABSENT_FROM_EARLIER,
                    later=later.stat(resource_id, metric, statistic),
                    later_tier=in_later.fidelity_tier if in_later else "",
                    note=f"absent from the earlier run ({run_a})",
                )
            )
            continue

        if in_later is None:
            rows.append(
                DeltaRow(
                    resource_id=resource_id,
                    resource_name=name,
                    kind=DeltaKind.ABSENT_FROM_LATER,
                    earlier=earlier.stat(resource_id, metric, statistic),
                    earlier_tier=in_earlier.fidelity_tier,
                    note=f"absent from the later run ({run_b})",
                )
            )
            continue

        if in_earlier.fidelity_tier != in_later.fidelity_tier:
            rows.append(
                DeltaRow(
                    resource_id=resource_id,
                    resource_name=name,
                    kind=DeltaKind.FIDELITY_DIFFERS,
                    earlier=earlier.stat(resource_id, metric, statistic),
                    later=later.stat(resource_id, metric, statistic),
                    earlier_tier=in_earlier.fidelity_tier,
                    later_tier=in_later.fidelity_tier,
                    note=(
                        f"fidelity tier changed from {in_earlier.fidelity_tier} to "
                        f"{in_later.fidelity_tier}"
                    ),
                )
            )
            advisories.append((ADVISORY_FIDELITY_NOT_COMPARABLE, resource_id))
            continue

        earlier_value = earlier.stat(resource_id, metric, statistic)
        later_value = later.stat(resource_id, metric, statistic)
        if earlier_value is None or later_value is None:
            rows.append(
                DeltaRow(
                    resource_id=resource_id,
                    resource_name=name,
                    kind=DeltaKind.NO_VALUE,
                    earlier=earlier_value,
                    later=later_value,
                    earlier_tier=in_earlier.fidelity_tier,
                    later_tier=in_later.fidelity_tier,
                    note="one of the two runs holds no value for this metric",
                )
            )
            continue

        rows.append(
            DeltaRow(
                resource_id=resource_id,
                resource_name=name,
                kind=DeltaKind.COMPARABLE,
                earlier=earlier_value,
                later=later_value,
                delta=_difference(
                    earlier_value,
                    later_value,
                    earlier_snapshot=earlier.snapshot_id,
                    later_snapshot=later.snapshot_id,
                ),
                earlier_tier=in_earlier.fidelity_tier,
                later_tier=in_later.fidelity_tier,
            )
        )

    return DeltaTable(
        run_a=run_a,
        run_b=run_b,
        snapshot_a=earlier.snapshot_id,
        snapshot_b=later.snapshot_id,
        metric=metric,
        statistic=statistic,
        rows=tuple(rows),
        advisories=tuple(advisories),
    )


def delta_pointer(
    *,
    earlier_snapshot: str,
    later_snapshot: str,
    resource_id: str,
    metric: str,
    statistic: str,
) -> str:
    """The reserved address of one compile-time difference. See :data:`DELTA_NAMESPACE`.

    Every token is escaped, because a resource id is slash-heavy and an unescaped one would
    address a different place — the same reason `compile/snapshot_view.py` escapes its tokens even
    where nothing currently needs it.
    """
    return pointer(
        DELTA_NAMESPACE,
        earlier_snapshot,
        later_snapshot,
        resource_id,
        metric,
        statistic,
        "value",
    )


def qualified(snapshot_id: str, value: SnapshotValue) -> str:
    """`<snapshot_id>#<pointer>` — an operand addressed across snapshots.

    A pointer alone identifies a position *within* a snapshot, and a delta's two operands live in
    two different ones. Qualifying with the content-addressed snapshot id makes each operand
    resolvable by anyone holding both documents, which is what a reader disputing a change
    actually needs.
    """
    return f"{snapshot_id}#{value.pointer}"


def _difference(
    earlier: SnapshotValue,
    later: SnapshotValue,
    *,
    earlier_snapshot: str,
    later_snapshot: str,
) -> SnapshotValue:
    """`later - earlier`, as a value carrying the derivation and the later run's address.

    `Decimal` arithmetic over two values already quantized at the catalog scale, so the
    difference carries no more fractional digits than either operand and the display scale can
    only pad it.

    The pointer is the **later** run's, because that is the position the difference is *about* —
    a delta answers "what does this run say, relative to the last one" — and because a figure in
    a document must resolve against the **one** snapshot that document is verified against. A
    figure pointing into the earlier snapshot could not re-resolve at all.

    Both operands are therefore named in `derived_from` **fully qualified**, as
    `<snapshot_id>#<pointer>`. A bare pointer would be ambiguous across two snapshots — the same
    `/resources/0/statistics/0/value` addresses a different resource in each — and an operand
    nobody can locate is the difference between a stated derivation and an assertion.
    """
    return SnapshotValue(
        value=later.value - earlier.value,
        unit=later.unit,
        statistic=later.statistic,
        estimator=DELTA_ESTIMATOR,
        fidelity_tier=later.fidelity_tier,
        scale=max(later.scale, earlier.scale),
        metric=later.metric,
        resource_id=later.resource_id,
        window=f"{earlier.window} -> {later.window}",
        pointer=delta_pointer(
            earlier_snapshot=earlier_snapshot,
            later_snapshot=later_snapshot,
            resource_id=later.resource_id,
            metric=later.metric,
            statistic=later.statistic,
        ),
        formula=DELTA_FORMULA,
        derived_from=(
            DerivedSource(
                kind=DELTA_SOURCE_KIND,
                name=qualified(earlier_snapshot, earlier),
                statistic=earlier.statistic,
                unit=earlier.unit,
            ),
            DerivedSource(
                kind=DELTA_SOURCE_KIND,
                name=qualified(later_snapshot, later),
                statistic=later.statistic,
                unit=later.unit,
            ),
        ),
    )


DELTA_DIRECTION_UP: Final[str] = "\u25b2"
DELTA_DIRECTION_DOWN: Final[str] = "\u25bc"
DELTA_DIRECTION_FLAT: Final[str] = "\u2014"


def direction_glyph(delta: Decimal) -> str:
    """The direction a delta moved, as a glyph.

    Glyph plus signed magnitude, **never colour** (`design-system.md`): CPU rising is not "bad",
    and disk free space falling is not the same kind of "down" as network throughput falling.
    The glyph states the direction; the prose states whether it matters. `--destructive` is
    reserved for a verification failure, and diluting it here would cost it the one meaning it
    has.
    """
    if delta > 0:
        return DELTA_DIRECTION_UP
    if delta < 0:
        return DELTA_DIRECTION_DOWN
    return DELTA_DIRECTION_FLAT
