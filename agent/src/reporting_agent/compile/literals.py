"""Build-time guard: no English literal reaches a text-emitting position in the render or
compile/blocks trees (Req 15.2, 15.6).

## Why this lives in ``compile/`` and not in ``render/`` or at the package root

The guard enforces the compile-layer contract that every user-visible string at a
text-emitting site is a declared message-catalog id resolved through
``compile/messages.py``.  It is the **enforcement** counterpart to ``messages.py``, and
it scans the AST declarations in ``compile/ast.py`` to guard itself.  It belongs to the
compile package because the message catalog is a compile-time concept: strings are
resolved at compile time and the AST carries resolved strings.

The scan targets ``render/**`` and ``compile/blocks/**``.  This module imports **neither**
at runtime — it performs a static AST walk over their source files using the standard
``ast`` module.  And neither imports it: it is invoked only from the Dockerfile's
``--assert-build`` line and from the test wrapper in ``tests/test_message_literals.py``.

## Why it lives in ``src/`` and not in ``tests/``

Two reasons, identical to those documented in ``catalog/evidence.py``:

* ``.dockerignore`` excludes ``tests/**``, and criterion 15.6 requires the guard to run in
  the image build.  A guard that only ran in the suite could not stop an image carrying
  English copy in an Indonesian document.
* ``tests/test_message_literals.py`` imports this module, so the suite and the build check
  share one implementation.

## What this asserts

1. A **declared set** of text-emitting sites as ``(callable_name, parameter)`` pairs.
2. Module-level ``Final[str]`` names matching ``_(TEXT|LABEL|HEADER|CAPTION|NOTICE|TITLE)$``
   must hold a declared string id — or ``""``.
3. Every ``str`` ``ast.Constant`` at a declared call site must be a declared string id — or
   ``""``.
4. **The guard guards itself**: every dataclass in ``compile/ast.py`` carrying a ``str``
   field named ``text``, ``header``, ``caption``, ``label`` or ``title`` appears in the
   declared emitting set, so a new emitting site added without registering it fails the
   suite.

## Invocation

    python -m reporting_agent.compile.literals --assert-build
"""

from __future__ import annotations

import ast
import re
import sys
from pathlib import Path
from typing import Final, Sequence

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------
# In a checkout: this file is at agent/src/reporting_agent/compile/literals.py.
# SRC_ROOT is agent/src/reporting_agent/.
# In the Docker image: the working directory is /app, source at /app/reporting_agent/.
# Both entry paths resolve via the package's own location — never by probing.
_THIS_DIR = Path(__file__).resolve().parent  # compile/
SRC_ROOT: Final[Path] = _THIS_DIR.parent  # reporting_agent/

COMPILE_BLOCKS_ROOT: Final[Path] = SRC_ROOT / "compile" / "blocks"
RENDER_ROOT: Final[Path] = SRC_ROOT / "render"
AST_MODULE: Final[Path] = SRC_ROOT / "compile" / "ast.py"

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


def is_valid_string_id_or_empty(value: str) -> bool:
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
            if isinstance(kw.value, ast.Constant) and isinstance(kw.value.value, str):
                results.append(kw.value)
    return results


# ---------------------------------------------------------------------------
# Scan logic
# ---------------------------------------------------------------------------

Offender = tuple[str, int, str]  # (relative_path_or_abs, line, detail)


def _scan_call_sites(tree: ast.AST, path: Path, *, base: Path) -> list[Offender]:
    """Find string constants at declared text-emitting call sites that are not valid ids."""
    offenders: list[Offender] = []
    try:
        rel = path.relative_to(base).as_posix()
    except ValueError:
        rel = str(path)

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
                if not is_valid_string_id_or_empty(const.value):
                    offenders.append(
                        (rel, const.lineno, f"{callable_name}({param}=) literal {const.value!r}")
                    )

    return offenders


def _scan_dot_text_assignments(tree: ast.AST, path: Path, *, base: Path) -> list[Offender]:
    """Find `.text = <string literal>` assignments (python-docx run.text = ...)."""
    offenders: list[Offender] = []
    try:
        rel = path.relative_to(base).as_posix()
    except ValueError:
        rel = str(path)

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
                if not is_valid_string_id_or_empty(value):
                    offenders.append(
                        (rel, node.lineno, f".text = {value!r}")
                    )

    return offenders


