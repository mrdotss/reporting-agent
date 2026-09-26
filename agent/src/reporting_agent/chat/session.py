"""One chat turn: ground, price, answer, enforce (ask-chat Req 1, 9).

The order is the design. Everything the model may cite is gathered **before** the model is
called — verified ledgers, saved scan counts, live metrics pulls, list prices — and every
chunk the model writes passes through
:class:`~reporting_agent.chat.stream_filter.AnswerFilter` before it becomes a `delta`. The
turn's result rides on `done` through the invocation outcome:

- `language` — the language this turn was answered in;
- `citations` — each fact the answer used, with the path or price it came from;
- `charts` — each chart the answer placed, built from those facts' values and the snapshots'
  daily buckets, never from numbers the model wrote;
- `proposal` — a report request the user may confirm, when one survived the allow-list;
- `refused`, `unavailable_runs`, `unavailable_live`, `prices_unavailable`,
  `withheld_figures` — what the UI should say about what was not used;
- `thought_seconds` — how long the answer model reasoned before it wrote.

`tool` for the three steps and `delta` for the answer text, plus two events that exist so
a question is not a silent spinner while the answer model reasons:

- `intent` — one sentence from a fast second model saying what the assistant is about to
  do (`narrate/intent.py`). It runs in parallel with everything else and is sent only if
  it is ready before the first `delta`; after that it would be noise.
- `thinking` — the answer model's reasoning as it streams, with every number masked and
  its markup removed (`chat/thinking.py`). It is never checked, so it is never the answer.
"""

from __future__ import annotations

import asyncio
import contextlib
import secrets
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Sequence
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Final

from reporting_agent.chat.charts import ChartRequest, SeriesKey, build_chart
from reporting_agent.chat.grounding import (
    SOURCE_PRICE,
    Fact,
    LiveGrounding,
    LiveUnavailableError,
    RunGrounding,
    RunUnavailableError,
    VmSize,
    format_statistic,
    load_live_grounding,
    load_run_grounding,
    number_facts,
    scan_facts,
    select_facts,
)
from reporting_agent.chat.knowledge import (
    Fetch,
    Knowledge,
    SkillRouter,
    gather_knowledge,
    knowledge_section,
    knowledge_sources,
)
from reporting_agent.chat.payload import ChatRequest, detect_language
from reporting_agent.chat.stream_filter import AnswerFilter
from reporting_agent.chat.thinking import ThinkingMask
from reporting_agent.narrate.chat import (
    GUARDRAIL_INTERVENED,
    ChatModel,
    build_grounding,
    build_messages,
    refusal_text,
    system_prompt,
)
from reporting_agent.pricing.aws_prices import (
    PROVIDER_AWS,
    normalize_aws_pair,
)
from reporting_agent.pricing.azure_retail import (
    MAX_PAIRS,
    PriceLookupResult,
    RetailPrice,
    VmPricePair,
    normalize_pair,
)
from reporting_agent.storage.base import ObjectStore

if TYPE_CHECKING:
    from reporting_agent.main import StepTracker

__all__ = [
    "ANSWER_BLOCK_ID",
    "TOOL_COMPOSE_ANSWER",
    "TOOL_LOOKUP_PRICES",
    "TOOL_READ_GROUNDING",
    "ChatDependencies",
    "price_facts",
    "run_chat",
]

TOOL_READ_GROUNDING: Final[str] = "read_grounding"
TOOL_LOOKUP_PRICES: Final[str] = "lookup_prices"
TOOL_COMPOSE_ANSWER: Final[str] = "compose_answer"
TOOL_FIND_KNOWLEDGE: Final[str] = "find_knowledge"
TOOL_LOAD_SKILL: Final[str] = "load_skill"
TOOL_READ_DOC: Final[str] = "read_doc"
ANSWER_BLOCK_ID: Final[str] = "answer"

PriceLookup = Callable[[Sequence[VmPricePair]], Awaitable[PriceLookupResult]]
IntentWriter = Callable[..., Awaitable[str | None]]
"""Called as `writer(prompt=…, context=[…], language=…)`; `None` means no sentence."""

MAX_PREVIOUS_QUESTION_CHARS: Final[int] = 300


@dataclass(frozen=True, slots=True)
class ChatDependencies:
    store: ObjectStore
    model: ChatModel
    prices: PriceLookup | None
    intent: IntentWriter | None = None
    choose: Callable[[str], ChatModel] | None = None
    skills: SkillRouter | None = None
    """Chooses the provider skills and pages a question needs; `None` uses none."""
    fetch: Fetch | None = None
    """Reads one allowlisted documentation page (`skills/fetch.py`)."""
    """Builds the model for a choice in `CHAT_MODEL_CHOICES`; `None` answers every turn
    with `model`."""


