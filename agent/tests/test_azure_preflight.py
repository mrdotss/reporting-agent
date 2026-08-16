"""The preflight gate — `azure/preflight.py` and the routed `preflight` command.

Req 12.1, 12.2, 12.3, 12.4, 12.8, 12.9, 12.10, 12.11, 12.12, 12.13 and 14.3, all without a
subscription, a tenant, a token or a socket. Three surfaces:

* **The pure decision.** `derive_scope_verified` takes the parsed permissions response and
  nothing else, so every case Req 12.2 and 12.3 enumerate — a subscription-scope Reader
  entry, a `notActions` subtraction, an empty entry list, a malformed body — is an
  example-based unit test. That the function is pure is itself asserted: it is the
  mechanism behind Req 12.4, because a parameter an inventory result could arrive through
  is the only way that flag could ever be set from a successful query.
* **The service's I/O.** `PermissionsTransport` and `RowCounter` are injected, so the
  30-second cap, the non-success status, the transport failure, the expired secret and all
  four fidelity outcomes are driven directly.
* **The routed command.** `main.handle_preflight` is driven through `run_invocation` with a
  faked service, asserting the two timeline steps, the terminal ordering that ends in
  `done`, and the outcome the app reads off that `done`.

The recorded-response integration fixtures are task 6.3 and are deliberately not here.

`main` reads its configuration at import (Req 14.12), so the two required variables are set
before that import — the same contract the container satisfies with its environment.
"""

from __future__ import annotations

import asyncio
import inspect
import os
import threading
import time
from collections.abc import AsyncIterator, Mapping
from datetime import timedelta
from typing import Any, ClassVar, Final

import pytest
from azure.core.credentials import AccessToken
from azure.core.exceptions import ClientAuthenticationError

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from reporting_agent import main  # imported after the environment above, deliberately
from reporting_agent.azure import preflight as preflight_module
from reporting_agent.azure.credential import InvocationCredential
from reporting_agent.azure.preflight import (
    ARM_ENDPOINT,
    FIDELITY_BASELINE,
    FIDELITY_ENHANCED,
    FIDELITY_PROBE_HOURS,
    LOGICAL_DISK_FREE_SPACE_QUERY,
    PERMISSIONS_API_VERSION,
    PERMISSIONS_TIMEOUT_S,
    RESOURCE_READ_ACTION,
    PreflightService,
    build_preflight_service,
    derive_scope_verified,
    entry_grants_read,
    matches_action,
    permissions_entries,
    permissions_url,
)
from reporting_agent.errors import (
    AuthExpiredError,
    AuthFailedError,
    ErrorCode,
    ScopeUnverifiedError,
)
from reporting_agent.main import (
    COMMAND_PREFLIGHT,
    STATUS_COMPLETED,
    STATUS_FAILED,
    TOOL_PREFLIGHT_FIDELITY,
    TOOL_PREFLIGHT_PERMISSIONS,
    Invocation,
    StepTracker,
    derive_session_id,
    emit,
    run_invocation,
)
from reporting_agent.redaction import discard_secrets

Event = dict[str, Any]

TENANT: Final[str] = "11111111-1111-1111-1111-111111111111"
CLIENT: Final[str] = "22222222-2222-2222-2222-222222222222"
SECRET: Final[str] = "Zq7~client.secret[with]regex*chars+and-length"
SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
WORKSPACE: Final[str] = "9c8b7a65-4321-4321-4321-0123456789ab"
ACTOR: Final[str] = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"

# A real-time watchdog. A healthy drain finishes in milliseconds, so this only fires when
# something stopped producing — and then it fails a test rather than hanging the suite.
WATCHDOG_S: Final[float] = 5.0

# Short enough that the cap is observable in a unit test; the declared 30 seconds is
# asserted separately, on the constant itself.
FAST_TIMEOUT_S: Final[float] = 0.05


@pytest.fixture(autouse=True)
def _clean_redaction_registry() -> Any:
    """The registry is a `ContextVar`; one test's secret must not scrub another's output."""
    discard_secrets()
    yield
    discard_secrets()


# --------------------------------------------------------------------------- #
# Stand-ins
# --------------------------------------------------------------------------- #


class FakeSdkCredential:
    """Stands in for `ClientSecretCredential`. Constructs nothing and calls nothing."""

    def __init__(self, *, tenant_id: str, client_id: str, client_secret: str) -> None:
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.error: BaseException | None = None
        self.calls: list[str] = []
        self.closed = False

    def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken:
        self.calls.append(scopes[0])
        if self.error is not None:
            raise self.error
        return AccessToken(f"token:{scopes[0]}", int(time.time()) + 3600)

    def close(self) -> None:
        self.closed = True


def credential_for(error: BaseException | None = None) -> InvocationCredential:
    """An `InvocationCredential` over the fake SDK credential above."""
    built: list[FakeSdkCredential] = []

    def factory(*, tenant_id: str, client_id: str, client_secret: str) -> FakeSdkCredential:
        fake = FakeSdkCredential(
            tenant_id=tenant_id, client_id=client_id, client_secret=client_secret
        )
        fake.error = error
        built.append(fake)
        return fake

    credential = InvocationCredential(
        tenant_id=TENANT,
        client_id=CLIENT,
        client_secret=SECRET,
        credential_factory=factory,
    )
    assert len(built) == 1
    return credential


