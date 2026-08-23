"""The four styles-only theme documents: their specification, their builder, and their guard.

`agent/themes/{editorial,corporate,technical,minimal}.docx` are **stylesheets that happen to
be `.docx`** (Req 8.1). Each carries Word paragraph, character and table styles and **zero
content**. `render/docx.py` opens one as its base and applies styles by name; a theme missing
a name the compiled blocks reference is a terminal `RENDER_FAILED` (Req 8.6) and, before that,
a failed image build (Req 8.7).

## Why this module holds the specification as well as the loader

Req 8.1 requires the four documents to be tracked in the repository as source files and
changed only through the same review path as code. A `.docx` is a zip of XML: committing four
binaries and calling them reviewed would be a fiction. So the **reviewable source is
:data:`THEME_SPECS`** — a face, a palette and a scale per preset — and the binaries are built
from it by ``python -m reporting_agent.render.themes --write``.

That places the spec and the guard in one module, which raises a fair objection: a guard that
checks a generated file against the spec it was generated from proves nothing. Two things
answer it, and the split matters:

* :func:`collect_theme_violations` reads the **files on disk** through `python-docx` and
  asserts the properties Req 8.2-8.5 and 8.8 name — `Figure` present, the full referenced
  union present, zero non-whitespace text, exactly four openable files. Those assertions never
  consult :data:`THEME_SPECS`. They would catch a corrupt commit, a hand-edit in Word that
  dropped a style, or a Git LFS pointer checked out in place of the real bytes.
* `tests/test_themes.py` separately asserts each committed file is **byte-identical** to a
  fresh build, which is what makes the spec authoritative rather than decorative. Edit the
  spec without regenerating and that test fails; regenerate without reviewing the spec diff
  and the review path has still seen the change.

## Why the union is imported rather than restated

`compile/blocks/base.py` declares `PARAGRAPH_STYLES` and `TABLE_STYLES` precisely so this
guard can read them as data (its docstring says so). Restating them here would be the drift
that declaration exists to prevent: a block module could start emitting `Heading 5` and four
themes would keep passing a guard that had never heard of it.

Seven names are added here because no compile-stage constant declares them, and every one is
genuinely this module's to own. Two are the renderer's:

* **`Figure`**, a *character* style. `compile/` has no concept of it — a `Figure` node carries
  no style name, because every figure takes the same one. It is `render/docx.py` that wraps
  each figure in it (Req 20.3), and the Token_Extractor's ability to find figures without
  re-parsing prose depends on that wrapping, which is why Req 8.2 makes it the first
  assertion.
* **`PreviewNotice`**, a paragraph style used only when the renderer runs in preview mode, so
  a "Render real preview" artifact says what it is after it leaves the app.

The other five are the **front matter's** — `Cover Title`, `Cover Meta`, `Document Control`,
`Toc Entry` and `Table Signature`. The front matter is fixed rather than composed and accepts
no block, so no block type will ever reference one of these names and there is no
compile-stage constant for them to live in. See :data:`FRONT_MATTER_PARAGRAPH_STYLES` and
:data:`SIGNATURE_TABLE_STYLE`.

## The trap that makes a style lookup fail at render time

`python-docx` translates a handful of UI style names to the lowercase internal names Word
actually stores: `BabelFish.ui2internal("Heading 1") == "heading 1"`, and the same for
`Caption`, `Header` and `Footer`. A `w:name` of `"Heading 1"` therefore makes
`document.styles["Heading 1"]` raise `KeyError` — at render time, on a correct definition,
with a message about a style the file plainly contains.

:data:`_INTERNAL_NAMES` carries that mapping, and the guard looks every style up **the way
the renderer will**, through `document.styles[...]`, rather than by scanning `w:name`
attributes. A guard that read the XML directly would pass a document the renderer cannot use.
"""

from __future__ import annotations

import os
import re
import zipfile
from collections.abc import Iterator, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import docx
from docx.document import Document
from docx.opc.constants import CONTENT_TYPE as CT
from docx.oxml.ns import qn

from reporting_agent.compile.blocks.base import PARAGRAPH_STYLES, TABLE_STYLES
from reporting_agent.compile.definition import DESIGN_PRESETS
from reporting_agent.errors import RenderFailedError

__all__ = [
    "COVER_META_STYLE",
    "COVER_TITLE_STYLE",
    "DOCUMENT_CONTROL_STYLE",
    "FIGURE_CHARACTER_STYLE",
    "FRONT_MATTER_PARAGRAPH_STYLES",
    "PREVIEW_NOTICE_STYLE",
    "REQUIRED_CHARACTER_STYLES",
    "REQUIRED_PARAGRAPH_STYLES",
    "REQUIRED_STYLE_NAMES",
    "REQUIRED_TABLE_STYLES",
    "SIGNATURE_ROW_HEIGHT_TWIPS",
    "SIGNATURE_TABLE_STYLE",
    "THEME_FILENAMES",
    "THEME_PRESETS",
    "THEME_SPECS",
    "TOC_ENTRY_STYLE",
    "ThemeSpec",
    "assert_theme_available",
    "assert_themes_usable",
    "build_theme_bytes",
    "collect_theme_violations",
    "load_theme",
    "missing_styles",
    "non_whitespace_text",
    "theme_directory",
    "theme_filename",
    "theme_path",
    "write_theme_documents",
]


# --------------------------------------------------------------------------- #
# What every theme must declare
# --------------------------------------------------------------------------- #

FIGURE_CHARACTER_STYLE: Final[str] = "Figure"
"""Req 8.2, 20.3. Every figure is one run in this character style, at every position the AST
places one, and the Token_Extractor finds figures by that wrapping."""

PREVIEW_NOTICE_STYLE: Final[str] = "PreviewNotice"
"""The preview-mode page notice, so a rendered preview says what it is once it has left the
app."""

COVER_TITLE_STYLE: Final[str] = "Cover Title"
COVER_META_STYLE: Final[str] = "Cover Meta"
DOCUMENT_CONTROL_STYLE: Final[str] = "Document Control"
TOC_ENTRY_STYLE: Final[str] = "Toc Entry"

