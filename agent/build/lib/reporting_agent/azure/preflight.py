"""The preflight gate: prove read at **subscription** scope, then probe fidelity.

Two questions, answered in that order, and only the first one can fail a preflight.

**1. Is there read at subscription scope?** Asked of

    GET /subscriptions/{subscriptionId}/providers/Microsoft.Authorization/permissions

with the submitted service principal's **own** token (Req 12.1), and answered **solely**
from that response (Req 12.4). There is deliberately no inventory query anywhere in this
module, and there is no parameter through which an inventory result could reach the
decision, because **coverage checks cannot detect what RBAC hides**: a principal holding
Reader on one resource group returns that group's resources, every metric request against
them succeeds, every figure verifies, and the delivered document is 90% incomplete with
nothing in the data to say so. A successful inventory is therefore *evidence of nothing*
about scope, which is why the only input to :func:`derive_scope_verified` is the
permissions response.

`scope_verified` is `true` **only** when some entry's `actions` carry a pattern matching
the resource read action and that entry's `notActions` deny none of it (Req 12.2). An
empty entry list, a response that does not parse, a non-success status, a transport
failure, and no completion inside 30 seconds all leave it `false` and report
`SCOPE_UNVERIFIED` (Req 12.3, 12.12). A secret Azure rejects as expired is the one
distinct outcome: `AUTH_EXPIRED`, because the fix is a rotation rather than a role
assignment (Req 12.13).

**2. Which fidelity tier?** `enhanced` only when a supplied Log Analytics workspace
answers the logical-disk `% Free Space` query with **at least one row in the trailing 24
hours** (Req 12.8). An absent workspace id, a rejection, a failure and zero rows all
record `baseline` (Req 12.9, 12.10) — and none of them can fail the preflight. That
asymmetry is the point: the tier describes what the *report* will be able to say, so
"we could not prove the guest counters are flowing" is an honest `baseline`, not a reason
to refuse a connection whose Reader assignment is perfectly correct.

**The decision is pure and the I/O is injected.** :func:`derive_scope_verified` and
:func:`entry_grants_read` take plain data — the parsed response, nothing else — so every
permissions case in Req 12.2 and 12.3 is a unit test with no subscription, no token and
no socket. The two service methods wrap them in exactly the I/O they need, behind the
:class:`PermissionsTransport` and :class:`RowCounter` seams.

**Why a raw ARM request rather than an SDK client.** The subscription-scope permissions
operation has no method on `AuthorizationManagementClient` — the SDK exposes
`permissions.list_for_resource` and `list_for_resource_group`, neither of which is the
subscription scope this gate is about. So the request is issued directly, with a bearer
token from the invocation's single :class:`~reporting_agent.azure.credential.
InvocationCredential`, which is also what makes "the principal's own token" (Req 12.1)
literal: there is no ambient credential in this runtime to fall back to.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import timedelta
from typing import Any, Final, Protocol, runtime_checkable
from urllib.parse import quote

from reporting_agent.azure.credential import (
    ARM_SCOPE,
    LOGS_SCOPE,
    InvocationCredential,
    classify_authentication_error,
)
from reporting_agent.errors import AgentError, AuthExpiredError, ScopeUnverifiedError
from reporting_agent.redaction import scrub, scrub_exception

__all__ = [
    "ARM_ENDPOINT",
    "FIDELITY_BASELINE",
    "FIDELITY_ENHANCED",
    "FIDELITY_PROBE_HOURS",
    "FIDELITY_PROBE_TIMEOUT_S",
    "LOGICAL_DISK_FREE_SPACE_QUERY",
    "METRICS_HISTORY_QUERY",
    "METRICS_HISTORY_TIMEOUT_S",
    "PERMISSIONS_API_VERSION",
    "PERMISSIONS_TIMEOUT_S",
    "RESOURCE_READ_ACTION",
    "HttpxPermissionsTransport",
    "EarliestProbe",
    "PermissionsTransport",
    "PreflightService",
    "RowCounter",
    "build_preflight_service",
    "derive_scope_verified",
    "entry_grants_read",
    "logs_earliest_probe",
    "logs_row_counter",
    "matches_action",
    "permissions_entries",
    "permissions_url",
]

logger = logging.getLogger(__name__)

# --- the permissions request ---------------------------------------------------------

ARM_ENDPOINT: Final[str] = "https://management.azure.com"
"""The ARM control plane. It has no regional endpoint, so there is one host here and the
`ARM_SCOPE` token from the invocation credential is the only audience involved."""

PERMISSIONS_API_VERSION: Final[str] = "2022-04-01"
"""`Microsoft.Authorization` permissions list. Pinned rather than floated: the shape this
module reads — `value[].actions` / `value[].notActions` — is a property of the version."""

PERMISSIONS_TIMEOUT_S: Final[float] = 30.0
"""Req 12.12 — the whole assertion, token acquisition included, has 30 seconds. Past it
`scope_verified` stays `false` and the code is `SCOPE_UNVERIFIED`.

