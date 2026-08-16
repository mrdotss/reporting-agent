"""ONE `ClientSecretCredential` per invocation, reused by every Azure client (Req 19.1).

The credential is built from the `tenant_id`, `client_id` and `client_secret` carried in
that invocation's `context` and from **nothing else** (Req 19.7). There is no environment
variable read here, no managed-identity probe, no CLI fallback and no
`DefaultAzureCredential` anywhere in this runtime — `tests/test_boundaries.py` fails the
suite if that name appears in any module. An ambient chain would silently authenticate as
the *container's own* identity against a customer's subscription, which is a cross-tenant
disclosure that looks, from every log line, like a working run.

Four properties are load-bearing.

**One instance, two audiences.** The same `ClientSecretCredential` serves
`management.azure.com` (ARM, Resource Graph, `azure-mgmt-monitor` metric definitions and
the per-resource fallback) and the regional metrics data plane (Req 19.2). They are
different token audiences from one credential, which is why the data-plane fallback to the
ARM control plane needs no new credential and no new scope. :func:`for_scope` hands out a
per-audience :class:`ScopedCredential` **view** over that single instance; it constructs
nothing.

**Nothing is held in a module global** (Req 19.4). The credential lives on this
invocation-scoped object, so a second invocation in the same process constructs a **new**
one and reuses nothing. A module-level cache keyed by tenant would be an easy performance
win and a catastrophic correctness bug: one customer's credential presented against
another customer's subscription. There is deliberately no instance of this class at module
scope, and a test asserts that.

**At most one token acquisition per audience at a time** (Req 19.5). Acquisition is
serialized by a **per-scope `asyncio.Lock`**, so eight concurrent metric requests collapse
to one acquisition rather than eight — which matters because a burst of authentication
requests is itself a throttling trigger. *Per scope*, not one global lock: an ARM
acquisition must not queue behind a data-plane one when their tokens are independent.

The lock is doubled by a per-scope `threading.Lock` inside :meth:`_acquire_blocking`, and
that is not belt-and-braces. Every Azure SDK client used here is **synchronous**, so its
auth policy calls :meth:`ScopedCredential.get_token` from whatever thread the request runs
on — an `asyncio.to_thread` worker, which cannot `await` an `asyncio.Lock`. The sync entry
point therefore routes back into the loop's lock when it can
(:meth:`InvocationCredential.acquire_token_sync`), and the threading lock is what keeps the
guarantee true when it cannot. One blocking primitive, reached by both paths, so the
"at most one in flight per audience" claim holds regardless of which door the caller came
through.

**An expired secret and a rejected one are different facts.** Azure answers both with a
`ClientAuthenticationError`, so :func:`classify_authentication_error` reads the AAD error
code out of the message: an expired secret raises `AuthExpiredError` (`AUTH_EXPIRED`,
rotate it) and every other authorization rejection raises `AuthFailedError`
(`AUTH_FAILED`, the client id or secret is wrong) — distinct codes, per Req 19.6, because
the consultant's next action differs. Every message that leaves here is passed through
:func:`~reporting_agent.redaction.scrub` first, and the plaintext secret is handed to the
SDK constructor and then **not retained as an attribute** of this object.
"""

from __future__ import annotations

import asyncio
import logging
import threading
import time
from collections.abc import Callable
from typing import Any, Final

from azure.core.credentials import AccessToken
from azure.core.exceptions import ClientAuthenticationError
from azure.identity import ClientSecretCredential

from reporting_agent.errors import AgentError, AuthExpiredError, AuthFailedError
from reporting_agent.redaction import register_secrets, scrub

__all__ = [
    "ARM_SCOPE",
    "EXPIRED_SECRET_ERROR_CODES",
    "LOGS_SCOPE",
    "METRICS_DATA_PLANE_SCOPE",
    "TOKEN_EXPIRY_MARGIN_SECONDS",
    "CredentialFactory",
    "InvocationCredential",
    "ScopedCredential",
    "classify_authentication_error",
]

logger = logging.getLogger(__name__)

# --- the audiences one credential serves (Req 19.2) ----------------------------------