FRONT_MATTER_PARAGRAPH_STYLES: Final[tuple[str, ...]] = (
    COVER_TITLE_STYLE,
    COVER_META_STYLE,
    DOCUMENT_CONTROL_STYLE,
    TOC_ENTRY_STYLE,
)
"""The front matter's four paragraph styles (breadth criteria 13.4, 13.5, 14.6).

Declared **here** rather than in `compile/blocks/base.py` for the same reason `Figure` and
`PreviewNotice` are: front matter is not composable and carries no block, so no block type
references any of these names and the compile-stage declaration has nothing to say about
them. Requirement 13.2 makes that permanent — the front matter accepts no block at all.

* **`Cover Title`** and **`Cover Meta`** — the report title and the customer / period /
  contact lines of the cover (13.4). A cover set in `Title` and `Subtitle` would tie the
  cover's scale to a content heading's, and the two are different typographic jobs.
* **`Document Control`** — the label lines of the document control page: document name,
  document number, confidentiality notice (13.5).
* **`Toc Entry`** — one contents entry, carrying the right-aligned dotted tab the page number
  sits on. The tab stop belongs to the theme rather than to the emitter, so a table of
  contents cannot be laid out by inline formatting the four themes disagree about.
"""

SIGNATURE_TABLE_STYLE: Final[str] = "Table Signature"
"""The approvers table (breadth criterion 13.6).

Its own style rather than one of the three `design.table_style` choices, because it is the
one table whose row height is load-bearing: where no signature image is supplied, the
renderer emits an **empty ruled box at the height the theme declares**, and "the height the
theme declares" has to be somewhere. It is `w:trHeight` on this style.
"""

REQUIRED_CHARACTER_STYLES: Final[tuple[str, ...]] = (FIGURE_CHARACTER_STYLE,)

REQUIRED_PARAGRAPH_STYLES: Final[tuple[str, ...]] = (
    *PARAGRAPH_STYLES,
    PREVIEW_NOTICE_STYLE,
    *FRONT_MATTER_PARAGRAPH_STYLES,
)
"""Every paragraph style the declared block types reference, plus the preview notice and the
four front-matter styles.

`PARAGRAPH_STYLES` is imported rather than restated — see the module docstring."""

REQUIRED_TABLE_STYLES: Final[tuple[str, ...]] = (*TABLE_STYLES, SIGNATURE_TABLE_STYLE)

REQUIRED_STYLE_NAMES: Final[tuple[str, ...]] = (
    *REQUIRED_CHARACTER_STYLES,
    *REQUIRED_PARAGRAPH_STYLES,
    *REQUIRED_TABLE_STYLES,
)
"""The union Req 8.3 defines, in a fixed order so a failure message reads the same every run."""

THEME_PRESETS: Final[tuple[str, ...]] = DESIGN_PRESETS
"""The four preset names, imported from the validator that constrains a definition to them, so
a fifth preset cannot appear here without appearing there (Req 7.1, 8.1)."""

THEME_FILENAMES: Final[tuple[str, ...]] = tuple(f"{preset}.docx" for preset in THEME_PRESETS)

THEME_DIR_ENV: Final[str] = "RPT_THEME_DIR"
"""An explicit override, so a test can point the loader at a directory it built itself without
reaching into module state."""


# --------------------------------------------------------------------------- #
# The specification — the reviewable source of the four binaries
# --------------------------------------------------------------------------- #


@dataclass(frozen=True, slots=True)
class Face:
    """The three type faces one theme uses.

    Every name here is a font the image installs (`fonts-liberation2`,
    `fonts-dejavu-core`) — see the Dockerfile. A theme naming a font the container lacks
    renders through LibreOffice's substitution, which changes line breaking and therefore
    pagination, so the font list and this spec are one decision in two files.
    """

    heading: str
    body: str
    figure: str


@dataclass(frozen=True, slots=True)
class Palette:
    """One theme's ink, in `RRGGBB`.

    Deliberately narrow: an accent, a body ink, a muted ink and two table tones. A document
    that needs a third accent is a document whose hierarchy is not carrying its weight.
    """

    accent: str
    ink: str
    muted: str
    rule: str
    band: str


@dataclass(frozen=True, slots=True)
class ThemeSpec:
    """One preset, completely.

    Sizes are in **points** here and converted to OOXML half-points at build time, because a
    spec a reviewer reads should carry the unit a designer thinks in.
    """

    preset: str
    face: Face
    palette: Palette
    title_pt: float
    subtitle_pt: float
    heading_pt: tuple[float, float, float, float]
    body_pt: float
    small_pt: float
    line_spacing: float
    heading_all_caps: bool = False
    """`technical` and `minimal` set their deepest headings in small tracked capitals rather
    than reaching for a fifth size."""

    banded_rows: bool = True

    def __post_init__(self) -> None:
        if self.preset not in THEME_PRESETS:
            raise ValueError(f"{self.preset!r} is not one of {THEME_PRESETS}")
        if len(self.heading_pt) != 4:
            raise ValueError(f"{self.preset!r} declares {len(self.heading_pt)} heading sizes, not 4")


_EDITORIAL: Final[ThemeSpec] = ThemeSpec(
    preset="editorial",
    # The one serif of the four, and scoped deliberately to the *document*. `design-system.md`
    # rules out a serif in the app's chrome; a delivered report is a paginated print medium
    # where a serif reading face is an ordinary, and here distinguishing, choice.
    face=Face(heading="Liberation Serif", body="Liberation Serif", figure="DejaVu Sans Mono"),
    palette=Palette(accent="0F6470", ink="1A1A1A", muted="5A6B70", rule="C9D4D7", band="F2F6F7"),
    title_pt=26,
    subtitle_pt=13,
    heading_pt=(16, 13, 11.5, 10.5),
    body_pt=11,
    small_pt=9,
    line_spacing=1.28,
)

_CORPORATE: Final[ThemeSpec] = ThemeSpec(
    preset="corporate",
    face=Face(heading="Liberation Sans", body="Liberation Sans", figure="DejaVu Sans Mono"),
    palette=Palette(accent="1F3A5F", ink="1C1C1C", muted="5B6B7C", rule="C8D2DC", band="EEF2F6"),
    title_pt=24,
    subtitle_pt=12,
    heading_pt=(15, 12.5, 11, 10),
    body_pt=10.5,
    small_pt=8.5,
    line_spacing=1.22,
)

