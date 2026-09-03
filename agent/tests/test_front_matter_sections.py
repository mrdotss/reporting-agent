"""The front matter's neutral description, and the two emitters over it.

`emit_front_matter` wrote straight into a `DocxDocument`, so the cover, the document
control page and the contents existed only as Word calls. `render/html.py` walks the block
AST, and the front matter is not in the AST — it is fixed rather than composed and accepts
no block — so a real run's `document.html` began at the first section heading with no
cover, no approvers and no contents at all.

`front_matter_sections` is now the single statement of what the front matter contains and
in what order. This file holds the part that matters most: that **both** emitters handle
every section kind, so a kind added for one cannot silently go missing from the other.
"""

from __future__ import annotations

import typing

import pytest
from docx import Document as _new_document

from reporting_agent.compile.messages import load_messages
from reporting_agent.render.front_matter import (
    ApproverEntry,
    CoverConfig,
    DistributionRow,
    DocumentControlConfig,
    FrontMatterConfig,
    FrontMatterContents,
    FrontMatterGrid,
    FrontMatterHeading,
    FrontMatterNote,
    FrontMatterPageBreak,
    FrontMatterPairs,
    FrontMatterSection,
    RevisionHistoryRow,
    RunFacts,
    front_matter_sections,
)
from reporting_agent.render.html import emit_front_matter_html
from reporting_agent.render.themes import load_theme

_MESSAGES = load_messages("en")

SECTION_KINDS: tuple[type, ...] = typing.get_args(FrontMatterSection)


def _run(**kw) -> RunFacts:
    base = dict(
        run_id="run-001", template_id="tmpl-abc", customer_name="Acme Corp",
        period_display="July 2026", report_title="Infrastructure Report",
        period_start_year="2026", period_start_month="07",
    )
    base.update(kw)
    return RunFacts(**base)


FULL = FrontMatterConfig(
    cover=CoverConfig(
        enabled=True,
        subtitle="Monthly",
        contact_block="ops@acme.example",
        # A configured logo, so the cover produces its reserved block and both emitters
        # are exercised on it. Without one the kind is declared and nothing makes it,
        # which is exactly what the guard below refuses.
        logo="brand/helios.png",
    ),
    document_control=DocumentControlConfig(
        document_name="Monthly Infrastructure Report",
        document_number_pattern="FRM.SOP.019-{year}-{month}",
        confidentiality_notice_id="doc.front_matter.confidentiality",
        distribution_rows=(DistributionRow(recipient="Platform team", company="Acme"),),
        approvers=(ApproverEntry(role="author", name="R. Prakoso", company="Helios"),),
    ),
)


def _full_sections() -> tuple[FrontMatterSection, ...]:
    return front_matter_sections(
        front_matter=FULL,
        run=_run(revision_history=RevisionHistoryRow(revision="11", author="R. Prakoso")),
        messages=_MESSAGES,
        heading_entries=(("Azure Subscription Overview", 1), ("Resource Groups", 1)),
    )


class TestBothEmittersCoverEveryKind:
    """The guard. A section kind that only one emitter knows is a piece of the delivered
    document present in the `.docx` and missing from the styled PDF, or the reverse — and
    neither emitter would fail, because each only sees what it was given."""

    def test_the_full_front_matter_exercises_every_declared_kind(self) -> None:
        """If this fails, a kind was added to the union and nothing produces it — so the
        two assertions below would pass while testing nothing about it."""
        produced = {type(section) for section in _full_sections()}
        assert produced == set(SECTION_KINDS), (
            f"kinds never produced by `front_matter_sections`: "
            f"{sorted(k.__name__ for k in set(SECTION_KINDS) - produced)}"
        )

    def test_the_docx_emitter_renders_every_kind(self) -> None:
        from reporting_agent.render.front_matter import _emit_section

        for section in _full_sections():
            document = load_theme("editorial")
            _emit_section(document, section)  # must not raise

    def test_the_html_emitter_renders_every_kind(self) -> None:
        for section in _full_sections():
            markup = emit_front_matter_html([section])
            assert markup.startswith('<div class="rpt-front-matter">')

    def test_an_undeclared_kind_is_refused_by_both(self) -> None:
        """Req 24.8's no-partial-rendering, and the docx side's equivalent: an unhandled
        section raises rather than being skipped, because a silently dropped cover is
        worse than a failed render."""
        from reporting_agent.render.front_matter import _emit_section
        from reporting_agent.errors import RenderFailedError
        from reporting_agent.render.html import HtmlEmitFailed

        class Unknown:
            pass

        with pytest.raises(RenderFailedError):
            _emit_section(load_theme("editorial"), Unknown())  # type: ignore[arg-type]
        with pytest.raises(HtmlEmitFailed):
            emit_front_matter_html([Unknown()])


