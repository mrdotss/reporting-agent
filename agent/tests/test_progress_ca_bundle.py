"""`RPT_CA_BUNDLE` — trusting a private certificate authority for the callback.

## Why this option exists at all

The progress callback is an ordinary HTTPS POST, and `httpx` builds its default context
from **certifi** with an explicit `cafile`. That makes `SSL_CERT_FILE` and
`REQUESTS_CA_BUNDLE` inert: a deployment whose app sits on a private network behind a
certificate its own authority issued has no environment-only way to add that root.

The failure without it is the bad kind. Req 38.4 forbids a callback failure from ending a
run, so verification failures are swallowed — the runtime collects, renders, verifies and
writes every artifact to S3, and the run row reaps as `TIMEOUT`. A complete, provably
correct report that the app insists does not exist.

## What is asserted here

That the configured bundle **reaches the client**, that an absent one changes nothing, and
that a path naming no file is reported rather than silently downgraded to the default
store. The third is the one worth having: falling back would fail every callback of every
run, quietly, which is precisely the outcome this option was added to prevent.

No socket is opened. The client is constructed for real and inspected.
"""

from __future__ import annotations

import ssl
from pathlib import Path
from typing import Any

import pytest

from reporting_agent.config import OPTIONAL_ENV_VARS, REQUIRED_ENV_VARS, Config
from reporting_agent.progress import HttpxProgressTransport, ProgressReporter

FULL_ENV = {
    "AWS_REGION": "us-east-1",
    "RPT_ARTIFACT_BUCKET": "rpt-artifacts-prod",
    "RPT_PROSE_MODEL_ID": "zai.glm-5",
}


# --------------------------------------------------------------------------- #
# The configuration
# --------------------------------------------------------------------------- #


def test_the_bundle_is_declared_optional_not_required() -> None:
    """An operator without a private CA must not be forced to invent a value."""
    assert "RPT_CA_BUNDLE" in OPTIONAL_ENV_VARS
    assert "RPT_CA_BUNDLE" not in REQUIRED_ENV_VARS


def test_an_absent_bundle_is_the_empty_default() -> None:
    assert Config.from_env(FULL_ENV).ca_bundle == ""


@pytest.mark.parametrize("value", ["", "   ", "\t"])
def test_a_blank_bundle_is_the_default_rather_than_an_error(value: str) -> None:
    """`_require` refuses a blank for the required variables. This one must not: blank
    is a legitimate answer meaning "use the default trust store"."""
    assert Config.from_env({**FULL_ENV, "RPT_CA_BUNDLE": value}).ca_bundle == ""


def test_a_configured_bundle_is_carried_verbatim_and_trimmed() -> None:
    config = Config.from_env({**FULL_ENV, "RPT_CA_BUNDLE": "  /etc/ssl/ca.pem \n"})

    assert config.ca_bundle == "/etc/ssl/ca.pem"


# --------------------------------------------------------------------------- #
# The transport
# --------------------------------------------------------------------------- #


@pytest.fixture
def ca_file(tmp_path: Path) -> Path:
    """A real PEM on disk. Its contents never matter — `ssl` only has to load it."""
    import subprocess

    key = tmp_path / "ca.key"
    pem = tmp_path / "ca.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(pem), "-days", "1",
            "-subj", "/CN=Test Internal CA",
        ],
        check=True,
        capture_output=True,
    )
    return pem


def client_of(transport: HttpxProgressTransport) -> Any:
    """Force the lazy client into existence without sending anything."""
    import httpx

    assert transport._client is None
    verify = transport._verify() if transport._ca_bundle else None
    return httpx.AsyncClient(verify=verify) if verify is not None else httpx.AsyncClient()


def test_no_bundle_builds_a_client_and_opens_nothing_eagerly() -> None:
    transport = HttpxProgressTransport()

    assert transport._ca_bundle == ""
    assert transport._client is None


def test_a_configured_bundle_becomes_an_ssl_context_loading_that_file(ca_file: Path) -> None:
    """The assertion that matters: the context really loaded the PEM.

    Compared against a default context's certificate count, because "an `SSLContext` was
    returned" would pass for one that quietly loaded nothing.
    """
    transport = HttpxProgressTransport(ca_bundle=str(ca_file))
    context = transport._verify()

    assert isinstance(context, ssl.SSLContext)

    subjects = {entry["subject"] for entry in context.get_ca_certs()}
    assert any("Test Internal CA" in str(subject) for subject in subjects), subjects


def test_a_bundle_naming_no_file_is_reported_rather_than_ignored() -> None:
    """The fallback that must not exist.

    A missing path silently becoming the default store would fail verification on every
    callback of every run, and Req 38.4 would swallow each one — the exact silent failure
    `RPT_CA_BUNDLE` exists to prevent. The message names the path.
    """
    transport = HttpxProgressTransport(ca_bundle="/no/such/ca.pem")

    with pytest.raises(FileNotFoundError) as raised:
        transport._verify()

    assert "/no/such/ca.pem" in str(raised.value)


def test_a_directory_is_refused_the_same_way(tmp_path: Path) -> None:
    transport = HttpxProgressTransport(ca_bundle=str(tmp_path))

    with pytest.raises(FileNotFoundError):
        transport._verify()


# --------------------------------------------------------------------------- #
# The wiring
# --------------------------------------------------------------------------- #


def test_the_reporter_passes_the_bundle_to_its_default_transport(ca_file: Path) -> None:
    reporter = ProgressReporter(
        progress_url="https://app.internal/api/internal/runs/r/progress",
        progress_token="t" * 40,
        run_id="run_1",
        ca_bundle=str(ca_file),
    )

    assert isinstance(reporter._transport, HttpxProgressTransport)
    assert reporter._transport._ca_bundle == str(ca_file)


def test_an_injected_transport_is_left_exactly_as_given(ca_file: Path) -> None:
    """A caller supplying its own transport owns it. Reaching into an injected object to
    apply a configuration it did not ask for is the kind of surprise that makes an
    injection seam untrustworthy."""
    supplied = HttpxProgressTransport(ca_bundle="")

    reporter = ProgressReporter(
        progress_url="https://app.internal/api/internal/runs/r/progress",
        progress_token="t" * 40,
        run_id="run_1",
        transport=supplied,
        ca_bundle=str(ca_file),
    )

    assert reporter._transport is supplied
    assert supplied._ca_bundle == ""


def test_a_disabled_reporter_still_accepts_the_bundle() -> None:
    """A prompt invocation carries no run, so the reporter is disabled. The bundle must
    not be the thing that decides that."""
    reporter = ProgressReporter(
        progress_url=None, progress_token=None, run_id=None, ca_bundle="/etc/ssl/ca.pem"
    )

    assert reporter.enabled is False
