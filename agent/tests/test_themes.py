"""The Theme_Guard (Req 8.2-8.5, 8.8), shipping with the documents it guards.

Two halves, and the second is what makes the first worth anything:

* **The four committed documents** satisfy every property Req 8 names — each declares the
  `Figure` character style, each declares the full referenced style union, each carries zero
  non-whitespace text, and `agent/themes/` holds exactly the four required file names, each
  openable as a document package.
* **Guard the guard.** Every one of those rules is proven to *fire* against a theme
  deliberately broken in `tmp_path`. This guard checks an absence — the easiest kind of check
  to write so that it can never fail — so a rule nobody has watched fail is a rule nobody
  knows the shape of.

The checker lives in `src/`, not here, because `.dockerignore` excludes `tests/`: a guard that
only ran in the suite could not stop an image carrying a theme missing a style the compiled
blocks reference (Req 8.7). The Dockerfile runs
`python -m reporting_agent.render.themes --assert-build`, and
:func:`test_the_build_time_entry_point_agrees_with_the_suite` asserts the two agree.

## The anti-drift test worth finding first

:func:`test_every_style_a_compiled_document_asks_for_is_declared_by_every_theme` compiles real
definitions and walks the resulting AST, asserting every `style` it finds is a name all four
themes declare. That closes the loop the constant declarations only describe: a block module
that starts emitting `Heading 5` fails here rather than rendering unstyled in a delivered
document.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import zipfile
from pathlib import Path

import pytest

import snapshot_factory as sf
from definition_corpus import CORPUS_ROOT
from reporting_agent.compile.ast import Chart, Paragraph, Table, child_nodes
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import (
    LAYOUT_TABLE_STYLE,
    PARAGRAPH_STYLES,
    TABLE_STYLES,
    heading_style,
    table_style_name,
)
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.errors import ErrorCode, RenderFailedError
from reporting_agent.render import themes as T

AGENT_ROOT = Path(__file__).resolve().parent.parent
BUILD_ENV = {"PYTHONPATH": str(AGENT_ROOT / "src"), "PATH": "/usr/bin:/bin"}


# --------------------------------------------------------------------------- #
# Helpers — a theme broken on purpose
# --------------------------------------------------------------------------- #


def _rewrite(preset: str, destination: Path, *, styles: str | None = None, document: str | None = None) -> Path:
    """Copy `preset`'s theme into `destination`, optionally replacing two parts.

    Rewrites the zip rather than editing in place, which is what a hand-edit in Word amounts
    to from this guard's point of view.
    """
    source = T.theme_path(preset)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(source) as original, zipfile.ZipFile(
        destination, "w", compression=zipfile.ZIP_DEFLATED
    ) as rebuilt:
        for item in original.infolist():
            payload = original.read(item.filename)
            if styles is not None and item.filename == "word/styles.xml":
                payload = styles.encode("utf-8")
            if document is not None and item.filename == "word/document.xml":
                payload = document.encode("utf-8")
            rebuilt.writestr(item.filename, payload)
    return destination


def _styles_xml(preset: str) -> str:
    with zipfile.ZipFile(T.theme_path(preset)) as archive:
        return archive.read("word/styles.xml").decode("utf-8")


def _document_xml(preset: str) -> str:
    with zipfile.ZipFile(T.theme_path(preset)) as archive:
        return archive.read("word/document.xml").decode("utf-8")


def _without_style(preset: str, style_name: str) -> str:
    """`preset`'s styles.xml with one style element removed entirely."""
    style_id = T._STYLE_IDS[style_name]
    pattern = rf'<w:style w:type="[a-z]+" w:styleId="{re.escape(style_id)}">.*?</w:style>'
    reduced, count = re.subn(pattern, "", _styles_xml(preset), count=1, flags=re.DOTALL)
    assert count == 1, f"could not excise {style_name!r} ({style_id!r}) from {preset}"
    return reduced


def _four_themes(directory: Path) -> Path:
    """A complete, valid copy of all four documents in `directory`."""
    T.write_theme_documents(directory)
    return directory


# --------------------------------------------------------------------------- #
# The committed documents satisfy the invariant
# --------------------------------------------------------------------------- #


def test_the_theme_directory_holds_exactly_the_four_required_documents() -> None:
    """Req 8.1, 8.8."""
    present = sorted(entry.name for entry in T.theme_directory().iterdir() if entry.is_file())
    assert present == sorted(T.THEME_FILENAMES)


