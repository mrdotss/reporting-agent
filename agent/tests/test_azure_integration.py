"""Fixture-driven integration for the credential and the preflight gate (task 6.3).

Req 12.2, 12.3, 12.12, 12.13, 19.1, 19.3, 19.4 and 19.6 — driven from **recorded Azure
responses on disk** rather than from stand-ins hand-built inside the test. No network, no
tenant, no token, no Azure SDK client: the credential factory, the permissions transport and
the fidelity row counter are the seams `azure/credential.py` and `azure/preflight.py` already
declare, and `tests/fixtures/` holds what Azure actually answered.

Two things are proven here that the unit suites deliberately left out.

**The credential is constructed once, and first (Req 19.3).** A collection over
`resource_graph_two_types_two_locations.json` — 2 resource types across 2 locations, so more
than one Azure client is genuinely required, because the batch metrics endpoint takes one
metric namespace per call and its data plane is regional — records every construction into
**one shared :class:`~fakes.azure_clients.ConstructionLog`**. "Before the first client" is
then a fact about a recorded sequence, not an inference from reading `__init__`. The same log
shows a second invocation in the same process building a *new* credential whose tokens are
textually distinct from the first's (Req 19.4).

**The preflight gate is driven end to end, through the router.** `main.handle_preflight`
builds a **real** `PreflightService` over a transport that replays a recorded permissions
response, so each recording is followed all the way to the terminal event the app reads:
a subscription-scope Reader entry completes with `scope_verified: true`; a
resource-group-only 403, an empty entry list, a Monitoring-Reader-only grant and a
`notActions` subtraction each end as terminal `SCOPE_UNVERIFIED`; an expired-secret
rejection ends as `AUTH_EXPIRED`; a wrong secret ends as `AUTH_FAILED`; and a permissions
call that never completes ends as `SCOPE_UNVERIFIED`.

The unit suites (`test_azure_credential.py`, `test_azure_preflight.py`) own the pure
decision, the per-scope locking and the argument-level edge cases. What is here is the wiring
between them and the recorded data.

`main` reads its configuration at import (Req 14.12), so the two required variables are set
before that import — the same contract the container satisfies with its environment.
"""

from __future__ import annotations

import asyncio
import functools
import json
import os
from collections.abc import AsyncIterator, Mapping
from dataclasses import dataclass, field
from typing import Any, Final

import pytest
from azure.core.exceptions import ClientAuthenticationError

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

from fakes.azure_clients import (  # tests/ is on sys.path, deliberately
    CLIENT,
    CREDENTIAL,
    ConstructionLog,
    RecordingAzureClient,
    RecordingCredentialFactory,
)
from fixtures import (
    FIXTURE_ROOT,
    RecordedResponse,
    available,
    fixture_path,
    load_response,
)
from reporting_agent.azure import preflight as preflight_module
from reporting_agent.azure.credential import (
    ARM_SCOPE,
    METRICS_DATA_PLANE_SCOPE,
    InvocationCredential,
)
from reporting_agent.azure.preflight import (
    FIDELITY_BASELINE,
    FIDELITY_ENHANCED,
    PERMISSIONS_API_VERSION,
    PERMISSIONS_TIMEOUT_S,
    derive_scope_verified,
    permissions_url,
)
from reporting_agent.errors import (
    AuthExpiredError,
    AuthFailedError,
    ErrorCode,
)
from reporting_agent.main import (
    COMMAND_PREFLIGHT,
    STATUS_COMPLETED,
    STATUS_FAILED,
    TOOL_PREFLIGHT_FIDELITY,
    TOOL_PREFLIGHT_PERMISSIONS,
    Invocation,
    derive_session_id,
    emit,
    run_invocation,
)
from reporting_agent.redaction import discard_secrets

Event = dict[str, Any]

