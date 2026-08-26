"""One `generate_report` invocation over the production assembly, with only Azure faked.

Extracted from `test_report_pipeline.py` so the mandatory negative suite of task 14 drives
the **same** path the positive suite does. That sharing is the point rather than a
convenience: Req 44.13 requires every negative test to assert its unmutated fixture passes
before it mutates anything, and a fixture assembled a second way could pass here and fail
there — or, worse, pass here because it was assembled to.

Only the four Azure ports are fakes. The provider assembly, the collector, the compiler,
the `python-docx` render, the LibreOffice conversion, the verifier and the object store
protocol are all the production ones, so an ordering asserted over this harness is an
ordering between real phases rather than between stubs.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from collections.abc import Sequence
from typing import Any, Final

BUCKET_NAME = "rpt-artifacts-test"

# `main` reads its configuration at import, so these are set before it is imported — the
# same bootstrap `test_collect_pipeline.py` uses, and for the same reason.
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", BUCKET_NAME)
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

# Req 23.8's `LANG` assertion runs before the conversion process starts, so a developer
# host whose locale is `en_US.UTF-8` would fail every scenario here on the locale rather
# than on anything the pipeline did. The container image pins both of these; set at import
# rather than in a fixture because the module-scoped runs below resolve first.
os.environ["LANG"] = "C.UTF-8"
os.environ.setdefault("LO_PROFILE", tempfile.mkdtemp(prefix="rpt-lo-profile-"))

import definition_factory as df  # noqa: E402
from fakes.azure_ports import (  # noqa: E402
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    facts_port_answering_nothing,
    raw_response_from_recorded,
)
from fakes.object_store import InMemoryObjectStore  # noqa: E402
from fixtures import load_response  # noqa: E402
from reporting_agent.azure.ports import RawHttpResponse  # noqa: E402
from reporting_agent.azure.provider import FIDELITY_BASELINE, provider_over_ports  # noqa: E402
from reporting_agent.catalog.loader import DEFAULT_CATALOG_PATH, load_catalog  # noqa: E402
from reporting_agent.main import StepTracker  # noqa: E402
from reporting_agent.report_pipeline import ReportOutcome, run_generate_report  # noqa: E402

__all__ = [
    "ACTOR_ID",
    "BUCKET",
    "BUCKET_NAME",
    "CPU",
    "DEFAULT_RESOURCES",
    "DESIGN",
    "GROUP",
    "LOCATION",
    "MEMORY",
    "RESOURCE_TYPE",
    "RUN_ID",
    "SUBSCRIPTION",
    "WATCHDOG_S",
    "WEB_01",
    "WIRE_TYPE",
    "InMemoryObjectStore",
    "Pipeline",
    "StubProse",
    "batch",
    "definition",
    "df",
    "empty_batch",
    "inventory",
    "load_catalog",
    "metric_entry",
    "multi_day_batch",
    "raw",
    "report_objects",
    "resource_id",
    "run_generate_report",
    "types_of",
]

WATCHDOG_S: Final[float] = 300.0

SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
RESOURCE_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
WIRE_TYPE: Final[str] = "microsoft.compute/virtualmachines"
LOCATION: Final[str] = "southeastasia"
GROUP: Final[str] = "rg-prod-sea"
ACTOR_ID: Final[str] = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"
RUN_ID: Final[str] = "run_01HQZX8QW9K7YB4T2C3M5N6P7Q"
CPU: Final[str] = "Percentage CPU"
MEMORY: Final[str] = "Available Memory Bytes"
BUCKET: Final[str] = BUCKET_NAME

DEFAULT_RESOURCES: Final[tuple[str, ...]] = ("prod-web-01",)

WEB_01: Final[str] = (
    f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}"
    f"/providers/Microsoft.Compute/virtualMachines/prod-web-01"
)

DESIGN: Final[dict[str, Any]] = {
    "preset": "editorial",
    "accent_color": "#1f6f78",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": False,
    "logo": None,
    "page_size": "A4",
}


def raw(body: object, **headers: str) -> RawHttpResponse:
    return RawHttpResponse(status=200, headers=dict(headers), body=body)


def resource_id(name: str) -> str:
    """The ARM id the fakes and the assertions both derive from a VM name.

    Derived rather than written twice: a hand-written id in a test and a generated one in the
    fake would disagree the first time either changes, and every anchored assertion in the
    negative suite resolves a row by the name inside it.
    """
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}"
        f"/providers/Microsoft.Compute/virtualMachines/{name}"
    )


def inventory(names: Sequence[str] = DEFAULT_RESOURCES) -> RawHttpResponse:
    """One Resource Graph page carrying `names`, in order.

    Parameterized because the negative suite needs a table with **two** data rows: Req 44.3's
    transposition is invisible in a one-row table, where swapping two columns across "every
    data row" swaps one row and any verifier comparing sets would still pass it.
    """
    return raw(
        {
            "totalRecords": len(names),
            "count": len(names),
            "data": [
                {
                    "id": resource_id(name),
                    "name": name,
                    "type": WIRE_TYPE,
                    "location": LOCATION,
                    "resourceGroup": GROUP,
                    "tags": {"env": "prod"},
                    "sku": "Standard_D4s_v5",
                    "powerState": "PowerState/running",
                }
                for name in names
            ],
        },
        **{"x-ms-user-quota-remaining": "9"},
    )


def metric_entry(
    name: str,
    *,
    total: float = 720.0,
    count: int = 60,
    minimum: float = 5.0,
    maximum: float = 30.0,
    error_code: str = "Success",
) -> dict[str, Any]:
    """One metric of one resource, as the batch endpoint returns it.

    The four numbers are arguments so a fixture can give two resources **different** values.
    Req 44.3 needs a table whose transposed values differ pairwise, and two resources folding
    to the same average produce a transposition that changes no cell text — a mutation the
    test would then assert was caught, having never applied one.
    """
    return {
        "name": {"value": name},
        # Azure returns per-resource and per-metric failures **inside a 200** (Req 29.1),
        # so a scenario needs to be able to produce one without failing the request.
        "errorCode": error_code,
        "timeseries": [
            {
                "metadatavalues": [],
                "data": [
                    {
                        "timeStamp": "2026-06-30T17:00:00Z",
                        "total": total,
                        "count": count,
                        "minimum": minimum,
                        "maximum": maximum,
                    }
                ],
            }
        ],
    }


def empty_batch(names: Sequence[str] = DEFAULT_RESOURCES) -> RawHttpResponse:
    """A 200 carrying no resource at all.

    The shape behind the real incident: the request succeeds and answers for nothing, so
    every requested resource records `resource_absent_from_response` (Req 29.5) and the
    run reaches `assert_some_statistic` with an empty statistics map — the one moment when
    the `collection_log` is the only explanation available.

    A per-metric `errorCode` is **not** enough to reach that state, and finding out why is
    the useful part: SKU capability values are finalized from the SKU listing rather than
    from metrics, so a refused metric still leaves a statistic behind and the run ends as
    `PARTIAL_COVERAGE` instead.
    """
    del names
    return raw({"values": []})


def batch(names: Sequence[str] = DEFAULT_RESOURCES) -> RawHttpResponse:
    """One batch response covering `names`, each resource folding to its own values.

    The `index`-derived offsets are what keep the per-resource averages and peaks distinct;
    see :func:`metric_entry`.
    """
    return raw(
        {
            "values": [
                {
                    "starttime": "2026-06-30T17:00:00Z",
                    "endtime": "2026-07-01T17:00:00Z",
                    "interval": "PT1H",
                    "namespace": WIRE_TYPE,
                    "resourceregion": LOCATION,
                    "resourceid": resource_id(name),
                    "value": [
                        metric_entry(
                            CPU,
                            total=720.0 + 180.0 * index,
                            minimum=5.0 + index,
                            maximum=30.0 + 11.0 * index,
                        ),
                        metric_entry(
                            MEMORY,
                            total=720.0 + 180.0 * index,
                            minimum=5.0 + index,
                            maximum=30.0 + 11.0 * index,
                        ),
                    ],
                }
                for index, name in enumerate(names)
            ]
        }
    )


def multi_day_batch(
    names: Sequence[str] = DEFAULT_RESOURCES, *, days: int = 2
) -> RawHttpResponse:
    """A batch response carrying one interval per local day, for `days` days.

    A `timeseries_chart` plots one figure per local day, so a single-interval fixture gives
    it one point and cannot show the axis working. The timestamps are the Jakarta midnights
    the window's day buckets are built around — 17:00Z is 00:00+07:00 — so each interval
    lands in a different local day rather than in a different hour of one.
    """
    def entry(name: str, index: int, day: int) -> dict[str, Any]:
        return {
            "timeStamp": f"2026-06-{30 + day:02d}T17:00:00Z"
            if day == 0
            else f"2026-07-{day:02d}T17:00:00Z",
            "total": 720.0 + 180.0 * index + 60.0 * day,
            "count": 60,
            "minimum": 5.0 + index,
            "maximum": 30.0 + 11.0 * index + day,
        }

    def metric(name: str, index: int, metric_name: str) -> dict[str, Any]:
        return {
            "name": {"value": metric_name},
            "errorCode": "Success",
            "timeseries": [
                {
                    "metadatavalues": [],
                    "data": [entry(name, index, day) for day in range(days)],
                }
            ],
        }

    return raw(
        {
            "values": [
                {
                    "starttime": "2026-06-30T17:00:00Z",
                    "endtime": f"2026-07-{days:02d}T17:00:00Z",
                    "interval": "PT1H",
                    "namespace": WIRE_TYPE,
                    "resourceregion": LOCATION,
                    "resourceid": resource_id(name),
                    "value": [metric(name, index, CPU), metric(name, index, MEMORY)],
                }
                for index, name in enumerate(names)
            ]
        }
    )


def definition(**overrides: Any) -> dict[str, Any]:
    design = {**DESIGN, **overrides.pop("design", {})}
    blocks = overrides.pop(
        "blocks",
        [
            df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
            df.block("gaps", "gaps_and_coverage", {}),
        ],
    )
    return df.definition(blocks, design=design, **overrides)


class StubProse:
    """A `ProseProvider` returning fixed text, so a scenario can choose what the model
    "wrote".

    A stub rather than a real Bedrock call for the obvious reason and one less obvious one:
    the assertions here are about what the **verifier** does with model prose, and a real
    model that happened to behave would make the negative case unreachable.
    """

    def __init__(self, text: str) -> None:
        self.text = text
        self.requests: list[Any] = []

    def narrate(self, request: Any) -> str:
        self.requests.append(request)
        return self.text


class Pipeline:
    """One invocation over the production assembly, with only Azure faked."""

    def __init__(self, **overrides: Any) -> None:
        self.prose: Any | None = overrides.pop("prose", None)
        self.store = InMemoryObjectStore()
        self.steps = StepTracker()
        self.outcome = ReportOutcome()
        self.catalog = load_catalog(DEFAULT_CATALOG_PATH)
        self.definition = overrides.pop("definition", definition())
        # Which VMs the inventory answers with. `()` is an inventory that finds nothing,
        # which is the condition Req 44.8's expired secret produces and the one case where
        # the run must end before a snapshot is ever written.
        self.resources: Sequence[str] = overrides.pop("resources", DEFAULT_RESOURCES)
        # How many local days the canned response spans. One by default, because most
        # scenarios only need a figure; a `timeseries_chart` needs an axis.
        self.days: int = overrides.pop("days", 1)
        self.period: dict[str, str] = overrides.pop(
            "period", {"start": "2026-07-01", "end": "2026-07-01"}
        )
        # Held so a scenario can assert what was *asked for*, not only what came back — the
        # fake's canned batch response is the same whatever the request names.
        # Overridable, because the port is handed its queue at construction: a scenario
        # assigning to `provider_metrics.batch_responses` afterwards is too late and the
        # canned response is used instead — quietly, which is how it looks like the
        # scenario ran when it did not.
        self.provider_metrics = FakeMetricsPort(
            batch_responses=list(
                overrides.pop(
                    "batch_responses",
                    [
                        batch(self.resources)
                        if self.days == 1
                        else multi_day_batch(self.resources, days=self.days)
                    ],
                )
            ),
            fallback_responses=[],
        )
        self.provider = provider_over_ports(
            inventory_port=FakeInventoryPort([inventory(self.resources)]),
            sku_port=FakeSkuPort(
                [
                    raw_response_from_recorded(
                        load_response("azure", "resource_skus_with_vcpus_available")
                    )
                ]
            ),
            definitions_port=FakeDefinitionsPort(
                [raw({"value": [{"name": {"value": CPU}}, {"name": {"value": MEMORY}}]})]
            ),
            metrics_port=self.provider_metrics,
            facts_port=facts_port_answering_nothing(),
            object_store=self.store,
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            fidelity_tier=FIDELITY_BASELINE,
            catalog=self.catalog,
        )

    def payload(self) -> dict[str, Any]:
        body: dict[str, Any] = {
            "command": "generate_report",
            "period": dict(self.period),
            "scope": {
                "resource_types": [RESOURCE_TYPE],
                "resource_groups": [],
                "tag_filters": {},
            },
            "definition": self.definition,
            "template_version_id": "tv_01HQZX",
        }

        # The per-run front-matter values a `schema_version >= 2` template requires
        # (Req 13.7). Added here rather than in each test because they are not optional
        # for such a template: `emit_front_matter` refuses an absent one with
        # RENDER_FAILED and no substituted placeholder (Req 13.15), so a v2 harness that
        # omits them is not testing a v2 run — it is testing a run that cannot render.
        #
        # Conditional so a v1 payload is byte-identical to what it always was: v1
        # templates have no front matter and a run carrying values nothing prints would
        # be describing a document shape that does not exist.
        definition = self.definition
        schema_version = definition.get("schema_version") if isinstance(definition, dict) else None
        has_front_matter = isinstance(definition, dict) and isinstance(
            definition.get("front_matter"), dict
        )
        if isinstance(schema_version, int) and schema_version >= 2 and has_front_matter:
            body["customer_name"] = "Contoso Indonesia"
            body["revision_history_row"] = {
                "revision": "1.0",
                "note": "Initial report",
                "author": "R. Prakoso",
            }

        return body

    def context(self) -> dict[str, Any]:
        return {
            "actor_id": ACTOR_ID,
            "run_id": RUN_ID,
            "subscription_id": SUBSCRIPTION,
            "timezone": "Asia/Jakarta",
            "fidelity_tier": FIDELITY_BASELINE,
            "log_analytics_workspace_id": None,
        }

    def run(self) -> tuple[list[dict[str, Any]], Exception | None]:
        """Drain the pipeline, returning the events **and** how it ended.

        Both, because every gate assertion here is a claim about the events emitted before
        the raise, and an exception propagating out of the `async for` discards them.
        """
        events: list[dict[str, Any]] = []

        async def go() -> None:
            async for event in run_generate_report(
                payload=self.payload(),
                context=self.context(),
                steps=self.steps,
                artifact_bucket=BUCKET,
                outcome=self.outcome,
                prose=self.prose,
                provider=self.provider,
                object_store=self.store,
                catalog=self.catalog,
            ):
                events.append(event)

        try:
            asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))
        except Exception as exc:
            return events, exc
        return events, None


def types_of(events: list[dict[str, Any]]) -> list[str]:
    return [event["type"] for event in events]


def report_objects(store: InMemoryObjectStore) -> list[str]:
    return [key for key in store.keys() if "/reports/" in key]
