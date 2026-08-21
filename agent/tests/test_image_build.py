"""The image's build-time contract (Req 8.7, 23.2, 23.5, 23.10).

A `docker build` is not available in this suite, so these tests assert the properties of
the **Dockerfile and README as source** — that the packages are named, the profile is
warmed, the four assertions are present, and every documented build line names the
platform. That is a weaker check than building the image and a much stronger one than
nothing: every failure mode below is a line somebody deletes or forgets to add, and each
would otherwise surface as a broken deployed runtime rather than as a red suite.

What this deliberately does **not** claim: that the image builds, that LibreOffice
converts, or that the profile warms. Those need a daemon and an arm64 target.
`tests/test_pdf.py` covers the conversion itself against the locally installed
LibreOffice, and the build assertions cover the image.

## Why assert on text rather than parse the Dockerfile

There is no Dockerfile parser in the runtime closure and adding one to check four lines
would be a dependency bought for a test. The predicates below are therefore written to be
whitespace- and continuation-tolerant — the file is normalized to one logical line per
instruction first — so reformatting the Dockerfile does not fail them while deleting an
assertion does.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Final

import pytest

from reporting_agent.render.themes import THEME_SPECS

AGENT_ROOT: Final[Path] = Path(__file__).resolve().parent.parent
DOCKERFILE: Final[Path] = AGENT_ROOT / "Dockerfile"
DOCKERIGNORE: Final[Path] = AGENT_ROOT / ".dockerignore"
README: Final[Path] = AGENT_ROOT / "README.md"

PLATFORM_FLAG: Final[str] = "--platform linux/arm64"


def _logical_lines(path: Path) -> list[str]:
    """The file with line continuations joined and comments dropped.

    So an assertion can look for `apt-get install ... libreoffice-writer` without caring
    how the instruction is wrapped, and cannot be satisfied by a line that is commented
    out — which is the one false pass that would matter here.
    """
    joined = path.read_text().replace("\\\n", " ")
    lines: list[str] = []
    for raw in joined.splitlines():
        stripped = raw.strip()
        if not stripped or stripped.startswith("#"):
            continue
        lines.append(re.sub(r"\s+", " ", stripped))
    return lines


@pytest.fixture(scope="module")
def instructions() -> list[str]:
    return _logical_lines(DOCKERFILE)


@pytest.fixture(scope="module")
def dockerfile_body(instructions: list[str]) -> str:
    return "\n".join(instructions)


# --------------------------------------------------------------------------- #
# The packages (Req 23.2)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "package",
    [
        "libreoffice-writer",
        "libreoffice-core",
        "fonts-dejavu-core",
        "fonts-liberation2",
    ],
)
def test_the_image_installs_the_required_system_package(
    package: str, dockerfile_body: str
) -> None:
    """Req 23.2 — LibreOffice plus arm64 builds of the fonts the four themes reference."""
    install = [line for line in dockerfile_body.splitlines() if "apt-get install" in line]
    assert install, "no apt-get install instruction at all"
    assert any(package in line for line in install), package


def test_the_install_takes_no_recommends_and_cleans_the_apt_lists(
    dockerfile_body: str,
) -> None:
    """Without `--no-install-recommends` the Writer install pulls most of the suite; without
    the cleanup the apt lists stay in the layer for nothing."""
    assert "--no-install-recommends" in dockerfile_body
    assert "rm -rf /var/lib/apt/lists" in dockerfile_body


def test_the_image_installs_no_java_runtime(dockerfile_body: str) -> None:
    """A `docx` to `pdf` conversion needs the Writer import filter and the PDF export
    filter, neither of which is Java. Naming a JRE would add a large arm64 layer for
    features this product does not use."""
    assert "default-jre" not in dockerfile_body
    assert "libreoffice-java" not in dockerfile_body


def test_every_font_a_theme_names_is_installed_by_a_named_package(
    dockerfile_body: str,
) -> None:
    """The check that keeps `THEME_SPECS` and the apt line one decision.

    A theme naming a font the container lacks renders through LibreOffice's substitution,
    which changes line breaking and therefore pagination — so the delivered PDF would
    paginate differently from the one that was reviewed, silently.
    """
    supplied_by = {
        "Liberation Sans": "fonts-liberation2",
        "Liberation Serif": "fonts-liberation2",
        "Liberation Mono": "fonts-liberation2",
        "DejaVu Sans": "fonts-dejavu-core",
        "DejaVu Serif": "fonts-dejavu-core",
        "DejaVu Sans Mono": "fonts-dejavu-core",
    }

    named: set[str] = set()
    for spec in THEME_SPECS.values():
        named.update({spec.face.heading, spec.face.body, spec.face.figure})

    unaccounted = sorted(name for name in named if name not in supplied_by)
    assert unaccounted == [], (
        f"{unaccounted} are named by a theme and this test knows no package that supplies "
        f"them; add the package to the Dockerfile and the mapping here"
    )
    for font in sorted(named):
        assert supplied_by[font] in dockerfile_body, (font, supplied_by[font])


# --------------------------------------------------------------------------- #
# The environment and the pre-warmed profile (Req 23.3, 23.5)
# --------------------------------------------------------------------------- #


def test_the_image_sets_the_c_utf8_locale(dockerfile_body: str) -> None:
    """Req 23.3. A comma-decimal locale rewrites every numeral LibreOffice lays out, so the
    ledger's `formatted` strings stop being locatable in the PDF."""
    assert re.search(r"ENV .*LANG=C\.UTF-8", dockerfile_body), dockerfile_body


