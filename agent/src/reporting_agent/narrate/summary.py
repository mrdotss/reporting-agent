"""The executive summary's prose — one model call, no tools, no numbers in (Req 19, 35).

The model receives exactly what Req 19.1 permits: each ledger figure as its **formatted
string** with its label, the compiled aggregate table, and the `collection_log` gap counts
grouped by type. It receives **no raw metric series** — no per-timestamp value, and no
numeric absent from the ledger.

That withholding is the whole design, and it is stronger than an instruction. A model handed
a series could average it; a number it computed would have no `snapshot_path`, so it could
not become a `Figure`, and it would reach the document as prose — where the masking pass
would catch it and withhold the report. Withholding the series means the model is never in a
position to try, and the verifier is the backstop rather than the plan.

## The prose is an input to a compile, not a product of one

`generate` returns text. The pipeline persists it as `reports/<runId>/prose.json` and passes
it **into** subsequent compilations of that run, so a compile is a pure function of (template
version, snapshot, prose bundle). A model call inside a compile would make the AST digest
non-identical across two compilations of one pair — and would make a re-verification's
byte-identical recompiled ledger depend on a model's determinism, which is not a thing to
depend on.

## What the call deliberately does not have

**No tool list.** A single-shot Converse call with no tools is the only shape in which "the
model cannot reach a number" is a structural fact rather than a hope. There is no tool
registry anywhere in this runtime, so Req 19.7's enumeration test is an assertion over an
empty set.

**No retry that changes the prompt**, and no post-processing of the returned characters. Req
19.3 requires the model's text to enter the AST **unaltered**: nothing strips, rounds or
substitutes a numeral it wrote. That is deliberate and it is worth being explicit about,
because the tempting alternative — quietly scrubbing digits out of model prose — would make
the document pass verification while hiding the fact that the model tried.
"""

from __future__ import annotations

import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, Protocol

from reporting_agent.compile.blocks.base import ProseRequest

__all__ = [
    "MAX_OUTPUT_TOKENS",
    "SYSTEM_PROMPT",
    "SYSTEM_PROMPT_ID",
    "BedrockConverse",
    "ProseGenerator",
    "build_messages",
    "generate",
    "prose_generator",
]

logger = logging.getLogger(__name__)

MAX_OUTPUT_TOKENS: Final[int] = 800
"""Enough for four paragraphs of narrative. A cap rather than a target: the compiler decides
how many paragraphs the block holds, and a longer answer is truncated by the compiler's own
`MAX_PROSE_PARAGRAPHS` rather than by this number."""

SYSTEM_PROMPT: Final[str] = (
    "You write the executive summary of an infrastructure utilization report.\n"
    "\n"
    "Write two to four short paragraphs of plain prose about what the figures below "
    "show: which resources are busy, which are idle, where headroom exists, and what "
    "the recorded gaps mean for confidence in the report.\n"
    "\n"
    "Do not write any number that is not in the list of figures given to you, and "
    "prefer describing a pattern in words to restating a figure. Do not invent a "
    "measurement, a total, a percentage change or a rank. Do not speculate about "
    "causes you cannot see in the data.\n"
    "\n"
    "Return prose only: no headings, no bullet lists, no markdown."
)
"""The instruction, and it is **not** enforcement (Req 19.5).

Every clause here is a request. The mechanism that makes "no LLM ever produces a number"
true is the masking pass in `verify/masking.py`, which fails the verification on any numeral
the compiler did not place — regardless of what this prompt says, regardless of the model,
and with no setting anywhere that disables it (Req 19.8). This text exists to make the
common case pleasant, not to make the guarantee hold.
"""

SYSTEM_PROMPT_ID: Final[str] = (
    "Anda menulis ringkasan eksekutif dari laporan utilisasi infrastruktur.\n"
    "\n"
    "Tulis dua hingga empat paragraf pendek dalam prosa tentang apa yang ditunjukkan "
    "oleh angka-angka di bawah ini: sumber daya mana yang sibuk, mana yang menganggur, "
    "di mana tersedia ruang cadangan, dan apa arti kesenjangan yang tercatat bagi "
    "kepercayaan terhadap laporan.\n"
    "\n"
    "Jangan menulis angka apa pun yang tidak ada dalam daftar angka yang diberikan "
    "kepada Anda, dan lebih baik menggambarkan pola dalam kata-kata daripada "
    "mengulangi sebuah angka. Jangan membuat pengukuran, total, perubahan persentase "
    "atau peringkat. Jangan berspekulasi tentang penyebab yang tidak dapat Anda lihat "
    "dalam data.\n"
    "\n"
    "Kembalikan prosa saja: tanpa heading, tanpa bullet list, tanpa markdown."
)
"""Indonesian variant of the system prompt (Req 15.7).

Instructs the narrator in Indonesian where the pinned definition's `identity.language`
is `id`. Supplies the narrator the context the templates spec permits and nothing
further. As with the English prompt, this is a request not enforcement — the masking
pass remains the mechanism that prevents fabricated numbers."""


