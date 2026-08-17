"""The two model call sites (Req 19, 35).

Every test here is about what the model **cannot** reach or **cannot** affect, because that
is the whole content of these two modules. The prose itself is not asserted — it is prose,
there is no correct answer, and a test pinning its wording would break on every model
revision while proving nothing.

The one that matters most is
:func:`test_a_numeral_the_model_invents_reaches_the_document_unaltered`. Nothing strips a
number out of model prose, deliberately: a numeral the compiler did not place must **reach
the verifier** rather than be quietly removed, because a silent edit turns a caught defect
into an uncaught one.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any, Final

import pytest

from reporting_agent.compile.blocks.base import ProseRequest
from reporting_agent.narrate.review import (
    MAX_FINDINGS,
    REVIEW_TIMEOUT_S,
    review,
    strip_unknown_numerals,
)
from reporting_agent.narrate.summary import (
    SYSTEM_PROMPT,
    ProseGenerator,
    build_messages,
    generate,
)
from reporting_agent.verify.findings import FINDING_PROSE_REVIEW_FINDING, SEVERITY_ADVISORY

MODEL: Final[str] = "anthropic.claude-fake-v1"

REQUEST: Final[ProseRequest] = ProseRequest(
    block_id="summary",
    report_title="July utilization",
    subscription_display_name="prod-sea",
    window="2026-07-01 to 2026-07-31",
    grain="PT1H",
    resource_count=37,
    gap_counts={"no_samples": 2, "deallocated": 1},
    figures=(("Percentage CPU avg", "12.48%"), ("Percentage CPU max", "88.20%")),
)


class FakeModel:
    """Records the call and answers with whatever it was given."""

    def __init__(self, text: str = "Utilization is modest across the fleet.", **kw: Any):
        self.text = text
        self.raises = kw.get("raises")
        self.delay = kw.get("delay", 0.0)
        self.calls: list[dict[str, Any]] = []

    def converse(self, **kwargs: Any):
        self.calls.append(kwargs)
        if self.raises is not None:
            raise self.raises
        if self.delay:
            import time

            time.sleep(self.delay)
        return {"output": {"message": {"content": [{"text": self.text}]}}}


# --------------------------------------------------------------------------- #
# Req 19.1 — exactly the permitted context, and nothing else
# --------------------------------------------------------------------------- #


def test_the_prompt_carries_formatted_strings_and_no_series() -> None:
    """The model reads what the document will *say*, never the value it was formatted from.

    A model handed a series could average it; a number it computed would have no
    `snapshot_path`, could not become a `Figure`, and would reach the document as prose. The
    withholding means it is never in a position to try.
    """
    text = build_messages(REQUEST)[0]["content"][0]["text"]

    assert "12.48%" in text
    assert "88.20%" in text
    assert "no_samples: 2" in text
    assert "Resources in scope: 37" in text
    # The unformatted value, the snapshot pointer and any per-timestamp key must be absent.
    for forbidden in ("12.48\n", "/resources/", "timeStamp", "timeseries", "snapshot"):
        assert forbidden not in text, forbidden


def test_the_call_carries_no_tool_list() -> None:
    """Req 19.7 — a single-shot Converse call with no tools is the only shape in which "the
    model cannot reach a number" is structural rather than aspirational."""
    model = FakeModel()

    generate(REQUEST, client=model, model_id=MODEL)

    assert len(model.calls) == 1
    assert "toolConfig" not in model.calls[0]
    assert "tools" not in model.calls[0]
    assert model.calls[0]["modelId"] == MODEL
    assert model.calls[0]["system"] == [{"text": SYSTEM_PROMPT}]


def test_the_system_prompt_is_not_treated_as_enforcement() -> None:
    """Req 19.5. The prompt asks; `verify/masking.py` enforces.

    Asserted as a property of the prompt's own text rather than as a comment, because the
    temptation this documents is real: a reader seeing "do not write any number" could
    reasonably conclude the instruction is the mechanism.
    """
    assert "Do not write any number" in SYSTEM_PROMPT
    # And the mechanism exists independently of it.
    from reporting_agent.verify.masking import scan_paragraphs

    assert callable(scan_paragraphs)


# --------------------------------------------------------------------------- #
# Req 19.3 — the returned characters, unaltered
# --------------------------------------------------------------------------- #


def test_a_numeral_the_model_invents_reaches_the_document_unaltered() -> None:
    """Nothing strips, rounds or substitutes a numeral the model wrote.

    The tempting alternative — quietly scrubbing digits out of model prose — would make the
    document pass verification while hiding that the model tried. The numeral must reach the
    masking pass, which fails the verification and withholds the report.
    """
    invented = "CPU averaged 37.4% and grew 12% month over month."

    returned = generate(REQUEST, client=FakeModel(invented), model_id=MODEL)

    assert returned == invented


def test_multiple_content_blocks_are_concatenated_in_order() -> None:
    class Split:
        def converse(self, **kwargs: Any):
            del kwargs
            return {
                "output": {
                    "message": {"content": [{"text": "first. "}, {"text": "second."}]}
                }
            }

    assert generate(REQUEST, client=Split(), model_id=MODEL) == "first. second."


@pytest.mark.parametrize(
    "response",
    [
        {},
        {"output": {}},
        {"output": {"message": {}}},
        {"output": {"message": {"content": "not a list"}}},
        {"output": {"message": {"content": [{"toolUse": {}}]}}},
    ],
)
def test_an_unusable_response_yields_empty_prose(response) -> None:
    class Odd:
        def converse(self, **kwargs: Any):
            del kwargs
            return response

    assert generate(REQUEST, client=Odd(), model_id=MODEL) == ""


