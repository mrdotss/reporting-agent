"""Guard: no English literal reaches a text-emitting position in the render or compile/blocks
trees (Req 15.2, 15.6).

Thin wrapper over ``reporting_agent.compile.literals``, which holds the scan implementation
and the ``--assert-build`` entry point.  The suite and the Dockerfile check one
implementation.
"""

from __future__ import annotations

import textwrap
from pathlib import Path

import pytest

from reporting_agent.compile.literals import (
    COMPILE_BLOCKS_ROOT,
    DECLARED_EMITTING_SITES,
    RENDER_ROOT,
    _EXCLUDED_SITES,
    _source_files,
    ast_dataclass_str_fields,
    check_self_guard,
    is_valid_string_id_or_empty,
    run_guard,
    run_id_resolution_guard,
)


class TestMessageLiterals:
    """The Python literal guard (Req 15.2, 15.6)."""

    def test_no_english_literals_at_text_emitting_sites(self) -> None:
        """Every string constant at a declared text-emitting site must be a string id or empty."""
        offenders = run_guard()
        if offenders:
            lines = [f"  {path}:{line}: {detail}" for path, line, detail in offenders]
            msg = (
                f"Found {len(offenders)} English literal(s) at text-emitting sites "
                f"(should be string ids resolved through the message catalog):\n"
                + "\n".join(lines)
            )
            pytest.fail(msg)

    def test_guard_guards_itself(self) -> None:
        """Every dataclass in compile/ast.py carrying a str field named text, header,
        caption, label or title must appear in the declared emitting set."""
        missing = check_self_guard()
        if missing:
            lines = [f"  {cls}.{field}" for cls, field in missing]
            msg = (
                f"The following dataclass text fields in compile/ast.py are not registered "
                f"in DECLARED_EMITTING_SITES (a new emitting site was added without "
                f"updating the guard):\n" + "\n".join(lines)
            )
            pytest.fail(msg)

    def test_scan_covers_both_directories(self) -> None:
        """The scan must find files under both render/ and compile/blocks/."""
        render_files = _source_files(RENDER_ROOT) if RENDER_ROOT.is_dir() else []
        blocks_files = _source_files(COMPILE_BLOCKS_ROOT) if COMPILE_BLOCKS_ROOT.is_dir() else []
        assert render_files, f"No Python files found under {RENDER_ROOT}"
        assert blocks_files, f"No Python files found under {COMPILE_BLOCKS_ROOT}"

    def test_scan_does_not_flag_valid_string_ids(self) -> None:
        """Sanity check: known valid string ids pass the regex."""
        assert is_valid_string_id_or_empty("")
        assert is_valid_string_id_or_empty("doc.notice.empty_scope")
        assert is_valid_string_id_or_empty("chart.axis.resource")
        assert is_valid_string_id_or_empty("ui.report.title")

    def test_scan_flags_english_literals(self) -> None:
        """Sanity check: English text is not a valid string id."""
        assert not is_valid_string_id_or_empty("Series")
        assert not is_valid_string_id_or_empty("Point")
        assert not is_valid_string_id_or_empty("Other")
        assert not is_valid_string_id_or_empty("This chart carries no plotted values")
        assert not is_valid_string_id_or_empty(
            "Preview — rendered from a stored snapshot. Not a verified deliverable."
        )


