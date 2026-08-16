"""Unit tests for `azure/credential.py` (Req 19.1, 19.2, 19.4, 19.5, 19.6, 19.7).

No Azure call is made and no tenant is needed: the credential factory is injected, and the
stand-in records every construction, every `get_token` call, and — the point of the
exercise — the **maximum number of acquisitions it ever had in flight at once**. That last
number is what Req 19.5 is about, so it is measured rather than assumed.

Where a test needs two things to be genuinely concurrent, it uses a `threading.Barrier`
rather than a sleep. A barrier that is never met raises, so "these two ran in parallel" and
"these two were serialized" are distinguishable without a timing threshold that turns a
loaded machine into a flaky suite.

The broader fixture-driven assertion — one collection over 2 resource types across 2
locations constructs the credential exactly once, **before** the first Azure client
(Req 19.3) — belongs to task 6.3, which owns the recorded-response fixtures. What is
provable here without them is that construction happens in `__init__` and that nothing
else in the module ever constructs a second one.
"""

from __future__ import annotations

import asyncio
import threading
import time
from typing import Any, Final

import pytest
from azure.core.credentials import AccessToken, TokenCredential
from azure.core.exceptions import ClientAuthenticationError

from reporting_agent.azure import credential as credential_module
from reporting_agent.azure.credential import (
    ARM_SCOPE,
    EXPIRED_SECRET_ERROR_CODES,
    LOGS_SCOPE,
    METRICS_DATA_PLANE_SCOPE,
    TOKEN_EXPIRY_MARGIN_SECONDS,
    InvocationCredential,
    ScopedCredential,
    classify_authentication_error,
)
from reporting_agent.errors import AuthExpiredError, AuthFailedError, ErrorCode
from reporting_agent.redaction import SECRET_PLACEHOLDER, discard_secrets, scrub

TENANT: Final[str] = "11111111-1111-1111-1111-111111111111"
CLIENT: Final[str] = "22222222-2222-2222-2222-222222222222"
SECRET: Final[str] = "Zq7~client.secret[with]regex*chars+and-length"

# A watchdog for every test that awaits something. A hang here means a lock was taken and
# not released, which without a timeout looks like a stalled suite rather than a bug.
WATCHDOG_S: Final[float] = 10.0


@pytest.fixture(autouse=True)
def clean_redaction_registry() -> Any:
    """The registry is a `ContextVar`; a secret registered by one test must not scrub the
    next test's ordinary output."""
    discard_secrets()
    yield
    discard_secrets()


# --------------------------------------------------------------------------- #
# Stand-ins
# --------------------------------------------------------------------------- #


class RecordingCredential:
    """Stands in for `ClientSecretCredential`, and watches its own concurrency.

    `max_in_flight` is the highest number of `get_token` calls that overlapped. Req 19.5
    is exactly the claim that this stays at 1 per audience, so it is the observable the
    serialization tests assert on.
    """

    def __init__(
        self,
        *,
        tenant_id: str,
        client_id: str,
        client_secret: str,
        error: BaseException | None = None,
        lifetime: int = 3600,
        hold: float = 0.0,
        barrier: threading.Barrier | None = None,
        clock: Any = time.time,
    ) -> None:
        self.tenant_id = tenant_id
        self.client_id = client_id
        self.client_secret = client_secret
        self.error = error
        self.lifetime = lifetime
        self.hold = hold
        self.barrier = barrier
        # `expires_on` must be stated on the same time base the credential's freshness
        # check uses, or a stubbed clock silently makes every token immortal.
        self.clock = clock

        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.max_in_flight = 0
        self.closed = False
        self._in_flight = 0
        self._guard = threading.Lock()

    def get_token(self, *scopes: str, **kwargs: Any) -> AccessToken:
        with self._guard:
            self._in_flight += 1
            self.max_in_flight = max(self.max_in_flight, self._in_flight)
            sequence = len(self.calls) + 1
            self.calls.append((scopes[0], dict(kwargs)))
        try:
            if self.barrier is not None:
                # Raises BrokenBarrierError if the other party never arrives, which is
                # what "these two acquisitions were serialized" looks like.
                self.barrier.wait(timeout=WATCHDOG_S / 2)
            if self.hold:
                time.sleep(self.hold)
            if self.error is not None:
                raise self.error
            return AccessToken(
                f"token:{scopes[0]}:{sequence}", int(self.clock()) + self.lifetime
            )
        finally:
            with self._guard:
                self._in_flight -= 1

    def close(self) -> None:
        self.closed = True


