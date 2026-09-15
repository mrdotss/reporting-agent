"""The `chat` payload, parsed closed (ask-chat Req 1.3).

The web app is the only caller and it builds this payload from rows it has already
authorized, so a malformed payload is a defect rather than a user error: it raises
:class:`ChatPayloadError`, and the router turns that into one terminal `error` and `done`.

Every bound here is a cap on what reaches the model — a prompt, a history, a number of
attachments — so an oversized payload is refused rather than truncated silently.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

__all__ = [
    "MAX_ATTACHED_LIVE",
    "MAX_ATTACHED_RUNS",
    "MAX_ATTACHED_SCANS",
    "MAX_HISTORY_TURNS",
    "MAX_PROMPT_CHARS",
    "MAX_REQUEST_TARGETS",
    "AttachedLive",
    "AttachedRun",
    "AttachedScan",
    "ChatPayloadError",
    "ChatRequest",
    "HistoryTurn",
    "RequestTarget",
    "detect_language",
    "parse_chat_request",
]

MAX_PROMPT_CHARS: Final[int] = 4000
MAX_HISTORY_TURNS: Final[int] = 12
MAX_ATTACHED_RUNS: Final[int] = 6
MAX_ATTACHED_SCANS: Final[int] = 4
MAX_ATTACHED_LIVE: Final[int] = 4
MAX_REQUEST_TARGETS: Final[int] = 50
MAX_LABEL_CHARS: Final[int] = 200

_IDENTIFIER: Final[re.Pattern[str]] = re.compile(r"^[A-Za-z0-9_.:@+-]{1,128}$")
"""Run ids, actor ids, attempt ids, scan ids and target ids. Every one of them either
prefixes an S3 key or is echoed back in an outcome, so a `/` or a newline is refused here
rather than discovered in a key."""


class ChatPayloadError(ValueError):
    """The `chat` payload does not have the shape the web app is contracted to send."""


@dataclass(frozen=True, slots=True)
class HistoryTurn:
    role: str
    text: str


@dataclass(frozen=True, slots=True)
class AttachedRun:
    """A verified report the app authorized this conversation to read.

    `owner_actor_id` is the run owner's id, which may not be the asking user's: a report is
    shared across a workspace, and its artifacts live under the owner's prefix. The app has
    already checked the asker's workspace membership; this runtime reads the key it names.
    """

    run_id: str
    owner_actor_id: str
    verification_attempt_id: str
    customer_name: str
    period_display: str
    provider: str


@dataclass(frozen=True, slots=True)
class AttachedScan:
    """A connector's latest saved scan, projected by the app. No credential travels here."""

    scan_id: str
    connector_label: str
    provider: str
    collected_at: str
    inventory: Mapping[str, Any]


@dataclass(frozen=True, slots=True)
class AttachedLive:
    """A completed live metrics pull (ask-chat Req 8): a snapshot, never verified.

    Its snapshot lives under the pulling user's prefix, named by `pull_id`, exactly as a
    run's does under its owner's. The figures it yields are cited as live and unverified.
    """

    pull_id: str
    owner_actor_id: str
    connector_label: str
    window_display: str
    collected_at: str


@dataclass(frozen=True, slots=True)
class RequestTarget:
    """A customer and connector a report may be proposed for. The id is opaque."""

    target_id: str
    customer_name: str
    connector_label: str
    provider: str


@dataclass(frozen=True, slots=True)
class ChatRequest:
    prompt: str
    history: tuple[HistoryTurn, ...]
    runs: tuple[AttachedRun, ...]
    scans: tuple[AttachedScan, ...]
    targets: tuple[RequestTarget, ...]
    live: tuple[AttachedLive, ...] = ()


def parse_chat_request(payload: Mapping[str, Any]) -> ChatRequest:
    """Parse and bound the payload, raising :class:`ChatPayloadError` on any deviation."""
    prompt = _text(payload.get("prompt"), "prompt", MAX_PROMPT_CHARS)

    history_raw = _sequence(payload.get("history", []), "history")
    if len(history_raw) > MAX_HISTORY_TURNS:
        raise ChatPayloadError(
            f"`history` carries {len(history_raw)} turns; at most {MAX_HISTORY_TURNS} are sent."
        )
    history = tuple(_turn(item, index) for index, item in enumerate(history_raw))

    attachments = payload.get("attachments", {})
    if not isinstance(attachments, Mapping):
        raise ChatPayloadError("`attachments` must be an object.")

    runs_raw = _sequence(attachments.get("runs", []), "attachments.runs")
    scans_raw = _sequence(attachments.get("scans", []), "attachments.scans")
    live_raw = _sequence(attachments.get("live", []), "attachments.live")
    targets_raw = _sequence(payload.get("request_targets", []), "request_targets")

    if len(runs_raw) > MAX_ATTACHED_RUNS:
        raise ChatPayloadError(f"at most {MAX_ATTACHED_RUNS} reports can be attached.")
    if len(scans_raw) > MAX_ATTACHED_SCANS:
        raise ChatPayloadError(f"at most {MAX_ATTACHED_SCANS} connectors can be attached.")
    if len(live_raw) > MAX_ATTACHED_LIVE:
        raise ChatPayloadError(f"at most {MAX_ATTACHED_LIVE} live metrics pulls can be attached.")
    if len(targets_raw) > MAX_REQUEST_TARGETS:
        raise ChatPayloadError(f"at most {MAX_REQUEST_TARGETS} request targets are sent.")

    return ChatRequest(
        prompt=prompt,
        history=history,
        runs=tuple(_run(item) for item in runs_raw),
        scans=tuple(_scan(item) for item in scans_raw),
        targets=tuple(_target(item) for item in targets_raw),
        live=tuple(_live(item) for item in live_raw),
    )