The cap covers the *assertion* rather than the HTTP request alone on purpose: a token
acquisition that hangs leaves the connection just as unproven as a request that does, and
the consultant is sitting in front of a wizard step either way."""

RESOURCE_READ_ACTION: Final[str] = "Microsoft.Resources/subscriptions/resources/read"
"""The read action a subscription-scope assignment has to grant.

This is the action that enumerating a subscription's resources requires, which is the
capability the whole report depends on — `Monitoring Reader` alone does not grant it, and
without inventory there is nothing to collect metrics *for*. `Reader` at subscription
scope carries `*/read`, which matches; an assignment that does not reach the subscription
returns no entry granting it at this scope."""

# --- the fidelity probe --------------------------------------------------------------

FIDELITY_BASELINE: Final[str] = "baseline"
FIDELITY_ENHANCED: Final[str] = "enhanced"

FIDELITY_PROBE_HOURS: Final[int] = 24
"""Req 12.8, 12.10 — the trailing window the probe looks in. A workspace that collected
the counter last month is not collecting it now, and a report is about now."""

FIDELITY_PROBE_TIMEOUT_S: Final[float] = 15.0
"""A probe that has not answered by here records `baseline`. Deliberately shorter than
`PERMISSIONS_TIMEOUT_S`: this question cannot fail the preflight, so making the consultant
wait 30 seconds to be told `baseline` buys nothing."""

LOGICAL_DISK_FREE_SPACE_QUERY: Final[str] = (
    'Perf | where ObjectName == "LogicalDisk" and CounterName == "% Free Space" | limit 1'
)
"""The enhanced-tier evidence, and the narrowest form of it.

There is **no platform metric for free space inside a VM** — it is a guest-observed
quantity that requires the Azure Monitor Agent, a Data Collection Rule and Log Analytics.
So this counter answering at all is what distinguishes `enhanced` from `baseline`.
`limit 1` because the question is *whether* rows exist, not how many: one row settles it,
and a probe that scans a month of a busy workspace to count what it will not use is a
cost with no answer attached."""

# --- how far back the workspace can answer -------------------------------------------

METRICS_HISTORY_QUERY: Final[str] = (
    "AzureMetrics | summarize earliest = min(TimeGenerated) | project earliest"
)
"""The oldest exported platform metric this workspace holds.

`AzureMetrics`, not `Perf`. They are two different things reached by two different
mechanisms: `Perf` holds guest counters put there by the Azure Monitor Agent under a Data
Collection Rule — which is what `LOGICAL_DISK_FREE_SPACE_QUERY` above probes for — while
`AzureMetrics` holds *platform* metrics routed by a diagnostic setting. A subscription can
have either, both or neither, and only the second one lengthens a trend.