ARM_SCOPE: Final[str] = "https://management.azure.com/.default"
"""ARM control plane: Resource Graph inventory, `resource_skus.list`,
`metric_definitions.list`, and `metrics.list` — the per-resource fallback for a location
with no metrics data-plane host. `management.azure.com` has no regional endpoint, which is
exactly why that fallback needs no new audience."""

METRICS_DATA_PLANE_SCOPE: Final[str] = "https://metrics.monitor.azure.com/.default"
"""Batch metric values through `MetricsClient.query_resources`. The *endpoint* is regional
(`https://<location>.metrics.monitor.azure.com`) but the *audience* is not, so one token
serves every location."""

LOGS_SCOPE: Final[str] = "https://api.loganalytics.io/.default"
"""Log Analytics, for the **enhanced** tier only — the logical-disk free-space counter that
has no platform metric. Declared here so the third audience is named in one place rather
than spelled out at its call site."""

TOKEN_EXPIRY_MARGIN_SECONDS: Final[int] = 300
"""Treat a token as stale this long before `expires_on`. A token that expires between the
freshness check and the response arriving is a 401 halfway through a twelve-minute
collection, so the margin is generous rather than tight."""

# --- expiry versus rejection (Req 19.6) ----------------------------------------------

EXPIRED_SECRET_ERROR_CODES: Final[frozenset[str]] = frozenset({"AADSTS7000222"})
"""AAD error codes that mean *the secret expired*, rather than *the secret is wrong*.

`AADSTS7000222` is "The provided client secret keys for app ... are expired". Deliberately
**not** here: `AADSTS7000215` (invalid client secret), `AADSTS700016` (application not
found), `AADSTS7000112` (application disabled), `AADSTS90002` (tenant not found). Each of
those is `AUTH_FAILED` — a value to correct, not a secret to rotate."""

_EXPIRY_PHRASES: Final[tuple[str, ...]] = ("client secret", "secret key", "credential")
"""A message may carry the fact without the code, so a phrase check backs the code check:
`expired` **and** one of these. Requiring both keeps `AADSTS7000215: Invalid client secret
provided` — which never says expired — classified as `AUTH_FAILED`."""

CredentialFactory = Callable[..., Any]
"""How the underlying credential is built. Defaults to `ClientSecretCredential` and is
injectable so a test can count constructions and simulate a rejection without a tenant."""


def classify_authentication_error(exc: BaseException) -> AgentError:
    """Map an authentication rejection to `AUTH_EXPIRED` or `AUTH_FAILED` (Req 19.6).

    Returns the exception **instance** to raise, rather than raising, so the call site
    keeps its `raise ... from exc` chain and the original traceback.

    The message is scrubbed before it is embedded: Azure does not echo the secret, but
    this text reaches an `error` event and a log line, and "the provider probably does not
    echo it" is not the standard the redaction guard holds elsewhere.
    """
    text = scrub(str(exc)) or ""
    upper = text.upper()

    expired = any(code in upper for code in EXPIRED_SECRET_ERROR_CODES) or (
        "EXPIRED" in upper and any(phrase in text.lower() for phrase in _EXPIRY_PHRASES)
    )

    if expired:
        return AuthExpiredError(
            "Azure rejected the client secret as expired; it must be rotated on the "
            f"subscription before this run can succeed. Azure said: {text}"
        )

    return AuthFailedError(
        "Azure rejected the client credentials for a reason other than expiry — the "
        "tenant id, client id or secret is wrong, or the application is disabled. This "
        f"is not an expiry and rotating the secret will not fix it. Azure said: {text}"
    )


