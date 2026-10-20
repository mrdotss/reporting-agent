"""Agent paragraphs: words the agent writes on the author's instruction, through the real pipeline.

The promises tested here:

* The model is shown the figures of the blocks a paragraph reads — those and no others — with
  the author's instruction, length, voice and the report's language.
* What it writes reaches the document unaltered, and the report verifies. An answer the
  narrator refuses (a number it was not shown) costs the paragraph, never the report: the
  preset's note stands in for it, or nothing does.
* Each outcome is recorded in `agent.json` beside the report, the written words are kept in
  `prose.json`, and a re-verification replays them byte for byte.
* The coverage section names the sections that carry agent-written words.
"""

from __future__ import annotations

import asyncio
import json
from io import BytesIO
from types import SimpleNamespace
from typing import Any

import pytest

import test_aws_collector  # noqa: F401  (sets the environment the agent's config reads)
from reporting_agent.compile.blocks.agent import agent_paragraphs_of
from reporting_agent.compile.blocks.base import PROSE_KIND_AGENT, ProseRequest
from reporting_agent.narrate.summary import build_messages, generate_with_reason
from reporting_agent.redaction import discard_secrets
from reporting_agent.render import pdf as P

Event = dict[str, Any]

INSTRUCTION = {"en": "Say which instances ran above 80% at peak and whether that needs attention."}
NOTE = {"en": "The agent's commentary on these figures was not written for this report."}


def _definition() -> dict[str, Any]:
    from test_aws_report import aws_definition
    from test_v4_report import _to_v4

    definition = _to_v4(aws_definition())
    for section in definition["sections"]:
        if section["type"] == "ec2_utilization":
            section["blocks"] = [
                {"slot": "title", "title": {"en": "Compute use"}},
                # Placed above the blocks it reads: the request is built after they compile.
                {"kind": "agent", "id": "u_ag1", "instruction": INSTRUCTION, "reads": ["fleet"],
                 "length": "short", "voice": "executive"},
                {"slot": "each"},
                {"slot": "fleet"},
                {"kind": "agent", "id": "u_ag2", "instruction": {"en": "Name the quietest instance."},
                 "reads": ["fleet"], "fallback": "note", "note": NOTE},
                # No `reads`: the whole section.
                {"kind": "agent", "id": "u_ag3", "instruction": {"en": "Summarise the section."}},
            ]
        elif section["type"] == "ebs_volumes":
            # A section whose blocks carry no figure: there is nothing to ask the agent about.
            section.setdefault("blocks", []).extend([{"slot": "title"}, {"kind": "agent", "id": "u_ag4", "instruction": {"en": "Summarise the volumes."}}])
    return definition


class FakeProse:
    """A narrator that answers by block: the first paragraph quotes a figure it was shown,
    the second is refused, the third never answers."""

    def __init__(self) -> None:
        self.requests: dict[str, ProseRequest] = {}
        self.reasons: dict[str, str] = {}

    def narrate(self, request: ProseRequest) -> str:
        self.requests[request.block_id] = request
        if request.kind != PROSE_KIND_AGENT:
            return ""
        if request.block_id.endswith("__u_ag1"):
            self.reasons[request.block_id] = "written"
            return f"The busiest instance peaked at {request.figures[0][1]}, which deserves a look."
        if request.block_id.endswith("__u_ag2"):
            self.reasons[request.block_id] = "unprovable_figures"
            return ""
        self.reasons[request.block_id] = "model_failed"
        return ""

    def reason_for(self, block_id: str) -> str | None:
        return self.reasons.get(block_id)


def _context() -> dict[str, Any]:
    from test_aws_collector import ACCOUNT

    return {"actor_id": "actor-1", "run_id": "run-1", "subscription_id": ACCOUNT, "timezone": "UTC",
            "provider": "aws", "fidelity_tier": "baseline", "display_name": "Example AWS"}


def _payload(definition: dict[str, Any]) -> dict[str, Any]:
    from test_run_end_to_end_v2 import invoke_payload

    payload = invoke_payload(definition)
    payload["period"] = {"start": "2026-09-01", "end": "2026-09-01"}
    payload["scope"] = {"resource_types": [], "resource_groups": [], "tag_filters": {}, "regions": ["us-east-1", "ap-southeast-3"]}
    payload.pop("context", None)
    return payload