TENANT: Final[str] = "11111111-1111-1111-1111-111111111111"
SECOND_TENANT: Final[str] = "44444444-4444-4444-4444-444444444444"
CLIENT_ID: Final[str] = "22222222-2222-2222-2222-222222222222"
SECRET: Final[str] = "Zq7~client.secret[with]regex*chars+and-length"
SECOND_SECRET: Final[str] = "a-different-tenants-client-secret-value"
SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
WORKSPACE: Final[str] = "9c8b7a65-4321-4321-4321-0123456789ab"
ACTOR: Final[str] = "usr_01HQZX8QW9K7YB4T2C3M5N6P7Q"

# A real-time watchdog. Every scenario here finishes in milliseconds, so this only fires
# when something stopped producing — and then it fails a test rather than hanging the suite.
WATCHDOG_S: Final[float] = 10.0

# The permissions cap, driven at a fraction of the declared 30 seconds so the non-completion
# case is observable in a unit-test runtime. The declared constant is asserted separately, on
# itself, so shortening this one here cannot quietly become shortening it in production.
FAST_TIMEOUT_S: Final[float] = 0.05

# The fidelity probe hops onto a worker thread, so its cap is generous enough that a loaded
# machine does not turn `enhanced` into `baseline`. It is not what any test here measures.
PROBE_TIMEOUT_S: Final[float] = 5.0

REQUEST: Final[str] = "request"
"""A permissions request recorded into the same log as the constructions, so "the credential
existed before the request went out" is orderable on the preflight path too."""

INVENTORY: Final[RecordedResponse] = load_response(
    "azure", "resource_graph_two_types_two_locations"
)

# recorded permissions response -> the `scope_verified` it must produce (Req 12.2, 12.3).
PERMISSIONS_CASES: Final[tuple[tuple[str, bool], ...]] = (
    ("permissions_subscription_reader", True),
    ("permissions_resource_group_only", False),
    ("permissions_empty", False),
    ("permissions_monitoring_reader_only", False),
    ("permissions_read_denied_by_not_actions", False),
)

REFUSING_PERMISSIONS: Final[tuple[str, ...]] = tuple(
    name for name, verified in PERMISSIONS_CASES if not verified
)


@pytest.fixture(autouse=True)
def _clean_redaction_registry() -> Any:
    """The registry is a `ContextVar`; one test's secret must not scrub another's output."""
    discard_secrets()
    yield
    discard_secrets()


# --------------------------------------------------------------------------- #
# The recorded inventory, and the collection that runs over it
# --------------------------------------------------------------------------- #


def inventory_rows() -> tuple[Mapping[str, Any], ...]:
    body = INVENTORY.body
    assert isinstance(body, dict), INVENTORY.name
    data = body["data"]
    assert isinstance(data, list) and data, INVENTORY.name
    return tuple(data)


def collection_groups() -> tuple[tuple[str, str], ...]:
    """`(location, resource_type)` groups, sorted — one Azure client each.

    The grouping key is the real one: the batch metrics endpoint takes a single metric
    namespace per call, which makes it one resource type per call, and the metrics data
    plane is regional, which makes `location` part of the key rather than an afterthought.
    """
    return tuple(
        sorted({(row["location"], row["type"]) for row in inventory_rows()})
    )


@dataclass(slots=True)
class Collected:
    """What one fake collection produced, for the Req 19.3 assertions."""

    credential: InvocationCredential
    factory: RecordingCredentialFactory
    log: ConstructionLog
    clients: list[RecordingAzureClient]
    tokens: list[str]