class FactorySpy:
    """Records every credential construction, so "exactly one" is countable."""

    def __init__(self, **credential_kwargs: Any) -> None:
        self.credential_kwargs = credential_kwargs
        self.built: list[RecordingCredential] = []
        self.calls: list[dict[str, Any]] = []

    def __call__(
        self, *, tenant_id: str, client_id: str, client_secret: str, **extra: Any
    ) -> RecordingCredential:
        self.calls.append(
            {
                "tenant_id": tenant_id,
                "client_id": client_id,
                "client_secret": client_secret,
                **extra,
            }
        )
        built = RecordingCredential(
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret,
            **self.credential_kwargs,
        )
        self.built.append(built)
        return built


class CredentialWithoutClose:
    """A credential holding no transport, so `close()` must tolerate its absence."""

    def __init__(self, **_: Any) -> None:
        self.calls: list[str] = []

    def get_token(self, *scopes: str, **_: Any) -> AccessToken:
        self.calls.append(scopes[0])
        return AccessToken("token", int(time.time()) + 3600)


def build(
    spy: FactorySpy | None = None,
    *,
    clock: Any | None = None,
    secret: str = SECRET,
) -> tuple[InvocationCredential, FactorySpy]:
    factory = spy if spy is not None else FactorySpy()
    kwargs: dict[str, Any] = {"credential_factory": factory}
    if clock is not None:
        kwargs["clock"] = clock
    return InvocationCredential(TENANT, CLIENT, secret, **kwargs), factory


def auth_error(message: str) -> ClientAuthenticationError:
    return ClientAuthenticationError(message=message)


# --------------------------------------------------------------------------- #
# Req 19.1 / 19.2 — one credential, two audiences
# --------------------------------------------------------------------------- #


def test_exactly_one_credential_is_constructed_per_invocation() -> None:
    """Req 19.1 — and it is constructed in `__init__`, before any client can exist."""
    cred, spy = build()
    assert len(spy.built) == 1

    async def scenario() -> None:
        for scope in (ARM_SCOPE, METRICS_DATA_PLANE_SCOPE, LOGS_SCOPE, ARM_SCOPE):
            cred.for_scope(scope)
            await cred.acquire_token(scope)

    asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert len(spy.built) == 1, "a second ClientSecretCredential was constructed"
    assert cred.credential is spy.built[0]


def test_the_same_instance_serves_management_and_the_metrics_data_plane() -> None:
    """Req 19.2 — two audiences, one credential, and one view per audience."""
    cred, spy = build()

    arm = cred.for_scope(ARM_SCOPE)
    metrics = cred.for_scope(METRICS_DATA_PLANE_SCOPE)

    assert isinstance(arm, ScopedCredential)
    assert isinstance(arm, TokenCredential), "the SDK's auth policy calls get_token"
    assert arm is cred.for_scope(ARM_SCOPE), "one memoized view per audience"
    assert arm is not metrics, "the two audiences are distinct views"

    arm_token = arm.get_token()
    metrics_token = metrics.get_token()

    assert arm_token.token != metrics_token.token, "one token per audience, not per object"
    assert [scope for scope, _ in spy.built[0].calls] == [
        ARM_SCOPE,
        METRICS_DATA_PLANE_SCOPE,
    ]
    assert len(spy.built) == 1


def test_for_scope_constructs_no_credential_and_no_client() -> None:
    cred, spy = build()
    before = len(spy.built)
    for _ in range(5):
        cred.for_scope(ARM_SCOPE)
        cred.for_scope(METRICS_DATA_PLANE_SCOPE)
    assert len(spy.built) == before
    assert spy.built[0].calls == [], "for_scope must acquire no token either"


def test_the_declared_audiences_are_the_ones_the_sdks_default_to() -> None:
    """The scope strings are facts about the SDKs, so they are pinned here.

    `azure-monitor-querymetrics` defaults `credential_scopes` to the metrics data-plane
    audience and `azure-monitor-query` to Log Analytics; ARM is the control plane the
    Resource Graph, compute and monitor management clients use.
    """
    assert ARM_SCOPE == "https://management.azure.com/.default"
    assert METRICS_DATA_PLANE_SCOPE == "https://metrics.monitor.azure.com/.default"
    assert LOGS_SCOPE == "https://api.loganalytics.io/.default"
    assert len({ARM_SCOPE, METRICS_DATA_PLANE_SCOPE, LOGS_SCOPE}) == 3


