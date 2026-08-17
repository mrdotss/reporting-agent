"""The bounded, seeded, advisory spot check (Req 34).

A full Azure re-query would nearly double the critical path of every run, and it would
mostly test this product's own aggregation — which a unit test proves better, faster and
without a subscription. What a re-query *can* tell you that nothing else can is whether the
figures in a delivered document still correspond to what the cloud reports, and twenty-five
resources answer that as well as two thousand.

## Everything here is advisory, and that is a decision rather than a hedge

A value re-queried in September legitimately differs from one collected in July: Azure
revises late-arriving data, ages out fine-grained series, and re-computes rollups. Treating
that as a failure would make every honest run fail eventually, and a gate that eventually
fails on correct input is a gate people learn to override. So `drift_observed` is advisory,
the verification status derives from none of it (Req 34.6), and no artifact is withheld on
its account (Req 34.10).

## Selection is pure, and separate from the re-query

:func:`select` is a function over the snapshot, the resource ids the document names, and the
seed (Req 34.7). It makes no request and imports no client, so the sampler is testable
without a subscription — which matters because the interesting part of this module is the
selection, not the comparison.

Three tiers in precedence order, each resource admitted at most once, admission stopping at
25 distinct resources:

1. every resource the **document names** that the snapshot carries — the figures a reader is
   actually looking at;
2. the ten with the **highest recorded maximum** for the primary metric — the resources a
   capacity decision would turn on;
3. **10% of the snapshot, rounded up**, drawn pseudo-randomly from the seed — so a resource
   nobody is looking at can still be caught.

## Why the tie-breaking rules are load-bearing

Truncation at the cap has to be deterministic, or a disputed check is not re-runnable — and
"re-runnable identically" is the entire value of recording `{n, method, seed}` before the
first re-query. So candidates within a tier are ordered by ascending resource id, a tie in
the recorded maximum breaks by ascending resource id, and a tie in resource count between two
resource types breaks by ascending resource type id (Req 34.4). Without the last one, the
*primary metric* itself would depend on dictionary iteration order, and two runs over one
snapshot would sample against different metrics.
"""

from __future__ import annotations

import hashlib
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Final

from reporting_agent.compile.snapshot_view import SnapshotView
from reporting_agent.verify.findings import (
    FINDING_DRIFT_OBSERVED,
    DriftSample,
    Finding,
    record_finding,
)
from reporting_agent.verify.ports import MetricRequeryPort

__all__ = [
    "DRIFT_SAMPLE_METHOD",
    "MAX_SAMPLE",
    "NAMED_TIER",
    "RANDOM_TIER_FRACTION",
    "TOP_TIER",
    "DriftOutcome",
    "primary_metric",
    "requery_sample",
    "select",
]

MAX_SAMPLE: Final[int] = 25
"""Req 34.1's cap. A hard stop, not a target — a snapshot of 2,000 resources samples 25."""

TOP_TIER: Final[int] = 10
RANDOM_TIER_FRACTION: Final[int] = 10
"""Tier three is one tenth of the snapshot, rounded **up**, so a snapshot of one resource
still contributes one candidate rather than none."""

DRIFT_SAMPLE_METHOD: Final[str] = "named+top10+10pct_capped25"
"""The selection rule's identifier, recorded on the result (Req 34.3).

A string naming the rule rather than a version number: the descriptor exists so a disputed
check can be re-run identically, and a reader of a two-year-old verification record needs to
know *which* rule ran, not which release it shipped in.
"""

NAMED_TIER: Final[str] = "named"


@dataclass(frozen=True, slots=True)
class DriftOutcome:
    """What one drift pass observed. Every field is advisory."""

    sample: DriftSample
    findings: tuple[Finding, ...]
    requeried: int


def primary_metric(
    view: SnapshotView, definition: Mapping[str, object]
) -> tuple[str, str] | None:
    """`(resource type, metric name)` for the report's primary metric (Req 34.1).

    The metric the pinned version's selection names **first** for the resource type carrying
    the most resources in the snapshot. First rather than "the most important", because
    there is no ordering over metrics that means anything — the template's own first choice
    is the only defensible reading and it is one the author controls.

    A tie in resource count breaks by ascending resource type id. That rule is doing real
    work: without it the primary metric depends on dictionary iteration order, and two
    verifications of one snapshot would spot-check different metrics.
    """
    counts: dict[str, int] = {}
    for resource in view.resources:
        counts[resource.resource_type] = counts.get(resource.resource_type, 0) + 1
    if not counts:
        return None

    selection = definition.get("metrics")
    chosen = min(counts.items(), key=lambda item: (-item[1], item[0]))[0]

    if not isinstance(selection, Mapping):
        return None
    for resource_type, entries in sorted(selection.items()):
        if str(resource_type).casefold() != chosen.casefold():
            continue
        for entry in entries if isinstance(entries, Sequence) else ():
            if isinstance(entry, Mapping) and isinstance(entry.get("metric"), str):
                return (chosen, str(entry["metric"]))
    return None


