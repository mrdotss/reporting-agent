"""Runtime and source-scan guards for the HTML emitter's declared class names.

Part 1 — Runtime check: emit a fixture document exercising every node type, parse every
``class`` attribute out of the produced markup, and assert the set of ``rpt-``-prefixed
class names is a **subset** of ``EMITTED_CLASS_NAMES``. A runtime check cannot be fooled
by an interpolated class name.

Part 2 — Source scan: assert no ``class="rpt-`` literal appears in the module source
outside the declaration block (between the sentinel comments).

Requirements: 22.1, 22.2, 22.3, 22.5
"""

from __future__ import annotations

import re
from dataclasses import replace as dc_replace
from pathlib import Path
from typing import Final

import definition_factory as df
import messages_factory as mf
import snapshot_factory as sf
from reporting_agent.compile.ast import Chart, Document, FigurePath, Series
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render.html import EMITTED_CLASS_NAMES, emit_html, emit_toc_html

# ---------------------------------------------------------------------------
# Common fixtures: a design + a definition that exercises every node type
# ---------------------------------------------------------------------------

DESIGN: Final[dict[str, object]] = {
    "preset": "editorial",
    "accent_color": "#1f6f78",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": True,
    "logo": None,
    "page_size": "A4",
}

# A definition with every block type so the emitter exercises all paths.
_ALL_BLOCKS = [
    df.block("cover", "cover", {"subtitle": "Test"}),
    df.block("h", "heading", {"text": "Title", "level": 1}),
    df.block("p", "rich_text", {"text": "Body paragraph."}),
    df.block("t", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX], "caption": "Table"}),
    # A fact column, so the fixture produces a `TextFactCell` and therefore `rpt-fact`.
    # Without one the equality guard below cannot tell "the emitter stopped writing that
    # class" from "the fixture never asked for it" — and `rpt-fact` is what exempts a
    # text fact from the figure's `nowrap`, which is the whole reason it exists.
    df.block(
        "tf",
        "resource_table",
        {"columns": [{"kind": "fact", "fact_key": "os_type"}], "caption": "Facts"},
    ),
    df.block("k", "kpi_row", {"metrics": [df.CPU_AVG]}),
    df.block("g", "gaps_and_coverage", {}),
    df.block("c", "timeseries_chart", {"metrics": [df.CPU_AVG]}),
    df.block("pb", "page_break", {}),
    {"id": "r", "type": "row", "columns": [
        [df.block("rc", "rich_text", {"text": "Column content."})],
        [df.block("rc2", "rich_text", {"text": "Second column."})],
    ]},
]

# A definition that produces headings at levels 1-3 so emit_toc_html exercises
# the table of contents path (ADOPTED_APPROACH is two_pass_measure → TOC emitted).
_TOC_BLOCKS = [
    df.block("h1", "heading", {"text": "Introduction", "level": 1}),
    df.block("h2", "heading", {"text": "Overview", "level": 2}),
    df.block("h3", "heading", {"text": "Details", "level": 3}),
    df.block("p", "rich_text", {"text": "Body paragraph."}),
    df.block("t", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX], "caption": "Table"}),
]



def _snapshot_with_a_fact() -> dict:
    """`two_vm_snapshot` with an `os_type` fact on every resource.

    The default fixture carries statistics and no facts, so nothing in it produces a
    `TextFactCell` — and the equality guard below cannot distinguish "the emitter stopped
    writing `rpt-fact`" from "the fixture never asked for one". A class that exists to
    exempt text facts from a figure's `nowrap` has to be exercised by a text fact.
    """
    from reporting_agent.collect.snapshot import FactEntry, ResourceSnapshot
    from dataclasses import replace as dc_replace

    snapshot = sf.two_vm_snapshot()
    os_type = FactEntry(
        key="os_type",
        value="Linux",
        value_kind="text",
        source="resource_graph",
        collected_at="2026-08-31T00:00:00Z",
        formatted="Linux",
    )
    snapshot["resources"] = [
        {**resource, "facts": [*(resource.get("facts") or []), _as_plain(os_type)]}
        for resource in snapshot["resources"]
    ]
    return snapshot


def _as_plain(fact) -> dict:
    """A `FactEntry` as the plain mapping a snapshot document carries."""
    return {
        "key": fact.key,
        "value": fact.value,
        "value_kind": fact.value_kind,
        "source": fact.source,
        "collected_at": fact.collected_at,
        "formatted": fact.formatted,
    }