class ScopedCredential:
    """A `TokenCredential` for **one** audience over the invocation's single credential.

    Satisfies the `azure.core.credentials.TokenCredential` protocol — a synchronous
    `get_token` — which is what the sync SDK clients' auth policy calls. It holds no
    credential of its own and constructs nothing; every call routes back to the one
    :class:`InvocationCredential` that made it, which is where the caching and the
    serialization live.

    `get_token_info` is deliberately **not** implemented. `azure-core`'s bearer policy
    prefers it when present, and implementing it would mean a second acquisition path to
    keep consistent with this one for no behavioural gain.
    """

    __slots__ = ("_owner", "scope")

    def __init__(self, owner: InvocationCredential, scope: str) -> None:
        self._owner = owner
        self.scope = scope

    def __repr__(self) -> str:
        return f"ScopedCredential(scope={self.scope!r})"

    def get_token(
        self,
        *scopes: str,
        claims: str | None = None,
        tenant_id: str | None = None,
        enable_cae: bool = False,
        **kwargs: Any,
    ) -> AccessToken:
        """Return a token for this audience, cached and serialized by the owner.

        A `claims` challenge or a `tenant_id` override asks for a token that is **not**
        the one being cached, so those bypass the cache and go straight to the underlying
        credential. Serving a cached token against a CAE claims challenge produces an
        authentication loop that retries forever and never says why.

        `enable_cae` on its own is **not** part of the cache key, and that is the right
        trade: the cache holds an ordinary token for the audience, which is valid either
        way, and treating the flag as a key would give every CAE-enabled client its own
        acquisition — dissolving the collapse Req 19.5 asks for. The case that actually
        matters is the challenge itself, and it is handled above.
        """
        requested = scopes[0] if scopes else self.scope

        if len(scopes) > 1:
            logger.debug(
                "a token was requested for %d scopes; using the first (%s). One audience "
                "per client is the contract here.",
                len(scopes),
                requested,
            )

        if claims is not None or tenant_id is not None:
            return self._owner.acquire_token_uncached(
                requested,
                claims=claims,
                tenant_id=tenant_id,
                enable_cae=enable_cae,
                **kwargs,
            )

        return self._owner.acquire_token_sync(requested)

    def close(self) -> None:
        """No-op. The invocation owns the credential's lifetime, not this view of it."""


