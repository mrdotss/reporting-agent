"""Task 12.1 — `distinct_dimensions` and the `list_inventory` command (Req 9.1, 9.3, 9.5).

Three properties this module exists to keep, each of which is invisible to a test that only
checks the happy path:

**One query.** `FakeInventoryPort` scripts `query_resources` and `query_distinct_dimensions`
from the **same** queue, so a `distinct_dimensions` that also paged the inventory shows up as
an extra recorded call rather than as nothing at all.

**Nothing but the four dimensions.** Asserted against the query text, because Req 9.5's
exclusion is a property of the projection: the assertions below say the query names no `id`
and no `subscriptionId` in anything it projects, so there is no field a later filter would
have to remove and no way for one to be forgotten.

**A failed query reports no dimension.** Four empty dimensions is a claim about the
subscription, and Req 9.9 names that claim — "an empty option list a consultant would read as
an empty subscription" — as the reading to avoid. The `done` of a failed listing carries no
dimension key at all.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import AsyncIterator
from typing import Any, Final

import pytest

from fakes.azure_ports import FakeInventoryPort

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from reporting_agent.azure.clients import distinct_dimensions_query
from reporting_agent.azure.inventory import (
    DIMENSION_RESOURCE_GROUPS,
    DIMENSION_RESOURCE_TYPES,
    DIMENSION_TAG_KEYS,
    DIMENSION_TAG_VALUES,
    DISTINCT_VALUE_LIMIT,
    INVENTORY_DIMENSIONS,
    DimensionValues,
    InventoryCollector,
    InventoryDimensions,
    ResourceGraphQueryError,
    read_dimension,
)
from reporting_agent.azure.ports import InventoryPort, RawHttpResponse
from reporting_agent.errors import AuthFailedError, ErrorCode, ThrottledError
from reporting_agent.main import (
    COMMAND_LIST_INVENTORY,
    COMMANDS,
    Invocation,
    StepTracker,
    handle_list_inventory,
    parse_invocation,
    run_invocation,
)

SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
ACTOR: Final[str] = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"


def run(coro: Any) -> Any:
    return asyncio.run(coro)


def response(row: dict[str, Any] | None, *, status: int = 200) -> RawHttpResponse:
    """One Resource Graph aggregate answer. `None` scripts a body carrying no row."""
    return RawHttpResponse(
        status=status,
        headers={},
        body={"data": [] if row is None else [row], "count": 0 if row is None else 1},
    )


def aggregate(**dimensions: list[Any]) -> dict[str, Any]:
    """One summarize row, defaulting every unnamed dimension to an empty set."""
    return {name: list(dimensions.get(name, [])) for name in INVENTORY_DIMENSIONS}


def dimensions_from(
    row: dict[str, Any] | None, *, status: int = 200
) -> InventoryDimensions:
    port = FakeInventoryPort([response(row, status=status)])
    return run(InventoryCollector(port).distinct_dimensions(subscription_id=SUBSCRIPTION))


# --------------------------------------------------------------------------- #
# The declarations
# --------------------------------------------------------------------------- #


def test_the_four_dimensions_are_declared_once_each() -> None:
    """One declaration for the query's column, the reader's field and `done`'s key. Three
    spellings that agree today is how one picker silently goes empty."""
    assert INVENTORY_DIMENSIONS == (
        DIMENSION_RESOURCE_TYPES,
        DIMENSION_RESOURCE_GROUPS,
        DIMENSION_TAG_KEYS,
        DIMENSION_TAG_VALUES,
    )
    assert INVENTORY_DIMENSIONS == (
        "resource_types",
        "resource_groups",
        "tag_keys",
        "tag_values",
    )
    assert len(set(INVENTORY_DIMENSIONS)) == 4


def test_the_per_dimension_bound_is_two_thousand() -> None:
    assert DISTINCT_VALUE_LIMIT == 2000


def test_the_dimensions_dataclass_has_one_field_per_declared_dimension() -> None:
    """`to_plain_data` keys by the tuple, so a dimension added there with no field here
    fails loudly rather than being quietly absent from the payload."""
    empty = DimensionValues(values=(), truncated=False)
    built = InventoryDimensions(empty, empty, empty, empty)
    assert set(built.to_plain_data()) == set(INVENTORY_DIMENSIONS)


# --------------------------------------------------------------------------- #
# Req 9.5 — the projection is the exclusion
# --------------------------------------------------------------------------- #


def test_the_query_projects_the_four_dimensions_and_nothing_else() -> None:
    query = distinct_dimensions_query(subscription_id=SUBSCRIPTION)
    summarized = [line for line in query.splitlines() if "make_set_if" in line]

    assert len(summarized) == 4
    for name in INVENTORY_DIMENSIONS:
        assert f"{name} = make_set_if(" in query


@pytest.mark.parametrize(
    "identifier", ["id,", " id ", "tenantId", "clientId", "resourceId"]
)
def test_the_query_projects_no_resource_or_principal_identifier(identifier: str) -> None:
    """Req 9.5 as a property of the projection rather than of a filter applied afterwards:
    a response cannot disclose a field the query never asked for."""
    query = distinct_dimensions_query(subscription_id=SUBSCRIPTION)
    projected = [
        line
        for line in query.splitlines()
        if line.startswith(("| project", "| extend", "| summarize", "  "))
    ]
    assert projected, query
    for line in projected:
        assert identifier not in line, line


def test_the_subscription_id_is_a_scope_filter_and_never_a_projected_column() -> None:
    query = distinct_dimensions_query(subscription_id=SUBSCRIPTION)
    scoping = [line for line in query.splitlines() if SUBSCRIPTION in line]

    assert len(scoping) == 1
    assert scoping[0].startswith("| where subscriptionId ==")
    assert "subscriptionId" not in query.split("| project", 1)[1]


def test_the_query_escapes_the_subscription_id_it_interpolates() -> None:
    """The value arrives from the invocation `context`, so it is quoted like every other
    outside string `inventory_query` interpolates."""
    query = distinct_dimensions_query(subscription_id="it's-not-a-guid")
    assert "'it''s-not-a-guid'" in query


def test_the_query_asks_for_one_more_value_than_the_bound() -> None:
    """The only available evidence that the true set is larger than the bound: Resource
    Graph reports no total beside an aggregate, so receiving 2001 is the signal and asking
    for exactly 2000 would make "exactly 2000" and "more than 2000" one response."""
    query = distinct_dimensions_query(subscription_id=SUBSCRIPTION)
    assert query.count(f", {DISTINCT_VALUE_LIMIT + 1})") == 4
    assert f", {DISTINCT_VALUE_LIMIT})" not in query


def test_the_query_keeps_an_untagged_resource_in_the_type_and_group_dimensions() -> None:
    """`mv-expand` over an **empty** array drops the row, which would remove an untagged
    resource's type and group as well — a picker that cannot offer the type of the one
    untagged VM in the subscription. The sentinel keeps the row and `isnotempty` excludes
    it from the two tag dimensions alone."""
    query = distinct_dimensions_query(subscription_id=SUBSCRIPTION)
    assert "pack_array('')" in query
    assert "mv-expand tagKey = tagKeys" in query
    assert "make_set_if(tagKey, isnotempty(tagKey)" in query
    assert "make_set_if(tagValue, isnotempty(tagValue)" in query


def test_the_query_is_byte_identical_between_two_calls() -> None:
    """A query that reorders itself between calls makes a support case's quoted text and a
    recorded fixture both useless."""
    first = distinct_dimensions_query(subscription_id=SUBSCRIPTION)
    second = distinct_dimensions_query(subscription_id=SUBSCRIPTION)
    assert first == second


# --------------------------------------------------------------------------- #
# Req 9.1 — one query, ordered, bounded, with a per-dimension flag
# --------------------------------------------------------------------------- #


def test_exactly_one_port_call_is_made_and_it_is_the_aggregate_one() -> None:
    """Req 9.2's "exactly one Azure Resource Graph query per cache miss". The fake scripts
    both methods from one queue, so a second call of either kind would exhaust it."""
    port = FakeInventoryPort([response(aggregate(resource_types=["Microsoft.Compute/x"]))])
    run(InventoryCollector(port).distinct_dimensions(subscription_id=SUBSCRIPTION))

    assert len(port.calls) == 1
    assert port.calls[0] == {"subscription_id": SUBSCRIPTION}


def test_each_dimension_is_ordered_ascending_in_code_point_order() -> None:
    """Code-point order, not a locale collation: `Z` sorts before `a` and `ä` after both.
    A locale-aware sort would order the same subscription two ways on two machines."""
    dimensions = dimensions_from(
        aggregate(
            resource_types=["b", "a", "C"],
            resource_groups=["rg-10", "rg-2", "rg-1"],
            tag_keys=["Zone", "ap", "\u00e4pfel"],
            tag_values=["\U0001f600", "1", "Z", "a"],
        )
    )

    assert dimensions.resource_types.values == ("C", "a", "b")
    assert dimensions.resource_groups.values == ("rg-1", "rg-10", "rg-2")
    assert dimensions.tag_keys.values == ("Zone", "ap", "\u00e4pfel")
    assert dimensions.tag_values.values == ("1", "Z", "a", "\U0001f600")


def test_a_dimension_at_the_bound_is_complete_and_not_flagged() -> None:
    values = [f"value-{index:05d}" for index in range(DISTINCT_VALUE_LIMIT)]
    dimensions = dimensions_from(aggregate(tag_values=values))

    assert len(dimensions.tag_values.values) == DISTINCT_VALUE_LIMIT
    assert dimensions.tag_values.truncated is False


def test_a_dimension_one_past_the_bound_is_cut_to_it_and_flagged() -> None:
    values = [f"value-{index:05d}" for index in range(DISTINCT_VALUE_LIMIT + 1)]
    dimensions = dimensions_from(aggregate(tag_values=values))

    assert len(dimensions.tag_values.values) == DISTINCT_VALUE_LIMIT
    assert dimensions.tag_values.truncated is True
    # Cut **after** the sort, so a truncated dimension is the lexicographically first
    # 2000 of what came back rather than an arbitrary 2000 of it.
    assert dimensions.tag_values.values == tuple(sorted(values)[:DISTINCT_VALUE_LIMIT])


def test_the_truncation_flag_is_per_dimension_and_not_per_response() -> None:
    """A subscription can carry three resource types and forty thousand tag values. One
    response-level flag would either understate the complete dimensions or overstate the
    cut one."""
    dimensions = dimensions_from(
        aggregate(
            resource_types=["Microsoft.Compute/virtualMachines"],
            tag_values=[f"v{index:05d}" for index in range(DISTINCT_VALUE_LIMIT + 1)],
        )
    )

    assert dimensions.resource_types.truncated is False
    assert dimensions.tag_values.truncated is True


def test_an_aggregate_carrying_no_row_reads_as_four_empty_dimensions() -> None:
    """A subscription with no resources at all returns no row from a `summarize`, and that
    is a real case: Req 9.9 routes it to the free-entry fallback rather than treating it as
    an error, so an absent row is not a malformed answer."""
    dimensions = dimensions_from(None)

    for name in INVENTORY_DIMENSIONS:
        assert getattr(dimensions, name) == DimensionValues(values=(), truncated=False)


def test_a_blank_subscription_id_raises_before_any_port_call() -> None:
    port = FakeInventoryPort([])
    with pytest.raises(ValueError, match="subscription_id"):
        run(InventoryCollector(port).distinct_dimensions(subscription_id="   "))
    assert port.calls == []


# --------------------------------------------------------------------------- #
# read_dimension — the pure reader
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        (["b", "a"], ("a", "b")),
        (["a", "a"], ("a",)),
        ([], ()),
        (None, ()),
        ("not-an-array", ()),
        (42, ()),
        ({"a": 1}, ()),
        (["a", None, 3, "b"], ("a", "b")),
        (["a", ""], ("a",)),
    ],
)
def test_read_dimension_drops_every_unusable_member(
    raw: object, expected: tuple[str, ...]
) -> None:
    """A `None` or an empty string in a picker's option list is an option a consultant can
    select and a run cannot collect."""
    assert read_dimension({"d": raw}, "d").values == expected


def test_read_dimension_of_an_absent_column_is_empty_and_untruncated() -> None:
    assert read_dimension({}, "d") == DimensionValues(values=(), truncated=False)


def test_dimension_values_refuses_a_shape_it_promised_not_to_return() -> None:
    """The three invariants `read_dimension` establishes, asserted on the type rather than
    trusted of the one function that builds it — so a second builder cannot skip them."""
    with pytest.raises(ValueError, match=r"past Req 9\.1's bound"):
        DimensionValues(
            values=tuple(f"v{i:05d}" for i in range(DISTINCT_VALUE_LIMIT + 1)),
            truncated=True,
        )
    with pytest.raises(ValueError, match="repeated value"):
        DimensionValues(values=("a", "a"), truncated=False)
    with pytest.raises(ValueError, match="code-point order"):
        DimensionValues(values=("b", "a"), truncated=False)


def test_dimension_values_serializes_its_flag_alongside_its_values() -> None:
    assert DimensionValues(values=("a",), truncated=True).to_plain_data() == {
        "values": ["a"],
        "truncated": True,
    }


# --------------------------------------------------------------------------- #
# A response that did not succeed reports no dimension
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("status", "expected"),
    [
        (429, ThrottledError),
        (401, AuthFailedError),
        (403, AuthFailedError),
        (400, ResourceGraphQueryError),
        (404, ResourceGraphQueryError),
        (500, ResourceGraphQueryError),
        (503, ResourceGraphQueryError),
    ],
)
def test_each_unsuccessful_status_raises_the_exception_its_cause_calls_for(
    status: int, expected: type[Exception]
) -> None:
    """The three cases are told apart because they call for different actions: retry, fix
    the credential, or read the runtime log. A `503` presented as `AUTH_FAILED` would send
    a consultant to rotate a secret that is fine — the "specific enough to be believed and
    pointing at the wrong thing" failure `main._row_error_code` records."""
    with pytest.raises(expected):
        dimensions_from(aggregate(), status=status)


