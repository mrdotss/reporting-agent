"""What sets `ledger`, `signal` and `brief` apart beyond faces and colours.

Each theme's `ThemeSpec` carries three treatments — `cover_style`, `heading_rule` and
`display_numbers` — and both outputs read them: the Word file through its built styles and
the cover the front matter describes, the reading copy through `render/printcss.py`. These
tests hold the two halves to one decision, and hold the first four themes to what they were.
"""

from __future__ import annotations

import io
import json
import re
import zlib
from pathlib import Path
from types import SimpleNamespace

import pytest
from PIL import Image

from reporting_agent.compile.messages import load_messages
from reporting_agent.render import themes as T
from reporting_agent.render.front_matter import (
    CoverConfig,
    CoverTreatment,
    FrontMatterBackground,
    FrontMatterConfig,
    FrontMatterHeading,
    FrontMatterPageBreak,
    RunFacts,
    cover_treatment,
    emit_front_matter,
    front_matter_sections,
    solid_png,
)
from reporting_agent.render.printcss import stylesheet

_MESSAGES = load_messages("en")
_RUN = RunFacts(
    run_id="run-001",
    template_id="tmpl-abc",
    customer_name="Acme Corp",
    period_display="July 2026",
    report_title="Infrastructure Report",
    period_start_year="2026",
    period_start_month="07",
)
_FIRST_FOUR = ("editorial", "corporate", "technical", "minimal")


def _design(preset: str, accent: str = "") -> SimpleNamespace:
    return SimpleNamespace(preset=preset, accent_color=accent)


def _style(preset: str, style_id: str) -> str:
    styles = T._styles_xml(T.THEME_SPECS[preset])
    found = re.search(rf'<w:style w:type="paragraph" w:styleId="{style_id}">.*?</w:style>', styles, re.DOTALL)
    assert found is not None, (preset, style_id)
    return found.group(0)


# --- the cover -------------------------------------------------------------------------


def test_each_theme_asks_for_its_own_cover() -> None:
    assert cover_treatment(_design("signal")) == CoverTreatment(fill="A3401F")
    assert cover_treatment(_design("brief")) == CoverTreatment(own_page=False)
    for preset in (*_FIRST_FOUR, "ledger"):
        assert cover_treatment(_design(preset)) == CoverTreatment(), preset
    assert cover_treatment(_design("seasonal")) == CoverTreatment()


def test_a_full_bleed_cover_takes_a_chosen_accent() -> None:
    assert cover_treatment(_design("signal", "#2f3c7e")) == CoverTreatment(fill="2F3C7E")
    # Anything that is not a six-digit hex falls back to the theme's own accent.
    assert cover_treatment(_design("signal", "teal")) == CoverTreatment(fill="A3401F")


def test_the_ground_is_a_png_of_exactly_that_colour_and_the_same_bytes_every_time() -> None:
    image = solid_png("A3401F")
    assert image == solid_png("A3401F")
    assert image.startswith(b"\x89PNG\r\n\x1a\n")
    decoded = Image.open(io.BytesIO(image)).convert("RGB")
    assert decoded.size == (8, 8)
    assert set(decoded.getdata()) == {(0xA3, 0x40, 0x1F)}
    # One chunk of compressed rows, each a filter byte and eight pixels.
    assert zlib.decompress(image[image.index(b"IDAT") + 4 : image.index(b"IEND") - 8]) == (
        b"\x00" + b"\xa3\x40\x1f" * 8
    ) * 8


def test_a_full_bleed_cover_lays_its_ground_first() -> None:
    sections = front_matter_sections(
        front_matter=FrontMatterConfig(), run=_RUN, messages=_MESSAGES, cover=CoverTreatment(fill="A3401F")
    )
    assert isinstance(sections[0], FrontMatterBackground)
    assert sections[0].image == solid_png("A3401F")


def test_a_supplied_background_image_still_wins_over_the_ground() -> None:
    picture = solid_png("123456")
    config = FrontMatterConfig(cover=CoverConfig(enabled=True, background_image=picture))
    sections = front_matter_sections(
        front_matter=config, run=_RUN, messages=_MESSAGES, cover=CoverTreatment(fill="A3401F")
    )
    backgrounds = [section for section in sections if isinstance(section, FrontMatterBackground)]
    assert [background.image for background in backgrounds] == [picture]


