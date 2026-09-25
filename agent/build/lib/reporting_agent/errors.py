"""The run error vocabulary and its typed exceptions.

One code per way a run can end badly, classified exactly as the requirements glossary
classifies them, plus the exception that carries each one out of the collector.

**Terminal versus non-terminal is a property of the code, not of the moment.** The
glossary calls `THROTTLED` non-terminal because the class is *retryable* — a
re-submitted run has a real chance of succeeding — even though the run that raised it
does fail. Those are two different facts, so they are two different attributes here:
`retryable` on the class, `terminal` on the instance. Collapsing them into one boolean
is how a retryable failure ends up presented as permanent.

**`TIMEOUT` and `SECRET_UNREADABLE` are absent on purpose (Req 36.6, 38.11, 41.10).**
Both are written by the web app:

* `TIMEOUT` comes from the Reaper's deadline sweep. By definition the container may
  already be gone, so an agent claiming its own timeout is claiming something it
  cannot have observed — which is exactly why the progress endpoint rejects a
  presented `TIMEOUT` outright.
* `SECRET_UNREADABLE` comes from the tick, when decryption fails while building the
  invoke payload. No invocation is made, so no agent process exists to raise it.

Neither is an `ErrorCode` member, so `AgentError` has no subclass able to carry one
and `exception_for` refuses both by name. The absence is the enforcement.
"""

from __future__ import annotations

from enum import StrEnum
from typing import ClassVar, Final

__all__ = [
    "APP_WRITTEN_CODES",
    "NON_TERMINAL_CODES",
    "ROW_ERROR_CODES",
    "RUNTIME_DEFECT_CODE",
    "TERMINAL_CODES",
    "AgentError",
    "AuthExpiredError",
    "AuthFailedError",
    "CatalogUnusableError",
    "CompileFailedError",
    "EmptyScopeError",
    "ErrorCode",
    "NoStatisticsError",
    "PartialCoverageError",
    "PdfConversionFailedError",
    "RegionUnreachableError",
    "RenderFailedError",
    "ReplayMismatchError",
    "ScopeUnverifiedError",
    "TemplateInvalidError",
    "ThrottledError",
    "VerificationFailedError",
    "exception_for",
]


class ErrorCode(StrEnum):
    """Every code the **agent** can report. A `StrEnum` so the member serializes into
    an event and a callback body as its own string with no conversion step."""

    # --- Terminal: the run is over and re-running changes nothing by itself. ------
    AUTH_EXPIRED = "AUTH_EXPIRED"
    AUTH_FAILED = "AUTH_FAILED"
    SCOPE_UNVERIFIED = "SCOPE_UNVERIFIED"
    EMPTY_SCOPE = "EMPTY_SCOPE"
    CATALOG_UNUSABLE = "CATALOG_UNUSABLE"
    NO_STATISTICS = "NO_STATISTICS"

    # --- Terminal, one per document phase (Req 41.2). Appended, never reordered:
    # the app's `run_error_code` enum grows by `ALTER TYPE ... ADD VALUE`, so this
    # block and that enum stay in one order by only ever gaining members here.
    TEMPLATE_INVALID = "TEMPLATE_INVALID"
    COMPILE_FAILED = "COMPILE_FAILED"
    RENDER_FAILED = "RENDER_FAILED"
    PDF_CONVERSION_FAILED = "PDF_CONVERSION_FAILED"
    VERIFICATION_FAILED = "VERIFICATION_FAILED"
    REPLAY_MISMATCH = "REPLAY_MISMATCH"

    # --- Non-terminal: retryable, or a gap, or a completed run with detail. -------
    THROTTLED = "THROTTLED"
    PARTIAL_COVERAGE = "PARTIAL_COVERAGE"
    REGION_UNREACHABLE = "REGION_UNREACHABLE"


TERMINAL_CODES: Final[frozenset[ErrorCode]] = frozenset(
    {
        ErrorCode.AUTH_EXPIRED,
        ErrorCode.AUTH_FAILED,
        ErrorCode.SCOPE_UNVERIFIED,
        ErrorCode.EMPTY_SCOPE,
        ErrorCode.CATALOG_UNUSABLE,
        ErrorCode.NO_STATISTICS,
        ErrorCode.TEMPLATE_INVALID,
        ErrorCode.COMPILE_FAILED,
        ErrorCode.RENDER_FAILED,
        ErrorCode.PDF_CONVERSION_FAILED,
        ErrorCode.VERIFICATION_FAILED,
        ErrorCode.REPLAY_MISMATCH,
    }
)

