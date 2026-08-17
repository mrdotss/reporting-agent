"""The Prose_Reviewer — advisory, bounded, and unable to change anything (Req 35).

A second model reads the prose the first one wrote and files observations: a claim the
figures do not support, a comparison nothing in the report establishes, a tone problem. Every
one is an **advisory** `prose_review_finding`, and the verification status is identical
whether this review completed, produced twenty-five findings, or never ran at all (Req 35.3).

That is a real design choice rather than caution. A model's opinion about prose is exactly
the kind of signal that is useful to a reviewer and disastrous as a gate: it is
non-deterministic, it has no ground truth to check against, and a report withheld because a
model disliked a sentence is a report nobody trusts the system about.

## What it can see, and what it cannot

Exactly two inputs (Req 35.1): the model-authored prose nodes, and the aggregate table of
**rendered `formatted` strings**. No raw series, no `collection_log` entry, no archived
response. So the reviewer is in the same position as a reader holding the finished document,
which is the position from which its observations are worth anything.

## Three bounds, each closing a specific failure

* **At most 25 findings** (Req 35.2). A panel of two hundred advisory notes is a panel
  nobody reads, which is indistinguishable from having no reviewer.
* **60 seconds** (Req 35.6), after which the outcome is recorded as not completed, with no
  finding of any other type, no further attempt, and no change to either status. An advisory
  step must never be able to hold a verified report.
* **No numeral absent from both the ledger and the allowlist** (Req 35.2). The reviewer's
  own text is scrubbed of any figure it invented, because that text is displayed beside the
  report — and a number in a finding, next to a document whose whole claim is that every
  number traces to a snapshot, is exactly the wrong thing to render.

It writes nothing (Req 35.7): no snapshot, no ledger, no AST, no `.docx`, no `.pdf`. Nothing
applies its findings automatically and no code path writes a finding's text into the
document (Req 35.4).
"""

from __future__ import annotations

import logging
import re
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from reporting_agent.narrate.summary import BedrockConverse
from reporting_agent.verify.findings import (
    FINDING_PROSE_REVIEW_FINDING,
    Finding,
    record_finding,
)

__all__ = [
    "MAX_FINDINGS",
    "REVIEW_SYSTEM_PROMPT",
    "REVIEW_TIMEOUT_S",
    "ReviewOutcome",
    "review",
    "strip_unknown_numerals",
]

logger = logging.getLogger(__name__)

MAX_FINDINGS: Final[int] = 25
REVIEW_TIMEOUT_S: Final[float] = 60.0

_NUMERIC_TOKEN: Final[re.Pattern[str]] = re.compile(r"\S*\d\S*")
_REDACTED: Final[str] = "[figure]"

REVIEW_SYSTEM_PROMPT: Final[str] = (
    "You review the narrative of an infrastructure utilization report for a colleague.\n"
    "\n"
    "You are given the narrative paragraphs and the table of figures the report prints. "
    "List observations where the narrative claims something the figures do not support, "
    "draws a comparison the report does not establish, or reads as more certain than the "
    "data allows.\n"
    "\n"
    "One observation per line, plain prose, no numbers. Write nothing if the narrative is "
    "well supported."
)


@dataclass(frozen=True, slots=True)
class ReviewOutcome:
    """What one review produced. `completed` is `False` for a timeout or a failure.

    Distinguished from "completed and found nothing" because they mean different things to
    a reader of the panel — one says the narrative was checked and is fine, the other says
    it was not checked — and because Req 35.6 requires the not-completed case to be
    recorded as such rather than as silence.
    """

    findings: tuple[Finding, ...]
    completed: bool


def strip_unknown_numerals(text: str, *, known: Iterable[str]) -> str:
    """Replace every numeric-bearing token that is not a known string (Req 35.2).

    "Known" is the union of the ledger's `formatted` strings and the derived static-text
    allowlist — precisely the strings the document is entitled to contain. Anything else is
    a number the reviewer produced, and a number a model produced has no place in text
    rendered beside a report whose claim is that every number traces to a snapshot.

    Replaced rather than dropped, so the sentence still reads and a reviewer can see that
    something was removed.
    """
    permitted = {value for value in known if value}
    return _NUMERIC_TOKEN.sub(
        lambda match: match.group() if match.group() in permitted else _REDACTED, text
    )


async def review(
    *,
    prose: Sequence[str],
    figures: Sequence[tuple[str, str]],
    client: BedrockConverse | None,
    model_id: str,
    allowlist: Iterable[str] = (),
    timeout_s: float = REVIEW_TIMEOUT_S,
) -> ReviewOutcome:
    """Run the advisory review, or record that it did not run.

    Every failure path returns rather than raises, and returns `completed=False` rather than
    an empty finding list: an advisory step that could raise would be able to fail a
    verification, which is the one thing Req 35.3 says it cannot do.

    `client=None` — no model configured, or a re-verification long after the fact — is a
    legitimate not-completed outcome, not an error.
    """
    if client is None or not prose:
        return ReviewOutcome(findings=(), completed=False)

    import asyncio

    try:
        response = await asyncio.wait_for(
            asyncio.to_thread(
                client.converse,
                modelId=model_id,
                system=[{"text": REVIEW_SYSTEM_PROMPT}],
                messages=_messages(prose, figures),
                inferenceConfig={"maxTokens": 700, "temperature": 0.0},
            ),
            timeout=timeout_s,
        )
    except TimeoutError:
        logger.info(
            "the prose review exceeded its %.0fs budget; recorded as not completed, with "
            "no finding and no second attempt",
            timeout_s,
        )
        return ReviewOutcome(findings=(), completed=False)
    except Exception as exc:
        logger.info(
            "the prose review failed (%s); recorded as not completed. The verification "
            "status is unaffected either way",
            type(exc).__name__,
        )
        return ReviewOutcome(findings=(), completed=False)

    known = {formatted for _, formatted in figures} | set(allowlist)
    observations = _observations(response)
    findings = tuple(
        record_finding(
            FINDING_PROSE_REVIEW_FINDING,
            strip_unknown_numerals(observation, known=known),
            ast_path=path,
        )
        for path, observation in observations[:MAX_FINDINGS]
    )
    return ReviewOutcome(findings=findings, completed=True)


def _messages(
    prose: Sequence[str], figures: Sequence[tuple[str, str]]
) -> list[dict[str, Any]]:
    """The two permitted inputs, and nothing else (Req 35.1)."""
    lines = ["Narrative:"]
    lines.extend(f"[{index}] {text}" for index, text in enumerate(prose))
    lines.append("")
    lines.append("Figures the report prints:")
    lines.extend(f"- {label}: {formatted}" for label, formatted in figures)
    return [{"role": "user", "content": [{"text": "\n".join(lines)}]}]


def _observations(response: Mapping[str, Any]) -> list[tuple[str, str]]:
    """One `(ast path, observation)` per non-blank line the model returned.

    The path is the paragraph ordinal the model was shown, recovered from a leading `[n]`
    where the model used one. A reviewer needs to know *which* sentence an observation is
    about, and asking for the marker is cheaper and more robust than trying to match the
    observation's text back to a paragraph.
    """
    from reporting_agent.narrate.summary import _text_of

    text = _text_of(response)
    found: list[tuple[str, str]] = []
    for line in text.splitlines():
        stripped = line.strip().lstrip("-•* ").strip()
        if not stripped:
            continue
        match = re.match(r"^\[(\d+)\]\s*(.+)$", stripped)
        if match:
            found.append((f"prose:{match.group(1)}", match.group(2)))
        else:
            found.append(("prose", stripped))
    return found