def _scan_final_str_names(tree: ast.AST, path: Path, *, base: Path) -> list[Offender]:
    """Find module-level Final[str] names matching the naming pattern whose value is not a valid id."""
    offenders: list[Offender] = []
    try:
        rel = path.relative_to(base).as_posix()
    except ValueError:
        rel = str(path)

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
            if isinstance(ann.value, ast.Name) and ann.value.id == "Final":
                if isinstance(ann.slice, ast.Name) and ann.slice.id == "str":
                    is_final_str = True
        if not is_final_str:
            continue

        # Check the value
        if node.value is None:
            continue
        value_str = _extract_string_value(node.value)
        if value_str is not None and not is_valid_string_id_or_empty(value_str):
            offenders.append(
                (rel, node.lineno, f"Final[str] {name} = {value_str!r}")
            )

    return offenders


def _extract_string_value(node: ast.expr) -> str | None:
    """Extract a plain string from a Constant or a parenthesized string."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    return None


# ---------------------------------------------------------------------------
# The guard guards itself
# ---------------------------------------------------------------------------


def ast_dataclass_str_fields(ast_module: Path | None = None) -> set[tuple[str, str]]:
    """All (ClassName, field_name) pairs from compile/ast.py dataclasses where the field
    is named text/header/caption/label/title and annotated with a type containing `str`."""
    module_path = ast_module or AST_MODULE
    tree = _parse(module_path)
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
# The main scan — usable from both the test wrapper and the --assert-build CLI
# ---------------------------------------------------------------------------


def run_guard(
    *,
    render_root: Path | None = None,
    compile_blocks_root: Path | None = None,
    base: Path | None = None,
) -> list[Offender]:
    """Run the full literal guard over render/** and compile/blocks/**.

    Parameters allow overriding roots for testing against fixture directories.
    """
    r_root = render_root or RENDER_ROOT
    cb_root = compile_blocks_root or COMPILE_BLOCKS_ROOT
    resolve_base = base or SRC_ROOT.parent  # agent/ in checkout, /app in image

    all_offenders: list[Offender] = []

    files: list[Path] = []
    for d in [r_root, cb_root]:
        if d.is_dir():
            files.extend(_source_files(d))

    if not files:
        raise RuntimeError(
            f"The literal guard found no Python files under {[r_root, cb_root]}. "
            "This means it cannot guard anything — the scan must not pass vacuously."
        )

    for path in files:
        tree = _parse(path)
        all_offenders.extend(_scan_call_sites(tree, path, base=resolve_base))
        all_offenders.extend(_scan_dot_text_assignments(tree, path, base=resolve_base))
        all_offenders.extend(_scan_final_str_names(tree, path, base=resolve_base))

    return all_offenders


def check_self_guard(ast_module: Path | None = None) -> list[tuple[str, str]]:
    """Return (ClassName, field_name) pairs in compile/ast.py not covered by the declared set."""
    ast_fields = ast_dataclass_str_fields(ast_module)

    declared_class_fields: set[tuple[str, str]] = set()
    for callable_name, param in DECLARED_EMITTING_SITES:
        if isinstance(param, str):
            declared_class_fields.add((callable_name, param))

    excluded_class_fields: set[tuple[str, str]] = set()
    for callable_name, param in _EXCLUDED_SITES:
        if isinstance(param, str):
            excluded_class_fields.add((callable_name, param))

    missing = ast_fields - declared_class_fields - excluded_class_fields
    return sorted(missing)


# ---------------------------------------------------------------------------
# CLI entry point for Dockerfile --assert-build
# ---------------------------------------------------------------------------


def _main(argv: Sequence[str]) -> int:
    """`python -m reporting_agent.compile.literals --assert-build` (Req 15.2, 15.6).

    The same entry-point shape `compile/ast.py`, `render/themes.py` and
    `catalog/evidence.py` use, so the Dockerfile's build guards read identically.
    """
    if "--assert-build" not in argv:
        print(
            "usage: python -m reporting_agent.compile.literals --assert-build",
            file=sys.stderr,
        )
        return 2

    # Self-guard first
    missing = check_self_guard()
    if missing:
        lines = [f"  {cls}.{field}" for cls, field in missing]
        print(
            f"FAIL: {len(missing)} unregistered emitting site(s) in compile/ast.py:\n"
            + "\n".join(lines),
            file=sys.stderr,
        )
        return 1

    # Literal scan
    offenders = run_guard()
    if offenders:
        lines = [f"  {path}:{line}: {detail}" for path, line, detail in offenders]
        print(
            f"FAIL: {len(offenders)} English literal(s) at text-emitting sites:\n"
            + "\n".join(lines),
            file=sys.stderr,
        )
        return 1

    # Count files scanned
    render_count = len(_source_files(RENDER_ROOT)) if RENDER_ROOT.is_dir() else 0
    blocks_count = len(_source_files(COMPILE_BLOCKS_ROOT)) if COMPILE_BLOCKS_ROOT.is_dir() else 0
    print(
        f"literal guard ok: scanned {render_count + blocks_count} files, 0 offenders."
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through the Dockerfile
    raise SystemExit(_main(sys.argv[1:]))