class TestIdResolutionGuard:
    """Guard: an id-shaped constant must only appear as a .text() argument (Req 15.7).

    The motivating defect: `EMPTY_SCOPE_TEXT` (value `"doc.notice.empty_scope"`) was used
    directly in an f-string in render/html.py, printing the raw id to the in-app preview.
    The existing literal guard could not catch it because `self.write(...)` is not a
    declared emitting site — the id reached the page through a generic writer.

    This guard checks the dual rule: a reference to an id-shaped constant must appear ONLY
    as an argument to a `.text(...)` message-resolution call. An id is a thing you resolve,
    never a thing you emit.
    """

    def test_no_unresolved_id_references_in_real_tree(self) -> None:
        """The real tree carries zero id-resolution violations."""
        offenders = run_id_resolution_guard()
        if offenders:
            lines = [f"  {path}:{line}: {detail}" for path, line, detail in offenders]
            pytest.fail(
                f"Found {len(offenders)} unresolved id-constant reference(s) — "
                f"each must only appear as a .text() argument:\n"
                + "\n".join(lines)
            )

    def test_detects_id_used_in_fstring(self, tmp_path: Path) -> None:
        """The exact defect that motivated this guard: an imported id-constant used in an
        f-string rather than resolved through .text().

        Uses a fixture tree so the check's ability to catch violations is proven
        independently of the real tree being clean.
        """
        render_dir = tmp_path / "render"
        render_dir.mkdir()
        blocks_dir = tmp_path / "compile" / "blocks"
        blocks_dir.mkdir(parents=True)

        (render_dir / "broken.py").write_text(
            textwrap.dedent("""\
                import html
                from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT

                class Emitter:
                    def chart(self, node):
                        # THE DEFECT: id emitted raw through a generic writer
                        self.write(f'<p>{html.escape(EMPTY_SCOPE_TEXT)}</p>')
            """),
            encoding="utf-8",
        )
        (blocks_dir / "__init__.py").write_text("", encoding="utf-8")

        offenders = run_id_resolution_guard(
            render_root=render_dir,
            compile_blocks_root=blocks_dir,
            base=tmp_path,
        )
        assert len(offenders) == 1, (
            f"Expected exactly 1 violation for the f-string defect, got {len(offenders)}: "
            + str(offenders)
        )
        assert "EMPTY_SCOPE_TEXT" in offenders[0][2]
        assert "outside .text()" in offenders[0][2]

    def test_does_not_flag_text_call(self, tmp_path: Path) -> None:
        """Passing an id-constant to .text() is the correct resolution and must not be
        flagged."""
        render_dir = tmp_path / "render"
        render_dir.mkdir()
        blocks_dir = tmp_path / "compile" / "blocks"
        blocks_dir.mkdir(parents=True)

        (render_dir / "correct.py").write_text(
            textwrap.dedent("""\
                import html
                from reporting_agent.compile.blocks.base import EMPTY_SCOPE_TEXT

                class Emitter:
                    def chart(self, node):
                        self.write(f'<p>{html.escape(self.messages.text(EMPTY_SCOPE_TEXT))}</p>')
            """),
            encoding="utf-8",
        )
        (blocks_dir / "__init__.py").write_text("", encoding="utf-8")

        offenders = run_id_resolution_guard(
            render_root=render_dir,
            compile_blocks_root=blocks_dir,
            base=tmp_path,
        )
        assert offenders == [], f"Expected zero violations, got: {offenders}"

    def test_detects_id_passed_to_non_text_function(self, tmp_path: Path) -> None:
        """An id-constant passed to any function other than .text() is a violation."""
        render_dir = tmp_path / "render"
        render_dir.mkdir()
        blocks_dir = tmp_path / "compile" / "blocks"
        blocks_dir.mkdir(parents=True)

        (render_dir / "wrong.py").write_text(
            textwrap.dedent("""\
                from reporting_agent.compile.blocks.base import NO_DATA_TEXT

                def emit(msg):
                    pass

                def render():
                    emit(NO_DATA_TEXT)
            """),
            encoding="utf-8",
        )
        (blocks_dir / "__init__.py").write_text("", encoding="utf-8")

        offenders = run_id_resolution_guard(
            render_root=render_dir,
            compile_blocks_root=blocks_dir,
            base=tmp_path,
        )
        assert len(offenders) == 1
        assert "NO_DATA_TEXT" in offenders[0][2]

    def test_detects_locally_defined_id_used_raw(self, tmp_path: Path) -> None:
        """A locally-defined Final[str] with a valid id value used outside .text() is
        caught even without an import from blocks/base."""
        render_dir = tmp_path / "render"
        render_dir.mkdir()
        blocks_dir = tmp_path / "compile" / "blocks"
        blocks_dir.mkdir(parents=True)

        (render_dir / "local.py").write_text(
            textwrap.dedent("""\
                from typing import Final

                MY_NOTICE_TEXT: Final[str] = "doc.notice.custom"

                def render():
                    print(MY_NOTICE_TEXT)
            """),
            encoding="utf-8",
        )
        (blocks_dir / "__init__.py").write_text("", encoding="utf-8")

        offenders = run_id_resolution_guard(
            render_root=render_dir,
            compile_blocks_root=blocks_dir,
            base=tmp_path,
        )
        assert len(offenders) == 1
        assert "MY_NOTICE_TEXT" in offenders[0][2]

    def test_multiple_violations_reported(self, tmp_path: Path) -> None:
        """All violations are reported, not just the first."""
        render_dir = tmp_path / "render"
        render_dir.mkdir()
        blocks_dir = tmp_path / "compile" / "blocks"
        blocks_dir.mkdir(parents=True)

        (render_dir / "multi.py").write_text(
            textwrap.dedent("""\
                from reporting_agent.compile.blocks.base import (
                    EMPTY_SCOPE_TEXT,
                    NOTICE_COLUMN_HEADER,
                )

                def bad():
                    x = EMPTY_SCOPE_TEXT
                    y = NOTICE_COLUMN_HEADER
            """),
            encoding="utf-8",
        )
        (blocks_dir / "__init__.py").write_text("", encoding="utf-8")

        offenders = run_id_resolution_guard(
            render_root=render_dir,
            compile_blocks_root=blocks_dir,
            base=tmp_path,
        )
        assert len(offenders) == 2
        names = {o[2] for o in offenders}
        assert any("EMPTY_SCOPE_TEXT" in n for n in names)
        assert any("NOTICE_COLUMN_HEADER" in n for n in names)