# --------------------------------------------------------------------------- #
# Req 19.4 — nothing survives an invocation
# --------------------------------------------------------------------------- #


def test_a_second_invocation_constructs_a_new_credential() -> None:
    """Req 19.4 — one customer's credential is never presented against another's tenant."""
    spy = FactorySpy()
    first, _ = build(spy)
    second = InvocationCredential(
        "99999999-9999-9999-9999-999999999999",
        CLIENT,
        "a-different-client-secret-value",
        credential_factory=spy,
    )

    assert len(spy.built) == 2
    assert first.credential is not second.credential
    assert first.for_scope(ARM_SCOPE) is not second.for_scope(ARM_SCOPE)
    assert spy.calls[0]["tenant_id"] != spy.calls[1]["tenant_id"]

    # Caches are per invocation too: a token acquired by the first is not served to the
    # second, which is the only reason the separate instances matter.
    first.for_scope(ARM_SCOPE).get_token()
    second.for_scope(ARM_SCOPE).get_token()
    assert first.acquisition_count == 1
    assert second.acquisition_count == 1


def test_the_module_holds_no_credential_at_module_scope() -> None:
    """Req 19.4 — a module global would outlive the invocation that built it."""
    offenders = [
        name
        for name, value in vars(credential_module).items()
        if isinstance(value, (InvocationCredential, ScopedCredential))
    ]
    assert not offenders, (
        "the credential is held on the invocation-scoped object, never in a module "
        f"global; found: {offenders}"
    )


# --------------------------------------------------------------------------- #
# Req 19.5 — at most one acquisition per audience at a time
# --------------------------------------------------------------------------- #


def test_eight_concurrent_requests_for_one_audience_collapse_to_one_acquisition() -> None:
    """Req 19.5 — the per-scope `asyncio.Lock`, measured.

    A burst of authentication requests is itself a throttling trigger, so eight
    concurrent metric requests must produce one token acquisition and seven cache hits.
    """
    cred, spy = build(FactorySpy(hold=0.05))

    async def scenario() -> list[AccessToken]:
        return list(
            await asyncio.gather(*(cred.acquire_token(ARM_SCOPE) for _ in range(8)))
        )

    tokens = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert len(tokens) == 8
    assert {token.token for token in tokens} == {tokens[0].token}, "one token, shared"
    assert cred.acquisition_count == 1
    assert len(spy.built[0].calls) == 1
    assert spy.built[0].max_in_flight == 1


def test_the_sync_entry_point_collapses_concurrent_worker_thread_acquisitions() -> None:
    """The SDK clients are synchronous, so this is the path that actually runs in a run.

    Eight `get_token` calls arriving on eight worker threads — which is what
    `asyncio.to_thread(client.some_call)` produces — must still collapse to one
    acquisition, even though none of those threads can await the `asyncio.Lock`.
    """
    cred, spy = build(FactorySpy(hold=0.05))
    scoped = cred.for_scope(METRICS_DATA_PLANE_SCOPE)

    async def scenario() -> list[AccessToken]:
        return list(
            await asyncio.gather(*(asyncio.to_thread(scoped.get_token) for _ in range(8)))
        )

    tokens = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert {token.token for token in tokens} == {tokens[0].token}
    assert cred.acquisition_count == 1
    assert spy.built[0].max_in_flight == 1


def test_two_audiences_do_not_queue_behind_each_other() -> None:
    """The lock is per scope, not global.

    Proven with a two-party barrier rather than a stopwatch: if an ARM acquisition and a
    data-plane acquisition were serialized by one lock, the first would wait for a partner
    that cannot arrive and the barrier would break.
    """
    barrier = threading.Barrier(2)
    cred, spy = build(FactorySpy(barrier=barrier))

    async def scenario() -> list[AccessToken]:
        return list(
            await asyncio.gather(
                cred.acquire_token(ARM_SCOPE),
                cred.acquire_token(METRICS_DATA_PLANE_SCOPE),
            )
        )

    tokens = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert len({token.token for token in tokens}) == 2
    assert cred.acquisition_count == 2
    assert spy.built[0].max_in_flight == 2, "the two audiences ran concurrently"
    assert not barrier.broken


def test_a_cached_token_is_reused_without_a_second_acquisition() -> None:
    cred, spy = build()

    async def scenario() -> tuple[AccessToken, AccessToken]:
        return await cred.acquire_token(ARM_SCOPE), await cred.acquire_token(ARM_SCOPE)

    first, second = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert first.token == second.token
    assert cred.acquisition_count == 1
    # And the sync path shares that cache rather than keeping its own.
    assert cred.for_scope(ARM_SCOPE).get_token().token == first.token
    assert cred.acquisition_count == 1
    assert len(spy.built[0].calls) == 1


