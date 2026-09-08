"""The development prototype preserves compiler values and exposes actual styling."""
import importlib.util
from pathlib import Path
import pytest

spec = importlib.util.spec_from_file_location("design_preview", Path(__file__).parents[1] / "dev/design_preview/preview.py")
preview = importlib.util.module_from_spec(spec)
spec.loader.exec_module(preview)

def settings(**changes):
    return {"preset": "corporate", "accent_color": "#1f6f78", "density": "normal", "table_style": "banded", "page_size": "A4", "chart_font": "document", "chart_style": "stacked", **changes}

def test_four_themes_share_compiler_values_and_hash():
    samples = [preview.prepare(settings(preset=p)) for p in preview.CHOICES["preset"]]
    assert len({s["manifest"]["chart_data_hash"] for s in samples}) == 1
    assert all(s["manifest"]["displayed_figures"] == samples[0]["manifest"]["displayed_figures"] for s in samples)
    assert len({s["html"] for s in samples}) == 4
    assert [s["panel"] for s in samples[0]["chart"]["series"]] == [0, 1]
    assert {s["formatted"] for s in samples[0]["manifest"]["displayed_figures"]} >= {"0.18%", "27.30%", "0.35% (p95, est. from hourly averages)"}

def test_customization_reaches_html_and_chart_font():
    default = preview.prepare(settings())
    tuned = preview.prepare(settings(accent_color="#76558b", density="relaxed", table_style="bordered", page_size="Letter", chart_font="monospace"))
    assert "#76558b" in tuned["html"]
    assert "size:Letter" in tuned["html"]
    assert "padding:11pt 6pt" in tuned["html"]
    assert "border:0.6pt solid #ccd4db" in tuned["html"]
    assert tuned["chart"]["font"] == "DejaVu Sans Mono"
    assert tuned["manifest"]["chart_data_hash"] == default["manifest"]["chart_data_hash"]

def test_missing_points_are_gaps_and_not_zero_or_interpolation():
    result = preview.prepare(settings(), "missing")
    for series in result["chart"]["series"]:
        assert series["values"][8:11] == [None, None, None]
        assert series["values"][7] is not None
        assert series["values"][11] is not None

@pytest.mark.parametrize("variant", ["long-name", "empty", "overflow", "low"])
def test_stress_variants_compile_without_hiding_content(variant):
    result = preview.prepare(settings(), variant)
    assert "SAMPLE OUTPUT" in result["html"]
    if variant == "overflow":
        assert result["html"].count("Daily averages remain low") == 32
    if variant == "empty":
        assert not result["chart"]["series"]
        assert "No CPU telemetry" in result["html"]
    if variant == "long-name":
        assert "long-resource-name" in result["html"]

def test_invalid_settings_never_reach_css():
    with pytest.raises(ValueError):
        preview.prepare(settings(accent_color="red; color:white"))
