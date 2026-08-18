"""Real page images of the four themes, for the wizard's preset picker (Req 13.2).

Run as ``python -m reporting_agent.render.thumbnails --write``, mirroring
``render/themes.py``'s convention. The produced PNGs and their sidecars are **committed**
to the repository beside the themes and copied into ``app/public/theme-thumbnails/``;
nothing here runs at request time, in the runtime container, or during a report.

## Why a real render rather than a hand-drawn mockup

Requirement 13.2 requires the thumbnail to be "evidence of the theme the Docx_Renderer
emits against rather than decoration". A designed mockup drifts the first time a theme's
heading font changes and nothing notices — the consultant then picks a preset from a
picture of a document the renderer stopped producing months ago. So the chain here is the
**production** one, end to end:

    compile_document → render_document → convert_to_pdf → rasterize page 1

No branch of it is special-cased for a thumbnail. If a theme stops declaring a style the
compiler needs, this raises rather than emitting a picture of a fallback.

## The null context, and what it is for here

The sample page is compiled against a snapshot with **no resources and no gaps** —
`verify/allowlist.py#null_context_snapshot`, the same derivation the masking allowlist
uses. Requirement 13.2 requires the page to carry "no figure a snapshot did not produce",
and this is the strongest available form of that: not "we chose harmless numbers" but
"there were no numbers to choose". Every digit on the thumbnail is chrome the template
itself declares — a column header, a heading — and the assertion below holds it to that
by refusing to write an image whose ledger is non-empty.

### What that costs, stated rather than papered over

Requirement 13.2 asks the sample to exercise "a heading style, body prose and a data
table". The first two are unqualified successes. The table is **not**: every table this
product emits is a table of measurements, so under a null context the `resource_table`
renders the explicit "no resources matched this scope" row Requirement 3.7 declares —
one row, one column — rather than a populated grid.

The thumbnail therefore shows the theme's heading face and colour, its body face and
leading, and its table *chrome*: the header style, the header rule, the cell padding and
the caption. It does **not** show row banding across many rows, which is one of the
things `table_style` tunes.

Three alternatives were considered and rejected. Populating the table with invented rows
puts fabricated measurements on an image a consultant will read as a sample report —
which is the failure mode this whole product exists to prevent, and the one where a
number gets quoted back. Using `appendix_methodology` instead emits paragraphs rather
than a table under a null context, so it exercises the table styling not at all.
Exempting the thumbnail path from the null-context rule makes the image evidence of a
render nothing else performs.

A one-row table produced by the real renderer is weaker evidence than a full one and is
still *evidence*. An invented one is not.

## The rasterizer is a build-time dependency, deliberately not a runtime one

`pdftoppm` (poppler-utils) turns page 1 into a PNG. It is **not** in the runtime image and
must not be added to it: the images are committed artifacts, so the container that renders
customer reports has no reason to carry a rasterizer. A developer or CI runs this module
on a machine that has poppler; `tests/test_thumbnails.py` asserts the committed sidecars
still describe the shipped themes, which is the part that has to hold on every build.

## The sidecar, and what the app does with it

Each image is written with a `<preset>.json` carrying the SHA-256 of the theme document it
was rendered from. Requirement 13.8 has the picker treat an image as **unavailable** when
that digest differs from the theme currently shipped — so a theme edited without
regenerating its thumbnail produces a card that says the page image is unavailable, rather
than a card showing a picture of the previous theme. Stale evidence is worse than none.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any, Final

__all__ = [
    "SAMPLE_DEFINITION",
    "THUMBNAIL_DIR",
    "generate_all",
    "sidecar_for",
    "theme_digest",
    "thumbnail_paths",
]

_PACKAGE_PARENT: Final[Path] = Path(__file__).resolve().parent.parent.parent

THUMBNAIL_DIR: Final[Path] = _PACKAGE_PARENT.parent / "themes" / "thumbnails"
"""`agent/themes/thumbnails/`. Beside the themes, because the two are one artifact set:
a theme and the picture of it are only meaningful together."""

RASTER_WIDTH_PX: Final[int] = 720
"""Wide enough that Requirement 13.1's 240-CSS-pixel minimum is met at 3x, so the card
stays sharp on a high-density display. Not larger: four PNGs are committed to the
repository and reviewed in diffs."""

CONVERT_TIMEOUT_S: Final[float] = 120.0


# --- The sample page ------------------------------------------------------------------
#
# Requirement 13.2 requires the sample to exercise "a heading style, body prose and a data
# table of that theme" — the three things that actually differ between the four presets
# and the three a consultant is deciding between when they look at the grid. A cover page
# is deliberately absent: it is mostly whitespace and a title, so four cover pages look
# more alike than the themes are.

_SAMPLE_RESOURCE_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"

_SAMPLE_COLUMNS: Final[tuple[dict[str, Any], ...]] = (
    {"metric": "Percentage CPU", "statistic": "avg", "header": "CPU avg"},
    {"metric": "Percentage CPU", "statistic": "max", "header": "CPU peak"},
    {"metric": "Available Memory Bytes", "statistic": "avg", "header": "Memory avg"},
)

SAMPLE_DEFINITION: Final[dict[str, Any]] = {
    "schema_version": 1,
    "identity": {
        "name": "Theme sample",
        "report_title": "Infrastructure utilization",
        "description": "",
    },
    "scope": {
        "resource_types": ["Microsoft.Compute/virtualMachines"],
        "tag_filters": [],
        "resource_groups": [],
        "top_n": None,
        "sort": None,
    },
    "period": {"kind": "last_full_month"},
    "metrics": {
        "Microsoft.Compute/virtualMachines": [
            {"metric": "Percentage CPU", "statistic": "avg"},
            {"metric": "Percentage CPU", "statistic": "max"},
            {"metric": "Available Memory Bytes", "statistic": "avg"},
        ]
    },
    "blocks": [
        {
            "id": "sample-heading",
            "type": "heading",
            "config": {"level": 1, "text": "Utilization summary"},
        },
        {
            "id": "sample-prose",
            "type": "rich_text",
            "config": {
                "text": (
                    "Body prose in this theme's own paragraph style. The line length, "
                    "the leading and the face are all the theme's, so this paragraph "
                    "is what a narrative section will look like once it carries real "
                    "text. Nothing on this page came from a snapshot."
                )
            },
        },
        {
            "id": "sample-table",
            "type": "resource_table",
            "config": {
                "columns": list(_SAMPLE_COLUMNS),
                "caption": "Resources in scope",
            },
        },
        {
            "id": "sample-appendix",
            "type": "appendix_methodology",
            "config": {"caption": "How these figures are produced"},
        },
    ],
    "design": {
        "preset": "editorial",
        "accent_color": "#1f6f78",
        "density": "normal",
        "table_style": "hairline",
        "number_format": {"decimal_places": 2, "group_thousands": True},
        "cover_page": False,
        "logo": None,
        "page_size": "A4",
    },
}


def _sample_snapshot() -> dict[str, Any]:
    """The smallest snapshot the compiler accepts, emptied of every measurement.

    Built by the **production** `build_snapshot`, over zero resources, and then passed
    through `null_context_snapshot` anyway. Two steps that look redundant and are not:

    * `build_snapshot` is what makes the document a real one — every field the
      `SnapshotView` requires is present because the builder that writes real snapshots
      wrote it, rather than because this literal remembered it. A hand-written document
      here is a second declaration of the snapshot schema, and the first thing it does
      is fall behind.
    * `null_context_snapshot` is the same emptying the masking allowlist performs, so
      "no figure a snapshot did not produce" is enforced by the function that already
      defines what a null context is rather than by this module choosing to pass no
      resources.
    """
    from datetime import UTC, date, datetime
    from zoneinfo import ZoneInfo

    from reporting_agent.collect.buckets import resolve_window
    from reporting_agent.collect.snapshot import build_snapshot
    from reporting_agent.providers.base import ScopeSpec
    from reporting_agent.verify.allowlist import null_context_snapshot

    jakarta = ZoneInfo("Asia/Jakarta")

    return null_context_snapshot(
        build_snapshot(
            run_id="theme-thumbnail",
            scope=ScopeSpec(
                subscription_id="00000000-0000-0000-0000-000000000000",
                resource_types=[_SAMPLE_RESOURCE_TYPE],
                resource_groups=[],
                tag_filters={},
            ),
            scope_verified=True,
            collected_at=datetime(2026, 8, 1, 0, 0, tzinfo=UTC),
            timezone_name="Asia/Jakarta",
            tz=jakarta,
            window=resolve_window(date(2026, 7, 1), date(2026, 7, 31), jakarta),
            grain="PT1H",
            metrics_by_resource_type={
                _SAMPLE_RESOURCE_TYPE: [
                    "Percentage CPU",
                    "Available Memory Bytes",
                ]
            },
            resources=[],
            gaps=[],
            catalog_version="1.0.0",
            raw_archive_complete=True,
            raw_archive_object_count=0,
        )
    )


# --- Digests and paths ------------------------------------------------------------------


def theme_digest(preset: str) -> str:
    """SHA-256 of the theme document, 64 lowercase hex characters.

    Over the file's exact bytes, so a theme rebuilt to be visually identical but not
    byte-identical still invalidates its thumbnail. That is the strict reading and the
    right one: `tests/test_themes.py` already asserts each committed theme is
    byte-identical to a fresh build, so a differing digest means the theme genuinely
    changed.
    """
    from reporting_agent.render.themes import theme_path

    return hashlib.sha256(theme_path(preset).read_bytes()).hexdigest()


def thumbnail_paths(preset: str) -> tuple[Path, Path]:
    """The `(png, sidecar)` pair for `preset`."""
    return (
        THUMBNAIL_DIR / f"{preset}.png",
        THUMBNAIL_DIR / f"{preset}.json",
    )


def sidecar_for(preset: str) -> dict[str, Any] | None:
    """The recorded sidecar, or `None` when it is absent or unreadable.

    One outcome for absent, malformed and unparsable alike, matching
    `verify/charts.py#sidecar_digest`'s reasoning: Requirement 13.8 gives them one
    behaviour — the image is unavailable — so distinguishing them here would be a
    distinction no caller can act on.
    """
    _, sidecar = thumbnail_paths(preset)

    try:
        loaded = json.loads(sidecar.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None

    return loaded if isinstance(loaded, dict) else None


# --- Producing one image ------------------------------------------------------------


def _rasterize(pdf_bytes: bytes, destination: Path) -> None:
    """Page 1 of `pdf_bytes`, as a PNG at {@link RASTER_WIDTH_PX} wide.

    `-f 1 -l 1` bounds it to the first page, and `-png` picks the encoder. `pdftoppm`
    appends its own suffix to the output prefix, so the file is produced in a temporary
    directory and moved — naming it directly is not something the tool supports.
    """
    if shutil.which("pdftoppm") is None:
        raise RuntimeError(
            "pdftoppm is not on PATH. The thumbnails are committed artifacts generated "
            "by a developer or by CI, so poppler-utils is a build-time dependency and "
            "is deliberately absent from the runtime image — install it here rather "
            "than adding it to the Dockerfile."
        )

    with tempfile.TemporaryDirectory() as scratch:
        source = Path(scratch) / "page.pdf"
        source.write_bytes(pdf_bytes)

        # Fixed argv, no shell, and every path is one this function just created in
        # a temporary directory — there is no caller-supplied string in the list.
        subprocess.run(
            [
                "pdftoppm",
                "-png",
                "-f",
                "1",
                "-l",
                "1",
                "-scale-to-x",
                str(RASTER_WIDTH_PX),
                "-scale-to-y",
                "-1",
                str(source),
                str(Path(scratch) / "out"),
            ],
            check=True,
            capture_output=True,
            timeout=CONVERT_TIMEOUT_S,
        )

        produced = sorted(Path(scratch).glob("out*.png"))
        if not produced:
            raise RuntimeError("pdftoppm produced no page image")

        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(produced[0].read_bytes())


def _render_preset(preset: str) -> bytes:
    """The sample page for `preset`, as PDF bytes, through the production path.

    The ledger is asserted **empty** before conversion. That is Requirement 13.2's "carries
    no figure a snapshot did not produce", checked rather than assumed: a compiler change
    that started emitting a figure from an empty view would otherwise put a fabricated
    number on four thumbnails, and a number on a marketing image is exactly the kind of
    thing that gets quoted back.
    """
    from reporting_agent.compile.blocks import compile_document
    from reporting_agent.compile.blocks.base import DesignSettings
    from reporting_agent.compile.snapshot_view import build_snapshot_view
    from reporting_agent.render.docx import render_document
    from reporting_agent.render.pdf import convert_to_pdf

    definition = {**SAMPLE_DEFINITION, "design": {**SAMPLE_DEFINITION["design"], "preset": preset}}

    view = build_snapshot_view(_sample_snapshot())
    compiled = compile_document(
        definition,
        view=view,
        subscription_display_name="Sample subscription",
        prose=None,
        comparison_source=None,
        catalog_scales=None,
    )

    if compiled.ledger.entries:
        raise RuntimeError(
            f"the null-context render for {preset!r} produced "
            f"{len(compiled.ledger.entries)} figures; a theme thumbnail must carry no "
            f"figure a snapshot did not produce (Req 13.2)"
        )

    outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(definition["design"]),
        preview=False,
    )

    return convert_to_pdf(outcome.docx_bytes).pdf_bytes


def generate_all(*, destination: Path | None = None) -> list[str]:
    """Render every preset, write each PNG and its sidecar, and name what was written."""
    from reporting_agent.render.themes import THEME_PRESETS

    directory = destination if destination is not None else THUMBNAIL_DIR
    directory.mkdir(parents=True, exist_ok=True)

    written: list[str] = []

    for preset in THEME_PRESETS:
        pdf_bytes = _render_preset(preset)

        png = directory / f"{preset}.png"
        _rasterize(pdf_bytes, png)

        sidecar = directory / f"{preset}.json"
        sidecar.write_text(
            json.dumps(
                {
                    "theme_sha256": theme_digest(preset),
                    # Named rather than versioned: what a reader needs when a thumbnail
                    # looks wrong is the command that reproduces it.
                    "generated_by": "python -m reporting_agent.render.thumbnails --write",
                },
                indent=2,
                sort_keys=True,
            )
            + "\n",
            encoding="utf-8",
        )

        written.extend([png.name, sidecar.name])

    return written


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--write",
        action="store_true",
        help="render every preset and overwrite the committed images and sidecars",
    )
    args = parser.parse_args(argv)

    if not args.write:
        parser.error("nothing to do without --write")

    for name in generate_all():
        print(f"wrote themes/thumbnails/{name}")

    return 0


if __name__ == "__main__":  # pragma: no cover - the CLI entry point
    sys.exit(main())