def test_a_token_inside_the_expiry_margin_is_re_acquired() -> None:
    """A token that expires mid-request is a 401 halfway through a long collection."""
    now = 1_000_000.0
    clock = lambda: now  # noqa: E731 - a one-line stub clock
    lifetime = TOKEN_EXPIRY_MARGIN_SECONDS + 60
    cred, spy = build(FactorySpy(lifetime=lifetime, clock=clock), clock=clock)

    scoped = cred.for_scope(ARM_SCOPE)
    scoped.get_token()
    assert cred.acquisition_count == 1

    # Inside the margin, so the cached token is treated as stale.
    now += 120
    scoped.get_token()
    assert cred.acquisition_count == 2
    assert len(spy.built[0].calls) == 2
    assert len(spy.built) == 1, "a re-acquisition builds no second credential"


def test_the_sync_path_works_with_no_event_loop_at_all() -> None:
    """Constructed outside a loop, there is no loop to route a `get_token` back into."""
    cred, spy = build()
    scoped = cred.for_scope(ARM_SCOPE)

    first = scoped.get_token()
    second = scoped.get_token()

    assert first.token == second.token
    assert cred.acquisition_count == 1
    assert spy.built[0].max_in_flight == 1


def test_a_sync_get_token_on_the_loop_thread_does_not_deadlock() -> None:
    """Blocking on a coroutine submitted to the loop you are running on never returns.

    A synchronous SDK call made directly on the loop thread — rather than through
    `to_thread` — must therefore acquire in place. The watchdog is the assertion: this
    test hangs if that case routes back into the loop.
    """
    cred, _ = build()

    async def scenario() -> AccessToken:
        return cred.for_scope(ARM_SCOPE).get_token()

    token = asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))
    assert token.token.startswith("token:")
    assert cred.acquisition_count == 1


# --------------------------------------------------------------------------- #
# Req 19.6 — AUTH_EXPIRED and AUTH_FAILED are different facts
# --------------------------------------------------------------------------- #


EXPIRED_MESSAGES: Final[tuple[str, ...]] = (
    "AADSTS7000222: The provided client secret keys for app '22222222' are expired. "
    "Visit the Azure portal to create new keys for your app.",
    "aadsts7000222: the provided client secret keys are expired",
    # No AAD code, but the message states the fact.
    "Authentication failed: the client secret has expired.",
    "invalid_client: credential expired",
)

REJECTED_MESSAGES: Final[tuple[str, ...]] = (
    "AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the "
    "request is the client secret value.",
    "AADSTS700016: Application with identifier '22222222' was not found in the directory.",
    "AADSTS7000112: Application is disabled.",
    "AADSTS90002: Tenant '11111111' not found.",
    "unauthorized_client: the application is not authorized",
)


@pytest.mark.parametrize("message", EXPIRED_MESSAGES)
def test_an_expired_secret_classifies_as_auth_expired(message: str) -> None:
    error = classify_authentication_error(auth_error(message))
    assert isinstance(error, AuthExpiredError)
    assert error.code is ErrorCode.AUTH_EXPIRED
    assert error.terminal is True


@pytest.mark.parametrize("message", REJECTED_MESSAGES)
def test_every_other_authorization_rejection_classifies_as_auth_failed(
    message: str,
) -> None:
    """Req 19.6 — a rejected client id must be distinguishable from an expired secret,
    because the consultant's next action differs: correct a value, or rotate a secret."""
    error = classify_authentication_error(auth_error(message))
    assert isinstance(error, AuthFailedError)
    assert not isinstance(error, AuthExpiredError)
    assert error.code is ErrorCode.AUTH_FAILED
    assert error.terminal is True
    assert error.code is not ErrorCode.AUTH_EXPIRED


def test_the_two_codes_are_distinct_and_both_terminal() -> None:
    assert ErrorCode.AUTH_EXPIRED is not ErrorCode.AUTH_FAILED
    assert AuthExpiredError.code.value == "AUTH_EXPIRED"
    assert AuthFailedError.code.value == "AUTH_FAILED"
    assert EXPIRED_SECRET_ERROR_CODES == frozenset({"AADSTS7000222"})
    assert "AADSTS7000215" not in EXPIRED_SECRET_ERROR_CODES


