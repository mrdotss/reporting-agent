"""The report pipeline, end to end (Req 41, 42).

Every scenario drives the **real** path: the production provider assembly over the scripted
Azure fakes, a real compile, a real `python-docx` render, a real LibreOffice conversion and
the real verifier. Nothing about the document phases is stubbed, because the thing under test
is an *ordering* — collect, compile, render, verify, upload, and the upload last — and an
ordering asserted over stubs is an ordering between stubs.

The two that carry the module:

* :func:`test_the_artifacts_are_written_only_after_the_verification_passes` — the delivery
  gate, asserted as an absence: on a failing verification no report object exists at all, so
  there is no window in which a `report_file` could name one.
* :func:`test_the_theme_is_asserted_before_a_single_azure_call` — the refusal that costs
  nothing when it fires and four minutes of somebody's money when it does not.
"""

from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path
from typing import Any, Final

import pytest

BUCKET_NAME = "rpt-artifacts-test"

# `main` reads its configuration at import, so these are set before it is imported — the
# same bootstrap `test_collect_pipeline.py` uses, and for the same reason.
os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", BUCKET_NAME)
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

# Req 23.8's `LANG` assertion runs before the conversion process starts, so a developer
# host whose locale is `en_US.UTF-8` would fail every scenario here on the locale rather
# than on anything the pipeline did. The container image pins both of these; set at import
# rather than in a fixture because the module-scoped run below resolves first.
os.environ["LANG"] = "C.UTF-8"
os.environ.setdefault("LO_PROFILE", tempfile.mkdtemp(prefix="rpt-lo-profile-"))

import definition_factory as df  # noqa: E402
from fakes.azure_ports import (  # noqa: E402
    FakeDefinitionsPort,
    FakeInventoryPort,
    FakeMetricsPort,
    FakeSkuPort,
    raw_response_from_recorded,
)
from fakes.object_store import InMemoryObjectStore  # noqa: E402
from fixtures import load_response  # noqa: E402
from reporting_agent.azure.ports import RawHttpResponse  # noqa: E402
from reporting_agent.azure.provider import FIDELITY_BASELINE, provider_over_ports  # noqa: E402
from reporting_agent.catalog.loader import load_catalog  # noqa: E402
from reporting_agent.errors import (  # noqa: E402
    PartialCoverageError,
    RenderFailedError,
    VerificationFailedError,
)
from reporting_agent.main import StepTracker  # noqa: E402
from reporting_agent.report_pipeline import ReportOutcome, run_generate_report  # noqa: E402

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


def inventory() -> RawHttpResponse:
    return raw(
        {
            "totalRecords": 1,
            "count": 1,
            "data": [
                {
                    "id": WEB_01,
                    "name": "prod-web-01",
                    "type": WIRE_TYPE,
                    "location": LOCATION,
                    "resourceGroup": GROUP,
                    "tags": {"env": "prod"},
                    "sku": "Standard_D4s_v5",
                    "powerState": "PowerState/running",
                }
            ],
        },
        **{"x-ms-user-quota-remaining": "9"},
    )


def metric_entry(name: str) -> dict[str, Any]:
    return {
        "name": {"value": name},
        "errorCode": "Success",
        "timeseries": [
            {
                "metadatavalues": [],
                "data": [
                    {
                        "timeStamp": "2026-06-30T17:00:00Z",
                        "total": 720.0,
                        "count": 60,
                        "minimum": 5.0,
                        "maximum": 30.0,
                    }
                ],
            }
        ],
    }