class RecordingTransport:
    """A `PermissionsTransport` that records the request and returns a canned response."""

    def __init__(
        self,
        *,
        status: int = 200,
        body: object = None,
        error: BaseException | None = None,
        hang: bool = False,
    ) -> None:
        self.status = status
        self.body = body
        self.error = error
        self.hang = hang
        self.requests: list[dict[str, Any]] = []
        self.closed = False

    async def get_json(
        self, url: str, *, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, object]:
        self.requests.append({"url": url, "headers": dict(headers), "timeout": timeout})
        if self.hang:
            await asyncio.Event().wait()
        if self.error is not None:
            raise self.error
        return self.status, self.body

    async def aclose(self) -> None:
        self.closed = True


def reader_response(*, actions: tuple[str, ...] = ("*/read",), not_actions: tuple[str, ...] = ()) -> dict[str, Any]:
    """The ARM envelope a subscription-scope assignment returns."""
    return {
        "value": [
            {
                "actions": list(actions),
                "notActions": list(not_actions),
                "dataActions": [],
                "notDataActions": [],
            }
        ]
    }


def service_for(
    *,
    transport: RecordingTransport | None = None,
    credential: InvocationCredential | None = None,
    workspace_id: str | None = None,
    row_counter: Any = None,
    permissions_timeout_s: float = FAST_TIMEOUT_S,
    fidelity_timeout_s: float = FAST_TIMEOUT_S,
) -> PreflightService:
    return PreflightService(
        subscription_id=SUBSCRIPTION,
        credential=credential if credential is not None else credential_for(),
        transport=transport if transport is not None else RecordingTransport(body=reader_response()),
        workspace_id=workspace_id,
        row_counter=row_counter,
        permissions_timeout_s=permissions_timeout_s,
        fidelity_timeout_s=fidelity_timeout_s,
    )


def run(coro: Any) -> Any:
    return asyncio.run(asyncio.wait_for(coro, timeout=WATCHDOG_S))


def drain(stream: AsyncIterator[Event]) -> list[Event]:
    async def go() -> list[Event]:
        collected: list[Event] = []
        async for event in stream:
            collected.append(event)
        return collected

    return asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))


def types_of(events: list[Event]) -> list[str]:
    return [event["type"] for event in events]


def one(events: list[Event], kind: str) -> Event:
    matches = [event for event in events if event["type"] == kind]
    assert len(matches) == 1, f"expected exactly one {kind}, got {types_of(events)}"
    return matches[0]


# --------------------------------------------------------------------------- #
# The pure decision — Req 12.2, 12.3, 12.4
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "pattern",
    [
        "*",
        "*/read",
        "*/READ",
        "Microsoft.Resources/*",
        "Microsoft.Resources/subscriptions/*/read",
        "Microsoft.Resources/subscriptions/resources/read",
        "microsoft.resources/subscriptions/resources/read",
        "Microsoft.*/subscriptions/resources/read",
    ],
)
def test_a_pattern_that_covers_the_resource_read_action_matches(pattern: str) -> None:
    """Azure RBAC wildcards span separators, and action names are case-insensitive.

    `Reader` carries `*/read`; a comparison that treated `*` as one segment, or that was
    case-sensitive, would read a perfectly valid assignment as absent.
    """
    assert matches_action(pattern) is True


@pytest.mark.parametrize(
    "pattern",
    [
        "*/write",
        "Microsoft.Compute/*/read",
        "Microsoft.Resources/subscriptions/resourceGroups/read",
        "Microsoft.Resources/subscriptions/resources/write",
        "",
        None,
        7,
        ["*/read"],
    ],
)
def test_a_pattern_that_does_not_cover_the_read_action_does_not_match(
    pattern: object,
) -> None:
    """A non-string pattern matches nothing: a response carrying one is malformed, and a
    malformed response is not evidence of a permission."""
    assert matches_action(pattern) is False


def test_a_subscription_scope_reader_entry_verifies_the_scope() -> None:
    """Req 12.2 — the happy case, and the only shape that may produce `true`."""
    assert derive_scope_verified(reader_response()) is True


def test_an_explicit_read_action_verifies_the_scope() -> None:
    """A custom role naming the action outright is as good as `*/read`."""
    assert derive_scope_verified(reader_response(actions=(RESOURCE_READ_ACTION,))) is True


def test_any_one_entry_granting_the_read_is_enough() -> None:
    """Req 12.2 — "at least one entry". Several assignments at one scope are ordinary."""
    response = {
        "value": [
            {"actions": ["Microsoft.Compute/*/write"], "notActions": []},
            {"actions": ["*/read"], "notActions": []},
        ]
    }
    assert derive_scope_verified(response) is True


def test_a_not_actions_subtraction_leaves_the_scope_unverified() -> None:
    """Req 12.2 — the read must be left **undenied**.

    `notActions` is a subtraction, so reading only the `actions` half would call an
    assignment that grants `*/read` and takes it straight back a verified subscription
    scope.
    """
    assert derive_scope_verified(reader_response(not_actions=("*/read",))) is False
    assert (
        derive_scope_verified(reader_response(not_actions=(RESOURCE_READ_ACTION,))) is False
    )
    assert derive_scope_verified(reader_response(not_actions=("*",))) is False


