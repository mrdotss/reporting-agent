"""The error vocabulary: its partition, its typed exceptions, and the two codes the
agent must be structurally unable to raise (Req 36.6)."""

from __future__ import annotations

import pytest

from reporting_agent import errors
from reporting_agent.errors import (
    APP_WRITTEN_CODES,
    NON_TERMINAL_CODES,
    ROW_ERROR_CODES,
    TERMINAL_CODES,
    AgentError,
    AuthExpiredError,
    AuthFailedError,
    CatalogUnusableError,
    CompileFailedError,
    EmptyScopeError,
    ErrorCode,
    NoStatisticsError,
    PartialCoverageError,
    PdfConversionFailedError,
    RegionUnreachableError,
    RenderFailedError,
    ReplayMismatchError,
    ScopeUnverifiedError,
    TemplateInvalidError,
    ThrottledError,
    VerificationFailedError,
    exception_for,
)


def _all_agent_error_subclasses() -> set[type[AgentError]]:
    found: set[type[AgentError]] = set()

    def walk(cls: type[AgentError]) -> None:
        for subclass in cls.__subclasses__():
            found.add(subclass)
            walk(subclass)

    walk(AgentError)
    return found


# --- the vocabulary ------------------------------------------------------------


def test_terminal_codes_are_the_twelve_the_agent_can_end_a_run_with() -> None:
    # Six from collection (Req 36.6) and six from the document phases (Req 41.2), which
    # were added additively — nothing the foundation declared was removed to make room.
    assert {code.value for code in TERMINAL_CODES} == {
        "AUTH_EXPIRED",
        "AUTH_FAILED",
        "SCOPE_UNVERIFIED",
        "EMPTY_SCOPE",
        "CATALOG_UNUSABLE",
        "NO_STATISTICS",
        "TEMPLATE_INVALID",
        "COMPILE_FAILED",
        "RENDER_FAILED",
        "PDF_CONVERSION_FAILED",
        "VERIFICATION_FAILED",
        "REPLAY_MISMATCH",
    }


def test_the_six_document_phase_codes_are_terminal() -> None:
    # Req 41.2 — each of the six is terminal, and none of them is retryable: a template
    # that does not validate, a document that does not verify and a snapshot that does
    # not replay are all unchanged by re-running the identical run.
    for code in (
        ErrorCode.TEMPLATE_INVALID,
        ErrorCode.COMPILE_FAILED,
        ErrorCode.RENDER_FAILED,
        ErrorCode.PDF_CONVERSION_FAILED,
        ErrorCode.VERIFICATION_FAILED,
        ErrorCode.REPLAY_MISMATCH,
    ):
        exception = exception_for(code)

        assert code in TERMINAL_CODES
        assert code not in NON_TERMINAL_CODES
        assert exception.default_terminal is True
        assert exception.escalatable is False
        assert exception.retryable is False


def test_non_terminal_codes_are_the_three_the_glossary_declares() -> None:
    assert {code.value for code in NON_TERMINAL_CODES} == {
        "THROTTLED",
        "PARTIAL_COVERAGE",
        "REGION_UNREACHABLE",
    }


def test_the_two_sets_partition_the_enum() -> None:
    assert TERMINAL_CODES | NON_TERMINAL_CODES == set(ErrorCode)
    assert not TERMINAL_CODES & NON_TERMINAL_CODES


def test_every_code_serializes_as_its_own_string() -> None:
    # A `StrEnum`, so a member drops straight into an event payload or a callback body.
    assert ErrorCode.EMPTY_SCOPE == "EMPTY_SCOPE"
    assert f"{ErrorCode.THROTTLED}" == "THROTTLED"


