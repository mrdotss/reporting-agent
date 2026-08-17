"""One resource's accumulators turned into statistics — exact, then percentile, then
derived.

Extracted from `azure/provider.py`, where it was a method, for one reason: **replay has to
run the same code, not equivalent code** (Req 31.1). A second implementation of this
sequence in `verify/replay.py` would make a replay mismatch mean "the two implementations
disagree" rather than "the aggregation is not deterministic", and the second reading is the
only one the audit trail is worth anything for.

Provider-neutral by construction. It takes `sku_capability_values` already resolved rather
than a `SkuCapacity`, so nothing here knows what a SKU is or which cloud named the
capability — the caller reads its own capacity object and hands over the values the
catalog's derivations bind to. That is also what keeps this module off any provider's
import graph, which is what lets `verify/replay.py` import it without importing Azure.

## Two orderings that are load-bearing

**Exact, then percentile, then derived**, per metric in `selected` order. `build_snapshot`
sorts statistics before canonicalizing, so the digest does not depend on this — but the
`collection_log` does, because gaps are appended as they are produced, and a replay whose
gap list differs from the original's would be a mismatch on the strength of ordering alone.

**Derived statistics only where at least one source metric produced a result.** Without
that guard a deallocated resource — which folds nothing by construction — reaches
`derive_statistic`, whose first act is to check the SKU capacities, and collects a
`sku_capability_missing` gap on top of the `deallocated` gap that already explains it: one
fact, two classifications, and the second one wrong.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal

from reporting_agent.catalog.loader import DerivedEntry, MetricEntry
from reporting_agent.collect.accumulate import (
    AccumulatorResult,
    MetricAccumulator,
    derive_statistic,
)
from reporting_agent.collect.snapshot import (
    StatisticEntry,
    derived_statistics,
    exact_statistics,
    percentile_statistics,
)
from reporting_agent.providers.base import GapRecord

__all__ = ["derived_sample_count", "finalize_resource"]


def finalize_resource(
    *,
    resource_id: str,
    fidelity_tier: str,
    grain: str,
    declared: Mapping[str, MetricEntry],
    selected: Sequence[str],
    accumulators: Mapping[tuple[str, str], MetricAccumulator],
    derived_entries: Sequence[DerivedEntry],
    sku_capability_values: Mapping[str, Decimal | None],
) -> tuple[list[StatisticEntry], list[GapRecord]]:
    """One resource's finalized statistics and the gaps finalizing produced.

    A pair with no result emits nothing and carries whatever gap
    `MetricAccumulator.finalize` recorded — `no_samples` for a pair that folded nothing, and
    deliberately nothing at all for an excluded resource, whose `deallocated` or
    `power_state_unknown` gap already says why (Req 27.9, 20.6).
    """
    entries: list[StatisticEntry] = []
    gaps: list[GapRecord] = []
    results: dict[str, AccumulatorResult | None] = {}

    for name in selected:
        accumulator = accumulators.get((resource_id, name))
        if accumulator is None:
            continue
        result, gap = accumulator.finalize(resource_id, name)
        if gap is not None:
            gaps.append(gap)
        results[name] = result
        if result is None:
            continue

        metric = declared[name]
        entries.extend(
            exact_statistics(result, metric=metric, fidelity_tier=fidelity_tier, grain=grain)
        )
        if accumulator.sketch is not None and metric.percentiles:
            entries.extend(
                percentile_statistics(
                    accumulator.sketch,
                    metric=metric,
                    fidelity_tier=fidelity_tier,
                    grain=grain,
                )
            )

    if not any(result is not None for result in results.values()):
        return entries, gaps

    for derived_entry in derived_entries:
        values, derived_gaps = derive_statistic(
            derived_entry,
            resource_id=resource_id,
            metric_results=results,
            sku_capability_values=sku_capability_values,
        )
        gaps.extend(derived_gaps)
        if not values:
            continue
        entries.extend(
            derived_statistics(
                values,
                entry=derived_entry,
                fidelity_tier=fidelity_tier,
                sample_count=derived_sample_count(derived_entry, results),
            )
        )

    return entries, gaps


def derived_sample_count(
    entry: DerivedEntry, results: Mapping[str, AccumulatorResult | None]
) -> int:
    """The sample count a derived value reports: its first metric source's own count.

    A derived value is computed from statistics that were each computed over some number of
    samples; the first metric source's count is the honest figure for "how much data is
    behind this number", and it is the same source `collect/snapshot.py`'s
    `_derived_estimator` reads the estimator from, so the two describe the same input. `0`
    for a derivation with no metric source at all, which the catalog does not declare today.
    """
    for source in entry.sources:
        if source.kind != "metric":
            continue
        result = results.get(source.name)
        if result is not None:
            return int(result.sample_count)
    return 0
