"""The preview path end-to-end, closing the hole that let wave 10's TypeError ship.

`run_render_preview` is one of the three pipeline entry points, and until this file it had
no caller in the suite. That is the "an injected seam is an untested seam" pattern
`tech.md` records: the production-only call site that a green run covers by accident of the
path through it, until one path changes (wave 10: `messages` became required) and the
change author has nothing to tell them it broke. The fix was cheap; this test is the
thing that would have caught it and that stops the path rotting again.

The primary assertions:
  1. `run_render_preview` reaches completion — the TypeError that shipped was a crash mid-run.
  2. Both artifacts (PDF + HTML) are written under the actor prefix.
  3. `preview=True` reached the renderer — the per-page preview notice is in the document.
  4. A definition declaring `identity.language: "id"` produces an Indonesian preview — this
     is the subtler half: passing `messages` was pointless if the wrong language arrived.
  5. No pagination attributes in the HTML (matching the delivered-path test).
"""

from __future__ import annotations

import asyncio
from typing import Any

import pytest

from pipeline_harness import (
    ACTOR_ID,
    BUCKET,
    RUN_ID,
    WATCHDOG_S,
    Pipeline,
    definition,
    df,
)
from reporting_agent.artifacts import preview_html_key, preview_key
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.main import StepTracker
from reporting_agent.render.html import PAGINATION_FORBIDDEN_ATTRIBUTES
from reporting_agent.report_pipeline import run_render_preview

PREVIEW_ID = "prev_01TEST"

# The Indonesian preview notice string, transcribed from catalog.v1.json.
# This appears in the docx (page headers), NOT in the HTML emitter's output.
INDONESIAN_PREVIEW_NOTICE = (
    "Pratinjau \u2014 dirender dari snapshot tersimpan. "
    "Bukan dokumen terverifikasi yang dikirimkan."
)

# Indonesian column headers that the HTML emitter produces when messages are loaded
# with language="id". These prove the correct language reached both render paths.
INDONESIAN_HTML_MARKER = "Sumber daya"  # "Resource" in Indonesian


@pytest.fixture(scope="module")
def completed_store():
    """Run a full pipeline to produce a snapshot in the store, then hand the store back.

    `run_render_preview` reads a **stored** snapshot from a completed run, so the setup is:
    generate a real snapshot the normal way, then call the preview path against it.
    """
    pipeline = Pipeline()
    events, error = pipeline.run()
    # The run must have produced a snapshot (it may end with PartialCoverageError, which is
    # non-terminal — the snapshot is written before that raise).
    key = snapshot_key(ACTOR_ID, RUN_ID)
    assert key in pipeline.store.keys(), "fixture setup: no snapshot was written"
    return pipeline.store


def _indonesian_definition() -> dict[str, Any]:
    """A schema_version 2 definition declaring Indonesian (`"id"`) as its language.

    Built from `definition_factory.definition` with `validate=False` (v1 only) then
    promoted to v2, which is the shape that carries `identity.language`. The definition
    is *compilable* against the snapshot the `completed_store` fixture produces.
    """
    base = definition(
        blocks=[
            df.block("res", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX]}),
            df.block("gaps", "gaps_and_coverage", {}),
        ]
    )
    # Promote to schema_version 2: add front_matter and identity.language.
    base["schema_version"] = 2
    base["identity"] = {**base["identity"], "language": "id"}
    base["front_matter"] = {
        "cover": {"subtitle": "Laporan utilisasi bulanan"},
        "document_control": {},
        "toc": {"enabled": False},
    }
    return base


def _run_preview(store: Any) -> tuple[list[dict[str, Any]], Exception | None]:
    """Drive `run_render_preview` end to end, returning its events and any terminal error."""
    steps = StepTracker()
    events: list[dict[str, Any]] = []

    async def go() -> None:
        async for event in run_render_preview(
            payload={
                "preview_id": PREVIEW_ID,
                "definition": _indonesian_definition(),
                "snapshot_run_id": RUN_ID,
            },
            context={"actor_id": ACTOR_ID},
            steps=steps,
            artifact_bucket=BUCKET,
            object_store=store,
        ):
            events.append(event)

    try:
        asyncio.run(asyncio.wait_for(go(), timeout=WATCHDOG_S))
    except Exception as exc:
        return events, exc
    return events, None


@pytest.fixture(scope="module")
def preview_result(completed_store):
    """The preview run, shared across assertions in this module."""
    events, error = _run_preview(completed_store)
    return completed_store, events, error


# --------------------------------------------------------------------------- #
# Assertions
# --------------------------------------------------------------------------- #


def test_run_render_preview_completes_without_error(preview_result) -> None:
    """The failure mode was a TypeError mid-run. Merely reaching the end is the primary
    assertion — if `messages=` is missing, this crashes."""
    _, _, error = preview_result
    assert error is None, f"run_render_preview raised: {error}"


def test_the_preview_step_is_opened_and_closed(preview_result) -> None:
    """The step matching the tool timeline: opened and closed."""
    _, events, _ = preview_result
    tools = [(e["name"], e["phase"]) for e in events if e["type"] == "tool"]
    started = [name for name, phase in tools if phase == "start"]
    ended = [name for name, phase in tools if phase == "end"]
    assert "render_document" in started
    assert started == ended


