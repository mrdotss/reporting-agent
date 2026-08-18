"""The progress callback — how the agent advances its own run state (Req 38.1–38.4, 38.15).

At every phase transition the runtime fires a short POST to the `progress_url` the
invoke context supplied. Four or five tiny independent requests per run, none
long-lived, none able to time out the way a twelve-minute stream can. Postgres is the
state machine; this module is the only thing in the agent that writes to it.

Four properties are load-bearing, and each one is a decision rather than a detail.

**The token travels in a header** — `X-Rpt-Progress-Token` — never in the request
target and never in the body (Req 38.2, 15.7). It is a credential, not a correlation
id: it authorizes writes to the run state machine, so a leaked token lets someone mark
a run `completed`. A URL is copied into every intermediary access log on the path, so a
token in a query string is a token in somebody else's log file. :func:`_build_body`
therefore constructs the body from a fixed field list and drops any token-shaped key a
caller passes, and nothing here ever appends to `progress_url`.

**Nothing raised here can end a run** (Req 38.4). A run that dies because it could not
report its own progress is the worst of both designs: the work succeeded and the row
says otherwise. Every failure — a timeout, a non-success status, an exception from the
transport — is retried at most once, logged with the token excluded, and then abandoned
(Req 38.3). The Reaper's deadline sweep is the backstop for a callback that never
landed.

**Intermediate transitions are fire-and-forget; the terminal transition is awaited.**
The asymmetry is deliberate. Losing `collecting` costs a stale progress display and the
next transition corrects it. Losing the terminal callback costs a **false `TIMEOUT` on a
run that actually succeeded**, and the container is about to exit, so there is no later
transition to correct it. Awaiting the terminal callback bounds shutdown by
`PROGRESS_TIMEOUT_S * PROGRESS_MAX_ATTEMPTS` — ten seconds worst case — and keeps the
Reaper as the backstop rather than the primary path.

**In-phase progress is throttled to one callback per 5 seconds per phase**
(`PROGRESS_THROTTLE_S`, Req 38.15), with both guards stated positively:

* **every phase transition is sent at the instant it occurs**, irrespective of the
  limit, and
* **the terminal callback is always sent**, irrespective of the limit.

A 200-resource month folds many batches. Posting per folded batch would turn the
design's "four or five tiny requests per run" budget into hundreds of real HTTP
requests against the app, for a counter the UI reads at a two-second poll anyway.
Throttling the *count* while exempting the *transitions* keeps the callback path
bounded without ever delaying the write that moves the state machine.

The clock and the HTTP transport are injected, so the throttle and the retry are
testable over simulated time against a fake transport, with no network and no sleeping.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections.abc import Callable, Mapping
from typing import Any, Final, Protocol, runtime_checkable

from reporting_agent.errors import APP_WRITTEN_CODES, ROW_ERROR_CODES
from reporting_agent.redaction import presence_marker, register_secrets, scrub, scrub_exception

__all__ = [
    "AGENT_PHASES",
    "DOCUMENT_PHASES",
    "PROGRESS_MAX_ATTEMPTS",
    "PROGRESS_THROTTLE_S",
    "PROGRESS_TIMEOUT_S",
    "TERMINAL_PHASES",
    "TOKEN_HEADER",
    "HttpxProgressTransport",
    "ProgressReporter",
    "ProgressTransport",
]

logger = logging.getLogger(__name__)

PROGRESS_TIMEOUT_S: Final[float] = 5.0
"""Req 38.3 — a callback that has not completed within this is a failure."""

PROGRESS_MAX_ATTEMPTS: Final[int] = 2
"""One retry, and no more (Req 38.3). Two attempts at 5 seconds is what bounds the
awaited terminal callback to ten seconds, so there is deliberately **no backoff sleep**
between them: a delay here is time added to container shutdown, and the failure this
retry covers is a dropped connection rather than a busy server."""

PROGRESS_THROTTLE_S: Final[float] = 5.0
"""Req 38.15 — at most one *in-phase progress* callback per phase per 5 seconds."""

TOKEN_HEADER: Final[str] = "X-Rpt-Progress-Token"
"""Req 38.2 — where the run-scoped token is presented, and the only place it appears."""

TERMINAL_PHASES: Final[frozenset[str]] = frozenset({"completed", "failed"})

DOCUMENT_PHASES: Final[frozenset[str]] = frozenset(
    {"compiling", "rendering", "verifying"}
)
"""The three phases the document pipeline drives (Req 41.3).