def test_the_retryable_and_the_auth_failures_carry_their_declared_codes() -> None:
    with pytest.raises(ThrottledError) as throttled:
        dimensions_from(aggregate(), status=429)
    assert throttled.value.code is ErrorCode.THROTTLED
    # The instance is terminal — this listing is over — while the **class** is retryable,
    # which is what lets the wizard offer "try again" rather than a permanent failure.
    assert throttled.value.terminal is True
    assert ThrottledError.retryable is True

    with pytest.raises(AuthFailedError) as auth:
        dimensions_from(aggregate(), status=403)
    assert auth.value.code is ErrorCode.AUTH_FAILED
    assert auth.value.terminal is True


def test_a_residual_failure_is_not_an_agent_error_so_it_reports_as_a_runtime_defect() -> None:
    """A `400` is a defect in the KQL this package wrote and a `5xx` is Azure's; neither is
    a fact about the subscription, so neither may present as a collection code."""
    from reporting_agent.errors import AgentError

    assert not issubclass(ResourceGraphQueryError, AgentError)
    with pytest.raises(ResourceGraphQueryError) as caught:
        dimensions_from(aggregate(), status=500)
    assert caught.value.status == 500
    assert "500" in str(caught.value)


def test_an_unsuccessful_response_reports_no_dimension_at_all() -> None:
    """Not four empty ones. Req 9.9 names four empty dimensions as the reading to avoid,
    and a failed query is the case that would produce it."""
    port = FakeInventoryPort([response(aggregate(), status=500)])
    with pytest.raises(ResourceGraphQueryError):
        run(InventoryCollector(port).distinct_dimensions(subscription_id=SUBSCRIPTION))