_TECHNICAL: Final[ThemeSpec] = ThemeSpec(
    preset="technical",
    face=Face(heading="DejaVu Sans", body="DejaVu Sans", figure="DejaVu Sans Mono"),
    palette=Palette(accent="33556B", ink="202325", muted="5E6B72", rule="B9C4CA", band="EDF1F3"),
    title_pt=22,
    subtitle_pt=11.5,
    heading_pt=(14, 12, 10.5, 9.5),
    body_pt=10,
    small_pt=8.5,
    line_spacing=1.18,
    heading_all_caps=True,
)

_MINIMAL: Final[ThemeSpec] = ThemeSpec(
    preset="minimal",
    face=Face(heading="Liberation Sans", body="Liberation Sans", figure="DejaVu Sans Mono"),
    palette=Palette(accent="1A1A1A", ink="1A1A1A", muted="6B6B6B", rule="DCDCDC", band="F6F6F6"),
    title_pt=23,
    subtitle_pt=11.5,
    heading_pt=(14, 12, 10.5, 10),
    body_pt=10.5,
    small_pt=9,
    line_spacing=1.30,
    heading_all_caps=True,
    # Minimal earns its name by not banding: the hairline carries the row separation.
    banded_rows=False,
)

THEME_SPECS: Final[Mapping[str, ThemeSpec]] = {
    spec.preset: spec for spec in (_EDITORIAL, _CORPORATE, _TECHNICAL, _MINIMAL)
}

assert tuple(THEME_SPECS) == THEME_PRESETS, (
    f"THEME_SPECS declares {tuple(THEME_SPECS)}; the validator permits {THEME_PRESETS}. "
    f"A preset without a spec is a preset with no theme document."
)


# --------------------------------------------------------------------------- #
# Locating the directory
# --------------------------------------------------------------------------- #

_PACKAGE_PARENT: Final[Path] = Path(__file__).resolve().parent.parent.parent


def theme_directory() -> Path:
    """Where the four documents live, in the image and in the checkout.

    The two layouts differ and neither is wrong: the Dockerfile copies `src/reporting_agent/`
    to `/app/reporting_agent/` and `themes/` to `/app/themes/`, so the directory is the
    package's parent; in a checkout the package sits under `agent/src/`, so it is the parent's
    parent.

    Resolved from the **checkout marker** rather than from whichever candidate happens to
    exist. Probing for an existing `themes/` looks equivalent and is not: it makes the answer
    depend on the directory the caller is about to create, so `--write` bootstrapping an absent
    directory would resolve to the image layout and deposit four documents in `agent/src/`.
    """
    override = os.environ.get(THEME_DIR_ENV)
    if override:
        return Path(override)

    checkout_root = _PACKAGE_PARENT.parent
    if (checkout_root / "pyproject.toml").is_file():
        return checkout_root / "themes"
    return _PACKAGE_PARENT / "themes"


def theme_filename(preset: str) -> str:
    return f"{preset}.docx"


def theme_path(preset: str) -> Path:
    """The document for `preset`, without asserting it exists."""
    return theme_directory() / theme_filename(preset)


# --------------------------------------------------------------------------- #
# Reading a theme: the loader and the two assertions
# --------------------------------------------------------------------------- #


def _declared_names(document: Document) -> frozenset[str]:
    """Every style name `document` declares, as `python-docx` resolves them.

    Read through `document.styles` rather than off the XML, so the guard agrees with the
    renderer about what a name means — see the module docstring on `BabelFish`.
    """
    return frozenset(style.name for style in document.styles if style.name)


def missing_styles(document: Document, *, required: Sequence[str] = REQUIRED_STYLE_NAMES) -> tuple[str, ...]:
    """The names in `required` that `document` does not declare, in `required`'s order."""
    declared = _declared_names(document)
    return tuple(name for name in required if name not in declared)


def non_whitespace_text(document: Document) -> str:
    """Every non-whitespace character in the body, the headers and the footers (Req 8.5).

    Returns the offending characters rather than a boolean so a failure can quote what it
    found: "declares 14 non-whitespace characters" sends a reviewer looking, `'Lorem ipsum'`
    tells them what happened.

    Header and footer parts are read **off the package** rather than through
    `document.sections[...].header`, because that property materializes a header part for a
    section that has none — the guard would then be inspecting a part it had just created.
    """
    found: list[str] = []
    for element in _text_bearing_elements(document):
        for node in element.iter(qn("w:t")):
            if node.text:
                found.append(node.text)
    return "".join("".join(found).split())


def _text_bearing_elements(document: Document) -> Iterator[object]:
    """The body, then every header and footer part in the package."""
    yield document.element.body
    for part in document.part.package.iter_parts():
        if part.content_type in (CT.WML_HEADER, CT.WML_FOOTER):
            yield part.element


def load_theme(preset: str) -> Document:
    """Open `preset`'s theme and assert it carries every referenced style (Req 7.7, 8.6).

    Raises :class:`RenderFailedError` — terminal `RENDER_FAILED` — naming the theme and
    **every** missing style rather than the first, so one fix pass clears the render rather
    than one round trip per style.
    """
    path = theme_path(preset)
    if preset not in THEME_PRESETS:
        raise RenderFailedError(
            f"style preset {preset!r} names no theme document; the four presets are "
            f"{', '.join(THEME_PRESETS)}"
        )
    if not path.is_file():
        raise RenderFailedError(
            f"theme document {theme_filename(preset)!r} is absent from {path.parent}; the "
            f"image must carry all four of {', '.join(THEME_FILENAMES)}"
        )

    try:
        document = docx.Document(str(path))
    except Exception as error:
        raise RenderFailedError(
            f"theme document {theme_filename(preset)!r} could not be opened as a document "
            f"package: {type(error).__name__}: {error}"
        ) from error

    absent = missing_styles(document)
    if absent:
        raise RenderFailedError(
            f"theme document {theme_filename(preset)!r} is missing "
            f"{len(absent)} referenced style(s): {', '.join(absent)}"
        )
    return document


def assert_theme_available(preset: str) -> None:
    """Req 8.9 — the pre-collection preflight.

    Asserted when a run is claimed, **before any Azure call**, so a theme that cannot render
    the document fails the run in milliseconds rather than after minutes of inventory and
    metrics work. Deliberately the full style assertion and not only `Figure`: the whole check
    is one file open, so there is nothing to be gained by checking less of it.
    """
    load_theme(preset)