def test_an_unrelated_not_actions_entry_does_not_deny_the_read() -> None:
    """A Reader-with-exclusions role is still a Reader for this action."""
    response = reader_response(
        not_actions=("Microsoft.Authorization/*/write", "*/secrets/read")
    )
    assert derive_scope_verified(response) is True


def test_an_empty_entry_list_leaves_the_scope_unverified() -> None:
    """Req 12.3 — and this is exactly what a resource-group-scoped Reader returns for the
    subscription scope, while its inventory query still succeeds and silently omits most
    of the estate."""
    assert derive_scope_verified({"value": []}) is False
    assert permissions_entries({"value": []}) == ()


@pytest.mark.parametrize(
    "response",
    [
        None,
        {},
        {"value": None},
        {"value": "nope"},
        {"value": {}},
        {"error": {"code": "AuthorizationFailed", "message": "no access"}},
        "",
        "not json at all",
        42,
        [],
        [None, 7, "x"],
        {"value": [{"actions": None, "notActions": None}]},
        {"value": [{"actions": "*/read"}]},
        {"value": [{"actions": [7, None]}]},
        {"value": [{}]},
        {"value": [{"dataActions": ["*/read"]}]},
    ],
)
def test_a_response_that_proves_nothing_leaves_the_scope_unverified(
    response: object,
) -> None:
    """Req 12.3 — anything that is not a proven read is `false`.

    A truncated body, an error envelope and a `dataActions`-only entry are all "we did not
    prove read at this scope", which is the only safe reading: the alternative ships a
    report that is 90% incomplete with nothing in the data to say so.
    """
    assert derive_scope_verified(response) is False


def test_a_bare_entry_list_is_accepted_as_well_as_the_arm_envelope() -> None:
    """The decision is about the entries, not about who unwrapped them."""
    assert derive_scope_verified([{"actions": ["*/read"], "notActions": []}]) is True
    assert entry_grants_read({"actions": ["*/read"], "notActions": []}) is True
    assert entry_grants_read("not an entry") is False


def test_the_decision_takes_the_permissions_response_and_nothing_else() -> None:
    """Req 12.4, asserted structurally.

    `scope_verified` is derived **solely** from the permissions response. That is enforced
    by the signature: there is no parameter an inventory result could arrive through, so
    there is no code path that could set this flag from a successful query.
    """
    parameters = list(inspect.signature(derive_scope_verified).parameters)
    assert parameters == ["response", "action"]


def test_no_inventory_client_is_reachable_from_the_preflight_module() -> None:
    """Req 12.4 again, as a boundary rather than a signature.

    A Resource Graph import in this module would be the first step towards deriving the
    flag from an inventory result, which is the failure this whole gate exists to prevent.
    """
    source = inspect.getsource(preflight_module)
    assert "resourcegraph" not in source.lower()
    assert "ResourceGraphClient" not in source


# --------------------------------------------------------------------------- #
# The permissions request — Req 12.1, 12.11
# --------------------------------------------------------------------------- #


def test_the_permissions_url_names_the_documented_operation() -> None:
    """Req 12.1 — the subscription-scope permissions operation, at a pinned api-version."""
    url = permissions_url(SUBSCRIPTION)
    assert url == (
        f"{ARM_ENDPOINT}/subscriptions/{SUBSCRIPTION}/providers/Microsoft.Authorization"
        f"/permissions?api-version={PERMISSIONS_API_VERSION}"
    )


def test_the_subscription_id_is_percent_encoded_into_the_path() -> None:
    """It arrives from a customer-entered wizard field. A value carrying a `/` or a `?`
    must not re-point the request at a different ARM operation."""
    url = permissions_url("../providers/Microsoft.Authorization/roleAssignments?x=1")
    assert "/subscriptions/..%2Fproviders" in url
    assert url.count("?") == 1
    assert url.endswith(f"api-version={PERMISSIONS_API_VERSION}")


def test_the_request_presents_the_principals_own_bearer_token() -> None:
    """Req 12.1, 12.11 — the agent holds the token; the web app makes no Azure call."""
    transport = RecordingTransport(body=reader_response())
    service = service_for(transport=transport)

    assert run(service.assert_subscription_read()) is True

    assert len(transport.requests) == 1
    request = transport.requests[0]
    assert request["url"] == permissions_url(SUBSCRIPTION)
    assert request["headers"]["Authorization"].startswith("Bearer token:")
    assert "management.azure.com" in request["headers"]["Authorization"]


# --------------------------------------------------------------------------- #
# The refusals — Req 12.3, 12.5, 12.12
# --------------------------------------------------------------------------- #


def test_an_unproven_scope_reports_scope_unverified_and_names_the_reason() -> None:
    """Req 12.3, 12.5 — and the message states why a resource-group assignment is refused,
    which is the copy the wizard shows (Req 12.7)."""
    service = service_for(transport=RecordingTransport(body={"value": []}))

    with pytest.raises(ScopeUnverifiedError) as raised:
        run(service.assert_subscription_read())

    assert raised.value.code is ErrorCode.SCOPE_UNVERIFIED
    assert raised.value.terminal is True
    assert "resource group" in raised.value.message.lower()


