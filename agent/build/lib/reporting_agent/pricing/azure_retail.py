"""Azure Retail Prices lookups for VM sizes (ask-chat Req 4).

`https://prices.azure.com/api/retail/prices` is public and unauthenticated, so no secret is
involved. What is guarded instead:

- **The filter.** A SKU and a region come from a snapshot, which is data a customer's
  resource names flow through. Each is matched against a strict pattern before it is
  interpolated into the OData `$filter`, so a crafted value cannot widen the query.
- **The follow-up link.** `NextPageLink` is followed only when it points back at the same
  endpoint, and at most a few pages deep.
- **The number.** `retailPrice` is parsed as its JSON text, never as a float, so the string
  a chat cites is the string the API sent.

Pay-as-you-go consumption rows only: Spot and Low Priority meters are skipped. One Linux and
one Windows price are kept per size, when the API has them.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import ssl
import threading
import time
import urllib.request
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final
from urllib.parse import urlencode

__all__ = [
    "API_VERSION",
    "MAX_PAIRS",
    "RETAIL_PRICES_URL",
    "AzureRetailPrices",
    "PriceLookupResult",
    "RetailPrice",
    "VmPricePair",
    "build_query_url",
    "parse_items",
]

logger = logging.getLogger(__name__)

RETAIL_PRICES_URL: Final[str] = "https://prices.azure.com/api/retail/prices"
API_VERSION: Final[str] = "2023-01-01-preview"
MAX_PAIRS: Final[int] = 25
MAX_PAGES: Final[int] = 3
TIMEOUT_S: Final[float] = 10.0
CACHE_TTL_S: Final[float] = 24 * 60 * 60
MAX_BODY_BYTES: Final[int] = 4_000_000

_SKU: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9_]{1,64}$")
_REGION: Final[re.Pattern[str]] = re.compile(r"^[a-z0-9]{1,40}$")

Fetch = Callable[[str], Mapping[str, Any]]


@dataclass(frozen=True, slots=True)
class VmPricePair:
    sku: str
    region: str


@dataclass(frozen=True, slots=True)
class RetailPrice:
    sku: str
    region: str
    operating_system: str
    retail_price: str
    unit_of_measure: str
    currency: str
    effective_start: str


@dataclass(frozen=True, slots=True)
class PriceLookupResult:
    prices: tuple[RetailPrice, ...]
    unavailable: tuple[VmPricePair, ...]


def normalize_pair(sku: str, region: str) -> VmPricePair | None:
    """The pair as the API spells it, or `None` when either part is not a safe token."""
    sku_token = sku.strip()
    region_token = region.strip().lower().replace(" ", "")
    if not _SKU.match(sku_token) or not _REGION.match(region_token):
        return None
    return VmPricePair(sku=sku_token, region=region_token)


def build_query_url(pair: VmPricePair) -> str:
    if not _SKU.match(pair.sku) or not _REGION.match(pair.region):
        raise ValueError("a price lookup pair must be normalized before it is queried")
    query = (
        "serviceName eq 'Virtual Machines' and priceType eq 'Consumption' "
        f"and armRegionName eq '{pair.region}' and armSkuName eq '{pair.sku}'"
    )
    return f"{RETAIL_PRICES_URL}?{urlencode({'api-version': API_VERSION, '$filter': query})}"


def parse_items(pair: VmPricePair, items: Iterable[object]) -> list[RetailPrice]:
    chosen: dict[str, RetailPrice] = {}
    for item in items:
        if not isinstance(item, Mapping) or item.get("type") != "Consumption":
            continue
        sku_name = str(item.get("skuName", ""))
        if "Spot" in sku_name or "Low Priority" in sku_name:
            continue
        if item.get("isPrimaryMeterRegion") is False:
            continue
        price = item.get("retailPrice")
        if not isinstance(price, str) or not re.fullmatch(r"\d+(?:\.\d+)?(?:[eE][-+]?\d+)?", price):
            continue
        operating_system = "Windows" if "Windows" in str(item.get("productName", "")) else "Linux"
        if operating_system in chosen:
            continue
        chosen[operating_system] = RetailPrice(
            sku=pair.sku,
            region=pair.region,
            operating_system=operating_system,
            retail_price=price,
            unit_of_measure=str(item.get("unitOfMeasure", "")),
            currency=str(item.get("currencyCode", "USD")),
            effective_start=str(item.get("effectiveStartDate", "")),
        )
    return [chosen[name] for name in sorted(chosen)]


class AzureRetailPrices:
    """A cached lookup. One instance per process, so the cache outlives an invocation."""

    def __init__(
        self,
        *,
        fetch: Fetch | None = None,
        ca_bundle: str = "",
        clock: Callable[[], float] = time.monotonic,
        ttl_s: float = CACHE_TTL_S,
    ) -> None:
        self._fetch = fetch if fetch is not None else _https_fetch(ca_bundle)
        self._clock = clock
        self._ttl_s = ttl_s
        self._cache: dict[VmPricePair, tuple[float, tuple[RetailPrice, ...]]] = {}
        self._lock = threading.Lock()

    async def __call__(self, pairs: Sequence[VmPricePair]) -> PriceLookupResult:
        return await asyncio.to_thread(self.lookup, pairs)

    def lookup(self, pairs: Sequence[VmPricePair]) -> PriceLookupResult:
        prices: list[RetailPrice] = []
        unavailable: list[VmPricePair] = []
        for pair in list(dict.fromkeys(pairs))[:MAX_PAIRS]:
            cached = self._cached(pair)
            if cached is None:
                try:
                    cached = tuple(self._fetch_pair(pair))
                except Exception as exc:  # a price is decoration, never a failed turn
                    logger.warning(
                        "the list price for %s in %s could not be read (%s)",
                        pair.sku,
                        pair.region,
                        type(exc).__name__,
                    )
                    unavailable.append(pair)
                    continue
                with self._lock:
                    self._cache[pair] = (self._clock() + self._ttl_s, cached)
            if cached:
                prices.extend(cached)
            else:
                unavailable.append(pair)
        return PriceLookupResult(prices=tuple(prices), unavailable=tuple(unavailable))

    def _cached(self, pair: VmPricePair) -> tuple[RetailPrice, ...] | None:
        with self._lock:
            entry = self._cache.get(pair)
            if entry is None or entry[0] < self._clock():
                return None
            return entry[1]

    def _fetch_pair(self, pair: VmPricePair) -> list[RetailPrice]:
        url: str | None = build_query_url(pair)
        items: list[object] = []
        for _page in range(MAX_PAGES):
            if url is None:
                break
            body = self._fetch(url)
            page_items = body.get("Items")
            if isinstance(page_items, Sequence):
                items.extend(page_items)
            next_link = body.get("NextPageLink")
            url = next_link if isinstance(next_link, str) and next_link.startswith(RETAIL_PRICES_URL + "?") else None
        return parse_items(pair, items)


def _https_fetch(ca_bundle: str) -> Fetch:
    context = _ssl_context(ca_bundle)

    def fetch(url: str) -> Mapping[str, Any]:
        request = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=TIMEOUT_S, context=context) as response:
            raw = response.read(MAX_BODY_BYTES + 1)
        if len(raw) > MAX_BODY_BYTES:
            raise ValueError("the price response exceeded the size limit")
        body = json.loads(raw, parse_float=str, parse_int=str)
        if not isinstance(body, Mapping):
            raise ValueError("the price response is not an object")
        return body

    return fetch


def _ssl_context(ca_bundle: str) -> ssl.SSLContext:
    try:
        import certifi

        context = ssl.create_default_context(cafile=certifi.where())
    except ImportError:  # pragma: no cover - certifi ships with httpx
        context = ssl.create_default_context()
    if ca_bundle:
        context.load_verify_locations(cafile=ca_bundle)
    return context