async def collect_over_fixture(
    log: ConstructionLog,
    *,
    factory: RecordingCredentialFactory | None = None,
    tenant_id: str = TENANT,
    client_secret: str = SECRET,
) -> Collected:
    """One collection over the recorded inventory, shaped like the real one.

    Build the invocation credential, then one ARM client for inventory and one regional
    metrics client per `(location, resource_type)` group, then issue every request
    concurrently on worker threads — which is how the synchronous Azure SDK clients run
    inside this runtime, and therefore the path a `get_token` actually arrives on.

    The credential is constructed **inside** the running loop on purpose: that is what the
    invocation does, and it is what lets a worker thread's `get_token` route back into the
    per-scope `asyncio.Lock`.
    """
    spy = factory if factory is not None else RecordingCredentialFactory(log=log)
    credential = InvocationCredential(
        tenant_id, CLIENT_ID, client_secret, credential_factory=spy
    )

    clients = [
        RecordingAzureClient(
            credential=credential.for_scope(ARM_SCOPE),
            scope=ARM_SCOPE,
            log=log,
            kind="resource_graph",
        )
    ]
    for location, resource_type in collection_groups():
        clients.append(
            RecordingAzureClient(
                credential=credential.for_scope(METRICS_DATA_PLANE_SCOPE),
                scope=METRICS_DATA_PLANE_SCOPE,
                log=log,
                kind="metrics",
                location=location,
                resource_type=resource_type,
            )
        )

    tokens = list(
        await asyncio.gather(*(asyncio.to_thread(client.request) for client in clients))
    )
    return Collected(
        credential=credential, factory=spy, log=log, clients=clients, tokens=tokens
    )


def run(coro: Any) -> Any:
    return asyncio.run(asyncio.wait_for(coro, timeout=WATCHDOG_S))


# --------------------------------------------------------------------------- #
# Req 19.3 — the fixture, and what one collection over it must do
# --------------------------------------------------------------------------- #


def test_the_fixture_holds_at_least_two_resource_types_across_at_least_two_locations() -> None:
    """Req 19.3 states the fixture's shape, so the shape is asserted rather than assumed.

    Without this, a later edit that narrowed the recording to one type in one location
    would leave the ordering test below passing while it stopped proving anything: one
    group needs one client, and "constructed before the first client" is trivially true
    when there is only ever one.
    """
    rows = inventory_rows()
    resource_types = {row["type"] for row in rows}
    locations = {row["location"] for row in rows}

    assert len(resource_types) >= 2, resource_types
    assert len(locations) >= 2, locations
    assert len(collection_groups()) >= 4, collection_groups()
    assert INVENTORY.ok and INVENTORY.status == 200
    # The projection Req 20.1 requires is present on every recorded row, so this fixture
    # stays usable when the real inventory collector lands.
    for row in rows:
        assert set(row) >= {
            "id",
            "name",
            "type",
            "location",
            "resourceGroup",
            "tags",
            "sku",
            "powerState",
        }, row


def test_one_collection_constructs_the_credential_once_and_before_the_first_client() -> None:
    """Req 19.1, 19.3 — counted and ordered from one shared construction log.

    The ordering is the load-bearing half: a credential built lazily on first use would
    still be "exactly one", and would still work, but it would mean an Azure client existed
    before the run had proven it could authenticate at all — so the first failure would
    surface from inside a request rather than at the top of the run.
    """
    log = ConstructionLog()
    collected = run(collect_over_fixture(log))

    assert log.count(CREDENTIAL) == 1, log
    assert log.count(CLIENT) == len(collection_groups()) + 1, log
    assert log.count(CLIENT) > 1, "the fixture must require more than one client"
    assert log.kinds()[0] == CREDENTIAL, log
    assert log.first_index(CREDENTIAL) < log.first_index(CLIENT), log
    assert log.kinds()[1:] == (CLIENT,) * log.count(CLIENT), log

    # And it is the same instance behind every client (Req 19.1), through the memoized
    # per-audience view rather than a second object with its own cache.
    assert collected.credential.credential is collected.factory.built[0]
    for client in collected.clients:
        assert client.credential is collected.credential.for_scope(client.scope)
    assert len(collected.factory.built) == 1


def test_the_whole_collection_authenticates_through_that_one_credential() -> None:
    """Req 19.1, 19.2 — two audiences, one credential, one acquisition each.

    Every client requested a token; the underlying credential saw two acquisitions, one per
    audience, not one per client. That is the difference Req 19.5 is about, observed over a
    collection rather than over a synthetic burst.
    """
    log = ConstructionLog()
    collected = run(collect_over_fixture(log))
    sdk = collected.factory.built[0]

    assert len(collected.tokens) == len(collected.clients)
    assert all(token.startswith("token:invocation-1:") for token in collected.tokens)
    assert set(sdk.scopes) == {ARM_SCOPE, METRICS_DATA_PLANE_SCOPE}
    assert len(sdk.scopes) == 2, f"one acquisition per audience, got {sdk.scopes}"
    assert collected.credential.acquisition_count == 2

    # The regional metrics clients share one data-plane token; the ARM client has its own.
    metrics_tokens = {
        client.tokens[0] for client in collected.clients if client.kind == "metrics"
    }
    assert len(metrics_tokens) == 1, metrics_tokens
    assert metrics_tokens.isdisjoint(
        {client.tokens[0] for client in collected.clients if client.kind == "resource_graph"}
    )