`min(TimeGenerated)` measures what is **there**, which is the only honest answer. A
workspace can be configured and hold thirty days, because Log Analytics has its own
retention independent of the diagnostic setting that fills it; and a diagnostic setting
enabled last week produces a workspace that exists and answers for a week. Asking whether
export is configured would answer a different question than the one a lookback control
needs."""

METRICS_HISTORY_TIMEOUT_S: Final[float] = FIDELITY_PROBE_TIMEOUT_S
"""The same 15 seconds the fidelity probe gets, for the same reason: this question cannot
fail a preflight, so making a consultant wait longer to be told "live metrics only" buys
nothing. A workspace too large to answer in time records `None`, and the control then
offers the retention floor — which is what a subscription with no export offers anyway."""


class EarliestProbe(Protocol):
    """Returns the oldest `TimeGenerated` a workspace holds, as text, or `None`.

    Text rather than a `datetime` because it crosses a thread boundary from the Azure SDK
    and is written into a JSON event immediately after: parsing it here would be a
    conversion nobody reads, and a timezone this module would have to have an opinion
    about.
    """

    def __call__(self, workspace_id: str) -> str | None: ...


def logs_earliest_probe(credential: InvocationCredential) -> EarliestProbe:
    """An :class:`EarliestProbe` over `LogsQueryClient`, beside :func:`logs_row_counter`.

    **Synchronous**, because `LogsQueryClient` is; the caller runs it on a worker thread.
    """

    def earliest(workspace_id: str) -> str | None:
        from azure.monitor.query import LogsQueryClient, LogsQueryStatus

        client = LogsQueryClient(credential=credential.for_scope(LOGS_SCOPE))
        try:
            response = client.query_workspace(
                workspace_id=workspace_id,
                query=METRICS_HISTORY_QUERY,
                # `None` is the whole retention, which is the point: a bounded timespan
                # would answer "the oldest record inside the window I guessed", and the
                # guess is the thing being measured.
                timespan=None,
            )
        finally:
            closer = getattr(client, "close", None)
            if callable(closer):
                closer()

        status = getattr(response, "status", None)
        if status == LogsQueryStatus.PARTIAL:
            tables = getattr(response, "partial_data", None) or ()
        else:
            tables = getattr(response, "tables", None) or ()

        for table in tables:
            for row in getattr(table, "rows", ()) or ():
                if row and row[0] is not None:
                    return str(row[0])
        return None

    return earliest


# --- pattern matching ----------------------------------------------------------------

_WILDCARD: Final[str] = "*"

# Azure RBAC action patterns wildcard with `*`, and the wildcard spans separators:
# `*/read` matches `Microsoft.Compute/virtualMachines/read`, and
# `Microsoft.Authorization/*/read` matches `Microsoft.Authorization/roleAssignments/read`.
# So `*` becomes `.*` and every other character is escaped. Matching is case-insensitive,
# because ARM treats action names that way and a comparison that did not would read a
# perfectly valid assignment as absent.
_PATTERN_CACHE: dict[str, re.Pattern[str]] = {}


def _compiled(pattern: str) -> re.Pattern[str]:
    cached = _PATTERN_CACHE.get(pattern)
    if cached is None:
        body = ".*".join(re.escape(part) for part in pattern.split(_WILDCARD))
        cached = re.compile(f"^{body}$", re.IGNORECASE)
        _PATTERN_CACHE[pattern] = cached
    return cached


def matches_action(pattern: object, action: str = RESOURCE_READ_ACTION) -> bool:
    """Does an RBAC action `pattern` match `action`? **Pure.**

    A non-string pattern matches nothing. A permissions response carrying one is
    malformed, and a malformed response is not evidence of a permission.
    """
    if not isinstance(pattern, str) or not pattern:
        return False
    return _compiled(pattern).fullmatch(action) is not None


def _patterns(value: object) -> tuple[str, ...]:
    """The string patterns in an `actions` / `notActions` field.

    A missing or non-sequence field yields none, which is the right reading for both
    fields: absent `actions` grants nothing, and absent `notActions` denies nothing —
    `notActions: []` is what an ordinary Reader assignment actually carries.
    """
    if isinstance(value, str) or not isinstance(value, Sequence):
        return ()
    return tuple(item for item in value if isinstance(item, str))


# --- the pure decision (Req 12.2, 12.3, 12.4) ----------------------------------------


def permissions_entries(response: object) -> tuple[Mapping[str, Any], ...]:
    """The entries of a parsed permissions response. **Pure.**

    Accepts the ARM envelope (`{"value": [...]}`) and a bare list, and yields nothing for
    anything else — a `None`, an error envelope, a string, a truncated body. "Nothing"
    is the safe reading: no entry means no proven read, which means `false`.
    """
    if isinstance(response, Mapping):
        value = response.get("value")
    else:
        value = response

    if isinstance(value, str) or not isinstance(value, Sequence):
        return ()

    return tuple(entry for entry in value if isinstance(entry, Mapping))


def entry_grants_read(
    entry: object, action: str = RESOURCE_READ_ACTION
) -> bool:
    """Does one permissions entry grant `action` undenied? **Pure** (Req 12.2).

    Both halves are required: an `actions` pattern that matches, **and** no `notActions`
    pattern that matches the same action. A `notActions` entry is a subtraction, so an
    assignment carrying `*/read` alongside a `notActions` of `*/read` grants nothing, and
    reading only the `actions` half would call that a verified subscription scope.

    `dataActions` and `notDataActions` are ignored: they govern access to data *inside* a
    resource (blob contents, queue messages), not the ability to enumerate resources and
    read their configuration, which is what this gate is about.
    """
    if not isinstance(entry, Mapping):
        return False

    granted = any(matches_action(pattern, action) for pattern in _patterns(entry.get("actions")))
    if not granted:
        return False

    denied = any(
        matches_action(pattern, action) for pattern in _patterns(entry.get("notActions"))
    )
    return not denied


def derive_scope_verified(response: object, action: str = RESOURCE_READ_ACTION) -> bool:
    """`scope_verified`, derived **solely** from the permissions response (Req 12.4).

    **Pure**, and pure is the enforcement rather than a convenience: the function takes
    the parsed response and nothing else, so there is no parameter an inventory result
    could arrive through and no code path that could set this flag from a successful
    query. Preflight is the only writer of a `true` value (Req 12.14) and this is the only
    place it is computed.

    `true` when at least one entry grants the read action undenied (Req 12.2). `false`
    for every other shape, the empty entry list included (Req 12.3) — which is exactly
    what a resource-group-scoped Reader returns when asked about the subscription scope.
    """
    return any(entry_grants_read(entry, action) for entry in permissions_entries(response))


def permissions_url(subscription_id: str) -> str:
    """The permissions request target for one subscription (Req 12.1).

    The id is percent-encoded with no safe characters: it arrives from a customer-entered
    wizard field, and a value carrying a `/` or a `?` would otherwise re-point the request
    at a different ARM operation.
    """
    encoded = quote(subscription_id, safe="")
    return (
        f"{ARM_ENDPOINT}/subscriptions/{encoded}/providers/Microsoft.Authorization"
        f"/permissions?api-version={PERMISSIONS_API_VERSION}"
    )


# --- the injected I/O seams ----------------------------------------------------------


@runtime_checkable
class PermissionsTransport(Protocol):
    """The one HTTP operation this module performs, injected so it can be faked.

    Returns `(status_code, parsed_body)`. `parsed_body` is `None` when the body was not
    JSON, which the decision treats exactly as it treats an empty entry list: no proven
    read.
    """

    async def get_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> tuple[int, object]: ...


class HttpxPermissionsTransport:
    """`PermissionsTransport` over `httpx.AsyncClient`.

    The client is built on first use, so constructing a service opens no connection pool —
    the same reasoning as `progress.HttpxProgressTransport`, and it matters here because
    every invocation builds a service only if it is a preflight.
    """

    def __init__(self, client: Any | None = None) -> None:
        self._client = client

    async def get_json(
        self,
        url: str,
        *,
        headers: Mapping[str, str],
        timeout: float,
    ) -> tuple[int, object]:
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient()

        response = await self._client.get(url, headers=dict(headers), timeout=timeout)
        try:
            body: object = response.json()
        except Exception:  # a non-JSON body is data, not a defect
            body = None
        return int(response.status_code), body

    async def aclose(self) -> None:
        client = self._client
        self._client = None
        if client is not None and hasattr(client, "aclose"):
            await client.aclose()


RowCounter = Callable[[str], int]
"""Counts the rows a workspace returns for the logical-disk query. **Synchronous**,
because `LogsQueryClient` is, and run on a worker thread by the caller."""


def logs_row_counter(
    credential: InvocationCredential,
    *,
    query: str = LOGICAL_DISK_FREE_SPACE_QUERY,
    hours: int = FIDELITY_PROBE_HOURS,
) -> RowCounter:
    """A :data:`RowCounter` over `LogsQueryClient` — the enhanced tier's only use of
    `azure-monitor-query`, which at >=2.0.0 is a logs-only package.

    The client is constructed inside the returned callable, so an invocation with no
    workspace id never imports it. The credential is the invocation's single one, viewed
    for the Log Analytics audience, so this adds a token audience and not a credential.
    """

    def count_rows(workspace_id: str) -> int:
        from azure.monitor.query import LogsQueryClient, LogsQueryStatus

        client = LogsQueryClient(credential=credential.for_scope(LOGS_SCOPE))
        try:
            response = client.query_workspace(
                workspace_id=workspace_id,
                query=query,
                timespan=timedelta(hours=hours),
            )
        finally:
            closer = getattr(client, "close", None)
            if callable(closer):
                closer()

        # A partial result still answers the question: rows came back, so the counter is
        # being collected. Treating a partial success as zero would record `baseline` for
        # a workspace that demonstrably has the data.
        status = getattr(response, "status", None)
        if status == LogsQueryStatus.PARTIAL:
            tables = getattr(response, "partial_data", None) or ()
        else:
            tables = getattr(response, "tables", None) or ()

        return sum(len(getattr(table, "rows", ()) or ()) for table in tables)

    return count_rows


# --- the service ---------------------------------------------------------------------


@dataclass(slots=True)
class PreflightService:
    """One preflight, over one invocation's credential.

    Built by :func:`build_preflight_service` from the invocation `context`. Holds no
    module state and is not cached anywhere: a second preflight in the same process
    builds a second credential, so one customer's credential can never be presented
    against another customer's subscription.
    """

    subscription_id: str
    credential: InvocationCredential
    transport: PermissionsTransport
    workspace_id: str | None = None
    row_counter: RowCounter | None = None
    earliest_probe: EarliestProbe | None = None
    permissions_timeout_s: float = PERMISSIONS_TIMEOUT_S
    fidelity_timeout_s: float = FIDELITY_PROBE_TIMEOUT_S
    metrics_history_timeout_s: float = METRICS_HISTORY_TIMEOUT_S
    read_action: str = RESOURCE_READ_ACTION
    _closed: bool = field(default=False, repr=False)

    # --- question 1: is there read at subscription scope? ---------------------------

    async def assert_subscription_read(self) -> bool:
        """Return `True`, or raise `ScopeUnverifiedError` / `AuthExpiredError`.

        Never returns `False`: a `false` result rejects the connection, and the code that
        rejection carries — `SCOPE_UNVERIFIED` (Req 12.3, 12.5, 12.12) — is more useful
        raised with the reason attached than returned as a bare boolean the caller has to
        re-interpret. The one distinct outcome is an expired secret, which raises
        `AUTH_EXPIRED` instead (Req 12.13).
        """
        try:
            status, body = await asyncio.wait_for(
                self._request_permissions(), timeout=self.permissions_timeout_s
            )
        except TimeoutError as exc:
            # Req 12.12 — no completion within 30 seconds. `scope_verified` stays false.
            # Built-in `TimeoutError` subclasses `OSError`, so an `except OSError` added
            # above or beside this arm would catch every timeout first and route it to the
            # generic branch, replacing "did not complete" with "failed with OSError".
            raise ScopeUnverifiedError(
                f"The subscription-scope permissions check did not complete within "
                f"{self.permissions_timeout_s:.0f} seconds, so read at subscription scope "
                f"could not be proven and the connection was not accepted. Reader must be "
                f"assigned at the subscription's own scope."
            ) from exc
        except AgentError:
            # An already-classified fact about the credential — `AUTH_EXPIRED` for an
            # expired secret (Req 12.13), `AUTH_FAILED` for a rejection that is not an
            # expiry (Req 19.6). Both are distinct from `SCOPE_UNVERIFIED` because the
            # consultant's next action differs: rotate, correct, or fix a role assignment.
            raise
        except Exception as exc:  # Req 12.12: a failure leaves it false
            raise ScopeUnverifiedError(
                "The subscription-scope permissions check could not be completed, so read "
                "at subscription scope could not be proven and the connection was not "
                f"accepted. The attempt failed with {type(exc).__name__}."
            ) from exc

        if not 200 <= status < 300:
            # Req 12.12 — any non-success status leaves `scope_verified` false. A 403 here
            # is the honest, common case: the principal cannot read permissions at this
            # scope because it holds nothing at this scope.
            raise ScopeUnverifiedError(
                f"The permissions request for this subscription returned status {status}, "
                f"so read at subscription scope could not be proven and the connection "
                f"was not accepted. Reader must be assigned at the subscription's own "
                f"scope; an assignment on a single resource group is refused here because "
                f"its inventory query would still succeed and would silently omit most of "
                f"the estate."
            )

        entries = permissions_entries(body)
        if not derive_scope_verified(body, self.read_action):
            # Req 12.3 — including the empty entry list, which is precisely what a
            # resource-group-scoped assignment returns for the subscription scope.
            raise ScopeUnverifiedError(
                f"The permissions response for this subscription carries no entry granting "
                f"{self.read_action} at subscription scope ({len(entries)} "
                f"{'entry' if len(entries) == 1 else 'entries'} returned), so the "
                f"connection was not accepted. Reader assigned on a resource group returns "
                f"that group's resources and no subscription-scope read: the inventory "
                f"query would succeed and the report would be missing most of the estate "
                f"with nothing in the data to say so."
            )

        logger.info(
            "subscription-scope read asserted from %d permissions %s.",
            len(entries),
            "entry" if len(entries) == 1 else "entries",
        )
        return True

    async def _request_permissions(self) -> tuple[int, object]:
        """Acquire the principal's own ARM token and issue the permissions GET (Req 12.1).

        An expired or rejected secret surfaces here, already classified by
        `azure/credential.py` into `AUTH_EXPIRED` or `AUTH_FAILED`. A 401 whose body names
        an expired secret is escalated to `AUTH_EXPIRED` as well — the only case where a
        response status produces something other than `SCOPE_UNVERIFIED`, because Req
        12.13 asks for that distinction wherever the expiry becomes visible.
        """
        token = await self.credential.acquire_token(ARM_SCOPE)
        headers = {
            "Authorization": f"Bearer {token.token}",
            "Accept": "application/json",
        }
        status, body = await self.transport.get_json(
            permissions_url(self.subscription_id),
            headers=headers,
            timeout=self.permissions_timeout_s,
        )

        if status == 401:
            self._raise_if_secret_expired(body)

        return status, body

    def _raise_if_secret_expired(self, body: object) -> None:
        """Raise `AuthExpiredError` if a 401 body names an expired client secret.

        Only ever *escalates* to `AUTH_EXPIRED`. A 401 for any other reason stays a
        non-success status and therefore `SCOPE_UNVERIFIED` (Req 12.12): "we could not
        prove the scope" is true of it, and inventing `AUTH_FAILED` from a response ARM
        did not explain would send the consultant to rotate a secret that is fine.
        """
        text = scrub(_error_text(body)) or ""
        if not text:
            return
        classified = classify_authentication_error(Exception(text))
        if isinstance(classified, AuthExpiredError):
            raise classified

    # --- question 2: which fidelity tier? ------------------------------------------

    async def probe_fidelity(self) -> str:
        """`enhanced` or `baseline`. **Never raises** (Req 12.8, 12.9, 12.10).

        Every unhappy path — no workspace id, a rejection, an exception, a timeout, zero
        rows — records `baseline`, because an unproven enhanced tier is a `baseline`
        report rather than a refused connection. The tier then travels with every figure
        the report derives, and a `baseline` percentile is labelled as estimated wherever
        it appears.
        """
        workspace = (self.workspace_id or "").strip()
        if not workspace:
            # Req 12.9 — no workspace id was supplied, so there is nothing to probe.
            # Absent, empty and whitespace-only are one thing: a wizard field left alone.
            return FIDELITY_BASELINE

        counter = self.row_counter
        if counter is None:
            counter = logs_row_counter(self.credential)

        try:
            rows = await asyncio.wait_for(
                asyncio.to_thread(counter, workspace), timeout=self.fidelity_timeout_s
            )
        except TimeoutError:
            # Built-in `TimeoutError` subclasses `OSError`, so an `except OSError` added
            # above or beside this arm would swallow every timeout first. Both arms record
            # `baseline`, so nothing observable would change — the log line below is the
            # only place "slow" and "rejected" stay apart, and it would quietly go.
            logger.info(
                "the fidelity probe did not answer within %.0f seconds; recording %s.",
                self.fidelity_timeout_s,
                FIDELITY_BASELINE,
            )
            return FIDELITY_BASELINE
        except Exception as exc:  # Req 12.10: a failure records baseline
            logger.info(
                "the fidelity probe failed or was rejected; recording %s: %s",
                FIDELITY_BASELINE,
                scrub_exception(exc),
            )
            return FIDELITY_BASELINE

        if not isinstance(rows, int) or isinstance(rows, bool) or rows < 1:
            # Req 12.10 — zero rows in the trailing window means the counter is not being
            # collected now, whatever the workspace was configured to do at some point.
            return FIDELITY_BASELINE

        return FIDELITY_ENHANCED

    # --- question 3: how far back can this subscription answer? ----------------------

    async def probe_metrics_history(self) -> str | None:
        """The oldest exported platform metric this workspace holds, or `None`.

        **Never raises**, on the same reasoning as :meth:`probe_fidelity`: this question
        shapes a control, and a control that cannot be shown is not a reason to refuse a
        connection. Every unhappy path — no workspace, a rejection, a timeout, an empty
        table — answers `None`, which a caller reads as "live metrics only" and which is
        the true answer for a subscription with no export configured.

        ## Why the answer is a date and not a number of months

        A count goes stale the day after it is stored: the workspace gains another day
        every day, and a stored `7` silently understates the depth until somebody
        re-probes. The earliest record is a fixed fact, and depth is `now` minus it,
        computed wherever it is needed. A subscription that enables export today therefore
        offers a deeper lookback three months from now with nobody doing anything.

        The one thing that can invalidate it is retention being **shortened**, which the
        collection degrades over honestly rather than this probe pre-empting.
        """
        workspace = (self.workspace_id or "").strip()
        if not workspace:
            return None

        probe = self.earliest_probe
        if probe is None:
            probe = logs_earliest_probe(self.credential)

        try:
            earliest = await asyncio.wait_for(
                asyncio.to_thread(probe, workspace),
                timeout=self.metrics_history_timeout_s,
            )
        except TimeoutError:
            # A workspace too large to answer `min(TimeGenerated)` in time. Recorded as
            # unknown rather than retried: the control degrades to the retention floor,
            # which is what a subscription with no export offers anyway.
            logger.info(
                "the metrics-history probe did not answer within %.0f seconds; "
                "recording no exported history.",
                self.metrics_history_timeout_s,
            )
            return None
        except Exception as exc:
            logger.info(
                "the metrics-history probe failed or was rejected; recording no "
                "exported history: %s",
                scrub_exception(exc),
            )
            return None

        if not isinstance(earliest, str) or not earliest.strip():
            # An empty `AzureMetrics` answers one row holding null: the table exists and
            # nothing has been routed into it, which is no exported history.
            return None
        return earliest.strip()

    # --- teardown -------------------------------------------------------------------

    async def aclose(self) -> None:
        """Release the credential and the transport. Never raises.

        Runs on the invocation's teardown path, where raising would replace a real
        terminal error with a cleanup one.
        """
        if self._closed:
            return
        self._closed = True

        closer = getattr(self.transport, "aclose", None)
        if callable(closer):
            try:
                await closer()
            except Exception as exc:  # defensive teardown
                logger.debug("closing the permissions transport failed: %s", scrub(str(exc)))

        self.credential.close()


def _error_text(body: object) -> str:
    """The message out of an ARM error envelope, or the body rendered as text.

    ARM answers a rejection with `{"error": {"code": ..., "message": ...}}`, and the AAD
    error code the expiry classification reads lives in that message.
    """
    if isinstance(body, Mapping):
        error = body.get("error")
        if isinstance(error, Mapping):
            parts = [
                str(error.get(key))
                for key in ("code", "message")
                if isinstance(error.get(key), str)
            ]
            if parts:
                return " ".join(parts)
    if body is None:
        return ""
    return str(body)


def build_preflight_service(
    context: Mapping[str, Any],
    *,
    transport: PermissionsTransport | None = None,
    row_counter: RowCounter | None = None,
    permissions_timeout_s: float = PERMISSIONS_TIMEOUT_S,
    fidelity_timeout_s: float = FIDELITY_PROBE_TIMEOUT_S,
) -> PreflightService:
    """Build a :class:`PreflightService` from one invocation's `context`.

    The credential is constructed here, from the context's `tenant_id`, `client_id` and
    `client_secret` and from nothing else (Req 19.7) — a missing or blank one raises
    `AuthFailedError` before any request is made.

    A missing `subscription_id` raises `ScopeUnverifiedError`: there is no scope to prove
    read at, so the connection cannot be accepted, and reporting that as an internal error
    would tell the consultant nothing about what to fix.
    """
    subscription_id = context.get("subscription_id")
    if not isinstance(subscription_id, str) or not subscription_id.strip():
        raise ScopeUnverifiedError(
            "The invocation carries no subscription id, so there is no scope to assert "
            "read at and the connection was not accepted. The preflight proves Reader at "
            "the subscription's own scope, which requires knowing that subscription."
        )

    credential = InvocationCredential(
        tenant_id=context.get("tenant_id"),  # type: ignore[arg-type]
        client_id=context.get("client_id"),  # type: ignore[arg-type]
        client_secret=context.get("client_secret"),  # type: ignore[arg-type]
    )

    workspace = context.get("log_analytics_workspace_id")
    workspace_id = workspace.strip() if isinstance(workspace, str) and workspace.strip() else None

    return PreflightService(
        subscription_id=subscription_id.strip(),
        credential=credential,
        transport=transport if transport is not None else HttpxPermissionsTransport(),
        workspace_id=workspace_id,
        row_counter=row_counter,
        permissions_timeout_s=permissions_timeout_s,
        fidelity_timeout_s=fidelity_timeout_s,
    )


# Contradictions worth catching at import rather than at the first preflight.
assert PERMISSIONS_TIMEOUT_S == 30.0, PERMISSIONS_TIMEOUT_S  # Req 12.12
assert FIDELITY_PROBE_HOURS == 24, FIDELITY_PROBE_HOURS  # Req 12.8
assert FIDELITY_BASELINE != FIDELITY_ENHANCED
assert matches_action("*/read"), RESOURCE_READ_ACTION
assert matches_action("*"), RESOURCE_READ_ACTION
assert not matches_action("*/write"), RESOURCE_READ_ACTION
