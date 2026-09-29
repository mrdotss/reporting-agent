"""The Action register's runtime half: findings from the snapshot, rows against the register."""

from __future__ import annotations

import snapshot_factory as sf
from reporting_agent.collect.log import record_gap
from reporting_agent.collect.snapshot import FactEntry
from reporting_agent.compile.actions import MAX_ROWS, action_rows, findings_of
from reporting_agent.compile.messages import load_messages
from reporting_agent.compile.snapshot_view import build_snapshot_view


def fact(key: str, value: str, source: str = "aws") -> FactEntry:
    return FactEntry(key=key, value=value, value_kind="text", source=source,
                     collected_at="2026-08-01T00:00:00Z", formatted=value)


def view():
    web = sf.vm(resource_id="/r/web", name="web", facts=(
        fact("housekeeping", "none"),
        fact("rightsizing_finding", "Overprovisioned", "compute_optimizer"),
        fact("recommended_type", "t4g.nano", "compute_optimizer"),
    ))
    old = sf.vm(resource_id="/r/old", name="old", facts=(fact("housekeeping", "Stopped: its volumes still bill"),))
    gaps = [
        record_gap("backup_not_configured", "/r/web", "last_backup", "none", source="aws_backup"),
        record_gap("backup_not_configured", "/r/web", "backup_vault", "none", source="aws_backup"),
    ]
    return build_snapshot_view(sf.build(resources=[web, old], gaps=gaps))


def test_findings_are_one_per_kind_and_resource_with_a_stable_key() -> None:
    found = findings_of(view())
    assert [(f.key, f.title) for f in found] == [
        ("backup:/r/web", "Back up web"),
        ("housekeeping:/r/old", "old: Stopped: its volumes still bill"),
        ("rightsizing:/r/web", "Resize web (Overprovisioned) to t4g.nano"),
    ]


def test_rows_compare_the_register_with_this_snapshot() -> None:
    messages = load_messages("en")
    register = [
        # Still found: keeps its owner and status.
        {"key": "backup:/r/web", "status": "accepted", "owner": "customer", "since": "Aug 2026", "title": "Back up web"},
        # Gone from this snapshot: resolved here, not a month later.
        {"key": "housekeeping:/r/gone", "status": "open", "owner": "msp", "since": "Jul 2026", "title": "gone: Not attached"},
        # Resolved before and found again: reopened.
        {"key": "housekeeping:/r/old", "status": "resolved", "owner": "msp", "since": "Jun 2026"},
        # Not the declared shape: skipped, never a failed report.
        {"key": 7, "status": "open"},
    ]
    rows = action_rows(
        findings_of(view()), register, messages=messages, resolved=frozenset({"housekeeping:/r/gone"})
    )
    assert rows == [
        ["Back up web", "Customer", "Accepted", "Aug 2026"],
        ["old: Stopped: its volumes still bill", "MSP", "Reopened", "Jun 2026"],
        ["Resize web (Overprovisioned) to t4g.nano", "—", "New", "This report"],
        ["gone: Not attached", "MSP", "Resolved", "Jul 2026"],
    ]
    # Missing but never checked: it keeps its status rather than closing on absence.
    unchecked = action_rows(findings_of(view()), register, messages=messages)
    assert unchecked[-1] == ["gone: Not attached", "MSP", "Open", "Jul 2026"]


def test_only_checked_or_advisor_answered_keys_resolve() -> None:
    from reporting_agent.compile.actions import checked_keys, resolved_keys

    v = view()
    checked = checked_keys(v)
    # `web` has a housekeeping fact of `none` and a rightsizing finding recommending change.
    assert "housekeeping:/r/web" in checked and "rightsizing:/r/web" not in checked
    keys = ["housekeeping:/r/web", "housekeeping:/r/elsewhere", "advisor:/r/rec-1"]
    assert resolved_keys(keys, findings_of(v), checked, advisor=False) == {"housekeeping:/r/web"}
    assert resolved_keys(keys, findings_of(v), checked, advisor=True) == {"housekeeping:/r/web", "advisor:/r/rec-1"}


def test_nothing_to_do_says_so_and_a_long_register_is_capped() -> None:
    messages = load_messages("en")
    assert action_rows((), None, messages=messages) == [["No open actions.", "", "", ""]]
    register = [{"key": f"housekeeping:/r/{n:03}", "status": "open", "title": f"r{n}"} for n in range(80)]
    rows = action_rows((), register, messages=messages)
    assert len(rows) == MAX_ROWS
    assert rows[-1][0] == "…and 31 more in the app."