# --------------------------------------------------------------------------- #
# The Theme_Guard — every violation across all four documents, in one run
# --------------------------------------------------------------------------- #

DIRECTORY_VIOLATION: Final[str] = "directory"
UNOPENABLE_VIOLATION: Final[str] = "unopenable"
MISSING_STYLE_VIOLATION: Final[str] = "missing-style"
CONTENT_VIOLATION: Final[str] = "content"
VIOLATION_KINDS: Final[tuple[str, ...]] = (
    DIRECTORY_VIOLATION,
    UNOPENABLE_VIOLATION,
    MISSING_STYLE_VIOLATION,
    CONTENT_VIOLATION,
)
"""Req 8.8 requires an unopenable file to be reported **distinctly** from a missing style, so
each violation carries its kind as a prefix rather than leaving a reader to infer it from
wording."""


def collect_theme_violations(directory: Path | None = None) -> list[str]:
    """Every Req 8.2-8.5 and 8.8 violation across all four documents, not the first.

    One run has to clear a build (Req 8.4), so a single missing style must not hide the other
    eleven. Each returned line is prefixed with one of :data:`VIOLATION_KINDS`.

    Note what is *not* short-circuited: a document that fails to open still lets the other
    three be checked, and a document missing a style is still checked for stray content.
    """
    root = theme_directory() if directory is None else directory
    violations: list[str] = []

    if not root.is_dir():
        return [f"{DIRECTORY_VIOLATION}: {root} is not a directory"]

    present = sorted(entry.name for entry in root.iterdir() if entry.is_file())
    expected = sorted(THEME_FILENAMES)
    if present != expected:
        for unexpected in sorted(set(present) - set(expected)):
            violations.append(
                f"{DIRECTORY_VIOLATION}: {root / unexpected} is not one of the four required "
                f"theme documents"
            )
        for absent in sorted(set(expected) - set(present)):
            violations.append(f"{DIRECTORY_VIOLATION}: {root / absent} is missing")

    for preset in THEME_PRESETS:
        path = root / theme_filename(preset)
        if not path.is_file():
            continue  # already reported as a directory violation

        try:
            document = docx.Document(str(path))
        except Exception as error:
            violations.append(
                f"{UNOPENABLE_VIOLATION}: {path.name} could not be opened as a document "
                f"package: {type(error).__name__}: {error}"
            )
            continue

        for name in missing_styles(document):
            violations.append(f"{MISSING_STYLE_VIOLATION}: {path.name} does not declare {name!r}")

        stray = non_whitespace_text(document)
        if stray:
            violations.append(
                f"{CONTENT_VIOLATION}: {path.name} carries {len(stray)} non-whitespace text "
                f"character(s) in its body, headers or footers: {stray[:80]!r}"
            )

    return violations


def assert_themes_usable(directory: Path | None = None) -> None:
    """Raise :class:`RenderFailedError` listing every theme violation, or return silently.

    Called by `tests/test_themes.py` and by the image build
    (`python -m reporting_agent.render.themes --assert-build`), so an image cannot carry a
    theme missing a style the compiled blocks reference (Req 8.7).
    """
    violations = collect_theme_violations(directory)
    if violations:
        raise RenderFailedError(
            f"the four theme documents in {theme_directory() if directory is None else directory} "
            f"are not usable:\n  " + "\n  ".join(violations)
        )


# --------------------------------------------------------------------------- #
# Building the documents
# --------------------------------------------------------------------------- #

_INTERNAL_NAMES: Final[Mapping[str, str]] = {
    "Heading 1": "heading 1",
    "Heading 2": "heading 2",
    "Heading 3": "heading 3",
    "Heading 4": "heading 4",
    "Caption": "caption",
}
"""`python-docx`'s `BabelFish` aliases, for the names this module writes.

The full alias table also covers `Header`, `Footer` and `Heading 5`-`Heading 9`, none of which
any declared block type references. A name absent from this mapping is written as-is."""

_STYLE_IDS: Final[Mapping[str, str]] = {
    "Normal": "Normal",
    "Default Paragraph Font": "DefaultParagraphFont",
    "Normal Table": "NormalTable",
    "Title": "Title",
    "Subtitle": "Subtitle",
    "Heading 1": "Heading1",
    "Heading 2": "Heading2",
    "Heading 3": "Heading3",
    "Heading 4": "Heading4",
    "Body Text": "BodyText",
    "Caption": "Caption",
    "Notice": "Notice",
    "PreviewNotice": "PreviewNotice",
    "Cover Title": "CoverTitle",
    "Cover Meta": "CoverMeta",
    "Document Control": "DocumentControl",
    "Toc Entry": "TocEntry",
    "Figure": "Figure",
    "Table Hairline": "TableHairline",
    "Table Banded": "TableBanded",
    "Table Bordered": "TableBordered",
    "Table Signature": "TableSignature",
    "Layout Table": "LayoutTable",
}
"""`w:styleId` per style name. Ids carry no space; names do."""

_FIXED_TIMESTAMP: Final[str] = "2026-01-01T00:00:00Z"
"""One sentinel for `docProps/core.xml`, so two builds of one spec produce one byte sequence.

The same reasoning as `render/docx.py`'s determinism requirement (Req 20.8): a timestamp is
the one thing a document writer reaches for that makes byte equality impossible."""

_ZIP_TIMESTAMP: Final[tuple[int, int, int, int, int, int]] = (1980, 1, 1, 0, 0, 0)
"""The zip epoch. `ZipInfo` defaults to the wall clock, which would make every build differ."""

_A4_WIDTH_TWIPS: Final[int] = 11906
_A4_HEIGHT_TWIPS: Final[int] = 16838
_MARGIN_TWIPS: Final[int] = 1134  # 2 cm

SIGNATURE_ROW_HEIGHT_TWIPS: Final[int] = 907  # 1.6 cm
"""The minimum height of an approvers-table row, and therefore of an unsigned signature box.

`w:hRule="atLeast"`, so a supplied signature image taller than this grows the row rather than
being clipped."""