async def run_chat(
    request: ChatRequest,
    *,
    steps: StepTracker,
    outcome: dict[str, Any],
    store: ObjectStore,
    model: ChatModel,
    prices: PriceLookup | None,
    intent: IntentWriter | None = None,
    skills: SkillRouter | None = None,
    fetch: Fetch | None = None,
) -> AsyncIterator[dict[str, Any]]:
    language = detect_language(request.prompt)
    outcome["language"] = language
    turn = _turn(
        request,
        language=language,
        steps=steps,
        outcome=outcome,
        store=store,
        model=model,
        prices=prices,
        skills=skills,
        fetch=fetch,
    )
    if intent is None:
        async for event in turn:
            yield event
        return
    pending = asyncio.ensure_future(
        intent(prompt=request.prompt, context=_intent_context(request), language=language)
    )
    async for event in _with_intent(turn, pending):
        yield event


async def _with_intent(
    events: AsyncIterator[dict[str, Any]], pending: asyncio.Future[str | None]
) -> AsyncIterator[dict[str, Any]]:
    """`events`, with the intent sentence let in as soon as it is ready — unless the
    answer has already started, when it is dropped rather than shown out of order."""
    iterator = aiter(events)
    upcoming: asyncio.Future[dict[str, Any]] = asyncio.ensure_future(anext(iterator))
    waiting: asyncio.Future[str | None] | None = pending
    try:
        while True:
            watched: set[asyncio.Future[Any]] = {upcoming}
            if waiting is not None:
                watched.add(waiting)
            done, _ = await asyncio.wait(watched, return_when=asyncio.FIRST_COMPLETED)
            if waiting is not None and waiting in done:
                sentence = None if waiting.exception() else waiting.result()
                waiting = None
                if sentence:
                    yield {"type": "intent", "text": sentence}
            if upcoming in done:
                try:
                    event = upcoming.result()
                except StopAsyncIteration:
                    return
                if event.get("type") == "delta" and waiting is not None:
                    waiting.cancel()
                    waiting = None
                yield event
                upcoming = asyncio.ensure_future(anext(iterator))
    finally:
        pending.cancel()
        if not upcoming.done():
            upcoming.cancel()
            with contextlib.suppress(asyncio.CancelledError, StopAsyncIteration):
                await upcoming
        with contextlib.suppress(RuntimeError):
            await iterator.aclose()  # type: ignore[attr-defined]


def _intent_context(request: ChatRequest) -> list[str]:
    """What is attached, by name, for the intent sentence. Digits are removed later."""
    lines = [f"{run.customer_name} report, {run.period_display}" for run in request.runs]
    lines += [f"{live.connector_label} live metrics, {live.window_display}" for live in request.live]
    lines += [f"{scan.connector_label} inventory scan" for scan in request.scans]
    previous = next((turn.text for turn in reversed(request.history) if turn.role == "user"), "")
    if previous:
        lines.append(f"The user's previous question: {previous[:MAX_PREVIOUS_QUESTION_CHARS]}")
    return lines


async def _turn(
    request: ChatRequest,
    *,
    language: str,
    steps: StepTracker,
    outcome: dict[str, Any],
    store: ObjectStore,
    model: ChatModel,
    prices: PriceLookup | None,
    skills: SkillRouter | None = None,
    fetch: Fetch | None = None,
) -> AsyncIterator[dict[str, Any]]:
    # Provider knowledge is looked up from the start, beside the grounding reads below, so
    # its two short model calls and page reads overlap work the turn does anyway.
    looking: asyncio.Task[Knowledge] | None = (
        asyncio.ensure_future(gather_knowledge(request, router=skills, fetch=fetch))
        if skills is not None and fetch is not None
        else None
    )
    try:
        async for event in _answer(
            request,
            language=language,
            steps=steps,
            outcome=outcome,
            store=store,
            model=model,
            prices=prices,
            looking=looking,
        ):
            yield event
    finally:
        if looking is not None and not looking.done():
            looking.cancel()