@pytest.mark.parametrize("status", [201, 204, 299])
def test_any_success_status_is_still_decided_from_the_response_body(status: int) -> None:
    """The status opens the door; the **body** decides. A 204 with no entries proves
    nothing, so it is `SCOPE_UNVERIFIED` rather than a pass."""
    verified = service_for(transport=RecordingTransport(status=status, body=reader_response()))
    assert run(verified.assert_subscription_read()) is True

    empty = service_for(transport=RecordingTransport(status=status, body=None))
    with pytest.raises(ScopeUnverifiedError):
        run(empty.assert_subscription_read())


@pytest.mark.parametrize("status", [400, 403, 404, 429, 500, 503])
def test_a_non_success_status_leaves_the_scope_unverified(status: int) -> None:
    """Req 12.12 — including the common, honest case: a 403, because the principal holds
    nothing at this scope to read permissions with."""
    service = service_for(
        transport=RecordingTransport(
            status=status,
            body={"error": {"code": "AuthorizationFailed", "message": "no access"}},
        )
    )

    with pytest.raises(ScopeUnverifiedError, match=str(status)):
        run(service.assert_subscription_read())


def test_a_transport_failure_leaves_the_scope_unverified() -> None:
    """Req 12.12 — "fails to complete". A DNS failure is not a permission."""
    service = service_for(transport=RecordingTransport(error=OSError("dns went away")))

    with pytest.raises(ScopeUnverifiedError, match="OSError"):
        run(service.assert_subscription_read())


def test_no_completion_within_the_cap_leaves_the_scope_unverified() -> None:
    """Req 12.12 — the 30-second cap, driven here at a fraction of it.

    The consultant is sitting in front of a wizard step, so an unanswered check is a
    refusal rather than an indefinite wait, and the refusal is `SCOPE_UNVERIFIED` because
    nothing was proven.
    """
    service = service_for(transport=RecordingTransport(hang=True))

    with pytest.raises(ScopeUnverifiedError, match="did not complete"):
        run(service.assert_subscription_read())


def test_the_declared_cap_is_thirty_seconds() -> None:
    """Req 12.12 — the number itself, since the test above runs at a fraction of it."""
    assert PERMISSIONS_TIMEOUT_S == 30.0
    assert PreflightService.__dataclass_fields__["permissions_timeout_s"].default == 30.0


# --------------------------------------------------------------------------- #
# Expiry versus rejection — Req 12.13, 19.6
# --------------------------------------------------------------------------- #


def test_an_expired_secret_reports_auth_expired_not_scope_unverified() -> None:
    """Req 12.13 — a distinct terminal code, because the fix is a rotation."""
    credential = credential_for(
        error=ClientAuthenticationError(
            "AADSTS7000222: The provided client secret keys for app ... are expired."
        )
    )
    service = service_for(credential=credential)

    with pytest.raises(AuthExpiredError) as raised:
        run(service.assert_subscription_read())

    assert raised.value.code is ErrorCode.AUTH_EXPIRED
    assert raised.value.terminal is True


def test_a_non_expiry_rejection_reports_auth_failed() -> None:
    """Req 19.6 — a wrong client id or secret is not an expiry, and rotating will not fix
    it. Reusing `classify_authentication_error` is what keeps the two apart here and
    mid-run."""
    credential = credential_for(
        error=ClientAuthenticationError("AADSTS7000215: Invalid client secret provided.")
    )
    service = service_for(credential=credential)

    with pytest.raises(AuthFailedError) as raised:
        run(service.assert_subscription_read())

    assert raised.value.code is ErrorCode.AUTH_FAILED


def test_a_401_naming_an_expired_secret_is_escalated_to_auth_expired() -> None:
    """Req 12.13 wherever the expiry becomes visible — including a token that was issued
    and then refused."""
    service = service_for(
        transport=RecordingTransport(
            status=401,
            body={
                "error": {
                    "code": "InvalidAuthenticationToken",
                    "message": "AADSTS7000222: the client secret is expired",
                }
            },
        )
    )

    with pytest.raises(AuthExpiredError):
        run(service.assert_subscription_read())


def test_a_401_that_names_no_expiry_stays_scope_unverified() -> None:
    """Only ever an escalation. Inventing `AUTH_FAILED` from a 401 ARM did not explain
    would send the consultant to rotate a secret that is fine, and Req 12.12 already has
    the right answer for a non-success status."""
    service = service_for(
        transport=RecordingTransport(
            status=401,
            body={"error": {"code": "InvalidAuthenticationToken", "message": "bad token"}},
        )
    )

    with pytest.raises(ScopeUnverifiedError):
        run(service.assert_subscription_read())


# --------------------------------------------------------------------------- #
# The fidelity probe — Req 12.8, 12.9, 12.10
# --------------------------------------------------------------------------- #


def test_a_workspace_answering_with_rows_records_enhanced() -> None:
    """Req 12.8 — at least one row in the trailing 24 hours."""
    asked: list[str] = []

    def counter(workspace_id: str) -> int:
        asked.append(workspace_id)
        return 1

    service = service_for(workspace_id=WORKSPACE, row_counter=counter)

    assert run(service.probe_fidelity()) == FIDELITY_ENHANCED
    assert asked == [WORKSPACE]