_CONTENT_WIDTH_TWIPS: Final[int] = _A4_WIDTH_TWIPS - 2 * _MARGIN_TWIPS
"""Where `Toc Entry`'s right tab sits: the right text edge of the default section.

A template asking for Letter narrows the page and the emitter overrides the section geometry;
the tab is then slightly past the text edge rather than at it, which Word and LibreOffice both
resolve to the margin. A theme cannot hold two page geometries, and a contents entry whose
leader stops short reads worse than one whose stop is nominal."""

_W_NS: Final[str] = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"


def _half_points(points: float) -> int:
    """OOXML sizes are in half-points, and the value must be an integer.

    `round` rather than `int`: 11.5pt is 23 half-points exactly, and truncation would quietly
    render a 10.5pt body at 10pt.
    """
    return round(points * 2)


def _twentieths(points: float) -> int:
    """Spacing is in twentieths of a point."""
    return round(points * 20)


def _line_rule(spec: ThemeSpec, points: float) -> str:
    return (
        f'<w:spacing w:line="{_twentieths(points * spec.line_spacing)}" w:lineRule="auto"'
        f' w:before="0" w:after="{_twentieths(points * 0.45)}"/>'
    )


def _run_props(
    *,
    font: str,
    size_pt: float,
    color: str,
    bold: bool = False,
    italic: bool = False,
    caps: bool = False,
    spacing_twips: int | None = None,
) -> str:
    parts = [f'<w:rFonts w:ascii="{font}" w:hAnsi="{font}" w:cs="{font}" w:eastAsia="{font}"/>']
    if bold:
        parts.append("<w:b/>")
    if italic:
        parts.append("<w:i/>")
    if caps:
        parts.append("<w:caps/>")
    if spacing_twips is not None:
        parts.append(f'<w:spacing w:val="{spacing_twips}"/>')
    parts.append(f'<w:color w:val="{color}"/>')
    parts.append(f'<w:sz w:val="{_half_points(size_pt)}"/>')
    parts.append(f'<w:szCs w:val="{_half_points(size_pt)}"/>')
    return "<w:rPr>" + "".join(parts) + "</w:rPr>"


def _paragraph_style(
    name: str,
    spec: ThemeSpec,
    *,
    based_on: str | None = "Normal",
    next_style: str | None = "Body Text",
    size_pt: float,
    color: str,
    font: str,
    bold: bool = False,
    italic: bool = False,
    caps: bool = False,
    space_before_pt: float = 0.0,
    space_after_pt: float = 4.0,
    keep_next: bool = False,
    outline_level: int | None = None,
    border_bottom: str | None = None,
    right_tab_twips: int | None = None,
) -> str:
    paragraph_parts: list[str] = []
    if keep_next:
        paragraph_parts.append("<w:keepNext/><w:keepLines/>")
    if right_tab_twips is not None:
        # A right tab with a dot leader — the page-number column of a contents entry. It
        # belongs to the theme rather than to the emitter, so the four themes cannot lay a
        # table of contents out four different ways.
        paragraph_parts.append(
            f'<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="{right_tab_twips}"/></w:tabs>'
        )
    paragraph_parts.append(
        f'<w:spacing w:before="{_twentieths(space_before_pt)}"'
        f' w:after="{_twentieths(space_after_pt)}"'
        f' w:line="{_twentieths(size_pt * spec.line_spacing)}" w:lineRule="auto"/>'
    )
    if border_bottom:
        paragraph_parts.append(
            f'<w:pBdr><w:bottom w:val="single" w:sz="4" w:space="3" w:color="{border_bottom}"/>'
            f"</w:pBdr>"
        )
    if outline_level is not None:
        paragraph_parts.append(f'<w:outlineLvl w:val="{outline_level}"/>')

    lines = [f'<w:style w:type="paragraph" w:styleId="{_STYLE_IDS[name]}">']
    lines.append(f'<w:name w:val="{_INTERNAL_NAMES.get(name, name)}"/>')
    if based_on is not None:
        lines.append(f'<w:basedOn w:val="{_STYLE_IDS[based_on]}"/>')
    if next_style is not None:
        lines.append(f'<w:next w:val="{_STYLE_IDS[next_style]}"/>')
    lines.append("<w:qFormat/>")
    lines.append("<w:pPr>" + "".join(paragraph_parts) + "</w:pPr>")
    lines.append(
        _run_props(
            font=font,
            size_pt=size_pt,
            color=color,
            bold=bold,
            italic=italic,
            caps=caps,
            spacing_twips=8 if caps else None,
        )
    )
    lines.append("</w:style>")
    return "".join(lines)


def _borders(*, edges: Mapping[str, tuple[str, int, str]]) -> str:
    """A `w:tblBorders` element. Each edge maps to `(style, eighth-points, colour)`."""
    ordered = ("top", "left", "bottom", "right", "insideH", "insideV")
    parts = []
    for edge in ordered:
        if edge not in edges:
            continue
        style, size, color = edges[edge]
        parts.append(f'<w:{edge} w:val="{style}" w:sz="{size}" w:space="0" w:color="{color}"/>')
    return "<w:tblBorders>" + "".join(parts) + "</w:tblBorders>"


def _cell_margins(*, vertical: int, horizontal: int) -> str:
    return (
        f'<w:tblCellMar><w:top w:w="{vertical}" w:type="dxa"/>'
        f'<w:left w:w="{horizontal}" w:type="dxa"/>'
        f'<w:bottom w:w="{vertical}" w:type="dxa"/>'
        f'<w:right w:w="{horizontal}" w:type="dxa"/></w:tblCellMar>'
    )


def _table_style(name: str, spec: ThemeSpec, *, body: str) -> str:
    return (
        f'<w:style w:type="table" w:styleId="{_STYLE_IDS[name]}">'
        f'<w:name w:val="{_INTERNAL_NAMES.get(name, name)}"/>'
        f'<w:basedOn w:val="{_STYLE_IDS["Normal Table"]}"/>'
        f"<w:qFormat/>"
        f"{body}"
        f"</w:style>"
    )