@pytest.fixture(scope="module")
def walk():
    if P.SOFFICE_BINARY is None:
        pytest.skip("LibreOffice is not installed")
    from fakes.object_store import InMemoryObjectStore
    from reporting_agent.catalog.loader import load_catalog
    from reporting_agent.main import StepTracker
    from reporting_agent.report_pipeline import ReportOutcome, run_generate_report
    from test_aws_collector import fake_clients, provider

    store = InMemoryObjectStore()
    prose = FakeProse()
    events: list[Event] = []

    async def go() -> None:
        async for event in run_generate_report(
            payload=_payload(_definition()), context=_context(), steps=StepTracker(),
            artifact_bucket="unused", outcome=ReportOutcome(), prose=prose,
            provider=provider(store, fake_clients()), object_store=store, catalog=load_catalog(),
        ):
            events.append(event)

    try:
        asyncio.run(go())
    except Exception:  # a report with gaps ends PARTIAL_COVERAGE, which is still a delivery
        pass
    finally:
        discard_secrets()
    return store, events, prose


def _object(store, suffix: str) -> Any:
    key = next(key for key in store.keys() if key.endswith(suffix))
    return json.loads(store.get(key).body)


def _docx_paragraphs(store) -> list[tuple[str, str]]:
    from docx import Document

    key = next(key for key in store.keys() if key.endswith("/report.docx"))
    document = Document(BytesIO(store.get(key).body))
    return [(p.style.name, p.text) for p in document.paragraphs]


class TestTheWalk:
    def test_the_report_verifies(self, walk) -> None:
        _, events, _ = walk
        verification = next(e for e in events if e["type"] == "verification")
        assert verification["status"] == "pass", verification.get("findings")

    def test_the_model_sees_only_what_the_paragraph_reads(self, walk) -> None:
        _, _, prose = walk
        request = next(r for block_id, r in prose.requests.items() if block_id.endswith("__u_ag1"))
        assert request.kind == PROSE_KIND_AGENT
        assert request.instruction == INSTRUCTION["en"]
        assert (request.length, request.voice, request.language) == ("short", "executive", "en")
        # The fleet table compiled after the paragraph, and its figures are there.
        assert request.figures
        assert all(" · " in label for label, _ in request.figures)
        everything = next(r for block_id, r in prose.requests.items() if block_id.endswith("__u_ag3"))
        assert everything.figures, "an empty `reads` reads the whole section"

    def test_the_written_paragraph_prints_and_the_others_fall_back(self, walk) -> None:
        store, _, prose = walk
        paragraphs = _docx_paragraphs(store)
        texts = [text for _, text in paragraphs]
        written = next(r for block_id, r in prose.requests.items() if block_id.endswith("__u_ag1"))
        assert f"The busiest instance peaked at {written.figures[0][1]}, which deserves a look." in texts
        assert ("Notice", NOTE["en"]) in paragraphs  # the refused paragraph's note
        assert not any("Summarise the volumes" in text for text in texts)  # an instruction never prints

    def test_agent_json_records_every_outcome_and_why(self, walk) -> None:
        store, _, _ = walk
        bundle = _object(store, "/agent.json")
        assert bundle["schema_version"] == 1
        by_id = {entry["block_id"].split("__")[-1]: entry for entry in bundle["paragraphs"]}
        assert by_id["u_ag1"]["outcome"] == "written" and by_id["u_ag1"]["reason"] == "written"
        assert by_id["u_ag1"]["section_title"] == "Compute use"
        assert (by_id["u_ag2"]["outcome"], by_id["u_ag2"]["reason"]) == ("note", "unprovable_figures")
        assert (by_id["u_ag3"]["outcome"], by_id["u_ag3"]["reason"]) == ("omitted", "model_failed")
        assert (by_id["u_ag4"]["outcome"], by_id["u_ag4"]["reason"]) == ("omitted", "nothing_to_read")
        assert "text" not in by_id["u_ag1"]

    def test_the_words_are_kept_for_a_recompile(self, walk) -> None:
        store, _, _ = walk
        blocks = _object(store, "/prose.json")["blocks"]
        written = [text for block_id, text in blocks.items() if block_id.endswith("__u_ag1")]
        assert written and written[0].startswith("The busiest instance peaked at")
        assert not [block_id for block_id in blocks if block_id.endswith(("__u_ag2", "__u_ag3", "__u_ag4"))]

    def test_the_coverage_section_names_where_the_agent_wrote(self, walk) -> None:
        store, _, _ = walk
        texts = [text for _, text in _docx_paragraphs(store)]
        assert "Written by the agent" in texts
        record = next(text for text in texts if text.startswith("Paragraphs the agent wrote appear in:"))
        assert "Compute use" in record
        assert texts.index("Written by the agent") > texts.index("Compute use")



