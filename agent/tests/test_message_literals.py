"""Guard: no English literal reaches a text-emitting position in the render or compile/blocks
trees (Req 15.2, 15.6).

Thin wrapper over ``reporting_agent.compile.literals``, which holds the scan implementation
and the ``--assert-build`` entry point.  The suite and the Dockerfile check one
implementation.
"""

from __future__ import annotations

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