def _header_row_props(spec: ThemeSpec, *, underline: bool) -> str:
    """The first row of a data table: the header, which the verifier resolves columns by."""
    tc_parts = []
    if underline:
        tc_parts.append(
            f'<w:tcBorders><w:bottom w:val="single" w:sz="8" w:space="0" '
            f'w:color="{spec.palette.accent}"/></w:tcBorders>'
        )
    tc = f"<w:tcPr>{''.join(tc_parts)}</w:tcPr>" if tc_parts else ""
    return (
        f'<w:tblStylePr w:type="firstRow">'
        f'<w:pPr><w:keepNext/><w:spacing w:before="0" w:after="0"/></w:pPr>'
        f"{_run_props(font=spec.face.heading, size_pt=spec.small_pt, color=spec.palette.accent, bold=True, caps=True)}"
        f"{tc}"
        f"</w:tblStylePr>"
    )


def _data_table_styles(spec: ThemeSpec) -> str:
    """The three `design.table_style` choices.

    All three exist in **every** theme, because the preset chooses the file and
    `design.table_style` chooses the style inside it — the two settings are orthogonal
    (`DesignSettings.table_style_name`). A theme defining only its "own" look would fail the
    moment a template paired `technical` with `bordered`.
    """
    common_run = _run_props(
        font=spec.face.body, size_pt=spec.small_pt, color=spec.palette.ink
    )
    common_pPr = '<w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>'

    hairline = _table_style(
        "Table Hairline",
        spec,
        body=(
            f"{common_pPr}{common_run}"
            f"<w:tblPr>"
            f"{_borders(edges={'bottom': ('single', 4, spec.palette.rule), 'insideH': ('single', 2, spec.palette.rule)})}"
            f"{_cell_margins(vertical=60, horizontal=100)}"
            f"</w:tblPr>"
            f"{_header_row_props(spec, underline=True)}"
        ),
    )

    banded_body = (
        f"{common_pPr}{common_run}"
        f"<w:tblPr>"
        f'<w:tblStyleRowBandSize w:val="1"/>'
        f"{_borders(edges={'bottom': ('single', 4, spec.palette.rule)})}"
        f"{_cell_margins(vertical=60, horizontal=100)}"
        f"</w:tblPr>"
        f"{_header_row_props(spec, underline=True)}"
    )
    if spec.banded_rows:
        banded_body += (
            f'<w:tblStylePr w:type="band1Horz"><w:tcPr>'
            f'<w:shd w:val="clear" w:color="auto" w:fill="{spec.palette.band}"/>'
            f"</w:tcPr></w:tblStylePr>"
        )
    banded = _table_style("Table Banded", spec, body=banded_body)

    every_edge = ("single", 4, spec.palette.rule)
    bordered = _table_style(
        "Table Bordered",
        spec,
        body=(
            f"{common_pPr}{common_run}"
            f"<w:tblPr>"
            f"{_borders(edges=dict.fromkeys(('top', 'left', 'bottom', 'right', 'insideH', 'insideV'), every_edge))}"
            f"{_cell_margins(vertical=60, horizontal=100)}"
            f"</w:tblPr>"
            f"{_header_row_props(spec, underline=False)}"
        ),
    )

    # Breadth 13.6 — the approvers table. Not one of the three `design.table_style` choices,
    # because it is the one table whose **row height** is part of the contract: where the
    # definition supplies no signature image for a role, the renderer emits an empty ruled box
    # "at the height the theme declares for that cell", and this `w:trHeight` is that
    # declaration. A signature box sized to its content would collapse to a line of nothing.
    signature = _table_style(
        "Table Signature",
        spec,
        body=(
            f"{common_pPr}{common_run}"
            f"<w:tblPr>"
            f"{_borders(edges=dict.fromkeys(('top', 'left', 'bottom', 'right', 'insideH', 'insideV'), ('single', 4, spec.palette.rule)))}"
            f"{_cell_margins(vertical=80, horizontal=100)}"
            f"</w:tblPr>"
            f'<w:trPr><w:trHeight w:val="{SIGNATURE_ROW_HEIGHT_TWIPS}" w:hRule="atLeast"/></w:trPr>'
            f"{_header_row_props(spec, underline=False)}"
        ),
    )

    # Req 15.9 / 21.2 — a `row` block's container. Borderless on every edge, and it carries no
    # header-row conditional formatting because a layout table has no header row: the verifier
    # excludes it by the absence of a `w:tblCaption`, and its *appearance* must not suggest a
    # data table to a reader either.
    layout = _table_style(
        "Layout Table",
        spec,
        body=(
            f"{common_pPr}{common_run}"
            f"<w:tblPr>"
            f"{_borders(edges=dict.fromkeys(('top', 'left', 'bottom', 'right', 'insideH', 'insideV'), ('none', 0, 'auto')))}"
            f"{_cell_margins(vertical=0, horizontal=100)}"
            f"</w:tblPr>"
        ),
    )

    return hairline + banded + bordered + signature + layout


