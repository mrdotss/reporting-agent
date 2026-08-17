"""The drift sampler's re-query half (Req 34).

Property 5 covers the selection. What is left is everything about the *port*: that a
descriptor is recorded before the first re-query and whether or not a finding results, that
a resource the port cannot answer for is recorded as not re-queried and does not stop the
rest, and that nothing here can fail a verification.

The test that matters most is
:func:`test_a_port_that_raises_does_not_fail_the_verification`. An expired credential or a
network blip during an advisory spot check must not withhold a document that every hard
gate passed — and "must not" is only true if it has been observed.
"""

from __future__ import annotations

import asyncio
from decimal import Decimal
from typing import Any, Final

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.verify.drift import (
    DRIFT_SAMPLE_METHOD,
    primary_metric,
    requery_sample,
    select,
)
from reporting_agent.verify.findings import FINDING_DRIFT_OBSERVED, SEVERITY_ADVISORY
from reporting_agent.verify.ports import MetricRequeryPort, RequeriedValue

SEED: Final[str] = "c" * 64
WINDOW: Final[dict[str, str]] = {"start": "2026-07-01", "end": "2026-07-31"}


@pytest.fixture()
def view():
    return build_snapshot_view(sf.two_vm_snapshot())


class FakePort:
    """Answers with whatever it was handed, and records what it was asked."""

    def __init__(self, answers: dict[str, str] | None = None, *, raises: bool = False):
        self.answers = answers or {}
        self.raises = raises
        self.calls: list[dict[str, Any]] = []

    async def requery(self, **kwargs: Any):
        self.calls.append(kwargs)
        if self.raises:
            raise RuntimeError("the subscription's client secret expired last week")
        return [
            RequeriedValue(
                resource_id=resource_id,
                metric=kwargs["metric"],
                statistic=kwargs["statistic"],
                value=Decimal(value),
            )
            for resource_id, value in self.answers.items()
        ]


def run(view, *, port, sample=None, metric=sf.CPU, statistic="max"):
    resolved = select(view, named=(), seed=SEED, metric=metric) if sample is None else sample
    return asyncio.run(
        requery_sample(
            view,
            sample=resolved,
            seed=SEED,
            metric=metric,
            statistic=statistic,
            window=WINDOW,
            grain="PT1H",
            requery=port,
        )
    )


def test_the_port_satisfies_the_protocol() -> None:
    """The port is a `runtime_checkable` Protocol, so a fake that drifts from it fails here
    rather than in the middle of a verification."""
    assert isinstance(FakePort(), MetricRequeryPort)


# --------------------------------------------------------------------------- #
# Req 34.3 — the descriptor, recorded before the first re-query
# --------------------------------------------------------------------------- #


def test_the_descriptor_is_recorded_whether_or_not_a_finding_results(view) -> None:
    """Recorded either way, because the descriptor exists so a disputed check is re-runnable
    — and a check that found nothing is exactly the one somebody disputes."""
    unchanged = {
        resource.resource_id: str(view.stat(resource.resource_id, sf.CPU, "max").value)
        for resource in view.resources
    }

    outcome = run(view, port=FakePort(unchanged))

    assert outcome.findings == ()
    assert outcome.sample["seed"] == SEED
    assert outcome.sample["method"] == DRIFT_SAMPLE_METHOD
    assert outcome.sample["n"] == 2
    assert outcome.requeried == 2


def test_the_descriptor_is_recorded_when_there_is_no_port_at_all(view) -> None:
    """Req 25.7 — a verification with no port is a complete verification. Drift is advisory,
    so a re-verification of a two-year-old report, whose credential expired long ago,
    reaches the same status as one that re-queried everything."""
    outcome = run(view, port=None)

    assert outcome.findings == ()
    assert outcome.requeried == 0
    assert outcome.sample["n"] == 2
    assert len(outcome.sample["not_requeried"]) == 2


# --------------------------------------------------------------------------- #
# Req 34.5, 34.6 — a difference is advisory
# --------------------------------------------------------------------------- #


def test_a_differing_value_is_one_advisory_finding_naming_both_values(view) -> None:
    first = view.resources[0].resource_id
    recorded = view.stat(first, sf.CPU, "max").value

    outcome = run(view, port=FakePort({first: "99.99"}))

    findings = [f for f in outcome.findings if f["type"] == FINDING_DRIFT_OBSERVED]
    assert len(findings) == 1
    assert findings[0]["severity"] == SEVERITY_ADVISORY
    assert findings[0]["resource_id"] == first
    assert findings[0]["observed"] == "99.99"
    assert findings[0]["expected"] == str(recorded)
    assert findings[0]["snapshot_path"]