def test_the_guard_reports_no_violation_for_the_committed_documents() -> None:
    assert T.collect_theme_violations() == []
    T.assert_themes_usable()


def test_the_guard_inspected_something() -> None:
    """The first failure mode to rule out: a guard that passes by finding no documents.

    `test_boundaries.py` deliberately omits a non-empty rule on its own scan; here the
    directory contents *are* the subject, so an empty directory must not read as clean.
    """
    assert len(T.THEME_FILENAMES) == 4
    assert len(T.REQUIRED_STYLE_NAMES) >= 14
    for preset in T.THEME_PRESETS:
        assert T.theme_path(preset).is_file(), preset
        assert T.theme_path(preset).stat().st_size > 1000, preset


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_every_theme_declares_the_figure_character_style(preset: str) -> None:
    """Req 8.2 — and it must be a **character** style, because the renderer applies it to a
    run. A paragraph style of the same name would satisfy a name check and fail at render."""
    from docx.enum.style import WD_STYLE_TYPE

    style = T.load_theme(preset).styles[T.FIGURE_CHARACTER_STYLE]
    assert style.type == WD_STYLE_TYPE.CHARACTER, style.type


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
@pytest.mark.parametrize("style_name", T.REQUIRED_STYLE_NAMES)
def test_every_theme_declares_every_required_style(preset: str, style_name: str) -> None:
    """Req 8.3, looked up the way the renderer looks it up.

    Through `document.styles[name]` rather than by scanning `w:name`, because `python-docx`
    translates a handful of UI names to lowercase internal ones — so a theme whose XML plainly
    contains `Heading 1` can still raise `KeyError` for `"Heading 1"`.
    """
    assert T.load_theme(preset).styles[style_name] is not None


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_every_theme_carries_zero_non_whitespace_text(preset: str) -> None:
    """Req 8.5 — a stylesheet that happens to be a `.docx`, not a document with placeholder
    prose in it."""
    assert T.non_whitespace_text(T.load_theme(preset)) == ""


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_no_theme_declares_a_header_or_footer_part(preset: str) -> None:
    """The strongest form of Req 8.5's header and footer clause: rather than assert a header
    carries no text, assert there is no header.

    Also protects :func:`non_whitespace_text` from the trap it documents — reading
    `section.header` would *create* the part, so a test that passed by materializing an empty
    header would prove nothing.
    """
    from docx.opc.constants import CONTENT_TYPE as CT

    document = T.load_theme(preset)
    kinds = [part.content_type for part in document.part.package.iter_parts()]
    assert CT.WML_HEADER not in kinds, kinds
    assert CT.WML_FOOTER not in kinds, kinds


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_the_committed_document_is_byte_identical_to_a_fresh_build(preset: str) -> None:
    """What makes `THEME_SPECS` authoritative rather than decorative.

    Edit the spec without regenerating and this fails; edit the binary in Word and this fails.
    Either way the committed bytes and the reviewed source cannot drift apart, which is the
    only honest reading of Req 8.1's "tracked as source files and changed only through the same
    review path as code".
    """
    assert T.theme_path(preset).read_bytes() == T.build_theme_bytes(T.THEME_SPECS[preset])


