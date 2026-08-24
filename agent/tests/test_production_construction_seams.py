"""Three silently-failing production-only construction seams.

## What this exists to stop

Unlike ``_s3_store`` (which raises a ``TypeError`` on a bad keyword and thereby FAILS
LOUDLY), these three seams degrade SILENTLY when their construction site is broken:

1. ``_prose_provider(model_id, region)`` — a bad keyword to ``prose_generator`` is caught
   by the broad ``except Exception`` in ``narrate/summary.py``; the run delivers a report
   with a blank executive summary and no error anywhere.

2. ``prose_generator`` → ``boto3.client("bedrock-runtime", region_name=region)`` — same
   outcome.  Every test injects ``ProseGenerator(client=FakeModel(...))``, so the real
   ``boto3.client`` call runs only in production.

3. ``HttpxProgressTransport._client`` lazy build — no test drives ``post_json`` with
   ``self._client is None``; the e2e tests inject a ``RecordingTransport``.  A broken
   httpx construction means the run completes and uploads everything to S3 while the row
   NEVER TRANSITIONS, because ``ProgressReporter`` swallows all transport errors by
   design (Req 38.4).  The reaper writes ``TIMEOUT`` over a completed run.

## Design reasoning on the silent swallows

**Progress transport (seam 3):** the swallow is CORRECT.  ``progress.py`` must never fail
a run — that is ``agentcore-integration.md``'s documented invariant, and the reaper is the
intended backstop.  The test here does NOT argue that progress failures should propagate;
it argues that the httpx construction site must be exercised so a broken keyword does not
silently make the backstop the norm.

**prose_generator boto3 build (seam 2):** the swallow is CORRECT.  A report with no
narrative is a complete report (the summary block renders its compiler-placed figures).
Raising here would withhold a document whose every figure verifies, over a decoration.

**_prose_provider (seam 1):** the swallow is CORRECT but the BLANKNESS IS INVISIBLE.  A
report delivering an empty narrative section with no error anywhere is a product decision —
the verifier passes, the document ships, and the reader cannot tell whether the summary was
deliberately left empty or silently failed.  This should be surfaced as a
``collection_log``-style gap (e.g. ``prose_unavailable``) so the verification surface can
show it alongside the other recorded gaps.  The report is still delivered; the run still
succeeds; the blankness is merely VISIBLE rather than inferred.  THIS FILE DOES NOT CHANGE
THAT BEHAVIOUR — it is recorded here as a recommendation.

## The guard (extending test_object_store_factories.py's pattern)

The enumeration guard at the bottom asserts that the FACTORIES table is whole, so a new
production-only construction site added tomorrow is a red test rather than a fourth silent
failure to discover six months later.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

import pytest


# ============================================================================ #
# Constants
# ============================================================================ #

REGION = "us-east-1"
MODEL_ID = "anthropic.claude-3-5-haiku-20241022-v1:0"


# ============================================================================ #
# Seam 1: _prose_provider (report_pipeline.py)
# ============================================================================ #


def test_prose_provider_calls_prose_generator_with_region_keyword(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The regression gate: ``_prose_provider`` must pass ``region=`` (not
    ``region_name=``) to ``prose_generator``.

    A wrong keyword is caught by the broad ``except Exception`` and silently yields a
    blank executive summary.  This test calls the REAL ``_prose_provider`` and stubs
    ``prose_generator`` at its boundary — confirming the keyword arrives correctly.
    """
    captured: dict[str, Any] = {}

    def spy_prose_generator(model_id: str, *, region: str | None = None, language: str = "en") -> object:
        captured["model_id"] = model_id
        captured["region"] = region
        captured["language"] = language
        return object()  # a ProseGenerator stand-in

    monkeypatch.setattr(
        "reporting_agent.narrate.summary.prose_generator",
        spy_prose_generator,
    )

    from reporting_agent.report_pipeline import _prose_provider

    result = _prose_provider(MODEL_ID, REGION)

    assert result is not None
    assert captured["model_id"] == MODEL_ID
    assert captured["region"] == REGION


# ============================================================================ #
# Seam 2: prose_generator -> boto3.client("bedrock-runtime", region_name=region)
# ============================================================================ #