def _emit_all():
    """Compile and emit a document exercising every node type.

    The compiled chart carries no ``period_label`` (that requires historical runs),
    so we inject one post-compilation via ``dataclasses.replace`` — the same pattern
    task 8.2's own test uses. Without this, the fixture never produces
    ``rpt-chart-period`` and the subset check cannot notice its absence.

    We also inject a second Chart with empty series to exercise ``rpt-notice`` (the
    empty-scope indication inside a chart with no data).
    """
    view = build_snapshot_view(_snapshot_with_a_fact())
    compiled = compile_document(
        df.definition(_ALL_BLOCKS, design=DESIGN), view=view
    )
    # Inject a period_label into the first Chart node so rpt-chart-period is emitted.
    # Also inject an empty-series Chart to exercise the rpt-notice class (indication).
    patched_blocks: list[object] = []
    injected_empty_chart = False
    for block in compiled.document.blocks:
        if isinstance(block, Chart) and not block.period_label:
            block = dc_replace(block, period_label="Jul 2026 – Aug 2026 (UTC+7)")
            patched_blocks.append(block)
            if not injected_empty_chart:
                # A chart with empty series triggers the rpt-notice indication.
                empty_chart = Chart(
                    path=FigurePath("fixture:empty_chart"),
                    chart_type="bar",
                    title="Empty fixture",
                    unit="%",
                    encoding="categorical",
                    series=(Series(
                        path=FigurePath("fixture:empty_chart.series.0"),
                        key="empty",
                        label="Empty",
                        points=(),
                    ),),
                )
                patched_blocks.append(empty_chart)
                injected_empty_chart = True
        else:
            patched_blocks.append(block)
    patched_doc = Document(blocks=tuple(patched_blocks))
    outcome = emit_html(patched_doc, messages=mf.EN)
    return outcome


def _emit_toc():
    """Compile a document with headings and emit its table of contents."""
    view = build_snapshot_view(sf.two_vm_snapshot())
    compiled = compile_document(
        df.definition(_TOC_BLOCKS, design=DESIGN), view=view
    )
    toc_html = emit_toc_html(compiled.document)
    return toc_html


# ---------------------------------------------------------------------------
# Part 1 — Runtime subset check
# ---------------------------------------------------------------------------

_CLASS_ATTR_RE = re.compile(r'class="([^"]*)"')


def _extract_rpt_classes(markup: str) -> set[str]:
    """Extract all rpt-prefixed class names from HTML markup."""
    classes: set[str] = set()
    for match in _CLASS_ATTR_RE.finditer(markup):
        for cls in match.group(1).split():
            if cls.startswith("rpt-"):
                classes.add(cls)
    return classes


def test_emitted_classes_are_subset_of_declaration() -> None:
    """Every rpt-prefixed class in the produced markup is declared in EMITTED_CLASS_NAMES."""
    outcome = _emit_all()
    emitted_classes = _extract_rpt_classes(outcome.html)

    # Sanity: we must have found some classes (at least document, block, table, row, figure)
    assert len(emitted_classes) >= 5, (
        f"Expected at least 5 distinct rpt- classes in the output, got {len(emitted_classes)}: "
        f"{sorted(emitted_classes)}"
    )

    declared = set(EMITTED_CLASS_NAMES)
    undeclared = emitted_classes - declared
    assert not undeclared, (
        f"Undeclared rpt- class names found in HTML output: {sorted(undeclared)}. "
        f"Every emitted class must be a member of EMITTED_CLASS_NAMES."
    )


def test_toc_classes_are_subset_of_declaration() -> None:
    """Every rpt-prefixed class emitted by emit_toc_html is declared in EMITTED_CLASS_NAMES."""
    toc_markup = _emit_toc()

    # The TOC must be non-empty: ADOPTED_APPROACH is two_pass_measure and we have headings.
    assert toc_markup, (
        "emit_toc_html returned an empty string — the fixture has headings and "
        "ADOPTED_APPROACH is two_pass_measure, so a TOC must be emitted."
    )

    toc_classes = _extract_rpt_classes(toc_markup)

    # Sanity: we must find the three TOC classes.
    assert len(toc_classes) >= 3, (
        f"Expected at least 3 distinct rpt- classes in the TOC output, got "
        f"{len(toc_classes)}: {sorted(toc_classes)}"
    )

    declared = set(EMITTED_CLASS_NAMES)
    undeclared = toc_classes - declared
    assert not undeclared, (
        f"Undeclared rpt- class names found in TOC output: {sorted(undeclared)}. "
        f"Every emitted class must be a member of EMITTED_CLASS_NAMES."
    )