# --------------------------------------------------------------------------- #
# Req 19.4 — a second invocation in the same process
# --------------------------------------------------------------------------- #


def test_a_second_invocation_in_the_same_process_constructs_a_new_credential() -> None:
    """Req 19.4 — and shares no cached token with the first.

    Two collections, one process, one shared factory and one shared log. The second
    invocation's tokens are textually distinct from the first's, so "reuses no credential
    instance" is checked on values and not only on object identity — a module-level cache
    keyed by tenant would present one customer's credential against another's subscription
    and would pass an identity check on the object it handed back.
    """
    log = ConstructionLog()
    factory = RecordingCredentialFactory(log=log)

    first = run(collect_over_fixture(log, factory=factory))
    second = run(
        collect_over_fixture(
            log, factory=factory, tenant_id=SECOND_TENANT, client_secret=SECOND_SECRET
        )
    )

    assert log.count(CREDENTIAL) == 2, log
    assert len(factory.built) == 2
    assert first.credential.credential is not second.credential.credential
    assert first.credential.for_scope(ARM_SCOPE) is not second.credential.for_scope(ARM_SCOPE)
    assert factory.built[0].tenant_id == TENANT
    assert factory.built[1].tenant_id == SECOND_TENANT

    assert set(first.tokens).isdisjoint(set(second.tokens)), "a token crossed invocations"
    assert all(token.startswith("token:invocation-2:") for token in second.tokens)
    # The first invocation's credential acquired nothing on the second's behalf.
    assert first.credential.acquisition_count == 2
    assert second.credential.acquisition_count == 2

    # Each invocation's second credential construction happened before its own first
    # client, so the ordering guarantee holds per invocation rather than once per process.
    kinds = log.kinds()
    boundary = kinds.index(CREDENTIAL, 1)
    assert kinds[0] == CREDENTIAL
    assert kinds[boundary + 1] == CLIENT, kinds
    assert kinds[1:boundary] == (CLIENT,) * (boundary - 1), kinds


# --------------------------------------------------------------------------- #
# Req 19.6 — an authorization rejection during a collection
# --------------------------------------------------------------------------- #


def aad_rejection(fixture_name: str) -> ClientAuthenticationError:
    """The `ClientAuthenticationError` a recorded AAD refusal produces.

    `ClientSecretCredential` embeds the token endpoint's `error_description` into the
    exception it raises, so the recorded body is the input the classifier actually sees.
    """
    recorded = load_response("azure", fixture_name)
    body = recorded.body
    assert isinstance(body, dict), recorded.name
    description = body["error_description"]
    assert isinstance(description, str) and description, recorded.name
    return ClientAuthenticationError(message=description)


def test_a_recorded_expired_secret_fails_a_collection_as_auth_expired() -> None:
    """Req 19.6, 12.13 — the code says 'rotate it', from the recorded AAD refusal."""
    log = ConstructionLog()
    factory = RecordingCredentialFactory(
        log=log, error=aad_rejection("aad_expired_secret_rejection")
    )

    with pytest.raises(AuthExpiredError) as caught:
        run(collect_over_fixture(log, factory=factory))

    assert caught.value.code is ErrorCode.AUTH_EXPIRED
    assert caught.value.terminal is True
    assert "AADSTS7000222" in str(caught.value)
    assert SECRET not in str(caught.value)
    # The rejection is a fact about the credential, not a reason to build another one.
    assert log.count(CREDENTIAL) == 1, log


