"""Example-based tests for the redaction guard (Req 15.1-15.5, 15.8-15.10).

The generated half of this coverage — regex-metacharacter alphabets, nesting depth
1-4, lengths 0-7 — is Property 5, which lands separately. What is here are the
specific cases whose behaviour is stated rather than universal: the two secrets that
must carry identical sensitivity, the exact placeholder, filter idempotency, and
teardown at the terminal event.
"""

from __future__ import annotations

import logging

import pytest

from reporting_agent.redaction import (
    MIN_SECRET_LENGTH,
    SECRET_PLACEHOLDER,
    RedactionFilter,
    discard_secrets,
    install_log_redaction,
    presence_marker,
    register_secrets,
    registered_secret_count,
    scrub,
    scrub_deep,
    scrub_exception,
)

# 40 characters, shaped like an Azure client secret: metacharacters included on
# purpose, because an unescaped `.` or `*` in a compiled pattern is the failure this
# module exists to prevent.
AZURE_SHAPED_SECRET = "aB3~.q7-Zx*Kp1_Ld9+Rt5?Nv2(Hj8)Gm4[Wc6]\\"
PROGRESS_TOKEN = "b2VmMTM0YWMtNWM4YS00ZjBkLThlMWEtOWY3YjNkNGU1YTZi"


@pytest.fixture(autouse=True)
def _clean_registry():
    """Every test starts and ends with an empty registry and an unfiltered root logger.

    Without the teardown, one test's secrets would scrub another test's ordinary
    output — which is the very failure Req 15.10 is about, so it would be perverse to
    build the suite on it.
    """
    discard_secrets()
    root = logging.getLogger()
    before = list(root.filters)
    yield
    discard_secrets()
    root.filters = before
    for handler in root.handlers:
        handler.filters = [f for f in handler.filters if not isinstance(f, RedactionFilter)]


# --- registration ------------------------------------------------------------------


def test_client_secret_and_progress_token_carry_identical_sensitivity():
    """Req 15.1 — both values register, and both are replaced by the same placeholder."""
    register_secrets([AZURE_SHAPED_SECRET, PROGRESS_TOKEN])

    text = f"POST with secret={AZURE_SHAPED_SECRET} and token={PROGRESS_TOKEN}"
    result = scrub(text)

    assert AZURE_SHAPED_SECRET not in result
    assert PROGRESS_TOKEN not in result
    assert result == f"POST with secret={SECRET_PLACEHOLDER} and token={SECRET_PLACEHOLDER}"


def test_metacharacter_secret_is_escaped_and_matches_literally():
    """A secret containing `.*` must not compile into a pattern that eats the line."""
    register_secrets(["a.*b+c?(d)"])

    assert scrub("value=a.*b+c?(d) end") == f"value={SECRET_PLACEHOLDER} end"
    # The same text the unescaped pattern would have matched, left alone.
    assert scrub("value=aXXXbbbcd end") == "value=aXXXbbbcd end"


def test_short_and_non_string_values_register_nothing():
    """Req 15.9 — no pattern, no placeholder, no mangled prose."""
    register_secrets(["", "a", "1234567", None, 12345678, b"bytesval", ["nested"]])

    assert registered_secret_count() == 0
    assert scrub("ordinary prose a 1234567") == "ordinary prose a 1234567"
    assert SECRET_PLACEHOLDER not in scrub("aaaaaaa")


def test_minimum_length_boundary_registers_at_eight_characters():
    register_secrets(["1234567"])
    assert registered_secret_count() == 0

    register_secrets(["12345678"])
    assert registered_secret_count() == 1
    assert MIN_SECRET_LENGTH == 8
    assert scrub("id=12345678") == f"id={SECRET_PLACEHOLDER}"


def test_repeated_registration_does_not_grow_the_registry():
    """Req 15.10 — the registry stays bounded even under a retried context parse."""
    for _ in range(5):
        register_secrets([AZURE_SHAPED_SECRET, PROGRESS_TOKEN])

    assert registered_secret_count() == 2


def test_overlapping_secrets_leave_no_fragment():
    """The longer secret is replaced first, so its tail is not left behind."""
    shorter = "abcdefgh"
    longer = shorter + "ijklmnop"
    register_secrets([shorter, longer])

    assert scrub(f"token={longer}") == f"token={SECRET_PLACEHOLDER}"


# --- scrub / scrub_deep ------------------------------------------------------------


def test_scrub_passes_none_through_and_leaves_clean_text_unchanged():
    register_secrets([AZURE_SHAPED_SECRET])

    assert scrub(None) is None
    assert scrub("nothing sensitive here") == "nothing sensitive here"


