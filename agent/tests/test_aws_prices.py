"""AWS list prices for Ask: the pair, the query, the parse, and the dispatch by cloud."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from reporting_agent.chat.grounding import snapshot_vm_sizes
from reporting_agent.pricing.aws_prices import (
    AwsListPrices,
    CombinedPrices,
    normalize_aws_pair,
    parse_products,
    product_filters,
)
from reporting_agent.pricing.azure_retail import PriceLookupResult, RetailPrice, VmPricePair


def product(price: str, unit: str = "Hrs") -> str:
    return json.dumps({"terms": {"OnDemand": {"T1": {"effectiveDate": "2026-09-01T00:00:00Z",
        "priceDimensions": {"D1": {"unit": unit, "pricePerUnit": {"USD": price}}}}}}})


def test_pairs_are_safe_tokens_or_nothing() -> None:
    assert normalize_aws_pair("t3.micro", "us-east-1") == VmPricePair("t3.micro", "us-east-1", provider="aws")
    rds = normalize_aws_pair("db.m7g.large", "us-east-1", engine="postgres", multi_az="yes")
    assert rds == VmPricePair("db.m7g.large", "us-east-1", provider="aws", engine="PostgreSQL", deployment="Multi-AZ")
    for bad in (("t3.micro' or '1", "us-east-1"), ("t3.micro", "useast1"), ("t3.micro", "us-east-1; x")):
        assert normalize_aws_pair(*bad) is None
    # An engine priced by licence edition gets no price rather than a guessed one.
    assert normalize_aws_pair("db.m5.large", "us-east-1", engine="sqlserver-se") is None


def test_ec2_asks_linux_and_windows_license_included_and_rds_one_engine() -> None:
    queries = product_filters(VmPricePair("c5.large", "ap-southeast-1", provider="aws"))
    assert [(service, label) for service, label, _ in queries] == [("AmazonEC2", "Linux"), ("AmazonEC2", "Windows")]
    fields = {term["Field"]: term["Value"] for term in queries[0][2]}
    assert fields == {"instanceType": "c5.large", "regionCode": "ap-southeast-1", "tenancy": "Shared",
                      "preInstalledSw": "NA", "capacitystatus": "Used", "licenseModel": "No License required",
                      "operatingSystem": "Linux"}
    (rds,) = product_filters(VmPricePair("db.t4g.micro", "ap-southeast-1", provider="aws", engine="PostgreSQL",
                                         deployment="Single-AZ"))
    assert rds[0] == "AmazonRDS" and rds[1] == "PostgreSQL · Single-AZ"


def test_the_price_is_the_apis_string_and_only_an_hourly_rate() -> None:
    pair = VmPricePair("t3.micro", "us-east-1", provider="aws")
    (price,) = parse_products(pair, "Linux", ["not json", product("1.5", unit="Quantity"), product("0.0104000000")])
    assert price.retail_price == "0.0104000000"
    assert price.unit_of_measure == "1 Hour" and price.currency == "USD" and price.source == "AWS Price List"
    assert parse_products(pair, "Linux", [product("1e3")]) == []


def test_the_lookup_caches_and_reports_what_it_could_not_price() -> None:
    calls: list[dict[str, Any]] = []

    def get_products(**kwargs: Any) -> dict[str, Any]:
        calls.append(kwargs)
        if kwargs["Filters"][0]["Value"] == "m9.huge":
            return {"PriceList": []}
        return {"PriceList": [product("0.0104000000")]}

    lookup = AwsListPrices(get_products=get_products)
    good = VmPricePair("t3.micro", "us-east-1", provider="aws")
    missing = VmPricePair("m9.huge", "us-east-1", provider="aws")
    first = asyncio.run(lookup([good, missing]))
    assert [p.operating_system for p in first.prices] == ["Linux", "Windows"]
    assert first.unavailable == (missing,)
    asyncio.run(lookup([good]))
    assert len(calls) == 4  # two for each pair, once; the second lookup was cached


def test_each_pair_goes_to_its_own_clouds_list() -> None:
    seen: dict[str, list[VmPricePair]] = {"azure": [], "aws": []}

    def fake(cloud: str) -> Any:
        async def lookup(pairs: list[VmPricePair]) -> PriceLookupResult:
            seen[cloud].extend(pairs)
            return PriceLookupResult(prices=tuple(RetailPrice(p.sku, p.region, "Linux", "1", "1 Hour", "USD", "")
                                                  for p in pairs), unavailable=())
        return lookup

    combined = CombinedPrices(azure=fake("azure"), aws=fake("aws"))
    azure = VmPricePair("Standard_D2s_v5", "southeastasia")
    aws = VmPricePair("t3.micro", "us-east-1", provider="aws")
    result = asyncio.run(combined([azure, aws]))
    assert seen == {"azure": [azure], "aws": [aws]}
    assert {p.sku for p in result.prices} == {"Standard_D2s_v5", "t3.micro"}


@pytest.mark.parametrize(
    ("resource", "expected"),
    [
        ({"resource_type": "AWS::EC2::Instance", "name": "web", "location": "us-east-1", "sku": {"name": "t3.micro"}},
         ("t3.micro", "aws", "", "", "web · instance type")),
        ({"resource_type": "AWS::RDS::DBInstance", "name": "orders", "location": "us-east-1",
          "sku": {"name": "db.m7g.large"},
          "facts": [{"key": "engine", "value": "postgres"}, {"key": "multi_az", "value": "no"}]},
         ("db.m7g.large", "aws", "postgres", "no", "orders · database class")),
    ],
)
def test_an_aws_snapshot_names_its_priced_sizes(resource: dict[str, Any], expected: tuple[str, ...]) -> None:
    sizes, facts = snapshot_vm_sizes({"resources": [resource]}, {"run_id": "r"})
    (size,) = sizes
    assert (size.sku, size.provider, size.engine, size.multi_az, facts[0].label) == expected
