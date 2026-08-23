"""PDF conversion (Req 23).

Two halves, and both are needed:

* **A faked subprocess** for everything about *how* the conversion is invoked — the flags, the
  profile, the attempt count, the limit, and every failure mode. A fake is the only way to
  assert "exactly one attempt" or "refused before the process started", because a real run
  that succeeded would prove neither.
* **One real conversion**, because a faked subprocess cannot tell us LibreOffice works. It is
  the difference between testing our argument list and testing the thing.

## The invariant the whole module exists for

The `.pdf` is converted from the **exact bytes** of the `.docx` this run produced. Never from
the AST, the ledger, the HTML emitter or the snapshot. `convert_to_pdf(docx_bytes)` takes bytes
and nothing it could re-render from, so the guarantee is a property of the signature — and the
test that matters most is the end-to-end one: the same figures are findable in both halves.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.blocks import compile_document
from reporting_agent.compile.blocks.base import DesignSettings
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.errors import ErrorCode, PdfConversionFailedError
from reporting_agent.render import pdf as P
from reporting_agent.compile.messages import load_messages
from reporting_agent.render.docx import render_document
import messages_factory as mf

_MESSAGES = load_messages("en")

SOFFICE: Final[str | None] = shutil.which(P.SOFFICE_BINARY)

DESIGN: Final[dict[str, object]] = {
    "preset": "editorial",
    "accent_color": "#1f6f78",
    "density": "normal",
    "table_style": "hairline",
    "number_format": {"decimal_places": 2, "group_thousands": True},
    "cover_page": True,
    "logo": None,
    "page_size": "A4",
}

BLOCKS: Final[list] = [
    df.block("h", "heading", {"text": "Utilization", "level": 1}),
    df.block("p", "rich_text", {"text": "CPU headroom is substantial."}),
    df.block("t", "resource_table", {"columns": [df.CPU_AVG, df.CPU_MAX], "caption": "Cap"}),
    df.block("k", "kpi_row", {"metrics": [df.CPU_AVG]}),
    df.block("v", "verification_record", {}),
]


@pytest.fixture(autouse=True)
def _required_lang(monkeypatch: pytest.MonkeyPatch) -> None:
    """Every test runs with the locale the converter requires.

    Autouse because the alternative is every test remembering to set it, and a test that
    forgot would fail on the `LANG` assertion for a reason unrelated to what it checks. The
    two tests that are *about* `LANG` override it themselves.
    """
    monkeypatch.setenv("LANG", P.REQUIRED_LANG)


def rendered_document() -> tuple[object, bytes]:
    view = build_snapshot_view(sf.two_vm_snapshot())
    compiled = compile_document(df.definition(BLOCKS, design=DESIGN), view=view)
    outcome = render_document(
        compiled.document,
        ledger=compiled.ledger,
        design=DesignSettings.from_plain(DESIGN),
        messages=mf.EN,
    )
    return compiled, outcome.docx_bytes


# --------------------------------------------------------------------------- #
# The faked subprocess
# --------------------------------------------------------------------------- #


@dataclass
class FakeRunner:
    """A `subprocess.run` stand-in that records its calls.

    Writes the output file itself when `produce` is set, so a "successful" conversion can be
    simulated without LibreOffice — which is what lets the flag, profile and attempt-count
    assertions run in milliseconds and on a machine with no office suite.
    """

    returncode: int = 0
    stdout: str = ""
    stderr: str = ""
    produce: bytes | None = b"%PDF-1.7\nfake"
    raises: BaseException | None = None
    calls: list[list[str]] = None  # type: ignore[assignment]

    def __post_init__(self) -> None:
        self.calls = []

    def __call__(self, command, **kwargs):
        self.calls.append(list(command))
        self.kwargs = kwargs
        if self.raises is not None:
            raise self.raises
        if self.produce is not None:
            # The converter names its output `report.pdf` beside the source.
            source = Path(command[-1])
            (source.parent / "report.pdf").write_bytes(self.produce)
        return subprocess.CompletedProcess(
            args=command, returncode=self.returncode, stdout=self.stdout, stderr=self.stderr
        )


def _one_page_pdf() -> bytes:
    """A genuinely valid one-page PDF, for the fake runner to "produce".

    Built with matplotlib — already a dependency — rather than hand-written. The first attempt
    at this test file hand-rolled a PDF with no xref table and no `%%EOF`, which `pypdf`
    rejects; the readable-page check then fired on every "successful" fake conversion and seven
    tests failed for a reason that had nothing to do with what they were checking.

    Which is the check working: a non-empty file is not a readable document, and the fixture
    has to clear the same bar a real conversion does.
    """
    from io import BytesIO

    from matplotlib.figure import Figure

    buffer = BytesIO()
    Figure(figsize=(1, 1)).savefig(buffer, format="pdf")
    return buffer.getvalue()


MINIMAL_PDF: Final[bytes] = _one_page_pdf()


def runner_producing_a_readable_pdf(**kwargs) -> FakeRunner:
    return FakeRunner(produce=MINIMAL_PDF, **kwargs)


# --------------------------------------------------------------------------- #
# Req 23.3, 23.8 — LANG is asserted before the process starts
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("value", ["en_US.UTF-8", "de_DE.UTF-8", "C", "", "c.utf-8"])
def test_a_wrong_lang_starts_no_conversion(
    value: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Req 23.8 — refused **before** spawning, because a wrong-locale PDF is a
    plausible-looking artifact and there must be nothing to mistakenly upload."""
    monkeypatch.setenv("LANG", value)
    runner = runner_producing_a_readable_pdf()

    with pytest.raises(PdfConversionFailedError) as raised:
        P.convert_to_pdf(b"docx", runner=runner)

    assert runner.calls == [], "a process was started despite the wrong locale"
    assert P.REQUIRED_LANG in raised.value.message
    assert repr(value) in raised.value.message
    assert raised.value.code is ErrorCode.PDF_CONVERSION_FAILED
    assert raised.value.terminal is True