def test_a_difference_below_the_recorded_precision_is_not_drift(view) -> None:
    """Req 34.5 — "at the precision the snapshot records that value".

    The snapshot stores a decimal string at the catalog's declared scale. A re-query
    answering one digit finer is the same measurement described more precisely, and
    reporting it would make every honest run accumulate advisory noise until nobody reads
    the panel.
    """
    first = view.resources[0].resource_id
    recorded = view.stat(first, sf.CPU, "max")

    outcome = run(view, port=FakePort({first: f"{recorded.value}4999"}))

    assert outcome.findings == ()
    assert outcome.requeried >= 1


# --------------------------------------------------------------------------- #
# Req 34.9, 34.10 — an unanswered resource stops nothing
# --------------------------------------------------------------------------- #


def test_a_resource_the_port_cannot_answer_for_is_recorded_and_the_rest_continue(
    view,
) -> None:
    """Req 34.9. Recorded as not re-queried, no finding of any kind, and the remaining
    re-queries complete."""
    first, second = (resource.resource_id for resource in view.resources)

    outcome = run(view, port=FakePort({second: "99.99"}))

    assert outcome.sample["not_requeried"] == [first]
    assert outcome.requeried == 1
    assert [f["resource_id"] for f in outcome.findings] == [second]


def test_a_port_that_raises_does_not_fail_the_verification(view) -> None:
    """An expired credential during an **advisory** spot check must not withhold a document
    that every hard gate passed.

    Letting the exception propagate would couple the delivery of a correct report to the
    liveness of a subscription — which is the coupling Req 34.10 exists to forbid, and the
    one a naive implementation reintroduces by simply not catching.
    """
    port = FakePort(raises=True)

    outcome = run(view, port=port)

    assert port.calls, "the port was reached, so the failure is the one under test"
    assert outcome.findings == ()
    assert outcome.requeried == 0
    assert len(outcome.sample["not_requeried"]) == outcome.sample["n"]


def test_the_port_is_asked_only_for_the_sample(view) -> None:
    """Req 34.2 — no full re-query. Asserted against the call the port actually received,
    not against the sampler's intent."""
    port = FakePort()

    run(view, port=port, sample=(view.resources[0].resource_id,))

    assert len(port.calls) == 1
    assert port.calls[0]["resource_ids"] == [view.resources[0].resource_id]
    assert port.calls[0]["metric"] == sf.CPU
    assert port.calls[0]["grain"] == "PT1H"
    assert port.calls[0]["window"] == WINDOW


def test_an_empty_sample_reaches_no_port_at_all(view) -> None:
    port = FakePort()

    outcome = run(view, port=port, sample=())

    assert port.calls == []
    assert outcome.sample["n"] == 0


# --------------------------------------------------------------------------- #
# Req 34.1 — the primary metric
# --------------------------------------------------------------------------- #


def test_the_primary_metric_is_the_first_the_pinned_selection_names(view) -> None:
    definition = df.definition([df.block("res", "resource_table", {"columns": [df.CPU_AVG]})])

    assert primary_metric(view, definition) == (sf.VM_TYPE, sf.CPU)


def test_a_tie_in_resource_count_resolves_by_ascending_resource_type_id() -> None:
    """Req 34.4's least obvious clause, and the one doing the most work: without it the
    *primary metric* depends on dictionary iteration order, so two verifications of one
    snapshot spot-check different metrics."""
    other = "Microsoft.Storage/storageAccounts"
    resources = [
        sf.vm(resource_id="/vm/a", name="a"),
        sf.vm(resource_id="/sa/a", name="sa", resource_type=other),
    ]
    view = build_snapshot_view(
        sf.build(resources=resources, resource_types=[sf.VM_TYPE, other])
    )
    definition = df.definition(
        [df.block("res", "resource_table", {"columns": [df.CPU_AVG]})],
        metrics={sf.VM_TYPE: [df.CPU_AVG], other: [df.CPU_MAX]},
    )

    resolved = primary_metric(view, definition)

    assert resolved is not None
    # Both types carry one resource, so the ascending type id wins: "Microsoft.Compute/..."
    # sorts before "Microsoft.Storage/...".
    assert resolved[0] == sf.VM_TYPE
    assert primary_metric(view, definition) == resolved


def test_a_snapshot_with_no_resources_has_no_primary_metric() -> None:
    view = build_snapshot_view(sf.build(resources=[]))

    assert primary_metric(view, {"metrics": {sf.VM_TYPE: [df.CPU_AVG]}}) is None


def test_a_definition_naming_no_metric_for_the_busiest_type_has_no_primary_metric(
    view,
) -> None:
    """Failing closed on a definition that cannot answer the question, rather than picking
    a metric from a different resource type and spot-checking the wrong thing."""
    definition = df.definition(
        [df.block("res", "resource_table", {"columns": [df.CPU_AVG]})],
        metrics={"Microsoft.Storage/storageAccounts": [df.CPU_AVG]},
    )

    assert primary_metric(view, definition) is None