# --------------------------------------------------------------------------- #
# The port contract
# --------------------------------------------------------------------------- #


def test_the_fake_still_satisfies_the_port_protocol() -> None:
    assert isinstance(FakeInventoryPort([]), InventoryPort)


def test_the_aggregate_port_method_takes_no_continuation_token() -> None:
    """"One query per call" as a property of the signature: there is no `skip_token`
    parameter to pass and none to read back, so no loop can form."""
    import inspect

    signature = inspect.signature(InventoryPort.query_distinct_dimensions)
    assert set(signature.parameters) == {"self", "subscription_id"}


# --------------------------------------------------------------------------- #
# The `list_inventory` command
# --------------------------------------------------------------------------- #


def payload(**overrides: Any) -> dict[str, Any]:
    body: dict[str, Any] = {
        "command": COMMAND_LIST_INVENTORY,
        "context": {
            "actor_id": ACTOR,
            "subscription_id": SUBSCRIPTION,
            "tenant_id": "tenant",
            "client_id": "client",
            "client_secret": "secret-value",
        },
    }
    body.update(overrides)
    return body


def drain(source: Any) -> list[dict[str, Any]]:
    async def go() -> list[dict[str, Any]]:
        return [event async for event in source]

    return run(go())


def types_of(events: list[dict[str, Any]]) -> list[str]:
    return [event["type"] for event in events]


