"""Chart verification (Req 30).

The tests that carry weight here are the two "one gate alone is not enough" cases. Each
constructs a document that the *other* gate accepts and asserts this pass rejects it:

* a **stale image** — the companion table is perfect and the sidecar records a digest from an
  earlier set of numbers, which the anchored pass cannot see;
* a **fabricated table cell** — the sidecar agrees with the ledger and the printed grid does
  not, which the hash gate cannot see.

Together they are the argument for Req 30.5. Either test alone would pass against a
half-implemented verifier.
"""

from __future__ import annotations

import io
import json
from typing import Final

import pytest
from docx import Document as open_docx

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.render.charts import SIDECAR_SUFFIX as RENDER_SIDECAR_SUFFIX
from reporting_agent.render.docx import render_document
from reporting_agent.verify.anchors import AnchorPass, TableGrid, check_tables, read_grids
from reporting_agent.verify.charts import (
    SIDECAR_SUFFIX,
    ChartPass,
    chart_nodes,
    check_charts,
    sidecar_digest,
)
from reporting_agent.verify.findings import (
    FINDING_CHART_HASH_MISMATCH,
    FINDING_CHART_TABLE_MISSING,
    SEVERITY_BLOCKING,
)

DEFAULT_DESIGN: Final[dict[str, object]] = {
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
    """One compiled and rendered chart document, shared — rendering draws a real PNG."""
    view = build_snapshot_view(sf.two_vm_snapshot())
    compiled = compile_document(
        df.definition(
            [df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})],
            design=DEFAULT_DESIGN,
        ),
        view=view,
    )
    outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DEFAULT_DESIGN),
    )
    grids = read_grids(open_docx(io.BytesIO(outcome.docx_bytes)))
    return compiled, outcome, grids


def run(rendered, *, grids=None, sidecars=None) -> ChartPass:
    compiled, outcome, default_grids = rendered
    resolved_grids = default_grids if grids is None else grids
    return check_charts(
        compiled.document,
        grids=resolved_grids,
        sidecars=dict(outcome.chart_sidecars) if sidecars is None else sidecars,
        table_pass=check_tables(compiled.ledger, resolved_grids),
    )


# --------------------------------------------------------------------------- #
# The suffix contract, and the clean case
# --------------------------------------------------------------------------- #


def test_the_sidecar_key_this_module_reads_is_the_key_the_renderer_writes() -> None:
    """The constant is restated rather than imported, so it is asserted equal here.

    Two spellings of one key is the kind of drift that produces `chart_hash_mismatch` on
    every chart of a correct document.
    """
    assert SIDECAR_SUFFIX == RENDER_SIDECAR_SUFFIX


def test_a_clean_render_verifies_every_chart_through_both_gates(rendered) -> None:
    compiled, outcome, grids = rendered
    outcome_pass = run(rendered)

    assert outcome_pass.charts_checked >= 1
    assert outcome_pass.findings == ()
    assert outcome_pass.hashes_matched == outcome_pass.charts_checked
    assert len(outcome_pass.verified) == outcome_pass.charts_checked
    assert outcome_pass.blocking_identities == frozenset()
    assert {node.anchor_id for node in chart_nodes(compiled.document)} == set(
        outcome_pass.verified
    )
    assert all(key.endswith(SIDECAR_SUFFIX) for key in outcome.chart_sidecars)
    assert grids


def test_the_recomputed_hash_is_derived_from_the_ledger_and_not_from_the_sidecar(
    rendered,
) -> None:
    """Req 30.2 — the check that would otherwise always pass.

    Rewriting the sidecar's digest to an arbitrary value must move the *observed* side and
    leave the *recomputed* side untouched. A recomputation reading the sidecar would report
    the two as equal and pass.
    """
    _, outcome, _ = rendered
    identity = next(iter(outcome.chart_hashes))
    forged = "f" * 64
    sidecars = {
        key: json.dumps({**json.loads(value.decode()), "data_hash": forged}).encode()
        for key, value in outcome.chart_sidecars.items()
    }

    findings = run(rendered, sidecars=sidecars).findings

    assert [f["type"] for f in findings] == [FINDING_CHART_HASH_MISMATCH]
    assert findings[0]["observed"] == forged
    assert findings[0]["expected"] == outcome.chart_hashes[identity]
    assert findings[0]["expected"] != forged


