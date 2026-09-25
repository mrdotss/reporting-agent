"""SKU capacity resolution: `resource_skus.list`, always location-filtered.

**Why `vCPUs` is not a fallback (Req 21.2, 21.3, 21.9).** A constrained-core SKU
reports the *parent* SKU's advertised core count in `vCPUs` and its actual exposed
core count in `vCPUsAvailable` — `Standard_E32-8s_v5` advertises 32 and exposes 8.
Reading `vCPUs` when `vCPUsAvailable` is missing would not degrade gracefully; it
would silently overstate capacity by 4x and corrupt every derived per-core figure.
So a missing or unparseable `vCPUsAvailable` is a recorded `sku_capability_missing`
gap, full stop — there is no code path in this module that ever reads `vCPUs` for a
capacity computation.

**Why the cache holds capacity, not the raw listing (Req 21.6, 21.11).** One
`resource_skus.list` response for a location is parsed into `sku_name -> SkuCapacity`
exactly once, keyed by `(subscription_id, location)`. Every subsequent
:meth:`SkuCatalog.resolve` against that pair — for any SKU name, for any resource —
is served from that dict with no further listing call. The cache is an attribute of
one `SkuCatalog` instance, not module state, so it can be discarded at run end
(:meth:`SkuCatalog.discard`) without any risk of one run's subscription-scoped SKU
restrictions leaking into the next invocation inside the same long-lived container.

**Why a gap names the resource, not the SKU (Req 21.7, 21.9, 21.10).**
`collect/log.py`'s `record_gap` convention is that `resource_id` names *the affected
resource* — the identifier a reader needs to act on. A SKU shared by many resources
that turns out to be unknown or missing a capability affects every one of them, so
`resolve` takes the caller's `resource_id` and records one gap per call, naming that
resource; the SKU name itself travels in the gap's `message` text instead, since
`GapRecord` carries no field of its own for it. The cache's own contents are not
resource-scoped at all, which is what lets one listing call answer for every
resource sharing a SKU.

**No `float` anywhere (Req 21.12).** Every capability value is read as a `str` and
parsed with `Decimal`; the GiB-to-bytes conversion multiplies by the exact integer
`1073741824` (2**30) under `Decimal` arithmetic. There is no float literal, no
`float()` call and no implicit int/float promotion on the path from a capability
string to a `SkuCapacity` field.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
from typing import Final

from reporting_agent.azure.ports import RawHttpResponse, SkuPort
from reporting_agent.collect.log import (
    GAP_TYPE_SKU_CAPABILITY_MISSING,
    GAP_TYPE_SKU_UNKNOWN,
    record_gap,
)
from reporting_agent.providers.base import GapRecord

__all__ = [
    "CAPABILITY_MEMORY_GB",
    "CAPABILITY_VCPUS_AVAILABLE",
    "GIB_TO_BYTES",
    "SkuCapacity",
    "SkuCatalog",
]

logger = logging.getLogger(__name__)

CAPABILITY_VCPUS_AVAILABLE: Final[str] = "vCPUsAvailable"
"""The capability this module reads for vCPU capacity (Req 21.2)."""

CAPABILITY_MEMORY_GB: Final[str] = "MemoryGB"
"""The capability this module reads for memory capacity, a decimal string in GiB
(Req 21.4)."""

_CAPABILITY_VCPUS_PARENT: Final[str] = "vCPUs"
"""Named only so the gap message can say, by name, which capability is deliberately
never read in `vCPUsAvailable`'s place (Req 21.3, 21.9). Never passed to
`_parse_capability` for a capacity computation."""

GIB_TO_BYTES: Final[Decimal] = Decimal(1073741824)
"""Exactly 2**30, as a `Decimal` built from an `int` rather than parsed from a string
literal, so there is no textual rounding step between "the constant this module
multiplies by" and "the constant Req 21.5 names" (Req 21.5)."""


@dataclass(frozen=True, slots=True)
class SkuCapacity:
    """One SKU's resolved capacity in one location.

    `vcpus_available` and `memory_bytes` are independently `None` when their source
    capability was absent from the listing or failed to parse as `Decimal` (Req 21.9,
    21.10) — one missing capability never blocks resolving the other, and neither
    ever falls back to a different capability. Both are `Decimal` or `None`; never
    `float` (Req 21.12). `memory_bytes` is already converted from `MemoryGB` (GiB) to
    bytes (Req 21.5); there is no separate GiB-valued field.
    """

    sku_name: str
    vcpus_available: Decimal | None
    memory_bytes: Decimal | None


