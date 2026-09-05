"""The historical trend when there is no prior-run history to plot.

`compile/historical.py` plots one point per prior **verified run**, which is correct and
empty on a first report: a customer's first month has no earlier run to compare against,
so the trend they most want is the one the product could not draw. Requirement 19.5 makes
the block emit anyway with a statement saying so, which is honest and still an empty chart.

`collect/pipeline.py` seeds calendar months into the run's own snapshot for exactly that
case — the same estate, the same grain, one local calendar month at a time — and this file
pins how the block chooses between the two sources.
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("AWS_REGION", "us-east-1")
os.environ.setdefault("RPT_ARTIFACT_BUCKET", "rpt-artifacts-test")
os.environ.setdefault("RPT_PROSE_MODEL_ID", "test.prose-model")

import snapshot_factory as sf
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.snapshot_view import build_snapshot_view

CPU = "Percentage CPU"
MONTHS = {"2026-05": "31.20", "2026-06": "27.65", "2026-07": "12.48"}


def definition(lookback: int = 3) -> dict[str, object]:
    return {
        "schema_version": 2,
        "provider": "azure",
        "blocks": [
            {
                "id": "trend",
                "type": "historical_trend",
                "config": {"metric": CPU, "statistic": "avg", "lookback": lookback},
            }
        ],
    }


def snapshot(*, months: dict[str, str] | None):
    return sf.build(
        resources=[
            sf.vm(
                resource_id=f"/subscriptions/{sf.SUBSCRIPTION_ID}/resourceGroups/rg-prod"
                f"/providers/Microsoft.Compute/virtualMachines/prod-web-01",
                name="prod-web-01",
                month_cpu=months,
            )
        ]
    )


def charts_in(document) -> list:
    """Every `Chart` in the compiled document, walked off the dataclass tree."""
    from reporting_agent.compile.ast import Chart

    return [block for block in document.document.blocks if isinstance(block, Chart)]


def points_of(chart) -> list:
    return [point for series in chart.series for point in series.points]


def compile_trend(months: dict[str, str] | None, **kwargs):
    view = build_snapshot_view(snapshot(months=months))
    return compile_document(definition(), view=view, **kwargs)


# --------------------------------------------------------------------------- #


def test_a_run_with_no_prior_history_and_no_seed_still_emits_the_block() -> None:
    """Requirement 19.5, unchanged: a block that vanishes is indistinguishable from one
    never configured."""
    document = compile_trend(None)

    assert charts_in(document) == []
    # Not nothing: the statement saying there is no history to plot, and the block's own
    # counts. A vanished block and a configured-but-empty one must not look alike.
    assert document.document.blocks


def test_seeded_months_are_plotted_when_no_prior_run_was_selected() -> None:
    """The defect this exists for: a first report's trend was necessarily empty, because
    the only source was a set of earlier runs the customer did not have yet."""
    charts = charts_in(compile_trend(MONTHS))

    assert len(charts) == 1
    assert [point.x for point in points_of(charts[0])] == [
        "2026-05",
        "2026-06",
        "2026-07",
    ]


def test_a_seeded_point_re_resolves_against_this_run_s_own_snapshot() -> None:
    """A seeded figure is a figure. It carries no prior-run pointer prefix, because it
    was measured by this run and addresses this run's own document."""
    charts = charts_in(compile_trend(MONTHS))
    for point in points_of(charts[0]):
        assert "/month_buckets/" in point.y.snapshot_path
        assert not point.y.snapshot_path.startswith("/prior_runs")


def test_the_plotted_values_are_the_months_that_were_measured() -> None:
    charts = charts_in(compile_trend(MONTHS))
    plotted = {point.x: point.y.formatted for point in points_of(charts[0])}

    assert set(plotted) == set(MONTHS)
    for month, value in MONTHS.items():
        assert value in plotted[month]


