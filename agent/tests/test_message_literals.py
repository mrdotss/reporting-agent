"""Guard: no English literal reaches a text-emitting position in the render or compile/blocks
trees (Req 15.2, 15.6).

Scans ``agent/.../render/**`` AND ``agent/.../compile/blocks/**``.  The second is the design's
recorded **narrowing** of criterion 15.6: scanning only ``render/`` would leave
``EMPTY_SCOPE_TEXT`` and every ``Column(header=...)`` untouched by the guard that exists to
catch them.

The guard asserts four things:

1. A **declared set** of text-emitting sites as ``(callable_name, parameter)`` pairs.
2. Module-level ``Final[str]`` names matching ``_(TEXT|LABEL|HEADER|CAPTION|NOTICE|TITLE)$``
   must hold a declared string id — or ``""``.
3. Every ``str`` ``ast.Constant`` at a declared call site must be a declared string id — or
   ``""``.
4. **The guard guards itself**: every dataclass in ``compile/ast.py`` carrying a ``str`` field
   named ``text``, ``header``, ``caption``, ``label`` or ``title`` appears in the declared
   emitting set, so a new emitting site added without registering it fails the suite.

Invokable as ``python -m tests.test_message_literals --assert-build`` from the Dockerfile
(since ``.dockerignore`` excludes ``tests/`` as a pytest-discovered tree but the guard must
still stop an image carrying English copy in an Indonesian document).
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path
from typing import Final

import pytest

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

# In a checkout: tests/ is one level below agent/, and source is at agent/src/reporting_agent/.
# In the Docker image: the working directory is /app, source at /app/reporting_agent/, and
# this file is COPY'd to /app/tests/test_message_literals.py.
AGENT_ROOT = Path(__file__).resolve().parent.parent
_CHECKOUT_SRC = AGENT_ROOT / "src" / "reporting_agent"
_IMAGE_SRC = Path("/app/reporting_agent")

# Resolve: use checkout path if it exists, else image path.
SRC_ROOT: Path = _CHECKOUT_SRC if _CHECKOUT_SRC.is_dir() else _IMAGE_SRC
COMPILE_BLOCKS_ROOT = SRC_ROOT / "compile" / "blocks"
RENDER_ROOT = SRC_ROOT / "render"
AST_MODULE = SRC_ROOT / "compile" / "ast.py"

# ---------------------------------------------------------------------------
# The declared set of text-emitting sites
# ---------------------------------------------------------------------------

# (callable_name, parameter_name_or_position) pairs.
# Parameter is a keyword name for keyword arguments, or an int for positional.
DECLARED_EMITTING_SITES: Final[frozenset[tuple[str, str | int]]] = frozenset(
    {
        ("Text", "text"),
        ("TextCell", "text"),
        ("Column", "header"),
        ("Table", "caption"),
        ("Series", "label"),
        ("Chart", "title"),
        ("Chart", "caption"),
        ("add_paragraph", 0),
        ("add_run", 0),
        # Assignment to `.text` on a python-docx run is handled separately.
    }
)

# Callables whose parameter represents a style id, not copy.  Excluded.
_EXCLUDED_SITES: Final[frozenset[tuple[str, str | int]]] = frozenset(
    {
        ("Paragraph", "style"),
    }
)

# ---------------------------------------------------------------------------
# The module-level Final[str] name pattern
# ---------------------------------------------------------------------------

_FINAL_NAME_RE: Final[re.Pattern[str]] = re.compile(
    r"_(TEXT|LABEL|HEADER|CAPTION|NOTICE|TITLE)$"
)

# ---------------------------------------------------------------------------
# The MESSAGE_ID_PATTERN — what a valid string id looks like.
# Matches the pattern declared in messages/__init__.py.
# ---------------------------------------------------------------------------

_MESSAGE_ID_RE: Final[re.Pattern[str]] = re.compile(
    r"^(doc|chart|ui)\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"
)


def _is_valid_string_id_or_empty(value: str) -> bool:
    """A value passes if it is either the empty string or a well-formed string id."""
    return value == "" or bool(_MESSAGE_ID_RE.match(value))


# ---------------------------------------------------------------------------
# AST helpers
# ---------------------------------------------------------------------------


def _source_files(root: Path) -> list[Path]:
    """All .py files under *root*, recursively, sorted for determinism."""
    return sorted(root.rglob("*.py"))


def _parse(path: Path) -> ast.AST:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _callable_name(node: ast.expr) -> str | None:
    """Extract the unqualified callable name from a Call's func node."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _positional_string_constants(call: ast.Call, pos: int) -> list[ast.Constant]:
    """String constants at positional argument *pos* of a Call."""
    results: list[ast.Constant] = []
    if pos < len(call.args):
        arg = call.args[pos]
        if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
            results.append(arg)
    return results