def test_scrub_deep_reaches_every_depth_of_objects_and_arrays():
    """Req 15.3 — depth 3 inside objects and inside arrays, plus mapping keys."""
    register_secrets([AZURE_SHAPED_SECRET])

    event = {
        "type": "error",
        "detail": {
            "request": {
                "headers": {"authorization": f"Bearer {AZURE_SHAPED_SECRET}"},
                "attempts": [
                    {"message": f"failed with {AZURE_SHAPED_SECRET}"},
                    ["nested", ["deeper", f"{AZURE_SHAPED_SECRET} here"]],
                ],
            }
        },
        f"key-{AZURE_SHAPED_SECRET}": "value in a secret-bearing key",
    }

    scrubbed = scrub_deep(event)

    assert AZURE_SHAPED_SECRET not in repr(scrubbed)
    assert (
        scrubbed["detail"]["request"]["headers"]["authorization"]
        == f"Bearer {SECRET_PLACEHOLDER}"
    )
    assert scrubbed["detail"]["request"]["attempts"][1][1][1] == f"{SECRET_PLACEHOLDER} here"
    assert f"key-{SECRET_PLACEHOLDER}" in scrubbed
    # The caller's object is not mutated.
    assert AZURE_SHAPED_SECRET in repr(event)


def test_scrub_deep_preserves_shape_and_non_string_scalars():
    register_secrets([AZURE_SHAPED_SECRET])

    value = scrub_deep(
        {
            "count": 3,
            "ratio": None,
            "flag": True,
            "tuple": ("plain", AZURE_SHAPED_SECRET),
            "list": ["plain"],
        }
    )

    assert value["count"] == 3
    assert value["ratio"] is None
    assert value["flag"] is True
    assert value["tuple"] == ("plain", SECRET_PLACEHOLDER)
    assert isinstance(value["list"], list)


# --- exceptions --------------------------------------------------------------------


def test_scrub_exception_walks_cause_and_context():
    """Req 15.5 — the secret in a chained cause and in a chained context is removed."""
    register_secrets([AZURE_SHAPED_SECRET, PROGRESS_TOKEN])

    try:
        try:
            try:
                raise ValueError(f"context carried {PROGRESS_TOKEN}")
            except ValueError:
                raise KeyError(f"cause carried {AZURE_SHAPED_SECRET}") from None
        except KeyError as cause:
            raise RuntimeError("outer failed") from cause
    except RuntimeError as exc:
        text = scrub_exception(exc)

    assert AZURE_SHAPED_SECRET not in text
    assert PROGRESS_TOKEN not in text
    assert "outer failed" in text
    assert f"cause carried {SECRET_PLACEHOLDER}" in text
    assert f"context carried {SECRET_PLACEHOLDER}" in text


def test_scrub_exception_walks_a_suppressed_context():
    """`raise ... from None` hides the link from traceback, not from the guard."""
    register_secrets([AZURE_SHAPED_SECRET])

    try:
        try:
            raise ValueError(f"suppressed {AZURE_SHAPED_SECRET}")
        except ValueError:
            raise RuntimeError("replacement") from None
    except RuntimeError as exc:
        text = scrub_exception(exc)

    assert AZURE_SHAPED_SECRET not in text
    assert f"suppressed {SECRET_PLACEHOLDER}" in text


def test_scrub_exception_terminates_on_a_self_referential_chain():
    register_secrets([AZURE_SHAPED_SECRET])

    exc = RuntimeError(f"loop {AZURE_SHAPED_SECRET}")
    exc.__cause__ = exc

    text = scrub_exception(exc)

    assert AZURE_SHAPED_SECRET not in text
    assert text.count(SECRET_PLACEHOLDER) == 1


# --- presence marker ---------------------------------------------------------------


def test_presence_marker_reveals_no_character_of_the_secret():
    """Req 15.4 — presence and length only."""
    marker = presence_marker(AZURE_SHAPED_SECRET)

    assert len(AZURE_SHAPED_SECRET) == 40
    assert marker == "<set:40chars>"
    assert AZURE_SHAPED_SECRET not in marker
    # A single digit of the length can coincide with a digit of the secret, so the
    # claim under test is that no *sequence* of the secret survives.
    for start in range(len(AZURE_SHAPED_SECRET) - 1):
        assert AZURE_SHAPED_SECRET[start : start + 2] not in marker


def test_presence_marker_reports_nothing_when_nothing_is_set():
    assert presence_marker(None) is None
    assert presence_marker("") is None


# --- the logging filter ------------------------------------------------------------


def test_install_log_redaction_is_idempotent_on_the_root_logger_and_its_handlers():
    """Req 15.2 — at most one filter each, however many times installation runs."""
    root = logging.getLogger()
    handler = logging.NullHandler()
    root.addHandler(handler)
    try:
        for _ in range(3):
            install_log_redaction()

        assert sum(isinstance(f, RedactionFilter) for f in root.filters) == 1
        assert sum(isinstance(f, RedactionFilter) for f in handler.filters) == 1
    finally:
        root.removeHandler(handler)