def test_a_month_carrying_no_statistic_is_not_plotted_as_zero() -> None:
    """A trend is the one place a zero-filled gap does most damage: three months of
    declining usage is a story, and two measured months beside a fabricated zero is the
    same picture with nothing behind it."""
    partial = {"2026-06": "27.65", "2026-07": "12.48"}
    charts = charts_in(compile_trend(partial))

    assert [point.x for point in points_of(charts[0])] == ["2026-06", "2026-07"]


def test_the_seed_is_ignored_where_a_prior_run_was_selected() -> None:
    """A prior verified run is the better evidence — it was verified — so it wins. The
    fallback is whole rather than per month: a prior-run point is labelled by its report
    period and a seeded point by its calendar month, so interleaving them would put two
    kinds of label on one axis and, where a period and a month overlap, plot the same
    hours twice.
    """
    from reporting_agent.compile.historical import PriorRunCandidate, Selection

    prior = build_snapshot_view(snapshot(months=None))
    candidate = PriorRunCandidate(
        run_id="run-earlier-0001",
        period_start="2026-06-01",
        period_end="2026-06-30",
        timezone="Asia/Jakarta",
        status="completed",
        verification_status="passed",
        verification_created_at="2026-07-01T00:00:00Z",
        verification_id="ver-0001",
        snapshot_sha256="a" * 64,
    )

    class Source:
        def snapshot_view_for(self, run_id: str):
            return prior if run_id == "run-earlier-0001" else None

    view = build_snapshot_view(snapshot(months=MONTHS))
    document = compile_document(
        definition(),
        view=view,
        historical=Source(),
        historical_selections={
            (CPU, "avg", 3): Selection(selected=(candidate,), exclusions=())
        },
    )
    # The prior run's own period label, not a calendar month.
    assert [point.x for point in points_of(charts_in(document)[0])] == [
        "2026-06-01 – 2026-06-30"
    ]


# --------------------------------------------------------------------------- #
# A seeded run still replays
# --------------------------------------------------------------------------- #


def test_a_seeded_snapshot_recomputes_to_its_own_digest() -> None:
    """The property that decides whether the trend may ship at all.

    `verify/replay.py` re-folds a run's archived responses and demands the recomputed
    snapshot hash to the digest the stored one carries. A seeded month is measured over a
    window that is **not** this run's, so no fold over this window's archive reproduces it
    — the months are carried over, exactly as enhanced-tier guest statistics already are.

    Asserted here rather than left to the end-to-end suite because the failure is silent
    in the worst way: every figure is right, every other gate passes, and the document is
    withheld at the last one.
    """
    from reporting_agent.collect.snapshot import CONTENT_HASH_FIELD
    from reporting_agent.verify.replay import plan_from_snapshot

    document = snapshot(months=MONTHS)
    plan = plan_from_snapshot(document, catalog=load_catalog())

    carried = {
        bucket.local_month: bucket
        for resource in plan.resources
        for bucket in resource.month_buckets
    }

    assert set(carried) == set(MONTHS)
    for month, value in MONTHS.items():
        assert str(carried[month].statistics[0].value) == value
    assert document[CONTENT_HASH_FIELD]


def test_a_month_edited_in_the_snapshot_travels_into_the_recomputation() -> None:
    """The cost of carrying rather than recomputing, pinned so it is a known limit rather
    than a surprise: replay cannot catch a tampered month, because it has nothing to
    compare it against. The figure ledger still can — a trend figure's `snapshot_path`
    addresses `month_buckets`, and its `formatted` must equal what it addresses.
    """
    from reporting_agent.verify.replay import plan_from_snapshot

    document = snapshot(months=MONTHS)
    document["resources"][0]["month_buckets"][0]["statistics"][0]["value"] = "99.99"

    plan = plan_from_snapshot(document, catalog=load_catalog())
    carried = plan.resources[0].month_buckets[0]

    assert str(carried.statistics[0].value) == "99.99"


# --------------------------------------------------------------------------- #
# The commentary — one paragraph per resource
# --------------------------------------------------------------------------- #


