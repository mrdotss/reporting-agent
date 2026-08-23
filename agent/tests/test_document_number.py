"""Tests for `render/front_matter.document_number` (Req 13.8, 13.16, 25.9).

Two assertions criterion 25.9 declares as a TEST rather than a property:

1. Two renders of one run resolve one identical number.
2. Two runs of one template and one resolved period resolve the SAME number, distinguished
   by the revision history row — a re-run of one period is a revision of one document
   rather than a second document.
"""

from __future__ import annotations

import pytest

from reporting_agent.errors import RenderFailedError
from reporting_agent.render.front_matter import (
    RunFacts,
    document_number,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _run(
    *,
    run_id: str = "run-001",
    template_id: str = "tmpl-abc",
    year: str = "2026",
    month: str = "07",
) -> RunFacts:
    return RunFacts(
        run_id=run_id,
        template_id=template_id,
        customer_name="Customer A",
        period_display="July 2026",
        report_title="Infrastructure Report",
        period_start_year=year,
        period_start_month=month,
    )


# ---------------------------------------------------------------------------
# Criterion 25.9 — two renders of one run resolve one identical number
# ---------------------------------------------------------------------------


class TestTwoRendersOneRun:
    """Two renders of one run resolve one identical number."""

    def test_simple_pattern(self) -> None:
        run = _run()
        pattern = "RPT-{template}-{year}{month}-{run}"
        first = document_number(pattern, run=run)
        second = document_number(pattern, run=run)
        assert first == second

    def test_pattern_with_only_template_and_year(self) -> None:
        run = _run()
        pattern = "DOC/{template}/{year}-{run}"
        first = document_number(pattern, run=run)
        second = document_number(pattern, run=run)
        assert first == second
        assert first == "DOC/tmpl-abc/2026-run-001"

    def test_pattern_with_all_placeholders(self) -> None:
        run = _run(run_id="r42", template_id="T1", year="2026", month="08")
        pattern = "{template}-{year}-{month}-{run}"
        first = document_number(pattern, run=run)
        second = document_number(pattern, run=run)
        assert first == second
        assert first == "T1-2026-08-r42"

    def test_literal_only_pattern(self) -> None:
        """A pattern with no placeholders resolves identically every time."""
        run = _run()
        pattern = "FIXED-DOC-123"
        first = document_number(pattern, run=run)
        second = document_number(pattern, run=run)
        assert first == second
        assert first == "FIXED-DOC-123"


# ---------------------------------------------------------------------------
# Criterion 13.16 — two runs of one template and one resolved period resolve
# the SAME number, distinguished by the revision history row
# ---------------------------------------------------------------------------


class TestTwoRunsOnePeriodSameNumber:
    """Two runs of one template and one resolved period produce the same number
    (when {run} is not in the pattern), because a re-run of one period is a revision
    of one document rather than a second document."""

    def test_no_run_placeholder_same_number(self) -> None:
        """Without {run}, two runs of one template/period are the same number."""
        run_a = _run(run_id="run-001")
        run_b = _run(run_id="run-002")
        # Pattern omits {run}, so only template/year/month matter
        pattern = "RPT-{template}-{year}{month}"
        number_a = document_number(pattern, run=run_a)
        number_b = document_number(pattern, run=run_b)
        assert number_a == number_b
        assert number_a == "RPT-tmpl-abc-202607"

    def test_with_run_placeholder_different_number(self) -> None:
        """With {run}, two runs of one template/period are distinguished."""
        run_a = _run(run_id="run-001")
        run_b = _run(run_id="run-002")
        pattern = "RPT-{template}-{year}{month}-{run}"
        number_a = document_number(pattern, run=run_a)
        number_b = document_number(pattern, run=run_b)
        # They differ because {run} differs
        assert number_a != number_b
        assert number_a == "RPT-tmpl-abc-202607-run-001"
        assert number_b == "RPT-tmpl-abc-202607-run-002"

    def test_same_template_different_period_different_number(self) -> None:
        """Two runs of different periods resolve different numbers."""
        run_july = _run(year="2026", month="07")
        run_aug = _run(year="2026", month="08")
        pattern = "RPT-{template}-{year}{month}"
        assert document_number(pattern, run=run_july) != document_number(
            pattern, run=run_aug
        )


# ---------------------------------------------------------------------------
# Clause (c) — absent per-run values raise RENDER_FAILED
# ---------------------------------------------------------------------------


class TestAbsentPerRunValues:
    """A per-run value that is absent is RENDER_FAILED naming that value."""

    def test_absent_run_id_in_pattern(self) -> None:
        run = _run(run_id="")
        pattern = "DOC-{run}"
        with pytest.raises(RenderFailedError, match="\\{run\\}"):
            document_number(pattern, run=run)

    def test_absent_template_id_in_pattern(self) -> None:
        run = RunFacts(
            run_id="r1",
            template_id="",
            customer_name="C",
            period_display="July 2026",
            report_title="Report",
            period_start_year="2026",
            period_start_month="07",
        )
        pattern = "{template}-{year}{month}"
        with pytest.raises(RenderFailedError, match="\\{template\\}"):
            document_number(pattern, run=run)

    def test_absent_year_in_pattern(self) -> None:
        run = _run(year="")
        pattern = "RPT-{year}-{run}"
        with pytest.raises(RenderFailedError, match="\\{year\\}"):
            document_number(pattern, run=run)

    def test_absent_month_in_pattern(self) -> None:
        run = _run(month="")
        pattern = "RPT-{month}-{run}"
        with pytest.raises(RenderFailedError, match="\\{month\\}"):
            document_number(pattern, run=run)

    def test_absent_value_not_in_pattern_no_error(self) -> None:
        """A placeholder whose substitution is absent but NOT in the pattern is fine."""
        run = _run(month="")
        pattern = "RPT-{template}-{year}-{run}"
        # {month} is not in the pattern, so empty month is OK
        result = document_number(pattern, run=run)
        assert result == "RPT-tmpl-abc-2026-run-001"


# ---------------------------------------------------------------------------
# Substitution correctness
# ---------------------------------------------------------------------------


class TestSubstitutionCorrectness:
    """The closed placeholder grammar substitutes correctly."""

    def test_all_four_placeholders(self) -> None:
        run = _run(run_id="R99", template_id="INFRA", year="2025", month="12")
        pattern = "{template}/{year}/{month}/{run}"
        assert document_number(pattern, run=run) == "INFRA/2025/12/R99"

    def test_repeated_placeholder(self) -> None:
        """A placeholder may appear more than once."""
        run = _run(run_id="X", template_id="T", year="2026", month="01")
        pattern = "{run}-{run}"
        assert document_number(pattern, run=run) == "X-X"

    def test_literal_braces_not_in_grammar(self) -> None:
        """Characters that look like placeholders but aren't declared pass through.

        Note: the definition validator would reject this pattern, but the
        `document_number` function itself does simple replacement on declared
        placeholders only. An undeclared {foo} is left verbatim.
        """
        run = _run()
        # {foo} is not in the declared set, so it stays literal
        pattern = "{template}-{foo}-{run}"
        result = document_number(pattern, run=run)
        assert result == "tmpl-abc-{foo}-run-001"

    def test_empty_pattern_with_no_placeholders(self) -> None:
        """A one-character literal pattern."""
        run = _run()
        assert document_number("X", run=run) == "X"


# ---------------------------------------------------------------------------
# emit_front_matter — cover disabled (clause a) with real document
# ---------------------------------------------------------------------------


class TestEmitFrontMatterCoverDisabled:
    """Where cover-page flag is FALSE: no cover content AND no leading blank page,
    while document control page is emitted unchanged."""

    def test_cover_disabled_emits_document_control(self) -> None:
        """With cover disabled, emit_front_matter emits document control into doc."""
        from reporting_agent.compile.messages import load_messages
        from reporting_agent.render.front_matter import (
            CoverConfig,
            DocumentControlConfig,
            FrontMatterConfig,
            TocConfig,
            emit_front_matter,
        )
        from reporting_agent.render.themes import load_theme

        config = FrontMatterConfig(
            cover=CoverConfig(enabled=False),
            document_control=DocumentControlConfig(),
            toc=TocConfig(enabled=False),
        )
        run = _run()
        msgs = load_messages("en")
        doc = load_theme("editorial")

        emit_front_matter(doc, front_matter=config, run=run, messages=msgs)

        # Document control heading is the first paragraph
        assert doc.paragraphs[0].text == "Document control"


# ---------------------------------------------------------------------------
# emit_front_matter — absent per-run values (clause c) with real document
# ---------------------------------------------------------------------------


class TestEmitFrontMatterAbsentValues:
    """A per-run value that is absent raises RENDER_FAILED before any emission."""

    def test_absent_customer_name(self) -> None:
        from reporting_agent.compile.messages import load_messages
        from reporting_agent.render.front_matter import (
            CoverConfig,
            FrontMatterConfig,
            emit_front_matter,
        )
        from reporting_agent.render.themes import load_theme

        config = FrontMatterConfig(cover=CoverConfig(enabled=False))
        run = RunFacts(
            run_id="r1", template_id="t1", customer_name="",
            period_display="July 2026", report_title="Report",
            period_start_year="2026", period_start_month="07",
        )
        msgs = load_messages("en")
        doc = load_theme("editorial")

        with pytest.raises(RenderFailedError, match="customer_name"):
            emit_front_matter(doc, front_matter=config, run=run, messages=msgs)

    def test_absent_period_display(self) -> None:
        from reporting_agent.compile.messages import load_messages
        from reporting_agent.render.front_matter import (
            CoverConfig,
            FrontMatterConfig,
            emit_front_matter,
        )
        from reporting_agent.render.themes import load_theme

        config = FrontMatterConfig(cover=CoverConfig(enabled=False))
        run = RunFacts(
            run_id="r1", template_id="t1", customer_name="Cust",
            period_display="", report_title="Report",
            period_start_year="2026", period_start_month="07",
        )
        msgs = load_messages("en")
        doc = load_theme("editorial")

        with pytest.raises(RenderFailedError, match="period_display"):
            emit_front_matter(doc, front_matter=config, run=run, messages=msgs)

    def test_absent_report_title(self) -> None:
        from reporting_agent.compile.messages import load_messages
        from reporting_agent.render.front_matter import (
            CoverConfig,
            FrontMatterConfig,
            emit_front_matter,
        )
        from reporting_agent.render.themes import load_theme

        config = FrontMatterConfig(cover=CoverConfig(enabled=False))
        run = RunFacts(
            run_id="r1", template_id="t1", customer_name="Cust",
            period_display="July 2026", report_title="   ",
            period_start_year="2026", period_start_month="07",
        )
        msgs = load_messages("en")
        doc = load_theme("editorial")

        with pytest.raises(RenderFailedError, match="report_title"):
            emit_front_matter(doc, front_matter=config, run=run, messages=msgs)