class TestTheDescriptionIsTheOrder:
    def test_cover_precedes_document_control_precedes_contents(self) -> None:
        kinds = [type(s).__name__ for s in _full_sections()]
        # The logo's reserved block opens the cover, above the eyebrow, as
        # `ReportA.dc.html` opens its own — so it is first wherever a logo is configured.
        assert kinds[0] == "FrontMatterLogo"
        assert kinds[1] == "FrontMatterHeading"
        assert kinds.index("FrontMatterContents") == len(kinds) - 2

    def test_disabling_the_cover_keeps_the_rest(self) -> None:
        """Req 13.9 — disabling the cover does not disable the front matter."""
        without = front_matter_sections(
            front_matter=FrontMatterConfig(
                cover=CoverConfig(enabled=False),
                document_control=FULL.document_control,
            ),
            run=_run(),
            messages=_MESSAGES,
        )
        texts = [s.text for s in without if isinstance(s, FrontMatterHeading)]
        assert "Infrastructure Report" not in texts
        assert _MESSAGES.text("doc.front_matter.document_control") in texts

    def test_the_signature_column_is_empty_in_both_emitters(self) -> None:
        """Req 13.6 clause (b) — an empty ruled box, never the approver's typed name."""
        grid = next(s for s in _full_sections() if isinstance(s, FrontMatterGrid)
                    and s.signature_column is not None)
        for row in grid.rows:
            assert row[grid.signature_column] == ""

        markup = emit_front_matter_html([grid])
        assert '<td class="rpt-signature"></td>' in markup
        assert "R. Prakoso" in markup  # the name is in its own column, not the box

    def test_the_contents_carry_no_page_number(self) -> None:
        """Req 24.4 — the HTML emitter determines no pagination, so it promises none.

        It emits a **reference** and not a number: an `href` to the heading's own id, which
        `printcss.py` resolves with `target-counter(attr(href), page)` at pagination time.
        WeasyPrint knows where the anchor landed and this module does not, which is the
        whole distinction. A browser with no paged media renders the entry with no number
        at all, which is what the in-app preview has always shown.

        Asserted as the absence of a resolved page number rather than the absence of every
        digit — the earlier form of this test — because the entry now legitimately carries
        a **section** number, which is derived from the heading sequence and says nothing
        about pages.
        """
        contents = next(s for s in _full_sections() if isinstance(s, FrontMatterContents))
        markup = emit_front_matter_html([contents])

        assert "Azure Subscription Overview" in markup
        # The reference, not a number.
        assert 'href="#rpt-heading-1"' in markup
        # Nothing that resolves pagination: no page counter, no total, no "page N of M".
        for forbidden in ("data-page", "page-number", " of ", "counter(page"):
            assert forbidden not in markup

    def test_the_contents_number_their_sections(self) -> None:
        """Two level-1 headings number 1 and 2, and each links to its own heading."""
        contents = next(s for s in _full_sections() if isinstance(s, FrontMatterContents))

        assert [(e.number, e.anchor) for e in contents.entries] == [
            ("1", "rpt-heading-1"),
            ("2", "rpt-heading-2"),
        ]

    def test_an_entrys_anchor_is_the_id_the_body_gives_that_heading(self) -> None:
        """The join. The contents counts headings and so does the body emitter, and if the
        two ever disagreed every link after the disagreement would point one heading off.
        """
        from reporting_agent.compile.ast import Document, Paragraph, Text
        from reporting_agent.render.html import emit_html

        document = Document(blocks=(
            Paragraph(path="b1:0", style="Heading 1",
                      inlines=(Text(path="b1:0", text="Azure Subscription Overview"),)),
            Paragraph(path="b2:0", style="Heading 1",
                      inlines=(Text(path="b2:0", text="Resource Groups"),)),
        ))
        body = emit_html(document, messages=_MESSAGES).html

        contents = next(s for s in _full_sections() if isinstance(s, FrontMatterContents))
        for entry in contents.entries:
            assert f'id="{entry.anchor}"' in body
