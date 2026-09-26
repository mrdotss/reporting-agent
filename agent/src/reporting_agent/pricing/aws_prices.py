"""AWS list prices for EC2 instance types and RDS classes (ask-chat, AWS).

The Price List API (`pricing:GetProducts`) answers with the on-demand rate as a decimal
string — `"0.0104000000"` — and that string is what a chat cites, exactly as the Azure lookup
cites `retailPrice`. It is called with the **runtime's own** role, never a customer's:
list prices are public and nothing about them is the customer's.

What is guarded:
- **The filter.** An instance type, a region and an engine come from a snapshot, which is
  data a customer's resources flow through. Each is matched against a strict pattern before
  it becomes a filter value, so a crafted value cannot widen the query.
- **The product.** EC2 is asked for shared tenancy, no pre-installed software, capacity in
  use and the license-included model, once for Linux and once for Windows — the same pair
  the Azure lookup keeps. RDS is asked for one engine and one deployment option.
- **The number.** The price is read as the API's string and never through a float.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final

from reporting_agent.pricing.azure_retail import (
    MAX_PAIRS,
    PriceLookupResult,
    RetailPrice,
    VmPricePair,
)

__all__ = [
    "PROVIDER_AWS",
    "RDS_ENGINES",
    "AwsListPrices",
    "CombinedPrices",
    "normalize_aws_pair",
    "parse_products",
    "product_filters",
]

logger = logging.getLogger(__name__)

PROVIDER_AWS: Final[str] = "aws"
PRICING_REGION: Final[str] = "us-east-1"
CACHE_TTL_S: Final[float] = 24 * 60 * 60

_EC2_TYPE: Final[re.Pattern[str]] = re.compile(r"^[a-z][a-z0-9-]*\.[a-z0-9]+$")
_RDS_CLASS: Final[re.Pattern[str]] = re.compile(r"^db\.[a-z][a-z0-9-]*\.[a-z0-9]+$")
_REGION: Final[re.Pattern[str]] = re.compile(r"^[a-z]{2}(-[a-z]+)+-\d$")
_PRICE: Final[re.Pattern[str]] = re.compile(r"^\d+(?:\.\d+)?$")

RDS_ENGINES: Final[Mapping[str, str]] = {
    "postgres": "PostgreSQL",
    "mysql": "MySQL",
    "mariadb": "MariaDB",
}
"""RDS's engine names, as `DescribeDBInstances` spells them, to the Price List's. Engines
priced by licence edition (SQL Server, Oracle) are not listed, so they get no price rather
than a guessed one."""

GetProducts = Callable[..., Mapping[str, Any]]


def normalize_aws_pair(sku: str, region: str, *, engine: str = "", multi_az: str = "") -> VmPricePair | None:
    """An EC2 type or RDS class with its region (and, for RDS, engine and deployment), or
    `None` when any part is not a safe token."""
    sku_token = sku.strip()
    region_token = region.strip()
    if not _REGION.match(region_token):
        return None
    if sku_token.startswith("db."):
        engine_name = RDS_ENGINES.get(engine.strip().lower())
        if not _RDS_CLASS.match(sku_token) or engine_name is None:
            return None
        deployment = "Multi-AZ" if multi_az.strip().lower() == "yes" else "Single-AZ"
        return VmPricePair(sku=sku_token, region=region_token, provider=PROVIDER_AWS, engine=engine_name, deployment=deployment)
    if not _EC2_TYPE.match(sku_token):
        return None
    return VmPricePair(sku=sku_token, region=region_token, provider=PROVIDER_AWS)


def product_filters(pair: VmPricePair) -> list[tuple[str, str, list[dict[str, str]]]]:
    """`(service code, operating system label, filters)` per query for one pair. **Pure.**"""

    def terms(**fields: str) -> list[dict[str, str]]:
        return [{"Type": "TERM_MATCH", "Field": field, "Value": value} for field, value in fields.items()]

    if pair.engine:
        return [
            (
                "AmazonRDS",
                f"{pair.engine} · {pair.deployment}",
                terms(instanceType=pair.sku, regionCode=pair.region, databaseEngine=pair.engine,
                      deploymentOption=pair.deployment),
            )
        ]
    common = {"instanceType": pair.sku, "regionCode": pair.region, "tenancy": "Shared", "preInstalledSw": "NA",
              "capacitystatus": "Used", "licenseModel": "No License required"}
    return [
        ("AmazonEC2", system, terms(**common, operatingSystem=system))
        for system in ("Linux", "Windows")
    ]


def parse_products(pair: VmPricePair, label: str, price_list: Sequence[str]) -> list[RetailPrice]:
    """The first hourly on-demand USD rate among the products. **Pure.**"""
    for raw in price_list:
        try:
            product = json.loads(raw)
        except (TypeError, ValueError):
            continue
        for term in (product.get("terms") or {}).get("OnDemand", {}).values():
            for dimension in (term.get("priceDimensions") or {}).values():
                price = (dimension.get("pricePerUnit") or {}).get("USD")
                if dimension.get("unit") != "Hrs" or not isinstance(price, str) or not _PRICE.match(price):
                    continue
                return [
                    RetailPrice(
                        sku=pair.sku,
                        region=pair.region,
                        operating_system=label,
                        retail_price=price,
                        unit_of_measure="1 Hour",
                        currency="USD",
                        effective_start=str(term.get("effectiveDate", "")),
                        source="AWS Price List",
                    )
                ]
    return []


class AwsListPrices:
    """A cached lookup over `pricing:GetProducts`. One instance per process."""

    def __init__(
        self,
        *,
        get_products: GetProducts | None = None,
        clock: Callable[[], float] = time.monotonic,
        ttl_s: float = CACHE_TTL_S,
    ) -> None:
        self._get_products = get_products
        self._clock = clock
        self._ttl_s = ttl_s
        self._cache: dict[VmPricePair, tuple[float, tuple[RetailPrice, ...]]] = {}
        self._lock = threading.Lock()

    def _client(self) -> GetProducts:
        if self._get_products is None:
            import boto3

            self._get_products = boto3.client("pricing", region_name=PRICING_REGION).get_products
        return self._get_products

    async def __call__(self, pairs: Sequence[VmPricePair]) -> PriceLookupResult:
        return await asyncio.to_thread(self.lookup, pairs)

    def lookup(self, pairs: Sequence[VmPricePair]) -> PriceLookupResult:
        prices: list[RetailPrice] = []
        unavailable: list[VmPricePair] = []
        for pair in list(dict.fromkeys(pairs))[:MAX_PAIRS]:
            with self._lock:
                entry = self._cache.get(pair)
            cached = entry[1] if entry is not None and entry[0] >= self._clock() else None
            if cached is None:
                try:
                    found: list[RetailPrice] = []
                    for service, label, filters in product_filters(pair):
                        answer = self._client()(ServiceCode=service, Filters=filters, MaxResults=10)
                        found.extend(parse_products(pair, label, answer.get("PriceList") or []))
                    cached = tuple(found)
                except Exception as exc:  # a price is decoration, never a failed turn
                    logger.warning("the AWS list price for %s in %s could not be read (%s)",
                                   pair.sku, pair.region, type(exc).__name__)
                    unavailable.append(pair)
                    continue
                with self._lock:
                    self._cache[pair] = (self._clock() + self._ttl_s, cached)
            if cached:
                prices.extend(cached)
            else:
                unavailable.append(pair)
        return PriceLookupResult(prices=tuple(prices), unavailable=tuple(unavailable))


class CombinedPrices:
    """Each pair to its own cloud's price list, one result back."""

    def __init__(self, *, azure: Callable[..., Any], aws: Callable[..., Any]) -> None:
        self._azure = azure
        self._aws = aws

    async def __call__(self, pairs: Sequence[VmPricePair]) -> PriceLookupResult:
        azure = [pair for pair in pairs if pair.provider != PROVIDER_AWS]
        aws = [pair for pair in pairs if pair.provider == PROVIDER_AWS]
        results = await asyncio.gather(
            *(lookup(group) for lookup, group in ((self._azure, azure), (self._aws, aws)) if group)
        )
        return PriceLookupResult(
            prices=tuple(price for result in results for price in result.prices),
            unavailable=tuple(pair for result in results for pair in result.unavailable),
        )