def one(events: list[dict[str, Any]], kind: str) -> dict[str, Any]:
    matches = [event for event in events if event["type"] == kind]
    assert len(matches) == 1, f"expected exactly one {kind}, got {types_of(events)}"
    return matches[0]


def stub_handler(
    row: dict[str, Any] | None, *, status: int = 200
) -> Any:
    """`handle_list_inventory`'s body over a scripted port.

    A stub rather than the real handler because the real one constructs a
    `ClientSecretCredential` and a `ResourceGraphClient` — the wiring `test_run_wiring.py`
    covers. What is asserted here is the router-visible shape: one step, four keys on
    `done`, and no dimension key when the query did not answer.
    """

    async def handler(
        invocation: Invocation, steps: StepTracker
    ) -> AsyncIterator[dict[str, Any]]:
        from reporting_agent.events import TOOL_COLLECT_INVENTORY

        port = FakeInventoryPort([response(row, status=status)])
        step = steps.start(
            TOOL_COLLECT_INVENTORY, label="Inventory", status="Listing"
        )
        yield step
        dimensions = await InventoryCollector(port).distinct_dimensions(
            subscription_id=SUBSCRIPTION
        )
        invocation.outcome.update(dimensions.to_plain_data())
        yield steps.end(step["id"])

    return handler