def _turn(item: object, index: int) -> HistoryTurn:
    if not isinstance(item, Mapping):
        raise ChatPayloadError(f"`history[{index}]` must be an object.")
    role = item.get("role")
    if role not in ("user", "assistant"):
        raise ChatPayloadError(f"`history[{index}].role` must be `user` or `assistant`.")
    return HistoryTurn(role=role, text=_text(item.get("text"), f"history[{index}].text", MAX_PROMPT_CHARS))


def _run(item: object) -> AttachedRun:
    record = _mapping(item, "attachments.runs[]")
    return AttachedRun(
        run_id=_identifier(record.get("run_id"), "run_id"),
        owner_actor_id=_identifier(record.get("owner_actor_id"), "owner_actor_id"),
        verification_attempt_id=_identifier(
            record.get("verification_attempt_id"), "verification_attempt_id"
        ),
        customer_name=_text(record.get("customer_name"), "customer_name", MAX_LABEL_CHARS),
        period_display=_text(record.get("period_display"), "period_display", MAX_LABEL_CHARS),
        provider=_text(record.get("provider"), "provider", 32),
    )


def _scan(item: object) -> AttachedScan:
    record = _mapping(item, "attachments.scans[]")
    inventory = record.get("inventory")
    if not isinstance(inventory, Mapping):
        raise ChatPayloadError("`attachments.scans[].inventory` must be an object.")
    return AttachedScan(
        scan_id=_identifier(record.get("scan_id"), "scan_id"),
        connector_label=_text(record.get("connector_label"), "connector_label", MAX_LABEL_CHARS),
        provider=_text(record.get("provider"), "provider", 32),
        collected_at=_text(record.get("collected_at"), "collected_at", 64),
        inventory=inventory,
    )


def _live(item: object) -> AttachedLive:
    record = _mapping(item, "attachments.live[]")
    return AttachedLive(
        pull_id=_identifier(record.get("pull_id"), "pull_id"),
        owner_actor_id=_identifier(record.get("owner_actor_id"), "owner_actor_id"),
        connector_label=_text(record.get("connector_label"), "connector_label", MAX_LABEL_CHARS),
        window_display=_text(record.get("window_display"), "window_display", MAX_LABEL_CHARS),
        collected_at=_text(record.get("collected_at"), "collected_at", 64),
    )


def _target(item: object) -> RequestTarget:
    record = _mapping(item, "request_targets[]")
    return RequestTarget(
        target_id=_identifier(record.get("target_id"), "target_id"),
        customer_name=_text(record.get("customer_name"), "customer_name", MAX_LABEL_CHARS),
        connector_label=_text(record.get("connector_label"), "connector_label", MAX_LABEL_CHARS),
        provider=_text(record.get("provider"), "provider", 32),
    )


def _mapping(item: object, name: str) -> Mapping[str, Any]:
    if not isinstance(item, Mapping):
        raise ChatPayloadError(f"`{name}` must be an object.")
    return item


def _sequence(value: object, name: str) -> Sequence[object]:
    if not isinstance(value, Sequence) or isinstance(value, (str, bytes)):
        raise ChatPayloadError(f"`{name}` must be an array.")
    return value


def _text(value: object, name: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ChatPayloadError(f"`{name}` must be a non-blank string.")
    if len(value) > limit:
        raise ChatPayloadError(f"`{name}` is {len(value)} characters; the limit is {limit}.")
    return value.strip()


def _identifier(value: object, name: str) -> str:
    if not isinstance(value, str) or not _IDENTIFIER.match(value):
        raise ChatPayloadError(f"`{name}` must be an identifier of 1-128 safe characters.")
    return value


_INDONESIAN_WORDS: Final[frozenset[str]] = frozenset(
    {
        "apa", "apakah", "yang", "dan", "atau", "berapa", "bagaimana", "kenapa", "mengapa",
        "untuk", "ini", "itu", "tidak", "bisa", "saya", "kami", "kita", "dengan", "dari",
        "pada", "mana", "laporan", "biaya", "harga", "bulan", "tolong", "buatkan", "sudah",
        "belum", "paling", "lebih", "pelanggan", "penggunaan", "dong", "adalah", "ada",
        "akan", "juga", "karena", "jika", "kalau", "berikan", "jelaskan", "bandingkan",
        # Imperatives and pronouns: a refused prompt is often an instruction rather than
        # a question, and it carries few of the question words above.
        "abaikan", "tampilkan", "tunjukkan", "sebutkan", "buat", "semua", "seluruh",
        "sebelumnya", "secara", "lengkap", "kamu", "anda", "aku", "kalian", "saja",
        "tentang", "bagaimanakah", "sekarang", "harus", "jangan", "dalam",
    }
)


def detect_language(text: str) -> str:
    """`id` when the text reads as Indonesian, otherwise `en`.

    The runtime states the reply language to the model from this answer (see
    `narrate/chat.system_prompt`) and writes its own refusal in it. A heuristic is enough:
    the cost of misjudging it is an answer in the other language, never a wrong figure.
    """
    words = re.findall(r"[a-z]+", text.lower())
    if not words:
        return "en"
    hits = sum(1 for word in words if word in _INDONESIAN_WORDS)
    return "id" if hits >= 2 or hits / len(words) >= 0.25 else "en"
