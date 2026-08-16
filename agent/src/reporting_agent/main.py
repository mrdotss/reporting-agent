"""The AgentCore entrypoint — command routing, step tracking and the single egress.

Three things live here and nothing else: the routing table, the invariants that hold of
every emitted event, and the one function every event leaves through.

    CONFIG = Config.from_env()      # once, at import, frozen (Req 14.12, 14.16)
    install_log_redaction()         # at import; again after the context is parsed (Req 15.2)

    app = BedrockAgentCoreApp()

    @app.entrypoint
    async def invoke(payload, context):
        ...
            yield emit(event)       # THE single egress (Req 14.15, 15.8)

**`emit` is a choke point, not a helper.** Every event this process produces passes
through it, so a redaction pass added there covers an emission site added later
(Req 15.8), and a type outside the declared vocabulary cannot be emitted by accident
(Req 14.15). It also refuses anything outside `EMITTED_BY_FOUNDATION`, which is what
makes "no `verification` and no `report_file`, ever" (Req 14.11) a property of the code
rather than a rule someone has to remember: this spec renders no document, so a
`report_file` arriving without a passing `verification` before it is not something the
UI has to defend against, because neither event has an emitter.

**Routing consults no model** (Req 14.2). `generate_report` and `preflight` run the
deterministic pipeline and any `prompt` in the same payload is ignored — there is no
model client in this module to consult, so that is structural too. A payload naming an
unrecognised command, a payload carrying no command at all, and a payload whose
`actor_id` is absent, non-string or blank each produce **one terminal `error` followed by
`done`** and nothing else (Req 14.4, 14.5, 14.13).

**Secrets are registered in the entrypoint's own context, before the merge starts.**
This is load-bearing and easy to get wrong: `merge_with_heartbeat` drains the pipeline in
an `asyncio` task, and a task runs in a *copy* of the current context, so a
`register_secrets` call inside the pipeline would set the `ContextVar` in the pump's copy
and `emit` — running in the consumer's context — would scrub nothing. Parsing the context
in `invoke` and registering there is what keeps the guard on the egress path.

**The terminal ordering is owned by a `finally`, not by each handler.** A phase that
raises still gets its `tool` step closed (Req 14.14) and still reaches `done`
(Req 14.10), because `StepTracker.close_all()` and the `done` event are the last two
things `run_invocation` does on every path. `done` is emitted last and
`merge_with_heartbeat` stops reading there, so nothing — not even a keep-alive already
queued — can follow it.

**Both handlers are wired**: `handle_preflight` to `azure/preflight.py` and
`handle_generate_report` to `collect/pipeline.py`. Neither constructs a terminal event;
:class:`CommandUnimplementedError` remains for a command added to `COMMANDS` before its
handler lands, and the router turns it into a well-formed terminal `error` + `done` pair
rather than an unhandled exception — a routing skeleton that crashes is indistinguishable,
from the client's side, from a runtime that died.

**A command whose result is its outcome reports it on `done`.** `preflight` has no run row
and no later callback, so `scope_verified` and `fidelity_tier` ride on the terminal event
through `Invocation.outcome` (see :func:`_done_event`). That keeps the result inside the
declared vocabulary rather than adding an eleventh event type the two languages would both
have to grow.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
from collections.abc import AsyncIterator, Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final, NamedTuple

from bedrock_agentcore.runtime import BedrockAgentCoreApp

from reporting_agent.config import Config
from reporting_agent.errors import (
    APP_WRITTEN_CODES,
    AgentError,
    ErrorCode,
)
from reporting_agent.events import (
    EMITTED_BY_FOUNDATION,
    EVENT_TYPES,
    TERMINAL_EVENT_TYPE,
    TOOL_COLLECT_INVENTORY,
    TOOL_COLLECT_METRICS,
    is_declared_event_type,
)
from reporting_agent.heartbeat import merge_with_heartbeat
from reporting_agent.progress import (
    AGENT_PHASES,
    TERMINAL_PHASES,
    ProgressReporter,
)
from reporting_agent.redaction import (
    discard_secrets,
    install_log_redaction,
    presence_marker,
    register_secrets,
    scrub_deep,
    scrub_exception,
)

__all__ = [
    "CODE_COMMAND_UNIMPLEMENTED",
    "CODE_INTERNAL_ERROR",
    "CODE_INVALID_ACTOR",
    "CODE_MISSING_COMMAND",
    "CODE_UNSUPPORTED_COMMAND",
    "COMMANDS",
    "COMMAND_GENERATE_REPORT",
    "COMMAND_HANDLERS",
    "COMMAND_PREFLIGHT",
    "CONFIG",
    "FOUNDATION_TOOL_NAMES",
    "INVOCATION_ERROR_CODES",
    "KNOWN_TOOL_NAMES",
    "SESSION_ID_MAX_LENGTH",
    "SESSION_ID_MIN_LENGTH",
    "STATUS_COMPLETED",
    "STATUS_FAILED",
    "TOOL_COLLECT_INVENTORY",
    "TOOL_COLLECT_METRICS",
    "CommandUnimplementedError",
    "EmissionError",
    "Invocation",
    "Rejection",
    "StepInvariantError",
    "StepTracker",
    "app",
    "derive_session_id",
    "describe_invocation",
    "emit",
    "handle_generate_report",
    "handle_preflight",
    "invoke",
    "main",
    "parse_invocation",
    "resolve_actor_id",
    "resolve_session_id",
    "run_invocation",
]

logger = logging.getLogger(__name__)

Event = dict[str, Any]

# --- the routing table ---------------------------------------------------------------

COMMAND_GENERATE_REPORT: Final[str] = "generate_report"
COMMAND_PREFLIGHT: Final[str] = "preflight"

COMMANDS: Final[frozenset[str]] = frozenset({COMMAND_GENERATE_REPORT, COMMAND_PREFLIGHT})
"""The commands this runtime accepts (Req 14.3). `compare_runs` and `verify_report` belong
to the specs that add the compile/render/verify pipeline; naming one here would route a
payload to a pipeline that does not exist."""


# --- error codes that describe the *invocation*, not the collection -------------------
#
# Req 14.4 requires the unrecognised-command code to be distinct from every
# collection-phase code, and the asserts at the bottom of this module hold all four of
# these disjoint from `ErrorCode` and from the two app-written codes. That disjointness is
# the point: a client must be able to tell "this payload was refused" from "this
# subscription could not be collected", and neither may ever be confused with the
# reaper's `TIMEOUT`.

CODE_UNSUPPORTED_COMMAND: Final[str] = "UNSUPPORTED_COMMAND"
CODE_MISSING_COMMAND: Final[str] = "MISSING_COMMAND"
CODE_INVALID_ACTOR: Final[str] = "INVALID_ACTOR"
CODE_COMMAND_UNIMPLEMENTED: Final[str] = "COMMAND_UNIMPLEMENTED"
CODE_INTERNAL_ERROR: Final[str] = "INTERNAL_ERROR"

INVOCATION_ERROR_CODES: Final[frozenset[str]] = frozenset(
    {
        CODE_UNSUPPORTED_COMMAND,
        CODE_MISSING_COMMAND,
        CODE_INVALID_ACTOR,
        CODE_COMMAND_UNIMPLEMENTED,
        CODE_INTERNAL_ERROR,
    }
)

# --- session ids ---------------------------------------------------------------------

SESSION_ID_MIN_LENGTH: Final[int] = 33
SESSION_ID_MAX_LENGTH: Final[int] = 128

SESSION_ID_NAMESPACE: Final[str] = "rpt:session:actor:v1:"
"""Namespace for the derived fallback id, versioned so a future change to the derivation
is a new namespace rather than a silent reinterpretation of ids already in use. The web
app derives run and thread session ids the same way, under its own namespaces
(`app/lib/session-id.ts`); this one is the agent-side last resort."""

# --- tool steps ----------------------------------------------------------------------

TOOL_START_PHASE: Final[str] = "start"
TOOL_END_PHASE: Final[str] = "end"

TOOL_PREFLIGHT_PERMISSIONS: Final[str] = "preflight_permissions"
TOOL_PREFLIGHT_FIDELITY: Final[str] = "preflight_fidelity"
"""The `preflight` command's two steps. Named here rather than in `azure/preflight.py`
because the step vocabulary is a UI contract this module owns; the service answers the two
questions and knows nothing about the timeline they are rendered on."""

FOUNDATION_TOOL_NAMES: Final[frozenset[str]] = frozenset(
    {TOOL_COLLECT_INVENTORY, TOOL_COLLECT_METRICS}
)
"""The two step names this spec drives (Req 14.7).