def test_the_image_declares_the_profile_location(dockerfile_body: str) -> None:
    assert re.search(r"ENV .*LO_PROFILE=/opt/libreoffice-profile", dockerfile_body)


def test_the_profile_is_warmed_with_a_real_headless_conversion(
    dockerfile_body: str,
) -> None:
    """Req 23.5 — warmed at build time, with `--norestore` and the profile named."""
    warm = [line for line in dockerfile_body.splitlines() if "soffice" in line]
    assert warm, "no soffice invocation in the build"
    line = warm[0]
    assert "--headless" in line
    assert "--norestore" in line
    assert '-env:UserInstallation="file://$LO_PROFILE"' in line
    assert "--convert-to pdf" in line


def test_the_warm_up_asserts_a_non_empty_output_and_cleans_up(
    dockerfile_body: str,
) -> None:
    """A warm-up whose output nobody checks is a warm-up that can silently not happen."""
    assert "test -s /tmp/warm/warm.pdf" in dockerfile_body
    assert "rm -rf /tmp/warm" in dockerfile_body


def test_the_warm_up_converts_a_document_built_through_the_real_path(
    dockerfile_body: str,
) -> None:
    """Warming with a `.txt` would exercise the plain-text import filter, which is not the
    filter a run uses. Converting a `python-docx` document built on a theme warms the Writer
    `.docx` import and the PDF export filter, which are — and proves at build time that the
    two libraries can hand a file between them."""
    assert "load_theme" in dockerfile_body
    assert "/tmp/warm/warm.docx" in dockerfile_body


def test_the_profile_is_group_writable_for_an_arbitrary_uid(dockerfile_body: str) -> None:
    """The profile is used at run time rather than copied, so whichever uid the runtime
    supplies has to be able to take LibreOffice's lock files inside it.

    Group 0 with group permissions mirroring the owner's works for root, for a named user
    and for an unnamed uid injected by the platform. A plain `chown` to one named user
    would work for that uid and fail for every other.
    """
    assert 'chgrp -R 0 "$LO_PROFILE"' in dockerfile_body
    assert 'chmod -R g=u "$LO_PROFILE"' in dockerfile_body


# --------------------------------------------------------------------------- #
# The build assertions (Req 8.7, 23.10)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "assertion",
    [
        "python -m reporting_agent.render.themes --assert-build",
        "python -m reporting_agent.compile.ast --assert-build",
        "python -m reporting_agent.catalog.evidence --assert-build",
    ],
)
def test_the_build_runs_the_guard(assertion: str, dockerfile_body: str) -> None:
    """Req 8.7, 23.10 and 2.6 — the build aborts and publishes nothing.

    All three guards live in `src/` precisely so they can run here: `.dockerignore` excludes
    `tests/**`, so a guard that only ran in the suite could not stop a bad image.

    The catalog guard is the one whose absence would be hardest to notice, because the
    defect it catches is silent at run time: Azure answers a request for a metric it does
    not have with a per-resource error, the collector records a typed gap, the run completes,
    verification passes, and the delivered document simply never mentions that metric.
    """
    assert assertion in dockerfile_body