def test_a_recorded_wrong_secret_fails_a_collection_as_auth_failed() -> None:
    """Req 19.6 — a rejected secret value is a different fact from an expired one, because
    rotating a correct-but-mistyped secret fixes nothing."""
    log = ConstructionLog()
    factory = RecordingCredentialFactory(
        log=log, error=aad_rejection("aad_invalid_secret_rejection")
    )

    with pytest.raises(AuthFailedError) as caught:
        run(collect_over_fixture(log, factory=factory))

    assert caught.value.code is ErrorCode.AUTH_FAILED
    assert not isinstance(caught.value, AuthExpiredError)
    assert "AADSTS7000215" in str(caught.value)


# --------------------------------------------------------------------------- #
# The recorded permissions responses, through the pure decision
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(("fixture_name", "verified"), PERMISSIONS_CASES)
def test_each_recorded_permissions_response_derives_its_documented_answer(
    fixture_name: str, verified: bool
) -> None:
    """Req 12.2, 12.3 — the recording is the whole input to the decision.

    Ties every fixture in the set to the boolean it must produce, so a fixture edited to
    make some other test pass fails here first.
    """
    recorded = load_response("azure", fixture_name)
    assert derive_scope_verified(recorded.body) is verified, recorded.name


# --------------------------------------------------------------------------- #
# The routed preflight, over a transport replaying those recordings
# --------------------------------------------------------------------------- #


class FixtureTransport:
    """A `PermissionsTransport` replaying one recorded response.

    Records the request into the shared construction log, so the credential's construction
    and the request it authorizes are orderable against each other.
    """

    def __init__(
        self,
        recorded: RecordedResponse | None,
        log: ConstructionLog,
        *,
        hang: bool = False,
    ) -> None:
        self.recorded = recorded
        self.log = log
        self.hang = hang
        self.requests: list[dict[str, Any]] = []
        self.closed = False

    async def get_json(
        self, url: str, *, headers: Mapping[str, str], timeout: float
    ) -> tuple[int, object]:
        self.log.record(REQUEST, url)
        self.requests.append({"url": url, "headers": dict(headers), "timeout": timeout})
        if self.hang:
            # Req 12.12 — the call that never completes. The cap cancels this.
            await asyncio.Event().wait()
        assert self.recorded is not None, "a replaying transport needs a recording"
        return self.recorded.status, self.recorded.body

    async def aclose(self) -> None:
        self.closed = True


@dataclass(slots=True)
class Routed:
    """One routed preflight, and everything it touched."""

    events: list[Event]
    transport: FixtureTransport
    log: ConstructionLog
    factory: RecordingCredentialFactory
    probed: list[str] = field(default_factory=list)

    def types(self) -> list[str]:
        return [event["type"] for event in self.events]

    def one(self, kind: str) -> Event:
        matches = [event for event in self.events if event["type"] == kind]
        assert len(matches) == 1, f"expected exactly one {kind}, got {self.types()}"
        return matches[0]

    def tool_names(self) -> list[str]:
        return [event["name"] for event in self.events if event["type"] == "tool"]