def test_a_disabled_cover_has_no_ground() -> None:
    config = FrontMatterConfig(cover=CoverConfig(enabled=False))
    sections = front_matter_sections(
        front_matter=config, run=_RUN, messages=_MESSAGES, cover=CoverTreatment(fill="A3401F")
    )
    assert not any(isinstance(section, FrontMatterBackground) for section in sections)


def test_a_title_strip_runs_straight_into_document_control() -> None:
    def leading(cover: CoverTreatment) -> list[object]:
        sections = front_matter_sections(
            front_matter=FrontMatterConfig(), run=_RUN, messages=_MESSAGES, cover=cover
        )
        control = next(
            index
            for index, section in enumerate(sections)
            if isinstance(section, FrontMatterHeading) and section.style == T.DOCUMENT_CONTROL_STYLE
        )
        return list(sections[:control])

    assert any(isinstance(section, FrontMatterPageBreak) for section in leading(CoverTreatment()))
    assert not any(isinstance(section, FrontMatterPageBreak) for section in leading(CoverTreatment(own_page=False)))


def test_the_word_file_anchors_the_ground_behind_a_signal_cover() -> None:
    document = T.load_theme("signal")
    emit_front_matter(
        document,
        front_matter=FrontMatterConfig(),
        run=_RUN,
        messages=_MESSAGES,
        cover=cover_treatment(_design("signal")),
    )
    xml = document.element.body.xml
    assert 'behindDoc="1"' in xml
    assert xml.index('behindDoc="1"') < xml.index("Infrastructure Report")


def test_a_full_bleed_cover_is_set_in_white_and_the_others_are_not() -> None:
    assert '<w:color w:val="FFFFFF"/>' in _style("signal", "CoverTitle")
    assert '<w:color w:val="FFFFFF"/>' in _style("signal", "CoverMeta")
    for preset in (*_FIRST_FOUR, "ledger", "brief"):
        assert "FFFFFF" not in _style(preset, "CoverTitle"), preset


# --- headings --------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("preset", "expected"),
    [
        ("ledger", '<w:bottom w:val="double" w:sz="6" w:space="3" w:color="245C45"/>'),
        ("brief", '<w:bottom w:val="single" w:sz="6" w:space="3" w:color="3D4F8F"/>'),
        ("editorial", '<w:bottom w:val="single" w:sz="4" w:space="3" w:color="C9D4D7"/>'),
    ],
)
def test_the_rule_under_a_section_heading_is_the_theme_s(preset: str, expected: str) -> None:
    assert expected in _style(preset, "Heading1")


def test_signal_draws_no_rule_under_a_section_heading() -> None:
    assert "<w:pBdr>" not in _style("signal", "Heading1")


def test_paragraph_properties_are_written_in_schema_order() -> None:
    """Word enforces `CT_PPr`'s sequence where LibreOffice forgives it."""
    order = ("w:keepNext", "w:pBdr", "w:shd", "w:tabs", "w:spacing", "w:ind", "w:outlineLvl")
    for preset in T.THEME_PRESETS:
        styles = T._styles_xml(T.THEME_SPECS[preset])
        for properties in re.findall(r"<w:pPr>(.*?)</w:pPr>", styles):
            seen = [name for name in order if f"<{name}" in properties]
            positions = [properties.index(f"<{name}") for name in seen]
            assert positions == sorted(positions), (preset, properties)


# --- callouts --------------------------------------------------------------------------


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_every_theme_sets_a_callout_apart_in_both_tones(preset: str) -> None:
    spec = T.THEME_SPECS[preset]
    info = _style(preset, "Callout")
    attention = _style(preset, "CalloutAttention")
    assert f'<w:left w:val="single" w:sz="18" w:space="8" w:color="{spec.palette.accent}"/>' in info
    assert f'w:fill="{spec.palette.band}"' in info
    assert f'w:color="{T.ATTENTION_RULE}"' in attention
    assert f'w:fill="{T.ATTENTION_TINT}"' in attention