def test_building_a_theme_twice_produces_one_byte_sequence() -> None:
    """Determinism, for the same reason `render/docx.py` needs it (Req 20.8): a wall-clock
    timestamp or an unordered zip would make the test above unwritable."""
    for preset in T.THEME_PRESETS:
        spec = T.THEME_SPECS[preset]
        assert T.build_theme_bytes(spec) == T.build_theme_bytes(spec)


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_the_figure_style_neutralizes_case_transformation(preset: str) -> None:
    """The bug this catches ships a correct document and fails its own verification.

    `w:caps` changes rendered glyphs and leaves `w:t` alone, so a figure inheriting caps from
    its paragraph style sits in the `.docx` as `1.2 bytes` and appears in the `.pdf` as
    `1.2 BYTES`. Req 23's PDF pass looks for each ledger `formatted` string as a contiguous
    substring, so it would report `pdf_figure_missing` for a document that is entirely right.

    Two presets set `w:caps` on `Heading 4`, and a figure in a heading is ordinary. Digits have
    no case, so without this the failure would appear only for units and estimator labels —
    intermittently, on some presets, for some metrics.
    """
    style_xml = _styles_xml(preset)
    figure = re.search(
        r'<w:style w:type="character" w:styleId="Figure">.*?</w:style>', style_xml, re.DOTALL
    )
    assert figure is not None, "no Figure character style in the styles part"
    assert '<w:caps w:val="0"/>' in figure.group(0)
    assert '<w:smallCaps w:val="0"/>' in figure.group(0)


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_the_layout_table_style_has_no_visible_border(preset: str) -> None:
    """Req 21.2 — a `row` block's container must not read as a data table.

    The verifier excludes it by the absence of a `w:tblCaption`, but a reader excludes it by
    seeing no rules, and both have to hold.
    """
    style_xml = _styles_xml(preset)
    layout = re.search(
        r'<w:style w:type="table" w:styleId="LayoutTable">.*?</w:style>', style_xml, re.DOTALL
    )
    assert layout is not None
    borders = re.search(r"<w:tblBorders>.*?</w:tblBorders>", layout.group(0), re.DOTALL)
    assert borders is not None
    assert 'w:val="single"' not in borders.group(0), borders.group(0)
    assert borders.group(0).count('w:val="none"') == 6, borders.group(0)
    # And no header-row conditional formatting: a layout table has no header row.
    assert "w:tblStylePr" not in layout.group(0)


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_every_theme_declares_all_three_data_table_styles(preset: str) -> None:
    """The preset picks the *file*; `design.table_style` picks the *style inside it*. The two
    settings are orthogonal, so a theme defining only its own look would fail the moment a
    template paired `technical` with `bordered`."""
    document = T.load_theme(preset)
    for setting in ("hairline", "banded", "bordered"):
        assert document.styles[table_style_name(setting)] is not None


# --------------------------------------------------------------------------- #
# The union is derived from the compile stage, not restated
# --------------------------------------------------------------------------- #


def test_the_required_union_contains_every_declared_compile_stage_style() -> None:
    """Req 8.3. Imported rather than restated, so a block module cannot add a style the themes
    have never heard of."""
    assert set(PARAGRAPH_STYLES) <= set(T.REQUIRED_PARAGRAPH_STYLES)
    assert set(TABLE_STYLES) <= set(T.REQUIRED_TABLE_STYLES)
    assert LAYOUT_TABLE_STYLE in T.REQUIRED_TABLE_STYLES
    assert T.FIGURE_CHARACTER_STYLE in T.REQUIRED_STYLE_NAMES
    assert T.PREVIEW_NOTICE_STYLE in T.REQUIRED_STYLE_NAMES


def test_the_union_adds_exactly_the_two_names_the_compile_stage_cannot_declare() -> None:
    """`Figure` and `PreviewNotice` are the renderer's own, and nothing else is smuggled in."""
    extra = set(T.REQUIRED_STYLE_NAMES) - set(PARAGRAPH_STYLES) - set(TABLE_STYLES)
    assert extra == {T.FIGURE_CHARACTER_STYLE, T.PREVIEW_NOTICE_STYLE}


@pytest.mark.parametrize("level", [-3, 0, 1, 2, 3, 4, 5, 9, 100, True, None, "2", 2.5])
def test_every_heading_style_the_clamp_can_return_is_declared(level: object) -> None:
    """`heading_style` clamps rather than refuses, so the set of names it can return is what
    the themes must cover — including for a level no author would type."""
    assert heading_style(level) in T.REQUIRED_PARAGRAPH_STYLES


@pytest.mark.parametrize(
    "setting", ["hairline", "banded", "bordered", "", "nonsense", "HAIRLINE"]
)
def test_every_table_style_the_resolver_can_return_is_declared(setting: str) -> None:
    """`table_style_name` falls back to `Table Hairline` for an unrecognised setting, so this
    covers the fallback as well as the three declared values."""
    assert table_style_name(setting) in T.REQUIRED_TABLE_STYLES


class _ComparisonOverOneView:
    """A `ComparisonSource` answering every run id with one view — no S3, no Azure.

    The fixture's `comparison_delta` names two runs, and this test is about **style names**,
    not about deltas: comparing a snapshot with itself still emits the block's table with its
    style, which is all that is being walked for. `tests/test_delta.py` owns the arithmetic.
    """

    def __init__(self, view: object) -> None:
        self._view = view

    def snapshot_for(self, run_id: str) -> object:
        return self._view