def route_preflight(
    monkeypatch: pytest.MonkeyPatch,
    *,
    fixture_name: str | None = None,
    hang: bool = False,
    credential_error: BaseException | None = None,
    workspace_id: str | None = None,
    rows: int | None = None,
    permissions_timeout_s: float = FAST_TIMEOUT_S,
) -> Routed:
    """Drive the `preflight` command over a recorded response, through the real service.

    Only the two seams `azure/preflight.py` already declares are injected — the permissions
    transport and the fidelity row counter — plus the credential factory, so no token is
    ever requested from AAD. `build_preflight_service` itself, `PreflightService`,
    `InvocationCredential` and `main.handle_preflight` are the production code paths.

    `handle_preflight` imports `build_preflight_service` at call time, so that an invocation
    which is not a preflight never pays the Azure SDK import; patching the module attribute
    is therefore enough.
    """
    log = ConstructionLog()
    factory = RecordingCredentialFactory(log=log, error=credential_error)
    recorded = load_response("azure", fixture_name) if fixture_name else None
    transport = FixtureTransport(recorded, log, hang=hang)
    probed: list[str] = []

    def row_counter(workspace: str) -> int:
        probed.append(workspace)
        return rows if rows is not None else 0

    real_builder = preflight_module.build_preflight_service
    monkeypatch.setattr(
        preflight_module,
        "InvocationCredential",
        functools.partial(InvocationCredential, credential_factory=factory),
    )
    monkeypatch.setattr(
        preflight_module,
        "build_preflight_service",
        lambda context, **_: real_builder(
            context,
            transport=transport,
            row_counter=row_counter if workspace_id else None,
            permissions_timeout_s=permissions_timeout_s,
            fidelity_timeout_s=PROBE_TIMEOUT_S,
        ),
    )

    context: dict[str, Any] = {
        "actor_id": ACTOR,
        "subscription_id": SUBSCRIPTION,
        "tenant_id": TENANT,
        "client_id": CLIENT_ID,
        "client_secret": SECRET,
    }
    if workspace_id:
        context["log_analytics_workspace_id"] = workspace_id

    invocation = Invocation(
        command=COMMAND_PREFLIGHT,
        actor_id=ACTOR,
        session_id=derive_session_id(ACTOR),
        run_id=None,
        payload={"command": COMMAND_PREFLIGHT},
        context=context,
        progress=None,
    )
    events = drain(run_invocation(invocation))

    # Everything that left the runtime went through the one egress, the registered secret
    # survived into none of it, and no event carries a credential-bearing field.
    #
    # The **client secret** is the agent-side guarantee (Req 15.1, 15.5): it is registered
    # on construction and scrubbed out of every message. The client id is not scrubbed here
    # and must not be asserted absent — Azure quotes it in its own refusal text, and Req
    # 15.6 puts the removal of a *field named* `client_id` in the app's relay. What the
    # runtime owes is that no such field exists in the first place, which is what the
    # recursive check below asserts.
    assert SECRET not in json.dumps(events), "the client secret reached the event stream"
    for event in events:
        assert emit(event) == event, event
        assert_no_credential_fields(event)

    return Routed(
        events=events, transport=transport, log=log, factory=factory, probed=probed
    )


CREDENTIAL_FIELD_NAMES: Final[frozenset[str]] = frozenset(
    {"client_secret", "clientsecret", "tenant_id", "tenantid", "client_id", "clientid",
     "progress_token", "progresstoken"}
)
"""The field names Req 15.6 has the app strip from a relayed event, at every depth. The
runtime's own contribution is not emitting them: a field the app has to remove is a field
that existed for at least one hop."""


def assert_no_credential_fields(value: object, path: str = "") -> None:
    """No key anywhere in an event names a credential, compared case-insensitively."""
    if isinstance(value, Mapping):
        for key, item in value.items():
            where = f"{path}.{key}" if path else str(key)
            assert (
                str(key).lower().replace("-", "_") not in CREDENTIAL_FIELD_NAMES
            ), f"an event carries a credential-bearing field at {where}"
            assert_no_credential_fields(item, where)
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            assert_no_credential_fields(item, f"{path}[{index}]")


def drain(stream: AsyncIterator[Event]) -> list[Event]:
    async def go() -> list[Event]:
        collected: list[Event] = []
        async for event in stream:
            collected.append(event)
        return collected

    return run(go())