def _system_prompt_for(language: str) -> str:
    """Return the appropriate narrator system prompt for the given language."""
    if language == "id":
        return SYSTEM_PROMPT_ID
    return SYSTEM_PROMPT


class BedrockConverse(Protocol):
    """The one operation this module calls. A protocol so the boundary is one method wide."""

    def converse(self, **kwargs: Any) -> Mapping[str, Any]: ...


@dataclass(frozen=True, slots=True)
class ProseGenerator:
    """A `ProseProvider` over one Bedrock model.

    `narrate` returns `""` where the model is unreachable or answers with nothing usable.
    Empty prose is a complete report — the summary block renders its compiler-placed figures
    and no narrative — whereas raising would withhold a document whose every figure is
    verified over a decorative paragraph.
    """

    client: BedrockConverse
    model_id: str
    language: str = "en"

    def narrate(self, request: ProseRequest) -> str:
        return generate(request, client=self.client, model_id=self.model_id, language=self.language)


def build_messages(request: ProseRequest) -> list[dict[str, Any]]:
    """The one user message, built from exactly the permitted context (Req 19.1).

    Figures arrive as `(label, formatted)` pairs — the string the document will print, never
    the value it was formatted from. So a figure the model quotes is a figure that already
    exists in the ledger, which is the difference between a quote the masking pass accepts
    and an invention it rejects.
    """
    lines = [
        f"Report: {request.report_title}",
        f"Subscription: {request.subscription_display_name}",
        f"Window: {request.window} at {request.grain}",
        f"Resources in scope: {request.resource_count}",
        "",
        "Figures (label, as printed):",
    ]
    lines.extend(f"- {label}: {formatted}" for label, formatted in request.figures)
    if request.gap_counts:
        lines.append("")
        lines.append("Recorded collection gaps, by type:")
        lines.extend(
            f"- {gap_type}: {count}"
            for gap_type, count in sorted(request.gap_counts.items())
        )
    return [{"role": "user", "content": [{"text": "\n".join(lines)}]}]


def generate(
    request: ProseRequest, *, client: BedrockConverse, model_id: str, language: str = "en"
) -> str:
    """One single-shot Converse call, with **no tool list**.

    A failure of any kind returns `""`. Broad by intent: a throttle, an expired role, a
    model that has been retired and a malformed response are four exceptions and one
    outcome — this report has no narrative — and none of them is a reason to withhold a
    document whose figures all verified.
    """
    try:
        response = client.converse(
            modelId=model_id,
            system=[{"text": _system_prompt_for(language)}],
            messages=build_messages(request),
            inferenceConfig={"maxTokens": MAX_OUTPUT_TOKENS, "temperature": 0.2},
        )
    except Exception as exc:
        logger.warning(
            "the executive summary's model call failed (%s); the block renders its "
            "compiler-placed figures with no narrative and the run continues",
            type(exc).__name__,
        )
        return ""

    return _text_of(response)


def _text_of(response: Mapping[str, Any]) -> str:
    """The assistant's text, or `""`.

    Concatenated across content blocks in order and returned **unaltered** (Req 19.3): no
    stripping of numerals, no rounding, no substitution. A numeral the model wrote must
    reach the verifier rather than be quietly removed, because the verifier is what turns
    "the model tried" into a withheld report instead of a silent edit.
    """
    output = response.get("output")
    message = output.get("message") if isinstance(output, Mapping) else None
    content = message.get("content") if isinstance(message, Mapping) else None
    if not isinstance(content, Sequence):
        return ""
    pieces = [
        block["text"]
        for block in content
        if isinstance(block, Mapping) and isinstance(block.get("text"), str)
    ]
    return "".join(pieces).strip()


def prose_generator(model_id: str, *, region: str | None = None, language: str = "en") -> ProseGenerator | None:
    """A generator over the configured Bedrock model, or `None` where none is reachable.

    `None` rather than a raise, and the distinction matters: a report with no narrative is a
    complete report — the summary block still renders its compiler-placed figures — whereas
    a raise here would withhold a document whose every figure verifies over a decoration.

    The client is built **here** and nowhere else. `tests/test_boundaries.py` asserts that no
    module outside `narrate/` reaches a Bedrock client, which is what makes "audit the model
    call sites" a directory listing rather than a search of the whole tree.
    """
    if not model_id:
        return None
    try:
        import boto3

        client = boto3.client("bedrock-runtime", region_name=region)
    except Exception as exc:
        logger.warning(
            "no Bedrock client could be built for the prose model (%s); this run's "
            "executive summary renders its figures with no narrative",
            type(exc).__name__,
        )
        return None
    return ProseGenerator(client=client, model_id=model_id, language=language)