def _styles_in_tree(node: object) -> set[str]:
    found: set[str] = set()
    if isinstance(node, Paragraph | Table):
        found.add(node.style)
    if isinstance(node, Chart):
        pass  # a chart carries no theme style; its companion table does
    for child in child_nodes(node):
        found |= _styles_in_tree(child)
    return found


RENDERER_APPLIED_STYLES: frozenset[str] = frozenset(
    {LAYOUT_TABLE_STYLE, "Caption", T.PREVIEW_NOTICE_STYLE, "Notice"}
)
"""The four required names a compiled AST never carries in a `style` field.

Worth naming rather than leaving as a gap in the walk below, because each is applied by the
renderer for a structural reason:

* **`Layout Table`** — a `row` compiles to a `LayoutRow`, which carries no style at all;
  `render/anchors.py` gives its container this style and no `w:tblCaption`, which is what
  excludes a layout table from the verifier's table pass by construction (Req 21.2).
* **`Caption`** — a caption travels as `Table.caption` / `Chart.caption`, a string on the node
  rather than a paragraph, because the AST has no notion of the paragraph the renderer will
  emit for it.
* **`PreviewNotice`** — preview mode only, so no compile ever asks for it.
* **`Notice`** — the empty-scope and no-gaps rows are `TextCell`s inside a table that carries
  the *table* style; the notice style is applied to the cell's paragraph at render time.

`render/docx.py`'s own tests are what cover these; asserting them here would require a fake
renderer, and a walk that quietly covered ten of fourteen names while reading as exhaustive is
worse than one that says which four it does not reach.
"""


def _compiled_styles(*, table_style: str, heading_levels: tuple[int, ...]) -> set[str]:
    """Every style an actual compile carries, for one `design.table_style` and heading depth."""
    view = build_snapshot_view(sf.two_vm_snapshot())
    definition = json.loads((CORPUS_ROOT / "accept-every-block-type.json").read_text())
    definition["design"] = {**definition["design"], "table_style": table_style}
    definition["blocks"] = [
        *definition["blocks"],
        *(
            {"id": f"h{level}", "type": "heading", "config": {"text": f"H{level}", "level": level}}
            for level in heading_levels
        ),
    ]
    compiled = compile_document(
        definition, view=view, comparison_source=_ComparisonOverOneView(view)
    )
    return _styles_in_tree(compiled.document)


def test_every_style_a_compiled_document_asks_for_is_declared_by_every_theme() -> None:
    """The anti-drift test: from the compiler's real output to the committed files.

    Compiles the corpus fixture covering all sixteen declared block types — once per
    `design.table_style`, and with a heading at every level the clamp can produce — then walks
    the AST for every `style` it actually carries and asserts all four themes declare each one.
    A constant declaring a name is a promise; this is the check.

    Reads the shared corpus rather than a private fixture so the block-type coverage is the same
    coverage the Mirror_Guard enforces, rather than a second list to keep current. The three
    axes are separate because a single fixture pins one table style and one heading depth: the
    first version of this test walked six names and read as though it had walked fourteen.
    """
    asked_for: set[str] = set()
    for table_style in ("hairline", "banded", "bordered"):
        asked_for |= _compiled_styles(
            table_style=table_style, heading_levels=(1, 2, 3, 4, 9)
        )

    # Every name the AST can carry is now covered, and the four it cannot are accounted for.
    assert asked_for | RENDERER_APPLIED_STYLES == set(T.REQUIRED_STYLE_NAMES) - {
        T.FIGURE_CHARACTER_STYLE
    }, sorted(set(T.REQUIRED_STYLE_NAMES) - asked_for - RENDERER_APPLIED_STYLES)

    documents = {preset: T.load_theme(preset) for preset in T.THEME_PRESETS}
    missing: list[str] = []
    for style_name in sorted(asked_for):
        for preset, document in documents.items():
            try:
                document.styles[style_name]
            except KeyError:
                missing.append(f"{preset}.docx does not declare {style_name!r}")
    assert missing == [], missing


