"""PDF conversion, from the produced `.docx` and from nothing else.

The whole point of Req 23.1 is one sentence: **the `.pdf` is converted from the exact bytes of
the `.docx` that was rendered for this run.** Never from the AST, never from the ledger, never
from the HTML emitter's output, never from the snapshot. Rendering the two independently would
be two chances to produce a different number, and a client reading the PDF while a colleague
reads the Word file would have no way to know which one to trust.

That is also why :func:`convert_to_pdf` takes `docx_bytes` and not a path to something it could
re-render: the signature is the guarantee. There is no argument it could be handed that would
let it produce a PDF of anything other than the document.

## `LANG` is asserted before the process starts, not after

Req 23.8. A comma-decimal locale makes LibreOffice lay out `12,345.60` as `12.345,60`, so every
ledger `formatted` string stops being findable in the extracted text and the PDF pass reports
`pdf_figure_missing` on a document that is completely correct. The Dockerfile sets
`LANG=C.UTF-8`, and this module still checks it — because an image-level default says nothing
about the value in effect in *this* process, which a task definition, an operator or a parent
shell can all override.

Checked **before** spawning rather than after converting, because a wrong-locale PDF is a
plausible-looking artifact. Failing before the process starts means there is nothing to
mistakenly upload.

## One attempt, one limit, including the first conversion of a container's life

Req 23.9. The profile is warmed at image build time precisely so the first conversion is not
special — so it gets the same 300-second limit and the same single attempt as every later one.
A retry here would paper over the cold-start problem the build-time warm-up exists to remove,
and it would do so by doubling the worst case of an already-minutes-long run.

## Conversions are serialized within a process

The profile is **used** rather than copied (Req 23.5), so two concurrent conversions would
contend on LibreOffice's lock files inside it — which manifests as one of the two failing with
a profile-in-use error, intermittently, under load. A process-wide lock is the cheap fix; the
expensive one would be copying the profile per conversion, which reintroduces the cold-profile
cost the warm-up removed.
"""

from __future__ import annotations

import hashlib
import shutil
import subprocess
import threading
from dataclasses import dataclass
from pathlib import Path
from tempfile import TemporaryDirectory
from typing import Final

from reporting_agent.errors import PdfConversionFailedError
from reporting_agent.redaction import scrub

__all__ = [
    "CONVERT_TIMEOUT_S",
    "DEFAULT_PROFILE_PATH",
    "PROFILE_ENV_VAR",
    "REQUIRED_LANG",
    "SOFFICE_BINARY",
    "ConversionOutcome",
    "assert_lang_in_effect",
    "convert_to_pdf",
    "digest_of",
    "profile_path",
    "soffice_command",
]

REQUIRED_LANG: Final[str] = "C.UTF-8"
"""Req 23.3. Asserted, not assumed — see the module docstring."""

CONVERT_TIMEOUT_S: Final[float] = 300.0
"""Req 23.9. Applies to the first conversion of a container's life as much as to any other."""

SOFFICE_BINARY: Final[str] = "soffice"

PROFILE_ENV_VAR: Final[str] = "LO_PROFILE"
DEFAULT_PROFILE_PATH: Final[str] = "/opt/libreoffice-profile"
"""Where the Dockerfile warms the profile. Read from the environment so the image and this
module cannot disagree about the path, with the image's own value as the fallback."""

_CONVERSION_LOCK: Final[threading.Lock] = threading.Lock()
"""Serializes conversions within one process — see the module docstring on lock files."""


@dataclass(frozen=True, slots=True)
class ConversionOutcome:
    """One conversion's result.

    Carries both digests because Req 23.7 requires them recorded **before** any download is
    presented, and the cleanest way to make that ordering hold is for the conversion to be the
    thing that produces them: a caller cannot present a download it has not received an
    outcome for.
    """

    pdf_bytes: bytes
    docx_sha256: str
    pdf_sha256: str
    page_count: int


def digest_of(payload: bytes) -> str:
    """SHA-256 hex over an artifact's byte content (Req 23.7)."""
    return hashlib.sha256(payload).hexdigest()


def profile_path() -> Path:
    """The pre-warmed profile, from the environment or the image's default."""
    import os

    return Path(os.environ.get(PROFILE_ENV_VAR) or DEFAULT_PROFILE_PATH)


def assert_lang_in_effect() -> None:
    """Req 23.8 — refuse before starting a conversion if `LANG` is not `C.UTF-8`.

    Names both the required and the observed value, because the fix is to change one of them
    and a message that reports only "wrong locale" leaves the reader guessing which.
    """
    import os

    observed = os.environ.get("LANG")
    if observed != REQUIRED_LANG:
        raise PdfConversionFailedError(
            f"the required LANG value {REQUIRED_LANG!r} was not in effect (LANG is "
            f"{observed!r}), so no conversion was started. A comma-decimal locale rewrites "
            f"every numeral LibreOffice lays out, which would make the ledger's formatted "
            f"strings unfindable in the PDF and withhold a document that is correct"
        )