def test_a_recorded_subscription_scope_reader_completes_the_preflight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 12.2 — the one recording that may produce `true`, followed to `done`."""
    routed = route_preflight(monkeypatch, fixture_name="permissions_subscription_reader")
    done = routed.one("done")

    # Three questions: read at scope, the guest-counter tier, and how far back exported
    # platform metrics reach — the last of which bounds the wizard's Lookback control.
    assert routed.types() == ["tool"] * 6 + ["done"]
    assert done["status"] == STATUS_COMPLETED
    assert done["scope_verified"] is True
    assert done["fidelity_tier"] == FIDELITY_BASELINE, "no workspace id was supplied"
    assert "error" not in routed.types()

    # The documented operation, with the principal's own bearer token (Req 12.1).
    assert len(routed.transport.requests) == 1
    request = routed.transport.requests[0]
    assert request["url"] == permissions_url(SUBSCRIPTION)
    assert f"api-version={PERMISSIONS_API_VERSION}" in request["url"]
    assert request["headers"]["Authorization"] == f"Bearer token:invocation-1:{ARM_SCOPE}"

    # One credential, built before the request it authorized (Req 19.1, 19.3).
    assert routed.log.count(CREDENTIAL) == 1, routed.log
    assert routed.log.first_index(CREDENTIAL) < routed.log.first_index(REQUEST), routed.log
    assert routed.transport.closed is True
    assert routed.factory.built[0].closed is True


@pytest.mark.parametrize("fixture_name", REFUSING_PERMISSIONS)
def test_a_recorded_refusal_ends_the_preflight_as_scope_unverified(
    monkeypatch: pytest.MonkeyPatch, fixture_name: str
) -> None:
    """Req 12.3, 12.12 — every recording that proves nothing produces the same terminal
    code, and none of them reaches the fidelity probe.

    The permissions assertion is a gate. A resource-group-only assignment is the case that
    matters most: its inventory query would succeed, so the run would deliver a document
    missing most of the estate with nothing in the data to say so.
    """
    routed = route_preflight(monkeypatch, fixture_name=fixture_name)
    error = routed.one("error")
    done = routed.one("done")

    assert error["code"] == ErrorCode.SCOPE_UNVERIFIED.value
    assert error["terminal"] is True
    assert "subscription" in error["message"].lower()
    assert done["status"] == STATUS_FAILED
    assert done["scope_verified"] is False
    assert done["fidelity_tier"] == FIDELITY_BASELINE
    assert TOOL_PREFLIGHT_FIDELITY not in routed.tool_names(), "the gate let a step behind it"
    assert routed.tool_names() == [TOOL_PREFLIGHT_PERMISSIONS, TOOL_PREFLIGHT_PERMISSIONS]
    assert routed.probed == []


def test_a_recorded_expired_secret_rejection_ends_the_preflight_as_auth_expired(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 12.13 — distinct from `SCOPE_UNVERIFIED`, and no request is ever issued.

    The refusal happens at token acquisition, so the transport records nothing: there was
    never a token to present. The connection is rejected either way, but the consultant is
    told to rotate the secret rather than to fix a role assignment.
    """
    routed = route_preflight(
        monkeypatch, credential_error=aad_rejection("aad_expired_secret_rejection")
    )
    error = routed.one("error")

    assert error["code"] == ErrorCode.AUTH_EXPIRED.value
    assert error["code"] != ErrorCode.SCOPE_UNVERIFIED.value
    assert error["terminal"] is True
    assert routed.one("done")["status"] == STATUS_FAILED
    assert routed.one("done")["scope_verified"] is False
    assert routed.transport.requests == [], "a rejected credential presented a token"


def test_a_recorded_wrong_secret_rejection_ends_the_preflight_as_auth_failed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 19.6 — the third distinct code the gate can report."""
    routed = route_preflight(
        monkeypatch, credential_error=aad_rejection("aad_invalid_secret_rejection")
    )
    error = routed.one("error")

    assert error["code"] == ErrorCode.AUTH_FAILED.value
    assert error["code"] not in {
        ErrorCode.AUTH_EXPIRED.value,
        ErrorCode.SCOPE_UNVERIFIED.value,
    }
    assert routed.one("done")["status"] == STATUS_FAILED


def test_a_recorded_401_naming_an_expired_secret_ends_as_auth_expired(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 12.13 — the expiry is reported wherever it becomes visible, including in a
    response body rather than at acquisition."""
    routed = route_preflight(monkeypatch, fixture_name="permissions_401_expired_secret")
    error = routed.one("error")

    assert error["code"] == ErrorCode.AUTH_EXPIRED.value
    assert len(routed.transport.requests) == 1
    assert routed.one("done")["scope_verified"] is False


