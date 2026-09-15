"""End-to-end tests for `list_resources`, driven through `main.invoke` (ask-chat Req 8.1).

The Resource Graph port and the credential are the only substitutions: the router, the
step tracker, the outcome merge onto `done` and `emit`'s scrub all run for real.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Sequence
from typing import Any, Final

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from fakes.azure_ports import FakeInventoryPort
from pipeline_harness import SUBSCRIPTION, inventory, resource_id
from reporting_agent import main
from reporting_agent.events import HEARTBEAT_EVENT_TYPE
from reporting_agent.redaction import discard_secrets

Event = dict[str, Any]

CLIENT_SECRET: Final[str] = "not-a-real-client-secret-list-resources-0123456789"


class _Credential:
    """Stands in for `InvocationCredential`; records that it was closed."""

    closed = False

    def __init__(self, **_kwargs: object) -> None:
        pass

    def close(self) -> None:
        type(self).closed = True


def _payload(**context: object) -> dict[str, Any]:
    return {
        "command": "list_resources",
        "context": {
            "actor_id": "user_list_resources",
            "subscription_id": SUBSCRIPTION,
            "tenant_id": "tenant-not-real",
            "client_id": "client-not-real",
            "client_secret": CLIENT_SECRET,
            "fidelity_tier": "baseline",
            **context,
        },
    }


def _invoke(monkeypatch: pytest.MonkeyPatch, port: FakeInventoryPort, body: dict[str, Any]) -> list[Event]:
    closed: list[bool] = []
    monkeypatch.setattr(
        "reporting_agent.azure.clients.build_inventory_port",
        lambda *, credential: (port, lambda: closed.append(True)),
    )
    monkeypatch.setattr("reporting_agent.azure.credential.InvocationCredential", _Credential)
    discard_secrets()

    async def drain() -> list[Event]:
        return [event async for event in main.invoke(body)]

    events = asyncio.run(asyncio.wait_for(drain(), timeout=60))
    return [event for event in events if event["type"] != HEARTBEAT_EVENT_TYPE]


def _names(resources: Sequence[dict[str, Any]]) -> list[str]:
    return [resource["name"] for resource in resources]


def test_the_machines_ride_on_done_sorted_by_name(monkeypatch: pytest.MonkeyPatch) -> None:
    port = FakeInventoryPort([inventory(["prod-web-01", "cpn-app"])])
    events = _invoke(monkeypatch, port, _payload())

    assert [event["type"] for event in events] == ["tool", "tool", "done"]
    done = events[-1]
    assert done["status"] == "completed"
    assert _names(done["resources"]) == ["cpn-app", "prod-web-01"]
    assert done["resources"][0]["resource_id"] == resource_id("cpn-app")
    assert set(done["resources"][0]) == {
        "resource_id",
        "name",
        "resource_type",
        "location",
        "resource_group",
        "sku_name",
        "power_state",
    }
    assert done["resources_truncated"] is False
    assert port.calls[0]["resource_types"] == ("Microsoft.Compute/virtualMachines",)
    assert _Credential.closed is True


def test_no_secret_reaches_the_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    events = _invoke(monkeypatch, FakeInventoryPort([inventory(["cpn-app"])]), _payload())
    assert CLIENT_SECRET not in repr(events)


def test_a_listing_with_no_subscription_is_one_error_then_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    events = _invoke(monkeypatch, FakeInventoryPort([]), _payload(subscription_id=""))
    assert [event["type"] for event in events] == ["error", "done"]
    assert events[-1]["status"] == "failed"
    assert "resources" not in events[-1]
