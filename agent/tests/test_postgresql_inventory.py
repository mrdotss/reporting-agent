"""PostgreSQL inventory uses collected specs, firewall rules and selected metrics."""

import asyncio
from dataclasses import replace

import snapshot_factory as sf
from fakes.azure_ports import FakeFactsPort
from reporting_agent.azure.facts import postgresql_firewall_facts
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.catalog.loader import load_section_catalogue
from reporting_agent.compile.ast import Chart
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.snapshot_view import build_snapshot_view
from test_azure_facts import collector, record

PG = "Microsoft.DBforPostgreSQL/flexibleServers"


def postgresql_fixture():
    metrics = [
        sf.exact(name, stat, value, unit=unit)
        for name, value, unit in [
            ("cpu_percent", "12", "percent"),
            ("memory_percent", "30", "percent"),
            ("storage_used", "8589934592", "bytes"),
            ("storage_percent", "25", "percent"),
        ]
        for stat in ("avg", "max")
    ]
    resource = sf.vm(
        resource_id=f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod/providers/{PG}/sample-pg",
        name="sample-pg",
        resource_type=PG,
        statistics=metrics,
    )
    specs = {
        "version": "17",
        "tier": "Burstable",
        "sku_name": "Standard_B1ms",
        "pg_state": "Ready",
        "pg_storage_size_gib": "32",
        "pg_public_access": "Enabled",
        "pg_fqdn": "sample-pg.postgres.database.azure.com",
        "pg_high_availability": "Disabled",
        "pg_storage_tier": "P4",
        "pg_storage_autogrow": "Disabled",
        "pg_geo_backup": "Disabled",
        "pg_storage_iops": "120",
        "backup_retention_days": "7",
        "pg_firewall_rules": "Office: 192.0.2.1 – 192.0.2.1",
    }
    facts = tuple(
        sf.FactEntry(
            key=k,
            value=v,
            formatted=v,
            value_kind="numeric"
            if k in ("pg_storage_size_gib", "pg_storage_iops", "backup_retention_days")
            else "text",
            unit="days"
            if k == "backup_retention_days"
            else "count"
            if k in ("pg_storage_size_gib", "pg_storage_iops")
            else None,
            source="arm" if k == "pg_firewall_rules" else "resource_graph",
            collected_at="2026-07-03T00:00:00Z",
        )
        for k, v in specs.items()
    )
    resource = replace(
        resource,
        facts=facts,
        day_buckets=tuple(replace(day, statistics=tuple(metrics)) for day in resource.day_buckets),
    )
    definition = {
        "schema_version": 3,
        "provider": "azure",
        "identity": {"language": "en"},
        "design": {"preset": "corporate", "number_format": {"bytes_as_gib": True}},
        "sections": [
            {
                "id": "pg",
                "type": "postgresql_flexible_inventory",
                "position": 1,
                "selection": {"resource_types": [PG]},
                "presentation": "chart_and_table",
                "metrics": [{"metric": m.metric, "statistic": m.statistic} for m in metrics],
            }
        ],
    }
    return definition, sf.build(resources=[resource])


def test_postgresql_specs_and_all_selected_metric_charts():
    definition, snapshot = postgresql_fixture()
    compiled = compile_document(
        definition, view=build_snapshot_view(snapshot), catalogue=load_section_catalogue()
    )
    charts = [n for n in compiled.document.blocks if isinstance(n, Chart)]
    assert len(charts) == 4
    assert {p.y.metric for c in charts for s in c.series for p in s.points} == {
        "cpu_percent",
        "memory_percent",
        "storage_used",
        "storage_percent",
    }
    assert any(f.formatted == "8.00 GiB" for f in compiled.ledger.entries.values())
    assert any(
        getattr(f, "value", None) == "Office: 192.0.2.1 – 192.0.2.1"
        for f in compiled.ledger.text_facts().values()
    )


def test_firewall_empty_success_and_unreadable_are_distinct():
    assert (
        postgresql_firewall_facts({"value": []}, "server")["value"][0]["pg_firewall_rules"]
        == "No firewall rules configured"
    )
    assert postgresql_firewall_facts(None, "server") is None
    assert postgresql_firewall_facts({"value": [{}]}, "server") is None


def test_firewall_collection_folds_permissions_as_a_gap():
    resource = record("pg", resource_type=PG)
    for status in (200, 403):
        port = FakeFactsPort(
            postgresql_responses=[RawHttpResponse(status=status, headers={}, body={"value": []})]
        )
        facts, gaps = asyncio.run(
            collector(port)._collect_postgresql_firewalls([resource], {resource["resource_id"]: PG})
        )
        assert bool(facts) == (status == 200)
        assert bool(gaps) == (status == 403)


def test_firewall_archive_can_reproduce_the_collected_fact():
    from fakes.object_store import InMemoryObjectStore
    from reporting_agent.collect.archive import ArchiveWriter
    from reporting_agent.collect.factfold import FACT_KIND_FACTS, fold_fact_response
    from test_facts_archive import CONTEXT, objects_of

    resource = record("pg", resource_type=PG)
    body = {
        "value": [
            {
                "name": "office",
                "properties": {"startIpAddress": "192.0.2.1", "endIpAddress": "192.0.2.2"},
            }
        ]
    }
    port = FakeFactsPort(postgresql_responses=[RawHttpResponse(status=200, headers={}, body=body)])
    service = collector(port)
    store = InMemoryObjectStore()
    service.archive = ArchiveWriter(store=store)
    service.archive_context = CONTEXT
    types = {resource["resource_id"]: PG}
    facts, gaps = asyncio.run(service._collect_postgresql_firewalls([resource], types))
    assert not gaps
    (archived,) = objects_of(store)
    replay, missing = fold_fact_response(
        archived["raw_response"],
        kind=FACT_KIND_FACTS,
        source="arm",
        resource_ids=[resource["resource_id"]],
        declaration=service.declaration,
        resource_types=types,
        received_at=archived["received_at"],
    )
    assert not missing
    assert tuple(replay) == facts


def test_firewall_port_rejects_truncated_or_malformed_lists():
    from reporting_agent.azure.clients import ArmFactsPort

    class Response:
        status_code = 200

        def __init__(self, body):
            self.body = body
            self.headers = {}

        def json(self):
            return self.body

    for body in ({"value": [], "nextLink": "https://management.azure.com/next"}, {}):
        port = ArmFactsPort(sender=lambda request, body=body: Response(body), max_pages=1)
        response = asyncio.run(
            port.list_postgresql_firewall_rules(
                server_id="/subscriptions/test/providers/Microsoft.DBforPostgreSQL/flexibleServers/pg"
            )
        )
        assert not response.ok