def test_the_walk_reaches_every_table_style_and_heading_level() -> None:
    """Guard the guard above: prove the three axes actually widen what it inspects.

    Without this, a fixture change that dropped every table could leave the assertion passing
    over a handful of paragraph styles.
    """
    hairline = _compiled_styles(table_style="hairline", heading_levels=())
    assert "Table Hairline" in hairline
    assert "Table Banded" not in hairline

    banded = _compiled_styles(table_style="banded", heading_levels=())
    assert "Table Banded" in banded

    bordered = _compiled_styles(table_style="bordered", heading_levels=())
    assert "Table Bordered" in bordered

    deep = _compiled_styles(table_style="hairline", heading_levels=(1, 2, 3, 4, 9))
    for level in (1, 2, 3, 4):
        assert f"Heading {level}" in deep, level


# --------------------------------------------------------------------------- #
# Guard the guard — every rule is proven to fire
# --------------------------------------------------------------------------- #


def test_a_clean_copy_in_a_temporary_directory_reports_nothing(tmp_path: Path) -> None:
    assert T.collect_theme_violations(_four_themes(tmp_path)) == []


@pytest.mark.parametrize("style_name", T.REQUIRED_STYLE_NAMES)
def test_the_guard_catches_any_single_missing_style(style_name: str, tmp_path: Path) -> None:
    """Req 8.4 — every name in the union, each proven to be checked rather than merely
    listed."""
    _four_themes(tmp_path)
    _rewrite("editorial", tmp_path / "editorial.docx", styles=_without_style("editorial", style_name))

    violations = T.collect_theme_violations(tmp_path)
    assert len(violations) == 1, violations
    assert violations[0].startswith(T.MISSING_STYLE_VIOLATION)
    assert "editorial.docx" in violations[0]
    assert repr(style_name) in violations[0]


def test_the_guard_reports_every_missing_pair_across_all_four_documents(tmp_path: Path) -> None:
    """Req 8.4 explicitly: **not** only the first, so one fix pass clears the build.

    A first-error-only guard turns twelve missing styles into twelve build cycles, and the
    twelfth one is where somebody gives up and deletes the assertion.
    """
    _four_themes(tmp_path)
    for preset in T.THEME_PRESETS:
        _rewrite(
            preset,
            tmp_path / T.theme_filename(preset),
            styles=_without_style(preset, T.FIGURE_CHARACTER_STYLE),
        )
    # And one document is missing a second style on top of that.
    reduced = _without_style("minimal", T.FIGURE_CHARACTER_STYLE)
    reduced = re.sub(
        r'<w:style w:type="paragraph" w:styleId="Notice">.*?</w:style>', "", reduced, flags=re.DOTALL
    )
    _rewrite("minimal", tmp_path / "minimal.docx", styles=reduced)

    violations = T.collect_theme_violations(tmp_path)
    assert len(violations) == 5, violations
    for preset in T.THEME_PRESETS:
        assert any(
            f"{preset}.docx" in line and repr(T.FIGURE_CHARACTER_STYLE) in line
            for line in violations
        ), preset
    assert any("minimal.docx" in line and "'Notice'" in line for line in violations)


def test_the_guard_catches_stray_body_text(tmp_path: Path) -> None:
    """Req 8.5, proven to fire."""
    _four_themes(tmp_path)
    body = _document_xml("corporate").replace(
        "<w:body>", "<w:body><w:p><w:r><w:t>Lorem ipsum</w:t></w:r></w:p>"
    )
    _rewrite("corporate", tmp_path / "corporate.docx", document=body)

    violations = T.collect_theme_violations(tmp_path)
    assert len(violations) == 1, violations
    assert violations[0].startswith(T.CONTENT_VIOLATION)
    assert "corporate.docx" in violations[0]
    assert "Loremipsum" in violations[0]


def test_whitespace_only_text_is_not_stray_content(tmp_path: Path) -> None:
    """Req 8.5 says *non-whitespace* characters. A stylesheet carrying an empty paragraph is
    still a stylesheet, and treating indentation as content would make the rule unusable."""
    _four_themes(tmp_path)
    body = _document_xml("technical").replace(
        "<w:body>", '<w:body><w:p><w:r><w:t xml:space="preserve">   </w:t></w:r></w:p>'
    )
    _rewrite("technical", tmp_path / "technical.docx", document=body)
    assert T.collect_theme_violations(tmp_path) == []


