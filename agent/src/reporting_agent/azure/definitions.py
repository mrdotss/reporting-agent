"""Metric definitions, probed once per `(resource_type, region)` and cached (Req 22).

Definitions are identical across every resource of one type in one region, so probing
per resource is hundreds of wasted calls that burn the request quota the actual metric
queries need. This module is the single place that fact gets exploited: a caller asks
:meth:`DefinitionProbe.definitions_for` for a pair as many times as it likes across the
pair's resources, and the underlying `DefinitionsPort.list_metric_definitions` probe
runs **at most once** for a pair that ever succeeds (Req 22.1, 22.2).

**Probe target selection is deterministic, not "whichever resource happens to be
handy."** The lowest-sorting resource id in the pair, by plain Unicode code-point order
— the same ordering `providers.base.sort_inventory` uses for the inventory array — is
tried first, and a failure retries against at most 2 further distinct resources of that
pair (Req 22.4). Two runs over the same inventory therefore probe the same resource,
which is what makes a probe failure reproducible rather than a function of dict
iteration order.

**A failed pair is a fact about the pair, not about the cache.** Req 22.6 is explicit:
when every attempt for a pair fails, *nothing* is stored in the cache for it. This
module honours that literally — a failed pair is **not** memoised as "unavailable," so
a second call for the same pair re-attempts the full probe sequence rather than serving
a remembered failure. That looks like it reopens the quota-spend problem this module
exists to solve, but it does not: the batch planner in `azure/metrics.py` groups by
`(subscription, location, resource_type)` and asks this module for a pair's definitions
once per group, so in practice a pair is asked for once. What Req 22.6 is actually
protecting against is a *cached negative* quietly becoming indistinguishable from a
cached positive three phases later — the same "don't invent a fact you don't have"
reasoning that keeps a failed probe from ever becoming a `metric_not_emitted` gap
(Req 22.6, and see `DefinitionsResult` below).

**The fallback is a value, not a side channel.** A pair whose every attempt fails
still needs an answer — the collector must request the Metric_Catalog's declared
metric set for that pair rather than skipping its resources (Req 22.5). Rather than a
raised exception or a bare empty tuple a caller could mistake for "this type has no
metrics," :meth:`definitions_for` always returns a :class:`DefinitionsResult`, whose
`source` field is the one place "probed successfully" and "fell back to the catalog"
are told apart, and whose `gap` field carries the `definitions_unavailable` gap
(Req 22.5) exactly when the fallback happened and is `None` otherwise. A caller that
ignores `source` still gets a usable `metric_names` tuple either way — the fallback is
never a hole where metrics used to be.

**Never a `metric_not_emitted` gap.** This module records exactly one gap type,
`definitions_unavailable`, and only when the whole probe sequence fails. Deciding that
one specific metric a resource's platform genuinely does not emit is
`azure/metrics.py`'s job, downstream of a *successful* definitions probe — conflating
the two would make an unanswered probe indistinguishable from a metric the platform
does not emit, which is precisely the distinction Req 22.6 exists to preserve.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final, Literal

from reporting_agent.azure.ports import DefinitionsPort, RawHttpResponse
from reporting_agent.catalog.loader import LoadedCatalog
from reporting_agent.collect.log import GAP_TYPE_DEFINITIONS_UNAVAILABLE, record_gap
from reporting_agent.providers.base import GapRecord

__all__ = [
    "MAX_PROBE_ATTEMPTS",
    "DefinitionProbe",
    "DefinitionsResult",
]

MAX_PROBE_ATTEMPTS: Final[int] = 3
"""The lowest-sorting resource, plus at most 2 further distinct resources (Req 22.4).
A pair with fewer than 3 distinct resource ids is probed against every one it has and
no more — there is nothing further to retry against."""

type DefinitionSource = Literal["probed", "catalog_fallback"]


@dataclass(frozen=True, slots=True)
class DefinitionsResult:
    """What a `(resource_type, region)` pair resolved to.

    `source` is the one field that distinguishes a genuine probe answer from a
    catalog fallback — a caller that only reads `metric_names` cannot tell the two
    apart, which is deliberate for anything that just wants "the names to request,"
    but a caller building the collection log needs to know which one occurred, hence
    `gap`: present (and `definitions_unavailable`) exactly when `source` is
    `"catalog_fallback"`, `None` when it is `"probed"`. There is no representable way
    to construct a `"probed"` result carrying a gap, or a `"catalog_fallback"` result
    carrying none, because every construction of this type happens in exactly one of
    the two branches inside :meth:`DefinitionProbe.definitions_for`.
    """

    resource_type: str
    region: str
    metric_names: tuple[str, ...]
    source: DefinitionSource
    gap: GapRecord | None = None

    @property
    def is_fallback(self) -> bool:
        """Whether this pair's metric names came from the catalog rather than a
        successful probe (Req 22.5)."""
        return self.source == "catalog_fallback"


class DefinitionProbe:
    """Probes `MonitorManagementClient.metric_definitions.list` at most once per
    `(resource_type, region)` pair that ever succeeds, and caches that success for the
    life of the run (Req 22.1, 22.2, 22.7).

    Constructed with the `DefinitionsPort` seam (Req 22.1's transport) and the loaded
    Metric_Catalog (the fallback source for Req 22.5). The cache is a plain instance
    attribute with no eviction policy beyond the instance's own lifetime — one
    `DefinitionProbe` per run, discarded with the run, is what "discard that cache
    when the run ends" (Req 22.7) means in a process with no other notion of a run
    boundary.
    """

    def __init__(self, port: DefinitionsPort, catalog: LoadedCatalog) -> None:
        self._port = port
        self._catalog = catalog
        self._cache: dict[tuple[str, str], DefinitionsResult] = {}

    def is_cached(self, resource_type: str, region: str) -> bool:
        """Whether a pair already has a cached, successfully probed result.

        Exposed for tests and for a caller that wants to know whether asking will
        cost a probe without triggering one — `definitions_for` itself never needs
        this, since it checks the same cache internally.
        """
        return (resource_type, region) in self._cache

    async def definitions_for(
        self,
        *,
        resource_type: str,
        region: str,
        metric_namespace: str,
        resource_ids: Sequence[str],
    ) -> DefinitionsResult:
        """The metric names available for one `(resource_type, region)` pair.

        `resource_ids` is every resource id known so far for this pair — the caller's
        full candidate pool, not a preselected probe target. This method chooses the
        probe target itself (Req 22.4): a repeated call for a pair that already
        succeeded returns the cached result and touches `resource_ids` only enough to
        validate it is non-empty; a pair that has not yet succeeded probes the
        lowest-sorting distinct id first and, on failure, up to 2 further distinct
        ids from the same pool, so a caller that accumulates resource ids across a
        run and calls this once per resource still costs at most 3 probes for the
        pair rather than one per call.

        Raises `ValueError` if `resource_ids` is empty — there is no resource in scope
        to probe, and returning a silent fallback would look identical to a fallback
        this module chose deliberately.
        """
        if not resource_ids:
            raise ValueError(
                f"definitions_for requires at least one resource id to probe for "
                f"resource type {resource_type!r} in region {region!r}, got none"
            )

        key = (resource_type, region)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        candidates = sorted(set(resource_ids))[:MAX_PROBE_ATTEMPTS]

        for resource_id in candidates:
            response = await self._port.list_metric_definitions(
                resource_id=resource_id, metric_namespace=metric_namespace
            )
            names = _extract_metric_names(response)
            if names is not None:
                result = DefinitionsResult(
                    resource_type=resource_type,
                    region=region,
                    metric_names=names,
                    source="probed",
                )
                self._cache[key] = result
                return result

        # Every attempt failed. Nothing is written to the cache (Req 22.6): a later
        # call for this same pair re-attempts the full sequence rather than serving a
        # remembered failure, so an "unavailable" pair never masquerades as a fact
        # this module is confident about.
        gap = record_gap(
            GAP_TYPE_DEFINITIONS_UNAVAILABLE,
            f"{resource_type} in {region}",
            None,
            (
                f"every metric-definitions probe failed for resource type "
                f"{resource_type!r} in region {region!r} after "
                f"{len(candidates)} attempt(s) against {tuple(candidates)}; the "
                f"collector requests the catalog's declared metric set for this "
                f"pair rather than skipping its resources"
            ),
        )
        return DefinitionsResult(
            resource_type=resource_type,
            region=region,
            metric_names=_catalog_metric_names(self._catalog, resource_type),
            source="catalog_fallback",
            gap=gap,
        )


def _extract_metric_names(response: RawHttpResponse) -> tuple[str, ...] | None:
    """The metric names in a `metric_definitions.list` response, or `None` if the
    probe itself failed. **Pure.**

    `None` — not an empty tuple — is "this attempt failed, try the next resource."
    An empty tuple is a distinct, legitimate answer: a successful probe against a
    resource type Azure reports zero metric definitions for. Collapsing the two would
    make `definitions_for` retry a resource type that genuinely has no definitions
    exactly as if the probe itself never landed.
    """
    if not response.ok:
        return None

    body = response.body
    if not isinstance(body, Mapping):
        return None

    raw_value = body.get("value")
    if not isinstance(raw_value, list):
        return None

    names: list[str] = []
    for entry in raw_value:
        if not isinstance(entry, Mapping):
            continue
        name_field = entry.get("name")
        candidate = name_field.get("value") if isinstance(name_field, Mapping) else name_field
        if isinstance(candidate, str) and candidate.strip():
            names.append(candidate)
    return tuple(names)


def _catalog_metric_names(catalog: LoadedCatalog, resource_type: str) -> tuple[str, ...]:
    """The Metric_Catalog's declared metric names for `resource_type` (Req 22.5).
    **Pure.** Empty when the catalog declares nothing for that type — still a valid
    fallback, just an uninformative one."""
    resource_catalog = catalog.for_resource_type(resource_type)
    if resource_catalog is None:
        return ()
    return tuple(metric.name for metric in resource_catalog.metrics)