Added when their transitions landed in `lib/runs/state.ts`'s `DRIVEN` table. Presenting a
phase the endpoint's table does not admit spends a request to be refused, so this set and
that table are two spellings of one fact — and the integration tests in task 11.6 assert
over all `(current, target)` pairs, which is what keeps them one fact rather than two.
"""

AGENT_PHASES: Final[frozenset[str]] = (
    frozenset({"collecting"}) | DOCUMENT_PHASES | TERMINAL_PHASES
)
"""The phases the **agent** may present, matching `progressCallbackSchema`'s enum.

`queued` and `claimed` are absent because the Reaper owns them — an agent presenting
`claimed` is claiming to have done the claiming. `TIMEOUT` is likewise the Reaper's: the
agent may already be gone when a deadline elapses, so a transition carrying it is a request
guaranteed to be refused (Req 41.5).
"""

# The codes the agent may present on a `failed` transition. `TIMEOUT` and
# `SECRET_UNREADABLE` are written by the app — the Reaper's sweep and the tick's
# decryption failure — and the endpoint rejects a presented `TIMEOUT` outright
# (Req 38.11), so a callback carrying one is a request guaranteed to be refused.
_AGENT_ERROR_CODES: Final[frozenset[str]] = ROW_ERROR_CODES - APP_WRITTEN_CODES

# Anything whose name looks like a credential is dropped from the body rather than
# trusted not to have been passed (Req 38.2, 15.7).
_FORBIDDEN_BODY_KEYS: Final[frozenset[str]] = frozenset(
    {"progress_token", "progresstoken", "token", "client_secret", "clientsecret"}
)

# The endpoint parses the body with zod, and a parse failure refuses the **whole**
# callback — including the phase transition it carries. So a field that cannot be valid
# is repaired or dropped here rather than sent: losing one label is a cosmetic
# regression, while losing the transition it travelled with costs a false `TIMEOUT`.
_MAX_ERROR_MESSAGE_CHARS: Final[int] = 2000
_MAX_LABEL_CHARS: Final[int] = 64

_NON_TERMINAL_BODY_FIELDS: Final[tuple[str, ...]] = ("current", "total", "label")
_FAILED_BODY_FIELDS: Final[tuple[str, ...]] = ("error_code", "error_message")
_COMPLETED_BODY_FIELDS: Final[tuple[str, ...]] = (
    "snapshot_id",
    "resource_count",
    "gap_count",
)


def _coerce(name: str, value: Any) -> Any | None:
    """Repair a body field the endpoint would refuse, or drop it.

    Over-long text is truncated because the message still carries its useful prefix. A
    count outside its declared range is dropped rather than clamped: a negative count is
    a bug in the caller, and inventing a plausible substitute for it would put a wrong
    number on the row this product exists to keep honest.
    """
    if name == "error_message":
        return str(value)[:_MAX_ERROR_MESSAGE_CHARS]
    if name == "label":
        return str(value)[:_MAX_LABEL_CHARS]

    if name in ("current", "total", "resource_count", "gap_count"):
        # `bool` is a subclass of `int`, and `True` is not a resource count.
        if isinstance(value, bool) or not isinstance(value, int):
            logger.warning("%s=%r is not an integer; dropped from the callback body.", name, value)
            return None
        floor = 1 if name == "total" else 0
        if value < floor:
            logger.warning(
                "%s=%d is below the minimum the progress endpoint accepts (%d); dropped "
                "from the callback body so the transition it travels with still lands.",
                name,
                value,
                floor,
            )
            return None

    return value


@runtime_checkable
class ProgressTransport(Protocol):
    """The one HTTP operation this module performs, injected so it can be faked.

    Returns the response status code. Anything outside 2xx is a failure, and so is
    raising — the caller treats the two identically, because from the run's point of
    view they are the same event: the transition did not land.
    """

    async def post_json(
        self,
        url: str,
        *,
        body: Mapping[str, Any],
        headers: Mapping[str, str],
        timeout: float,
    ) -> int: ...


class HttpxProgressTransport:
    """`ProgressTransport` over `httpx.AsyncClient`.

    The client is built on first use rather than in `__init__`, so constructing a
    reporter opens no connection pool — a prompt invocation that never reports a phase
    pays nothing. `client` is injectable for the same reason it is elsewhere in this
    package: so a test can exercise the real code path without a socket.
    """

    def __init__(self, client: Any | None = None) -> None:
        self._client = client

    async def post_json(
        self,
        url: str,
        *,
        body: Mapping[str, Any],
        headers: Mapping[str, str],
        timeout: float,
    ) -> int:
        if self._client is None:
            import httpx

            self._client = httpx.AsyncClient()

        response = await self._client.post(
            url, json=dict(body), headers=dict(headers), timeout=timeout
        )
        return int(response.status_code)

    async def aclose(self) -> None:
        client = self._client
        self._client = None
        if client is not None and hasattr(client, "aclose"):
            await client.aclose()


class ProgressReporter:
    """Sends this run's phase transitions to the app's progress endpoint.

    One instance per invocation, built from the invoke `context`. When `progress_url` or
    `progress_token` is absent — a chat prompt carries no run — the reporter is
    **disabled** and every method is a no-op, so no caller needs to branch on whether
    this invocation has a run row behind it.
    """

    def __init__(
        self,
        *,
        progress_url: str | None,
        progress_token: str | None,
        run_id: str | None,
        transport: ProgressTransport | None = None,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._url = (progress_url or "").strip()
        self._token = progress_token or ""
        self._run_id = (run_id or "").strip()
        self._transport: ProgressTransport = (
            transport if transport is not None else HttpxProgressTransport()
        )
        self._clock = clock

        self.enabled: bool = bool(self._url and self._token and self._run_id)

        # The phase the row is believed to carry. A `report` naming a different phase is
        # a *transition* and is exempt from the throttle; one naming this phase is an
        # in-phase refresh and is not.
        self._current_phase: str | None = None
        self._last_sent_at: dict[str, float] = {}
        self._pending: set[asyncio.Task[None]] = set()
        self._terminal_sent = False

        # Belt and braces. `main.py` registers the token when it parses the context
        # (Req 15.1) and registration is idempotent, so this costs nothing there — but
        # it means a log line from *this* module cannot carry the token even if a caller
        # built a reporter without going through that path.
        if self._token:
            register_secrets((self._token,))

        # Req 38.2 / 15.7: the token must not be in the request target. This module never
        # appends to `progress_url`, so the only way it could be is if the caller was
        # handed a URL that already contains it — which is a caller bug worth naming,
        # with the value itself excluded from the message.
        if self._token and self._token in self._url:
            logger.warning(
                "progress_url contains the run-scoped progress token; the token must "
                "travel in the %s header only. Continuing with the URL as supplied.",
                TOKEN_HEADER,
            )

    # --- the two public operations ---------------------------------------------------

    async def report(
        self,
        phase: str,
        *,
        current: int | None = None,
        total: int | None = None,
        label: str | None = None,
    ) -> None:
        """Report a **non-terminal** phase, fire-and-forget. Never raises (Req 38.4).

        Returns as soon as the request is scheduled, so a collector fold is never
        blocked on the app's response. `current`, `total` and `label` are carried where
        the entered phase has a countable unit of work (Req 38.1), which is what lets the
        row feed a determinate bar rather than a spinner that runs for four minutes.

        A transition to this phase is sent at the instant it occurs; a refresh inside the
        phase is subject to `PROGRESS_THROTTLE_S` (Req 38.15).
        """
        if not self.enabled or self._terminal_sent:
            return

        try:
            if phase in TERMINAL_PHASES:
                # Never drop a terminal callback on the floor: losing it costs a false
                # TIMEOUT on a successful run. Route it to the awaited path instead.
                logger.warning(
                    "report(%r) names a terminal phase; sending it through the awaited "
                    "terminal path instead of fire-and-forget.",
                    phase,
                )
                await self.report_terminal(phase)
                return

            if phase not in AGENT_PHASES:
                # Nothing outside the endpoint's enum can be accepted, so spending a
                # request to be refused buys nothing. Name it in a log line instead.
                logger.warning(
                    "phase %r is not a phase the agent may present; nothing sent.", phase
                )
                return

            if not self._admit(phase):
                return

            body = self._build_body(phase, current=current, total=total, label=label)
            task = asyncio.create_task(
                self._deliver(phase, body), name=f"progress-callback-{phase}"
            )
            self._pending.add(task)
            task.add_done_callback(self._pending.discard)
        except Exception as exc:  # Req 38.4: this may not end the run
            logger.warning(
                "progress callback for phase %r could not be scheduled; the run "
                "continues and the reaper is the backstop: %s",
                phase,
                scrub_exception(exc),
            )

    async def report_terminal(
        self,
        phase: str,
        *,
        error_code: str | None = None,
        error_message: str | None = None,
        snapshot_id: str | None = None,
        resource_count: int | None = None,
        gap_count: int | None = None,
    ) -> None:
        """Report a terminal phase and **wait for it**. Never raises (Req 38.4).

        Always sent, irrespective of the throttle (Req 38.15). Awaited because the
        container is about to exit: an unsent terminal callback is a run that succeeded
        and will be failed as `TIMEOUT` by the Reaper.

        Terminal fields are routed by phase, as Req 38.12 declares them — `error_code`
        and `error_message` for `failed`, `snapshot_id`, `resource_count` and `gap_count`
        for `completed`. A field belonging to the other phase is dropped, and no
        `current`/`total`/`label` is presented at all, because a terminal transition
        clears those columns.
        """
        if not self.enabled:
            return

        try:
            if phase not in TERMINAL_PHASES:
                logger.warning(
                    "report_terminal(%r) names a non-terminal phase; nothing sent.", phase
                )
                return

            body = self._build_body(
                phase,
                error_code=error_code,
                error_message=error_message,
                snapshot_id=snapshot_id,
                resource_count=resource_count,
                gap_count=gap_count,
            )

            self._current_phase = phase
            self._last_sent_at[phase] = self._clock()
            self._terminal_sent = True

            await self._deliver(phase, body)
        except Exception as exc:  # Req 38.4
            logger.warning(
                "terminal progress callback for phase %r failed; the run's outcome "
                "stands and the reaper is the backstop: %s",
                phase,
                scrub_exception(exc),
            )
        finally:
            await self.aclose()

    async def aclose(self) -> None:
        """Abandon any still-in-flight intermediate callback. Never raises.

        Called after the terminal callback. An intermediate transition still in flight at
        that point is *superseded* — the endpoint rejects every transition on a terminal
        row — so cancelling is both correct and instant, which is what keeps container
        shutdown bounded by the terminal callback alone. It also stops asyncio warning
        about a pending task destroyed at loop close.
        """
        pending = tuple(self._pending)
        self._pending.clear()
        for task in pending:
            task.cancel()
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)

    # --- the throttle ----------------------------------------------------------------

    def _admit(self, phase: str) -> bool:
        """May this non-terminal callback be sent now (Req 38.15)?

        Decided **synchronously**, before the request is scheduled, so the limit bounds
        HTTP requests rather than tasks. `_last_sent_at` records the decision instant,
        not the completion instant: a slow response must not widen the window and let a
        second request through early.
        """
        now = self._clock()

        if phase != self._current_phase:
            # A transition. Sent at the instant it occurs, irrespective of the limit.
            self._current_phase = phase
            self._last_sent_at[phase] = now
            return True

        last = self._last_sent_at.get(phase)
        if last is not None and (now - last) < PROGRESS_THROTTLE_S:
            return False

        self._last_sent_at[phase] = now
        return True

    # --- the body --------------------------------------------------------------------

    def _build_body(self, phase: str, **fields: Any) -> dict[str, Any]:
        """Build the callback body from a fixed field list.

        Constructed by allow-list rather than by copying a caller's mapping, which is
        what makes "the token is never in the body" (Req 38.2) structural: there is no
        field name here that could carry it, and a token-shaped key is dropped with a
        warning rather than forwarded.
        """
        body: dict[str, Any] = {"run_id": self._run_id, "phase": phase}

        if phase == "failed":
            permitted = _FAILED_BODY_FIELDS
        elif phase == "completed":
            permitted = _COMPLETED_BODY_FIELDS
        else:
            permitted = _NON_TERMINAL_BODY_FIELDS

        for name, value in fields.items():
            if name.lower() in _FORBIDDEN_BODY_KEYS:
                logger.warning(
                    "field %r was offered for a progress callback body and has been "
                    "dropped; a credential travels in the %s header only.",
                    name,
                    TOKEN_HEADER,
                )
                continue
            if value is None or name not in permitted:
                continue
            if name == "error_code" and str(value) not in _AGENT_ERROR_CODES:
                # Req 38.11 — the reaper is the only writer of TIMEOUT, and a `failed`
                # transition carrying an out-of-set code is refused. Dropping the field
                # here names the mistake in a log line instead of spending a request.
                logger.warning(
                    "error_code %r is not a code the agent may present; it has been "
                    "dropped from the progress callback body.",
                    value,
                )
                continue

            coerced = _coerce(name, value)
            if coerced is None:
                continue
            body[name] = coerced

        return body

    # --- delivery --------------------------------------------------------------------

    async def _deliver(self, phase: str, body: Mapping[str, Any]) -> None:
        """POST `body`, retrying at most once. Never raises (Req 38.3, 38.4)."""
        headers = {TOKEN_HEADER: self._token}

        for attempt in range(1, PROGRESS_MAX_ATTEMPTS + 1):
            try:
                status = await asyncio.wait_for(
                    self._transport.post_json(
                        self._url,
                        body=body,
                        headers=headers,
                        timeout=PROGRESS_TIMEOUT_S,
                    ),
                    timeout=PROGRESS_TIMEOUT_S,
                )
            except asyncio.CancelledError:
                # Cooperative cancellation from `aclose`, not a failure. Propagate.
                raise
            except TimeoutError:
                # Built-in `TimeoutError` subclasses `OSError`, so an `except OSError`
                # added above or beside this arm would swallow every timeout first and
                # report it as a transport failure — losing the "slow" signal that is the
                # only thing distinguishing this arm from the fallback below. On 3.11+
                # `asyncio.TimeoutError is TimeoutError`, so this one clause covers both.
                self._log_failure(phase, attempt, detail="did not complete within 5s")
            except Exception as exc:  # Req 38.4
                self._log_failure(phase, attempt, detail=scrub_exception(exc))
            else:
                if 200 <= status < 300:
                    return
                self._log_failure(phase, attempt, detail=f"returned status {status}")

        logger.warning(
            "progress callback for phase %r abandoned after %d attempts; the run "
            "continues and the reaper is the backstop for a callback that never "
            "arrived.",
            phase,
            PROGRESS_MAX_ATTEMPTS,
        )

    def _log_failure(self, phase: str, attempt: int, *, detail: str) -> None:
        """Record one failed attempt with the token excluded (Req 38.3, 15.7).

        The token is rendered as a presence marker, and the URL is passed through the
        redaction guard, so neither the message nor the arguments can carry the value —
        even if a caller supplied a URL containing it.
        """
        logger.warning(
            "progress callback attempt %d/%d for phase %r to %s failed (token %s): %s",
            attempt,
            PROGRESS_MAX_ATTEMPTS,
            phase,
            scrub(self._url),
            presence_marker(self._token),
            detail,
        )