def select(
    view: SnapshotView,
    *,
    named: Iterable[str],
    seed: str,
    metric: str | None = None,
    statistic: str = "max",
) -> tuple[str, ...]:
    """The sampled resource ids, in admission order. **Pure** (Req 34.7).

    Deterministic in every respect that could vary: each tier is ordered by ascending
    resource id before admission, the ranking tie breaks by ascending resource id, and the
    pseudo-random tier is a keyed digest over `(seed, resource id)` rather than anything
    from `random` — a module-level RNG would make the selection depend on how many other
    draws happened first in the process.
    """
    present = {resource.resource_id for resource in view.resources}
    admitted: list[str] = []
    seen: set[str] = set()

    def admit(candidates: Iterable[str]) -> None:
        for resource_id in candidates:
            if len(admitted) >= MAX_SAMPLE:
                return
            if resource_id in seen or resource_id not in present:
                continue
            seen.add(resource_id)
            admitted.append(resource_id)

    admit(sorted(set(named)))
    admit(_top_by_recorded_maximum(view, metric=metric, statistic=statistic))
    admit(_pseudo_random(sorted(present), seed=seed))
    return tuple(admitted)


def _top_by_recorded_maximum(
    view: SnapshotView, *, metric: str | None, statistic: str
) -> tuple[str, ...]:
    """The ten resources with the highest recorded value for the primary metric.

    A resource carrying no value for that metric is not a candidate here — it has no
    recorded maximum to rank by, and treating an absent value as zero would rank a resource
    the collector could not read *below* every resource it could, which is backwards: the
    unreadable one is the more interesting.
    """
    if metric is None:
        return ()
    ranked: list[tuple[Decimal, str]] = []
    for resource in view.resources:
        value = view.stat(resource.resource_id, metric, statistic)
        if value is None:
            continue
        ranked.append((value.value, resource.resource_id))
    ranked.sort(key=lambda item: (-item[0], item[1]))
    return tuple(resource_id for _, resource_id in ranked[:TOP_TIER])


def _pseudo_random(resource_ids: Sequence[str], *, seed: str) -> tuple[str, ...]:
    """One tenth of `resource_ids`, rounded up, drawn from a keyed digest of the seed.

    Ordering by `sha256(seed || resource_id)` rather than by a shuffled list: it is
    reproducible from the recorded seed alone, needs no state, and cannot be perturbed by an
    unrelated draw elsewhere in the process. Ties in the digest — which do not occur in
    practice — break by ascending resource id, so the order is total either way.
    """
    if not resource_ids:
        return ()
    wanted = -(-len(resource_ids) // RANDOM_TIER_FRACTION)
    keyed = sorted(
        resource_ids,
        key=lambda resource_id: (
            hashlib.sha256(f"{seed}\x00{resource_id}".encode()).hexdigest(),
            resource_id,
        ),
    )
    return tuple(keyed[:wanted])


async def requery_sample(
    view: SnapshotView,
    *,
    sample: Sequence[str],
    seed: str,
    metric: str | None,
    statistic: str,
    window: Mapping[str, str],
    grain: str,
    requery: MetricRequeryPort | None,
) -> DriftOutcome:
    """Re-query the sample and compare, recording the descriptor first (Req 34.3).

    The descriptor is built **before** the port is touched and is returned whether or not a
    finding results, so a disputed check is re-runnable identically even when this run found
    nothing. That ordering is the requirement, not a convenience: a descriptor written after
    the fact would be a description of what happened rather than of what was asked for.

    A port that raises is treated as a port that answered nothing. The alternative — letting
    it propagate — would turn an expired credential or a network blip into a failed
    verification of a document that is correct, which is precisely the coupling Req 34.10
    forbids.
    """
    descriptor: DriftSample = {
        "n": len(sample),
        "method": DRIFT_SAMPLE_METHOD,
        "seed": seed,
        "not_requeried": [],
    }
    if requery is None or metric is None or not sample:
        descriptor["not_requeried"] = list(sample)
        return DriftOutcome(sample=descriptor, findings=(), requeried=0)

    try:
        answers = await requery.requery(
            resource_ids=list(sample),
            metric=metric,
            statistic=statistic,
            window=dict(window),
            grain=grain,
        )
    except Exception:
        descriptor["not_requeried"] = list(sample)
        return DriftOutcome(sample=descriptor, findings=(), requeried=0)

    by_resource = {answer.resource_id: answer for answer in answers}
    findings: list[Finding] = []
    requeried = 0

    for resource_id in sample:
        answer = by_resource.get(resource_id)
        recorded = view.stat(resource_id, metric, statistic)
        if answer is None or recorded is None:
            descriptor["not_requeried"].append(resource_id)
            continue
        requeried += 1
        # Compared at **the precision the snapshot records** (Req 34.5), not at full
        # precision: the snapshot's value is a decimal string at the catalog's declared
        # scale, and a re-query answering one digit finer is not drift.
        if _at_recorded_precision(answer.value, recorded.scale) == _at_recorded_precision(
            recorded.value, recorded.scale
        ):
            continue
        findings.append(
            record_finding(
                FINDING_DRIFT_OBSERVED,
                f"the re-queried {statistic} of {metric!r} for {resource_id} over "
                f"{window.get('start', '')}–{window.get('end', '')} is "
                f"{answer.value}, and the snapshot records {recorded.value}; a value "
                f"re-queried later legitimately differs from one collected earlier",
                resource_id=resource_id,
                expected=str(recorded.value),
                observed=str(answer.value),
                snapshot_path=recorded.pointer,
            )
        )

    return DriftOutcome(sample=descriptor, findings=tuple(findings), requeried=requeried)


def _at_recorded_precision(value: Decimal, scale: int) -> Decimal:
    try:
        return value.quantize(Decimal(1).scaleb(-max(scale, 0)))
    except InvalidOperation:  # pragma: no cover - a value too large to quantize
        return value
