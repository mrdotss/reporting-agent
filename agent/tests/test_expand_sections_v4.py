"""Schema v4 section layout — `compile/sections.py`'s second expansion.

A v4 section may carry `blocks`: the catalogue's slots in the author's order, some hidden,
some configured, with text the author added. Four claims are tested here:

1. **Absent `blocks` is the catalogue's layout.** A v4 section with no `blocks` emits the
   blocks a v3 `chart_and_table` section emits — the same types, configs and order — for
   every section type of both providers. Only the ids differ, by scheme.
2. **The layout is the author's.** Hidden blocks are gone, the order is theirs, a renamed
   heading prints their words, a narrowed table prints their columns, added text prints.
3. **Ids are named by slot.** Hiding or moving one block renames no other — which is what
   keeps an inspector selection and a ledger path stable while the author edits.
4. **v3 is untouched.** The same definition at v3 still compiles to v3's index-named ids.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest

from reporting_agent.catalog.loader import load_section_catalogue
from reporting_agent.compile.blocks.base import RESOURCE_ID_CONFIG_KEY
from reporting_agent.compile.messages import load_messages
from reporting_agent.compile.scope import ScopeRules, matches, scope_rules_from_plain
from reporting_agent.compile.sections import expand_sections, historical_trend_keys
from test_expand_sections import _make_view

VMS = [f"/subscriptions/s/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-{i}" for i in range(3)]


def _definition(provider: str, sections: list[dict[str, Any]], *, version: int = 4, language: str = "en") -> dict[str, Any]:
    return {
        "schema_version": version,
        "provider": provider,
        "identity": {"name": "Test", "language": language},
        "sections": sections,
    }


def _section(section_type: str, **extra: Any) -> dict[str, Any]:
    section: dict[str, Any] = {
        "id": "sec",
        "type": section_type,
        "position": 0,
        "selection": {"resource_types": [], "resource_groups": [], "tag_filters": [], "top_n": None, "sort": None},
        "metrics": [{"metric": "Percentage CPU", "statistic": "avg"}],
    }
    if section_type.startswith("historical_"):
        section["lookback"] = 3
    section.update(extra)
    return section


def _expand(provider: str, sections: list[dict[str, Any]], *, version: int = 4, language: str = "en"):
    return expand_sections(
        _definition(provider, sections, version=version, language=language),
        catalogue=load_section_catalogue(provider=provider),
        view=_make_view(VMS),
        messages=load_messages(language),
    )


def _shape(specs) -> list[tuple[str, dict[str, Any]]]:
    return [(spec.type, spec.config) for spec in specs]


# --- 1. absent `blocks` is the catalogue's layout -------------------------------------


@pytest.mark.parametrize(
    ("provider", "section_type"),
    [
        (provider, entry.key)
        for provider in ("aws", "azure")
        for entry in load_section_catalogue(provider=provider).entries
    ],
)
def test_a_v4_section_without_blocks_prints_what_v3_prints(provider: str, section_type: str) -> None:
    v3 = _expand(provider, [{**_section(section_type), "presentation": "chart_and_table"}], version=3)
    v4 = _expand(provider, [_section(section_type)])
    assert _shape(v4) == _shape(v3)


def test_v4_ids_are_named_by_slot() -> None:
    specs = _expand("azure", [_section("vm_utilization")])
    ids = [spec.id for spec in specs]
    assert ids[0] == "sec__title"
    assert ids[1:6] == ["sec__name__0", "sec__details__0", "sec__chart__0", "sec__summary__0", "sec__narrative__0"]
    assert ids[-1] == "sec__fleet"


def test_the_same_definition_at_v3_keeps_index_ids() -> None:
    specs = _expand("azure", [{**_section("vm_utilization"), "presentation": "chart_and_table"}], version=3)
    assert [spec.id for spec in specs][:3] == ["sec__0", "sec__1__0", "sec__2__0"]


# --- 2. the layout is the author's ------------------------------------------------------


def test_hidden_blocks_are_not_emitted() -> None:
    blocks = [{"slot": "fleet", "hidden": True}, {"slot": "each", "blocks": [{"slot": "narrative", "hidden": True}]}]
    specs = _expand("azure", [_section("vm_utilization", blocks=blocks)])
    types = {spec.type for spec in specs}
    assert "top_n_table" not in types and "resource_narrative" not in types
    assert "timeseries_chart" in types


def test_hiding_the_group_hides_every_per_resource_block() -> None:
    specs = _expand("azure", [_section("vm_utilization", blocks=[{"slot": "each", "hidden": True}])])
    assert [spec.id for spec in specs] == ["sec__title", "sec__fleet"]


def test_the_group_is_emitted_resource_major_in_the_authors_order() -> None:
    order = [{"slot": "chart"}, {"slot": "name"}, {"slot": "details"}, {"slot": "summary"}, {"slot": "narrative"}]
    specs = _expand("azure", [_section("vm_utilization", blocks=[{"slot": "each", "blocks": order}])])
    first_resource = [spec.id for spec in specs if spec.id.endswith("__0")]
    assert first_resource == ["sec__chart__0", "sec__name__0", "sec__details__0", "sec__summary__0", "sec__narrative__0"]
    resources = [spec.config[RESOURCE_ID_CONFIG_KEY] for spec in specs if spec.type == "timeseries_chart"]
    assert resources == VMS


def test_a_renamed_heading_prints_the_authors_words_in_the_report_language() -> None:
    title = {"en": "Compute use", "id": "Penggunaan komputasi"}
    en = _expand("azure", [_section("vm_utilization", blocks=[{"slot": "title", "title": title}])])
    indonesian = _expand(
        "azure", [_section("vm_utilization", blocks=[{"slot": "title", "title": title}])], language="id"
    )
    assert en[0].config["text"] == "Compute use"
    assert indonesian[0].config["text"] == "Penggunaan komputasi"
    assert "title_id" not in en[0].config


def test_an_unrenamed_heading_keeps_its_catalogue_title() -> None:
    specs = _expand("azure", [_section("vm_utilization", blocks=[{"slot": "title"}])])
    assert specs[0].config["text"] == load_messages("en").text("doc.section.vm_utilization")


def test_a_narrowed_table_prints_the_authors_columns_in_their_order() -> None:
    blocks = [{"slot": "each", "blocks": [{"slot": "details", "columns": ["power_state", "vm_size"]}]}]
    specs = _expand("azure", [_section("vm_utilization", blocks=blocks)])
    details = next(spec for spec in specs if spec.id == "sec__details__0")
    assert [column.get("attribute") or column.get("fact_key") for column in details.config["columns"]] == [
        "power_state",
        "vm_size",
    ]


def test_added_text_prints_as_static_prose_in_the_report_language() -> None:
    blocks = [{"slot": "title"}, {"kind": "text", "id": "u_intro", "text": {"en": "Read this first.", "id": "Baca ini dulu."}}]
    specs = _expand("azure", [_section("vm_utilization", blocks=blocks)], language="id")
    added = specs[1]
    assert (added.id, added.type, added.config) == ("sec__u_intro", "rich_text", {"text": "Baca ini dulu."})


def test_a_slot_the_layout_does_not_name_still_prints_after_the_named_ones() -> None:
    specs = _expand("azure", [_section("vm_utilization", blocks=[{"slot": "fleet"}])])
    assert specs[0].id == "sec__fleet"
    assert specs[1].id == "sec__title"


def test_an_author_filled_section_still_prints_its_typed_rows() -> None:
    section = _section("incident_report", supplied_rows=[["a", "b", "c", "d", "e"]])
    specs = _expand("azure", [section])
    rows = next(spec for spec in specs if spec.type == "blank_rows_table")
    assert rows.config["supplied_rows"] == [["a", "b", "c", "d", "e"]]


# --- 3. ids are stable while the author edits --------------------------------------------


def test_hiding_one_block_renames_no_other() -> None:
    shown = {spec.id for spec in _expand("azure", [_section("vm_utilization")])}
    blocks = [{"slot": "each", "blocks": [{"slot": "details", "hidden": True}]}]
    hidden = {spec.id for spec in _expand("azure", [_section("vm_utilization", blocks=blocks)])}
    assert hidden == shown - {f"sec__details__{n}" for n in range(len(VMS))}


def test_expansion_is_deterministic() -> None:
    blocks = [{"kind": "text", "id": "u_a", "text": {"en": "Words."}}, {"slot": "each", "blocks": [{"slot": "chart"}]}]
    first = _expand("azure", [_section("vm_utilization", blocks=blocks)])
    second = _expand("azure", [_section("vm_utilization", blocks=copy.deepcopy(blocks))])
    assert first == second


# --- the location filter and the trend keys ------------------------------------------------


def test_locations_narrow_by_region_folded() -> None:
    view = _make_view(VMS)
    resource = view.resources[0]
    assert matches(ScopeRules(locations=(resource.location.upper(),)), resource)
    assert not matches(ScopeRules(locations=("nowhere",)), resource)
    assert scope_rules_from_plain({"locations": ["a", "b"]}).locations == ("a", "b")
    assert scope_rules_from_plain({}).locations == ()


def test_a_hidden_trend_fetches_no_prior_runs() -> None:
    catalogue = load_section_catalogue(provider="azure")
    shown = _definition("azure", [_section("historical_vm_utilization")])
    hidden = _definition(
        "azure",
        [_section("historical_vm_utilization", blocks=[{"slot": "each", "blocks": [{"slot": "trend", "hidden": True}]}])],
    )
    assert historical_trend_keys(shown, catalogue=catalogue) == {("Percentage CPU", "avg", 3)}
    assert historical_trend_keys(hidden, catalogue=catalogue) == set()


# --- Blocks the author places -------------------------------------------------------------


def _placed(kind: str, provider: str = "azure", section_type: str = "vm_utilization", **extra):
    blocks = [{"slot": "title"}, {"kind": kind, "id": "u_x"}]
    return _expand(provider, [_section(section_type, blocks=blocks, **extra)])


def test_key_figures_read_the_sections_metrics() -> None:
    spec = next(s for s in _placed("key_figures") if s.id == "sec__u_x")
    assert spec.type == "kpi_row"
    assert spec.config["metrics"] == [{"metric": "Percentage CPU", "statistic": "avg"}]


def test_a_top_list_ranks_the_top_ten_when_the_section_sets_no_top_n() -> None:
    spec = next(s for s in _placed("top_list") if s.id == "sec__u_x")
    assert spec.type == "top_n_table"
    assert spec.scope_override is not None and spec.scope_override.top_n is not None
    assert (spec.scope_override.top_n.count, spec.scope_override.top_n.metric) == (10, "Percentage CPU")
    assert spec.config["order_by"] == {"metric": "Percentage CPU", "statistic": "avg"}


def test_a_top_list_keeps_the_sections_own_top_n() -> None:
    selection = {
        "resource_types": [], "resource_groups": [], "tag_filters": [], "sort": "ascending",
        "top_n": {"count": 3, "metric": "Percentage CPU", "statistic": "avg"},
    }
    spec = next(s for s in _placed("top_list", selection=selection) if s.id == "sec__u_x")
    assert spec.scope_override.top_n.count == 3  # type: ignore[union-attr]
    assert spec.scope_override.sort == "ascending"  # type: ignore[union-attr]


def test_month_vs_month_compares_against_the_previous_report_and_asks_for_it() -> None:
    spec = next(s for s in _placed("month_vs_month") if s.id == "sec__u_x")
    assert (spec.type, spec.config["against"], spec.config["lookback"]) == ("comparison_delta", "previous", 1)
    definition = _definition(
        "azure", [_section("vm_utilization", blocks=[{"kind": "month_vs_month", "id": "u_x"}])]
    )
    keys = historical_trend_keys(definition, catalogue=load_section_catalogue(provider="azure"))
    assert ("Percentage CPU", "avg", 1) in keys


def test_coverage_and_page_break_need_nothing_from_the_section() -> None:
    assert next(s for s in _placed("coverage", "aws", "backups") if s.id == "sec__u_x").type == "gaps_and_coverage"
    assert next(s for s in _placed("page_break", "aws", "backups") if s.id == "sec__u_x").type == "page_break"


def test_a_heatmap_is_the_time_series_compile_as_rows_of_cells() -> None:
    spec = next(s for s in _placed("heatmap") if s.id == "sec__u_x")
    assert (spec.type, spec.config["layout"]) == ("timeseries_chart", "heatmap")
    assert spec.scope_override.top_n.count == 12  # type: ignore[union-attr]


def test_a_sparkline_table_is_a_sparkline_chart_and_its_summary() -> None:
    specs = [s for s in _placed("sparklines") if s.id.startswith("sec__u_x")]
    assert [(s.id, s.type) for s in specs] == [("sec__u_x__chart", "timeseries_chart"), ("sec__u_x__summary", "metric_summary")]
    assert specs[0].config["style"] == "sparkline"
    assert specs[0].scope_override == specs[1].scope_override


def test_a_callout_carries_its_condition_and_the_reports_words() -> None:
    blocks = [{"kind": "callout", "id": "u_x", "when": "peak_at_or_above", "threshold": 80,
               "text": {"en": "{resource} ran hot at {value}.", "id": "{resource} panas di {value}."}}]
    specs = _expand("azure", [_section("vm_utilization", blocks=blocks)], language="id")
    spec = next(s for s in specs if s.id == "sec__u_x")
    assert spec.type == "rich_text"
    assert spec.config["text"] == "{resource} panas di {value}."
    assert spec.config["callout"] == {"when": "peak_at_or_above", "tone": "info", "metric": "Percentage CPU", "statistic": "avg", "threshold": 80}