class InvocationCredential:
    """The one credential for one invocation (Req 19.1, 19.2, 19.4, 19.5, 19.7).

    Construct it once, from the invocation `context`, and hand :meth:`for_scope` to every
    Azure client the run builds. The underlying `ClientSecretCredential` is constructed
    **eagerly, here**, so it exists before the first Azure client does (Req 19.3) — and so
    a malformed context fails at the top of the run rather than inside the first request.
    Construction performs no network call, so eagerness costs nothing.
    """

    def __init__(
        self,
        tenant_id: str,
        client_id: str,
        client_secret: str,
        *,
        credential_factory: CredentialFactory = ClientSecretCredential,
        clock: Callable[[], float] = time.time,
    ) -> None:
        self.tenant_id = _require_context_value("tenant_id", tenant_id)
        self.client_id = _require_context_value("client_id", client_id)
        secret = _require_context_value("client_secret", client_secret)

        # Req 15.1 — registered again here, idempotently. `main.parse_invocation` already
        # registered it, but a credential built by any other path (a test, a future
        # command) must not depend on that having happened for its error text to be safe.
        register_secrets((secret,))

        self._clock = clock
        self._tokens: dict[str, AccessToken] = {}
        self._scoped: dict[str, ScopedCredential] = {}
        self._async_locks: dict[str, asyncio.Lock] = {}
        self._thread_locks: dict[str, threading.Lock] = {}
        # Guards the three dicts above. The sync path runs on worker threads, so lazily
        # creating a lock is itself a race that would hand two threads two "the" locks.
        self._registry_lock = threading.Lock()
        self._acquisitions = 0

        # The loop the invocation runs on, so a sync `get_token` arriving on a worker
        # thread can route back into the per-scope asyncio lock. `None` when constructed
        # outside a loop, which is a legitimate synchronous use, not an error.
        try:
            self._loop: asyncio.AbstractEventLoop | None = asyncio.get_running_loop()
        except RuntimeError:
            self._loop = None

        # Exactly one construction, from the context values only (Req 19.1, 19.7). The
        # plaintext secret is passed and then dropped: it is not stored on `self`.
        self._credential: Any = credential_factory(
            tenant_id=self.tenant_id,
            client_id=self.client_id,
            client_secret=secret,
        )

    def __repr__(self) -> str:
        # No secret, and no client id either: it is a per-customer identifier the app
        # strips from every relayed event (Req 15.6), so a repr is no place for it.
        return (
            f"InvocationCredential(tenant_id={self.tenant_id!r}, "
            f"audiences={sorted(self._tokens)}, acquisitions={self._acquisitions})"
        )

    # --- what callers use ------------------------------------------------------------

    @property
    def credential(self) -> Any:
        """The single underlying `ClientSecretCredential`.

        Exposed for the assertion in Req 19.3 — that one collection constructs it exactly
        once — not as an invitation to hand it to a client directly. Use
        :meth:`for_scope`, which is what carries the serialization.
        """
        return self._credential

    @property
    def acquisition_count(self) -> int:
        """Token acquisitions attempted against the underlying credential.

        Counts attempts, not successes, so a rejected acquisition is visible. Cache hits
        do not count, which is what makes "eight concurrent requests, one acquisition"
        (Req 19.5) an observable fact rather than an intention.
        """
        return self._acquisitions

    def for_scope(self, scope: str) -> ScopedCredential:
        """The `TokenCredential` for `scope`, over the same underlying instance (Req 19.2).

        Constructs no credential. The view is memoized per scope, so one audience has one
        object and a client cannot be handed a second one that caches separately.
        """
        key = _require_scope(scope)
        with self._registry_lock:
            view = self._scoped.get(key)
            if view is None:
                view = ScopedCredential(self, key)
                self._scoped[key] = view
            return view

    async def acquire_token(self, scope: str) -> AccessToken:
        """Acquire (or reuse) a token for `scope`, serialized per audience (Req 19.5).

        The fast path checks the cache without taking the lock. Contenders then take the
        per-scope `asyncio.Lock` and re-check inside it, so a burst of concurrent callers
        for one audience produces **one** acquisition and N cache hits, and callers for a
        different audience do not queue behind them.
        """
        key = _require_scope(scope)

        cached = self._cached(key)
        if cached is not None:
            return cached

        async with self._async_lock_for(key):
            cached = self._cached(key)
            if cached is not None:
                return cached
            # The SDK credential is synchronous; acquiring it on the loop thread would
            # stall every other in-flight request for the length of a token request.
            return await asyncio.to_thread(self._acquire_blocking, key)

    def acquire_token_sync(self, scope: str) -> AccessToken:
        """Acquire (or reuse) a token from synchronous code — the SDK's entry point.

        Called by :meth:`ScopedCredential.get_token`, which the sync clients' auth policy
        invokes on whichever thread the request runs on. From a worker thread the call is
        routed back into the loop so it meets the same per-scope `asyncio.Lock` as the
        async path; when there is no loop to route through, or when this *is* the loop
        thread — where `run_coroutine_threadsafe(...).result()` would deadlock against
        itself — it falls through to the blocking path, which carries its own per-scope
        lock and the same cache.
        """
        key = _require_scope(scope)

        cached = self._cached(key)
        if cached is not None:
            return cached

        loop = self._loop
        if loop is not None and not loop.is_closed() and not _a_loop_runs_on_this_thread():
            pending = self.acquire_token(key)
            try:
                future = asyncio.run_coroutine_threadsafe(pending, loop)
            except RuntimeError:
                # The loop stopped between the check and the submission. Close the
                # coroutine and fall through rather than fail: the blocking path is
                # correct on its own.
                pending.close()
                logger.debug(
                    "the invocation loop was unavailable for a %s token acquisition; "
                    "acquiring on this thread instead.",
                    key,
                )
            else:
                # Waited on without a timeout deliberately. Every worker thread that can
                # reach this line was started by a `to_thread` the collection is awaiting,
                # so the loop outlives it; a bounded wait would only convert a hang that
                # cannot happen into a real failure carrying the wrong error code.
                return future.result()

        return self._acquire_blocking(key)

    def acquire_token_uncached(self, scope: str, **kwargs: Any) -> AccessToken:
        """Acquire a token that must **not** come from the cache.

        For a CAE `claims` challenge or a `tenant_id` override: the token requested is not
        the token being cached, so neither reading nor writing the cache is correct. Still
        serialized per audience, and still classified through
        :func:`classify_authentication_error`.
        """
        key = _require_scope(scope)
        clean = {name: value for name, value in kwargs.items() if value not in (None, False)}
        with self._thread_lock_for(key):
            return self._request_token(key, **clean)

    def close(self) -> None:
        """Release the underlying credential's transport, if it holds one.

        Called when the invocation ends. A credential built by a fake has no `close`, so
        the absence is not an error, and a failure to close is logged rather than raised —
        this runs on the teardown path, where raising would replace a real terminal error
        with a cleanup one.
        """
        closer = getattr(self._credential, "close", None)
        if not callable(closer):
            return
        try:
            closer()
        except Exception as exc:  # pragma: no cover - defensive teardown
            logger.debug("closing the Azure credential failed: %s", scrub(str(exc)))

    # --- internals -------------------------------------------------------------------

    def _cached(self, scope: str) -> AccessToken | None:
        """The cached token for `scope`, if it is still comfortably valid."""
        token = self._tokens.get(scope)
        if token is None:
            return None
        if token.expires_on - TOKEN_EXPIRY_MARGIN_SECONDS <= self._clock():
            return None
        return token

    def _async_lock_for(self, scope: str) -> asyncio.Lock:
        with self._registry_lock:
            lock = self._async_locks.get(scope)
            if lock is None:
                lock = asyncio.Lock()
                self._async_locks[scope] = lock
            return lock

    def _thread_lock_for(self, scope: str) -> threading.Lock:
        with self._registry_lock:
            lock = self._thread_locks.get(scope)
            if lock is None:
                lock = threading.Lock()
                self._thread_locks[scope] = lock
            return lock

    def _acquire_blocking(self, scope: str) -> AccessToken:
        """The one blocking acquisition, serialized per scope and cached.

        Both the async and the sync path end here, which is what makes "at most one
        acquisition per audience in flight" (Req 19.5) hold no matter which path a caller
        took. The cache is re-checked inside the lock so a caller that queued behind an
        acquisition reuses its result instead of issuing a second one.
        """
        with self._thread_lock_for(scope):
            cached = self._cached(scope)
            if cached is not None:
                return cached
            token = self._request_token(scope)
            self._tokens[scope] = token
            return token

    def _request_token(self, scope: str, **kwargs: Any) -> AccessToken:
        """Ask the underlying credential for a token, classifying a rejection (Req 19.6)."""
        # Under the registry lock: acquisitions for *different* audiences legitimately
        # overlap, so the counter is shared mutable state between threads. Taken while
        # holding a per-scope lock, and never the other way round, so the order is
        # consistent and cannot deadlock.
        with self._registry_lock:
            self._acquisitions += 1
        try:
            return self._credential.get_token(scope, **kwargs)
        except ClientAuthenticationError as exc:
            raise classify_authentication_error(exc) from exc