def test_list_inventory_is_an_accepted_command_with_a_handler() -> None:
    from reporting_agent.main import COMMAND_HANDLERS

    assert COMMAND_LIST_INVENTORY in COMMANDS
    assert COMMAND_HANDLERS[COMMAND_LIST_INVENTORY] is handle_list_inventory


def test_a_list_inventory_payload_is_routed_and_not_rejected() -> None:
    invocation = parse_invocation(payload(prompt="what is in this subscription?"))
    assert invocation.rejection is None
    assert invocation.command == COMMAND_LIST_INVENTORY


def test_the_four_dimension_keys_reach_done() -> None:
    """Req 9.1's whole result, on the terminal event, through `Invocation.outcome` — no new
    event type, so `events.py` and `lib/events.ts` are untouched."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={
                COMMAND_LIST_INVENTORY: stub_handler(
                    aggregate(
                        resource_types=["Microsoft.Compute/virtualMachines"],
                        resource_groups=["rg-prod"],
                        tag_keys=["env"],
                        tag_values=["prod", "dev"],
                    )
                )
            },
        )
    )

    assert types_of(events) == ["tool", "tool", "done"]
    done = one(events, "done")
    assert done["status"] == "completed"
    assert set(INVENTORY_DIMENSIONS) <= set(done)
    assert done["tag_values"] == {"values": ["dev", "prod"], "truncated": False}
    assert done["resource_types"] == {
        "values": ["Microsoft.Compute/virtualMachines"],
        "truncated": False,
    }


def test_done_stays_the_last_event_and_keeps_its_three_pinned_fields() -> None:
    """Req 14.10 — an outcome key cannot overwrite `type`, `run_id` or `status`, and
    nothing follows `done`."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_LIST_INVENTORY: stub_handler(aggregate())},
        )
    )

    assert types_of(events)[-1] == "done"
    assert types_of(events).count("done") == 1
    done = one(events, "done")
    assert done["type"] == "done"
    assert done["run_id"] is None
    assert done["status"] == "completed"