def test_the_build_asserts_the_architecture(dockerfile_body: str) -> None:
    """Req 23.10. The mistake being guarded fails at runtime launch, not at build, which is
    the expensive place to discover it."""
    assert 'test "$(uname -m)" = "aarch64"' in dockerfile_body


def test_the_build_asserts_libreoffice_is_present_and_the_profile_is_populated(
    dockerfile_body: str,
) -> None:
    """Req 23.10 names all three: LibreOffice absent, architecture wrong, profile absent."""
    assert "command -v soffice" in dockerfile_body
    assert 'test -d "$LO_PROFILE"' in dockerfile_body
    assert 'test -n "$(ls -A "$LO_PROFILE")"' in dockerfile_body


def test_the_theme_guard_runs_after_the_themes_are_copied(instructions: list[str]) -> None:
    """Ordering is load-bearing: the guard opens the four documents, so a build that asserted
    before copying them would fail on every build for the wrong reason."""
    copy_index = next(
        index for index, line in enumerate(instructions) if line.startswith("COPY themes/")
    )
    guard_index = next(
        index
        for index, line in enumerate(instructions)
        if "render.themes --assert-build" in line
    )
    assert copy_index < guard_index, instructions


def test_the_profile_is_warmed_after_the_theme_guard(instructions: list[str]) -> None:
    """The warm-up opens a theme, so it depends on the themes being valid. Asserting first
    means a broken theme fails as a theme failure rather than as a conversion failure."""
    guard_index = next(
        index
        for index, line in enumerate(instructions)
        if "render.themes --assert-build" in line
    )
    warm_index = next(index for index, line in enumerate(instructions) if "soffice" in line)
    assert guard_index < warm_index, instructions


def test_the_apt_layer_precedes_the_dependency_layer(instructions: list[str]) -> None:
    """LibreOffice is the largest and least frequently changed layer in the image, so a
    dependency bump must not reinstall it."""
    apt_index = next(
        index for index, line in enumerate(instructions) if "apt-get install" in line
    )
    pip_index = next(index for index, line in enumerate(instructions) if "pip install" in line)
    assert apt_index < pip_index, instructions


# --------------------------------------------------------------------------- #
# The themes reach the image
# --------------------------------------------------------------------------- #


def test_the_build_copies_the_theme_directory(dockerfile_body: str) -> None:
    """`.dockerignore` works by exclusion, so `themes/` was already in the build context
    before this line existed — and therefore silently absent from the image."""
    assert re.search(r"COPY themes/ \./themes/", dockerfile_body)


def test_the_dockerignore_does_not_exclude_the_themes(dockerfile_body: str) -> None:
    excluded = {
        line.strip()
        for line in DOCKERIGNORE.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    }
    assert "themes/" not in excluded
    assert "*.docx" not in excluded


def test_the_dockerignore_still_excludes_the_tests_and_the_dev_closure() -> None:
    """The reason all three guards must be assertable from `src/` alone.

    The exclusion is written `tests/**` rather than `tests/`, and the distinction is
    load-bearing rather than stylistic: `.dockerignore` exceptions are last-match-wins **per
    path**, so excluding the *directory* makes its contents unreachable whatever follows,
    while excluding its *files* leaves a later `!` free to re-include exactly the ones the
    build needs. The Metric Definitions evidence is re-included on that basis — see the test
    below.
    """
    patterns = [
        line.strip()
        for line in DOCKERIGNORE.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]

    assert "tests/**" in patterns
    assert "tests/" not in patterns, (
        "`tests/` excludes the directory itself, which makes the evidence re-inclusion "
        "below unreachable no matter where it appears"
    )
    assert "requirements-dev.lock" in patterns