def test_no_workspace_id_records_baseline_without_probing() -> None:
    """Req 12.9 — there is nothing to probe, so nothing is probed."""
    called: list[str] = []

    def counter(workspace_id: str) -> int:  # pragma: no cover - must not be reached
        called.append(workspace_id)
        return 5

    for workspace in (None, "", "   "):
        service = service_for(workspace_id=workspace, row_counter=counter)
        assert run(service.probe_fidelity()) == FIDELITY_BASELINE

    assert called == []


@pytest.mark.parametrize(
    "outcome",
    [
        pytest.param(0, id="zero rows"),
        pytest.param(-1, id="a nonsense count"),
        pytest.param(None, id="no count at all"),
        pytest.param(True, id="a bool, which is not a row count"),
    ],
)
def test_a_probe_that_shows_no_rows_records_baseline(outcome: object) -> None:
    """Req 12.10 — zero rows means the counter is not being collected **now**, whatever the
    workspace was configured to do at some point."""
    service = service_for(workspace_id=WORKSPACE, row_counter=lambda _: outcome)
    assert run(service.probe_fidelity()) == FIDELITY_BASELINE


@pytest.mark.parametrize(
    "error",
    [
        RuntimeError("the workspace query was rejected"),
        PermissionError("no read on the workspace"),
        ValueError("no such workspace"),
    ],
)
def test_a_probe_that_fails_or_is_rejected_records_baseline(error: Exception) -> None:
    """Req 12.10 — and it must never fail the preflight: an unproven enhanced tier is a
    `baseline` report, not a refused connection whose Reader assignment is correct."""

    def counter(workspace_id: str) -> int:
        raise error

    service = service_for(workspace_id=WORKSPACE, row_counter=counter)
    assert run(service.probe_fidelity()) == FIDELITY_BASELINE