def test_emitted_class_names_has_exactly_twenty_one_entries() -> None:
    """The declaration carries exactly twenty-one names.

    Grew to eighteen with `rpt-fact`, which a text fact wears **alongside** `rpt-figure`.
    Grew to twenty-one with the contents entry's three: the link that gives the print
    stylesheet a `target-counter` reference for a page number, and the number and text
    spans that let the section number sit in its own column rather than run into the
    heading.
    The shared class keeps the app's provenance reveal one interaction over both; the
    second one is what lets `printcss.py` exempt a fact from the `white-space: nowrap`
    that exists for figures, and from the right-alignment that exists for numerals. An
    ARM resource id under `nowrap` is one unbreakable 130-character token, and it ran off
    the right edge of the Public IP table.
    """
    assert len(EMITTED_CLASS_NAMES) == 21, (
        f"Expected 21 entries, got {len(EMITTED_CLASS_NAMES)}: {EMITTED_CLASS_NAMES}"
    )


def test_point_separator_is_middle_dot() -> None:
    """Consecutive rpt-point elements within a series are joined by ' · ' (U+00B7)."""
    outcome = _emit_all()

    # The middle dot separator must be present between point spans
    assert " \u00b7 " in outcome.html, (
        "Expected middle dot separator between consecutive rpt-point elements"
    )


def test_every_declared_class_appears_in_fixture_output() -> None:
    """Every name in EMITTED_CLASS_NAMES is exercised by the fixtures.

    This is the EQUALITY direction the subset check cannot provide: dropping an
    emission silently passes a subset assertion, but fails here because the fixture
    no longer produces it. The two fixtures together (document + TOC) cover all
    twenty-one names.
    """
    outcome = _emit_all()
    toc_markup = _emit_toc()
    produced = _extract_rpt_classes(outcome.html) | _extract_rpt_classes(toc_markup)

    declared = set(EMITTED_CLASS_NAMES)
    missing = declared - produced
    assert not missing, (
        f"Declared class names NOT produced by the fixtures: {sorted(missing)}. "
        f"Either the fixture is incomplete (add a node that produces the class) or "
        f"the name was removed from the emitter without removing it from the declaration."
    )


# ---------------------------------------------------------------------------
# Part 2 — Source scan: no class="rpt- literal outside the declaration
# ---------------------------------------------------------------------------

_HTML_PY_PATH = Path(__file__).resolve().parent.parent / "src" / "reporting_agent" / "render" / "html.py"

# The sentinel comments delimiting the declaration block
_SENTINEL_BEGIN = "# --- BEGIN EMITTED_CLASS_NAMES ---"
_SENTINEL_END = "# --- END EMITTED_CLASS_NAMES ---"

_CLASS_RPT_LITERAL_RE = re.compile(r'''(?:f['"]|['"]).*class="rpt-''')


def test_no_rpt_class_literal_outside_declaration() -> None:
    """No class="rpt- string literal appears in html.py outside the declaration block."""
    source = _HTML_PY_PATH.read_text(encoding="utf-8")

    # Find the declaration block
    begin_idx = source.index(_SENTINEL_BEGIN)
    end_idx = source.index(_SENTINEL_END) + len(_SENTINEL_END)

    # Check the code OUTSIDE the declaration block
    before = source[:begin_idx]
    after = source[end_idx:]
    outside = before + after

    violations: list[tuple[int, str]] = []
    for line_no, line in enumerate(outside.split("\n"), start=1):
        stripped = line.strip()
        # Skip comments and docstrings
        if stripped.startswith("#") or stripped.startswith('"""') or stripped.startswith("'''"):
            continue
        # Check for actual class="rpt- in f-strings or string literals that are code
        if re.search(r'class="rpt-', stripped) and not stripped.startswith(("#", "'")):
            # Verify it's in an actual string expression, not a comment
            if 'class="rpt-' in stripped and not stripped.lstrip().startswith("#"):
                # Additional filter: must be inside a string that is code, not a docstring line
                if stripped.startswith(("f'", 'f"', "'", '"')) or "f'" in stripped or 'f"' in stripped:
                    violations.append((line_no, stripped))

    assert not violations, (
        f"Found {len(violations)} class=\"rpt- literal(s) outside the declaration block:\n"
        + "\n".join(f"  line ~{ln}: {line}" for ln, line in violations)
    )
