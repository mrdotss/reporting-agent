"""Live metrics pulls in chat: parsing, grounding, labelling (ask-chat Req 8)."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest

from fakes.object_store import InMemoryObjectStore
from reporting_agent.chat.grounding import (
    SOURCE_LIVE,
    LiveUnavailableError,
    live_statistic_facts,
    load_live_grounding,
    number_facts,
)
from reporting_agent.chat.payload import (
    MAX_ATTACHED_LIVE,
    AttachedLive,
    ChatPayloadError,
    parse_chat_request,
)
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.narrate.chat import SYSTEM_PROMPT, build_grounding

LIVE = AttachedLive(
    pull_id="pull_1",
    owner_actor_id="user_1",
    connector_label="mrdotss-MSDN",
    window_display="1–7 Sept 2026",
    collected_at="2026-09-15T09:30:00Z",
)

SNAPSHOT: dict[str, Any] = {
    "resources": [
        {
            "name": "cpn-app",
            "resource_type": "Microsoft.Compute/virtualMachines",
            "location": "southeastasia",
            "sku": {"name": "Standard_B2als_v2", "vcpus_available": "2"},
            "statistics": [
                {"metric": "Percentage CPU", "statistic": "avg", "value": "8.06", "unit": "percent"},
                {"metric": "Percentage CPU", "statistic": "max", "value": "41.20", "unit": "percent"},
                {"metric": "Network In Total", "statistic": "sum", "value": "123456", "unit": "bytes"},
                {"metric": "Odd", "statistic": "avg", "value": "1.5", "unit": "furlongs"},
            ],
        }
    ]
}


def _live_body(**overrides: Any) -> dict[str, Any]:
    pull = {
        "pull_id": "pull_1",
        "owner_actor_id": "user_1",
        "connector_label": "mrdotss-MSDN",
        "window_display": "1–7 Sept 2026",
        "collected_at": "2026-09-15T09:30:00Z",
    }
    pull.update(overrides)
    return {"prompt": "How busy was cpn-app?", "attachments": {"runs": [], "scans": [], "live": [pull]}}


def test_a_live_attachment_parses() -> None:
    request = parse_chat_request(_live_body())
    assert request.live == (LIVE,)


def test_a_live_pull_id_that_could_escape_its_key_is_refused() -> None:
    with pytest.raises(ChatPayloadError):
        parse_chat_request(_live_body(pull_id="pull/../other"))


def test_too_many_live_pulls_are_refused() -> None:
    body = _live_body()
    body["attachments"]["live"] = body["attachments"]["live"] * (MAX_ATTACHED_LIVE + 1)
    with pytest.raises(ChatPayloadError):
        parse_chat_request(body)


def test_live_statistics_become_live_facts_formatted_like_a_report() -> None:
    facts = list(live_statistic_facts(SNAPSHOT, {"pull_id": "pull_1"}))
    assert [(fact.label, fact.formatted) for fact in facts] == [
        ("cpn-app · Percentage CPU · avg", "8.06%"),
        ("cpn-app · Percentage CPU · max", "41.20%"),
        # The report formatter's own floor: one decimal place, so a byte total reads as the
        # delivered document prints it.
        ("cpn-app · Network In Total · sum", "123,456.0 bytes"),
        ("cpn-app · Odd · avg", "1.5 furlongs"),
    ]
    assert {fact.source for fact in facts} == {SOURCE_LIVE}
    assert facts[0].ref["snapshot_path"] == "resources/0/statistics/0"


def test_a_live_pull_grounds_its_statistics_and_sizes() -> None:
    store = InMemoryObjectStore(
        objects={snapshot_key("user_1", "pull_1"): json.dumps(SNAPSHOT).encode("utf-8")}
    )
    grounding = asyncio.run(load_live_grounding(store, LIVE))

    assert grounding.vm_sizes[0].sku == "Standard_B2als_v2"
    sources = {fact.source for fact in grounding.facts}
    assert sources == {SOURCE_LIVE}
    citation = grounding.facts[0].citation("f1")
    assert citation["pull_id"] == "pull_1" and citation["connector_label"] == "mrdotss-MSDN"


def test_a_pull_with_no_snapshot_is_unavailable() -> None:
    with pytest.raises(LiveUnavailableError):
        asyncio.run(load_live_grounding(InMemoryObjectStore(), LIVE))


def test_the_model_is_told_live_figures_are_not_verified() -> None:
    facts = number_facts(live_statistic_facts(SNAPSHOT, {"pull_id": "pull_1"}))
    text = build_grounding(nonce="n", runs=[], scans=[], facts=facts, targets=[], live=[LIVE])
    assert "NOT verified" in text
    assert "mrdotss-MSDN | window 1–7 Sept 2026" in text
    assert "f1 | live | cpn-app · Percentage CPU · avg | 8.06%" in text
    assert "live metrics pull" in SYSTEM_PROMPT and "not verified" in SYSTEM_PROMPT