class SkuCatalog:
    """Resolves per-resource SKU capacity against a **location-filtered** listing
    (Req 21.1), cached by `(subscription_id, location)` and discarded at run end
    (Req 21.11).

    One instance per run. The cache lives on `self._cache`, never at module scope, so
    a run's SKU restrictions — which are subscription-scoped — cannot leak into a
    later invocation inside the same long-lived container; :meth:`discard` makes that
    explicit rather than relying on the instance simply going out of scope.
    """

    def __init__(self, port: SkuPort) -> None:
        self._port = port
        self._cache: dict[tuple[str, str], dict[str, SkuCapacity]] = {}

    async def resolve(
        self,
        *,
        subscription_id: str,
        location: str,
        sku_name: str,
        resource_id: str,
    ) -> tuple[SkuCapacity | None, list[GapRecord]]:
        """Resolve `sku_name`'s capacity in `location`, for the resource named
        `resource_id`.

        Returns `(None, [gap])` with a `sku_unknown` gap when `location`'s listing
        carries no SKU named `sku_name` (Req 21.7) — the caller derives no value that
        depends on this resource's SKU capacity (Req 21.8 is the accumulator's
        obligation; the `None` return is what makes it enforceable there).

        Otherwise returns a `SkuCapacity` whose `vcpus_available` and/or
        `memory_bytes` may themselves be `None`, each carrying its own
        `sku_capability_missing` gap naming the capability in `metric` and the SKU in
        `message` (Req 21.9, 21.10) — never a fallback to the `vCPUs` capability.

        Issues at most one `list_skus` call per distinct `(subscription_id,
        location)` for the lifetime of this instance (Req 21.6); every other call
        against a pair already resolved is served from the cache.
        """
        catalog = await self._catalog_for(subscription_id, location)
        capacity = catalog.get(sku_name)

        if capacity is None:
            gap = record_gap(
                GAP_TYPE_SKU_UNKNOWN,
                resource_id,
                None,
                f"SKU {sku_name!r} is absent from the resource_skus listing for "
                f"location {location!r}; no capacity value can be resolved for "
                f"resource {resource_id!r}.",
            )
            return None, [gap]

        gaps: list[GapRecord] = []

        if capacity.vcpus_available is None:
            gaps.append(
                record_gap(
                    GAP_TYPE_SKU_CAPABILITY_MISSING,
                    resource_id,
                    CAPABILITY_VCPUS_AVAILABLE,
                    f"SKU {sku_name!r} carries no parseable "
                    f"{CAPABILITY_VCPUS_AVAILABLE} capability, so no vCPU capacity "
                    f"is available for resource {resource_id!r}; the "
                    f"{_CAPABILITY_VCPUS_PARENT} capability is never read in its "
                    f"place because it reports the parent SKU's core count.",
                )
            )

        if capacity.memory_bytes is None:
            gaps.append(
                record_gap(
                    GAP_TYPE_SKU_CAPABILITY_MISSING,
                    resource_id,
                    CAPABILITY_MEMORY_GB,
                    f"SKU {sku_name!r} carries no parseable {CAPABILITY_MEMORY_GB} "
                    f"capability, so no memory capacity is available for resource "
                    f"{resource_id!r}.",
                )
            )

        return capacity, gaps

    async def _catalog_for(
        self, subscription_id: str, location: str
    ) -> dict[str, SkuCapacity]:
        """The `sku_name -> SkuCapacity` map for one `(subscription_id, location)`
        pair, listing exactly once and caching the parsed result (Req 21.6, 21.11)."""
        key = (subscription_id, location)
        cached = self._cache.get(key)
        if cached is not None:
            return cached

        response = await self._port.list_skus(
            subscription_id=subscription_id, location=location
        )
        catalog = _parse_listing(response, location=location)
        self._cache[key] = catalog
        return catalog

    def discard(self) -> None:
        """Discard every cached listing (Req 21.11). Called once, at run end."""
        self._cache.clear()


def _parse_listing(response: RawHttpResponse, *, location: str) -> dict[str, SkuCapacity]:
    """One location's `resource_skus.list` response, parsed into `sku_name ->
    SkuCapacity`.

    A response that did not succeed, or whose body is not the expected shape, parses
    to an empty catalog rather than raising: every SKU that would have resolved
    against it instead records `sku_unknown` from `resolve` — the same underlying
    fact, "this location's listing did not provide capacity for this SKU," reached
    from the input side rather than invented as a second failure mode.
    """
    if not response.ok:
        logger.warning(
            "resource_skus.list for location %r returned status %d; treating the "
            "listing as empty for this run.",
            location,
            response.status,
        )
        return {}

    body = response.body
    entries = body.get("value") if isinstance(body, Mapping) else None
    if not isinstance(entries, list):
        return {}

    catalog: dict[str, SkuCapacity] = {}
    for entry in entries:
        if not isinstance(entry, Mapping):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        capabilities = _capability_map(entry.get("capabilities"))
        catalog[name] = SkuCapacity(
            sku_name=name,
            vcpus_available=_parse_capability(capabilities, CAPABILITY_VCPUS_AVAILABLE),
            memory_bytes=_memory_bytes(capabilities),
        )
    return catalog


def _capability_map(raw: object) -> Mapping[str, str]:
    """The `capability name -> value` mapping out of a SKU entry's `capabilities`
    array, skipping any entry that is not a well-formed `{"name": str, "value":
    str}` pair rather than raising on it."""
    if not isinstance(raw, list):
        return {}
    result: dict[str, str] = {}
    for item in raw:
        if not isinstance(item, Mapping):
            continue
        name = item.get("name")
        value = item.get("value")
        if isinstance(name, str) and isinstance(value, str):
            result[name] = value
    return result


def _parse_capability(capabilities: Mapping[str, str], name: str) -> Decimal | None:
    """`capabilities[name]` as a `Decimal`, or `None` if the capability is absent or
    fails to parse (Req 21.9, 21.10). Never raises."""
    raw = capabilities.get(name)
    if raw is None:
        return None
    try:
        return Decimal(raw)
    except (InvalidOperation, ValueError, TypeError):
        return None


def _memory_bytes(capabilities: Mapping[str, str]) -> Decimal | None:
    """`MemoryGB` converted to bytes with exact `Decimal` arithmetic (Req 21.5), or
    `None` if `MemoryGB` itself is absent or unparseable (Req 21.10)."""
    memory_gib = _parse_capability(capabilities, CAPABILITY_MEMORY_GB)
    if memory_gib is None:
        return None
    return memory_gib * GIB_TO_BYTES