# --------------------------------------------------------------------------- #
# Req 30.5 — neither gate alone is enough
# --------------------------------------------------------------------------- #


def test_a_stale_image_passes_the_table_gate_and_fails_this_pass(rendered) -> None:
    """The companion table is perfect. Only the hash says the picture is out of date."""
    compiled, outcome, grids = rendered
    sidecars = {
        key: json.dumps({**json.loads(value.decode()), "data_hash": "a" * 64}).encode()
        for key, value in outcome.chart_sidecars.items()
    }

    table_pass = check_tables(compiled.ledger, grids)
    assert table_pass.findings == (), "the table gate sees nothing wrong"

    outcome_pass = run(rendered, sidecars=sidecars)

    assert outcome_pass.verified == frozenset()
    assert [f["type"] for f in outcome_pass.findings] == [FINDING_CHART_HASH_MISMATCH]
    assert all(f["severity"] == SEVERITY_BLOCKING for f in outcome_pass.findings)


def test_a_fabricated_table_cell_passes_the_hash_gate_and_fails_this_pass(rendered) -> None:
    """The sidecar agrees with the ledger. Only the table gate sees the invented number."""
    _, outcome, grids = rendered
    target = grids[0]
    tampered = (
        TableGrid(
            identity=target.identity,
            ordinal=target.ordinal,
            headers=target.headers,
            rows=((*target.rows[0][:-1], "99.99%"), *target.rows[1:]),
        ),
        *grids[1:],
    )

    outcome_pass = run(rendered, grids=tampered)

    assert outcome_pass.hashes_matched == outcome_pass.charts_checked, (
        "the hash gate sees nothing wrong"
    )
    assert outcome_pass.verified == frozenset()
    assert outcome.chart_hashes


# --------------------------------------------------------------------------- #
# Req 30.4, 30.6 — pairing by identity, and the three ways a sidecar fails
# --------------------------------------------------------------------------- #


def test_a_missing_companion_table_names_the_chart(rendered) -> None:
    """Req 30.4 — pairing is by identity, so an absent identity is an absent table however
    many other tables sit beside the image."""
    outcome_pass = run(rendered, grids=())

    missing = [f for f in outcome_pass.findings if f["type"] == FINDING_CHART_TABLE_MISSING]
    assert len(missing) == 1
    assert missing[0]["ast_path"]
    assert missing[0]["table_id"].startswith("cht:")
    assert outcome_pass.verified == frozenset()


def test_a_table_at_a_different_identity_does_not_pair(rendered) -> None:
    """A data table beside the image is not the companion table unless it says so."""
    outcome_pass = run(
        rendered,
        grids=(TableGrid(identity="tbl:elsewhere:0", ordinal=1, headers=("A",), rows=()),),
    )

    assert FINDING_CHART_TABLE_MISSING in {f["type"] for f in outcome_pass.findings}


@pytest.mark.parametrize(
    ("label", "payload"),
    [
        ("absent", None),
        ("not json", b"<html>not a sidecar</html>"),
        ("no data_hash key", b'{"identity":"cht:ts:0"}'),
        ("digest is not a string", b'{"data_hash": 12}'),
        ("digest is the wrong length", b'{"data_hash": "abc"}'),
        ("digest is not lowercase hex", b'{"data_hash": "' + b"A" * 64 + b'"}'),
    ],
)
def test_every_unreadable_sidecar_fails_the_same_way(rendered, label, payload) -> None:
    """Req 30.6 — one outcome for three failures, so "no sidecar" is never the lesser one."""
    _, outcome, _ = rendered
    sidecars = {} if payload is None else dict.fromkeys(outcome.chart_sidecars, payload)

    findings = run(rendered, sidecars=sidecars).findings

    assert [f["type"] for f in findings] == [FINDING_CHART_HASH_MISMATCH], label
    assert findings[0]["observed"] == ""


@pytest.mark.parametrize(
    "payload", [None, 12, b"{", b'{"data_hash": null}', b"[]", b"\xff\xfe"]
)
def test_sidecar_digest_returns_none_for_anything_unreadable(payload) -> None:
    assert sidecar_digest(payload) is None