def _a_loop_runs_on_this_thread() -> bool:
    """True when the calling thread is already running an event loop.

    Used to refuse a cross-thread submission that would deadlock: blocking on
    `run_coroutine_threadsafe(...).result()` from the loop's own thread waits for a
    coroutine that cannot start until the waiting frame returns.
    """
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return False
    return True


def _require_context_value(field_name: str, value: object) -> str:
    """Require a non-blank string from the invocation `context`, naming only the field.

    Raises `AuthFailedError`, not `ValueError`: a run whose context carries no usable
    client id cannot authenticate, and Azure would answer the same rejection a round trip
    later. Reporting it as `AUTH_FAILED` (Req 19.6) tells the consultant the credentials
    are wrong; reporting it as an internal error would not.

    The value never enters the message — that is the whole point of taking the field name.
    """
    if not isinstance(value, str) or not value.strip():
        raise AuthFailedError(
            f"the invocation context carries no usable {field_name}. The Azure "
            f"credential is built from the context's tenant_id, client_id and "
            f"client_secret and from nothing else — there is no environment variable and "
            f"no ambient credential source to fall back to (Req 19.7). The offending "
            f"value is excluded from this message."
        )
    return value


def _require_scope(scope: object) -> str:
    if not isinstance(scope, str) or not scope.strip():
        raise ValueError(
            f"a token scope must be a non-empty string, got {scope!r}. The audiences this "
            f"runtime uses are declared as ARM_SCOPE, METRICS_DATA_PLANE_SCOPE and "
            f"LOGS_SCOPE."
        )
    return scope
