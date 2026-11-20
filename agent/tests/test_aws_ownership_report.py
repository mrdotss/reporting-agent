"""The weekly ownership report, through the real pipeline, to a passing verification.

The same fake account as `test_aws_report.py`, with a price list, and a definition shaped
like the app's "Weekly ownership" starter: the ownership headline, idle and low-use
resources, what was created this period, who created what, and the full register.
"""

from __future__ import annotations

import asyncio
import json
import os
from io import BytesIO
from typing import Any

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from fakes.object_store import InMemoryObjectStore
from reporting_agent.catalog.loader import load_catalog, load_section_catalogue
from reporting_agent.main import StepTracker
from reporting_agent.redaction import discard_secrets
from reporting_agent.render import pdf as P
from reporting_agent.report_pipeline import ReportOutcome, run_generate_report
from test_aws_collector import ACCOUNT, fake_clients, provider
from test_aws_report import aws_definition
from test_run_end_to_end_v2 import invoke_payload

pytestmark = pytest.mark.skipif(P.SOFFICE_BINARY is None, reason="LibreOffice is not installed")

SECTIONS = ("ownership_glance", "idle_resources", "new_resources", "creators", "ownership_register")


def product(usage: str, unit: str, usd: str) -> str:
    return json.dumps({"product": {"attributes": {"usagetype": usage}},
                       "terms": {"OnDemand": {"t": {"priceDimensions": {"d": {"unit": unit, "pricePerUnit": {"USD": usd}}}}}}})


def get_products(**kwargs: Any) -> dict[str, Any]:
    service = kwargs["ServiceCode"]
    if service == "AmazonEC2":
        storage = any(f["Field"] == "volumeApiName" for f in kwargs["Filters"])
        return {"PriceList": [product("EBS:VolumeUsage.gp3", "GB-Mo", "0.0800000000") if storage
                              else product("BoxUsage:t3.micro", "Hrs", "0.0104000000")]}
    if service == "AmazonRDS":
        return {"PriceList": [product("InstanceUsage:db.t4g.micro", "Hrs", "0.0160000000")]}
    return {"PriceList": [product("USE1-PublicIPv4:InUseAddress", "Hrs", "0.0050000000")]}


def ownership_definition() -> dict[str, Any]:
    base = aws_definition()
    entries = {entry.key: entry for entry in load_section_catalogue(provider="aws").entries}
    sections = []
    for position, key in enumerate(SECTIONS):
        section = next(s for s in base["sections"] if s["type"] == key)
        section["position"] = position
        section["metrics"] = [
            # What the app's preset expansion writes: a percentile carries its estimator and tier.
            {"metric": m, "statistic": s, **({"estimator": "histogram_sketch_pt1h_interval_average",
                                              "fidelity_tier": "baseline"} if s == "p95" else {})}
            for m, s in dict(entries[key].presets).get("ownership", ())
        ]
        sections.append(section)
    base["sections"] = sections
    # As the starter writes it: no cover, no document control page, no contents.
    base["design"]["cover_page"] = False
    base["front_matter"] = {"cover": {"enabled": False}, "document_control": {"enabled": False}, "toc": {"enabled": False}}
    return base


@pytest.fixture(scope="module")
def walked() -> tuple[InMemoryObjectStore, list[dict[str, Any]], BaseException | None]:
    store = InMemoryObjectStore()
    payload = invoke_payload(ownership_definition())
    # A week holding the instance's creation day (2026-08-19, CloudTrail).
    payload["period"] = {"start": "2026-08-17", "end": "2026-08-23"}
    payload["scope"] = {"resource_types": [], "resource_groups": [], "tag_filters": {}, "regions": ["us-east-1", "ap-southeast-3"]}
    payload.pop("context", None)
    context = {"actor_id": "actor-1", "run_id": "run-1", "subscription_id": ACCOUNT, "timezone": "UTC",
               "provider": "aws", "fidelity_tier": "baseline", "display_name": "Example AWS"}
    events: list[dict[str, Any]] = []
    raised: BaseException | None = None
    aws = provider(store, fake_clients())
    aws.get_products = get_products

    async def go() -> None:
        async for event in run_generate_report(
            payload=payload, context=context, steps=StepTracker(), artifact_bucket="unused",
            outcome=ReportOutcome(), prose=None, provider=aws, object_store=store, catalog=load_catalog(),
        ):
            events.append(event)

    try:
        asyncio.run(go())
    except Exception as exc:
        raised = exc
    finally:
        discard_secrets()
    return store, events, raised