NON_TERMINAL_CODES: Final[frozenset[ErrorCode]] = frozenset(
    {
        ErrorCode.THROTTLED,
        ErrorCode.PARTIAL_COVERAGE,
        ErrorCode.REGION_UNREACHABLE,
    }
)

# Written by the web app, never by this process. Kept as plain strings precisely
# because there is no `ErrorCode` member to reference.
APP_WRITTEN_CODES: Final[frozenset[str]] = frozenset({"TIMEOUT", "SECRET_UNREADABLE"})

RUNTIME_DEFECT_CODE: Final[str] = "INTERNAL_ERROR"
"""The row code for a failure in this runtime rather than in the customer's data.

Deliberately **not** an `ErrorCode` member. Req 14.4 keeps every invocation-level code
distinct from every collection-phase code, so that a refused payload can never be read
as a failed collection, and `main.py` asserts that disjointness at import. This is the
one invocation-level code that must also reach `report_runs.error_code`, and it gets
there by being named here as a plain string — the same device `APP_WRITTEN_CODES` uses
for the same reason.

## Why it has to be writable at all

`main._row_error_code` used to drop a code the row could not accept and send the
`failed` transition without one, on the stated reasoning that the transition mattered
more than the label. That reasoning was wrong, and provably so: the progress endpoint
refuses a `failed` transition carrying no code (`missing_error_code`, Req 38.11, which
is also the CHECK constraint's precondition). Dropping the code did not save the
transition — it guaranteed the transition was refused, the row stayed in its phase, and
the Reaper wrote `TIMEOUT` half an hour later over a run that had already failed in
seconds. An unhandled `TypeError` in the document phase reported itself to an operator
as a timeout, which is the single most misleading thing the state machine can say.

So the five invocation-level codes all present as this one. The specific code still
travels in the `error` event and in the log, where it is actionable; the row records
the honest general fact, which is that the runtime failed for a reason that is our
defect rather than anything about the subscription.
"""

# The set `report_runs.error_code` accepts on a failed row (Req 36.6, extended
# additively by Req 41.2 and by the runtime-defect code above), which is every agent
# code except `PARTIAL_COVERAGE`, plus the two app-written ones.
#
# `PARTIAL_COVERAGE` is excluded deliberately: a run with gaps completes (Req 29.5).
# It travels as an `error` event carrying `terminal` false and is **never** a row
# `error_code`, because a completed run with a recorded, visible gap list is an honest
# result rather than a failure.
ROW_ERROR_CODES: Final[frozenset[str]] = (
    frozenset(
        code.value for code in ErrorCode if code is not ErrorCode.PARTIAL_COVERAGE
    )
    | APP_WRITTEN_CODES
    | {RUNTIME_DEFECT_CODE}
)


class AgentError(Exception):
    """Base for every failure that carries an `ErrorCode`.

    Subclasses declare the code and whether an instance ends the run. The base is not
    instantiable: an error without a code cannot be reported, and defaulting one would
    put the choice of code in an exception handler rather than at the failure site.
    """

    code: ClassVar[ErrorCode]
    """The code reported to the app. Declared by every subclass."""

    default_terminal: ClassVar[bool]
    """Whether raising this ends the run, absent an explicit override."""

    escalatable: ClassVar[bool] = False
    """Whether an instance may depart from `default_terminal`. True only where a
    requirement describes both outcomes for one code — `REGION_UNREACHABLE` is a gap
    per resource (Req 24.4) but fails the run when *every* location is unreachable
    (Req 24.5)."""

    retryable: ClassVar[bool] = False
    """Whether re-running has a real chance of succeeding without any change. True
    only for `THROTTLED`; there is no automatic retry loop in the foundation, so this
    informs the surface shown to the user rather than a control flow."""

    def __init__(self, message: str, *, terminal: bool | None = None) -> None:
        cls = type(self)

        # `code` is an annotation on the base and a value on every subclass, so this
        # is False for `AgentError` itself and True for anything usable.
        if not hasattr(cls, "code"):
            raise TypeError(
                f"{cls.__name__} declares no error code; instantiate a subclass that "
                f"does rather than AgentError itself."
            )

        resolved = cls.default_terminal if terminal is None else bool(terminal)

        if resolved is not cls.default_terminal and not cls.escalatable:
            raise ValueError(
                f"{cls.__name__} carries terminal={cls.default_terminal!r} and cannot "
                f"be constructed with terminal={resolved!r}."
            )

        super().__init__(message)

        self.message = message
        self.terminal: bool = resolved

    def __repr__(self) -> str:
        return (
            f"{type(self).__name__}(code={self.code.value!r}, "
            f"terminal={self.terminal!r}, message={self.message!r})"
        )


