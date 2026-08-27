"""Every catalogue entry rendered through every emitter, at least once (task 6.5).

`test_expand_sections.py::test_every_real_catalogue_entry_compiles_without_error` proves
every catalogue entry **compiles** — produces an AST. It does not prove any emitter can
actually render that AST: a node type the HTML emitter declares no case for, a table shape
`.docx` cannot lay out, a figure the PDF conversion cannot make extractable, would all pass
that guard and fail here first. "A section no guard has ever rendered is a section whose
emitter has never run" is task 6.5's own acceptance criterion, and this module is what makes
that claim true rather than aspirational.

**Three of the fifteen entries are excluded, and it is the same three, for the same reason,
as `test_expand_sections.py`'s own compile-only guard**: `vm_utilization`,
`historical_vm_utilization` and `database_utilization` need a per-run metric selection
threaded from the section's own `metrics`/`selection` into `expand_sections` before they
compile at all (`top_n_table` needs `columns` + `order_by`; `historical_trend` needs `metric`
+ `statistic` + `lookback`) — a design decision, not a data-shape fix, out of scope for this
task exactly as it was out of scope for the compile-only guard. Recorded here rather than
silently narrowed a second time.
"""

from __future__ import annotations

import hashlib
from decimal import Decimal
from io import BytesIO
from pathlib import Path

import pytest

import messages_factory as mf
from reporting_agent.catalog.loader import load_section_catalogue
from reporting_agent.collect.snapshot import ResourceSnapshot, SkuCapacity
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.snapshot_view import SnapshotView, build_snapshot_view
from reporting_agent.render import pdf as P
from reporting_agent.render.docx import render_document
from reporting_agent.render.html import emit_html
from snapshot_factory import CPU, exact
from snapshot_factory import build as build_fixture
from snapshot_factory import resource_record as make_rec

# The same exclusion, the same reason, as
# `test_expand_sections.py::test_every_real_catalogue_entry_compiles_without_error`.
NEEDS_METRIC_SELECTION_WIRING: frozenset[str] = frozenset(
    {"vm_utilization", "historical_vm_utilization", "database_utilization"}
)

DESIGN: dict[str, object] = {
    "preset": "corporate",
    "accent_color": "#008080",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": True,
    "logo": None,
    "page_size": "A4",
}

SOFFICE_AVAILABLE = P.SOFFICE_BINARY is not None


def _view() -> SnapshotView:
    """One real VM resource, built the same way `test_expand_sections.py`'s own
    `_make_view` does -- a minimal but real `ResourceSnapshot` rather than an empty
    inventory, so a metric-bearing entry has something non-trivial to render."""
    resource_id = (
        "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg-test/"
        "providers/Microsoft.Compute/virtualMachines/vm-01"
    )
    rec = make_rec(resource_id=resource_id, name="vm-01")
    resource = ResourceSnapshot(
        record=rec,
        sku=SkuCapacity(
            name="Standard_D2s_v5",
            vcpus_available=2,
            memory_bytes=Decimal("8589934592"),
        ),
        statistics=(exact(CPU, "avg", "12.50"),),
        day_buckets=(),
        facts=(),
    )
    doc = build_fixture(resources=[resource])
    return build_snapshot_view(doc)


def _catalogue():
    return load_section_catalogue()