def batch() -> RawHttpResponse:
    return raw(
        {
            "values": [
                {
                    "starttime": "2026-06-30T17:00:00Z",
                    "endtime": "2026-07-01T17:00:00Z",
                    "interval": "PT1H",
                    "namespace": WIRE_TYPE,
                    "resourceregion": LOCATION,
                    "resourceid": WEB_01,
                    "value": [metric_entry(CPU), metric_entry(MEMORY)],
                }
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
        self.catalog = load_catalog()
        self.definition = overrides.pop("definition", definition())
        # Held so a scenario can assert what was *asked for*, not only what came back — the
        # fake's canned batch response is the same whatever the request names.
        self.provider_metrics = FakeMetricsPort(
            batch_responses=[batch()], fallback_responses=[]
        )
        self.provider = provider_over_ports(
            inventory_port=FakeInventoryPort([inventory()]),
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
            object_store=self.store,
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            fidelity_tier=FIDELITY_BASELINE,
            catalog=self.catalog,
        )

    def payload(self) -> dict[str, Any]:
        return {
            "command": "generate_report",
            "period": {"start": "2026-07-01", "end": "2026-07-01"},
            "scope": {
                "resource_types": [RESOURCE_TYPE],
                "resource_groups": [],
                "tag_filters": {},
            },
            "definition": self.definition,
            "template_version_id": "tv_01HQZX",
        }

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


# --------------------------------------------------------------------------- #
# The happy path, all the way through
# --------------------------------------------------------------------------- #


@pytest.fixture(scope="module")
def completed():
    """One full run, shared — a real LibreOffice conversion is the expensive part."""
    os.environ.setdefault("LANG", "C.UTF-8")
    pipeline = Pipeline()
    events, error = pipeline.run()
    return pipeline, events, error


def test_a_full_run_reaches_a_passing_verification_and_two_report_files(completed) -> None:
    """The whole path, and the partial-coverage deferral with it (Req 41.4).

    This run carries gaps — the fake answers two of the catalog's metrics — so it ends by
    raising the **non-terminal** `PartialCoverageError`. That is the designed outcome and
    the interesting half of it is the ordering: the raise comes *after* both `report_file`
    events, because a run with recorded gaps is a complete run whose gaps are on its
    snapshot. Raising at the collection boundary would abandon the document phases over a
    non-terminal condition and turn a delivered report into no report at all.
    """
    pipeline, events, error = completed

    assert isinstance(error, PartialCoverageError)
    assert error.terminal is False
    assert pipeline.outcome.verification is not None
    assert pipeline.outcome.verification["status"] == "pass", (
        pipeline.outcome.verification["findings"]
    )
    assert types_of(events).count("report_file") == 2
    assert {ref.kind for ref in pipeline.outcome.artifacts} == {"docx", "pdf"}


def test_the_phases_run_in_order_and_every_step_is_closed(completed) -> None:
    """Req 41.1, 14.14. The `tool` stream is the timeline a consultant watches, and a step
    left open is a spinner that never resolves."""
    _, events, _ = completed
    tools = [
        (event["name"], event["phase"]) for event in events if event["type"] == "tool"
    ]

    started = [name for name, phase in tools if phase == "start"]
    ended = [name for name, phase in tools if phase == "end"]

    assert started == [
        "collect_inventory",
        "collect_metrics",
        "compile_figures",
        "render_document",
        "verify_document",
        "upload_artifact",
    ]
    assert ended == started


def test_snapshot_ready_precedes_the_verification_and_done_is_last(completed) -> None:
    """Req 25.9 — the ordering guarantee, at the source."""
    _, events, _ = completed
    kinds = types_of(events)

    assert kinds.index("snapshot_ready") < kinds.index("verification")
    assert kinds.index("verification") < kinds.index("report_file")
    assert "done" not in kinds, "the router emits `done`; the pipeline never does"


def test_the_verification_event_carries_the_values_written_to_the_store(completed) -> None:
    """Req 42.2 — a client that received no event renders the identical panel from the
    stored result, which is only true if the two are one object rather than two
    constructions of "the same" payload."""
    pipeline, events, _ = completed
    event = next(e for e in events if e["type"] == "verification")

    key = next(k for k in pipeline.store.keys() if "verification-" in k)
    stored = pipeline.store.get(key)
    assert stored is not None

    import json

    written = json.loads(stored.body)
    assert written["status"] == event["status"]
    assert written["figure_count"] == event["figure_count"]
    assert written["counts"] == event["counts"]
    assert written["ledger_sha256"] == event["ledger_sha256"]


def test_every_declared_artifact_is_written_under_the_actor_prefix(completed) -> None:
    """Req 43.1 — the actor id is the **first** segment, so download authorization stays an
    exact first-segment comparison rather than a prefix test."""
    pipeline, _, _ = completed
    keys = report_objects(pipeline.store)

    for name in ("report.docx", "report.pdf", "ledger.json", "ast.json", "prose.json"):
        assert f"{ACTOR_ID}/reports/{RUN_ID}/{name}" in keys, name
    assert any("verification-" in key for key in keys)
    assert all(key.split("/")[0] == ACTOR_ID for key in keys)
    assert all(key.split("/")[1] == "reports" for key in keys)


def test_the_stored_ledger_is_the_one_the_verification_digests(completed) -> None:
    """Req 17.6 — serialized once.

    The digest the verification records is `FigureLedger.digest()`, taken over the ledger's
    RFC 8785 canonical form; the bytes written are `FigureLedger.serialize()`, the same
    form. Re-deriving the digest from the artifact is what proves they are one
    serialization rather than two that happen to agree today — a later re-verification
    reads these bytes and asserts the recompiled ledger is byte-identical to them.
    """
    import hashlib

    pipeline, _, _ = completed
    stored = pipeline.store.get(f"{ACTOR_ID}/reports/{RUN_ID}/ledger.json")

    assert stored is not None and stored.body
    assert (
        hashlib.sha256(stored.body).hexdigest()
        == pipeline.outcome.verification["ledger_sha256"]  # type: ignore[index]
    )


# --------------------------------------------------------------------------- #
# The delivery gate
# --------------------------------------------------------------------------- #


def test_the_artifacts_are_written_only_after_the_verification_passes() -> None:
    """Req 25.1, 25.2 — asserted as an **absence**.

    A definition whose executive summary carries invented prose fails the masking pass. The
    interesting assertion is not that the run failed: it is that **no report object exists
    at all** afterwards. A pipeline that uploaded first and deleted on failure would leave
    this list non-empty for a moment, and that moment is widest exactly when the process is
    about to die.
    """
    pipeline = Pipeline(prose=StubProse("Headroom grew 37.4% against last month."))
    pipeline.definition = definition(
        blocks=[
            df.block("res", "resource_table", {"columns": [df.CPU_AVG]}),
            df.block("summary", "executive_summary", {}),
        ]
    )

    events, error = pipeline.run()

    assert isinstance(error, VerificationFailedError)
    assert error.terminal is True
    assert pipeline.outcome.verification is not None
    assert pipeline.outcome.verification["status"] == "fail"
    assert "report_file" not in types_of(events)
    assert not [
        key
        for key in report_objects(pipeline.store)
        if not key.rsplit("/", 1)[-1].startswith("verification-")
    ]


def test_a_failing_verification_still_writes_its_result(completed) -> None:
    """Req 25.10 — the panel presents every finding for a run whose document was withheld,
    and it can only do that from a result the app can read."""
    pipeline = Pipeline(prose=StubProse("Utilization rose 12% this month."))
    pipeline.definition = definition(
        blocks=[
            df.block("res", "resource_table", {"columns": [df.CPU_AVG]}),
            df.block("summary", "executive_summary", {}),
        ]
    )

    _, error = pipeline.run()

    assert isinstance(error, VerificationFailedError)
    assert [key for key in report_objects(pipeline.store) if "verification-" in key]
    assert completed is not None


# --------------------------------------------------------------------------- #
# The refusals that happen before any Azure call
# --------------------------------------------------------------------------- #


def test_the_theme_is_asserted_before_a_single_azure_call() -> None:
    """Req 8.9. The failure is identical whenever it happens; what differs is whether the
    customer's subscription was queried for four minutes first."""
    pipeline = Pipeline()
    pipeline.definition = definition(design={"preset": "corporate"})
    missing = Path("does-not-exist")

    import reporting_agent.render.themes as themes

    original = themes.theme_directory
    themes.theme_directory = lambda: missing  # type: ignore[assignment]
    try:
        events, error = pipeline.run()
    finally:
        themes.theme_directory = original  # type: ignore[assignment]

    assert isinstance(error, RenderFailedError)
    assert events == [], "no step opened, so no Azure call was made"
    assert pipeline.store.keys() == (), "and nothing was written"


def test_an_uncompilable_pinned_definition_fails_before_collection() -> None:
    """Req 2.8 — the two validators drifted, and the run ends before a metric is
    requested rather than two thirds of the way through a document."""
    from reporting_agent.errors import TemplateInvalidError

    pipeline = Pipeline()
    pipeline.definition = {**definition(), "blocks": [{"id": "x", "type": "nope"}]}

    events, error = pipeline.run()

    assert isinstance(error, TemplateInvalidError)
    assert events == []
    assert pipeline.store.keys() == ()


# --------------------------------------------------------------------------- #
# What the run asks Azure for (Req 5.4)
# --------------------------------------------------------------------------- #


def test_the_run_requests_only_the_metrics_the_pinned_version_selected() -> None:
    """Req 5.4 — exactly the pinned version's selection, and nothing outside it.

    Asserted at the port, because this is a claim about the request rather than about the
    snapshot: a pipeline that asked for every metric the type emits and then compiled only
    the selected ones would produce an identical document, an identical ledger and an
    identical verification — and would have spent the customer's quota on figures nobody
    asked for. The fake's canned response carries both CPU and memory whatever is asked, so
    a narrowing that did not happen is invisible anywhere else.
    """
    pipeline = Pipeline()
    pipeline.definition = definition(metrics={RESOURCE_TYPE: [df.CPU_AVG, df.CPU_MAX]})

    _, error = pipeline.run()

    assert isinstance(error, PartialCoverageError)
    requested = {
        name for call in pipeline.provider_metrics.batch_calls for name in call["metric_names"]
    }
    assert requested == {CPU}, requested
    assert MEMORY not in requested, "memory was not selected, so it must not be requested"


def test_a_derived_selection_requests_the_source_metrics_azure_actually_emits() -> None:
    """Req 5.4 with Req 32.1. `memory_used_pct` is not a metric Azure emits — it is computed
    from `Available Memory Bytes` and a SKU capacity — so a selection naming it has to reach
    the port as its declared metric source. Requesting the derived id itself would ask for a
    name the metrics endpoint has never heard of; requesting nothing would leave every
    derived figure with no input.
    """
    pipeline = Pipeline()
    pipeline.definition = definition(
        metrics={RESOURCE_TYPE: [df.CPU_AVG, df.MEMORY_USED_PCT_AVG]}
    )

    pipeline.run()

    requested = {
        name for call in pipeline.provider_metrics.batch_calls for name in call["metric_names"]
    }
    assert requested == {CPU, MEMORY}, requested
    assert "memory_used_pct" not in requested


def test_a_top_n_ranking_metric_is_folded_into_the_request() -> None:
    """A ranking is resolved against the snapshot, so a snapshot missing the metric it ranks
    by cannot resolve it — and the block would render its empty-scope row on a run that
    collected perfectly. The fold happens even though no block config names the metric."""
    from reporting_agent.report_pipeline import requested_metric_union

    union = requested_metric_union(
        definition(
            metrics={RESOURCE_TYPE: [df.CPU_AVG]},
            blocks=[
                df.block(
                    "top",
                    "top_n_table",
                    {"columns": [df.CPU_AVG], "order_by": df.CPU_AVG},
                    scope_override=df.scope(
                        top_n={"count": 5, "metric": MEMORY, "statistic": "avg"}
                    ),
                )
            ],
        ),
        load_catalog(),
    )

    assert set(union[RESOURCE_TYPE]) == {CPU, MEMORY}, union


# --------------------------------------------------------------------------- #
# The narrowing folds case (Req 3.12) — three spellings meet in one request
# --------------------------------------------------------------------------- #
#
# Azure resource type names are case-insensitive and Resource Graph lowercases `type` in
# its response body, so `Microsoft.Compute/virtualMachines` and
# `microsoft.compute/virtualmachines` name one type. Three independent spellings reach the
# request: the definition's `metrics` key, its scope's `resource_types` entry, and the
# catalog's own declaration. Every pair of them is compared somewhere in the narrowing, and
# an exact comparison anywhere fails **closed** — a type with no metrics rather than a
# spelling mismatch, which is precisely the failure `LoadedCatalog.for_resource_type`
# documents itself as existing to prevent.
#
# These are negative tests. The suite passed with the defect present, because a narrowing
# that requests nothing still renders, still verifies and still completes.

LOWER_TYPE: Final[str] = RESOURCE_TYPE.lower()


def test_a_lowercased_metrics_key_still_resolves_a_derived_statistics_sources() -> None:
    """The row Task 12's narrowing broke: a definition whose `metrics` key is Resource
    Graph's lowercase spelling. Before the narrowing it collected every capability metric;
    with an exact-case catalog lookup it collects **none**, and two failures stack — the
    derived statistic's source metric is dropped by `_derived_source_metrics` returning `()`,
    then the intersection empties whatever was left.

    Any Task 13 affordance that seeds `metrics` from observed inventory produces exactly this
    definition, because lowercase is the casing Resource Graph returns.
    """
    from reporting_agent.report_pipeline import requested_metric_union

    union = requested_metric_union(
        definition(
            metrics={LOWER_TYPE: [df.CPU_AVG, df.MEMORY_USED_PCT_AVG]},
            template_scope=df.scope(resource_types=[RESOURCE_TYPE]),
        ),
        load_catalog(),
    )

    requested = {name for names in union.values() for name in names}
    assert MEMORY in requested, (
        "the derived statistic's source metric was dropped: the catalog lookup did not "
        f"fold case. union={union}"
    )
    assert requested == {CPU, MEMORY}, union


def test_requested_metrics_folds_case_across_the_selection_and_the_capability_map() -> None:
    """`_requested_metrics`' own two comparisons, at the point the request is built.

    Driven directly rather than through a run, because the interesting input is a
    *disagreement* between three spellings and a full run only exercises whichever pair the
    fixture happens to spell alike.
    """
    from reporting_agent.collect.pipeline import _requested_metrics

    class Capabilities:
        def capabilities(self) -> dict[str, Any]:
            return {"metrics": {RESOURCE_TYPE: [CPU, MEMORY]}}

    provider = Capabilities()

    # The selection is lowercase, the scope is the catalog's spelling.
    narrowed = _requested_metrics(
        provider,  # type: ignore[arg-type]
        {"resource_types": [RESOURCE_TYPE]},  # type: ignore[typeddict-item]
        {LOWER_TYPE: [CPU]},
    )
    assert narrowed == {RESOURCE_TYPE: [CPU]}, narrowed

    # The scope is lowercase, the selection is the catalog's spelling. The pre-existing
    # `resource_type not in available` comparison is the one that failed here.
    narrowed = _requested_metrics(
        provider,  # type: ignore[arg-type]
        {"resource_types": [LOWER_TYPE]},  # type: ignore[typeddict-item]
        {RESOURCE_TYPE: [CPU]},
    )
    assert narrowed == {RESOURCE_TYPE: [CPU]}, narrowed

    # Both lowercase. The returned key is still the capability map's spelling, so nothing
    # downstream inherits Azure's casing from this function.
    narrowed = _requested_metrics(
        provider,  # type: ignore[arg-type]
        {"resource_types": [LOWER_TYPE]},  # type: ignore[typeddict-item]
        {LOWER_TYPE: [CPU, MEMORY]},
    )
    assert narrowed == {RESOURCE_TYPE: sorted([CPU, MEMORY])}, narrowed


def test_two_case_variant_selection_keys_union_rather_than_overwrite() -> None:
    """One type under two keys is not a contrived input: `union_scope` folds a top-N ranking
    metric into the *scope's* spelling while the selection is keyed by the definition's, so a
    definition mixing the two arrives here with both. Last-one-wins would drop either the
    selection or the ranking metric depending on dict order."""
    from reporting_agent.collect.pipeline import _requested_metrics

    class Capabilities:
        def capabilities(self) -> dict[str, Any]:
            return {"metrics": {RESOURCE_TYPE: [CPU, MEMORY]}}

    narrowed = _requested_metrics(
        Capabilities(),  # type: ignore[arg-type]
        {"resource_types": [RESOURCE_TYPE]},  # type: ignore[typeddict-item]
        {RESOURCE_TYPE: [CPU], LOWER_TYPE: [MEMORY]},
    )

    assert narrowed == {RESOURCE_TYPE: sorted([CPU, MEMORY])}, narrowed


# --------------------------------------------------------------------------- #
# The snapshot-only shape is untouched
# --------------------------------------------------------------------------- #


def test_a_payload_with_no_pinned_definition_is_a_snapshot_only_run() -> None:
    """`collecting → completed` is still a legal run shape, and the foundation's tests
    describe it — so the report pipeline recognises it rather than redefining it."""
    pipeline = Pipeline()
    pipeline.definition = {}

    events: list[dict[str, Any]] = []

    async def go() -> None:
        payload = pipeline.payload()
        payload.pop("definition")
        async for event in run_generate_report(
            payload=payload,
            context=pipeline.context(),
            steps=pipeline.steps,
            artifact_bucket=BUCKET,
            provider=pipeline.provider,
            object_store=pipeline.store,
            catalog=pipeline.catalog,
        ):
            events.append(event)

    # A snapshot-only run with gaps raises the same non-terminal error, from the same
    # place it always did — the foundation's wrapper, untouched.
    with pytest.raises(PartialCoverageError):
        asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))

    assert "snapshot_ready" in types_of(events)
    assert "verification" not in types_of(events)
    assert report_objects(pipeline.store) == []
