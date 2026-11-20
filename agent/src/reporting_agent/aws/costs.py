"""An estimated monthly cost per resource, at AWS's public on-demand list price. **Pure.**

The ownership report puts a price beside each idle resource, so a reader can tell a forgotten
`t3.nano` from a forgotten `r6i.4xlarge`. The price is the **list** price from the Price List
API (`pricing:GetProducts`), asked with the runtime's own role — list prices are public and
nothing about them is the customer's — so it is an estimate, and the report says so: no
savings plan, reservation, discount, credit, tax or data transfer is in it.

What is priced, and how:

* **EC2 instance** — the hourly rate for its type, region and operating system (Linux or
  Windows; any other platform is not priced rather than priced as Linux), times 730 hours.
* **RDS instance** — the hourly rate for its class, engine and deployment, times 730 hours.
  Compute only: storage and I/O are not in it.
* **EBS volume** — the per GB-month rate for its volume type, times its size. Provisioned
  IOPS and throughput above the baseline are not in it.
* **Elastic IP** — the hourly public IPv4 rate, idle or in use, times 730 hours.

A stopped instance or database bills no compute, so it reads `not running`. Anything the
price list does not answer reads `not priced`. Both are written as values, so every covered
resource answers the key.

Values are decimal strings at two places, computed in `Decimal` from the API's own string
and written by the snapshot's `decimal_string`.
"""

from __future__ import annotations

import json
import re
from collections.abc import Mapping, Sequence
from decimal import Decimal, InvalidOperation
from typing import Any, Final

from reporting_agent.collect.snapshot import decimal_string
from reporting_agent.pricing.aws_prices import RDS_ENGINES

__all__ = [
    "HOURS_PER_MONTH",
    "NOT_PRICED",
    "NOT_RUNNING",
    "PRICED_KINDS",
    "PRICE_SOURCE",
    "PriceQuery",
    "parse_rate",
    "price_items",
    "price_query",
]

PRICE_SOURCE: Final[str] = "aws_list_price"
HOURS_PER_MONTH: Final[Decimal] = Decimal(730)
NOT_PRICED: Final[str] = "not priced"
NOT_RUNNING: Final[str] = "not running"
PRICED_KINDS: Final[frozenset[str]] = frozenset({"instance", "volume", "database", "eip"})

_TOKEN: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.\-]*$")
_PRICE: Final[re.Pattern[str]] = re.compile(r"^\d+(?:\.\d+)?$")

PriceQuery = tuple[str, tuple[tuple[str, str], ...], str, str]
"""`(service code, ((field, value), …), unit, usage type suffix)` — hashable, so each
distinct query is asked once per run."""


def _safe(*values: object) -> bool:
    return all(isinstance(value, str) and _TOKEN.match(value) for value in values)


def _stopped(record: Mapping[str, Any]) -> bool:
    if record.get("_kind") == "instance":
        return (record.get("State") or {}).get("Name") in ("stopped", "stopping", "shutting-down", "terminated")
    if record.get("_kind") == "database":
        return record.get("DBInstanceStatus") in ("stopped", "stopping")
    return False


def price_query(record: Mapping[str, Any]) -> PriceQuery | None:
    """The one Price List query that prices this resource, or `None` when none can."""
    kind = record.get("_kind")
    region = record.get("_region")
    if kind not in PRICED_KINDS or not _safe(region):
        return None
    if kind == "instance":
        instance_type = record.get("InstanceType")
        details = str(record.get("PlatformDetails") or ("Windows" if record.get("Platform") == "windows" else ""))
        system = "Windows" if details == "Windows" else "Linux" if details in ("Linux/UNIX", "") else None
        if system is None or not _safe(instance_type):
            return None
        return (
            "AmazonEC2",
            (("capacitystatus", "Used"), ("instanceType", str(instance_type)), ("licenseModel", "No License required"),
             ("operatingSystem", system), ("preInstalledSw", "NA"), ("regionCode", str(region)), ("tenancy", "Shared")),
            "Hrs",
            "",
        )
    if kind == "database":
        engine = RDS_ENGINES.get(str(record.get("Engine") or "").lower())
        instance_class = record.get("DBInstanceClass")
        if engine is None or not _safe(instance_class):
            return None
        deployment = "Multi-AZ" if record.get("MultiAZ") else "Single-AZ"
        return (
            "AmazonRDS",
            (("databaseEngine", engine), ("deploymentOption", deployment), ("instanceType", str(instance_class)),
             ("regionCode", str(region))),
            "Hrs",
            "",
        )
    if kind == "volume":
        volume_type = record.get("VolumeType")
        if not _safe(volume_type):
            return None
        return (
            "AmazonEC2",
            (("productFamily", "Storage"), ("regionCode", str(region)), ("volumeApiName", str(volume_type))),
            "GB-Mo",
            "",
        )
    attached = bool(record.get("AssociationId") or record.get("InstanceId") or record.get("NetworkInterfaceId"))
    return (
        "AmazonVPC",
        (("group", "VPCPublicIPv4Address"), ("regionCode", str(region))),
        "Hrs",
        "PublicIPv4:InUseAddress" if attached else "PublicIPv4:IdleAddress",
    )


def parse_rate(query: PriceQuery, price_list: Sequence[str]) -> str | None:
    """The first non-zero on-demand USD rate in `unit` among the products, as the API's string."""
    _, _, unit, usage_suffix = query
    for raw in price_list:
        try:
            product = json.loads(raw)
        except (TypeError, ValueError):
            continue
        if not isinstance(product, Mapping):
            continue
        usage = str(((product.get("product") or {}).get("attributes") or {}).get("usagetype") or "")
        if usage_suffix and not usage.endswith(usage_suffix):
            continue
        for term in ((product.get("terms") or {}).get("OnDemand") or {}).values():
            for dimension in (term.get("priceDimensions") or {}).values():
                price = (dimension.get("pricePerUnit") or {}).get("USD")
                if dimension.get("unit") != unit or not isinstance(price, str) or not _PRICE.match(price):
                    continue
                if Decimal(price) > 0:
                    return price
    return None


def _monthly(record: Mapping[str, Any], unit: str, rate: str) -> str:
    try:
        per_unit = Decimal(rate)
    except InvalidOperation:
        return NOT_PRICED
    if unit == "GB-Mo":
        size = record.get("Size")
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            return NOT_PRICED
        total = per_unit * Decimal(size)
    else:
        total = per_unit * HOURS_PER_MONTH
    # Stored at the cent through the snapshot's own decimal rule, as a collected value is:
    # the report prints this string as written.
    return decimal_string(total, 2)


def price_items(
    resource_ids: Sequence[str],
    raw: Mapping[str, Mapping[str, Any]],
    rates: Mapping[PriceQuery, str | None],
) -> list[dict[str, Any]]:
    """`est_monthly_usd` for each priced resource, every one answered. **Pure.**"""
    items: list[dict[str, Any]] = []
    for resource_id in sorted(resource_ids):
        record = raw.get(resource_id)
        if record is None or record.get("_kind") not in PRICED_KINDS:
            continue
        if _stopped(record):
            value = NOT_RUNNING
        else:
            query = price_query(record)
            rate = rates.get(query) if query is not None else None
            value = NOT_PRICED if query is None or rate is None else _monthly(record, query[2], rate)
        items.append({"resource_id": resource_id, "est_monthly_usd": value})
    return items