@pytest.fixture(scope="module")
def azure_walk():
    """The Azure v4 walk through `main.invoke`, with an agent paragraph, for re-verification:
    the path the suite's other re-verification tests drive."""
    if P.SOFFICE_BINARY is None:
        pytest.skip("LibreOffice is not installed")
    from test_run_end_to_end_v2 import V2Walk
    from test_v4_report import azure_v4_definition

    definition = azure_v4_definition()
    definition["sections"][0]["blocks"].insert(
        2, {"kind": "agent", "id": "u_ag1", "instruction": INSTRUCTION, "reads": ["summary"]}
    )
    prose = FakeProse()
    patcher = pytest.MonkeyPatch()
    patcher.setattr("reporting_agent.report_pipeline._prose_provider", lambda model_id, region: prose)
    try:
        walk = V2Walk()
        events = walk.run(patcher, defn=definition)
    finally:
        patcher.undo()
        discard_secrets()
    return walk, events, definition


def test_a_re_verification_replays_the_stored_words(azure_walk) -> None:
    import test_run_end_to_end_v3 as v3_walk

    walk, events, definition = azure_walk
    assert next(e for e in events if e["type"] == "verification")["status"] == "pass"
    assert any(key.endswith("/agent.json") for key in walk.store.keys())
    # No narrator is reachable here: the words come from `prose.json`, or not at all.
    replayed, error = v3_walk.TestReVerificationOfAV3Run._reverify(None, walk, definition)  # type: ignore[arg-type]
    # Reaching the end without raising is the byte-identity of the recompiled ledger, as in
    # the suite's other re-verification tests (which, like this one, do not require the
    # standalone re-verification's chart-sidecar checks to pass).
    assert error is None, f"re-verification raised: {error!r}"
    verification = next(e for e in replayed if e["type"] == "verification")
    about_the_paragraph = [f for f in verification.get("findings", []) if "u_ag1" in json.dumps(f)]
    assert about_the_paragraph == []


# --- the parts on their own -----------------------------------------------------------


def _request(**kwargs: Any) -> ProseRequest:
    base = {"block_id": "sec_a__u_ag1", "report_title": "Report", "subscription_display_name": "Acct",
            "window": "September 2026", "grain": "PT1H", "resource_count": 2,
            "figures": (("web · CPUUtilization (max)", "97.2%"),), "kind": PROSE_KIND_AGENT,
            "instruction": "Flag anything above 80%.", "length": "bullets", "voice": "technical", "language": "en"}
    return ProseRequest(**{**base, **kwargs})


def test_the_message_carries_the_instruction_length_and_voice() -> None:
    text = build_messages(_request())[0]["content"][0]["text"]
    assert "Instruction: Flag anything above 80%." in text
    assert "starting with \"• \"" in text
    assert "name the metrics" in text
    assert "- web · CPUUtilization (max): 97.2%" in text
    indonesian = build_messages(_request(language="id", length="sentence", voice="plain"))[0]["content"][0]["text"]
    assert "Tulis satu kalimat." in indonesian


class _Client:
    def __init__(self, text: str = "", stop: str = "end_turn", fail: bool = False) -> None:
        self.text, self.stop, self.fail = text, stop, fail
        self.system: str = ""

    def converse(self, **kwargs: Any) -> dict[str, Any]:
        if self.fail:
            raise TimeoutError("read timed out")
        self.system = kwargs["system"][0]["text"]
        return {"stopReason": self.stop, "output": {"message": {"content": [{"text": self.text}]}}}


@pytest.mark.parametrize(
    ("client", "expected"),
    [
        (_Client("• web peaked at 97.2%"), ("• web peaked at 97.2%", "written")),
        (_Client("• web ran above 80% at peak"), ("", "unprovable_figures")),
        (_Client("• half written", stop="max_tokens"), ("", "unfinished")),
        (_Client(""), ("", "empty")),
        (_Client(fail=True), ("", "model_failed")),
    ],
)
def test_every_answer_says_why_it_is_what_it_is(client: _Client, expected: tuple[str, str]) -> None:
    assert generate_with_reason(_request(), client=client, model_id="test.model") == expected


def test_an_indonesian_report_is_written_in_indonesian() -> None:
    client = _Client("Mesin web paling sibuk.")
    generate_with_reason(_request(language="id"), client=client, model_id="test.model", language="id")
    assert client.system.startswith("Anda menulis satu paragraf")


@pytest.mark.parametrize(
    ("prose", "length", "expected"),
    [
        (None, "short", ()),
        ("One.\n\nTwo.\n\nThree.", "short", ("One.", "Two.")),
        ("• a\n• b\n\n• c", "bullets", ("• a", "• b", "• c")),
    ],
)
def test_an_answer_is_split_and_bounded_but_never_rewritten(prose, length, expected) -> None:
    assert agent_paragraphs_of(prose, length) == expected