def test_the_guard_reports_an_unopenable_file_distinctly_from_a_missing_style(
    tmp_path: Path,
) -> None:
    """Req 8.8 requires the two to be distinguishable.

    They have different fixes — one is a corrupt commit, the other is a design omission — and
    a reader who cannot tell them apart starts by looking for a style in a file that will not
    open.
    """
    _four_themes(tmp_path)
    (tmp_path / "minimal.docx").write_bytes(b"this is not a zip archive at all")

    violations = T.collect_theme_violations(tmp_path)
    assert len(violations) == 1, violations
    assert violations[0].startswith(T.UNOPENABLE_VIOLATION)
    assert "minimal.docx" in violations[0]
    assert T.MISSING_STYLE_VIOLATION not in violations[0]


def test_an_unopenable_file_does_not_stop_the_other_three_being_checked(tmp_path: Path) -> None:
    """One corrupt file must not mask eleven missing styles."""
    _four_themes(tmp_path)
    (tmp_path / "minimal.docx").write_bytes(b"not a zip")
    _rewrite(
        "editorial",
        tmp_path / "editorial.docx",
        styles=_without_style("editorial", T.FIGURE_CHARACTER_STYLE),
    )

    violations = T.collect_theme_violations(tmp_path)
    kinds = {line.split(":", 1)[0] for line in violations}
    assert kinds == {T.UNOPENABLE_VIOLATION, T.MISSING_STYLE_VIOLATION}, violations


def test_the_guard_catches_a_missing_document(tmp_path: Path) -> None:
    """Req 8.8 — other than exactly the four required names."""
    _four_themes(tmp_path)
    (tmp_path / "technical.docx").unlink()

    violations = T.collect_theme_violations(tmp_path)
    assert len(violations) == 1, violations
    assert violations[0].startswith(T.DIRECTORY_VIOLATION)
    assert "technical.docx" in violations[0]
    assert "missing" in violations[0]


def test_the_guard_catches_an_unexpected_file(tmp_path: Path) -> None:
    """A fifth document in the directory is a preset nothing can select, so it is either dead
    weight or a preset somebody forgot to declare. Both want saying."""
    _four_themes(tmp_path)
    (tmp_path / "seasonal.docx").write_bytes(T.build_theme_bytes(T.THEME_SPECS["minimal"]))

    violations = T.collect_theme_violations(tmp_path)
    assert len(violations) == 1, violations
    assert violations[0].startswith(T.DIRECTORY_VIOLATION)
    assert "seasonal.docx" in violations[0]


def test_the_guard_catches_an_absent_directory(tmp_path: Path) -> None:
    violations = T.collect_theme_violations(tmp_path / "nowhere")
    assert len(violations) == 1
    assert violations[0].startswith(T.DIRECTORY_VIOLATION)


def test_assert_themes_usable_raises_render_failed_listing_every_violation(
    tmp_path: Path,
) -> None:
    _four_themes(tmp_path)
    for preset in ("editorial", "corporate"):
        _rewrite(
            preset,
            tmp_path / T.theme_filename(preset),
            styles=_without_style(preset, T.PREVIEW_NOTICE_STYLE),
        )

    with pytest.raises(RenderFailedError) as raised:
        T.assert_themes_usable(tmp_path)

    assert raised.value.code is ErrorCode.RENDER_FAILED
    assert raised.value.terminal is True
    assert "editorial.docx" in raised.value.message
    assert "corporate.docx" in raised.value.message


# --------------------------------------------------------------------------- #
# The run-time failure (Req 8.6) and the preflight (Req 8.9)
# --------------------------------------------------------------------------- #