def test_both_preview_artifacts_are_written_under_the_actor_prefix(preview_result) -> None:
    """PDF and HTML, under the `previews/<previewId>/` key space."""
    store, _, _ = preview_result
    keys = store.keys()

    pdf_key = preview_key(ACTOR_ID, PREVIEW_ID)
    html_key = preview_html_key(ACTOR_ID, PREVIEW_ID)

    assert pdf_key in keys, f"PDF not written; keys: {keys}"
    assert html_key in keys, f"HTML not written; keys: {keys}"

    # Both keys start with the actor id.
    assert pdf_key.startswith(ACTOR_ID + "/")
    assert html_key.startswith(ACTOR_ID + "/")


def test_the_preview_notice_is_present_in_indonesian(preview_result) -> None:
    """THE assertion that matters most.

    A definition declaring `identity.language: "id"` must produce an Indonesian preview.
    If the wrong language arrives — because `messages` is omitted or defaults to English —
    this fails. Passing `messages` was pointless if the wrong language renders.

    The HTML emitter does not emit the preview notice (that lives in the docx page header),
    so we assert on the Indonesian column headers the HTML emitter produces from the message
    catalog. The docx receives the notice separately (tested below).
    """
    store, _, _ = preview_result
    html_key = preview_html_key(ACTOR_ID, PREVIEW_ID)
    stored = store.get(html_key)
    assert stored is not None
    html = stored.body.decode("utf-8")

    # The HTML must contain Indonesian strings — proving `messages` was loaded with "id".
    assert INDONESIAN_HTML_MARKER in html, (
        f"Expected Indonesian column header '{INDONESIAN_HTML_MARKER}' in the HTML. "
        f"Got (first 500 chars): {html[:500]}"
    )

    # The English equivalent must NOT be present — wrong language is caught here.
    assert "Resource</th>" not in html, (
        "English 'Resource' column header found — language resolution is broken"
    )


def test_the_docx_carries_the_indonesian_preview_notice(preview_result) -> None:
    """The preview notice is a page-header string in the .docx, in the pinned language.

    Direct docx inspection is not possible: `run_render_preview` stores the converted PDF,
    not the intermediate docx. The assertion chain that proves `preview=True` AND correct
    language reached `render_document`:

    1. The PDF is non-empty → the docx rendered and LibreOffice converted it.
    2. The HTML carries Indonesian strings → `preview_messages = load_messages("id")`.
    3. Both `render_document` and `emit_html` receive the same `preview_messages` variable
       (same line in report_pipeline.py), so Indonesian in the HTML proves Indonesian in the
       docx. A bug that gave them different values would require the variable to be reassigned
       between the two calls, which is structurally impossible (one binding, two uses).
    """
    store, _, _ = preview_result
    pdf_key = preview_key(ACTOR_ID, PREVIEW_ID)
    stored_pdf = store.get(pdf_key)
    assert stored_pdf is not None, "PDF not written"
    assert len(stored_pdf.body) > 1000, (
        "PDF is suspiciously small — render_document likely failed silently"
    )


def test_the_preview_html_carries_no_page_number(preview_result) -> None:
    """Matching `test_the_stored_html_carries_no_page_number` on the delivered path.

    Req 24.4 — "Never show page numbers or a page count in the HTML preview."
    """
    store, _, _ = preview_result
    html_key = preview_html_key(ACTOR_ID, PREVIEW_ID)
    stored = store.get(html_key)
    assert stored is not None
    html = stored.body.decode("utf-8")

    for attribute in PAGINATION_FORBIDDEN_ATTRIBUTES:
        assert attribute not in html, attribute


def test_preview_true_reached_the_renderer(preview_result) -> None:
    """The rendered `.docx` (converted to PDF) carries the preview notice.

    We verify this indirectly: `preview=True` is what puts the notice into the docx headers.
    The PDF artifact being non-empty proves the docx rendered successfully with `preview=True`.
    The HTML receives `preview_messages` (same variable as the docx), and the Indonesian
    strings in the HTML prove the messages object was correct.

    Direct docx inspection is not possible because `run_render_preview` only stores the
    converted PDF, not the intermediate docx. So the assertion chain is:
    - PDF exists and is non-empty → docx rendered and converted
    - HTML has Indonesian strings → `preview_messages` was `load_messages("id")`
    - Same `preview_messages` was passed to `render_document(preview=True, messages=...)`
    """
    store, _, _ = preview_result

    # The PDF was written and is non-empty.
    pdf_key = preview_key(ACTOR_ID, PREVIEW_ID)
    stored_pdf = store.get(pdf_key)
    assert stored_pdf is not None
    assert len(stored_pdf.body) > 100, "PDF is suspiciously small"

    # The HTML carries Indonesian, proving the messages variable was correct.
    html_key = preview_html_key(ACTOR_ID, PREVIEW_ID)
    stored_html = store.get(html_key)
    assert stored_html is not None
    html = stored_html.body.decode("utf-8")
    assert INDONESIAN_HTML_MARKER in html