class AuthExpiredError(AgentError):
    """The Azure client secret has expired (Req 12.13, 13.5). Distinct from
    `AuthFailedError` because the fix is a rotation, not a correction."""

    code = ErrorCode.AUTH_EXPIRED
    default_terminal = True


class AuthFailedError(AgentError):
    """Azure rejected the client id or secret for a reason other than expiry
    (Req 19.6)."""

    code = ErrorCode.AUTH_FAILED
    default_terminal = True


class ScopeUnverifiedError(AgentError):
    """The permissions preflight did not prove read at **subscription** scope
    (Req 12.3, 12.12). A resource-group assignment returns an RBAC-filtered inventory
    that would otherwise report full coverage of a partial subscription."""

    code = ErrorCode.SCOPE_UNVERIFIED
    default_terminal = True


class EmptyScopeError(AgentError):
    """Inventory resolved zero resources (Req 33.1), raised before any metrics request
    and before any artifact write.

    Zero resources means zero figures, which means zero unverifiable figures — a clean
    pass on every other gate and a worthless artifact. This gate is what stops an
    expired secret or an over-narrow Reader assignment from shipping a
    fully-verified, empty report."""

    code = ErrorCode.EMPTY_SCOPE
    default_terminal = True


class CatalogUnusableError(AgentError):
    """Catalog validation left zero valid entries for every in-scope resource type
    (Req 32.7). An internal configuration failure, not a customer-side one."""

    code = ErrorCode.CATALOG_UNUSABLE
    default_terminal = True


class NoStatisticsError(AgentError):
    """At least one resource resolved and collection produced zero statistics across
    every resource and every metric (Req 33.7). Distinct from `EMPTY_SCOPE`: resources
    were found, nothing was measurable."""

    code = ErrorCode.NO_STATISTICS
    default_terminal = True


class TemplateInvalidError(AgentError):
    """The **pinned** template version failed validation at compile time (Req 2.8),
    naming every failing field path.

    Reaching this at all means a definition the app was willing to save is one the
    compiler refuses, so it is also the signal that the two block-config schemas have
    drifted — a save-time validation error deferred into a failed run minutes later."""

    code = ErrorCode.TEMPLATE_INVALID
    default_terminal = True


class CompileFailedError(AgentError):
    """Compiling the pinned definition against the snapshot failed (Req 17.10, 18.9),
    naming the AST path and the block.

    Emits no partial AST and writes no artifact: a document assembled from the blocks
    that happened to compile is a document whose missing section is indistinguishable
    from one that was never configured."""

    code = ErrorCode.COMPILE_FAILED
    default_terminal = True


class RenderFailedError(AgentError):
    """`.docx` emission failed (Req 20.9, 20.12) — including a theme document missing a
    style the compiled blocks reference, which names **every** missing style rather than
    the first so one fix pass clears the render."""

    code = ErrorCode.RENDER_FAILED
    default_terminal = True


class PdfConversionFailedError(AgentError):
    """Converting the produced `.docx` to `.pdf` failed (Req 23.6, 23.8).

    Terminal even though a `.docx` exists, and that is the point: the pair is delivered
    together or not at all, because a Word file whose PDF could not be produced from it
    is a pair whose halves have never been shown to agree."""

    code = ErrorCode.PDF_CONVERSION_FAILED
    default_terminal = True


class VerificationFailedError(AgentError):
    """The rendered document and the snapshot disagree (Req 25.2) — any blocking
    finding, an unreadable document, an underivable allowlist, or a verification that
    terminated early.

    There is no "verification failed but here it is anyway" path: this is the code that
    withholds the artifact rather than annotating it."""

    code = ErrorCode.VERIFICATION_FAILED
    default_terminal = True


class ReplayMismatchError(AgentError):
    """Re-running the pure aggregation over the archived raw responses produced a digest
    differing from the stored `snapshot_id` (Req 31.3).

    Distinct from `VERIFICATION_FAILED`: the document may match the snapshot perfectly
    and the snapshot still not be reproducible from its own inputs, which is a failure
    of determinism rather than of transcription."""

    code = ErrorCode.REPLAY_MISMATCH
    default_terminal = True


class ThrottledError(AgentError):
    """Azure rate limits were exhausted after the waits were honoured — a required 4th
    consecutive Resource Graph quota wait (Req 20.14), or 5 consecutive 429s each
    having honoured `Retry-After` (Req 23.9).

    The run fails, so instances are terminal; the **class** is retryable, so the UI
    offers a re-run rather than presenting a permanent failure."""

    code = ErrorCode.THROTTLED
    default_terminal = True
    retryable = True