def test_a_permissions_call_that_never_completes_ends_as_scope_unverified(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 12.12 — no completion inside the cap leaves `scope_verified` false.

    Driven at a fraction of the declared 30 seconds so the case is observable in a unit-test
    runtime; the declared constant is asserted on itself below, so shortening the cap here
    cannot quietly become shortening it in production.
    """
    routed = route_preflight(monkeypatch, hang=True)
    error = routed.one("error")

    assert error["code"] == ErrorCode.SCOPE_UNVERIFIED.value
    assert error["terminal"] is True
    assert "second" in error["message"].lower()
    assert routed.one("done")["status"] == STATUS_FAILED
    assert routed.one("done")["scope_verified"] is False
    assert len(routed.transport.requests) == 1, "the request was issued and then abandoned"
    assert routed.probed == []


def test_the_declared_permissions_cap_is_thirty_seconds() -> None:
    """Req 12.12 states 30 seconds, so the constant is pinned rather than trusted."""
    assert PERMISSIONS_TIMEOUT_S == 30.0
    assert FAST_TIMEOUT_S < PERMISSIONS_TIMEOUT_S / 100, (
        "the driven cap must be a small fraction of the declared one, so a test that "
        "passes here says nothing about a shortened production cap"
    )


def test_a_recorded_workspace_answer_with_rows_records_enhanced(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 12.8 — rows for the logical-disk counter in the trailing window mean `enhanced`.

    The row count comes from the recorded Log Analytics answer, so the tier reported on
    `done` traces to data rather than to a boolean a test asserted into place.
    """
    logs = load_response("azure", "logs_logical_disk_free_space")
    body = logs.body
    assert isinstance(body, dict), logs.name
    recorded_rows = len(body["tables"][0]["rows"])
    assert recorded_rows >= 1, logs.name

    routed = route_preflight(
        monkeypatch,
        fixture_name="permissions_subscription_reader",
        workspace_id=WORKSPACE,
        rows=recorded_rows,
    )
    done = routed.one("done")

    assert done["status"] == STATUS_COMPLETED
    assert done["scope_verified"] is True
    assert done["fidelity_tier"] == FIDELITY_ENHANCED
    assert routed.probed == [WORKSPACE]
    # Six: permissions, the guest-counter tier, and how far back exported platform
    # metrics reach. The third shares the fidelity step name — both are workspace
    # questions, and the label on the event is what tells them apart on screen.
    assert routed.tool_names() == [
        TOOL_PREFLIGHT_PERMISSIONS,
        TOOL_PREFLIGHT_PERMISSIONS,
        *([TOOL_PREFLIGHT_FIDELITY] * 4),
    ]


# --------------------------------------------------------------------------- #
# The fixture convention itself — tasks 11.1–11.10 inherit it
# --------------------------------------------------------------------------- #


def test_every_recorded_azure_response_loads_and_explains_itself() -> None:
    """A fixture nobody can explain is a fixture the next person edits until it passes.

    Loading each recording is also what validates the envelope: `status`, `headers` and a
    non-empty `comment` are required, so a malformed addition fails here rather than inside
    whichever test replayed it.
    """
    names = available("azure")
    assert names, f"no recorded responses under {FIXTURE_ROOT / 'azure'}"

    for name in names:
        recorded = load_response("azure", name)
        assert recorded.name == f"azure/{name}.json"
        assert len(recorded.comment.split()) >= 10, recorded.name
        assert 100 <= recorded.status < 600, recorded.name


def test_the_loader_names_what_is_available_when_a_fixture_is_missing() -> None:
    with pytest.raises(FileNotFoundError) as caught:
        load_response("azure", "permissions_that_was_never_recorded")
    assert "permissions_subscription_reader" in str(caught.value)


def test_the_loader_refuses_a_path_that_leaves_the_fixture_root() -> None:
    """A test that can reach `../../src` through the fixture loader is reading the code it
    is meant to be checking."""
    with pytest.raises(ValueError, match="must stay under"):
        fixture_path("..", "..", "src", "reporting_agent", "main")
