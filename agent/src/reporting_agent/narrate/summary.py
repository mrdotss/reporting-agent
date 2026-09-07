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

from reporting_agent.compile.blocks.base import (
    PROSE_KIND_EXECUTIVE_SUMMARY,
    PROSE_KIND_RESOURCE,
    PROSE_KIND_TREND,
    ProseRequest,
)

__all__ = [
    "MAX_OUTPUT_TOKENS",
    "SYSTEM_PROMPT",
    "SYSTEM_PROMPT_ID",
    "SYSTEM_PROMPT_TREND",
    "SYSTEM_PROMPT_TREND_ID",
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


SYSTEM_PROMPT_TREND: Final[str] = (
    "You write the historical-trend commentary of an infrastructure utilization "
    "report.\n"
    "\n"
    "The figures below are grouped by resource, each one labelled with its resource, "
    "its metric and the calendar month it was measured in. Write ONE short paragraph "
    "per resource, in the order the resources appear, describing how that resource "
    "moved across the months shown: rising, falling, flat, or too short a history to "
    "say. Separate the paragraphs with a blank line and write nothing else — no "
    "resource headings, no summary paragraph, no closing.\n"
    "\n"
    "A resource with one month has no trend; say that plainly rather than describing "
    "a direction. Do not write any number that is not in the list of figures given to "
    "you. Do not compute a difference, a percentage change, a rate or an average "
    "across months — describe the movement in words. Do not speculate about causes "
    "you cannot see in the data.\n"
    "\n"
    "Return prose only: no headings, no bullet lists, no markdown."
)
"""The trend instruction (Req 19.5's "request, not enforcement" applies unchanged).

**One paragraph per resource, not per metric.** A paragraph for every resource-metric
pair would be the same report written many times over, and the token cost grows with the
product of two estate dimensions rather than with one.

The "do not compute a difference" clause matters more here than in the summary: a trend
is precisely the shape that invites "up 12% from May", and 12 is a number the compiler
never placed. The masking pass would catch it and withhold the report, so the clause is
there to keep the common case pleasant — as ever, not to make the guarantee hold."""

SYSTEM_PROMPT_TREND_ID: Final[str] = (
    "Anda menulis ulasan tren historis dari laporan utilisasi infrastruktur.\n"
    "\n"
    "Angka-angka di bawah ini dikelompokkan per sumber daya, masing-masing diberi label "
    "sumber daya, metrik, dan bulan kalender saat diukur. Tulis SATU paragraf pendek "
    "per sumber daya, sesuai urutan kemunculan sumber daya tersebut, yang menjelaskan "
    "bagaimana sumber daya itu bergerak sepanjang bulan-bulan yang ditampilkan: naik, "
    "turun, datar, atau riwayatnya terlalu pendek untuk disimpulkan. Pisahkan paragraf "
    "dengan satu baris kosong dan jangan tulis apa pun selain itu — tanpa judul sumber "
    "daya, tanpa paragraf ringkasan, tanpa penutup.\n"
    "\n"
    "Sumber daya dengan satu bulan tidak memiliki tren; sampaikan hal itu secara jelas "
    "alih-alih menjelaskan sebuah arah. Jangan menulis angka apa pun yang tidak ada "
    "dalam daftar angka yang diberikan kepada Anda. Jangan menghitung selisih, "
    "perubahan persentase, laju, atau rata-rata antarbulan — jelaskan pergerakannya "
    "dengan kata-kata. Jangan berspekulasi tentang penyebab yang tidak dapat Anda lihat "
    "dalam data.\n"
    "\n"
    "Kembalikan prosa saja: tanpa heading, tanpa bullet list, tanpa markdown."
)
"""Indonesian variant of the trend instruction (Req 15.7), on the same terms as
:data:`SYSTEM_PROMPT_ID`."""

SYSTEM_PROMPT_RESOURCE: Final[str] = (
    "You write the short review that sits under one resource in an infrastructure "
    "utilization report.\n"
    "\n"
    "Every figure below belongs to the SAME resource and covers the SAME reporting "
    "period, each labelled with its resource, its metric and its window. Write ONE "
    "short paragraph — three sentences at most — saying what this resource did over the "
    "period: how heavily it was used, whether its peaks are far from its averages, and "
    "whether anything in the figures deserves a reader's attention. Write nothing else "
    "— no heading, no resource name on its own line, no recommendation list, no "
    "closing.\n"
    "\n"
    "Do not write any number that is not in the list of figures given to you. Do not "
    "compute a difference, a percentage, a ratio, a headroom or an average across the "
    "figures — describe what you see in words. Do not recommend a resize, a SKU or a "
    "cost action: you are not shown price, quota or workload, and a recommendation "
    "drawn from utilization alone would be a guess presented as advice. Do not "
    "speculate about causes you cannot see in the data.\n"
    "\n"
    "Return prose only: no headings, no bullet lists, no markdown."
)
"""The per-resource instruction.

**Three sentences at most, and no advice.** This narration is expanded once per resource,
so its length is multiplied by the estate — and unlike the executive summary it sits
directly beneath the table and chart that already state the figures, so a paragraph that
restates them adds a page and nothing else.

The refusal to recommend is not modesty. Advisor's own recommendations are collected,
verified and tabled in their own section of this report; a paragraph inventing a second,
unverifiable set from utilization alone would put two kinds of advice in one document and
only one of them would trace to anything.
"""

SYSTEM_PROMPT_RESOURCE_ID: Final[str] = (
    "Anda menulis ulasan singkat yang ditempatkan di bawah satu sumber daya dalam "
    "laporan pemanfaatan infrastruktur.\n"
    "\n"
    "Semua angka di bawah ini milik sumber daya yang SAMA dan mencakup periode "
    "pelaporan yang SAMA, masing-masing diberi label sumber daya, metrik, dan "
    "jendelanya. Tulis SATU paragraf pendek — maksimal tiga kalimat — yang menjelaskan "
    "apa yang dilakukan sumber daya ini sepanjang periode tersebut: seberapa berat "
    "penggunaannya, apakah puncaknya jauh dari rata-ratanya, dan apakah ada hal dalam "
    "angka-angka itu yang perlu diperhatikan pembaca. Jangan tulis apa pun selain itu "
    "— tanpa judul, tanpa nama sumber daya pada baris tersendiri, tanpa daftar "
    "rekomendasi, tanpa penutup.\n"
    "\n"
    "Jangan menulis angka apa pun yang tidak ada dalam daftar angka yang diberikan "
    "kepada Anda. Jangan menghitung selisih, persentase, rasio, sisa kapasitas, atau "
    "rata-rata antarangka — jelaskan apa yang Anda lihat dengan kata-kata. Jangan "
    "merekomendasikan perubahan ukuran, SKU, atau tindakan biaya: Anda tidak diberi "
    "harga, kuota, atau beban kerja, dan rekomendasi yang ditarik dari pemanfaatan "
    "saja adalah tebakan yang disajikan sebagai saran. Jangan berspekulasi tentang "
    "penyebab yang tidak dapat Anda lihat dalam data.\n"
    "\n"
    "Kembalikan prosa saja: tanpa heading, tanpa bullet list, tanpa markdown."
)
"""Indonesian variant of the per-resource instruction (Req 15.7)."""

_PROMPTS: Final[dict[tuple[str, str], str]] = {
    (PROSE_KIND_EXECUTIVE_SUMMARY, "en"): SYSTEM_PROMPT,
    (PROSE_KIND_EXECUTIVE_SUMMARY, "id"): SYSTEM_PROMPT_ID,
    (PROSE_KIND_TREND, "en"): SYSTEM_PROMPT_TREND,
    (PROSE_KIND_TREND, "id"): SYSTEM_PROMPT_TREND_ID,
    (PROSE_KIND_RESOURCE, "en"): SYSTEM_PROMPT_RESOURCE,
    (PROSE_KIND_RESOURCE, "id"): SYSTEM_PROMPT_RESOURCE_ID,
}


def _system_prompt_for(
    language: str, kind: str = PROSE_KIND_EXECUTIVE_SUMMARY
) -> str:
    """The narrator instruction for one language and one narration.

    Falls back rather than raising, in both dimensions: an unknown language reads as
    English and an unknown kind as the executive summary. A report narrated under the
    wrong instruction is a bad report; a report withheld because a kind was misspelled is
    worse, and the masking pass constrains what the model may write either way.
    """
    resolved = language if language == "id" else "en"
    return _PROMPTS.get(
        (kind, resolved), _PROMPTS[(PROSE_KIND_EXECUTIVE_SUMMARY, resolved)]
    )


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
            system=[{"text": _system_prompt_for(language, request.kind)}],
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
        # Loud, because this is a misconfiguration rather than a choice. `config.py`
        # *requires* `RPT_PROSE_MODEL_ID`, so an empty id here means the configured value
        # did not reach this call — which is what happened between the trend narrative
        # shipping and this guard: `main.py` omitted `prose_model_id`, the pipeline's `""`
        # default won, and every report rendered its no-narrative fallback with nothing in
        # any log to say why.
        logger.warning(
            "no prose model id reached the generator, so this run writes no narrative; "
            "the configuration requires one, so this is a wiring fault rather than a "
            "deployment without a model"
        )
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