def test_row_error_codes_mirror_the_state_machine_set() -> None:
    # Req 36.6's ten values, Req 41.2's six, and the runtime-defect code, which is
    # exactly the value set of the app's `run_error_code` enum. `PARTIAL_COVERAGE` is
    # absent because a run with gaps completes; the two app-written codes are present
    # because the app writes them.
    #
    # Spelled out rather than derived from `ErrorCode`, deliberately: this is the one
    # assertion that would notice the Postgres enum and this module disagreeing, and a
    # derived expectation would restate whatever the module happens to declare. That is
    # also why `INTERNAL_ERROR` had to be added here by hand — it is not an `ErrorCode`
    # member, so no derivation would have produced it, and its absence from the enum
    # would go unnoticed by every other test in this file.
    assert ROW_ERROR_CODES == {
        "AUTH_EXPIRED",
        "AUTH_FAILED",
        "SCOPE_UNVERIFIED",
        "SECRET_UNREADABLE",
        "EMPTY_SCOPE",
        "CATALOG_UNUSABLE",
        "NO_STATISTICS",
        "REGION_UNREACHABLE",
        "THROTTLED",
        "TIMEOUT",
        "TEMPLATE_INVALID",
        "COMPILE_FAILED",
        "RENDER_FAILED",
        "PDF_CONVERSION_FAILED",
        "VERIFICATION_FAILED",
        "REPLAY_MISMATCH",
        "INTERNAL_ERROR",
    }
    assert "PARTIAL_COVERAGE" not in ROW_ERROR_CODES


# --- TIMEOUT and SECRET_UNREADABLE are not raisable here -----------------------


def test_app_written_codes_are_exactly_timeout_and_secret_unreadable() -> None:
    assert APP_WRITTEN_CODES == {"TIMEOUT", "SECRET_UNREADABLE"}


@pytest.mark.parametrize("name", sorted(APP_WRITTEN_CODES))
def test_app_written_code_is_not_an_error_code_member(name: str) -> None:
    # The absence is the enforcement: with no member there is nothing for an exception
    # to carry and nothing for a `code` argument to name.
    assert name not in {code.value for code in ErrorCode}
    assert name not in ErrorCode.__members__

    with pytest.raises(KeyError):
        ErrorCode[name]

    with pytest.raises(ValueError):
        ErrorCode(name)


@pytest.mark.parametrize("name", sorted(APP_WRITTEN_CODES))
def test_no_exception_class_carries_an_app_written_code(name: str) -> None:
    subclasses = _all_agent_error_subclasses()

    # Non-vacuity first. The walk has to reach every declared code, or a class added
    # without being reachable from `AgentError.__subclasses__()` would pass this by not
    # being looked at — and the six document-phase classes (Req 41.2) are the newest
    # arrivals, so this is what puts them under the refusal below rather than beside it.
    assert {subclass.code for subclass in subclasses} == set(ErrorCode)

    for subclass in subclasses:
        assert subclass.code.value != name


@pytest.mark.parametrize("name", sorted(APP_WRITTEN_CODES))
def test_exception_for_refuses_an_app_written_code_with_the_reason(name: str) -> None:
    with pytest.raises(ValueError) as raised:
        exception_for(name)

    message = str(raised.value)

    assert name in message
    assert "written by the web app" in message


def test_no_module_attribute_offers_an_app_written_code() -> None:
    # Catches a re-added `TIMEOUT = "TIMEOUT"` constant, or an exception named for one,
    # anywhere in the module — not only in the enum.
    for attribute in vars(errors):
        assert attribute not in {"TIMEOUT", "SECRET_UNREADABLE", "TimeoutError"}


# --- the typed exceptions -------------------------------------------------------


TERMINAL_EXCEPTIONS = [
    (AuthExpiredError, ErrorCode.AUTH_EXPIRED),
    (AuthFailedError, ErrorCode.AUTH_FAILED),
    (ScopeUnverifiedError, ErrorCode.SCOPE_UNVERIFIED),
    (EmptyScopeError, ErrorCode.EMPTY_SCOPE),
    (CatalogUnusableError, ErrorCode.CATALOG_UNUSABLE),
    (NoStatisticsError, ErrorCode.NO_STATISTICS),
    (TemplateInvalidError, ErrorCode.TEMPLATE_INVALID),
    (CompileFailedError, ErrorCode.COMPILE_FAILED),
    (RenderFailedError, ErrorCode.RENDER_FAILED),
    (PdfConversionFailedError, ErrorCode.PDF_CONVERSION_FAILED),
    (VerificationFailedError, ErrorCode.VERIFICATION_FAILED),
    (ReplayMismatchError, ErrorCode.REPLAY_MISMATCH),
]


