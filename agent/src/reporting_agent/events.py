"""The SSE event vocabulary — one contract, expressed in two languages.

The declaration below is mirrored in `app/lib/events.ts`, and a static guard in the
web test suite (`app/test/event-mirror.static.test.ts`) extracts the quoted strings
from between the sentinel comments in both files and compares the two sets
(Req 40.13). That is why the literals sit on their own, between sentinels, rather
than inside an `Enum` or a class: the guard needs neither a Python parser nor a
TypeScript parser, so the guard itself cannot drift from what it guards.

**The full vocabulary is declared; a subset is emitted.** This spec drives six of the
ten types. `delta`, `chart`, `verification` and `report_file` belong to the specs that
add prose, charts and the compile/render/verify pipeline — those specs add *emitters*,
not vocabulary, so the mirror never has to be renegotiated (Req 14.11 with 40.13), and
a client that meets an unhandled type ignores it and keeps reading (Req 40.6).

Nothing here emits. `main.py` owns the single egress function every event passes
through, and `EVENT_TYPES` is what it validates a `type` field against (Req 14.15).
"""

from typing import Final

# --- BEGIN EVENT TYPES (mirrored in app/lib/events.ts) ---
EVENT_TYPES: Final[tuple[str, ...]] = (
    "delta",
    "tool",
    "progress",
    "heartbeat",
    "snapshot_ready",
    "chart",
    "verification",
    "report_file",
    "error",
    "done",
)
# --- END EVENT TYPES ---

# The six types this spec's runtime actually emits (Req 14.11). Deliberately outside
# the sentinels: the mirror guard reads every quoted string between them, so a second
# list of type names inside would fail the comparison against the TypeScript side.
#
# `verification` and `report_file` are absent on purpose — no document is produced
# here, so neither may ever be emitted, and the ordering guarantee that a
# `report_file` never arrives without a passing `verification` before it cannot be
# violated by a runtime that emits neither.
EMITTED_BY_FOUNDATION: Final[frozenset[str]] = frozenset(
    {"tool", "progress", "heartbeat", "snapshot_ready", "error", "done"}
)

# The terminal event, and the only one permitted to be last (Req 14.10).
TERMINAL_EVENT_TYPE: Final[str] = "done"

# The keep-alive type, named here so `heartbeat.py` imports it instead of re-declaring
# the literal — one spelling of the string, in the module that owns the vocabulary.
# Deliberately outside the sentinels for the same reason TERMINAL_EVENT_TYPE is: the
# mirror guard reads *every* quoted string between them, so a second occurrence of
# "heartbeat" inside would fail the comparison against the TypeScript side.
HEARTBEAT_EVENT_TYPE: Final[str] = "heartbeat"

# The two `tool` step names this spec drives (Req 14.7). Declared here rather than in
# `main.py` because two modules consume them — `main.py`, which owns the step vocabulary
# the timeline renders, and `collect/pipeline.py`, which opens the steps — and a step name
# spelled twice is a step the UI renders as two different things. Outside the sentinels:
# these are not event *types*, so the TypeScript mirror does not carry them.
TOOL_COLLECT_INVENTORY: Final[str] = "collect_inventory"
TOOL_COLLECT_METRICS: Final[str] = "collect_metrics"

# The four the document phases drive. Same reasoning: two modules consume each name —
# `report_pipeline.py`, which opens the step, and the timeline that renders it — and a step
# name spelled twice is a step the UI renders as two different things.
TOOL_COMPILE_FIGURES: Final[str] = "compile_figures"
TOOL_RENDER_DOCUMENT: Final[str] = "render_document"
TOOL_VERIFY_DOCUMENT: Final[str] = "verify_document"
TOOL_UPLOAD_ARTIFACT: Final[str] = "upload_artifact"

# Every type the **document** pipeline emits (Req 42.1). All ten, because this spec adds the
# four the foundation deliberately left unemitted — and it adds emitters, not vocabulary, so
# `EVENT_TYPES` and `app/lib/events.ts` are untouched and the cross-language mirror guard
# never has to be renegotiated. Outside the sentinels, like every other non-vocabulary name
# here: the guard reads every quoted string between them.
#
# **Named rather than derived from `EVENT_TYPES`.** `frozenset(EVENT_TYPES)` would make the
# equality assertion below a tautology, and an eleventh vocabulary type would then be
# silently claimed as emitted by a pipeline that has no emitter for it. Spelled out, the
# assertion is the question "did you write the emitter?" asked at import.
EMITTED_BY_REPORT_PIPELINE: Final[frozenset[str]] = frozenset(
    {
        "delta",
        "tool",
        "progress",
        "heartbeat",
        "snapshot_ready",
        "chart",
        "verification",
        "report_file",
        "error",
        "done",
    }
)

PROGRESS_UNIT_BLOCKS: Final[str] = "blocks"


def is_declared_event_type(value: object) -> bool:
    """Is `value` one of the declared event types (Req 14.15)?"""
    return isinstance(value, str) and value in EVENT_TYPES


# A declaration that contradicts itself is worth catching at import rather than at the
# first emission: EMITTED_BY_FOUNDATION is a subset of the vocabulary, and no type is
# declared twice.
assert EMITTED_BY_FOUNDATION <= frozenset(EVENT_TYPES), EMITTED_BY_FOUNDATION
assert len(set(EVENT_TYPES)) == len(EVENT_TYPES), EVENT_TYPES
assert TERMINAL_EVENT_TYPE in EMITTED_BY_FOUNDATION, TERMINAL_EVENT_TYPE
assert HEARTBEAT_EVENT_TYPE in EMITTED_BY_FOUNDATION, HEARTBEAT_EVENT_TYPE
assert HEARTBEAT_EVENT_TYPE != TERMINAL_EVENT_TYPE
assert EMITTED_BY_FOUNDATION < EMITTED_BY_REPORT_PIPELINE, EMITTED_BY_REPORT_PIPELINE
assert EMITTED_BY_REPORT_PIPELINE == frozenset(EVENT_TYPES), EMITTED_BY_REPORT_PIPELINE
