"""`resource_narrative` — the short review under one machine's own heading.

The report had no per-resource commentary at all. `trend_narrative`, the only narrative
block wired into any section, sits under the historical trend chart and describes movement
**across months**; nothing described what a machine did **inside** the period it was
reported for, which is the paragraph a reader wants directly under the chart they have
just looked at.

This block is expanded `per: "resource"`, so the two properties that matter most here are
both about isolation rather than about prose:

* each block sees **only its own resource's** figures — an unfiltered read would give the
  third machine the first three machines' numbers, and every paragraph after the first
  would describe the wrong estate while every request grew;
* a run with no narrator leaves **nothing** behind — the same absence that prints one
  honest sentence under a single trend chart would print it under every machine in the
  report, which reads as a broken document rather than an honest one.

The model is never exercised here. `narrate/` is one method wide and its own tests cover
it; what these assert is the request this block builds and the nodes it assembles from an
answer, which is where a per-resource narration can go wrong in ways prose quality cannot
reveal.
"""

from __future__ import annotations

from decimal import Decimal

from reporting_agent.catalog.loader import load_section_catalogue
from reporting_agent.collect.snapshot import ResourceSnapshot, SkuCapacity
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import PROSE_KIND_RESOURCE
from reporting_agent.compile.blocks.narrative import (
    MAX_NARRATED_RESOURCES,
    MAX_RESOURCE_NARRATIVE_FIGURES,
)
from reporting_agent.compile.snapshot_view import build_snapshot_view
from snapshot_factory import CPU, VM_TYPE
from snapshot_factory import build as build_fixture
from snapshot_factory import exact
from snapshot_factory import resource_record as make_rec

VM_IDS = [
    f"/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-0{n}"
    for n in (1, 2, 3)
]


class RecordingProse:
    """A provider that records every request and answers with a fixed paragraph."""

    def __init__(self, answer: str = "It ran steadily through the period.") -> None:
        self.requests: list = []
        self._answer = answer

    def narrate(self, request) -> str:
        self.requests.append(request)
        return self._answer


class SilentProse:
    """A provider that answers nothing — a throttle, a retired model, an expired role."""

    def narrate(self, request) -> str:
        return ""


def _view():
    resources = [
        ResourceSnapshot(
            record=make_rec(resource_id=rid, name=rid.rsplit("/", 1)[-1]),
            sku=SkuCapacity(
                name="Standard_D2s_v5",
                vcpus_available=2,
                memory_bytes=Decimal("8589934592"),
            ),
            statistics=(exact(CPU, "avg", f"1{n}.50"), exact(CPU, "max", f"6{n}.00")),
            day_buckets=(),
            facts=(),
        )
        for n, rid in enumerate(VM_IDS)
    ]
    return build_snapshot_view(build_fixture(resources=resources))


