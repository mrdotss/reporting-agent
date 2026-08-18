"""The committed theme thumbnails still describe the themes that ship (Req 13.2, 13.8).

**No render happens here.** Rendering four pages costs four LibreOffice conversions, needs
a rasterizer the runtime image deliberately does not carry, and produces PNGs whose bytes
differ between poppler versions — so a test that regenerated and compared would fail on a
machine whose poppler was a minor version ahead, for no defect.

What this asserts instead is the property that actually has to hold on every build: each
committed sidecar records the digest of the theme document **currently shipped**. That is
the same comparison `app/lib/templates/theme-thumbnails.ts` performs at render time, so a
theme edited without regenerating its thumbnail fails here — loudly, in CI — rather than
silently degrading to a card that says the page image is unavailable.

The sample definition is validated too, because it is a definition like any other and a
change to the block-config schema could make it uncompilable. Discovering that at the
moment somebody regenerates the thumbnails is discovering it late.
"""

from __future__ import annotations

import pytest

from reporting_agent.compile.definition import collect_definition_issues
from reporting_agent.render.themes import THEME_PRESETS, theme_path
from reporting_agent.render.thumbnails import (
    SAMPLE_DEFINITION,
    THUMBNAIL_DIR,
    sidecar_for,
    theme_digest,
    thumbnail_paths,
)


@pytest.mark.parametrize("preset", THEME_PRESETS)
def test_every_preset_has_a_committed_image_and_sidecar(preset: str) -> None:
    png, sidecar = thumbnail_paths(preset)

    assert png.exists(), (
        f"themes/thumbnails/{preset}.png is missing. Regenerate with "
        f"`python -m reporting_agent.render.thumbnails --write`."
    )
    assert sidecar.exists(), f"themes/thumbnails/{preset}.json is missing"
    assert png.stat().st_size > 0


@pytest.mark.parametrize("preset", THEME_PRESETS)
def test_the_sidecar_records_the_shipped_theme(preset: str) -> None:
    """The assertion this file exists for.

    A theme edited without regenerating its thumbnail fails here. The alternative —
    letting it through and relying on the app's runtime check — means the failure
    surfaces to a consultant as a missing image rather than to a developer as a red
    build, and the fix (regenerate) is one command either way.
    """
    recorded = sidecar_for(preset)

    assert recorded is not None, f"themes/thumbnails/{preset}.json is unreadable"

    assert recorded.get("theme_sha256") == theme_digest(preset), (
        f"themes/thumbnails/{preset}.png was rendered from a different "
        f"{preset}.docx than the one committed. Regenerate with "
        f"`LANG=C.UTF-8 python -m reporting_agent.render.thumbnails --write`."
    )


@pytest.mark.parametrize("preset", THEME_PRESETS)
def test_the_sidecar_names_how_to_reproduce_it(preset: str) -> None:
    """What a reader needs when a thumbnail looks wrong is the command, not a version."""
    recorded = sidecar_for(preset)
    assert recorded is not None

    assert "thumbnails" in str(recorded.get("generated_by", ""))


def test_the_thumbnail_directory_holds_nothing_else() -> None:
    """Two files per preset and no others.

    A leftover `.png` for a preset that was removed would be served by the app — the
    public copy is a directory copy — and would be a picture of a theme that no longer
    exists offered as a choice.
    """
    expected = {f"{preset}.png" for preset in THEME_PRESETS} | {
        f"{preset}.json" for preset in THEME_PRESETS
    }

    assert {entry.name for entry in THUMBNAIL_DIR.iterdir()} == expected


def test_the_sample_definition_still_validates() -> None:
    issues = collect_definition_issues(SAMPLE_DEFINITION, mode="run")

    assert issues == [], (
        "the thumbnail sample definition no longer validates, so the next "
        f"regeneration would fail: {[issue.message for issue in issues]}"
    )


def test_the_sample_exercises_a_heading_prose_and_a_table() -> None:
    """Req 13.2's three, checked as block types rather than as pixels.

    A thumbnail whose sample lost its table would still render, still pass the digest
    check, and show a consultant nothing about the theme's table treatment.
    """
    types = {block["type"] for block in SAMPLE_DEFINITION["blocks"]}

    assert "heading" in types
    assert "rich_text" in types
    # `resource_table` renders its explicit no-resources row under a null context —
    # one row, in the theme's own table style. See the module docstring on what that
    # does and does not demonstrate.
    assert "resource_table" in types


@pytest.mark.parametrize("preset", THEME_PRESETS)
def test_the_theme_it_records_actually_exists(preset: str) -> None:
    assert theme_path(preset).exists()