@pytest.mark.parametrize(("exception", "code"), TERMINAL_EXCEPTIONS)
def test_terminal_exception_carries_its_code_and_is_terminal(
    exception: type[AgentError], code: ErrorCode
) -> None:
    raised = exception("something specific went wrong")

    assert raised.code is code
    assert raised.terminal is True
    assert raised.retryable is False
    assert raised.message == "something specific went wrong"
    assert str(raised) == "something specific went wrong"


@pytest.mark.parametrize(("exception", "code"), TERMINAL_EXCEPTIONS)
def test_terminal_exception_cannot_be_downgraded(
    exception: type[AgentError], code: ErrorCode
) -> None:
    with pytest.raises(ValueError) as raised:
        exception("nope", terminal=False)

    assert exception.__name__ in str(raised.value)


def test_base_agent_error_is_not_instantiable() -> None:
    # An error with no code cannot be reported, and defaulting one would move the
    # choice of code from the failure site into an exception handler.
    with pytest.raises(TypeError) as raised:
        AgentError("no code")

    assert "declares no error code" in str(raised.value)


def test_throttled_fails_the_run_while_the_class_stays_retryable() -> None:
    raised = ThrottledError("quota exhausted after honouring every wait")

    assert raised.code is ErrorCode.THROTTLED
    assert raised.terminal is True
    assert raised.retryable is True
    assert ErrorCode.THROTTLED in NON_TERMINAL_CODES


def test_region_unreachable_is_a_gap_by_default() -> None:
    raised = RegionUnreachableError("westus3 has no data-plane host")

    assert raised.code is ErrorCode.REGION_UNREACHABLE
    assert raised.terminal is False
    assert raised.retryable is False


def test_region_unreachable_escalates_when_every_location_fails() -> None:
    raised = RegionUnreachableError("every location unreachable", terminal=True)

    assert raised.terminal is True
    assert raised.code is ErrorCode.REGION_UNREACHABLE


def test_partial_coverage_is_never_terminal() -> None:
    raised = PartialCoverageError("completed with 4 gaps")

    assert raised.code is ErrorCode.PARTIAL_COVERAGE
    assert raised.terminal is False

    with pytest.raises(ValueError):
        PartialCoverageError("completed with 4 gaps", terminal=True)


def test_every_exception_is_catchable_as_agent_error() -> None:
    """Every declared code has exactly one class that **declares** it, and every class is
    catchable as an `AgentError`.

    Counted over classes declaring a `code` in their own `__dict__`, not over all
    descendants, and the distinction is the whole point of the assertion. What must stay
    1:1 is code-to-class: a code with no class cannot be raised, and a class inventing a
    code widens the vocabulary the app switches on. Neither is affected by a **specialized**
    subclass of an existing class that inherits its parent's code and only adds context —
    `compile/messages.py`'s `MissingMessageError` is a `RenderFailedError` carrying the
    string id and the language, which is strictly more information under the same code.

    Asserting `len(descendants) == len(ErrorCode)` instead would forbid every such
    specialization, which is a rule about class hierarchy shape rather than about the error
    vocabulary, and not one this codebase has a reason to hold.
    """
    subclasses = _all_agent_error_subclasses()
    declaring = {
        subclass for subclass in subclasses if "code" in vars(subclass)
    }

    assert len(declaring) == len(ErrorCode)
    assert {subclass.code for subclass in declaring} == set(ErrorCode)

    for subclass in subclasses:
        assert issubclass(subclass, AgentError)
        assert issubclass(subclass, Exception)
        # A specialization inherits a real code rather than leaving it unset.
        assert subclass.code in set(ErrorCode)


def test_repr_states_the_code_and_terminality() -> None:
    text = repr(EmptyScopeError("zero resources in scope"))

    assert "EmptyScopeError" in text
    assert "EMPTY_SCOPE" in text
    assert "terminal=True" in text


# --- the code -> exception mapping ---------------------------------------------


@pytest.mark.parametrize("code", list(ErrorCode))
def test_exception_for_round_trips_every_code(code: ErrorCode) -> None:
    exception = exception_for(code)

    assert exception.code is code
    assert exception_for(code.value) is exception


def test_exception_for_rejects_an_undeclared_code() -> None:
    with pytest.raises(ValueError) as raised:
        exception_for("NOT_A_CODE")

    assert "not a declared agent error code" in str(raised.value)