def _styles_xml(spec: ThemeSpec) -> str:
    """The whole payload of a theme: `word/styles.xml`."""
    palette = spec.palette
    face = spec.face
    h1, h2, h3, h4 = spec.heading_pt

    doc_defaults = (
        "<w:docDefaults>"
        "<w:rPrDefault>"
        f"{_run_props(font=face.body, size_pt=spec.body_pt, color=palette.ink)}"
        "</w:rPrDefault>"
        "<w:pPrDefault>"
        f"<w:pPr>{_line_rule(spec, spec.body_pt)}</w:pPr>"
        "</w:pPrDefault>"
        "</w:docDefaults>"
    )

    normal = (
        f'<w:style w:type="paragraph" w:default="1" w:styleId="{_STYLE_IDS["Normal"]}">'
        f'<w:name w:val="Normal"/><w:qFormat/>'
        f"<w:pPr>{_line_rule(spec, spec.body_pt)}</w:pPr>"
        f"{_run_props(font=face.body, size_pt=spec.body_pt, color=palette.ink)}"
        f"</w:style>"
    )
    default_font = (
        f'<w:style w:type="character" w:default="1" '
        f'w:styleId="{_STYLE_IDS["Default Paragraph Font"]}">'
        f'<w:name w:val="Default Paragraph Font"/><w:uiPriority w:val="1"/>'
        f"<w:semiHidden/><w:unhideWhenUsed/></w:style>"
    )
    normal_table = (
        f'<w:style w:type="table" w:default="1" w:styleId="{_STYLE_IDS["Normal Table"]}">'
        f'<w:name w:val="Normal Table"/><w:uiPriority w:val="99"/>'
        f"<w:semiHidden/><w:unhideWhenUsed/>"
        f'<w:tblPr>{_cell_margins(vertical=0, horizontal=108)}</w:tblPr>'
        f"</w:style>"
    )

    paragraph_styles = "".join(
        (
            _paragraph_style(
                "Title",
                spec,
                next_style="Subtitle",
                size_pt=spec.title_pt,
                color=palette.accent,
                font=face.heading,
                bold=True,
                space_after_pt=6,
                keep_next=True,
            ),
            _paragraph_style(
                "Subtitle",
                spec,
                size_pt=spec.subtitle_pt,
                color=palette.muted,
                font=face.heading,
                space_after_pt=14,
                keep_next=True,
            ),
            _paragraph_style(
                "Heading 1",
                spec,
                size_pt=h1,
                color=palette.accent,
                font=face.heading,
                bold=True,
                space_before_pt=16,
                space_after_pt=5,
                keep_next=True,
                outline_level=0,
                border_bottom=palette.rule,
            ),
            _paragraph_style(
                "Heading 2",
                spec,
                size_pt=h2,
                color=palette.accent,
                font=face.heading,
                bold=True,
                space_before_pt=12,
                space_after_pt=4,
                keep_next=True,
                outline_level=1,
            ),
            _paragraph_style(
                "Heading 3",
                spec,
                size_pt=h3,
                color=palette.ink,
                font=face.heading,
                bold=True,
                space_before_pt=10,
                space_after_pt=3,
                keep_next=True,
                outline_level=2,
            ),
            _paragraph_style(
                "Heading 4",
                spec,
                size_pt=h4,
                color=palette.muted,
                font=face.heading,
                bold=True,
                caps=spec.heading_all_caps,
                space_before_pt=8,
                space_after_pt=3,
                keep_next=True,
                outline_level=3,
            ),
            _paragraph_style(
                "Body Text",
                spec,
                next_style="Body Text",
                size_pt=spec.body_pt,
                color=palette.ink,
                font=face.body,
                space_after_pt=6,
            ),
            _paragraph_style(
                "Caption",
                spec,
                size_pt=spec.small_pt,
                color=palette.muted,
                font=face.body,
                italic=True,
                space_before_pt=2,
                space_after_pt=6,
                keep_next=True,
            ),
            # Req 3.7 / 16.10's row, and `design-system.md`'s instruction that an empty result
            # reads as information rather than as an error: muted ink, no rule, no red. A
            # style rather than inline formatting, so a theme can honour it its own way.
            _paragraph_style(
                "Notice",
                spec,
                size_pt=spec.small_pt,
                color=palette.muted,
                font=face.body,
                italic=True,
                space_before_pt=2,
                space_after_pt=4,
            ),
            _paragraph_style(
                "PreviewNotice",
                spec,
                size_pt=spec.small_pt,
                color=palette.muted,
                font=face.heading,
                caps=True,
                space_before_pt=0,
                space_after_pt=8,
                border_bottom=palette.rule,
            ),
            # --- The front matter (breadth 13.4, 13.5, 14.6) --------------------------
            #
            # Deliberately not `Title` and `Subtitle`. A cover and a content heading are
            # different typographic jobs, and sharing a style would tie the cover's scale to
            # whatever a section heading needs — so a theme could not make its cover larger
            # without enlarging every `Title` in the document.
            _paragraph_style(
                "Cover Title",
                spec,
                next_style="Cover Meta",
                size_pt=spec.title_pt * 1.35,
                color=palette.accent,
                font=face.heading,
                bold=True,
                space_before_pt=0,
                space_after_pt=8,
                keep_next=True,
            ),
            _paragraph_style(
                "Cover Meta",
                spec,
                next_style="Cover Meta",
                size_pt=spec.subtitle_pt,
                color=palette.muted,
                font=face.heading,
                space_after_pt=3,
            ),
            # The document control page's field lines and its confidentiality notice. No
            # `w:caps`: the lines carry *values* — a customer name, a document number — and
            # a style that uppercased them would change the data the reader sees.
            _paragraph_style(
                "Document Control",
                spec,
                next_style="Document Control",
                size_pt=spec.small_pt,
                color=palette.ink,
                font=face.body,
                space_before_pt=0,
                space_after_pt=2,
            ),
            _paragraph_style(
                "Toc Entry",
                spec,
                next_style="Toc Entry",
                size_pt=spec.body_pt,
                color=palette.ink,
                font=face.body,
                space_before_pt=0,
                space_after_pt=2,
                right_tab_twips=_CONTENT_WIDTH_TWIPS,
            ),
        )
    )

    # Req 8.2, 20.3 — the character style every figure is wrapped in. Monospaced so a column of
    # numerals aligns and a changing value does not reflow its row, and left otherwise
    # unremarkable: a figure should read as part of the sentence it sits in, not as a callout.
    #
    # ## The two explicit `off` switches are load-bearing, not defensive tidying
    #
    # `w:caps` and `w:smallCaps` change the *rendered* glyphs while leaving the stored `w:t`
    # untouched. A figure inheriting either from its paragraph style would sit in the `.docx`
    # as `1.2 bytes` and appear in the converted `.pdf` as `1.2 BYTES` — and Req 23's PDF pass
    # looks for each ledger `formatted` string as a contiguous substring of the extracted text,
    # so it would report `pdf_figure_missing` and withhold a document that is entirely correct.
    #
    # This is not hypothetical: `technical` and `minimal` set `w:caps` on `Heading 4`, and a
    # `kpi_row` heading is a perfectly ordinary place for a figure. Digits have no case, so the
    # failure would appear only for units and estimator labels — i.e. intermittently, on some
    # presets, for some metrics. Turning both off *here* fixes it for every theme at once,
    # because a figure's own character style is the last word on its run properties.
    figure_style = (
        f'<w:style w:type="character" w:styleId="{_STYLE_IDS["Figure"]}">'
        f'<w:name w:val="Figure"/>'
        f'<w:basedOn w:val="{_STYLE_IDS["Default Paragraph Font"]}"/>'
        f"<w:qFormat/>"
        f"<w:rPr>"
        f'<w:rFonts w:ascii="{face.figure}" w:hAnsi="{face.figure}" w:cs="{face.figure}"'
        f' w:eastAsia="{face.figure}"/>'
        f'<w:caps w:val="0"/><w:smallCaps w:val="0"/>'
        f'<w:spacing w:val="0"/>'
        f'<w:color w:val="{palette.ink}"/>'
        f'<w:sz w:val="{_half_points(spec.body_pt - 0.5)}"/>'
        f'<w:szCs w:val="{_half_points(spec.body_pt - 0.5)}"/>'
        f"</w:rPr>"
        f"</w:style>"
    )

    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        f'<w:styles xmlns:w="{_W_NS}">'
        f"{doc_defaults}{normal}{default_font}{normal_table}"
        f"{paragraph_styles}{figure_style}{_data_table_styles(spec)}"
        f"</w:styles>"
    )