def test_sidecar_digest_reads_a_well_formed_digest() -> None:
    """Non-vacuity: the parser this module rejects with must also accept."""
    assert sidecar_digest(b'{"data_hash": "' + b"9" * 64 + b'"}') == "9" * 64


# --------------------------------------------------------------------------- #
# Every chart is checked, and the counts say so
# --------------------------------------------------------------------------- #


def test_every_chart_is_checked_rather_than_stopping_at_the_first_failure() -> None:
    """Req 30.7 — a reviewer sees every broken chart in one verification."""
    view = build_snapshot_view(sf.two_vm_snapshot())
    compiled = compile_document(
        df.definition(
            [
                # Both over `avg`: the fixture's day buckets carry only that statistic, and
                # a timeseries chart with nothing to plot compiles to a notice table rather
                # than to a chart — which would leave this test asserting over one chart.
                df.block("ts1", "timeseries_chart", {"metrics": [df.CPU_AVG]}),
                df.block("ts2", "timeseries_chart", {"metrics": [df.CPU_AVG]}),
            ],
            design=DEFAULT_DESIGN,
        ),
        view=view,
    )

    outcome_pass = check_charts(
        compiled.document,
        grids=(),
        sidecars={},
        table_pass=AnchorPass(
            findings=(),
            matched=frozenset(),
            faulted=frozenset(),
            blocking_identities=frozenset(),
            anchors_checked=0,
            tables_resolved=0,
        ),
    )

    assert outcome_pass.charts_checked == 2
    assert outcome_pass.hashes_matched == 0
    assert len(outcome_pass.blocking_identities) == 2
    assert (
        sum(1 for f in outcome_pass.findings if f["type"] == FINDING_CHART_TABLE_MISSING) == 2
    )


def test_a_document_with_no_chart_checks_nothing_and_records_nothing() -> None:
    view = build_snapshot_view(sf.two_vm_snapshot())
    compiled = compile_document(
        df.definition(
            [df.block("res", "resource_table", {"columns": [df.CPU_AVG]})],
            design=DEFAULT_DESIGN,
        ),
        view=view,
    )

    outcome_pass = check_charts(
        compiled.document,
        grids=(),
        sidecars={},
        table_pass=AnchorPass(
            findings=(),
            matched=frozenset(),
            faulted=frozenset(),
            blocking_identities=frozenset(),
            anchors_checked=0,
            tables_resolved=0,
        ),
    )

    assert outcome_pass == ChartPass(
        findings=(),
        charts_checked=0,
        hashes_matched=0,
        verified=frozenset(),
        blocking_identities=frozenset(),
    )


def test_a_chart_whose_companion_table_carries_a_finding_is_not_verified(rendered) -> None:
    """Req 30.5 — "verified" requires both gates, and the table gate's verdict arrives
    through `table_pass` rather than being re-derived here."""
    compiled, outcome, grids = rendered
    identity = next(iter(outcome.chart_hashes))

    outcome_pass = check_charts(
        compiled.document,
        grids=grids,
        sidecars=dict(outcome.chart_sidecars),
        table_pass=AnchorPass(
            findings=(),
            matched=frozenset(),
            faulted=frozenset(),
            blocking_identities=frozenset({identity}),
            anchors_checked=1,
            tables_resolved=1,
        ),
    )

    assert outcome_pass.hashes_matched == outcome_pass.charts_checked
    assert outcome_pass.verified == frozenset()
    # No finding of its own: the table pass already recorded the defect, and recording it
    # twice would double-count one document error.
    assert outcome_pass.findings == ()


def test_a_chart_inside_a_row_block_is_found_by_the_walk() -> None:
    """`chart_nodes` descends through `LayoutColumn`, unlike the figure walk, because a
    chart's identity is rooted at its own block rather than at the row's."""
    view = build_snapshot_view(sf.two_vm_snapshot())
    compiled = compile_document(
        df.definition(
            [
                {
                    "id": "r",
                    "type": "row",
                    "columns": [
                        [df.block("ts", "timeseries_chart", {"metrics": [df.CPU_AVG]})],
                        [df.block("res", "resource_table", {"columns": [df.CPU_AVG]})],
                    ],
                }
            ],
            design=DEFAULT_DESIGN,
        ),
        view=view,
    )

    found = [node.anchor_id for node in chart_nodes(compiled.document)]

    assert found == ["cht:ts:0"]
