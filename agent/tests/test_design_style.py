"""`design.style`: the look a preset sets on top of its theme.

Two promises are tested here. A design without a style draws exactly what it drew before —
no chart spec key, no stylesheet value and no Word style changes. And a style, where set,
reaches the outputs it names: the chart spec the ECharts renderer reads, the reading copy's
stylesheet, and (in `tests/test_v4_report.py`'s styled walk) the Word file itself.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from reporting_agent.compile.blocks.base import DesignSettings, StyleSettings, apply_block_options
from reporting_agent.render.echarts import LINE_WIDTHS, chart_options, palette_colour
from reporting_agent.render.printcss import stylesheet
from reporting_agent.render.themes import (
    FONT_PAIRS,
    accent_for,
    cover_style_for,
    faces_for,
    theme_faces,
)

_PLAIN_NODE = SimpleNamespace(threshold="", values="", height="")


# --- parsing ---------------------------------------------------------------------------


def test_a_design_without_style_has_every_option_unset() -> None:
    design = DesignSettings.from_plain({"preset": "corporate"})
    assert design.style == StyleSettings()
    assert all(getattr(design.style, name) is None for name in StyleSettings.__slots__)


def test_a_style_is_read_field_by_field_and_ignores_wrong_types() -> None:
    style = StyleSettings.from_plain({"fonts": "plex", "chart_threshold": 80, "mark_at_or_above": True, "cover": 3})
    assert style.fonts == "plex"
    assert style.chart_threshold == 80
    # A boolean is not a threshold, and a number is not a cover: both read as unset.
    assert style.mark_at_or_above is None
    assert style.cover is None


# --- charts ----------------------------------------------------------------------------


def test_no_style_adds_nothing_to_a_chart() -> None:
    options = chart_options(_PLAIN_NODE, None)
    assert all(value is None for value in options.values())
    assert chart_options(_PLAIN_NODE, StyleSettings()) == options


def test_the_design_sets_every_chart_and_the_node_wins_where_it_has_its_own() -> None:
    style = StyleSettings(chart_line="bold", chart_grid="full", chart_values="last", chart_legend="top", chart_threshold=80)
    options = chart_options(_PLAIN_NODE, style)
    assert options == {"line": "bold", "grid": "full", "values": "last", "legend": "top", "palette": None, "height": None, "threshold": 80}

    own = SimpleNamespace(threshold="95", values="peak", height="tall")
    options = chart_options(own, style)
    assert options["threshold"] == 95
    assert options["values"] == "peak"
    assert options["height"] == "tall"
    assert LINE_WIDTHS["regular"] == 2.3  # the shipped width, which `regular` must keep


def test_chart_palettes_step_from_the_accent() -> None:
    assert palette_colour("standard", 0, "#1F3A5F") is None
    assert palette_colour(None, 3, "#1F3A5F") is None
    assert palette_colour("shades", 0, "#1F3A5F") == "#1f3a5f"
    shades = [palette_colour("shades", i, "#1F3A5F") for i in range(4)]
    assert len(set(shades)) == 4
    assert palette_colour("greys", 0, "#A3401F") == "#A3401F"
    assert palette_colour("greys", 1, "#A3401F") != "#A3401F"


# --- faces, cover, accent --------------------------------------------------------------


def test_a_pairing_names_faces_the_image_carries() -> None:
    assert {name for pair in FONT_PAIRS.values() for name in pair} <= set(theme_faces())
    design = DesignSettings.from_plain({"preset": "corporate", "style": {"fonts": "source", "figures": "text"}})
    assert faces_for(design) == ("Source Serif 4", "Source Sans 3", "Source Sans 3")
    assert faces_for(DesignSettings.from_plain({"preset": "ledger"})) == ("IBM Plex Sans", "IBM Plex Sans", "IBM Plex Mono")


def test_the_cover_is_the_style_s_where_it_picks_one() -> None:
    assert cover_style_for(DesignSettings.from_plain({"preset": "signal"})) == "full_bleed"
    assert cover_style_for(DesignSettings.from_plain({"preset": "signal", "style": {"cover": "band"}})) == "band"
    assert cover_style_for(DesignSettings.from_plain({"preset": "corporate", "style": {"cover": "summary"}})) == "summary"
    assert accent_for(SimpleNamespace(preset="corporate", accent_color="#2f3c7e")) == "2F3C7E"
    assert accent_for(SimpleNamespace(preset="corporate", accent_color="oklch(0.5 0.1 200)")) == "1F3A5F"


# --- the reading copy ------------------------------------------------------------------


def test_a_style_changes_only_what_it_names_in_the_stylesheet() -> None:
    plain = stylesheet("corporate")
    assert '--heading-face: "Liberation Sans"' in plain
    assert "margin: 17mm 16mm 14mm 16mm" in plain
    assert ".rpt-h-number { display: none; }" not in plain

    css = stylesheet(
        "corporate",
        style=StyleSettings(fonts="source", margins="wide", section_numbers="none", running_header="customer",
                            table_header="solid", heading_color="accent", text_size="large", callout="banner"),
        running_text='Contoso "West" · September 2026',
    )
    assert '--heading-face: "Source Serif 4", serif' in css
    assert '--body-face: "Source Sans 3", sans-serif' in css
    assert "margin: 22mm 21mm 18mm 21mm" in css
    assert ".rpt-h-number { display: none; }" in css
    assert 'content: "Contoso \\"West\\" · September 2026"' in css
    assert "table.rpt-table:not([data-header]) th { background: #1F3A5F; color: #fff;" in css
    assert "h1, h2 { color: var(--accent); }" in css
    assert 'background: var(--accent); color: #fff; font-weight: 700;' in css


@pytest.mark.parametrize("look", ["rule", "tint", "solid", "plain"])
def test_every_table_can_take_its_own_header(look: str) -> None:
    assert f'table.rpt-table[data-header="{look}"] th' in stylesheet("editorial")


def test_marked_cells_and_open_tables_are_styled_in_every_theme() -> None:
    css = stylesheet("brief")
    assert "table.rpt-table td[data-mark]" in css
    assert 'table.rpt-table[data-style="Table Open"] th' in css


# --- a block's own look ----------------------------------------------------------------


def test_a_block_s_own_style_is_set_on_the_nodes_it_emitted() -> None:
    from reporting_agent.compile.ast import Column, Table
    from reporting_agent.compile.blocks.base import LAYOUT_TABLE_STYLE, BlockOutput, BlockSpec

    table = Table(path=("blocks", "b", "nodes", 0), style="Table Hairline", columns=(Column(key="name", header="Name"),))
    layout = Table(path=("blocks", "b", "nodes", 1), style=LAYOUT_TABLE_STYLE, columns=(Column(key="x", header="X"),))
    block = BlockSpec(id="b", type="resource_table", config={"table_options": {"rows": "open", "header": "tint", "mark_at_or_above": 85}})
    styled = apply_block_options(BlockOutput(nodes=(table, layout)), block)
    first, second = styled.nodes
    assert (first.style, first.header_look, first.mark_at_or_above) == ("Table Open", "tint", "85")
    assert second == layout  # a layout table is never a data table, so it keeps its look

    untouched = BlockSpec(id="b", type="resource_table", config={})
    assert apply_block_options(BlockOutput(nodes=(table,)), untouched).nodes == (table,)
