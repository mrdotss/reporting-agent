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
import re
from collections.abc import AsyncIterator
from typing import Any, Final

import pytest

from fakes.azure_ports import FakeInventoryPort

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from reporting_agent.azure.clients import (
    distinct_dimensions_query,
    resource_counts_query,
)
from reporting_agent.azure.inventory import (
    COUNT_COLUMN,
    DIMENSION_REGIONS,
    DIMENSION_RESOURCE_GROUPS,
    DIMENSION_RESOURCE_TYPES,
    DIMENSION_TAG_KEYS,
    DIMENSION_TAG_VALUES,
    DISTINCT_VALUE_LIMIT,
    INVENTORY_DIMENSIONS,
    LOCATION_COLUMN,
    TYPE_COLUMN,
    DimensionValues,
    InventoryCollector,
    InventoryDimensions,
    ResourceGraphQueryError,
    read_counts,
    read_dimension,
    service_error_text,
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


def test_the_five_dimensions_are_declared_once_each() -> None:
    """One declaration for the query's column, the reader's field and `done`'s key. Three
    spellings that agree today is how one picker silently goes empty."""
    assert INVENTORY_DIMENSIONS == (
        DIMENSION_RESOURCE_TYPES,
        DIMENSION_RESOURCE_GROUPS,
        DIMENSION_TAG_KEYS,
        DIMENSION_TAG_VALUES,
        DIMENSION_REGIONS,
    )
    assert INVENTORY_DIMENSIONS == (
        "resource_types",
        "resource_groups",
        "tag_keys",
        "tag_values",
        "regions",
    )
    assert len(set(INVENTORY_DIMENSIONS)) == 5


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

    assert len(summarized) == 5
    for name in INVENTORY_DIMENSIONS:
        assert f"{name} = make_set_if(" in query


# --------------------------------------------------------------------------- #
# The projection is also the column set every later stage resolves against
# --------------------------------------------------------------------------- #

_IDENTIFIER: Final = re.compile(r"[A-Za-z_][A-Za-z0-9_]*")
_ASSIGNMENT: Final = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\s*=(?!=)")

_KQL_WORDS: Final[frozenset[str]] = frozenset(
    {
        "array_length",
        "bag_keys",
        "coalesce",
        "iff",
        "isnotempty",
        "make_set_if",
        "pack_array",
        "string",
        "to",
        "tostring",
        "typeof",
    }
)
"""Names in the query text that are KQL functions, type names or keywords — not columns.

Enumerated rather than inferred, and that direction matters: an unrecognised name has to
fail the walk below as an unresolved column, because the defect being guarded is exactly a
name that reads like a column and is not one in scope at that point.
"""


def _stages(query: str) -> list[str]:
    """The query's pipeline stages, each continuation line folded into the stage it belongs
    to.

    `summarize` spans five lines, indented rather than piped, so a per-line reading sees
    four stages that reference columns and no stage that declares them — which is how the
    defect below survived a file of assertions over this query's text.
    """
    stages: list[str] = []
    for line in query.splitlines():
        if line.startswith("|") or not stages:
            stages.append(line.strip())
        else:
            stages[-1] += " " + line.strip()
    return stages


def _referenced(expression: str) -> set[str]:
    """Every column an expression reads: its identifiers, less assignments and KQL words."""
    return {
        name
        for name in _IDENTIFIER.findall(_ASSIGNMENT.sub("", expression))
        if name not in _KQL_WORDS
    }


def _unresolved(query: str) -> list[tuple[str, set[str]]]:
    """Each stage that names a column not in scope where it runs, with the names.

    A plain re-reading of what Resource Graph does to the query: `project` **replaces** the
    column set, `extend` and `mv-expand` each add one to it, and every other stage has to
    resolve against whatever is there by then. Stages before the first `project` are skipped
    — the full `Resources` schema is in scope there and this file does not model it.
    """
    available: set[str] | None = None
    failures: list[tuple[str, set[str]]] = []
    for stage in _stages(query):
        if not stage.startswith("|"):
            continue
        verb, _, rest = stage[1:].strip().partition(" ")
        if verb == "project":
            available = {column.partition("=")[0].strip() for column in rest.split(",")}
            continue
        if available is None:
            continue
        if verb in {"extend", "mv-expand"}:
            name, _, expression = rest.partition("=")
            missing = _referenced(expression) - available
            available.add(name.strip())
        else:
            missing = _referenced(rest) - available
        if missing:
            failures.append((stage, missing))
    return failures


def test_every_column_the_pipeline_names_survives_the_projection() -> None:
    """The defect this exists for: `regions = make_set_if(location, ...)` was added to the
    `summarize` and `location` was not added to the `project`, so the one stage that reads it
    ran against a column set the projection had already dropped. Resource Graph answers the
    **whole query** with a 400, `distinct_dimensions` raises rather than claiming an empty
    subscription, and the scan screen reported 0 types, 0 regions and 0 groups for every
    estate.

    Every assertion in this file passed throughout, because each one reads the query looking
    for text that is present. This one walks the pipeline instead and asks a question text
    cannot answer: is each name in scope where it is used.
    """
    assert _unresolved(distinct_dimensions_query(subscription_id=SUBSCRIPTION)) == []


def test_the_walk_catches_a_dimension_whose_source_column_is_not_projected() -> None:
    """The guard above, shown failing on the query that shipped — otherwise it is a test
    that passes because it checks nothing.
    """
    shipped = distinct_dimensions_query(subscription_id=SUBSCRIPTION).replace(
        "| project type, location, resourceGroup, tags",
        "| project type, resourceGroup, tags",
    )
    failures = _unresolved(shipped)

    assert [missing for _, missing in failures] == [{"location"}]
    assert failures[0][0].startswith("| summarize")


def test_each_dimension_summarizes_a_column_the_projection_carries() -> None:
    """The same invariant stated per dimension, so the failure names which one is unsourced
    rather than only that some stage is."""
    query = distinct_dimensions_query(subscription_id=SUBSCRIPTION)
    projected = {
        column.strip()
        for column in query.split("| project", 1)[1].splitlines()[0].split(",")
    }
    sourced = dict(re.findall(r"(\w+) = make_set_if\((\w+),", query))

    assert set(sourced) == set(INVENTORY_DIMENSIONS)
    for dimension, column in sourced.items():
        # Either straight off the projection, or a column an `extend`/`mv-expand` built.
        assert column in projected | {"tagKey", "tagValue"}, dimension


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
    assert query.count(f", {DISTINCT_VALUE_LIMIT + 1})") == 5
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


# --------------------------------------------------------------------------- #
# What the log says when a query fails — the diagnosis, not just the status
# --------------------------------------------------------------------------- #


def arm_error(
    code: str = "BadRequest", message: str = "Query is invalid", **detail: str
) -> dict[str, Any]:
    """An ARM error envelope shaped the way Resource Graph actually sends one.

    Parsed JSON, because `clients._body_of` parses every body before it reaches a port's
    caller — which is the fact the first version of this logging got wrong.
    """
    body: dict[str, Any] = {"error": {"code": code, "message": message}}
    if detail:
        body["error"]["details"] = [dict(detail)]
    return body


def test_the_service_error_names_the_code_the_message_and_the_offending_token() -> None:
    """`ParserFailure ... 'location'` is the whole diagnosis of the defect this file's
    pipeline walk now prevents, and it was being thrown away."""
    text = service_error_text(
        arm_error(code="ParserFailure", message="Failed to resolve column", token="location")
    )

    assert "BadRequest" not in text
    assert "ParserFailure" in text
    assert "Failed to resolve column" in text
    assert "'location'" in text


def test_the_service_error_survives_every_body_shape_a_port_can_hand_back() -> None:
    """None of these may raise. A diagnostic that fires only when something has already
    failed is the last place an exception belongs — the previous version called `.decode`
    on a parsed body and took the run down on the one path it existed to report."""
    for body in (
        None,
        b"raw bytes",
        "a string",
        {"no": "error key"},
        {"error": "not a mapping"},
        {"error": {"code": "X", "details": "not a list"}},
        {"error": {"code": "X", "details": [None, 7, {"code": "Y"}]}},
        [1, 2, 3],
        object(),
    ):
        assert isinstance(service_error_text(body), str)


def test_the_service_error_is_bounded_so_a_long_body_cannot_fill_the_log() -> None:
    assert len(service_error_text(arm_error(message="x" * 5000))) <= 600


def test_the_service_error_is_scrubbed_like_every_other_logged_provider_string() -> None:
    """Redaction is not skipped on the grounds that an error body "cannot" hold a secret."""
    from reporting_agent.redaction import (
        SECRET_PLACEHOLDER,
        discard_secrets,
        register_secrets,
    )

    # Longer than `MIN_SECRET_LENGTH`, or the registry declines to register it at all.
    token = register_secrets(["s3cret-value-from-the-vault"])
    try:
        text = service_error_text(
            arm_error(message="rejected s3cret-value-from-the-vault outright")
        )
    finally:
        discard_secrets(token)

    assert "s3cret-value-from-the-vault" not in text
    assert SECRET_PLACEHOLDER in text


def test_a_failed_dimensions_query_logs_what_the_service_said(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The status alone said a query failed and not why, which is why the `location` defect
    took a source read rather than a log read to find."""
    caplog.set_level("WARNING")
    with pytest.raises(ResourceGraphQueryError):
        run(
            InventoryCollector(
                FakeInventoryPort(
                    [RawHttpResponse(status=400, headers={}, body=arm_error(token="location"))]
                )
            ).distinct_dimensions(subscription_id=SUBSCRIPTION)
        )

    assert "'location'" in caplog.text


def test_a_failed_child_query_logs_and_returns_rather_than_raising(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """The regression: this path's own warning called `.decode` on a body that is parsed
    JSON, so a 400 from the child query raised `AttributeError` out of the logging line and
    ended the whole run — instead of recording no child resource and carrying on. No test
    drove a failing child query, so every suite stayed green.
    """
    caplog.set_level("WARNING")

    class FailingChildPort:
        async def query_child_resources(self, *, subscription_id: str) -> RawHttpResponse:
            return RawHttpResponse(
                status=400, headers={}, body=arm_error(code="ParserFailure", token="fact_subnet")
            )

    result = run(
        InventoryCollector(FailingChildPort()).discover_child_resources(
            subscription_id=SUBSCRIPTION, fidelity_tier="baseline"
        )
    )

    assert list(result["resources"]) == []
    assert "'fact_subnet'" in caplog.text


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
    assert set(done) == {"type", "run_id", "status"} | set(INVENTORY_DIMENSIONS)
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
            ),
            # The second query the scan issues: one count row per (type, location) pair.
            # Scripted from the same queue as the first, so the assertion below pins exactly
            # two queries rather than tolerating any number.
            response({"type": "microsoft.storage/storageaccounts", "location": "eastus", "resource_count": 3}),
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
    # Exactly two queries: the dimensions aggregate and the per-type counts.
    #
    # The shared fake records each call's kwargs but not which method received them, so a
    # count of two cannot by itself tell "dimensions then counts" from "dimensions twice".
    # The second query is therefore pinned by its **effect** — the counts below can only be
    # on `done` if `query_resource_counts` was called and its answer read.
    assert len(port.calls) == 2
    assert all(call["subscription_id"] == SUBSCRIPTION for call in port.calls)

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
    assert done["resource_count"] == 3
    assert done["type_counts"] == {"microsoft.storage/storageaccounts": 3}
    assert done["child_type_counts"] == {}, (
        "the shipped catalogs declare no child type yet, so every counted type is a "
        "headline one"
    )
    assert done["region_counts"] == {"eastus": 3}


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


# --------------------------------------------------------------------------- #
# Positive secret guard (Req 15.11) — no event carries a secret key or value
# --------------------------------------------------------------------------- #

# The canonical secret identifiers, reusing the same key names and distinctive values
# as `test_run_wiring.py`'s Req 15.6 integration gate.
_SECRET_KEYS: Final[frozenset[str]] = frozenset(
    {"progress_token", "client_secret", "tenant_id", "client_id"}
)
_SECRET_VALUES: Final[tuple[tuple[str, str], ...]] = (
    ("client_secret", "not-a-real-client-secret-Zq7Z~x0LmN4pR8sT2vW6yA9cE3gH5jK"),
    ("progress_token", "not-a-real-progress-token-b7e2d4c6a8f0192837465564738291a0"),
    ("tenant_id", "tenant-0d4f1a2b-not-a-real-tenant-id"),
    ("client_id", "client-9e8d7c6b-not-a-real-client-id"),
)


def _assert_no_secret_in_events(events: list[dict[str, Any]]) -> None:
    """Assert no event carries a secret field name as a key or a secret value anywhere."""
    import json

    serialized = json.dumps(events)
    for name, value in _SECRET_VALUES:
        assert value not in serialized, (
            f"secret value of {name!r} appeared in serialized events"
        )
    for event in events:
        leaked_keys = _SECRET_KEYS & set(event)
        assert not leaked_keys, (
            f"secret key(s) {leaked_keys} appeared as top-level event keys in "
            f"event type={event.get('type')!r}"
        )


def test_no_secret_key_or_value_reaches_any_event_on_list_inventory() -> None:
    """Req 15.11 — positive guard: inject known secrets into the context and assert none
    survive into any event, either as a key name or as a value at any depth."""
    events = drain(
        run_invocation(
            parse_invocation(
                payload(
                    context={
                        "actor_id": ACTOR,
                        "subscription_id": SUBSCRIPTION,
                        "client_secret": _SECRET_VALUES[0][1],
                        "progress_token": _SECRET_VALUES[1][1],
                        "tenant_id": _SECRET_VALUES[2][1],
                        "client_id": _SECRET_VALUES[3][1],
                    },
                )
            ),
            handlers={COMMAND_LIST_INVENTORY: stub_handler(aggregate())},
        )
    )

    _assert_no_secret_in_events(events)


# --------------------------------------------------------------------------- #
# read_counts / resource_counts_query — the partitioned counts (task 1.3)
# --------------------------------------------------------------------------- #

CHILD_TYPE = "Microsoft.Network/virtualNetworks/subnets"
VM_TYPE_DECLARED = "Microsoft.Compute/virtualMachines"


def _count_rows() -> list[dict[str, object]]:
    """One VNet, one NSG, two VMs — plus the sub-records the Phase 5 collectors emit:
    four subnets and six security rules. Fourteen ARM ids, four deployed things.
    Spread across two regions to exercise the per-region accumulation."""
    return [
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 1},
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "westus", COUNT_COLUMN: 1},
        {TYPE_COLUMN: "microsoft.network/virtualnetworks", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 1},
        {TYPE_COLUMN: "microsoft.network/networksecuritygroups", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 1},
        {TYPE_COLUMN: "microsoft.network/virtualnetworks/subnets", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 4},
        {TYPE_COLUMN: "microsoft.network/networksecuritygroups/securityrules", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 6},
    ]


def test_the_headline_count_is_invariant_when_child_types_start_being_declared() -> None:
    """Task 1.3, Guard B — the property that makes Phase 5 safe to ship mid-engagement.

    Phase 5 adds the collectors that emit sub-records, so the **same** estate starts
    answering with subnets and security rules in it. If those counted, an untouched
    subscription would report 4 resources one month and 14 the next, and a customer
    comparing two consecutive reports would read that as infrastructure growth. Correct
    arithmetic, misleading number.

    Counted twice over one set of rows: once with no child type declared (the world before
    Phase 5) and once with both declared (after). `resource_count` and `type_counts` must be
    **identical** across the two, and only `child_type_counts` may move.
    """
    rows = _count_rows()

    before = read_counts(rows, child_types=())
    after = read_counts(
        rows,
        child_types=(CHILD_TYPE, "Microsoft.Network/networkSecurityGroups/securityRules"),
    )

    assert after.resource_count == 4, "two VMs, one VNet, one NSG — the deployed things"
    assert before.resource_count == 14, (
        "without the declaration every ARM id counts, which is the state this guard exists "
        "to prove we left"
    )
    assert dict(after.type_counts) == {
        "microsoft.compute/virtualmachines": 2,
        "microsoft.network/virtualnetworks": 1,
        "microsoft.network/networksecuritygroups": 1,
    }
    assert dict(after.child_type_counts) == {
        "microsoft.network/virtualnetworks/subnets": 4,
        "microsoft.network/networksecuritygroups/securityrules": 6,
    }
    assert sum(after.type_counts.values()) + sum(after.child_type_counts.values()) == 14, (
        "no row is dropped by the partition — every ARM id is counted in exactly one family"
    )


def test_the_region_count_is_invariant_when_child_types_start_being_declared() -> None:
    """The per-region map must not inflate when Phase 5's collectors start emitting
    sub-records, for the same reason the per-type map does not: `is_child_type` marks a
    subnet or a security rule as a sub-record, and a sub-record is not a deployed thing in
    the sense a reader takes from a count.

    Mutation-checked: collapsing the partition (treating children as non-children) would
    inflate eastus from 3 to 13.
    """
    rows = _count_rows()

    before = read_counts(rows, child_types=())
    after = read_counts(
        rows,
        child_types=(CHILD_TYPE, "Microsoft.Network/networkSecurityGroups/securityRules"),
    )

    # With the partition active, only non-child types are counted per region.
    assert dict(after.region_counts) == {"eastus": 3, "westus": 1}
    # Without the partition, child types inflate the region counts.
    assert dict(before.region_counts) == {"eastus": 13, "westus": 1}
    # The mutation check: if region_counts included children despite the partition, eastus
    # would be 13. That it is 3 proves the partition is applied.
    assert after.region_counts["eastus"] == 3


def test_per_type_total_sums_across_regions() -> None:
    """A fixture whose estate puts ONE resource type in TWO regions, asserting the per-type
    total sums across both. This is the regression the (type, location, count) change risks:
    if read_counts overwrote rather than summed, only the last region's count would survive.
    """
    rows = [
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 5},
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "westeurope", COUNT_COLUMN: 3},
    ]
    counts = read_counts(rows, child_types=())

    assert counts.type_counts["microsoft.compute/virtualmachines"] == 8
    assert counts.resource_count == 8
    assert dict(counts.region_counts) == {"eastus": 5, "westeurope": 3}


def test_per_region_map_from_multiple_types_in_one_region() -> None:
    """Multiple non-child types in a single region sum into one region entry."""
    rows = [
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 3},
        {TYPE_COLUMN: "microsoft.storage/storageaccounts", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 2},
    ]
    counts = read_counts(rows, child_types=())

    assert dict(counts.region_counts) == {"eastus": 5}
    assert counts.resource_count == 5


def test_region_counts_omits_rows_with_absent_or_empty_location() -> None:
    """A row with no location is counted in type_counts but not in region_counts —
    the region map must not carry a blank key."""
    rows = [
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", COUNT_COLUMN: 2},
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "", COUNT_COLUMN: 1},
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 4},
    ]
    counts = read_counts(rows, child_types=())

    assert counts.type_counts["microsoft.compute/virtualmachines"] == 7
    assert counts.resource_count == 7
    assert dict(counts.region_counts) == {"eastus": 4}


def test_the_partition_folds_case_between_the_wire_and_the_catalog() -> None:
    """Resource Graph lower-cases `type`; the catalogs declare Azure's own casing. An exact
    comparison would put every sub-record in the headline family and the partition would
    silently do nothing — the defect, reached through a spelling mismatch."""
    counts = read_counts(
        [{TYPE_COLUMN: CHILD_TYPE.casefold(), COUNT_COLUMN: 4}], child_types=(CHILD_TYPE,)
    )

    assert counts.resource_count == 0
    assert dict(counts.child_type_counts) == {CHILD_TYPE.casefold(): 4}


@pytest.mark.parametrize("count", [None, "3", -1, 1.5, True])
def test_an_unreadable_count_is_skipped_rather_than_zero_filled(count: object) -> None:
    """A type present in the answer with an unreadable count is not a type with no
    resources. `True` is in the set because `isinstance(True, int)` is `True` in Python, so
    a boolean reaching a count column would otherwise be read as the number 1."""
    counts = read_counts(
        [{TYPE_COLUMN: VM_TYPE_DECLARED, COUNT_COLUMN: count}], child_types=()
    )

    assert counts.type_counts == {}
    assert counts.resource_count == 0


def test_the_counts_query_projects_no_resource_id() -> None:
    """Req 9.5, and the reason this is a second query rather than columns on the first.

    That query's exclusion of resource identifiers is **structural** — it projects none, so
    there is no field a filter has to remove. Counting distinct ids would put `id` back into
    the projection and turn the guarantee back into a promise.
    """
    query = resource_counts_query(subscription_id=SUBSCRIPTION)

    assert " id" not in query and "id," not in query
    assert "count_distinct" not in query, (
        "count_distinct/count_distinctif are Azure Data Explorer functions whose presence in "
        "Resource Graph's KQL subset is unverified here; this query does not mv-expand, so "
        "count() is already exact"
    )
    assert "mv-expand" not in query, "no row multiplication, so no distinct-count is needed"
    assert f"summarize {COUNT_COLUMN} = count() by {TYPE_COLUMN}, {LOCATION_COLUMN}" in query


def test_the_counts_query_has_exactly_one_count_expression() -> None:
    """The trap this task exists to avoid.

    The design sketched three `count_distinct(id)` expressions distinguished only by
    trailing comments. Copied verbatim that returns the same number three times and the
    partitioning silently does nothing — a plausible wrong number, which is the failure class
    this whole task is about. One expression, partitioned in Python, cannot have that bug.
    """
    query = resource_counts_query(subscription_id=SUBSCRIPTION)

    assert query.count("count()") == 1


def test_the_counts_query_is_byte_identical_between_two_calls() -> None:
    first = resource_counts_query(subscription_id=SUBSCRIPTION)
    second = resource_counts_query(subscription_id=SUBSCRIPTION)
    assert first == second


def test_the_counts_query_escapes_the_subscription_id() -> None:
    query = resource_counts_query(subscription_id="it's-not-a-guid")
    assert "'it''s-not-a-guid'" in query