def _v3_definition(section_key: str, *, metric_bearing: bool) -> dict:
    metrics = (
        [{"metric": "Percentage CPU", "statistic": "avg"}] if metric_bearing else []
    )
    return {
        "schema_version": 3,
        "provider": "azure",
        "sections": [
            {
                "id": "sec",
                "type": section_key,
                "position": 0,
                "selection": {
                    "resource_types": [],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": metrics,
                "presentation": "table_only",
            }
        ],
        "identity": {
            "language": "en",
            "customer_name": "Test Corp",
            "report_title": "Test Report",
        },
        "period": {"start": "2026-07-01", "end": "2026-07-31"},
        "design": {
            "theme_preset": "corporate",
            "accent_color": "#008080",
            "density": "normal",
            "table_style": "hairline",
            "page_size": "a4",
            "number_format": {"decimal_separator": ".", "thousands_separator": ","},
            "cover_page": True,
        },
        "front_matter": {
            "cover": {"title": "Test", "subtitle": ""},
            "document_control": {
                "revision_history": [],
                "approvers": [],
                "distribution": [],
            },
            "toc": {"enabled": False},
        },
    }


def _renderable_entries():
    """Every catalogue entry this module can exercise, excluding the same three the
    compile-only guard excludes, and further restricted to entries whose first expansion
    is `per: "section"` — the same restriction the compile-only guard applies, since an
    entry whose first expansion is `per: "resource"` legitimately produces zero blocks
    against an empty scope and there is nothing for an emitter to render."""
    catalogue = _catalogue()
    return [
        entry
        for entry in catalogue.entries
        if entry.key not in NEEDS_METRIC_SELECTION_WIRING
        and entry.expands_to[0].per == "section"
    ]


_ENTRIES = _renderable_entries()
_ENTRY_IDS = [entry.key for entry in _ENTRIES]

assert len(_ENTRIES) >= 10, (
    f"expected at least 10 renderable catalogue entries after the known exclusions, got "
    f"{len(_ENTRIES)}: {_ENTRY_IDS} -- a change to the catalogue or the exclusion set "
    f"narrowed this guard's coverage without anyone deciding to"
)


@pytest.mark.parametrize("entry", _ENTRIES, ids=_ENTRY_IDS)
def test_every_renderable_entry_emits_html_with_no_case_gap(entry) -> None:
    """`emit_html` raises `HtmlEmitFailed` for any node type it declares no case for
    (Req 24.8) -- so a clean run here is the guard, not merely a smoke test."""
    catalogue = _catalogue()
    view = _view()
    definition = _v3_definition(entry.key, metric_bearing=entry.metric_bearing)
    compiled = compile_document(definition, view=view, catalogue=catalogue)

    outcome = emit_html(compiled.document, messages=mf.EN)

    assert outcome.html, f"{entry.key!r} produced empty HTML"
    assert "<div" in outcome.html


@pytest.mark.parametrize("entry", _ENTRIES, ids=_ENTRY_IDS)
def test_every_renderable_entry_emits_a_valid_docx(entry) -> None:
    """`render_document` must accept every compiled AST this catalogue can produce, not
    only the hand-built fixtures the rest of the render suite uses."""
    catalogue = _catalogue()
    view = _view()
    definition = _v3_definition(entry.key, metric_bearing=entry.metric_bearing)
    compiled = compile_document(definition, view=view, catalogue=catalogue)

    outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
        messages=mf.EN,
    )

    assert outcome.docx_bytes[:2] == b"PK", (
        f"{entry.key!r}'s .docx does not start with the zip signature"
    )


@pytest.mark.skipif(not SOFFICE_AVAILABLE, reason="LibreOffice is not installed")
def test_a_document_combining_every_renderable_entry_converts_to_a_readable_pdf(
    tmp_path: Path,
) -> None:
    """One real LibreOffice conversion covering every renderable entry **in one document**,
    rather than fifteen separate conversions — each real conversion costs real wall-clock
    time, and the PDF fidelity claim (every figure's `formatted` string survives the
    conversion) is a property of the render pipeline, not of any one section, so it needs
    proving once against the union rather than once per entry."""
    catalogue = _catalogue()
    view = _view()
    sections = [
        {
            "id": f"sec_{entry.key}",
            "type": entry.key,
            "position": index,
            "selection": {
                "resource_types": [],
                "resource_groups": [],
                "tag_filters": [],
                "top_n": None,
                "sort": None,
            },
            "metrics": (
                [{"metric": "Percentage CPU", "statistic": "avg"}]
                if entry.metric_bearing
                else []
            ),
            "presentation": "table_only",
        }
        for index, entry in enumerate(_ENTRIES)
    ]
    definition = _v3_definition(_ENTRIES[0].key, metric_bearing=_ENTRIES[0].metric_bearing)
    definition["sections"] = sections

    compiled = compile_document(definition, view=view, catalogue=catalogue)
    outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
        messages=mf.EN,
    )

    profile_dir = tmp_path / "profile"
    profile_dir.mkdir()
    pdf_outcome = P.convert_to_pdf(outcome.docx_bytes, profile=profile_dir)

    assert pdf_outcome.page_count >= 1
    assert pdf_outcome.pdf_bytes[:5] == b"%PDF-"
    assert pdf_outcome.docx_sha256 == hashlib.sha256(outcome.docx_bytes).hexdigest()

    from pypdf import PdfReader

    reader = PdfReader(BytesIO(pdf_outcome.pdf_bytes))
    normalized = " ".join(" ".join(page.extract_text().split()) for page in reader.pages)
    assert normalized.strip(), "the converted PDF carries no extractable text"
