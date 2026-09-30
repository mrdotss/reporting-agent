"""Where the proof link points: the app's public address, pinned once it is printed."""

from __future__ import annotations

from reporting_agent.report_pipeline import _pinned_verify_url, _verify_base_url

PROGRESS = {"progress_url": "https://app.reporting.internal/api/internal/runs/r-1/progress"}


def test_the_public_address_wins_over_the_private_progress_host() -> None:
    assert _verify_base_url(PROGRESS, {"public_base_url": "https://reporting.example.com/"}) == "https://reporting.example.com"


def test_without_a_public_address_the_progress_host_is_used() -> None:
    assert _verify_base_url(PROGRESS, {}) == "https://app.reporting.internal"
    assert _verify_base_url(PROGRESS) == "https://app.reporting.internal"


def test_only_https_counts() -> None:
    assert _verify_base_url(PROGRESS, {"public_base_url": "http://reporting.example.com"}) == "https://app.reporting.internal"
    assert _verify_base_url({"progress_url": "http://app.test/x"}, {"public_base_url": "ftp://x"}) == ""
    assert _verify_base_url(PROGRESS, {"public_base_url": "https://user@evil.example"}) == "https://app.reporting.internal"


def test_a_pinned_link_is_reprinted_exactly_and_an_unpinned_report_falls_back() -> None:
    assert _pinned_verify_url({"schema_version": 1, "verify_url": "https://reporting.example.com/v/r-1"}) == (
        "https://reporting.example.com/v/r-1"
    )
    assert _pinned_verify_url(None) is None
    assert _pinned_verify_url({"schema_version": 1}) is None