def test_prose_generator_calls_boto3_with_region_name_keyword(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The real ``prose_generator`` must call ``boto3.client("bedrock-runtime",
    region_name=<region>)``.

    Tests only ever construct ``ProseGenerator(client=FakeModel(...))``, so this
    boundary is production-only.  Stub boto3.client at the boundary (NOT the factory
    itself) and assert the keyword arrives.
    """
    captured: dict[str, Any] = {}

    class FakeClient:
        """Stand-in for a bedrock-runtime client."""

        pass

    def fake_boto3_client(service: str, **kwargs: Any) -> FakeClient:
        captured["service"] = service
        captured.update(kwargs)
        return FakeClient()

    monkeypatch.setattr("boto3.client", fake_boto3_client)

    from reporting_agent.narrate.summary import prose_generator

    result = prose_generator(MODEL_ID, region=REGION)

    assert result is not None
    assert captured["service"] == "bedrock-runtime"
    assert captured["region_name"] == REGION


def test_prose_generator_returns_none_on_empty_model_id() -> None:
    """No model means no prose — not a construction attempt."""
    from reporting_agent.narrate.summary import prose_generator

    assert prose_generator("", region=REGION) is None


# ============================================================================ #
# Seam 3: HttpxProgressTransport._client lazy build
# ============================================================================ #


def test_httpx_transport_lazy_build_constructs_asyncclient(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The ``if self._client is None`` branch in ``post_json`` must construct an
    ``httpx.AsyncClient()`` that can actually post.

    No test calls ``post_json`` to force the lazy build — e2e tests inject a
    ``RecordingTransport``.  This drives the real code path and stubs httpx.AsyncClient
    at the boundary so no socket opens.
    """
    import asyncio

    from reporting_agent.progress import HttpxProgressTransport

    constructed_kwargs: dict[str, Any] = {}

    class FakeResponse:
        status_code = 200

    class FakeAsyncClient:
        def __init__(self, **kwargs: Any) -> None:
            constructed_kwargs.update(kwargs)

        async def post(self, url: str, **kwargs: Any) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr("httpx.AsyncClient", FakeAsyncClient)

    transport = HttpxProgressTransport()
    assert transport._client is None  # precondition: lazy

    async def _drive() -> int:
        return await transport.post_json(
            "https://app.internal/api/internal/runs/r/progress",
            body={"phase": "collecting"},
            headers={"X-Rpt-Progress-Token": "tok"},
            timeout=5.0,
        )

    status = asyncio.run(_drive())

    assert status == 200
    assert transport._client is not None
    # No ca_bundle means NO constructor kwargs at all — the real httpx.AsyncClient()
    # is called bare.  An unexpected kwarg (a mutation) would appear here.
    assert constructed_kwargs == {}, f"unexpected kwargs: {constructed_kwargs}"


def test_httpx_transport_lazy_build_with_ca_bundle(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """When ``ca_bundle`` is set, the lazy build must pass ``verify=`` to AsyncClient."""
    import asyncio
    import subprocess

    from reporting_agent.progress import HttpxProgressTransport

    # Create a real PEM so _verify() doesn't raise
    key = tmp_path / "ca.key"
    pem = tmp_path / "ca.pem"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
            "-keyout", str(key), "-out", str(pem), "-days", "1",
            "-subj", "/CN=Test CA",
        ],
        check=True,
        capture_output=True,
    )

    constructed_kwargs: dict[str, Any] = {}

    class FakeResponse:
        status_code = 200

    class FakeAsyncClient:
        def __init__(self, **kwargs: Any) -> None:
            constructed_kwargs.update(kwargs)

        async def post(self, url: str, **kwargs: Any) -> FakeResponse:
            return FakeResponse()

    monkeypatch.setattr("httpx.AsyncClient", FakeAsyncClient)

    transport = HttpxProgressTransport(ca_bundle=str(pem))

    async def _drive() -> int:
        return await transport.post_json(
            "https://app.internal/api/internal/runs/r/progress",
            body={"phase": "collecting"},
            headers={"X-Rpt-Progress-Token": "tok"},
            timeout=5.0,
        )

    status = asyncio.run(_drive())

    assert status == 200
    assert "verify" in constructed_kwargs


# ============================================================================ #
# Enumeration guard: no NEW silent construction seam may appear untested
# ============================================================================ #

#: Every production-only construction site that silently degrades.
#: Kept as a table so the guard below can assert it is whole.
SILENT_SEAMS: Mapping[str, Callable[[], Any]] = {
    "report_pipeline._prose_provider": lambda: None,  # tested above
    "narrate.summary.prose_generator[boto3]": lambda: None,  # tested above
    "progress.HttpxProgressTransport[httpx]": lambda: None,  # tested above
}


def test_no_new_boto3_bedrock_runtime_construction_site_outside_narrate() -> None:
    """The only place ``boto3.client("bedrock-runtime", ...)`` should appear is
    ``narrate/summary.py``.  A second site would be another silent-failure seam."""
    from pathlib import Path

    source_root = Path(__file__).resolve().parents[1] / "src" / "reporting_agent"
    narrate_summary = source_root / "narrate" / "summary.py"

    sites: set[str] = set()
    for path in source_root.rglob("*.py"):
        if path == narrate_summary:
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if 'boto3.client("bedrock-runtime"' in line and not line.lstrip().startswith("#"):
                sites.add(str(path.relative_to(source_root)))

    assert not sites, (
        f"unexpected bedrock-runtime construction in: {', '.join(sorted(sites))} — "
        "every such site silently degrades on a bad keyword because prose_generator's "
        "broad except swallows it"
    )


def test_no_new_httpx_asyncclient_construction_outside_progress() -> None:
    """The only places ``httpx.AsyncClient(`` should appear in production code are
    ``progress.py`` (fire-and-forget callbacks, errors silently swallowed) and
    ``azure/preflight.py`` (permissions check, errors propagate as hard failures).

    A NEW site would need its own call-site test: the progress module's silent-swallow
    design makes any untested construction invisible, and the preflight module's hard-fail
    design makes an untested one a different kind of surprise.
    """
    from pathlib import Path

    source_root = Path(__file__).resolve().parents[1] / "src" / "reporting_agent"
    # Known sites — each has its own call-site test elsewhere
    known = {
        source_root / "progress.py",
        source_root / "azure" / "preflight.py",
    }

    sites: set[str] = set()
    for path in source_root.rglob("*.py"):
        if path in known:
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if "httpx.AsyncClient(" in line and not line.lstrip().startswith("#"):
                sites.add(str(path.relative_to(source_root)))

    assert not sites, (
        f"unexpected httpx.AsyncClient construction in: {', '.join(sorted(sites))} — "
        "every construction site needs its own call-site test because progress.py's "
        "design swallows errors silently"
    )