def test_loading_a_theme_missing_styles_is_terminal_render_failed_naming_every_one(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Req 8.6 — naming the theme document and **every** missing style name."""
    _four_themes(tmp_path)
    reduced = _without_style("editorial", T.FIGURE_CHARACTER_STYLE)
    for style_name in ("Notice", "Caption", "Table Banded"):
        style_id = T._STYLE_IDS[style_name]
        reduced = re.sub(
            rf'<w:style w:type="[a-z]+" w:styleId="{style_id}">.*?</w:style>',
            "",
            reduced,
            flags=re.DOTALL,
        )
    _rewrite("editorial", tmp_path / "editorial.docx", styles=reduced)
    monkeypatch.setenv(T.THEME_DIR_ENV, str(tmp_path))

    with pytest.raises(RenderFailedError) as raised:
        T.load_theme("editorial")

    message = raised.value.message
    assert raised.value.code is ErrorCode.RENDER_FAILED
    assert "editorial.docx" in message
    for style_name in (T.FIGURE_CHARACTER_STYLE, "Notice", "Caption", "Table Banded"):
        assert style_name in message, (style_name, message)


def test_loading_an_absent_theme_is_terminal_render_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(T.THEME_DIR_ENV, str(tmp_path))
    with pytest.raises(RenderFailedError) as raised:
        T.load_theme("minimal")
    assert "minimal.docx" in raised.value.message
    assert raised.value.terminal is True


def test_loading_an_undeclared_preset_names_the_four(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(T.THEME_DIR_ENV, str(tmp_path))
    with pytest.raises(RenderFailedError) as raised:
        T.load_theme("seasonal")
    for preset in T.THEME_PRESETS:
        assert preset in raised.value.message


def test_loading_an_unopenable_theme_is_terminal_render_failed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _four_themes(tmp_path)
    (tmp_path / "corporate.docx").write_bytes(b"not a document package")
    monkeypatch.setenv(T.THEME_DIR_ENV, str(tmp_path))

    with pytest.raises(RenderFailedError) as raised:
        T.load_theme("corporate")
    assert "could not be opened" in raised.value.message


@pytest.mark.parametrize("preset", T.THEME_PRESETS)
def test_the_preflight_accepts_every_shipped_preset(preset: str) -> None:
    """Req 8.9 — asserted when a run is claimed, before any Azure call."""
    T.assert_theme_available(preset)


def test_the_preflight_refuses_before_any_collection_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The point of Req 8.9 is the *timing*: a theme that cannot render the document fails the
    run in milliseconds rather than after minutes of inventory and metrics."""
    _four_themes(tmp_path)
    _rewrite(
        "technical",
        tmp_path / "technical.docx",
        styles=_without_style("technical", T.FIGURE_CHARACTER_STYLE),
    )
    monkeypatch.setenv(T.THEME_DIR_ENV, str(tmp_path))

    with pytest.raises(RenderFailedError):
        T.assert_theme_available("technical")


def test_the_theme_directory_honours_the_environment_override(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(T.THEME_DIR_ENV, str(tmp_path / "elsewhere"))
    assert T.theme_directory() == tmp_path / "elsewhere"


def test_the_theme_directory_resolves_the_checkout_layout_without_the_override(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Resolved from the checkout marker rather than from whichever candidate exists.

    Probing for an existing `themes/` looks equivalent and is not: it makes the answer depend
    on the directory the caller is about to create, so `--write` bootstrapping an absent
    directory would deposit four documents in `agent/src/`.
    """
    monkeypatch.delenv(T.THEME_DIR_ENV, raising=False)
    assert T.theme_directory() == AGENT_ROOT / "themes"


# --------------------------------------------------------------------------- #
# The build-time entry point
# --------------------------------------------------------------------------- #


def test_the_build_time_entry_point_agrees_with_the_suite() -> None:
    """`.dockerignore` excludes `tests/`, so the invariant has to be assertable from `src/`
    alone. This runs the exact command the Dockerfile runs."""
    result = subprocess.run(
        [sys.executable, "-m", "reporting_agent.render.themes", "--assert-build"],
        cwd=AGENT_ROOT,
        capture_output=True,
        text=True,
        env=BUILD_ENV,
        check=False,
    )
    assert result.returncode == 0, result.stderr
    assert "ok" in result.stdout


def test_the_build_time_entry_point_refuses_to_run_without_the_flag() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "reporting_agent.render.themes"],
        cwd=AGENT_ROOT,
        capture_output=True,
        text=True,
        env=BUILD_ENV,
        check=False,
    )
    assert result.returncode == 2, result.stdout


def test_the_build_time_entry_point_fails_on_a_broken_theme_directory(tmp_path: Path) -> None:
    """Req 8.7 — the build aborts and publishes nothing. Proven by pointing the entry point at
    a directory missing a style, rather than by trusting that it would."""
    _four_themes(tmp_path)
    _rewrite(
        "minimal",
        tmp_path / "minimal.docx",
        styles=_without_style("minimal", T.FIGURE_CHARACTER_STYLE),
    )

    result = subprocess.run(
        [sys.executable, "-m", "reporting_agent.render.themes", "--assert-build"],
        cwd=AGENT_ROOT,
        capture_output=True,
        text=True,
        env={**BUILD_ENV, T.THEME_DIR_ENV: str(tmp_path)},
        check=False,
    )
    assert result.returncode != 0
    assert "minimal.docx" in result.stderr
    assert T.FIGURE_CHARACTER_STYLE in result.stderr