def test_an_acquisition_rejection_raises_the_classified_error_from_the_async_path() -> None:
    spy = FactorySpy(error=auth_error(EXPIRED_MESSAGES[0]))
    cred, _ = build(spy)

    async def scenario() -> None:
        await cred.acquire_token(ARM_SCOPE)

    with pytest.raises(AuthExpiredError) as caught:
        asyncio.run(asyncio.wait_for(scenario(), timeout=WATCHDOG_S))

    assert caught.value.code is ErrorCode.AUTH_EXPIRED
    assert isinstance(caught.value.__cause__, ClientAuthenticationError)
    assert cred.acquisition_count == 1, "a rejection is counted, not hidden"


def test_an_acquisition_rejection_raises_the_classified_error_from_the_sync_path() -> None:
    spy = FactorySpy(error=auth_error(REJECTED_MESSAGES[0]))
    cred, _ = build(spy)

    with pytest.raises(AuthFailedError) as caught:
        cred.for_scope(METRICS_DATA_PLANE_SCOPE).get_token()

    assert caught.value.code is ErrorCode.AUTH_FAILED
    assert isinstance(caught.value.__cause__, ClientAuthenticationError)


def test_a_rejection_caches_nothing_and_stays_reportable() -> None:
    """A failed acquisition must not poison the cache with a token that does not exist."""
    spy = FactorySpy(error=auth_error(REJECTED_MESSAGES[1]))
    cred, _ = build(spy)
    scoped = cred.for_scope(ARM_SCOPE)

    for _ in range(2):
        with pytest.raises(AuthFailedError):
            scoped.get_token()

    assert cred.acquisition_count == 2


def test_a_non_authentication_error_propagates_unclassified() -> None:
    """A DNS failure is not an authorization decision, so it must not become AUTH_FAILED —
    `REGION_UNREACHABLE` is a different code with a different handling path."""
    spy = FactorySpy(error=RuntimeError("dns resolution failed"))
    cred, _ = build(spy)

    with pytest.raises(RuntimeError, match="dns resolution failed"):
        cred.for_scope(ARM_SCOPE).get_token()


# --------------------------------------------------------------------------- #
# Req 19.7 — the context and nothing else
# --------------------------------------------------------------------------- #