_DOCUMENT_XML: Final[str] = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    f'<w:document xmlns:w="{_W_NS}">'
    "<w:body>"
    # No paragraph, no run, no text — a theme is a stylesheet (Req 8.5). `sectPr` is not
    # content; it is the section's page geometry, which every document needs and which the
    # renderer overrides when a template asks for Letter.
    f'<w:sectPr><w:pgSz w:w="{_A4_WIDTH_TWIPS}" w:h="{_A4_HEIGHT_TWIPS}"/>'
    f'<w:pgMar w:top="{_MARGIN_TWIPS}" w:right="{_MARGIN_TWIPS}" w:bottom="{_MARGIN_TWIPS}"'
    f' w:left="{_MARGIN_TWIPS}" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr>'
    "</w:body>"
    "</w:document>"
)

_CONTENT_TYPES_XML: Final[str] = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    '<Default Extension="rels" '
    'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    '<Default Extension="xml" ContentType="application/xml"/>'
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-'
    'officedocument.wordprocessingml.document.main+xml"/>'
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-'
    'officedocument.wordprocessingml.styles+xml"/>'
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-'
    'package.core-properties+xml"/>'
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-'
    'officedocument.extended-properties+xml"/>'
    "</Types>"
)

_ROOT_RELS_XML: Final[str] = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships/officeDocument" Target="word/document.xml"/>'
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/'
    'relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships/extended-properties" Target="docProps/app.xml"/>'
    "</Relationships>"
)

_DOCUMENT_RELS_XML: Final[str] = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/'
    'relationships/styles" Target="styles.xml"/>'
    "</Relationships>"
)

_APP_XML: Final[str] = (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-'
    'properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docProps'
    '/vTypes"><Application>reporting-agent</Application></Properties>'
)


def _core_xml(spec: ThemeSpec) -> str:
    return (
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
        '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/'
        'metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" '
        'xmlns:dcterms="http://purl.org/dc/terms/" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
        f"<dc:title>{spec.preset} theme</dc:title>"
        "<dc:creator>reporting-agent</dc:creator>"
        f'<dcterms:created xsi:type="dcterms:W3CDTF">{_FIXED_TIMESTAMP}</dcterms:created>'
        f'<dcterms:modified xsi:type="dcterms:W3CDTF">{_FIXED_TIMESTAMP}</dcterms:modified>'
        "</cp:coreProperties>"
    )


def build_theme_bytes(spec: ThemeSpec) -> bytes:
    """One theme document, as bytes, deterministically.

    Two calls with one spec produce one byte sequence: the part order is fixed, every
    timestamp is a sentinel, and the zip entries carry the zip epoch rather than the wall
    clock. That is what lets `tests/test_themes.py` assert the committed file is current
    instead of merely plausible.
    """
    parts: tuple[tuple[str, str], ...] = (
        ("[Content_Types].xml", _CONTENT_TYPES_XML),
        ("_rels/.rels", _ROOT_RELS_XML),
        ("docProps/app.xml", _APP_XML),
        ("docProps/core.xml", _core_xml(spec)),
        ("word/_rels/document.xml.rels", _DOCUMENT_RELS_XML),
        ("word/document.xml", _DOCUMENT_XML),
        ("word/styles.xml", _styles_xml(spec)),
    )

    from io import BytesIO

    buffer = BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        for name, text in parts:
            info = zipfile.ZipInfo(name, date_time=_ZIP_TIMESTAMP)
            info.compress_type = zipfile.ZIP_DEFLATED
            info.external_attr = 0o600 << 16
            archive.writestr(info, text.encode("utf-8"))
    return buffer.getvalue()


def write_theme_documents(directory: Path | None = None) -> tuple[Path, ...]:
    """Write all four documents, returning the paths written.

    The `--write` half of this module's entry point. Regenerating is the only supported way to
    change a theme; editing the binary in Word would produce a file the byte-equality test
    rejects, which is the intent.
    """
    root = theme_directory() if directory is None else directory
    root.mkdir(parents=True, exist_ok=True)

    written: list[Path] = []
    for preset in THEME_PRESETS:
        path = root / theme_filename(preset)
        path.write_bytes(build_theme_bytes(THEME_SPECS[preset]))
        written.append(path)
    return tuple(written)


# The style-name vocabulary has to be internally consistent or the builder writes a `w:basedOn`
# pointing at nothing. Asserted at import, the way `errors.py` asserts its own partitions.
assert set(REQUIRED_STYLE_NAMES) <= set(_STYLE_IDS), sorted(
    set(REQUIRED_STYLE_NAMES) - set(_STYLE_IDS)
)
assert len(set(_STYLE_IDS.values())) == len(_STYLE_IDS), "two style names share one w:styleId"
assert not any(re.search(r"\s", style_id) for style_id in _STYLE_IDS.values()), (
    "a w:styleId carries whitespace"
)


if __name__ == "__main__":  # pragma: no cover - exercised by the Dockerfile and the suite
    import sys

    flags = sys.argv[1:]
    if "--write" in flags:
        for written_path in write_theme_documents():
            print(f"wrote {written_path}")
        raise SystemExit(0)

    if "--assert-build" not in flags:
        print(
            "usage: python -m reporting_agent.render.themes [--assert-build | --write]",
            file=sys.stderr,
        )
        raise SystemExit(2)

    assert_themes_usable()
    print(
        f"themes ok: {len(THEME_FILENAMES)} documents, "
        f"{len(REQUIRED_STYLE_NAMES)} required styles each"
    )
