"""Tests for the ``reporting_agent.compile.literals`` module's ``--assert-build`` entry point.

Verifies:
  (a) the real tree is currently clean (exit 0),
  (b) the scanner still detects offenders on a fixture tree carrying known violations,
  (c) the entry point refuses to run without ``--assert-build``.
"""

from __future__ import annotations

import os
import subprocess
import sys
import textwrap
from pathlib import Path


AGENT_ROOT: Path = Path(__file__).resolve().parent.parent
SRC_DIR: Path = AGENT_ROOT / "src"


class TestLiteralsEntryPoint:
    """The --assert-build CLI entry point (Req 15.2, 15.6)."""

    def _env(self) -> dict[str, str]:
        """Environment with PYTHONPATH set so the module is importable."""
        env = {**os.environ, "LANG": "C.UTF-8"}
        env["PYTHONPATH"] = str(SRC_DIR)
        return env

    def test_the_real_tree_is_clean(self) -> None:
        """After the migration, the real tree carries zero offenders and exits 0."""
        result = subprocess.run(
            [
                sys.executable,
                "-m",
                "reporting_agent.compile.literals",
                "--assert-build",
            ],
            capture_output=True,
            text=True,
            cwd=str(AGENT_ROOT),
            env=self._env(),
        )

        assert result.returncode == 0, (
            f"Expected exit 0 (no offenders), got {result.returncode}.\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}"
        )
        assert "0 offenders" in result.stdout

    def test_the_scanner_detects_offenders_in_a_fixture_tree(self, tmp_path: Path) -> None:
        """Point the guard at a fixture tree carrying known English literals and confirm
        it reports each one with its file and line.

        This keeps both halves of the claim testable: the real tree is clean (above) AND the
        scanner is still capable of catching violations (here). A test that only asserts zero
        passes forever and proves nothing.
        """
        from reporting_agent.compile.literals import run_guard

        render_dir = tmp_path / "src" / "render"
        render_dir.mkdir(parents=True)
        blocks_dir = tmp_path / "src" / "compile" / "blocks"
        blocks_dir.mkdir(parents=True)

        # A render file carrying three violations matching the old offenders:
        # - A Final[str] name matching the pattern with a non-id value
        # - A direct add_paragraph with an English literal
        (render_dir / "charts.py").write_text(
            textwrap.dedent("""\
                from typing import Final
                EMPTY_CHART_TEXT: Final[str] = "This chart carries no plotted values"
                OTHER_SERIES_LABEL: Final[str] = "Other"
                def draw():
                    pass
            """),
            encoding="utf-8",
        )
        (render_dir / "docx.py").write_text(
            textwrap.dedent("""\
                from typing import Final
                PREVIEW_NOTICE_TEXT: Final[str] = "Preview — rendered from a stored snapshot."
            """),
            encoding="utf-8",
        )

        # A clean blocks file so the scan has both directories
        (blocks_dir / "base.py").write_text(
            textwrap.dedent("""\
                def compile_block():
                    pass
            """),
            encoding="utf-8",
        )

        offenders = run_guard(
            render_root=render_dir,
            compile_blocks_root=blocks_dir,
            base=tmp_path,
        )

        assert len(offenders) == 3, (
            f"Expected 3 offenders in fixture tree, got {len(offenders)}:\n"
            + "\n".join(f"  {p}:{l}: {d}" for p, l, d in offenders)
        )
        details = " ".join(d for _, _, d in offenders)
        assert "EMPTY_CHART_TEXT" in details
        assert "OTHER_SERIES_LABEL" in details
        assert "PREVIEW_NOTICE_TEXT" in details

    def test_entry_point_exits_zero_on_clean_tree(self, tmp_path: Path) -> None:
        """On a tree where every emitting site uses valid string ids, exit 0."""
        render_dir = tmp_path / "reporting_agent" / "render"
        render_dir.mkdir(parents=True)
        blocks_dir = tmp_path / "reporting_agent" / "compile" / "blocks"
        blocks_dir.mkdir(parents=True)

        ast_dir = tmp_path / "reporting_agent" / "compile"
        ast_dir.mkdir(parents=True, exist_ok=True)
        (ast_dir / "ast.py").write_text(
            textwrap.dedent("""\
                from dataclasses import dataclass

                @dataclass
                class Text:
                    text: str

                @dataclass
                class Column:
                    header: str

                @dataclass
                class Table:
                    caption: str

                @dataclass
                class Series:
                    label: str

                @dataclass
                class Chart:
                    title: str
                    caption: str

                @dataclass
                class TextCell:
                    text: str
            """),
            encoding="utf-8",
        )

        (render_dir / "example.py").write_text(
            textwrap.dedent("""\
                from typing import Final
                SOME_LABEL: Final[str] = "doc.chart.some_label"
                def render():
                    add_paragraph("doc.notice.empty_scope")
                    add_run("")
            """),
            encoding="utf-8",
        )

        (blocks_dir / "example.py").write_text(
            textwrap.dedent("""\
                def compile():
                    Column(header="doc.table.header_name")
                    Table(caption="doc.table.caption_resources")
            """),
            encoding="utf-8",
        )

        from reporting_agent.compile.literals import check_self_guard, run_guard

        offenders = run_guard(
            render_root=render_dir,
            compile_blocks_root=blocks_dir,
            base=tmp_path,
        )
        assert offenders == [], f"Expected zero offenders on a clean tree, got: {offenders}"

        missing = check_self_guard(ast_module=ast_dir / "ast.py")
        assert missing == [], f"Self-guard should pass on fixture, got: {missing}"

    def test_entry_point_requires_assert_build_flag(self) -> None:
        """Without --assert-build, the entry point prints usage and exits 2."""
        result = subprocess.run(
            [sys.executable, "-m", "reporting_agent.compile.literals"],
            capture_output=True,
            text=True,
            cwd=str(AGENT_ROOT),
            env=self._env(),
        )
        assert result.returncode == 2
        assert "usage" in result.stderr.lower()