async def _answer(
    request: ChatRequest,
    *,
    language: str,
    steps: StepTracker,
    outcome: dict[str, Any],
    store: ObjectStore,
    model: ChatModel,
    prices: PriceLookup | None,
    looking: asyncio.Task[Knowledge] | None,
) -> AsyncIterator[dict[str, Any]]:
    groundings: list[RunGrounding] = []
    live_groundings: list[LiveGrounding] = []
    unavailable: list[RunUnavailableError] = []
    unavailable_live: list[LiveUnavailableError] = []
    if request.runs or request.scans or request.live:
        step = steps.start(
            TOOL_READ_GROUNDING, label="Grounding", status=_grounding_status(request)
        )
        yield step
        for run in request.runs:
            try:
                groundings.append(await load_run_grounding(store, run))
            except RunUnavailableError as exc:
                unavailable.append(exc)
        for live in request.live:
            try:
                live_groundings.append(await load_live_grounding(store, live))
            except LiveUnavailableError as exc:
                unavailable_live.append(exc)
        yield steps.end(step["id"])

    facts: list[Fact] = [fact for grounding in groundings for fact in grounding.facts]
    series: dict[SeriesKey, Sequence[tuple[str, str]]] = {}
    for grounding in groundings:
        series.update(grounding.series)
    for live_grounding in live_groundings:
        facts.extend(live_grounding.facts)
        series.update(live_grounding.series)
    for scan in request.scans:
        facts.extend(scan_facts(scan))

    pairs = _price_pairs(
        [size for grounding in groundings for size in grounding.vm_sizes]
        + [size for live_grounding in live_groundings for size in live_grounding.vm_sizes]
    )
    if pairs and prices is not None:
        step = steps.start(
            TOOL_LOOKUP_PRICES,
            label="List prices",
            status=f"Looking up {_price_list_names(pairs)} list prices for {_plural(len(pairs), _size_noun(pairs))}",
        )
        yield step
        result = await prices(pairs)
        facts.extend(price_facts(result.prices))
        if result.unavailable:
            outcome["prices_unavailable"] = [
                f"{pair.sku} ({pair.region})" for pair in result.unavailable
            ]
        yield steps.end(step["id"])

    numbered = number_facts(select_facts(facts, query=request.prompt))
    if unavailable:
        outcome["unavailable_runs"] = [
            {"run_id": exc.run.run_id, "reason": exc.reason} for exc in unavailable
        ]
    if unavailable_live:
        outcome["unavailable_live"] = [
            {"pull_id": exc.live.pull_id, "reason": exc.reason} for exc in unavailable_live
        ]

    knowledge = Knowledge()
    if looking is not None:
        step = steps.start(
            TOOL_FIND_KNOWLEDGE, label="Knowledge", status="Checking whether provider guidance applies"
        )
        yield step
        try:
            knowledge = await looking
        except Exception:
            # A failed lookup is an answer without guidance, never a failed answer.
            knowledge = Knowledge()
        yield steps.end(step["id"])
        # One step per skill and per page, so the timeline — and the saved answer — says
        # exactly what the model was given beyond the attachments.
        for skill in knowledge.skills:
            loaded = steps.start(TOOL_LOAD_SKILL, label="Skill", status=f"Loaded {skill.title}")
            yield loaded
            yield steps.end(loaded["id"])
        for item in knowledge.items:
            if item.kind != "guide":
                read = steps.start(TOOL_READ_DOC, label="Docs", status=f"Read {item.title}")
                yield read
                yield steps.end(read["id"])
        if knowledge.skills:
            outcome["knowledge"] = knowledge_sources(knowledge)

    step = steps.start(TOOL_COMPOSE_ANSWER, label="Answer", status="Writing the answer")
    yield step

    def chart_builder(chart_request: ChartRequest, chart_id: str) -> dict[str, Any] | None:
        return build_chart(
            chart_request,
            chart_id=chart_id,
            facts=numbered,
            series=series,
            format_value=format_statistic,
        )

    answer = AnswerFilter(
        numbered,
        frozenset(target.target_id for target in request.targets),
        chart_builder=chart_builder,
    )
    grounding = build_grounding(
        nonce=secrets.token_hex(12),
        runs=[grounding.run for grounding in groundings],
        scans=request.scans,
        live=[live_grounding.live for live_grounding in live_groundings],
        facts=numbered,
        targets=request.targets,
        unavailable=[f"{exc.run.customer_name} {exc.run.period_display}" for exc in unavailable]
        + [f"{exc.live.connector_label} {exc.live.window_display}" for exc in unavailable_live],
        daily_series=frozenset(
            fact_id
            for fact_id, fact in numbered.items()
            if fact.series_key is not None and len(series.get(fact.series_key, ())) >= 2
        ),
        knowledge=knowledge_section(knowledge),
    )
    messages = build_messages(history=request.history, prompt=request.prompt, grounding=grounding)

    thinking = ThinkingMask()
    thinking_since: float | None = None
    async for kind, value in model.stream(system=system_prompt(language), messages=messages):
        if kind == "stop":
            if value == GUARDRAIL_INTERVENED:
                answer.mark_refused()
            continue
        if kind == "reasoning":
            if thinking_since is None:
                thinking_since = time.monotonic()
            masked = thinking.feed(value)
            if masked:
                yield {"type": "thinking", "text": masked}
            continue
        if thinking_since is not None and "thought_seconds" not in outcome:
            outcome["thought_seconds"] = round(time.monotonic() - thinking_since)
            masked = thinking.finish()
            if masked:
                yield {"type": "thinking", "text": masked}
        text = answer.feed(value)
        if text:
            yield _delta(text)
    if thinking_since is not None and "thought_seconds" not in outcome:
        outcome["thought_seconds"] = round(time.monotonic() - thinking_since)

    tail = answer.finish()
    if answer.refused:
        outcome["refused"] = True
        yield _delta(refusal_text(language))
    elif tail:
        yield _delta(tail)
    yield steps.end(step["id"])

    outcome["citations"] = answer.citations()
    outcome["withheld_figures"] = answer.withheld
    if answer.charts:
        outcome["charts"] = answer.charts
    if answer.proposal is not None:
        outcome["proposal"] = answer.proposal