def test_a_probe_that_does_not_answer_records_baseline(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """A hung workspace query is a `baseline` tier, not a hung wizard step.

    The log line is asserted alongside the tier, because the tier alone cannot tell the
    timeout handler from the broad fallback beside it: every unhappy path records
    `baseline`, so "returned baseline" is equally true of a rejection. The message is the
    only place the difference survives — a hung workspace is *slow* and a rejected query
    is *misconfigured*, and a silent `baseline` gives the consultant nothing else to go
    on. So the rejection wording is asserted absent, not merely the timeout wording
    present.
    """

    def counter(workspace_id: str) -> int:
        time.sleep(FAST_TIMEOUT_S * 20)
        return 5

    service = service_for(workspace_id=WORKSPACE, row_counter=counter)

    with caplog.at_level("INFO", logger="reporting_agent.azure.preflight"):
        assert run(service.probe_fidelity()) == FIDELITY_BASELINE

    messages = [record.getMessage() for record in caplog.records]
    assert any("did not answer within" in message for message in messages), (
        f"the timeout handler logged nothing of its own: {messages!r}"
    )
    assert not any("failed or was rejected" in message for message in messages), (
        "the timeout was reported as a failure or rejection, so it reached the broad "
        f"fallback instead of the timeout handler: {messages!r}"
    )


def test_the_probe_asks_for_the_logical_disk_free_space_counter_in_the_last_day() -> None:
    """The counter and the window are the definition of the enhanced tier, so they are
    pinned rather than left to the call site: there is no platform metric for guest disk
    free space, which is why this query answering at all is the evidence."""
    assert FIDELITY_PROBE_HOURS == 24
    assert "LogicalDisk" in LOGICAL_DISK_FREE_SPACE_QUERY
    assert "% Free Space" in LOGICAL_DISK_FREE_SPACE_QUERY
    assert "limit 1" in LOGICAL_DISK_FREE_SPACE_QUERY


class FakeTable:
    def __init__(self, rows: int) -> None:
        self.rows = [["2026-07-01T00:00:00Z", "12.5"] for _ in range(rows)]


class FakeLogsResponse:
    def __init__(self, *, status: Any, rows: int) -> None:
        from azure.monitor.query import LogsQueryStatus

        self.status = status
        if status == LogsQueryStatus.PARTIAL:
            self.partial_data = [FakeTable(rows)]
            self.tables = []
        else:
            self.tables = [FakeTable(rows)]


class FakeLogsQueryClient:
    """Stands in for `LogsQueryClient`, recording what it was asked."""

    instances: ClassVar[list[FakeLogsQueryClient]] = []

    def __init__(self, *, credential: Any) -> None:
        self.credential = credential
        self.queries: list[dict[str, Any]] = []
        self.closed = False
        self.response: Any = None
        self.error: BaseException | None = None
        FakeLogsQueryClient.instances.append(self)

    def query_workspace(self, *, workspace_id: str, query: str, timespan: Any) -> Any:
        self.queries.append(
            {"workspace_id": workspace_id, "query": query, "timespan": timespan}
        )
        if self.error is not None:
            raise self.error
        return self.response

    def close(self) -> None:
        self.closed = True


@pytest.mark.parametrize(
    ("status_name", "rows", "expected"),
    [
        ("SUCCESS", 1, FIDELITY_ENHANCED),
        ("SUCCESS", 3, FIDELITY_ENHANCED),
        ("SUCCESS", 0, FIDELITY_BASELINE),
        # A partial result still answers the question: rows came back, so the counter is
        # being collected. Reading a partial success as zero would record `baseline` for a
        # workspace that demonstrably has the data.
        ("PARTIAL", 1, FIDELITY_ENHANCED),
        ("PARTIAL", 0, FIDELITY_BASELINE),
    ],
)
def test_the_default_row_counter_reads_the_workspace_response(
    status_name: str, rows: int, expected: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real `LogsQueryClient` call shape, with the client faked.

    `azure-monitor-query` at >=2.0.0 is logs-only, and this is the runtime's single use of
    it — the enhanced tier's guest-observed counter, which has no platform metric.
    """
    import azure.monitor.query as query_module
    from azure.monitor.query import LogsQueryStatus

    FakeLogsQueryClient.instances.clear()

    def build(*, credential: Any) -> FakeLogsQueryClient:
        client = FakeLogsQueryClient(credential=credential)
        client.response = FakeLogsResponse(
            status=getattr(LogsQueryStatus, status_name), rows=rows
        )
        return client

    monkeypatch.setattr(query_module, "LogsQueryClient", build)

    service = service_for(
        workspace_id=WORKSPACE,
        row_counter=preflight_module.logs_row_counter(credential_for()),
        fidelity_timeout_s=WATCHDOG_S,
    )

    assert run(service.probe_fidelity()) == expected

    client = FakeLogsQueryClient.instances[0]
    assert client.queries == [
        {
            "workspace_id": WORKSPACE,
            "query": LOGICAL_DISK_FREE_SPACE_QUERY,
            "timespan": timedelta(hours=FIDELITY_PROBE_HOURS),
        }
    ]
    # The client is closed whatever the response was, so a probe leaks no transport.
    assert client.closed is True


def test_the_default_row_counter_records_baseline_when_the_workspace_rejects(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 12.10 — a rejection is `baseline`, and it never fails the preflight."""
    import azure.monitor.query as query_module

    FakeLogsQueryClient.instances.clear()

    def build(*, credential: Any) -> FakeLogsQueryClient:
        client = FakeLogsQueryClient(credential=credential)
        client.error = PermissionError("no read on this workspace")
        return client

    monkeypatch.setattr(query_module, "LogsQueryClient", build)

    service = service_for(
        workspace_id=WORKSPACE,
        row_counter=preflight_module.logs_row_counter(credential_for()),
        fidelity_timeout_s=WATCHDOG_S,
    )

    assert run(service.probe_fidelity()) == FIDELITY_BASELINE
    assert FakeLogsQueryClient.instances[0].closed is True


def test_the_probe_runs_off_the_event_loop() -> None:
    """`LogsQueryClient` is synchronous, so the probe must not be called on the loop
    thread: a blocking query there stalls every heartbeat for its duration."""
    threads: list[str] = []

    def counter(workspace_id: str) -> int:
        threads.append(threading.current_thread().name)
        return 1

    async def scenario() -> str:
        service = service_for(workspace_id=WORKSPACE, row_counter=counter)
        loop_thread = threading.current_thread().name
        tier = await service.probe_fidelity()
        assert threads and threads[0] != loop_thread
        return tier

    assert run(scenario()) == FIDELITY_ENHANCED


# --------------------------------------------------------------------------- #
# Building the service from an invocation context
# --------------------------------------------------------------------------- #


def test_the_service_is_built_from_the_context_and_nothing_else() -> None:
    service = build_preflight_service(
        {
            "subscription_id": f"  {SUBSCRIPTION}  ",
            "tenant_id": TENANT,
            "client_id": CLIENT,
            "client_secret": SECRET,
            "log_analytics_workspace_id": f" {WORKSPACE} ",
        },
        transport=RecordingTransport(body=reader_response()),
    )

    assert service.subscription_id == SUBSCRIPTION
    assert service.workspace_id == WORKSPACE
    assert service.credential.tenant_id == TENANT
    run(service.aclose())


@pytest.mark.parametrize("workspace", [None, "", "   ", 7, {}])
def test_an_unusable_workspace_id_leaves_the_service_with_none(workspace: object) -> None:
    """Req 12.9 — absent, blank and non-string are one thing: nothing to probe."""
    service = build_preflight_service(
        {
            "subscription_id": SUBSCRIPTION,
            "tenant_id": TENANT,
            "client_id": CLIENT,
            "client_secret": SECRET,
            "log_analytics_workspace_id": workspace,
        },
        transport=RecordingTransport(),
    )
    assert service.workspace_id is None
    assert run(service.probe_fidelity()) == FIDELITY_BASELINE
    run(service.aclose())


@pytest.mark.parametrize("subscription", [None, "", "   ", 7])
def test_a_missing_subscription_id_reports_scope_unverified(subscription: object) -> None:
    """There is no scope to prove read at, so the connection cannot be accepted — and
    saying so is more useful than an internal error the consultant cannot act on."""
    with pytest.raises(ScopeUnverifiedError):
        build_preflight_service(
            {
                "subscription_id": subscription,
                "tenant_id": TENANT,
                "client_id": CLIENT,
                "client_secret": SECRET,
            }
        )


@pytest.mark.parametrize("field_name", ["tenant_id", "client_id", "client_secret"])
def test_a_missing_credential_field_reports_auth_failed_with_no_value_in_the_message(
    field_name: str,
) -> None:
    """Req 19.7 — the credential comes from the context and from nothing else, so a blank
    one is an authentication failure rather than something to fall back from."""
    context = {
        "subscription_id": SUBSCRIPTION,
        "tenant_id": TENANT,
        "client_id": CLIENT,
        "client_secret": SECRET,
    }
    context[field_name] = "  "

    with pytest.raises(AuthFailedError) as raised:
        build_preflight_service(context, transport=RecordingTransport())

    assert field_name in raised.value.message
    assert SECRET not in raised.value.message


def test_closing_the_service_closes_the_transport_and_the_credential() -> None:
    transport = RecordingTransport(body=reader_response())
    credential = credential_for()
    service = service_for(transport=transport, credential=credential)

    run(service.aclose())
    run(service.aclose())  # idempotent: teardown runs on every path

    assert transport.closed is True
    assert credential.credential.closed is True


# --------------------------------------------------------------------------- #
# The routed command — Req 14.3, and the event ordering it produces
# --------------------------------------------------------------------------- #


class FakePreflightService:
    """Stands in for `PreflightService` in the routed-command tests."""

    def __init__(
        self,
        *,
        verified: bool = True,
        tier: str = FIDELITY_ENHANCED,
        error: BaseException | None = None,
    ) -> None:
        self.verified = verified
        self.tier = tier
        self.error = error
        self.calls: list[str] = []
        self.closed = 0

    async def assert_subscription_read(self) -> bool:
        self.calls.append("permissions")
        if self.error is not None:
            raise self.error
        return self.verified

    async def probe_fidelity(self) -> str:
        self.calls.append("fidelity")
        return self.tier

    async def aclose(self) -> None:
        self.closed += 1


def route_preflight(
    service: FakePreflightService,
    monkeypatch: pytest.MonkeyPatch,
    *,
    context: Mapping[str, Any] | None = None,
) -> list[Event]:
    """Drive `main.handle_preflight` through the router with the service faked.

    The handler imports `build_preflight_service` at call time — so an invocation that is
    not a preflight never pays the Azure SDK import — which is what makes patching the
    module attribute enough.
    """
    monkeypatch.setattr(
        preflight_module, "build_preflight_service", lambda _context, **_: service
    )
    invocation = Invocation(
        command=COMMAND_PREFLIGHT,
        actor_id=ACTOR,
        session_id=derive_session_id(ACTOR),
        run_id=None,
        payload={"command": COMMAND_PREFLIGHT},
        context=dict(context or {"subscription_id": SUBSCRIPTION}),
        progress=None,
    )
    events = drain(run_invocation(invocation))
    # The outcome the app reads is on the terminal event, and it cleared the egress.
    for event in events:
        assert emit(event) == event, event
    return events


def test_the_preflight_command_is_routed_deterministically(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 14.3 — `preflight` is one of the two accepted commands, and there is no model
    in this module to route it through."""
    service = FakePreflightService()

    events = route_preflight(service, monkeypatch)

    assert types_of(events) == ["tool", "tool", "tool", "tool", "done"]
    assert [event["name"] for event in events if event["type"] == "tool"] == [
        TOOL_PREFLIGHT_PERMISSIONS,
        TOOL_PREFLIGHT_PERMISSIONS,
        TOOL_PREFLIGHT_FIDELITY,
        TOOL_PREFLIGHT_FIDELITY,
    ]
    assert [event["phase"] for event in events if event["type"] == "tool"] == [
        "start",
        "end",
        "start",
        "end",
    ]
    assert service.calls == ["permissions", "fidelity"]
    assert service.closed == 1


def test_a_passing_preflight_reports_its_outcome_on_the_terminal_event(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The result rides on `done`, inside the declared vocabulary.

    A preflight has no run row and no later callback, and the app consumes the short
    stream inline, so `scope_verified` and `fidelity_tier` travel on the one event every
    client already waits for rather than on an eleventh event type.
    """
    events = route_preflight(FakePreflightService(), monkeypatch)
    done = one(events, "done")

    assert done == {
        "type": "done",
        "run_id": None,
        "status": STATUS_COMPLETED,
        "scope_verified": True,
        "fidelity_tier": FIDELITY_ENHANCED,
    }


def test_a_baseline_probe_still_completes_the_preflight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 12.9, 12.10 — the tier is a fact about the report, not a gate on the
    connection."""
    events = route_preflight(
        FakePreflightService(tier=FIDELITY_BASELINE), monkeypatch
    )
    done = one(events, "done")

    assert done["status"] == STATUS_COMPLETED
    assert done["scope_verified"] is True
    assert done["fidelity_tier"] == FIDELITY_BASELINE
    assert "error" not in types_of(events)


def test_an_unverified_scope_ends_the_invocation_with_scope_unverified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 12.3, 12.5, 12.12 — a terminal `error`, then `done`, and no fidelity probe:
    the permissions assertion is a gate, so nothing runs behind it."""
    service = FakePreflightService(
        error=ScopeUnverifiedError("no subscription-scope read entry was returned")
    )

    events = route_preflight(service, monkeypatch)

    assert types_of(events) == ["tool", "error", "tool", "done"]
    error = one(events, "error")
    assert error["code"] == ErrorCode.SCOPE_UNVERIFIED.value
    assert error["terminal"] is True

    done = one(events, "done")
    assert done["status"] == STATUS_FAILED
    # The refusing answer to both questions, so a client reading only `done` is not left
    # guessing what a failed preflight decided.
    assert done["scope_verified"] is False
    assert done["fidelity_tier"] == FIDELITY_BASELINE

    assert service.calls == ["permissions"]
    assert TOOL_PREFLIGHT_FIDELITY not in [
        event.get("name") for event in events if event["type"] == "tool"
    ]
    assert service.closed == 1


def test_an_expired_secret_ends_the_invocation_with_auth_expired(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 12.13 — distinct from `SCOPE_UNVERIFIED`, because the fix is a rotation."""
    events = route_preflight(
        FakePreflightService(error=AuthExpiredError("Azure rejected the secret as expired")),
        monkeypatch,
    )

    assert one(events, "error")["code"] == ErrorCode.AUTH_EXPIRED.value
    assert one(events, "done")["status"] == STATUS_FAILED


def test_an_unexpected_failure_still_closes_the_step_and_reaches_done(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 14.10, 14.14 — a step left open by a raising phase is closed before `done`, and
    the outcome still says what a preflight that proved nothing means."""
    events = route_preflight(
        FakePreflightService(error=ZeroDivisionError("a bug nobody anticipated")), monkeypatch
    )

    assert types_of(events) == ["tool", "error", "tool", "done"]
    assert events[2]["phase"] == "end"
    assert events[2]["id"] == events[0]["id"]
    done = one(events, "done")
    assert done["status"] == STATUS_FAILED
    assert done["scope_verified"] is False


def test_the_preflight_steps_are_declared_step_names(
    caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The two names are part of the timeline contract, so opening them logs no
    "unrecognised step name" warning — the warning exists for a name the UI has never
    heard of, and these are not that."""
    caplog.set_level("WARNING")
    route_preflight(FakePreflightService(), monkeypatch)
    assert "not one of the declared step names" not in caplog.text
    assert TOOL_PREFLIGHT_PERMISSIONS in main.KNOWN_TOOL_NAMES
    assert TOOL_PREFLIGHT_FIDELITY in main.KNOWN_TOOL_NAMES


def test_the_routed_preflight_reaches_the_wire_through_the_entrypoint(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """End to end through `invoke`, its heartbeat merge and its single egress: the outcome
    on `done` survives the whole path, and nothing follows `done`."""
    monkeypatch.setattr(
        preflight_module,
        "build_preflight_service",
        lambda _context, **_: FakePreflightService(tier=FIDELITY_BASELINE),
    )
    body = {
        "command": COMMAND_PREFLIGHT,
        "context": {
            "actor_id": ACTOR,
            "subscription_id": SUBSCRIPTION,
            "tenant_id": TENANT,
            "client_id": CLIENT,
            "client_secret": SECRET,
        },
    }

    async def scenario() -> list[Event]:
        collected: list[Event] = []
        async for event in main.invoke(body):
            collected.append(event)
        return collected

    events = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert types_of(events)[-1] == "done"
    assert types_of(events).count("done") == 1
    done = events[-1]
    assert done["status"] == STATUS_COMPLETED
    assert done["scope_verified"] is True
    assert done["fidelity_tier"] == FIDELITY_BASELINE
    # No secret reached the wire on the way out (Req 15.8).
    assert SECRET not in repr(events)


def test_a_handler_seam_signature_is_unchanged_by_the_wiring() -> None:
    """The handler is still `(invocation, steps) -> AsyncIterator[Event]`, so task 11.9's
    seam and this one stay interchangeable from the router's side."""
    assert inspect.isasyncgenfunction(main.handle_preflight)
    assert list(inspect.signature(main.handle_preflight).parameters) == [
        "invocation",
        "steps",
    ]
    assert main.COMMAND_HANDLERS[COMMAND_PREFLIGHT] is main.handle_preflight


def test_the_step_tracker_is_the_only_source_of_the_preflights_tool_events(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 14.7, 14.8 — the handler asks the tracker for its events rather than building
    them, so the `id`/`name` pairing and the progress invariants cannot be bypassed."""
    events = route_preflight(FakePreflightService(), monkeypatch)
    tool_events = [event for event in events if event["type"] == "tool"]

    tracker = StepTracker()
    expected_first = tracker.start(
        TOOL_PREFLIGHT_PERMISSIONS,
        label="Permissions",
        status="Asserting read at subscription scope",
    )
    assert tool_events[0]["id"] == expected_first["id"]
    assert tool_events[1]["id"] == tool_events[0]["id"]
    assert tool_events[3]["id"] == tool_events[2]["id"]
    assert tool_events[2]["id"] != tool_events[0]["id"]