def test_a_failed_listing_reports_no_dimension_key_on_done() -> None:
    """The distinction from `preflight`, which seeds its refusing answer first:
    `scope_verified: false` is true of a preflight that proved nothing, while four empty
    dimensions is a claim about the subscription that a failed query does not license."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_LIST_INVENTORY: stub_handler(aggregate(), status=500)},
        )
    )

    done = one(events, "done")
    assert done["status"] == "failed"
    for name in INVENTORY_DIMENSIONS:
        assert name not in done
    assert one(events, "error")["terminal"] is True


def test_a_step_left_open_by_a_failed_listing_is_closed_before_done() -> None:
    """Req 14.14 — a spinner that never resolves is indistinguishable from a listing still
    running, and the endpoint's own 30-second bound is the only thing that would end it."""
    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_LIST_INVENTORY: stub_handler(aggregate(), status=403)},
        )
    )

    tools = [(event["name"], event["phase"]) for event in events if event["type"] == "tool"]
    assert tools == [("collect_inventory", "start"), ("collect_inventory", "end")]
    assert types_of(events).index("error") < types_of(events).index("done")


def test_the_command_adds_no_event_type() -> None:
    """`events.py` and `app/lib/events.ts` are not edited by this task, so the
    cross-language event mirror stays untouched."""
    from reporting_agent.events import EVENT_TYPES

    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_LIST_INVENTORY: stub_handler(aggregate())},
        )
    )
    for kind in types_of(events):
        assert kind in EVENT_TYPES


def test_the_secret_never_reaches_the_terminal_event() -> None:
    """Req 15.1, 15.8 — the credentials travel in the invoke `context` and the listing's
    result travels back on `done`; the one must not ride along with the other."""
    from reporting_agent.main import emit

    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={
                COMMAND_LIST_INVENTORY: stub_handler(
                    aggregate(tag_values=["secret-value"])
                )
            },
        )
    )
    scrubbed = [emit(event) for event in events]
    assert "secret-value" not in repr(scrubbed)