def _keyword_string_constants(call: ast.Call, name: str) -> list[ast.Constant]:
    """String constants at keyword argument *name* of a Call."""
    results: list[ast.Constant] = []
    for kw in call.keywords:
        if kw.arg == name:
            if isinstance(kw.value, ast.Constant) and isinstance(kw.value, ast.Constant):
                if isinstance(kw.value.value, str):
                    results.append(kw.value)
    return results


# ---------------------------------------------------------------------------
# Scan logic
# ---------------------------------------------------------------------------

Offender = tuple[str, int, str]  # (relative_path, line, detail)


def _scan_call_sites(tree: ast.AST, path: Path) -> list[Offender]:
    """Find string constants at declared text-emitting call sites that are not valid ids."""
    offenders: list[Offender] = []
    rel = path.relative_to(AGENT_ROOT).as_posix()

    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue

        func_name = _callable_name(node.func)
        if func_name is None:
            continue

        for callable_name, param in DECLARED_EMITTING_SITES:
            if func_name != callable_name:
                continue
            if isinstance(param, int):
                constants = _positional_string_constants(node, param)
            else:
                constants = _keyword_string_constants(node, param)

            for const in constants:
                if not _is_valid_string_id_or_empty(const.value):
                    offenders.append(
                        (rel, const.lineno, f"{callable_name}({param}=) literal {const.value!r}")
                    )

    return offenders


def _scan_dot_text_assignments(tree: ast.AST, path: Path) -> list[Offender]:
    """Find `.text = <string literal>` assignments (python-docx run.text = ...)."""
    offenders: list[Offender] = []
    rel = path.relative_to(AGENT_ROOT).as_posix()

    for node in ast.walk(tree):
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if (
                isinstance(target, ast.Attribute)
                and target.attr == "text"
                and isinstance(node.value, ast.Constant)
                and isinstance(node.value.value, str)
            ):
                value = node.value.value
                if not _is_valid_string_id_or_empty(value):
                    offenders.append(
                        (rel, node.lineno, f".text = {value!r}")
                    )

    return offenders


def _scan_final_str_names(tree: ast.AST, path: Path) -> list[Offender]:
    """Find module-level Final[str] names matching the naming pattern whose value is not a valid id."""
    offenders: list[Offender] = []
    rel = path.relative_to(AGENT_ROOT).as_posix()

    for node in ast.iter_child_nodes(tree):
        # Module-level annotated assignments: NAME: Final[str] = "..."
        if not isinstance(node, ast.AnnAssign):
            continue
        if not isinstance(node.target, ast.Name):
            continue
        name = node.target.id
        if not _FINAL_NAME_RE.search(name):
            continue

        # Check annotation is Final[str]
        ann = node.annotation
        is_final_str = False
        if isinstance(ann, ast.Subscript):
            # Final[str]
            if isinstance(ann.value, ast.Name) and ann.value.id == "Final":
                if isinstance(ann.slice, ast.Name) and ann.slice.id == "str":
                    is_final_str = True
        if not is_final_str:
            continue

        # Check the value
        if node.value is None:
            continue
        # May be a Constant or a parenthesized expression
        value_str = _extract_string_value(node.value)
        if value_str is not None and not _is_valid_string_id_or_empty(value_str):
            offenders.append(
                (rel, node.lineno, f"Final[str] {name} = {value_str!r}")
            )

    return offenders