def test_a_failed_model_call_yields_empty_prose_rather_than_failing_the_run() -> None:
    """A throttle, an expired role and a retired model are three exceptions and one outcome:
    this report has no narrative. None of them is a reason to withhold a document whose
    figures all verified."""
    generator = ProseGenerator(
        client=FakeModel(raises=RuntimeError("throttled")), model_id=MODEL
    )

    assert generator.narrate(REQUEST) == ""


# --------------------------------------------------------------------------- #
# Req 35 — the reviewer is advisory, bounded, and writes nothing
# --------------------------------------------------------------------------- #


def run_review(**overrides: Any):
    base: dict[str, Any] = {
        "prose": ["Utilization is modest.", "Two resources reported no samples."],
        "figures": [("Percentage CPU avg", "12.48%")],
        "client": FakeModel("[0] The claim of modest utilization is not supported."),
        "model_id": MODEL,
    }
    base.update(overrides)
    return asyncio.run(review(**base))


def test_an_observation_is_one_advisory_finding_naming_the_paragraph() -> None:
    outcome = run_review()

    assert outcome.completed is True
    assert len(outcome.findings) == 1
    assert outcome.findings[0]["type"] == FINDING_PROSE_REVIEW_FINDING
    assert outcome.findings[0]["severity"] == SEVERITY_ADVISORY
    assert outcome.findings[0]["ast_path"] == "prose:0"


def test_the_reviewer_sees_the_prose_and_the_figures_and_nothing_else() -> None:
    """Req 35.1 — exactly two inputs. No raw series, no `collection_log`, no archive."""
    model = FakeModel("")

    run_review(client=model)

    text = model.calls[0]["messages"][0]["content"][0]["text"]
    assert "Utilization is modest." in text
    assert "12.48%" in text
    for forbidden in ("collection_log", "raw_response", "timeseries", "gap_type"):
        assert forbidden not in text, forbidden


def test_findings_are_capped_at_twenty_five() -> None:
    """Req 35.2. A panel of two hundred advisory notes is a panel nobody reads, which is
    indistinguishable from having no reviewer at all."""
    many = "\n".join(f"[{index % 3}] observation {index}" for index in range(80))

    outcome = run_review(client=FakeModel(many))

    assert len(outcome.findings) == MAX_FINDINGS


def test_a_numeral_the_reviewer_invents_is_redacted_from_its_own_finding() -> None:
    """Req 35.2 — the finding text is displayed beside the report, and a number in it that
    traces to nothing is exactly the wrong thing to render there."""
    outcome = run_review(
        client=FakeModel("[0] The narrative says 12.48% but the peak was really 91.7%.")
    )

    message = outcome.findings[0]["message"]
    assert "12.48%" in message, "a figure the report prints stays readable"
    assert "91.7%" not in message
    assert "[figure]" in message


@pytest.mark.parametrize(
    ("text", "known", "expected"),
    [
        ("peak of 88.20%", {"88.20%"}, "peak of 88.20%"),
        ("peak of 91.7%", {"88.20%"}, "peak of [figure]"),
        ("no numbers here", set(), "no numbers here"),
        ("Top 10 resources", {"10"}, "Top 10 resources"),
        ("grew by 12x", set(), "grew by [figure]"),
    ],
)
def test_the_redaction_keeps_known_strings_and_replaces_the_rest(
    text, known, expected
) -> None:
    assert strip_unknown_numerals(text, known=known) == expected


def test_a_review_with_no_client_is_recorded_as_not_completed() -> None:
    """Not an error: a re-verification long after the fact has no model configured, and the
    verification status is identical either way (Req 35.3)."""
    outcome = run_review(client=None)

    assert outcome.completed is False
    assert outcome.findings == ()


def test_a_review_that_exceeds_its_budget_records_no_finding_of_any_kind() -> None:
    """Req 35.6 — after 60 seconds the outcome is not completed, with no further attempt.

    Driven at a millisecond budget rather than at sixty seconds, because the assertion is
    about the timeout path and not about the constant.
    """
    model = FakeModel(delay=0.2)

    outcome = run_review(client=model, timeout_s=0.01)

    assert outcome.completed is False
    assert outcome.findings == ()
    assert REVIEW_TIMEOUT_S == 60.0


def test_a_review_that_raises_is_recorded_as_not_completed() -> None:
    outcome = run_review(client=FakeModel(raises=RuntimeError("model unavailable")))

    assert outcome.completed is False
    assert outcome.findings == ()


def test_completed_and_found_nothing_is_distinct_from_never_ran() -> None:
    """Two states a reader of the panel needs kept apart: "the narrative was checked and is
    fine" and "the narrative was not checked"."""
    checked = run_review(client=FakeModel(""))
    unchecked = run_review(client=None)

    assert checked.findings == unchecked.findings == ()
    assert checked.completed is True
    assert unchecked.completed is False


def test_the_reviewer_writes_nothing() -> None:
    """Req 35.7. Asserted by signature: there is no store, no path and no writer among its
    arguments, so there is nothing it could write to."""
    import inspect

    parameters = set(inspect.signature(review).parameters)

    assert parameters == {
        "prose",
        "figures",
        "client",
        "model_id",
        "allowlist",
        "timeout_s",
    }
    assert json is not None