An unrecognised name is **logged and permitted** rather than refused. The names are a UI
contract — the timeline maps a name to an icon and a label — and a name the timeline does
not know degrades to a generic step, which is a cosmetic regression. Refusing it would
turn that into a failed run, and would also mean this module has to be edited before a
later phase can open a step. The invariants that actually protect the client (an `id`
referencing an open step, `done <= total`, no regression) are hard failures below."""

# The declared vocabulary from the invoke contract, so an unknown name is recognisable as
# "not yet emitted here" rather than "misspelt".
KNOWN_TOOL_NAMES: Final[frozenset[str]] = FOUNDATION_TOOL_NAMES | frozenset(
    {
        TOOL_PREFLIGHT_PERMISSIONS,
        TOOL_PREFLIGHT_FIDELITY,
        "compile_figures",
        "render_document",
        "verify_document",
        "upload_artifact",
        "compare_snapshots",
    }
)

# --- process configuration, read once ------------------------------------------------

CONFIG: Final[Config] = Config.from_env()
"""Built once, at import, and frozen (Req 14.12). Nothing in this package reads
`os.environ` after this line; a missing variable raises here, at process start, naming the
variable and excluding its value (Req 14.16)."""

install_log_redaction()  # Req 15.2 — at process start, and again after the context parse.


class EmissionError(RuntimeError):
    """An event was offered to :func:`emit` that may not be emitted.

    Raised for a non-mapping, for a missing or undeclared `type` (Req 14.15), and for a
    declared type outside `EMITTED_BY_FOUNDATION` — which is how `verification` and
    `report_file` are refused (Req 14.11).
    """


class StepInvariantError(ValueError):
    """A `tool` or `progress` event would have violated Req 14.7 / Req 14.8.

    Raised rather than quietly corrected. An orphan `progress` event points at a step the
    timeline never opened, and a `done` that jumped backwards makes a determinate bar run
    in reverse; both are caller bugs, and a caller bug that produces a plausible-looking
    stream is the kind that ships. The router catches it, closes the open steps and ends
    the invocation properly, so the failure is loud without being unhandled.
    """


class CommandUnimplementedError(RuntimeError):
    """A recognised command's handler has not landed yet.

    Carried by the two seams below. The router turns it into a terminal `error` + `done`,
    so an unfilled seam produces a well-formed stream rather than an unhandled exception.
    """

    def __init__(self, command: str, task: str) -> None:
        super().__init__(
            f"the {command!r} command is recognised but its handler is not implemented "
            f"yet; task {task} fills in this seam."
        )
        self.command = command
        self.task = task


# --------------------------------------------------------------------------- #
# The single egress
# --------------------------------------------------------------------------- #


def emit(event: object) -> Event:
    """Validate, scrub and return one event. **The** egress (Req 14.15, 15.8).

    Every event the process yields passes through here, so redaction cannot be bypassed by
    a new emission site and an undeclared type cannot reach the wire. The event is rebuilt
    rather than mutated, so a caller's dict is untouched.
    """
    if not isinstance(event, Mapping):
        raise EmissionError(
            f"an event must be a mapping carrying a `type` field, got "
            f"{type(event).__name__}"
        )

    kind = event.get("type")

    if not is_declared_event_type(kind):
        raise EmissionError(
            f"{kind!r} is not a declared event type; only the types in "
            f"reporting_agent.events.EVENT_TYPES may be emitted (Req 14.15): "
            f"{', '.join(EVENT_TYPES)}"
        )

    if kind not in EMITTED_BY_FOUNDATION:
        raise EmissionError(
            f"{kind!r} is declared but is not emitted by this spec's runtime "
            f"(Req 14.11). `verification` and `report_file` in particular have no "
            f"emitter here, because no document is produced: the ordering guarantee that "
            f"a `report_file` never arrives without a passing `verification` cannot be "
            f"violated by a runtime that emits neither."
        )

    # Req 15.8 — one scrub, on the way out, at every depth (Req 15.3).
    scrubbed = scrub_deep(dict(event))
    if not isinstance(scrubbed, dict):  # pragma: no cover - scrub_deep preserves shape
        raise EmissionError(f"the scrub returned {type(scrubbed).__name__}, not a dict")
    return scrubbed


# --------------------------------------------------------------------------- #
# Event constructors — the only places these shapes are written
# --------------------------------------------------------------------------- #


def _error_event(code: str, message: str, *, terminal: bool) -> Event:
    return {"type": "error", "code": code, "terminal": terminal, "message": message}


def _done_event(
    run_id: str | None, status: str, outcome: Mapping[str, Any] | None = None
) -> Event:
    """`done`, carrying `run_id` and `status` (Req 14.10), plus this command's outcome.

    `run_id` is `None` for an invocation with no run row behind it — a `preflight` is
    exactly that — rather than an invented identifier the app could not resolve.

    `outcome` carries the terminal facts of a command that has no row to write them to.
    `preflight` is the case that needs it: `scope_verified` and `fidelity_tier` are the
    whole point of the invocation, the app consumes the short stream inline, and there is
    no run row and no later callback to read them off. Putting them on `done` keeps the
    result inside the **declared** event vocabulary — no new type, so `events.py` and
    `app/lib/events.ts` do not have to be renegotiated for it — and keeps it on the one
    event every client already waits for.

    `type`, `run_id` and `status` are written last, so an outcome key cannot overwrite the
    three fields Req 14.10 pins.
    """
    event: Event = dict(outcome or {})
    event["type"] = TERMINAL_EVENT_TYPE
    event["run_id"] = run_id
    event["status"] = status
    return event


# --------------------------------------------------------------------------- #
# StepTracker — the owner of the tool/progress invariants
# --------------------------------------------------------------------------- #


@dataclass(slots=True)
class _Step:
    step_id: str
    name: str
    label: str
    last_done: int | None = None


class StepTracker:
    """Owns `tool` start/end pairing and the `progress` invariants (Req 14.7, 14.8, 14.14).

    One instance per invocation. Callers never construct a `tool` or `progress` event
    themselves — they ask the tracker for one — which is what makes an orphan `progress`
    event and an unclosed step unrepresentable rather than merely discouraged.
    """

    def __init__(self) -> None:
        self._open: dict[str, _Step] = {}
        self._closed: set[str] = set()
        self._sequence: int = 0

    # --- inspection ------------------------------------------------------------------

    @property
    def open_ids(self) -> tuple[str, ...]:
        """The ids of every step opened and not yet closed, in the order opened."""
        return tuple(self._open)

    def is_open(self, step_id: object) -> bool:
        return isinstance(step_id, str) and step_id in self._open

    # --- the three operations --------------------------------------------------------

    def start(
        self,
        name: str,
        *,
        label: str,
        status: str,
        step_id: str | None = None,
    ) -> Event:
        """Open a step and return its `tool` `start` event (Req 14.7).

        The id is derived from the step name and a per-invocation counter, so it is
        deterministic and readable in a log — there is no random component to make two
        runs of the same pipeline differ.
        """
        _require_text("name", name)
        _require_text("label", label)
        _require_text("status", status)

        if name not in KNOWN_TOOL_NAMES:
            logger.warning(
                "tool step name %r is not one of the declared step names; the activity "
                "timeline will render it as a generic step.",
                name,
            )

        self._sequence += 1
        resolved = step_id if step_id is not None else f"{name}-{self._sequence}"
        _require_text("step_id", resolved)

        if resolved in self._open or resolved in self._closed:
            raise StepInvariantError(
                f"step id {resolved!r} has already been used in this invocation; a "
                f"`tool` `start` must open a step the client has not seen before, "
                f"otherwise a `phase` `end` cannot say which step it closes."
            )

        self._open[resolved] = _Step(step_id=resolved, name=name, label=label)
        return {
            "type": "tool",
            "phase": TOOL_START_PHASE,
            "id": resolved,
            "name": name,
            "label": label,
            "status": status,
        }

    def progress(
        self,
        step_id: str,
        *,
        done: int,
        total: int,
        unit: str,
        label: str | None = None,
    ) -> Event:
        """Return a `progress` event for an **open** step (Req 14.8).

        `label` defaults to the label the step was opened with, so the two cannot
        disagree for one id.
        """
        step = self._open.get(step_id) if isinstance(step_id, str) else None
        if step is None:
            raise StepInvariantError(
                f"progress id {step_id!r} does not reference an open `tool` step "
                f"(open: {list(self._open) or 'none'}"
                + (f", closed: {sorted(self._closed)}" if self._closed else "")
                + "); a progress bar attached to a step the client never opened, or has "
                "already collapsed, is an orphan."
            )

        _require_count("done", done)
        _require_count("total", total)
        _require_text("unit", unit)
        if label is not None:
            _require_text("label", label)

        if total < 1:
            raise StepInvariantError(
                f"progress total for {step_id!r} is {total}; a determinate bar needs a "
                f"positive total, and a step with nothing to count should emit no "
                f"`progress` event at all."
            )
        if done > total:
            raise StepInvariantError(
                f"progress for {step_id!r} reports done={done} against total={total}; "
                f"`done` must stay at or below `total` (Req 14.8)."
            )
        if step.last_done is not None and done < step.last_done:
            raise StepInvariantError(
                f"progress for {step_id!r} went backwards, {step.last_done} -> {done}; "
                f"successive `done` values for one id must not decrease (Req 14.8)."
            )

        step.last_done = done
        return {
            "type": "progress",
            "id": step_id,
            "done": done,
            "total": total,
            "unit": unit,
            "label": step.label if label is None else label,
        }

    def end(self, step_id: str) -> Event:
        """Close an open step and return its `tool` `end` event, carrying the same
        `id` and the same `name` (Req 14.7)."""
        step = self._open.pop(step_id, None) if isinstance(step_id, str) else None
        if step is None:
            raise StepInvariantError(
                f"step id {step_id!r} is not open, so there is nothing to close "
                f"(open: {list(self._open) or 'none'})."
            )
        self._closed.add(step.step_id)
        return {
            "type": "tool",
            "phase": TOOL_END_PHASE,
            "id": step.step_id,
            "name": step.name,
        }

    def close_all(self) -> list[Event]:
        """Close every still-open step, innermost first (Req 14.14).

        Called from the router's `finally`, so a phase that ended by raising still has its
        step closed before `done` — an activity timeline left with a spinner running
        forever is indistinguishable from a run that is still working.

        Most-recently-opened first, because a step opened inside another is nested inside
        it on the timeline and a nested step outliving its parent reads as a bug.
        """
        events: list[Event] = []
        for step_id in reversed(list(self._open)):
            events.append(self.end(step_id))
        return events


def _require_text(field_name: str, value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise StepInvariantError(
            f"{field_name} must be a non-empty string, got {value!r}"
        )
    return value


def _require_count(field_name: str, value: object) -> int:
    # `bool` is a subclass of `int`, and `True` is not a count.
    if isinstance(value, bool) or not isinstance(value, int):
        raise StepInvariantError(f"{field_name} must be an int, got {value!r}")
    if value < 0:
        raise StepInvariantError(f"{field_name} must not be negative, got {value}")
    return value


# --------------------------------------------------------------------------- #
# Parsing the invocation
# --------------------------------------------------------------------------- #


class Rejection(NamedTuple):
    """A payload this runtime refuses, and the code it is refused with.

    A rejected invocation still produces a stream: one terminal `error` carrying this
    `code`, then `done` (Req 14.4, 14.5, 14.13).
    """

    code: str
    message: str


@dataclass(frozen=True, slots=True)
class Invocation:
    """One parsed invocation. Built by :func:`parse_invocation`, consumed by the router.

    `payload` and `context` are the raw mappings, so a handler filled in by a later task
    reads its own fields (`period`, `scope`, `subscription_id`, `timezone`, …) without this
    module having to grow a field per command.

    `progress` is always present and is a **no-op when this invocation carries no run** —
    a reporter built without a `progress_url`, `progress_token` and `run_id` is disabled —
    so no handler branches on whether there is a row behind it.

    `outcome` is the one **mutable** thing here: a handler writes the terminal facts it
    wants on its own `done` into it, and the router merges them (see :func:`_done_event`).
    A handler cannot construct the terminal event itself — that would strand the step
    closures and the progress callback behind an event the client treats as final — so
    this is how a command whose whole result *is* its outcome, `preflight`, reports one.
    The dict is written before the failure path is taken as well as on success, so a
    rejected preflight's `done` still says `scope_verified: false` rather than saying
    nothing.
    """

    command: str | None
    actor_id: str | None
    session_id: str | None
    run_id: str | None
    payload: Mapping[str, Any] = field(default_factory=dict)
    context: Mapping[str, Any] = field(default_factory=dict)
    progress: ProgressReporter | None = None
    rejection: Rejection | None = None
    outcome: dict[str, Any] = field(default_factory=dict)


def resolve_actor_id(context: Mapping[str, Any]) -> str | None:
    """`actor_id` from the payload `context`, or `None` (Req 14.5).

    Absent, non-string, empty and whitespace-only are one mistake with four spellings and
    all four resolve as absent. The value is returned **verbatim** when it is usable: it
    prefixes every S3 artifact key this run writes, so trimming it here would write
    artifacts under a key the app cannot compute.
    """
    value = context.get("actor_id")
    if not isinstance(value, str) or not value.strip():
        return None
    return value


def derive_session_id(actor_id: str) -> str:
    """A session id derived from `actor_id`: 64 lowercase hex characters (Req 14.6).

    Length is satisfied **by construction** — a SHA-256 digest is 64 hex characters for
    any input, comfortably inside 33–128 — so there is no length check here and no input
    that could fail one. Deterministic, so two invocations for one actor that both fall
    back to derivation share a session and therefore share memory.
    """
    digest = hashlib.sha256((SESSION_ID_NAMESPACE + actor_id).encode("utf-8"))
    return digest.hexdigest()


def resolve_session_id(
    *,
    supplied: object,
    fallback: object,
    actor_id: str | None,
) -> str | None:
    """`context.session_id`, else the request context's, else a derivation (Req 14.6).

    A candidate is used only if it is a string of 33–128 characters after stripping
    surrounding whitespace — the bound `InvokeAgentRuntime` enforces. Anything else falls
    through to the next source, and the invocation **continues** either way: an id that
    cannot be honoured costs continuity of memory, which is not worth failing a
    twelve-minute run over.
    """
    for candidate in (supplied, fallback):
        if not isinstance(candidate, str):
            continue
        value = candidate.strip()
        if SESSION_ID_MIN_LENGTH <= len(value) <= SESSION_ID_MAX_LENGTH:
            return value
        if value:
            logger.warning(
                "a supplied session id of %d characters is outside the %d-%d bound and "
                "was not used.",
                len(value),
                SESSION_ID_MIN_LENGTH,
                SESSION_ID_MAX_LENGTH,
            )

    if actor_id is None:
        return None
    return derive_session_id(actor_id)


def parse_invocation(payload: object, request_context: object = None) -> Invocation:
    """Parse a payload into an :class:`Invocation`. Never raises.

    Registers the invocation's secrets **before** anything else can fail (Req 15.1), so a
    message built on the rejection path below is already covered by the guard. This runs
    in the entrypoint's own context deliberately — see the module docstring on why
    registering inside the pumped pipeline would leave `emit` scrubbing nothing.

    A malformed payload is a rejection, not an exception: the client is owed a terminal
    `error` and a `done`, and a parse that raised would deny it both.
    """
    payload_map: Mapping[str, Any] = payload if isinstance(payload, Mapping) else {}
    context_map: Mapping[str, Any] = (
        payload_map.get("context") if isinstance(payload_map.get("context"), Mapping) else {}
    )

    # Req 15.1 — `client_secret` and `progress_token` carry identical sensitivity. The
    # token authorizes writes to the run state machine, so a leak lets someone mark a run
    # `completed`.
    register_secrets((context_map.get("client_secret"), context_map.get("progress_token")))

    raw_command = payload_map.get("command")
    command = raw_command if isinstance(raw_command, str) and raw_command in COMMANDS else None
    actor_id = resolve_actor_id(context_map)
    run_id = context_map.get("run_id")
    run_id = run_id if isinstance(run_id, str) and run_id.strip() else None

    session_id = resolve_session_id(
        supplied=context_map.get("session_id"),
        fallback=getattr(request_context, "session_id", None),
        actor_id=actor_id,
    )

    reporter = ProgressReporter(
        progress_url=_optional_text(context_map.get("progress_url")),
        progress_token=_optional_text(context_map.get("progress_token")),
        run_id=run_id,
    )

    # The command is checked before the actor: a payload naming no command, or a command
    # this runtime does not implement, is refused whatever else it carries, and a rejection
    # naming the missing pipeline is more useful than one naming a field of a pipeline that
    # would never have run.
    rejection = _reject_command(raw_command) or _reject_actor(actor_id)

    return Invocation(
        command=command,
        actor_id=actor_id,
        session_id=session_id,
        run_id=run_id,
        payload=payload_map,
        context=context_map,
        progress=reporter,
        rejection=rejection,
    )


def _reject_command(raw_command: object) -> Rejection | None:
    if raw_command is None:
        # Req 14.13 — a payload with no command is model-facing chat, which is out of this
        # spec's scope. There is no model client here to route it to.
        return Rejection(
            CODE_MISSING_COMMAND,
            "This runtime routes deterministic commands only, and this payload carries "
            "no `command` field. Send `command` set to one of: "
            + ", ".join(sorted(COMMANDS))
            + ".",
        )

    if isinstance(raw_command, str) and raw_command in COMMANDS:
        return None

    # Req 14.4 — an unrecognised command. The offered value is echoed, truncated: it is a
    # command name rather than a credential, and naming it is what makes a typo obvious.
    offered = raw_command if isinstance(raw_command, str) else type(raw_command).__name__
    return Rejection(
        CODE_UNSUPPORTED_COMMAND,
        f"{offered[:64]!r} is not a command this runtime accepts. Accepted commands: "
        + ", ".join(sorted(COMMANDS))
        + ".",
    )


def _reject_actor(actor_id: str | None) -> Rejection | None:
    if actor_id is not None:
        return None
    # Req 14.5 — `actor_id` scopes agent memory and prefixes every artifact key, so a run
    # without one would write artifacts nobody can find and answer questions in somebody
    # else's session. No collection is started.
    return Rejection(
        CODE_INVALID_ACTOR,
        "`context.actor_id` is required and must be a non-blank string. It scopes this "
        "invocation's memory and prefixes every artifact key it writes, so there is no "
        "safe default for it.",
    )


def _optional_text(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def describe_invocation(invocation: Invocation) -> dict[str, Any]:
    """A log-safe description of one invocation (Req 15.4).

    Every credential is rendered as a presence marker — `"<set:40chars>"` — so no
    character of one reaches a log line. `tenant_id` and `client_id` get the same
    treatment even though they are not registered as scrub patterns: they are
    per-customer identifiers the web app strips from every relayed event (Req 15.6), and
    a log line is no better a place for them.
    """
    context = invocation.context
    return {
        "command": invocation.command,
        "actor_id": invocation.actor_id,
        "run_id": invocation.run_id,
        "session_id": invocation.session_id,
        "subscription_id": context.get("subscription_id"),
        "timezone": context.get("timezone"),
        "fidelity_tier": context.get("fidelity_tier"),
        "tenant_id": presence_marker(_optional_text(context.get("tenant_id"))),
        "client_id": presence_marker(_optional_text(context.get("client_id"))),
        "client_secret": presence_marker(_optional_text(context.get("client_secret"))),
        "progress_token": presence_marker(_optional_text(context.get("progress_token"))),
        "progress_url": _optional_text(context.get("progress_url")),
        "rejected": None if invocation.rejection is None else invocation.rejection.code,
    }


# --------------------------------------------------------------------------- #
# The command handlers — seams for tasks 6.2 and 11.9
# --------------------------------------------------------------------------- #

CommandHandler = Callable[["Invocation", StepTracker], AsyncIterator[Event]]
"""What a command handler is: it takes the parsed invocation and the invocation's step
tracker, and yields events. It does **not** emit — `emit` is called once, in the
entrypoint — and it does not construct `tool` or `progress` events by hand; it asks the
tracker for them, which is what keeps Req 14.8 enforced for a handler written later."""


async def handle_preflight(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    """Assert subscription-scope read, then probe fidelity (Req 12.1–12.13, 14.3).

    Two steps on the timeline and one outcome on `done`. The order is not cosmetic: the
    permissions assertion is a **gate**, so nothing else runs until it passes, and a
    `false` result raises `SCOPE_UNVERIFIED` from inside `azure/preflight.py` with the
    reason attached. The fidelity probe cannot fail the preflight — every unhappy path
    there records `baseline` — so it runs only once the connection is acceptable.

    `outcome` is seeded with the refusing answer to both questions **before** any Azure
    call, so every path out of here, including an exception nobody anticipated, leaves a
    `done` the app can read: `scope_verified: false` and `fidelity_tier: "baseline"` are
    what a preflight that did not prove otherwise means.

    The Azure import is **local to this function** on purpose. `azure/preflight.py` pulls
    in `azure-identity` (and, with a workspace id, `azure-monitor-query`), and an
    invocation that is not a preflight has no business paying for either.
    """
    from reporting_agent.azure.preflight import (  # see the docstring
        FIDELITY_BASELINE,
        build_preflight_service,
    )

    invocation.outcome["scope_verified"] = False
    invocation.outcome["fidelity_tier"] = FIDELITY_BASELINE

    service = build_preflight_service(invocation.context)
    try:
        permissions = steps.start(
            TOOL_PREFLIGHT_PERMISSIONS,
            label="Permissions",
            status="Asserting read at subscription scope",
        )
        yield permissions
        # Returns True or raises: `SCOPE_UNVERIFIED` for an unproven scope (Req 12.3,
        # 12.12), `AUTH_EXPIRED` for an expired secret (Req 12.13). Derived solely from
        # the permissions response — there is no inventory query in this command at all
        # (Req 12.4).
        invocation.outcome["scope_verified"] = await service.assert_subscription_read()
        yield steps.end(permissions["id"])

        fidelity = steps.start(
            TOOL_PREFLIGHT_FIDELITY,
            label="Fidelity",
            status="Probing for guest-observed counters",
        )
        yield fidelity
        invocation.outcome["fidelity_tier"] = await service.probe_fidelity()
        yield steps.end(fidelity["id"])
    finally:
        await service.aclose()

    logger.info(
        "preflight completed: scope_verified=%r fidelity_tier=%r",
        invocation.outcome["scope_verified"],
        invocation.outcome["fidelity_tier"],
    )


async def handle_generate_report(
    invocation: Invocation, steps: StepTracker
) -> AsyncIterator[Event]:
    """Run the collection pipeline: inventory, metrics, gates, snapshot (Req 14.2, 14.3).

    Everything about *how* a run is collected lives in `collect/pipeline.py`; this handler
    is the wiring. It hands the pipeline the parsed payload and context, this invocation's
    step tracker — so every `tool` and `progress` event still passes through the invariants
    :class:`StepTracker` owns (Req 14.7, 14.8) — its progress reporter, and the artifact
    bucket from the configuration read once at process start (Req 14.12).

    The pipeline yields exactly one `snapshot_ready` (Req 14.9), which is where this
    invocation's terminal callback reads `snapshot_id`, `resource_count` and `gap_count`
    from, and **raises** for every failed gate rather than emitting a terminal event of its
    own: the router below turns an `AgentError` into one `error` plus `done`, which is what
    keeps that translation in a single place (Req 18.8). A completed run carrying gaps
    raises the non-terminal `PartialCoverageError`, so the stream reads `snapshot_ready`,
    then `error` with `terminal: false`, then `done`, and the run's status is `completed`
    (Req 29.5).

    The import is **local to this function**, and not only for symmetry with
    `handle_preflight`: importing the pipeline at module scope would make `main` and
    `collect/pipeline` a cycle, since the pipeline reaches this module's step vocabulary
    through a structural protocol precisely to avoid importing it back.
    """
    from reporting_agent.collect.pipeline import run_generate_report

    async for event in run_generate_report(
        payload=invocation.payload,
        context=invocation.context,
        steps=steps,
        artifact_bucket=CONFIG.artifact_bucket,
        aws_region=CONFIG.aws_region,
        progress=invocation.progress,
    ):
        yield event


COMMAND_HANDLERS: Final[dict[str, CommandHandler]] = {
    COMMAND_GENERATE_REPORT: handle_generate_report,
    COMMAND_PREFLIGHT: handle_preflight,
}


# --------------------------------------------------------------------------- #
# The router
# --------------------------------------------------------------------------- #

STATUS_COMPLETED: Final[str] = "completed"
STATUS_FAILED: Final[str] = "failed"


async def run_invocation(
    invocation: Invocation,
    *,
    handlers: Mapping[str, CommandHandler] | None = None,
) -> AsyncIterator[Event]:
    """Route one invocation and yield its events, `done` last (Req 14.10).

    `handlers` is injectable so a test can drive the router over a fake phase without
    mutating the module registry. Production passes nothing.

    The terminal tail — close every open step, fire the terminal progress callback, emit
    `done` — is in a `finally`, so it runs whether the phase returned, raised an
    `AgentError`, or raised something nobody anticipated (Req 14.14).
    """
    table = COMMAND_HANDLERS if handlers is None else handlers
    steps = StepTracker()
    status = STATUS_FAILED
    error_code: str | None = None
    error_message: str | None = None
    completion: dict[str, Any] = {}
    closing = False

    try:
        if invocation.rejection is not None:
            code, message = invocation.rejection
            error_code, error_message = code, message
            yield _error_event(code, message, terminal=True)
            return

        handler = table.get(invocation.command or "")
        if handler is None:
            # Belt and braces: `parse_invocation` rejects an unrecognised command, so this
            # is reachable only for a command in COMMANDS with no handler registered.
            error_code = CODE_UNSUPPORTED_COMMAND
            error_message = f"no handler is registered for {invocation.command!r}."
            yield _error_event(error_code, error_message, terminal=True)
            return

        seen_snapshot = False
        async for event in handler(invocation, steps):
            kind = _screen(event)

            if kind == TERMINAL_EVENT_TYPE:
                # `done` belongs to the tail below, which is the only thing that may end
                # an invocation. A handler emitting its own would leave the tracker's
                # steps and the terminal callback stranded behind an event the client
                # treats as final.
                raise EmissionError(
                    "a command handler offered a `done` event; the terminal event is "
                    "emitted by the router, once, after every step is closed (Req 14.10)."
                )

            if kind == "snapshot_ready":
                if seen_snapshot:
                    # Req 14.9 — exactly one per invocation. The snapshot is already
                    # written, so a duplicate event is cosmetic: drop it and say so,
                    # rather than failing a run that succeeded.
                    logger.warning(
                        "a second `snapshot_ready` was offered for this invocation and "
                        "has been dropped; exactly one is emitted (Req 14.9)."
                    )
                    continue
                seen_snapshot = True
                completion = _completion_fields(event)

            yield event

        status = STATUS_COMPLETED

    except (asyncio.CancelledError, GeneratorExit, KeyboardInterrupt, SystemExit):
        # The consumer went away or the process is going down. Yielding from the `finally`
        # in that state is a `RuntimeError`, and there is nobody left to read it anyway.
        closing = True
        raise
    except AgentError as exc:
        error_code, error_message = exc.code.value, exc.message
        status = STATUS_FAILED if exc.terminal else STATUS_COMPLETED
        logger.warning("the run reported %s: %s", exc.code.value, scrub_exception(exc))
        yield _error_event(exc.code.value, exc.message, terminal=exc.terminal)
    except (CommandUnimplementedError, EmissionError, StepInvariantError) as exc:
        # A defect in this runtime's own wiring or emission — an unfilled seam, an event
        # type with no emitter, an orphan `progress` — rather than a fact about a
        # customer's subscription. The message is our own text and quotes no customer
        # data, so it travels in the event, where it is actionable.
        error_code = (
            CODE_COMMAND_UNIMPLEMENTED
            if isinstance(exc, CommandUnimplementedError)
            else CODE_INTERNAL_ERROR
        )
        error_message = str(exc)
        logger.error("%s", scrub_exception(exc))
        yield _error_event(error_code, error_message, terminal=True)
    except Exception as exc:  # the client is owed a terminal event
        error_code = CODE_INTERNAL_ERROR
        # The scrubbed traceback goes to the log; the event carries the exception's name
        # and nothing else. A stack frame is a debugging aid, not something to relay to a
        # browser, and Req 15.5's scrub covers both paths.
        logger.error(
            "the invocation failed with an unhandled %s: %s",
            type(exc).__name__,
            scrub_exception(exc),
        )
        error_message = (
            f"The run failed with an unexpected {type(exc).__name__}. The failure is "
            f"recorded in the runtime log."
        )
        yield _error_event(error_code, error_message, terminal=True)
    finally:
        if not closing:
            # Req 14.14 — a step left open by a phase that raised is closed here, before
            # `done`, so no activity step spins forever.
            for event in steps.close_all():
                yield event

            await _report_terminal(
                invocation,
                status=status,
                error_code=error_code,
                error_message=error_message,
                completion=completion,
            )

            # Req 14.10 — last, on every path. `merge_with_heartbeat` stops reading here,
            # so nothing follows it, not even a keep-alive already queued.
            yield _done_event(invocation.run_id, status, invocation.outcome)


def _screen(event: object) -> str:
    """The type of one handler-produced event, refusing anything unemittable.

    `emit` refuses the same set, and the duplication is deliberate: `emit` is the
    structural backstop on the way out of the process, while this runs **inside** the
    router's `try`, so a handler that offered a `verification` or a `report_file`
    (Req 14.11) produces a terminal `error` and a `done` rather than an `EmissionError`
    escaping the entrypoint and truncating the stream.
    """
    if not isinstance(event, Mapping):
        raise EmissionError(
            f"a command handler yielded {type(event).__name__}, not an event mapping."
        )

    kind = event.get("type")
    if not is_declared_event_type(kind):
        raise EmissionError(f"{kind!r} is not a declared event type (Req 14.15).")
    if kind not in EMITTED_BY_FOUNDATION:
        raise EmissionError(
            f"{kind!r} has no emitter in this spec's runtime (Req 14.11); "
            f"`verification` and `report_file` in particular are never emitted here."
        )
    return str(kind)


def _completion_fields(event: Mapping[str, Any]) -> dict[str, Any]:
    """The terminal callback's `completed` fields, read off `snapshot_ready`.

    Taken from the event rather than passed separately, because the event and the callback
    must agree about what was collected and two sources of one number is how they stop
    agreeing.
    """
    gaps = event.get("gaps")
    counted = isinstance(gaps, Sequence) and not isinstance(gaps, (str, bytes))
    return {
        "snapshot_id": _optional_text(event.get("snapshot_id")),
        "resource_count": event.get("resource_count"),
        "gap_count": len(gaps) if counted else None,
    }


async def _report_terminal(
    invocation: Invocation,
    *,
    status: str,
    error_code: str | None,
    error_message: str | None,
    completion: Mapping[str, Any],
) -> None:
    """Fire the awaited terminal progress callback (Req 38.4, 38.12).

    Awaited, not fire-and-forget: the container is about to exit, and an unsent terminal
    callback is a successful run the Reaper will fail as `TIMEOUT`. The reporter never
    raises and is a no-op when this invocation carries no run.
    """
    reporter = invocation.progress
    if reporter is None:
        return

    if status == STATUS_COMPLETED:
        await reporter.report_terminal(STATUS_COMPLETED, **dict(completion))
        return

    await reporter.report_terminal(
        STATUS_FAILED,
        error_code=_row_error_code(error_code),
        error_message=error_message,
    )


def _row_error_code(code: str | None) -> str | None:
    """The code the run row may carry, or `None`.

    An invocation-level code (`MISSING_COMMAND`, `INVALID_ACTOR`, …) is not in the set the
    progress endpoint accepts, so presenting one would have the whole callback refused —
    and losing the callback costs a false `TIMEOUT` on a run whose outcome is already
    known. The phase transition matters more than the label, so an unpresentable code is
    dropped and the transition still lands.
    """
    if code is None:
        return None
    try:
        return ErrorCode(code).value
    except ValueError:
        logger.info(
            "error code %r describes the invocation rather than the collection, so it is "
            "not presented on the terminal callback; the `failed` transition still lands.",
            code,
        )
        return None


# --------------------------------------------------------------------------- #
# The entrypoint
# --------------------------------------------------------------------------- #

app = BedrockAgentCoreApp()


@app.entrypoint
async def invoke(payload: object, context: object = None) -> AsyncIterator[Event]:
    """Yield this invocation's SSE events (Req 14.1).

    The second parameter must be named `context`: that is how `BedrockAgentCoreApp`
    decides whether to hand the handler its request context, and the request context is
    the second source Req 14.6 resolves a session id from.
    """
    invocation = parse_invocation(payload, context)

    # Req 15.2 — again, now the context is parsed, so a handler installed after process
    # start is filtered too. Idempotent, so this adds no second filter.
    install_log_redaction()
    logger.info("invocation accepted: %r", describe_invocation(invocation))

    try:
        async for event in merge_with_heartbeat(run_invocation(invocation)):
            yield emit(event)
    finally:
        # Req 15.10 — the registry is per invocation. `done` has already been scrubbed and
        # yielded by the time this runs, so teardown cannot leave a later event unscrubbed,
        # and one invocation's secrets never scrub another's output.
        discard_secrets()


def main() -> None:
    """`python -m reporting_agent.main` — what the container's CMD runs."""
    app.run()


# Contradictions worth catching at import rather than at the first invocation.
assert COMMANDS == frozenset(COMMAND_HANDLERS), COMMANDS
assert FOUNDATION_TOOL_NAMES <= KNOWN_TOOL_NAMES
assert not INVOCATION_ERROR_CODES & frozenset(code.value for code in ErrorCode), (
    "Req 14.4 — an invocation-level code must be distinct from every collection-phase "
    "code, so a refused payload cannot be read as a failed collection."
)
assert not INVOCATION_ERROR_CODES & APP_WRITTEN_CODES, (
    "TIMEOUT and SECRET_UNREADABLE are written by the web app; no code emitted here may "
    "collide with either."
)
assert {STATUS_COMPLETED, STATUS_FAILED} == TERMINAL_PHASES
assert STATUS_COMPLETED in AGENT_PHASES and STATUS_FAILED in AGENT_PHASES
assert not {"verification", "report_file"} & EMITTED_BY_FOUNDATION, EMITTED_BY_FOUNDATION
assert SESSION_ID_MIN_LENGTH <= len(derive_session_id("actor")) <= SESSION_ID_MAX_LENGTH

if __name__ == "__main__":  # pragma: no cover - the container entrypoint
    main()
