"""Cross-lock consistency guard: one version per package across both lock files.

Two locks are committed, and they overlap almost completely — `requirements-dev.lock`
covers the `[dependency-groups] dev` group **plus** the project's own dependencies,
because a test suite needs the code under test. So every package in
`requirements.lock` also appears in `requirements-dev.lock`, and the two must name the
**same version** for it. Otherwise the closure developers test against is not the
closure the arm64 image runs (`Dockerfile` installs `requirements.lock` with
`--require-hashes`, and nothing else).

**This test replaces a README instruction.** The old rule was procedural — install
`requirements-dev.lock` first and `requirements.lock` last, so the runtime pins won
locally — and it depended on every developer remembering the order, in a repo with no
task runner to encode it. Worse, it only papered over the skew in one venv: the two
files stayed disagreeing on disk, and the next `uv pip compile` would reintroduce more
of it, because uv reads an existing output file as **resolution preferences** and will
happily leave one lock a patch release behind the other indefinitely. That is exactly
how the four-package skew this guard was written for came about
(`botocore`, `charset-normalizer`, `typing-inspection`, `uvicorn`).

The structural fix is on the regeneration side: `requirements.lock` is compiled with
`--constraint requirements-dev.lock`, so agreement is a property of how the files are
produced (see README.md, "Dependency locking"). This test is what notices when someone
regenerates without it, or hand-edits a pin — neither of which is visible in a diff of
900 hash lines.

Second invariant asserted here, for the same reason it is asserted in `pyproject.toml`
and `.dockerignore`: **the dev tools never ship.** `pytest`, `hypothesis` and `ruff`
are in the dev lock and must be absent from the runtime lock.

Both files are **parsed**, not pattern-matched loosely, and the parse is asserted to be
non-vacuous: a parser that silently matches nothing would let every assertion below
pass on an empty set, which is the failure mode this whole module exists to avoid.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

AGENT_ROOT = Path(__file__).resolve().parent.parent
RUNTIME_LOCK = AGENT_ROOT / "requirements.lock"
DEV_LOCK = AGENT_ROOT / "requirements-dev.lock"

# The dev group from pyproject.toml. Dev-only by construction: the image installs the
# runtime closure only, so these three must never appear in requirements.lock.
DEV_ONLY_TOOLS = ("pytest", "hypothesis", "ruff")

# A pin line, at column 0. uv emits three shapes and all three must parse:
#     name==version \
#     name==version
#     name==version ; platform_python_implementation != 'PyPy' \
# The trailing backslash continues into indented `--hash=sha256:...` lines, and the
# environment marker is metadata about *where* the pin applies, not part of the version.
PIN = re.compile(
    r"""^
    (?P<name>[A-Za-z0-9][A-Za-z0-9._-]*)   # PEP 508 name
    ==
    (?P<version>[^\s;\\]+)                 # the pinned version, nothing else
    (?:\s*;[^\\]*)?                        # optional environment marker
    \s*\\?                                 # optional line continuation
    $""",
    re.VERBOSE,
)


def _normalize(name: str) -> str:
    """PEP 503 normalization, so `typing_extensions` and `typing-extensions` are one key."""
    return re.sub(r"[-_.]+", "-", name).lower()


def _parse_lock(path: Path) -> dict[str, str]:
    """`{normalized name: version}` for one lock file.

    Skipped, deliberately and by shape rather than by guessing: blank lines, comments
    (including uv's `# via ...` annotation blocks), and every line whose first
    non-whitespace character is `-` — which covers both `--index-url` and the indented
    `--hash=sha256:...` continuations. Anything left at column 0 must be a pin; a line
    that is not is a parse failure, not something to ignore quietly.
    """
    pins: dict[str, str] = {}
    unparsed: list[str] = []
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = raw.strip()
        if not stripped or stripped.startswith("#") or stripped.startswith("-"):
            continue
        match = PIN.match(raw)
        if match is None:
            unparsed.append(f"{path.name}:{lineno} {raw!r}")
            continue
        pins[_normalize(match.group("name"))] = match.group("version")
    assert not unparsed, (
        "the lock parser did not understand these lines; fix the parser rather than "
        "loosening it, or the guards in this module pass on a partial set:\n  "
        + "\n  ".join(unparsed)
    )
    return pins


def _runtime_pins() -> dict[str, str]:
    return _parse_lock(RUNTIME_LOCK)


def _dev_pins() -> dict[str, str]:
    return _parse_lock(DEV_LOCK)


def _skew(runtime: dict[str, str], dev: dict[str, str]) -> list[str]:
    """Every package the two locks disagree about, naming the package and both versions."""
    return [
        f"{name}: {RUNTIME_LOCK.name}=={runtime[name]} vs {DEV_LOCK.name}=={dev[name]}"
        for name in sorted(runtime.keys() & dev.keys())
        if runtime[name] != dev[name]
    ]


# --------------------------------------------------------------------------- #
# The parse is non-vacuous — asserted first, because everything else rests on it
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("path", [RUNTIME_LOCK, DEV_LOCK], ids=lambda p: p.name)
def test_both_locks_exist_and_parse_to_pins(path: Path) -> None:
    """A guard that passes by parsing nothing is the failure mode to rule out first."""
    assert path.is_file(), f"{path} is missing"
    pins = _parse_lock(path)
    assert pins, f"{path.name} parsed to zero pins; the parser or the file is wrong"


def test_the_two_locks_overlap_non_trivially() -> None:
    """The dev lock covers the project's own dependencies, so the overlap is the point.

    An empty intersection would mean the consistency check below compares nothing —
    green, and proving the opposite of what it claims.
    """
    shared = _runtime_pins().keys() & _dev_pins().keys()
    assert len(shared) > 1, (
        "requirements.lock and requirements-dev.lock share almost their whole closure; "
        f"an intersection of {sorted(shared)} means one file failed to parse properly"
    )


# --------------------------------------------------------------------------- #
# The invariant: one version per package, across both files
# --------------------------------------------------------------------------- #


def test_shared_packages_are_pinned_to_the_same_version() -> None:
    """The closure the suite runs against is the closure the image runs."""
    skew = _skew(_runtime_pins(), _dev_pins())
    assert not skew, (
        "these packages are pinned to different versions in the two locks, so the "
        "tested closure and the shipped closure disagree. Do not hand-edit either "
        "file: regenerate both as README.md's 'Dependency locking' section shows "
        "(requirements.lock is compiled with --constraint requirements-dev.lock, "
        "which is what makes agreement reproducible):\n  " + "\n  ".join(skew)
    )


# --------------------------------------------------------------------------- #
# The standing invariant: the dev tools never ship
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("tool", DEV_ONLY_TOOLS)
def test_dev_tools_are_pinned_in_the_dev_lock(tool: str) -> None:
    assert tool in _dev_pins(), f"{tool} must be pinned in {DEV_LOCK.name}"


@pytest.mark.parametrize("tool", DEV_ONLY_TOOLS)
def test_dev_tools_are_absent_from_the_runtime_lock(tool: str) -> None:
    """The image installs the runtime closure only — pytest, hypothesis and ruff never ship."""
    pins = _runtime_pins()
    assert tool not in pins, (
        f"{tool}=={pins[tool]} is in {RUNTIME_LOCK.name}, which the Dockerfile installs "
        "into the image. It belongs to [dependency-groups] dev and to "
        f"{DEV_LOCK.name} only"
    )


# --------------------------------------------------------------------------- #
# Guard the guard — the parser against every line shape uv emits, on tmp_path
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("line", "expected"),
    [
        ("rfc8785==0.1.4", {"rfc8785": "0.1.4"}),
        ("boto3==1.43.51 \\", {"boto3": "1.43.51"}),
        (
            "cffi==2.1.1 ; platform_python_implementation != 'PyPy' \\",
            {"cffi": "2.1.1"},
        ),
        ("typing_extensions==4.15.0 \\", {"typing-extensions": "4.15.0"}),
        ("Azure-Core==1.41.0", {"azure-core": "1.41.0"}),
    ],
)
def test_the_parser_reads_every_pin_shape_uv_emits(
    line: str, expected: dict[str, str], tmp_path: Path
) -> None:
    lock = tmp_path / "requirements.lock"
    lock.write_text(
        "# This file was autogenerated by uv via the following command:\n"
        "--index-url https://pypi.org/simple\n"
        f"{line}\n"
        "    --hash=sha256:13b2beaad985e05e2d6407ee4c4f35590b11f8d693a258a561055cac8f64cab7 \\\n"
        "    --hash=sha256:f072f4d804ea359e4eaf198b1af7a8b0943881a87f31bb764f8bf219bb9419e0\n"
        "    # via\n"
        "    #   -c requirements-dev.lock\n"
        "    #   pydantic\n",
        encoding="utf-8",
    )
    assert _parse_lock(lock) == expected


def test_the_parser_rejects_a_line_it_does_not_understand(tmp_path: Path) -> None:
    """Silently skipping an unrecognized pin line is how a guard goes vacuous."""
    lock = tmp_path / "requirements.lock"
    lock.write_text("botocore>=1.43.70\n", encoding="utf-8")
    with pytest.raises(AssertionError, match="did not understand"):
        _parse_lock(lock)


def test_the_consistency_check_detects_a_skewed_pin() -> None:
    """The predicate must actually catch the disagreement it forbids, and name both sides.

    The versions here are the real skew this guard was written for, and the packages
    the two locks legitimately share.
    """
    runtime = {"botocore": "1.43.67", "httpx": "0.28.1"}
    dev = {"botocore": "1.43.70", "httpx": "0.28.1", "pytest": "9.1.1"}
    assert _skew(runtime, dev) == [
        "botocore: requirements.lock==1.43.67 vs requirements-dev.lock==1.43.70"
    ]
    assert _skew(runtime, runtime) == []