def _document(store: InMemoryObjectStore) -> Any:
    from docx import Document

    return Document(BytesIO(store.get(next(k for k in store.keys() if k.endswith("/report.docx"))).body))  # type: ignore[union-attr]


def _table(document: Any, header: str) -> list[list[str]]:
    table = next(t for t in document.tables if header in [c.text for c in t.rows[0].cells])
    return [[cell.text for cell in row.cells] for row in table.rows]


def test_the_ownership_report_verifies(walked: tuple[InMemoryObjectStore, list[dict[str, Any]], BaseException | None]) -> None:
    store, events, raised = walked
    verification = [event for event in events if event["type"] == "verification"]
    assert verification and verification[-1]["status"] == "pass", raised
    records = [json.loads(store.get(key).body) for key in store.keys() if "/verification-" in key]  # type: ignore[union-attr]
    assert records and not [f for f in records[-1].get("findings", []) if f.get("severity") == "blocking"]


def test_the_headline_counts_and_the_email_summary_agree(
    walked: tuple[InMemoryObjectStore, list[dict[str, Any]], BaseException | None],
) -> None:
    store, _, _ = walked
    document = _document(store)
    text = "\n".join(p.text for p in document.paragraphs)
    for title in ("Ownership at a Glance", "Idle and Low-Use Resources", "Created This Period",
                  "Who Created What", "Ownership Register", "How this report decides"):
        assert title in text, title
    def rows_of(first: str) -> dict[str, str]:
        table = next(t for t in document.tables if any(row.cells[0].text == first for row in t.rows))
        return {row.cells[0].text: row.cells[1].text for row in table.rows if len(row.cells) > 1}

    # Instance, stopped instance, volume, database, VPC, address, the security group in use.
    tiles = rows_of("Live resources")
    assert tiles["Live resources"] == "7"
    assert tiles["With a known creator"] == "4", tiles  # all but the stopped instance, database, security group
    assert tiles["Idle this week"] == "0", tiles
    assert rows_of("Stopped")["Stopped"] == "1"
    assert rows_of("Unknown")["Unknown"] == "3"
    assert "Nothing looks idle this week." in text
    # The report opens on its own first page: nothing of the cover or document control.
    # The Word file keeps the section title; the designed PDF prints the kicker in its place.
    opening = [p.text for p in document.paragraphs if p.text.strip()][:2]
    assert opening == ["Ownership at a Glance", "Weekly ownership report"], opening
    assert "Document control" not in text and "Contents" not in text

    glance = json.loads(store.get(next(k for k in store.keys() if k.endswith("/glance.json"))).body)  # type: ignore[union-attr]
    assert glance["focus"] == "ownership"
    assert glance["headline"] == "Nothing looks idle this week."
    assert [f["key"] for f in glance["figures"]] == ["owned", "known_creator", "idle", "idle_cost"]
    assert [f["value"] for f in glance["figures"]] == ["7", "4", "0", "0.00 USD"]
    assert all("How this report decides" not in d for d in glance["decisions"])


def test_each_resource_carries_its_chain_of_custody(
    walked: tuple[InMemoryObjectStore, list[dict[str, Any]], BaseException | None],
) -> None:
    store, _, _ = walked
    register = _table(_document(store), "Creator source")
    header, rows = register[0], register[1:]
    by_name = {row[0]: dict(zip(header, row, strict=True)) for row in rows}
    web = next(value for name, value in by_name.items() if name.startswith("web"))
    assert web["Created by"] == "user/alice" and web["Created on"] == "2026-08-19"
    assert web["Creator status"] == "Active" and web["Est. monthly USD"] == "7.59"
    vpc = next(value for name, value in by_name.items() if "main" in name)
    assert vpc["Created by"] == "role/Terraform/ci-run" and vpc["Creator status"] == "Deleted"
    assert vpc["Activity"] == "Not measured"

    creators = _table(_document(store), "Need attention")
    names = [row[0] for row in creators[1:]]
    assert names[0] in ("Unknown", "user/alice") and "root" in names and "role/Terraform/ci-run" in names