def test_the_credential_is_built_from_the_context_values_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Req 19.7 — an environment variable must not reach the credential.

    Every variable `EnvironmentCredential` reads is set to a *different* value here, so a
    value picked up from the environment would show up in the recorded construction.
    """
    ambient = {
        "AZURE_TENANT_ID": "ambient-tenant",
        "AZURE_CLIENT_ID": "ambient-client",
        "AZURE_CLIENT_SECRET": "ambient-secret",
        "AZURE_USERNAME": "ambient-user",
        "AZURE_PASSWORD": "ambient-password",
        "MSI_ENDPOINT": "http://169.254.169.254/metadata/identity",
        "IDENTITY_ENDPOINT": "http://169.254.169.254/metadata/identity",
    }
    for name, value in ambient.items():
        monkeypatch.setenv(name, value)

    cred, spy = build()

    assert spy.calls == [
        {"tenant_id": TENANT, "client_id": CLIENT, "client_secret": SECRET}
    ]
    assert cred.tenant_id == TENANT
    assert cred.client_id == CLIENT
    for value in ambient.values():
        assert value not in spy.calls[0].values()


def test_no_ambient_credential_source_is_reachable_from_this_module() -> None:
    """Req 19.7 — the ambient chain and every member of it that would silently
    authenticate as the container's own identity.

    `tests/test_boundaries.py` owns the tree-wide `ast` scan; this is the module-local
    assertion that the names are not bound here under any spelling.
    """
    forbidden = (
        "DefaultAzureCredential",
        "EnvironmentCredential",
        "ManagedIdentityCredential",
        "AzureCliCredential",
        "ChainedTokenCredential",
        "WorkloadIdentityCredential",
    )
    bound = vars(credential_module)
    for name in forbidden:
        assert name not in bound, f"{name} is bound in azure/credential.py"

    # `os` is not imported at all, so there is no route to `os.environ` here either.
    assert "os" not in bound
    assert "environ" not in bound


@pytest.mark.parametrize("field_name", ["tenant_id", "client_id", "client_secret"])
@pytest.mark.parametrize("value", ["", "   ", None, 12345])
def test_a_missing_context_value_fails_as_auth_failed_without_echoing_it(
    field_name: str, value: object
) -> None:
    """There is no fallback to fall back to, so an unusable context value is an
    authorization failure — reported as `AUTH_FAILED`, never as an internal error."""
    values: dict[str, Any] = {
        "tenant_id": TENANT,
        "client_id": CLIENT,
        "client_secret": SECRET,
    }
    values[field_name] = value
    spy = FactorySpy()

    with pytest.raises(AuthFailedError) as caught:
        InvocationCredential(
            values["tenant_id"],
            values["client_id"],
            values["client_secret"],
            credential_factory=spy,
        )

    assert field_name in str(caught.value)
    assert caught.value.code is ErrorCode.AUTH_FAILED
    assert str(value) not in str(caught.value) or value in ("", "   ")
    assert spy.built == [], "no credential is constructed from an unusable context"


# --------------------------------------------------------------------------- #
# Secret handling
# --------------------------------------------------------------------------- #


def test_constructing_the_credential_registers_the_secret_for_redaction() -> None:
    """Req 15.1 — the secret is registered, so any text quoting it is scrubbed on egress."""
    build()
    assert scrub(f"Azure said: {SECRET} was rejected") == (
        f"Azure said: {SECRET_PLACEHOLDER} was rejected"
    )


def test_a_rejection_message_carrying_the_secret_is_scrubbed() -> None:
    """Azure does not echo the secret, but the classifier must not depend on that."""
    spy = FactorySpy(error=auth_error(f"AADSTS7000215: secret {SECRET} is invalid"))
    cred, _ = build(spy)

    with pytest.raises(AuthFailedError) as caught:
        cred.for_scope(ARM_SCOPE).get_token()

    assert SECRET not in str(caught.value)
    assert SECRET_PLACEHOLDER in str(caught.value)


def test_the_credential_object_retains_no_plaintext_secret() -> None:
    cred, _ = build()
    held = [value for value in vars(cred).values() if isinstance(value, str)]
    assert SECRET not in held
    assert SECRET not in repr(cred)
    assert SECRET not in str(vars(cred).keys())


# --------------------------------------------------------------------------- #
# Odds and ends with teeth
# --------------------------------------------------------------------------- #


def test_a_claims_challenge_bypasses_the_cache() -> None:
    """Serving a cached token against a CAE claims challenge loops forever."""
    cred, spy = build()
    scoped = cred.for_scope(ARM_SCOPE)

    first = scoped.get_token()
    challenged = scoped.get_token(ARM_SCOPE, claims='{"access_token":{"nbf":{"essential":true}}}')

    assert first.token != challenged.token
    assert cred.acquisition_count == 2
    assert spy.built[0].calls[1][1]["claims"].startswith("{")
    # The challenge response is not cached in place of the ordinary token.
    assert scoped.get_token().token == first.token
    assert cred.acquisition_count == 2


def test_a_tenant_id_override_bypasses_the_cache() -> None:
    cred, spy = build()
    scoped = cred.for_scope(ARM_SCOPE)
    scoped.get_token()
    scoped.get_token(ARM_SCOPE, tenant_id="33333333-3333-3333-3333-333333333333")
    assert cred.acquisition_count == 2
    assert spy.built[0].calls[1][1]["tenant_id"].startswith("33333333")


def test_a_get_token_call_supplying_its_own_scope_is_honoured() -> None:
    """The SDK's auth policy passes the client's configured scope, not ours."""
    cred, spy = build()
    scoped = cred.for_scope(ARM_SCOPE)
    scoped.get_token(METRICS_DATA_PLANE_SCOPE)
    assert [scope for scope, _ in spy.built[0].calls] == [METRICS_DATA_PLANE_SCOPE]


@pytest.mark.parametrize("scope", ["", "   ", None, 7])
def test_an_unusable_scope_is_refused(scope: object) -> None:
    cred, _ = build()
    with pytest.raises(ValueError, match="non-empty string"):
        cred.for_scope(scope)  # type: ignore[arg-type]


def test_close_releases_the_underlying_transport_and_tolerates_its_absence() -> None:
    cred, spy = build()
    cred.close()
    assert spy.built[0].closed is True

    plain = InvocationCredential(
        TENANT, CLIENT, SECRET, credential_factory=CredentialWithoutClose
    )
    plain.close()  # no `close` on the credential is not an error


def test_repr_names_the_tenant_but_no_credential_value() -> None:
    cred, _ = build()
    text = repr(cred)
    assert TENANT in text
    assert SECRET not in text
    assert CLIENT not in text, "the client id is per-customer data, not log material"