def test_an_absent_lang_starts_no_conversion(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("LANG", raising=False)
    runner = runner_producing_a_readable_pdf()
    with pytest.raises(PdfConversionFailedError, match="was not in effect"):
        P.convert_to_pdf(b"docx", runner=runner)
    assert runner.calls == []


def test_the_lang_assertion_is_callable_on_its_own() -> None:
    """The pipeline calls it as a preflight too, so it has to stand alone."""
    P.assert_lang_in_effect()


def test_the_required_lang_is_the_value_the_image_sets() -> None:
    """One decision in two files, asserted so they cannot drift.

    A comma-decimal locale would rewrite every numeral LibreOffice lays out, so the ledger's
    formatted strings would stop being findable in the PDF.
    """
    dockerfile = (Path(__file__).resolve().parent.parent / "Dockerfile").read_text()
    assert f"LANG={P.REQUIRED_LANG}" in dockerfile


# --------------------------------------------------------------------------- #
# Req 23.4, 23.5 — the flags and the pre-warmed profile
# --------------------------------------------------------------------------- #


def test_the_invocation_carries_headless_and_norestore() -> None:
    runner = runner_producing_a_readable_pdf()
    P.convert_to_pdf(b"docx", runner=runner)
    command = runner.calls[0]
    assert command[0] == P.SOFFICE_BINARY
    assert "--headless" in command
    assert "--norestore" in command  # Req 23.4
    assert "--convert-to" in command
    assert command[command.index("--convert-to") + 1] == "pdf"


def test_the_invocation_uses_the_pre_warmed_profile_as_is(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Req 23.5 — used, never created at run time. Creating one per conversion would
    reintroduce the cold-profile cost the build-time warm-up exists to remove."""
    monkeypatch.setenv(P.PROFILE_ENV_VAR, str(tmp_path / "warm"))
    runner = runner_producing_a_readable_pdf()
    P.convert_to_pdf(b"docx", runner=runner)

    profile_args = [
        arg for arg in runner.calls[0] if arg.startswith("-env:UserInstallation=")
    ]
    assert profile_args == [f"-env:UserInstallation=file://{tmp_path / 'warm'}"]
    # And nothing was created: the converter does not own that directory.
    assert not (tmp_path / "warm").exists()


def test_the_profile_path_defaults_to_the_images_own(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.delenv(P.PROFILE_ENV_VAR, raising=False)
    assert P.profile_path() == Path(P.DEFAULT_PROFILE_PATH)


def test_the_default_profile_path_is_the_one_the_image_warms() -> None:
    dockerfile = (Path(__file__).resolve().parent.parent / "Dockerfile").read_text()
    assert f"LO_PROFILE={P.DEFAULT_PROFILE_PATH}" in dockerfile


def test_the_command_builder_is_the_single_source_of_the_flags() -> None:
    """A function rather than an inline list, so `--norestore` and the profile cannot be
    present in one call site and absent from another."""
    command = P.soffice_command(
        Path("/tmp/a/report.docx"), Path("/tmp/a"), profile=Path("/opt/p")
    )
    assert command == [
        "soffice",
        "--headless",
        "--norestore",
        "-env:UserInstallation=file:///opt/p",
        "--convert-to",
        "pdf",
        "--outdir",
        "/tmp/a",
        "/tmp/a/report.docx",
    ]


# --------------------------------------------------------------------------- #
# Req 23.9 — one attempt, one limit
# --------------------------------------------------------------------------- #


def test_exactly_one_invocation_is_made_per_produced_docx() -> None:
    runner = runner_producing_a_readable_pdf()
    P.convert_to_pdf(b"docx", runner=runner)
    assert len(runner.calls) == 1


@pytest.mark.parametrize(
    "runner",
    [
        FakeRunner(returncode=1, produce=None, stderr="boom"),
        FakeRunner(returncode=0, produce=None),
        FakeRunner(returncode=0, produce=b""),
    ],
    ids=["non-zero-exit", "no-output", "zero-byte-output"],
)
def test_a_failure_makes_no_second_attempt(runner: FakeRunner) -> None:
    """Req 23.9 — at most one. A retry would paper over the cold-start problem the build-time
    warm-up removed, and double the worst case of an already-minutes-long run."""
    with pytest.raises(PdfConversionFailedError):
        P.convert_to_pdf(b"docx", runner=runner)
    assert len(runner.calls) == 1


def test_the_time_limit_is_three_hundred_seconds() -> None:
    assert P.CONVERT_TIMEOUT_S == 300.0


def test_the_limit_is_passed_to_the_invocation() -> None:
    runner = runner_producing_a_readable_pdf()
    P.convert_to_pdf(b"docx", runner=runner)
    assert runner.kwargs["timeout"] == P.CONVERT_TIMEOUT_S


def test_the_same_limit_applies_to_the_first_conversion_of_a_containers_life() -> None:
    """There is no first-run branch, and that is the assertion: the profile is warmed at build
    time so the first conversion is not special."""
    import inspect

    source = inspect.getsource(P.convert_to_pdf)
    assert "first" not in source.lower().replace("first conversion of a container", "")
    runner = runner_producing_a_readable_pdf()
    P.convert_to_pdf(b"docx", runner=runner)
    assert runner.kwargs["timeout"] == P.CONVERT_TIMEOUT_S


def test_exceeding_the_limit_is_terminal_and_says_so() -> None:
    runner = FakeRunner(
        raises=subprocess.TimeoutExpired(cmd=["soffice"], timeout=300.0), produce=None
    )
    with pytest.raises(PdfConversionFailedError) as raised:
        P.convert_to_pdf(b"docx", runner=runner)
    assert "300s" in raised.value.message
    assert "one attempt" in raised.value.message
    assert raised.value.terminal is True


# --------------------------------------------------------------------------- #
# Req 23.6 — every failure mode
# --------------------------------------------------------------------------- #


def test_a_non_zero_exit_is_terminal_carrying_the_failure_text() -> None:
    runner = FakeRunner(returncode=77, produce=None, stderr="soffice exploded")
    with pytest.raises(PdfConversionFailedError) as raised:
        P.convert_to_pdf(b"docx", runner=runner)
    assert "77" in raised.value.message
    assert "soffice exploded" in raised.value.message


def test_a_missing_output_file_is_terminal() -> None:
    runner = FakeRunner(returncode=0, produce=None, stdout="claimed success")
    with pytest.raises(PdfConversionFailedError, match="wrote no output file"):
        P.convert_to_pdf(b"docx", runner=runner)


def test_a_zero_byte_output_is_terminal() -> None:
    runner = FakeRunner(returncode=0, produce=b"")
    with pytest.raises(PdfConversionFailedError, match="zero-byte"):
        P.convert_to_pdf(b"docx", runner=runner)


def test_an_unreadable_output_is_terminal() -> None:
    """A non-empty file is not the same as a readable document. Better discovered here, where
    the message says so, than as an empty token set that passes every later check."""
    runner = FakeRunner(returncode=0, produce=b"this is definitely not a pdf")
    with pytest.raises(PdfConversionFailedError, match="could not be read as a document"):
        P.convert_to_pdf(b"docx", runner=runner)


def test_empty_docx_bytes_are_refused_before_anything_else() -> None:
    runner = runner_producing_a_readable_pdf()
    with pytest.raises(PdfConversionFailedError, match="nothing to convert"):
        P.convert_to_pdf(b"", runner=runner)
    assert runner.calls == []


def test_the_failure_text_is_scrubbed() -> None:
    """LibreOffice echoes its argument list, so a future argument could carry something that
    must not be logged."""
    from reporting_agent.redaction import discard_secrets, register_secrets

    token = register_secrets(["super-secret-value"])
    try:
        runner = FakeRunner(
            returncode=1, produce=None, stderr="failed with super-secret-value in the args"
        )
        with pytest.raises(PdfConversionFailedError) as raised:
            P.convert_to_pdf(b"docx", runner=runner)
        assert "super-secret-value" not in raised.value.message
    finally:
        discard_secrets(token)


def test_an_absent_soffice_is_terminal(monkeypatch: pytest.MonkeyPatch) -> None:
    """Only reachable when no runner is injected, i.e. on the real path."""
    monkeypatch.setattr(P.shutil, "which", lambda _name: None)
    with pytest.raises(PdfConversionFailedError, match="not on PATH"):
        P.convert_to_pdf(b"docx")


# --------------------------------------------------------------------------- #
# Req 23.7 — both digests, before any download
# --------------------------------------------------------------------------- #


def test_both_digests_are_recorded_over_the_stored_byte_content() -> None:
    runner = runner_producing_a_readable_pdf()
    payload = b"the exact docx bytes"
    outcome = P.convert_to_pdf(payload, runner=runner)

    assert outcome.docx_sha256 == hashlib.sha256(payload).hexdigest()
    assert outcome.pdf_sha256 == hashlib.sha256(MINIMAL_PDF).hexdigest()
    assert outcome.pdf_bytes == MINIMAL_PDF
    assert outcome.page_count == 1


def test_the_digests_come_back_with_the_conversion_rather_than_afterwards() -> None:
    """Req 23.7 requires both recorded **before** any download is presented. The cleanest way
    to make that ordering hold is for the conversion to be the thing that produces them: a
    caller cannot present a download it has not received an outcome for."""
    fields = P.ConversionOutcome.__dataclass_fields__
    assert "docx_sha256" in fields
    assert "pdf_sha256" in fields


def test_the_digest_helper_matches_hashlib() -> None:
    assert P.digest_of(b"abc") == hashlib.sha256(b"abc").hexdigest()


# --------------------------------------------------------------------------- #
# Serialization
# --------------------------------------------------------------------------- #


def test_conversions_are_serialized_within_one_process() -> None:
    """The profile is used rather than copied, so two concurrent conversions would contend on
    LibreOffice's lock files inside it — intermittently, under load."""
    import threading

    observed: list[bool] = []
    barrier_hit = threading.Event()

    def slow(command, **kwargs):
        observed.append(P._CONVERSION_LOCK.locked())
        barrier_hit.set()
        source = Path(command[-1])
        (source.parent / "report.pdf").write_bytes(MINIMAL_PDF)
        return subprocess.CompletedProcess(args=command, returncode=0, stdout="", stderr="")

    P.convert_to_pdf(b"docx", runner=slow)
    assert barrier_hit.is_set()
    assert observed == [True], "the lock was not held across the invocation"


def test_the_lock_is_released_after_a_failure() -> None:
    """A lock left held by a failed conversion would deadlock every later one."""
    runner = FakeRunner(returncode=1, produce=None)
    with pytest.raises(PdfConversionFailedError):
        P.convert_to_pdf(b"docx", runner=runner)
    assert not P._CONVERSION_LOCK.locked()


# --------------------------------------------------------------------------- #
# One real conversion — the assertion a fake cannot make
# --------------------------------------------------------------------------- #


@pytest.mark.skipif(SOFFICE is None, reason="LibreOffice is not installed")
def test_a_real_conversion_produces_a_readable_pdf_carrying_every_figure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Req 23.1's invariant, end to end: the delivered pair cannot disagree.

    A faked subprocess cannot tell us LibreOffice works, and it certainly cannot tell us that
    the numbers survive the conversion. This renders a real document, converts it through the
    real binary, and requires **every** ledger `formatted` string to be findable in the
    extracted text — which is exactly what the PDF fidelity gate will check.
    """
    monkeypatch.setenv(P.PROFILE_ENV_VAR, str(tmp_path / "profile"))
    (tmp_path / "profile").mkdir()

    compiled, docx_bytes = rendered_document()
    outcome = P.convert_to_pdf(docx_bytes, profile=tmp_path / "profile")

    assert outcome.page_count >= 1
    assert outcome.pdf_bytes[:5] == b"%PDF-"
    assert outcome.docx_sha256 == hashlib.sha256(docx_bytes).hexdigest()
    assert outcome.pdf_sha256 == hashlib.sha256(outcome.pdf_bytes).hexdigest()

    from io import BytesIO

    from pypdf import PdfReader

    reader = PdfReader(BytesIO(outcome.pdf_bytes))
    normalized = " ".join(
        " ".join(page.extract_text().split()) for page in reader.pages
    )
    assert normalized.strip(), "the converted PDF carries no extractable text"

    missing = [
        figure.formatted
        for figure in compiled.ledger.entries.values()
        if figure.formatted not in normalized
    ]
    assert missing == [], (
        f"{len(missing)} ledger figure(s) are absent from the converted PDF: {missing}. "
        f"The delivered .docx and .pdf would disagree."
    )


@pytest.mark.skipif(SOFFICE is None, reason="LibreOffice is not installed")
def test_a_real_conversion_converts_the_docx_bytes_and_not_a_re_render(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The signature is the guarantee, and this is what it buys.

    A sentinel is put into the `.docx` **after** rendering, in a way no re-render would
    reproduce. If the converter took a path to something it could re-render — the AST, the
    ledger, the snapshot — the sentinel would be absent from the PDF. It is present, so the
    conversion read the bytes it was handed.
    """
    monkeypatch.setenv(P.PROFILE_ENV_VAR, str(tmp_path / "profile"))
    (tmp_path / "profile").mkdir()

    _, docx_bytes = rendered_document()
    sentinel = "ZZQQ-SENTINEL-7741"
    mutated = _inject_paragraph(docx_bytes, sentinel)
    assert mutated != docx_bytes

    outcome = P.convert_to_pdf(mutated, profile=tmp_path / "profile")

    from io import BytesIO

    from pypdf import PdfReader

    text = " ".join(
        " ".join(page.extract_text().split())
        for page in PdfReader(BytesIO(outcome.pdf_bytes)).pages
    )
    assert sentinel in text, (
        "the sentinel added to the .docx after rendering is absent from the .pdf, so the "
        "conversion did not read the bytes it was given"
    )
    assert outcome.docx_sha256 == hashlib.sha256(mutated).hexdigest()


def _inject_paragraph(docx_bytes: bytes, text: str) -> bytes:
    """Add one paragraph to a rendered `.docx`, rewriting the package.

    Deliberately a post-render edit: nothing in the compile or render path would produce it,
    which is what makes it a usable sentinel for "these exact bytes were converted".
    """
    import io
    import zipfile

    with zipfile.ZipFile(io.BytesIO(docx_bytes)) as archive:
        parts = {name: archive.read(name) for name in archive.namelist()}

    document = parts["word/document.xml"].decode("utf-8")
    paragraph = f"<w:p><w:r><w:t>{text}</w:t></w:r></w:p>"
    document = document.replace("<w:body>", f"<w:body>{paragraph}", 1)
    parts["word/document.xml"] = document.encode("utf-8")

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as rebuilt:
        for name, payload in parts.items():
            rebuilt.writestr(name, payload)
    return buffer.getvalue()


@pytest.mark.skipif(SOFFICE is None, reason="LibreOffice is not installed")
def test_a_real_conversion_of_a_corrupt_docx_is_terminal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real binary's own failure path, rather than a simulated one."""
    monkeypatch.setenv(P.PROFILE_ENV_VAR, str(tmp_path / "profile"))
    (tmp_path / "profile").mkdir()

    with pytest.raises(PdfConversionFailedError):
        P.convert_to_pdf(b"PK\x03\x04 this is not a document package at all")


def test_the_environment_the_real_tests_need_is_the_one_the_image_provides() -> None:
    """Guard against the real tests passing for the wrong reason: if this suite ran with a
    locale the converter refuses, every real conversion would be skipped-by-exception."""
    assert os.environ["LANG"] == P.REQUIRED_LANG