def soffice_command(source: Path, outdir: Path, *, profile: Path) -> list[str]:
    """The exact argument list every conversion uses.

    A function rather than an inline list so the tests can assert the flags without running
    LibreOffice, and so `--norestore` (Req 23.4) and the profile (Req 23.5) are impossible to
    omit in one call site and not another.
    """
    return [
        SOFFICE_BINARY,
        "--headless",
        # Req 23.4. Without it LibreOffice may try to recover documents from a previous
        # crashed session, which in a container means hanging on a dialog nobody can answer.
        "--norestore",
        # Req 23.5 — the profile warmed at build time, used as-is. `-env:` rather than `HOME`
        # so the choice is explicit in the argument list rather than implied by the
        # environment.
        f"-env:UserInstallation=file://{profile}",
        "--convert-to",
        "pdf",
        "--outdir",
        str(outdir),
        str(source),
    ]


def convert_to_pdf(
    docx_bytes: bytes,
    *,
    profile: Path | None = None,
    timeout_s: float = CONVERT_TIMEOUT_S,
    runner: object | None = None,
) -> ConversionOutcome:
    """Convert `docx_bytes` to PDF, once (Req 23.1, 23.6, 23.9).

    `docx_bytes` is the produced document's exact byte content. Nothing else is accepted, which
    is what makes "the pair cannot disagree" a property of the signature rather than a rule
    somebody has to remember.

    `runner` is a seam for the unit tests — a callable with `subprocess.run`'s shape. Injected
    rather than monkeypatched at the module level so a test cannot accidentally leave the real
    binary stubbed for a later test in the same process.

    Every failure mode Req 23.6 names — non-zero exit, the limit, no output, a zero-byte
    output, an unreadable page — is a terminal `PDF_CONVERSION_FAILED` carrying **scrubbed**
    failure text, because LibreOffice echoes its argument list and a future argument could
    carry something that must not be logged.
    """
    if not docx_bytes:
        raise PdfConversionFailedError(
            "no .docx bytes were produced for this run, so there is nothing to convert; a "
            "PDF rendered from anything else could disagree with the delivered Word file"
        )

    # Req 23.8, before the process starts.
    assert_lang_in_effect()

    resolved_profile = profile_path() if profile is None else profile
    execute = subprocess.run if runner is None else runner

    if runner is None and shutil.which(SOFFICE_BINARY) is None:
        raise PdfConversionFailedError(
            f"{SOFFICE_BINARY!r} is not on PATH, so no conversion is possible. The image "
            f"installs libreoffice-writer; a run reaching this has lost it"
        )

    docx_digest = digest_of(docx_bytes)

    with TemporaryDirectory(prefix="rpt-pdf-") as scratch:
        workspace = Path(scratch)
        source = workspace / "report.docx"
        source.write_bytes(docx_bytes)
        expected = workspace / "report.pdf"

        command = soffice_command(source, workspace, profile=resolved_profile)

        try:
            # Serialized because the profile is USED rather than copied (Req 23.5), so two
            # concurrent conversions contend on LibreOffice's lock files inside it — which
            # shows up as one of the two failing with a profile-in-use error, intermittently,
            # under load. Held across the whole invocation rather than around a shorter
            # critical section, because the contention is for the profile's lifetime.
            #
            # Req 23.9 — at most one invocation, and the limit applies to it.
            with _CONVERSION_LOCK:
                result = execute(  # type: ignore[operator]
                    command,
                    capture_output=True,
                    text=True,
                    timeout=timeout_s,
                    check=False,
                )
        except subprocess.TimeoutExpired as error:
            raise PdfConversionFailedError(
                f"the conversion did not produce an output file within {timeout_s:g}s and was "
                f"terminated. Exactly one attempt is made per produced .docx, including the "
                f"first conversion of a container's life: {scrub(str(error))}"
            ) from error

        returncode = getattr(result, "returncode", 1)
        if returncode != 0:
            raise PdfConversionFailedError(
                f"the conversion exited with status {returncode}: "
                f"{scrub(getattr(result, 'stderr', '') or getattr(result, 'stdout', ''))}"
            )

        if not expected.is_file():
            raise PdfConversionFailedError(
                f"the conversion reported success but wrote no output file to "
                f"{expected.name}: {scrub(getattr(result, 'stdout', ''))}"
            )

        pdf_bytes = expected.read_bytes()

    if not pdf_bytes:
        raise PdfConversionFailedError(
            "the conversion produced a zero-byte .pdf, so neither download is presented; a "
            "pair whose halves have never been shown to agree is not a deliverable"
        )

    page_count = _readable_page_count(pdf_bytes)

    return ConversionOutcome(
        pdf_bytes=pdf_bytes,
        docx_sha256=docx_digest,
        pdf_sha256=digest_of(pdf_bytes),
        page_count=page_count,
    )


def _readable_page_count(pdf_bytes: bytes) -> int:
    """The page count, or `PDF_CONVERSION_FAILED` if no page can be read (Req 23.6).

    A non-empty file is not the same as a readable document: a truncated write, or a
    conversion that failed halfway, produces bytes that open and hold nothing. Since the PDF
    fidelity gate is going to read this file's text anyway, a file it cannot open is better
    discovered here — where the message says so — than as an empty token set that passes every
    later check.
    """
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError

    try:
        reader = PdfReader(_as_stream(pdf_bytes))
        count = len(reader.pages)
    except (PdfReadError, OSError, ValueError) as error:
        raise PdfConversionFailedError(
            f"the produced .pdf could not be read as a document: "
            f"{type(error).__name__}: {scrub(str(error))}"
        ) from error

    if count < 1:
        raise PdfConversionFailedError(
            "the produced .pdf carries no readable page, so neither download is presented"
        )
    return count


def _as_stream(payload: bytes):
    from io import BytesIO

    return BytesIO(payload)