def _extract_string_value(node: ast.expr) -> str | None:
    """Extract a plain string from a Constant or a parenthesized string (concat)."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    # Handle parenthesized string concatenation: ("abc" "def")
    if isinstance(node, ast.JoinedStr):
        return None  # f-string, not a constant
    # Handle implicit string concatenation in a tuple wrapper (rare)
    return None


# ---------------------------------------------------------------------------
# The guard guards itself
# ---------------------------------------------------------------------------


def _ast_dataclass_str_fields() -> set[tuple[str, str]]:
    """All (ClassName, field_name) pairs from compile/ast.py dataclasses where the field
    is named text/header/caption/label/title and annotated with a type containing `str`."""
    tree = _parse(AST_MODULE)
    target_field_names = {"text", "header", "caption", "label", "title"}
    results: set[tuple[str, str]] = set()

    for node in ast.walk(tree):
        if not isinstance(node, ast.ClassDef):
            continue
        # Check for @dataclass decorator
        is_dataclass = any(
            (isinstance(d, ast.Name) and d.id == "dataclass")
            or (
                isinstance(d, ast.Call)
                and isinstance(d.func, ast.Name)
                and d.func.id == "dataclass"
            )
            or (
                isinstance(d, ast.Call)
                and isinstance(d.func, ast.Attribute)
                and d.func.attr == "dataclass"
            )
            for d in node.decorator_list
        )
        if not is_dataclass:
            continue

        for item in node.body:
            if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name):
                field_name = item.target.id
                if field_name not in target_field_names:
                    continue
                # Check annotation contains `str`
                ann_str = ast.unparse(item.annotation)
                if "str" in ann_str:
                    results.add((node.name, field_name))

    return results


# ---------------------------------------------------------------------------
# The main scan
# ---------------------------------------------------------------------------


def run_guard() -> list[Offender]:
    """Run the full literal guard over render/** and compile/blocks/**."""
    all_offenders: list[Offender] = []
    scanned_dirs = [RENDER_ROOT, COMPILE_BLOCKS_ROOT]

    files: list[Path] = []
    for d in scanned_dirs:
        if d.is_dir():
            files.extend(_source_files(d))

    if not files:
        raise RuntimeError(
            f"The literal guard found no Python files under {scanned_dirs}. "
            "This means it cannot guard anything — the scan must not pass vacuously."
        )

    for path in files:
        tree = _parse(path)
        all_offenders.extend(_scan_call_sites(tree, path))
        all_offenders.extend(_scan_dot_text_assignments(tree, path))
        all_offenders.extend(_scan_final_str_names(tree, path))

    return all_offenders


# ---------------------------------------------------------------------------
# pytest tests
# ---------------------------------------------------------------------------


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
        ast_fields = _ast_dataclass_str_fields()

        # Build the set of (ClassName, field_name) from our declared emitting sites
        declared_class_fields: set[tuple[str, str]] = set()
        for callable_name, param in DECLARED_EMITTING_SITES:
            if isinstance(param, str):
                declared_class_fields.add((callable_name, param))

        # Exclude the explicitly excluded sites
        excluded_class_fields: set[tuple[str, str]] = set()
        for callable_name, param in _EXCLUDED_SITES:
            if isinstance(param, str):
                excluded_class_fields.add((callable_name, param))

        # Every ast.py dataclass field must be in declared OR excluded
        missing = ast_fields - declared_class_fields - excluded_class_fields
        if missing:
            lines = [f"  {cls}.{field}" for cls, field in sorted(missing)]
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
        assert _is_valid_string_id_or_empty("")
        assert _is_valid_string_id_or_empty("doc.notice.empty_scope")
        assert _is_valid_string_id_or_empty("chart.axis.resource")
        assert _is_valid_string_id_or_empty("ui.report.title")

    def test_scan_flags_english_literals(self) -> None:
        """Sanity check: English text is not a valid string id."""
        assert not _is_valid_string_id_or_empty("Series")
        assert not _is_valid_string_id_or_empty("Point")
        assert not _is_valid_string_id_or_empty("Other")
        assert not _is_valid_string_id_or_empty("This chart carries no plotted values")
        assert not _is_valid_string_id_or_empty(
            "Preview — rendered from a stored snapshot. Not a verified deliverable."
        )


# ---------------------------------------------------------------------------
# CLI entry point for Dockerfile --assert-build
# ---------------------------------------------------------------------------


def _main() -> None:
    """Run the guard as a build-time assertion."""
    if "--assert-build" not in sys.argv:
        print("Usage: python -m tests.test_message_literals --assert-build", file=sys.stderr)
        sys.exit(1)

    offenders = run_guard()

    # Also run the self-guard
    ast_fields = _ast_dataclass_str_fields()
    declared_class_fields: set[tuple[str, str]] = set()
    for callable_name, param in DECLARED_EMITTING_SITES:
        if isinstance(param, str):
            declared_class_fields.add((callable_name, param))
    excluded_class_fields: set[tuple[str, str]] = set()
    for callable_name, param in _EXCLUDED_SITES:
        if isinstance(param, str):
            excluded_class_fields.add((callable_name, param))
    missing = ast_fields - declared_class_fields - excluded_class_fields
    if missing:
        lines = [f"  {cls}.{field}" for cls, field in sorted(missing)]
        print(
            f"FAIL: {len(missing)} unregistered emitting site(s) in compile/ast.py:\n"
            + "\n".join(lines),
            file=sys.stderr,
        )
        sys.exit(1)

    if offenders:
        lines = [f"  {path}:{line}: {detail}" for path, line, detail in offenders]
        print(
            f"FAIL: {len(offenders)} English literal(s) at text-emitting sites:\n"
            + "\n".join(lines),
            file=sys.stderr,
        )
        sys.exit(1)

    print(
        f"OK: literal guard passed — scanned {len(_source_files(RENDER_ROOT)) + len(_source_files(COMPILE_BLOCKS_ROOT))} "
        f"files, 0 offenders."
    )


if __name__ == "__main__":
    _main()