def test_the_real_handler_builds_the_port_lists_and_closes_everything_it_opened(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The **production** construction site, called rather than substituted.

    `handle_list_inventory` builds an `InvocationCredential` and a Resource Graph port and
    closes both in a `finally`; a test that replaced the whole handler would leave every one
    of those lines with no caller but a deployed container. Only `build_inventory_port` is
    monkeypatched — the one call that would open a socket — so the credential is constructed
    for real (its construction performs no network call by design) and both teardown calls
    are observed.
    """
    from reporting_agent.azure import clients as clients_module
    from reporting_agent.azure.credential import InvocationCredential
    from reporting_agent.events import TOOL_COLLECT_INVENTORY

    port = FakeInventoryPort(
        [
            response(
                aggregate(
                    resource_types=["Microsoft.Storage/storageAccounts"],
                    tag_keys=["owner", "env"],
                )
            )
        ]
    )
    closed: list[str] = []

    def fake_build(*, credential: Any) -> tuple[Any, Any]:
        assert credential.tenant_id == "tenant"
        assert credential.client_id == "client"
        return (port, lambda: closed.append("port"))

    monkeypatch.setattr(clients_module, "build_inventory_port", fake_build)

    original_close = InvocationCredential.close

    def spy_close(self: Any) -> None:
        closed.append("credential")
        original_close(self)

    monkeypatch.setattr(InvocationCredential, "close", spy_close)

    invocation = parse_invocation(payload())
    events = drain(
        run_invocation(
            invocation, handlers={COMMAND_LIST_INVENTORY: handle_list_inventory}
        )
    )

    # Both, in this order: a client closed after its credential is a client whose auth
    # policy can no longer refresh, which turns a teardown into a failed in-flight request.
    assert closed == ["port", "credential"]
    assert len(port.calls) == 1
    assert port.calls[0] == {"subscription_id": SUBSCRIPTION}

    tools = [(event["name"], event["phase"]) for event in events if event["type"] == "tool"]
    assert tools == [
        (TOOL_COLLECT_INVENTORY, "start"),
        (TOOL_COLLECT_INVENTORY, "end"),
    ]

    done = one(events, "done")
    assert done["status"] == "completed"
    assert done["resource_types"] == {
        "values": ["Microsoft.Storage/storageAccounts"],
        "truncated": False,
    }
    assert done["tag_keys"] == {"values": ["env", "owner"], "truncated": False}
    assert done["resource_groups"] == {"values": [], "truncated": False}


def test_the_real_handler_reports_no_dimension_key_when_the_query_did_not_answer(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The failure path of the **production** handler, not of a stub.

    Asserted against the real handler on purpose: the property is that
    `invocation.outcome` is written *only on success*, and a stub that never seeds cannot
    tell a handler that seeds four empty dimensions up front from one that does not. It is
    the seeding version that ships `resource_types: []` on a failed listing — Req 9.9's
    "an empty option list a consultant would read as an empty subscription".
    """
    from reporting_agent.azure import clients as clients_module

    port = FakeInventoryPort([response(aggregate(), status=500)])
    monkeypatch.setattr(
        clients_module,
        "build_inventory_port",
        lambda *, credential: (port, lambda: None),
    )

    events = drain(
        run_invocation(
            parse_invocation(payload()),
            handlers={COMMAND_LIST_INVENTORY: handle_list_inventory},
        )
    )

    done = one(events, "done")
    assert done["status"] == "failed"
    for name in INVENTORY_DIMENSIONS:
        assert name not in done, f"{name} was reported for a listing that never answered"
    assert one(events, "error")["terminal"] is True


def test_a_list_inventory_payload_with_no_subscription_id_builds_no_client_at_all(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """There is no scope to enumerate without one, and no safe default.

    The assertion that matters is **no client was built**, not merely that the invocation
    failed: without the guard the handler constructs a credential, opens a Resource Graph
    client and lets the query fail on its own, which produces the same failed `done` for a
    different reason. A test that only read the terminal event would pass either way.
    """
    from reporting_agent.azure import clients as clients_module

    def refuse(*, credential: Any) -> tuple[Any, Any]:
        raise AssertionError(
            "a Resource Graph client was built for a payload naming no subscription"
        )

    monkeypatch.setattr(clients_module, "build_inventory_port", refuse)

    body = payload()
    del body["context"]["subscription_id"]

    events = drain(
        run_invocation(
            parse_invocation(body), handlers={COMMAND_LIST_INVENTORY: handle_list_inventory}
        )
    )

    assert one(events, "done")["status"] == "failed"
    error = one(events, "error")
    assert error["terminal"] is True
    # The failure names the field. `run_invocation` replaces an unanticipated exception's
    # message with a generic one, so the name travels in the log — which is why the message
    # is asserted through the raise rather than through the event.
    with pytest.raises(ValueError, match="subscription_id"):
        drain(handle_list_inventory(parse_invocation(body), StepTracker()))

    for name in INVENTORY_DIMENSIONS:
        assert name not in one(events, "done")
