"""At a glance: distinct-resource counts, and the rules that choose its decisions."""

from __future__ import annotations

import snapshot_factory as sf
from reporting_agent.collect.log import record_gap
from reporting_agent.collect.snapshot import FactEntry
from reporting_agent.compile.blocks.glance import MAX_DECISIONS, decisions_for
from reporting_agent.compile.snapshot_view import build_snapshot_view


def fact(key: str, value: str, source: str = "aws") -> FactEntry:
    return FactEntry(key=key, value=value, value_kind="text", source=source,
                     collected_at="2026-08-01T00:00:00Z", formatted=value)


def view(resources: list[object], gaps: list[object] | None = None):
    return build_snapshot_view(sf.build(resources=resources, gaps=gaps or []))


def test_counts_are_distinct_resources_and_zero_is_still_a_figure() -> None:
    vm_a = sf.vm(resource_id="/r/vm-a", name="vm-a", facts=(fact("housekeeping", "Deallocated: its disks still bill"),))
    vm_b = sf.vm(resource_id="/r/vm-b", name="vm-b", facts=(fact("housekeeping", "none"),))
    gaps = [
        record_gap("backup_not_configured", "/r/vm-a", "last_backup", "none", source="recovery_services"),
        record_gap("backup_not_configured", "/r/vm-a", "last_restore_point", "none", source="recovery_services"),
    ]
    v = view([vm_a, vm_b], gaps)

    assert v.cardinality("resources", "with_finding", "housekeeping").value == 1
    # Two gap entries, one resource.
    assert v.cardinality("resources", "with_gap", "backup_not_configured").value == 1
    assert v.cardinality("resources", "with_gap", "deallocated").value == 0


def test_decisions_follow_what_the_snapshot_holds_most_important_first() -> None:
    quiet = view([sf.vm(resource_id="/r/vm-a", name="vm-a", facts=(fact("housekeeping", "none"),))])
    assert decisions_for(quiet) == ("doc.glance.decision.none",)

    busy = view(
        [
            sf.vm(
                resource_id="/r/vm-a",
                name="vm-a",
                facts=(fact("housekeeping", "Stopped: its volumes and any Elastic IP still bill"),
                       fact("rightsizing_finding", "Overprovisioned", "compute_optimizer")),
            )
        ],
        [record_gap("backup_not_configured", "/r/vm-a", "last_backup", "none", source="aws_backup")],
    )
    decisions = decisions_for(busy)
    assert decisions == (
        "doc.glance.decision.housekeeping",
        "doc.glance.decision.backup",
        "doc.glance.decision.rightsizing",
    )
    assert len(decisions) <= MAX_DECISIONS