class RegionUnreachableError(AgentError):
    """A location has no metrics data-plane host and the per-resource ARM fallback also
    failed (Req 24.4).

    Non-terminal by default: the location's resources each take a `region_unreachable`
    gap and the run continues, because a silently dropped region is a silently
    incomplete report. Constructed with `terminal=True` only when **every** location in
    the run resolves unreachable (Req 24.5), at which point there is nothing left to
    collect."""

    code = ErrorCode.REGION_UNREACHABLE
    default_terminal = False
    escalatable = True


class PartialCoverageError(AgentError):
    """The run completed with at least one recorded gap (Req 29.5).

    Not a failure: the run's `status` is `completed` and this travels as an `error`
    event carrying `terminal` false, before `done`. It is deliberately not
    escalatable — a report with visible gaps is the honest outcome this whole
    vocabulary exists to make possible, so no caller may promote it."""

    code = ErrorCode.PARTIAL_COVERAGE
    default_terminal = False


_EXCEPTION_BY_CODE: Final[dict[ErrorCode, type[AgentError]]] = {
    ErrorCode.AUTH_EXPIRED: AuthExpiredError,
    ErrorCode.AUTH_FAILED: AuthFailedError,
    ErrorCode.SCOPE_UNVERIFIED: ScopeUnverifiedError,
    ErrorCode.EMPTY_SCOPE: EmptyScopeError,
    ErrorCode.CATALOG_UNUSABLE: CatalogUnusableError,
    ErrorCode.NO_STATISTICS: NoStatisticsError,
    ErrorCode.TEMPLATE_INVALID: TemplateInvalidError,
    ErrorCode.COMPILE_FAILED: CompileFailedError,
    ErrorCode.RENDER_FAILED: RenderFailedError,
    ErrorCode.PDF_CONVERSION_FAILED: PdfConversionFailedError,
    ErrorCode.VERIFICATION_FAILED: VerificationFailedError,
    ErrorCode.REPLAY_MISMATCH: ReplayMismatchError,
    ErrorCode.THROTTLED: ThrottledError,
    ErrorCode.PARTIAL_COVERAGE: PartialCoverageError,
    ErrorCode.REGION_UNREACHABLE: RegionUnreachableError,
}


def exception_for(code: ErrorCode | str) -> type[AgentError]:
    """Resolve the exception class carrying `code`.

    Raises `ValueError` for `TIMEOUT` and `SECRET_UNREADABLE` with the reason stated,
    because both are written by the app and no agent-side exception exists for either.
    """
    key = code.value if isinstance(code, ErrorCode) else str(code)

    if key in APP_WRITTEN_CODES:
        raise ValueError(
            f"{key} is written by the web app, not by the agent, so no agent-side "
            f"exception carries it. TIMEOUT comes from the Reaper's deadline sweep and "
            f"SECRET_UNREADABLE from the tick's decryption failure; in both cases this "
            f"process either does not exist or cannot have observed the fact."
        )

    if key not in _CODE_VALUES:
        raise ValueError(f"{key!r} is not a declared agent error code.")

    return _EXCEPTION_BY_CODE[ErrorCode(key)]


_CODE_VALUES: Final[frozenset[str]] = frozenset(code.value for code in ErrorCode)

# Collection-time guards. Each one fails an edit that leaves the vocabulary
# inconsistent, at import, rather than at the moment a run tries to report a code.
assert TERMINAL_CODES | NON_TERMINAL_CODES == set(ErrorCode)
assert not TERMINAL_CODES & NON_TERMINAL_CODES
assert not _CODE_VALUES & APP_WRITTEN_CODES
assert set(_EXCEPTION_BY_CODE) == set(ErrorCode)
assert all(exc.code is code for code, exc in _EXCEPTION_BY_CODE.items())
assert all(
    exc.default_terminal
    for code, exc in _EXCEPTION_BY_CODE.items()
    if code in TERMINAL_CODES
)

# The foundation's ten (Req 36.6), the six document-phase codes (Req 41.2), and the
# runtime-defect code. Stated as a count rather than derived, so appending a member
# without appending the matching `run_error_code` value fails here instead of at the
# write that the column refuses.
assert len(ROW_ERROR_CODES) == 17

# The runtime-defect code is a row code but **not** a collection-phase one: Req 14.4
# keeps the invocation-level codes disjoint from `ErrorCode`, and `main.py` asserts that
# disjointness. Both facts have to hold at once, so both are checked here — the second
# is what stops a future edit from "simplifying" this into an `ErrorCode` member and
# silently making a refused payload indistinguishable from a failed collection.
assert RUNTIME_DEFECT_CODE in ROW_ERROR_CODES
assert RUNTIME_DEFECT_CODE not in _CODE_VALUES