# --- the reading copy ------------------------------------------------------------------


def test_the_reading_copy_follows_the_same_treatments() -> None:
    ledger, signal, brief = (stylesheet(preset) for preset in ("ledger", "signal", "brief"))

    assert "border-bottom: 2.4pt double var(--accent)" in ledger
    assert ".rpt-h-number { display: block;" in signal
    assert ".rpt-cover [data-style=\"Cover Title\"] {\n  color: #fff;" in signal
    assert "border-bottom: 0.75pt solid var(--accent)" in brief
    assert '[data-style="Document Control"] ~ [data-style="Document Control"]' in brief
    for css in (ledger, signal, brief):
        assert "h1::after, h2::after { content: none; }" in css


@pytest.mark.parametrize("preset", _FIRST_FOUR)
def test_the_first_four_keep_their_accent_bar_and_band(preset: str) -> None:
    css = stylesheet(preset)
    assert "content: none; }" not in css.split("/* A v4 callout")[1]
    assert "border-top: 4pt solid var(--accent);" in css
    assert ".rpt-h-number { display: block;" not in css


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_every_reading_copy_styles_both_callout_tones(preset: str) -> None:
    css = stylesheet(preset)
    assert '.rpt-block[data-style="Callout Attention"] {' in css
    assert f"border-left-color: #{T.ATTENTION_RULE};" in css


def test_a_serif_face_falls_back_to_serif() -> None:
    assert '--heading-face: "Source Serif 4", serif;' in stylesheet("brief")
    assert '--body-face: "Source Sans 3", sans-serif;' in stylesheet("brief")


# --- the faces -------------------------------------------------------------------------


def test_the_font_guard_names_a_face_that_resolves_to_something_else() -> None:
    def fake(face: str) -> str:
        return "Noto Sans" if face == "Archivo" else face

    assert T.unresolved_faces(fake) == ["'Archivo' resolves to Noto Sans"]
    assert T.unresolved_faces(lambda face: f"{face},Alias") == []
    assert "IBM Plex Mono" in T.theme_faces() and "Liberation Sans" in T.theme_faces()


# --- the app's copy --------------------------------------------------------------------

THEME_SPECS_FIXTURE = Path(__file__).resolve().parent / "fixtures" / "theme_specs.json"
"""What `app/lib/builder/theme.ts` mirrors, written from `THEME_SPECS` so the app's test can
hold its copy to the runtime's without parsing Python."""


def theme_spec_rows() -> dict[str, dict[str, object]]:
    rows: dict[str, dict[str, object]] = {}
    for preset, spec in T.THEME_SPECS.items():
        palette = spec.palette
        rows[preset] = {
            "faces": {"heading": spec.face.heading, "body": spec.face.body, "figure": spec.face.figure},
            "accent": f"#{palette.accent}",
            "ink": f"#{palette.ink}",
            "muted": f"#{palette.muted}",
            "rule": f"#{palette.rule}",
            "band": f"#{palette.band}",
            "titlePt": spec.title_pt,
            "subtitlePt": spec.subtitle_pt,
            "headingPt": list(spec.heading_pt),
            "bodyPt": spec.body_pt,
            "smallPt": spec.small_pt,
            "lineSpacing": spec.line_spacing,
            "headingAllCaps": spec.heading_all_caps,
            "bandedRows": spec.banded_rows,
            "coverStyle": spec.cover_style,
            "headingRule": spec.heading_rule,
            "displayNumbers": spec.display_numbers,
        }
    return rows


def test_the_app_s_copy_of_the_theme_specs_is_current() -> None:
    assert json.loads(THEME_SPECS_FIXTURE.read_text()) == theme_spec_rows(), (
        "tests/fixtures/theme_specs.json is stale: run `PYTHONPATH=src:tests python "
        "tests/test_theme_treatments.py`, then bring app/lib/builder/theme.ts level with it"
    )


if __name__ == "__main__":
    THEME_SPECS_FIXTURE.write_text(json.dumps(theme_spec_rows(), indent=2) + "\n")
    print(f"wrote {THEME_SPECS_FIXTURE}")