def test_the_dockerignore_re_includes_only_the_metric_definitions_evidence() -> None:
    """Req 2.6 — the guard runs in the build, so its evidence has to arrive.

    Two properties, and the order of the two patterns is one of them: the re-inclusion has to
    come **after** the exclusion, because the last matching pattern wins. Asserted by index
    rather than by presence, so reordering the file fails here instead of silently shipping
    an image whose catalog guard checks nothing.

    The re-inclusion is also asserted to be **narrow**. `!tests/` would re-include the whole
    suite — pytest fixtures, fakes, every test module — into the production image, which is
    the opposite of what the exclusion is for.
    """
    patterns = [
        line.strip()
        for line in DOCKERIGNORE.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]
    reinclusions = [pattern for pattern in patterns if pattern.startswith("!")]

    assert reinclusions == ["!tests/fixtures/metric_definitions/**"], (
        "exactly one re-inclusion, naming exactly the evidence: anything broader ships the "
        f"test suite into the image, got {reinclusions}"
    )
    assert patterns.index("tests/**") < patterns.index(
        "!tests/fixtures/metric_definitions/**"
    ), "the re-inclusion must follow the exclusion; the last matching pattern wins"


def test_the_build_copies_the_evidence_before_the_catalog_guard_runs(
    instructions: list[str],
) -> None:
    """Ordering is load-bearing the same way it is for the themes: the guard reads the
    fixtures, so a build that asserted before copying them would fail on every build for the
    wrong reason — and one that never copied them would fail for a reason that reads like a
    catalog defect."""
    copy_index = next(
        index
        for index, line in enumerate(instructions)
        if line.startswith("COPY tests/fixtures/metric_definitions/")
    )
    guard_index = next(
        index
        for index, line in enumerate(instructions)
        if "catalog.evidence --assert-build" in line
    )

    assert copy_index < guard_index, instructions


def test_the_evidence_lands_where_the_guard_resolves_it() -> None:
    """The Dockerfile's destination and `evidence_directory`'s image branch are two
    statements of one path, in two files, in two languages. This is the assertion that keeps
    them equal — otherwise the guard fails in the image with "the evidence directory does not
    exist" and the Dockerfile looks correct.
    """
    from reporting_agent.catalog.evidence import evidence_directory

    dockerfile = DOCKERFILE.read_text()
    assert "COPY tests/fixtures/metric_definitions/ ./evidence/metric_definitions/" in (
        dockerfile
    )
    # `evidence_directory()` resolves the checkout branch here, so the image branch is
    # asserted by its shape: the package's parent, plus the two segments the COPY names.
    assert evidence_directory().name == "metric_definitions"
    assert evidence_directory().parent.name in {"fixtures", "evidence"}


# --------------------------------------------------------------------------- #
# Every documented build line names the platform (Req 23.10)
# --------------------------------------------------------------------------- #

_BUILD_INVOCATION = re.compile(r"^\s*(?:\$\s*)?docker\s+(?:buildx\s+)?build\b")


def _build_command_lines(text: str) -> list[str]:
    """Every `docker build` / `docker buildx build` invocation, continuations joined."""
    joined = text.replace("\\\n", " ")
    return [line for line in joined.splitlines() if _BUILD_INVOCATION.match(line)]


def test_the_readme_documents_at_least_one_build_command() -> None:
    """Guard the guard below: an empty list would make it vacuously true."""
    assert len(_build_command_lines(README.read_text())) >= 2


def test_every_readme_build_line_names_the_platform() -> None:
    """Req 23.10's documentation half. A build without the flag produces an image the
    runtime will not start, and it fails at launch rather than at build — so a copied
    command line missing the flag is a real and expensive defect."""
    offenders = [
        line
        for line in _build_command_lines(README.read_text())
        if PLATFORM_FLAG not in line
    ]
    assert offenders == [], offenders


def test_the_dockerfile_header_shows_a_build_line_naming_the_platform() -> None:
    """The header comment is where somebody copying a command looks first."""
    header = DOCKERFILE.read_text().split("ARG PYTHON_VERSION", 1)[0]
    assert PLATFORM_FLAG in header


def test_the_readme_no_longer_claims_libreoffice_is_absent() -> None:
    """It said so, correctly, until this task installed it. A stale README that tells a
    reader the image cannot convert a PDF sends them looking in the wrong place."""
    text = README.read_text()
    assert "LibreOffice, the theme fonts and a pre-warmed LibreOffice profile are **not**" not in text
    assert "libreoffice-writer" in text