def price_facts(prices: Sequence[RetailPrice]) -> list[Fact]:
    return [_price_fact(price) for price in prices]


def _price_fact(price: RetailPrice) -> Fact:
    # A price is written into sentences, so it names its unit the way a sentence does —
    # `USD 0.0428 per hour`, not `per 1 Hour`. The citation keeps the API's own unit.
    per = _unit_phrase(price.unit_of_measure)
    return Fact(
        SOURCE_PRICE,
        f"{price.sku} in {price.region} · {price.operating_system} · list price",
        f"{price.currency} {_trim_price(price.retail_price)} per {per}".strip(),
        {
            "sku": price.sku,
            "region": price.region,
            "operating_system": price.operating_system,
            "currency": price.currency,
            "unit_of_measure": price.unit_of_measure,
            "effective_start": price.effective_start,
            "price_source": price.source,
        },
        value=price.retail_price if "e" not in price.retail_price.lower() else None,
        unit=f"{price.currency} per {per}",
    )


def _unit_phrase(unit_of_measure: str) -> str:
    """`1 Hour` → `hour`.

    Any other billing unit — `1 GB/Month`, `100 Hours` — is kept as the API wrote it.
    """
    count, _, name = unit_of_measure.strip().partition(" ")
    return name.lower() if count == "1" and name.isalpha() else unit_of_measure.strip()


def _price_pairs(sizes: Sequence[VmSize]) -> list[VmPricePair]:
    pairs: dict[VmPricePair, None] = {}
    for size in sizes:
        pair = (
            normalize_aws_pair(size.sku, size.region, engine=size.engine, multi_az=size.multi_az)
            if size.provider == PROVIDER_AWS
            else normalize_pair(size.sku, size.region)
        )
        if pair is not None:
            pairs.setdefault(pair, None)
    return list(pairs)[:MAX_PAIRS]


def _price_list_names(pairs: Sequence[VmPricePair]) -> str:
    clouds = {"AWS" if pair.provider == PROVIDER_AWS else "Azure" for pair in pairs}
    return " and ".join(sorted(clouds, key=lambda cloud: cloud != "Azure"))


def _size_noun(pairs: Sequence[VmPricePair]) -> str:
    """`VM size` while every pair is Azure, as the step always read; `size` once AWS joins."""
    return "VM size" if all(pair.provider != PROVIDER_AWS for pair in pairs) else "size"


def _trim_price(text: str) -> str:
    """`0.1920000` → `0.192`, `2.5` → `2.50`: the API's digits, fewer trailing zeros.

    String operations only — the value is the API's text, never a parsed number.
    """
    if "." not in text or "e" in text.lower():
        return text
    whole, fraction = text.split(".", 1)
    fraction = fraction.rstrip("0").ljust(2, "0")
    return f"{whole}.{fraction}"


def _grounding_status(request: ChatRequest) -> str:
    parts = []
    if request.runs:
        parts.append(_plural(len(request.runs), "verified report"))
    if request.live:
        parts.append(_plural(len(request.live), "live metrics pull"))
    if request.scans:
        parts.append(_plural(len(request.scans), "connector scan"))
    return "Reading " + " and ".join(parts)


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def _delta(text: str) -> dict[str, Any]:
    return {"type": "delta", "block_id": ANSWER_BLOCK_ID, "text": text}