def test_the_record_is_placed_at_the_foot_of_the_coverage_section() -> None:
    from reporting_agent.compile.blocks.base import BlockSpec
    from reporting_agent.compile.sections import _with_agent_record

    def spec(block_id: str, kind: str = "heading") -> BlockSpec:
        return BlockSpec(id=block_id, type=kind, config={}, scope_override=None)

    resolved = [({"id": "sec_a"}, SimpleNamespace(key="ec2_utilization")), ({"id": "sec_c"}, SimpleNamespace(key="coverage_and_verification"))]
    specs = [spec("sec_a__title"), spec("sec_a__u_ag1", "agent_paragraph"), spec("sec_c__title"), spec("sec_c__verification")]
    placed = _with_agent_record({}, resolved, list(specs))
    assert [s.id for s in placed][-1] == "sec_c__agent_record"
    assert _with_agent_record({}, resolved, [s for s in specs if s.type != "agent_paragraph"]) == [s for s in specs if s.type != "agent_paragraph"]


# --- the builder's Try it, and the preview ---------------------------------------------


def _try(store, block_id: str, prose) -> dict[str, Any]:
    from reporting_agent.main import StepTracker
    from reporting_agent.report_pipeline import run_try_agent

    outcome: dict[str, Any] = {}

    async def go() -> None:
        async for _event in run_try_agent(
            payload={"definition": _definition(), "snapshot_run_id": "run-1", "block_id": block_id},
            context={"actor_id": "actor-1", "run_id": "try-1"}, steps=StepTracker(),
            artifact_bucket="unused", outcome=outcome, object_store=store, prose=prose,
        ):
            pass

    asyncio.run(go())
    return outcome


def test_try_writes_the_one_paragraph_and_says_what_became_of_it(walk) -> None:
    store, _, _ = walk
    before = set(store.keys())
    prose = FakeProse()
    agent = _try(store, "sec_ec2_utilization__u_ag1", prose)["agent"]
    assert agent["outcome"] == "written" and agent["reason"] == "written"
    assert agent["text"].startswith("The busiest instance peaked at")
    assert agent["figures"] > 0
    assert list(prose.requests) == ["sec_ec2_utilization__u_ag1"]  # nothing else asked
    assert set(store.keys()) == before  # and nothing written

    refused = _try(store, "sec_ec2_utilization__u_ag2", FakeProse())["agent"]
    assert (refused["outcome"], refused["reason"], refused["text"]) == ("note", "unprovable_figures", "")


def test_try_without_a_model_says_so() -> None:
    from reporting_agent.report_pipeline import _AgentOnlyProse

    narrator = _AgentOnlyProse(None)
    assert narrator.reason_for("x") == "no_model"


def test_try_names_a_paragraph_the_draft_does_not_have(walk) -> None:
    from reporting_agent.errors import RenderFailedError

    store, _, _ = walk
    with pytest.raises(RenderFailedError):
        _try(store, "sec_ec2_utilization__u_none", FakeProse())


def test_a_preview_writes_its_agent_paragraphs_and_no_other_narration(walk) -> None:
    from reporting_agent.main import StepTracker
    from reporting_agent.report_pipeline import run_render_preview

    store, _, _ = walk
    prose = FakeProse()

    async def go() -> None:
        async for _event in run_render_preview(
            payload={"definition": _definition(), "snapshot_run_id": "run-1", "preview_id": "pv-agent"},
            context={"actor_id": "actor-1", "run_id": "pv-agent"}, steps=StepTracker(),
            artifact_bucket="unused", object_store=store, prose=prose,
        ):
            pass

    asyncio.run(go())
    assert prose.requests and all(request.kind == PROSE_KIND_AGENT for request in prose.requests.values())
    assert any(key.endswith("/previews/pv-agent/preview.pdf") for key in store.keys())


def test_try_agent_through_main_invoke(walk, monkeypatch: pytest.MonkeyPatch) -> None:
    """The command end to end, through the entrypoint: routed, one step, and the paragraph
    on `done` — the shape the app's Try it route reads."""
    from reporting_agent import main
    from reporting_agent.events import TERMINAL_EVENT_TYPE

    store, _, _ = walk
    monkeypatch.setattr("reporting_agent.report_pipeline._s3_store", lambda bucket, region: store)
    monkeypatch.setattr("reporting_agent.report_pipeline._prose_provider", lambda model_id, region: FakeProse())
    payload = {
        "command": "try_agent",
        "definition": _definition(),
        "snapshot_run_id": "run-1",
        "block_id": "sec_ec2_utilization__u_ag1",
        "context": {"actor_id": "actor-1", "run_id": "try-1"},
    }

    async def drain() -> list[Event]:
        return [event async for event in main.invoke(payload)]

    events = asyncio.run(asyncio.wait_for(drain(), timeout=600))
    done = events[-1]
    assert done["type"] == TERMINAL_EVENT_TYPE and done["status"] == "completed"
    assert done["agent"]["outcome"] == "written"
    assert done["agent"]["text"].startswith("The busiest instance peaked at")
    assert not [event for event in events if event["type"] in ("report_file", "verification")]