def narrative_definition() -> dict[str, object]:
    """The chart, then its commentary. That order is a real dependency: the narrative
    reads what the chart put in the ledger, so it mints no second figure at an address
    the chart already owns."""
    return {
        "schema_version": 2,
        "provider": "azure",
        "blocks": [
            {
                "id": "trend",
                "type": "historical_trend",
                "config": {"metric": CPU, "statistic": "avg", "lookback": 3},
            },
            {"id": "trend-prose", "type": "trend_narrative", "config": {}},
        ],
    }


class Recorder:
    """A `ProseProvider` that records the request and answers with fixed prose."""

    def __init__(self, answer: str = "") -> None:
        self.requests: list[object] = []
        self.answer = answer

    def narrate(self, request) -> str:
        self.requests.append(request)
        return self.answer


def narrative_paragraphs(document) -> list:
    """Only the commentary block's own paragraphs — the chart block emits its own
    statement into the same document, and counting both would assert nothing."""
    from reporting_agent.compile.ast import Paragraph

    return [
        block
        for block in document.document.blocks
        if isinstance(block, Paragraph) and block.path.startswith("trend-prose:")
    ]


def compile_narrative(months, answer: str = ""):
    view = build_snapshot_view(snapshot(months=months))
    recorder = Recorder(answer)
    document = compile_document(narrative_definition(), view=view, prose=recorder)
    return document, recorder


def test_the_commentary_asks_under_the_trend_instruction_not_the_summary_s() -> None:
    """A trend block's figures arriving under the executive summary's instruction reads
    as a model that ignored its prompt rather than as a pipeline that handed it the wrong
    one — which is why the kind travels on the request."""
    from reporting_agent.compile.blocks.base import PROSE_KIND_TREND

    _, recorder = compile_narrative(MONTHS)

    assert len(recorder.requests) == 1
    assert recorder.requests[0].kind == PROSE_KIND_TREND


def test_the_model_sees_formatted_strings_labelled_by_resource_and_month() -> None:
    """Req 19.1 unchanged: the string the document will print, never the value it was
    formatted from. A trend is the shape that most invites "up 12% from May", and 12 is a
    number the compiler never placed."""
    _, recorder = compile_narrative(MONTHS)
    figures = dict(recorder.requests[0].figures)

    assert len(figures) == len(MONTHS)
    for label in figures:
        assert label.startswith("prod-web-01 · Percentage CPU")
    assert set(figures.values()) == {
        formatted for formatted in figures.values() if formatted
    }
    for month, value in MONTHS.items():
        assert any(month in label and value in figures[label] for label in figures)


def test_the_commentary_renders_one_paragraph_per_resource() -> None:
    document, _ = compile_narrative(
        MONTHS, answer="prod-web-01 drifted downward across the three months.\n\nA second."
    )
    assert len(narrative_paragraphs(document)) == 2


def test_a_run_with_no_trend_figures_asks_the_model_nothing() -> None:
    """No months and no prior runs is not a question worth a model call — and an empty
    figure list would invite the model to invent the subject."""
    _, recorder = compile_narrative(None)

    assert recorder.requests == []


def test_the_block_still_emits_when_there_is_nothing_to_narrate() -> None:
    """Req 19.5's rule, applied here: a block that vanishes is indistinguishable from one
    never configured."""
    document, _ = compile_narrative(None)
    assert len(narrative_paragraphs(document)) == 1


def test_the_commentary_mints_no_figure_of_its_own() -> None:
    """The whole reason it reads the ledger rather than the snapshot: a second figure at
    an address the chart already owns would put one pointer in the ledger twice."""
    with_prose, _ = compile_narrative(MONTHS, answer="One paragraph.")
    view = build_snapshot_view(snapshot(months=MONTHS))
    chart_only = compile_document(definition(), view=view)

    assert with_prose.figure_count == chart_only.figure_count