def _definition():
    return {
        "schema_version": 3,
        "provider": "azure",
        "identity": {"language": "en", "customer_name": "Test", "report_title": "Test"},
        "period": {"kind": "last_full_month"},
        "design": {"preset": "corporate"},
        "front_matter": {},
        "sections": [
            {
                "id": "sec_util",
                "type": "vm_utilization",
                "position": 1,
                "selection": {
                    "resource_types": [VM_TYPE],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [
                    {"metric": CPU, "statistic": "avg"},
                    {"metric": CPU, "statistic": "max"},
                ],
                "presentation": "chart_and_table",
            }
        ],
    }


def _compile(prose):
    return compile_document(
        _definition(),
        view=_view(),
        prose=prose,
        catalogue=load_section_catalogue(),
    )


def _resource_requests(prose: RecordingProse) -> list:
    return [r for r in prose.requests if r.kind == PROSE_KIND_RESOURCE]


def test_one_request_per_machine_under_its_own_kind() -> None:
    """Three machines, three per-resource requests — and each under the instruction
    written for this narration, not the executive summary's."""
    prose = RecordingProse()
    _compile(prose)
    assert len(_resource_requests(prose)) == len(VM_IDS)


def test_each_request_carries_only_its_own_machine_s_figures() -> None:
    """The isolation property. Every figure label in a machine's request names that
    machine, and no request grows with the machines compiled before it."""
    prose = RecordingProse()
    _compile(prose)
    requests = _resource_requests(prose)
    names = [rid.rsplit("/", 1)[-1] for rid in VM_IDS]
    for name, request in zip(names, requests, strict=True):
        assert request.figures, f"{name} was asked for prose with no figures"
        for label, _formatted in request.figures:
            assert label.startswith(name), (
                f"{name}'s request carries a figure labelled {label!r}"
            )
        assert request.resource_count == 1


def test_the_requests_do_not_grow_with_position() -> None:
    """The specific shape the unfiltered bug takes: request N holding N machines' figures.
    Equal counts is the cheap, unambiguous witness that it does not."""
    prose = RecordingProse()
    _compile(prose)
    sizes = {len(r.figures) for r in _resource_requests(prose)}
    assert len(sizes) == 1, f"per-machine request sizes differ: {sizes}"


def test_the_answer_becomes_a_paragraph_under_each_machine() -> None:
    """What the reader gets. One paragraph per machine, carrying the model's text
    unaltered (Req 16.12)."""
    prose = RecordingProse(answer="It ran steadily through the period.")
    compiled = _compile(prose)
    texts = _paragraph_texts(compiled)
    assert texts.count("It ran steadily through the period.") == len(VM_IDS)


def test_a_silent_narrator_leaves_no_trace_under_any_machine() -> None:
    """Deliberately unlike `trend_narrative`, which prints one honest sentence when it has
    nothing. Repeated once per machine that sentence is noise, and the heading, table and
    chart above it already show the section is there."""
    compiled = _compile(SilentProse())
    texts = _paragraph_texts(compiled)
    assert not any("could not be written" in text for text in texts)


def test_no_provider_at_all_is_the_same_absence() -> None:
    """The state every delivered report was in before the wiring fix: no provider. It must
    not raise and must not print an apology per machine."""
    compiled = _compile(None)
    texts = _paragraph_texts(compiled)
    assert not any("could not be written" in text for text in texts)


def test_the_prompt_is_bounded_per_machine() -> None:
    """A bound on the prompt, multiplied by the estate. This asserts the cap is applied,
    not that this fixture reaches it — the fixture deliberately does not."""
    prose = RecordingProse()
    _compile(prose)
    for request in _resource_requests(prose):
        assert len(request.figures) <= MAX_RESOURCE_NARRATIVE_FIGURES


def _paragraph_texts(compiled) -> list[str]:
    """Every `Paragraph`'s literal text, flattened over the whole document.

    Paragraphs carry `inlines`, not `runs`; a walker that guessed the attribute name found
    nothing and reported an empty document as a document with no prose in it. Asserting on
    a shape read from `compile/ast.py` rather than remembered.
    """
    texts: list[str] = []

    def walk(node) -> None:
        inlines = getattr(node, "inlines", None)
        if inlines:
            joined = "".join(
                inline.text
                for inline in inlines
                if isinstance(getattr(inline, "text", None), str)
            )
            if joined:
                texts.append(joined)
        for attr in ("blocks", "nodes", "rows", "cells"):
            children = getattr(node, attr, None)
            if children:
                for child in children:
                    walk(child)

    walk(compiled.document)
    return texts


def test_the_number_of_model_calls_is_bounded_by_the_estate_s_first_twelve() -> None:
    """The cost bound, and the reason the block exists in the shape it does.

    Expanded per resource, an unbounded narrative makes the number of model calls in a
    report equal to the size of the fleet — the opposite of what "one paragraph per
    resource, to limit token cost" asked for. Sixteen machines, twelve paragraphs.
    """
    many = [
        f"/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-{n:02d}"
        for n in range(16)
    ]
    resources = [
        ResourceSnapshot(
            record=make_rec(resource_id=rid, name=rid.rsplit("/", 1)[-1]),
            sku=SkuCapacity(
                name="Standard_D2s_v5",
                vcpus_available=2,
                memory_bytes=Decimal("8589934592"),
            ),
            statistics=(exact(CPU, "avg", "12.50"), exact(CPU, "max", "60.00")),
            day_buckets=(),
            facts=(),
        )
        for rid in many
    ]
    view = build_snapshot_view(build_fixture(resources=resources))
    prose = RecordingProse()
    compile_document(
        _definition(), view=view, prose=prose, catalogue=load_section_catalogue()
    )
    assert len(_resource_requests(prose)) == MAX_NARRATED_RESOURCES
    assert MAX_NARRATED_RESOURCES < len(many), "the fixture must exceed the bound"


def test_an_unnarrated_machine_still_gets_its_section() -> None:
    """The bound spends a paragraph, not a machine. Its heading, table and chart are
    untouched — a resource that vanished past the twelfth would be a reporting hole."""
    many = [
        f"/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Compute/virtualMachines/vm-{n:02d}"
        for n in range(16)
    ]
    resources = [
        ResourceSnapshot(
            record=make_rec(resource_id=rid, name=rid.rsplit("/", 1)[-1]),
            sku=SkuCapacity(
                name="Standard_D2s_v5",
                vcpus_available=2,
                memory_bytes=Decimal("8589934592"),
            ),
            statistics=(exact(CPU, "avg", "12.50"),),
            day_buckets=(),
            facts=(),
        )
        for rid in many
    ]
    view = build_snapshot_view(build_fixture(resources=resources))
    compiled = compile_document(
        _definition(), view=view, prose=RecordingProse(), catalogue=load_section_catalogue()
    )
    texts = _paragraph_texts(compiled)
    assert "vm-15" in texts, "the sixteenth machine lost its heading, not just its paragraph"