def test_install_log_redaction_filters_a_handler_added_after_process_start():
    """Req 15.2 — the second installation, after the context parse, is what covers it."""
    root = logging.getLogger()
    install_log_redaction()

    late = logging.NullHandler()
    root.addHandler(late)
    try:
        assert not any(isinstance(f, RedactionFilter) for f in late.filters)

        install_log_redaction()

        assert sum(isinstance(f, RedactionFilter) for f in late.filters) == 1
    finally:
        root.removeHandler(late)


def _record(message: str, *args: object) -> logging.LogRecord:
    return logging.LogRecord(
        name="reporting_agent.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=message,
        args=args or None,
        exc_info=None,
    )


def test_filter_replaces_the_secret_in_a_message_and_in_lazy_args():
    register_secrets([AZURE_SHAPED_SECRET, PROGRESS_TOKEN])
    guard = RedactionFilter()

    direct = _record(f"invoking with {AZURE_SHAPED_SECRET}")
    lazy = _record("callback authorized by %s", PROGRESS_TOKEN)

    assert guard.filter(direct) is True
    assert guard.filter(lazy) is True

    assert direct.getMessage() == f"invoking with {SECRET_PLACEHOLDER}"
    assert lazy.getMessage() == f"callback authorized by {SECRET_PLACEHOLDER}"


def test_filter_leaves_a_clean_record_untouched():
    register_secrets([AZURE_SHAPED_SECRET])
    guard = RedactionFilter()

    record = _record("collected %d resources", 200)
    guard.filter(record)

    assert record.args == (200,)
    assert record.getMessage() == "collected 200 resources"
    assert SECRET_PLACEHOLDER not in record.getMessage()


def test_filter_scrubs_exception_text_reaching_a_handler(caplog):
    register_secrets([AZURE_SHAPED_SECRET])
    install_log_redaction()
    logger = logging.getLogger("reporting_agent.test.exc")

    with caplog.at_level(logging.ERROR):
        try:
            raise ValueError(f"azure rejected {AZURE_SHAPED_SECRET}")
        except ValueError:
            logger.exception("collection failed")

    record = caplog.records[-1]
    assert AZURE_SHAPED_SECRET not in (record.exc_text or "")
    assert SECRET_PLACEHOLDER in (record.exc_text or "")
    assert AZURE_SHAPED_SECRET not in caplog.text


# --- teardown and context scoping --------------------------------------------------


def test_discard_secrets_stops_an_earlier_invocations_secret_from_scrubbing_later_text():
    """Req 15.10 — the registry is emptied at the terminal event."""
    register_secrets([AZURE_SHAPED_SECRET])
    assert scrub(f"a={AZURE_SHAPED_SECRET}") == f"a={SECRET_PLACEHOLDER}"

    discard_secrets()

    assert registered_secret_count() == 0
    later_text = f"a customer's own text mentioning {AZURE_SHAPED_SECRET}"
    assert scrub(later_text) == later_text


def test_discard_secrets_with_a_token_restores_the_previous_registry():
    register_secrets(["outer-secret-value"])
    token = register_secrets([AZURE_SHAPED_SECRET])

    discard_secrets(token)

    assert registered_secret_count() == 1
    assert scrub(f"x={AZURE_SHAPED_SECRET}") == f"x={AZURE_SHAPED_SECRET}"
    assert scrub("x=outer-secret-value") == f"x={SECRET_PLACEHOLDER}"


def test_discard_secrets_tolerates_a_token_from_another_context():
    """Teardown runs on the terminal-event path, so it must never raise."""
    import contextvars

    holder: list[object] = []
    contextvars.copy_context().run(lambda: holder.append(register_secrets([AZURE_SHAPED_SECRET])))
    register_secrets([PROGRESS_TOKEN])

    discard_secrets(holder[0])  # type: ignore[arg-type]

    assert registered_secret_count() == 0


def test_secrets_registered_in_one_context_do_not_leak_into_another():
    """Req 15.10 — one invocation's secrets cannot scrub another's output."""
    import contextvars

    def invocation_a() -> None:
        register_secrets([AZURE_SHAPED_SECRET])
        assert scrub(f"a={AZURE_SHAPED_SECRET}") == f"a={SECRET_PLACEHOLDER}"

    contextvars.copy_context().run(invocation_a)

    assert registered_secret_count() == 0
    assert scrub(f"b={AZURE_SHAPED_SECRET}") == f"b={AZURE_SHAPED_SECRET}"
