"""A chart with no companion table: the default since `render/charts.COMPANION_TABLE_IN_DOCX`.

The `.docx` prints the chart and not a table of every plotted point, matching the designed
PDF. The points are still proven, by a narrower route:

* the chart answers to its **data hash** alone — there is no printed number for the table
  gate to check, and none is missing;
* each plotted point counts as rendered **only** through a chart whose hash matched
  (`drawn_verified`), and a mismatched chart's points are not reported a second time;
* the converted PDF is not searched for them, because nothing prints them as text.
"""

from __future__ import annotations

import io
from typing import Final

import pytest
from docx import Document as open_docx

import definition_factory as df
import messages_factory as mf
import snapshot_factory as sf
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render.charts import COMPANION_TABLE_IN_DOCX, plotted_figure_paths
from reporting_agent.render.docx import render_document
from reporting_agent.verify.anchors import check_tables, read_grids
from reporting_agent.verify.charts import SIDECAR_SUFFIX, chart_nodes, check_charts
from reporting_agent.verify.findings import FINDING_CHART_HASH_MISMATCH, FINDING_CHART_TABLE_MISSING

DESIGN: Final[dict[str, object]] = {
    "preset": "editorial",
    "accent_color": "#1f6f78",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": False,
    "logo": None,
    "page_size": "A4",
}


@pytest.fixture(scope="module")
def rendered():
    view = build_snapshot_view(sf.two_vm_snapshot())
    compiled = compile_document(
        df.definition(
            [df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})], design=DESIGN
        ),
        view=view,
    )
    outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
        messages=mf.EN,
    )
    grids = read_grids(open_docx(io.BytesIO(outcome.docx_bytes)))
    return compiled, outcome, grids


def test_the_docx_prints_no_companion_table() -> None:
    assert COMPANION_TABLE_IN_DOCX is False


def test_a_clean_chart_verifies_by_its_hash_and_vouches_for_every_plotted_point(rendered) -> None:
    compiled, outcome, grids = rendered
    assert grids == ()

    result = check_charts(
        compiled.document,
        grids=grids,
        sidecars=dict(outcome.chart_sidecars),
        table_pass=check_tables(compiled.ledger, grids),
        messages=mf.EN,
    )

    assert result.findings == ()
    [chart] = list(chart_nodes(compiled.document))
    assert result.verified == {chart.anchor_id}
    points = plotted_figure_paths(chart, messages=mf.EN)
    assert points and result.drawn_verified == points
    assert result.drawn_faulted == frozenset()
    # Every one of them is a ledger entry: the chart vouches for real figures only.
    assert points <= {str(path) for path in compiled.ledger.entries}


def test_a_stale_image_is_a_hash_finding_and_its_points_are_not_vouched_for(rendered) -> None:
    compiled, outcome, grids = rendered
    sidecars = {
        key: (b'{"data_sha256": "' + b"0" * 64 + b'"}' if key.endswith(SIDECAR_SUFFIX) else value)
        for key, value in outcome.chart_sidecars.items()
    }

    result = check_charts(
        compiled.document,
        grids=grids,
        sidecars=sidecars,
        table_pass=check_tables(compiled.ledger, grids),
        messages=mf.EN,
    )

    assert [finding["type"] for finding in result.findings] == [FINDING_CHART_HASH_MISMATCH]
    assert FINDING_CHART_TABLE_MISSING not in {finding["type"] for finding in result.findings}
    assert result.verified == frozenset()
    assert result.drawn_verified == frozenset()
    assert result.drawn_faulted and result.drawn == result.drawn_faulted
