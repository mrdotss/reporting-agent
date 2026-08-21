"""`GapRecord.interval_start` — the field, its one validation, its two call sites, and
the digest it must not have moved (Req 20.4).

## Why this field exists at all

A gap of type `interval_counts_missing` or `interval_malformed` is a statement about
**one interval**, and until this field existed the record did not say which one. That is
not a cosmetic omission: `.kiro/steering/azure-integration.md` records a running VM
emitting `{"timeStamp": ...}` and nothing else for a **64-hour contiguous stretch**
across all eight of its metrics simultaneously, which is ~512 honest gap entries. Whether
those 512 are one 64-hour hole or 512 unrelated flickers is the only question a reader
actually has, and it is answerable only if each entry carries its interval's start.

## The two halves this module keeps together

**The field is populated by the sites that have an interval**, and `None` everywhere
else — asserted here rather than assumed, because `str(point.get("timeStamp"))` on an
absent value yields the string `"None"`, which would satisfy every "is it a non-empty
string" check while naming an interval that does not exist.

**Adding the field moved no digest.** The two committed literals below were computed
from the pre-change tree — `git worktree` at the commit before `interval_start` existed —
and not from the implementation they now check. That direction matters: a digest fixture
generated *after* a change records whatever the change did, and would have agreed just as
happily with an implementation that emitted `"interval_start": null` on all twenty-odd
gap types that are not about an interval, silently changing the canonical bytes of every
gap ever recorded and therefore the `content_hash` of every snapshot a re-run of an
archived report would produce.

`test_a_gap_carrying_an_interval_start_does_move_the_digest` is the half that makes the
two literals mean something. Without it they would pass against a builder that dropped
`interval_start` on the floor, which is exactly the mistake an omit-when-absent
convention invites.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Final

import pytest

from reporting_agent.collect.accumulate import MetricAccumulator
from reporting_agent.collect.log import (
    GAP_TYPE_INTERVAL_MALFORMED,
    GAP_TYPE_METRIC_NOT_EMITTED,
    GAP_TYPE_PERMISSION_DENIED,
    record_gap,
)
from reporting_agent.collect.snapshot import CONTENT_HASH_FIELD, SNAPSHOT_ID_FIELD
from snapshot_factory import (
    SUBSCRIPTION_ID,
    build,
    snapshot_with_every_gap_type,
    two_vm_snapshot,
    vm,
)

RESOURCE_ID: Final[str] = (
    f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-prod"
    f"/providers/Microsoft.Compute/virtualMachines/prod-web-01"
)
CPU: Final[str] = "Percentage CPU"
INTERVAL_START: Final[str] = "2026-07-01T03:00:00Z"

# Computed against the tree at commit 09e9449, before `interval_start` existed, by
# running `two_vm_snapshot()` / `snapshot_with_every_gap_type()` from a pristine
# `git worktree`. Neither may change for as long as the gaps in those two fixtures carry
# no interval. A change here is not a fixture to refresh — it means every archived
# report's snapshot would now re-hash differently, which is the one thing an immutable
# content-addressed document may not do.
TWO_VM_DIGEST: Final[str] = (
    "7fa6dc73ed7130da755a8bad9763b7d0dca6db9bca8e84cc5388a0e9c312918b"
)
EVERY_GAP_TYPE_DIGEST: Final[str] = (
    "cd0e1ccd580d3fb2c0bf8ee5c8bf4467549683ec2778f1c07ff1c9cc5614f09f"
)


# --- the one validation, in the shape `metric`'s already had ------------------------


def test_interval_start_defaults_to_none_so_every_existing_call_site_is_unchanged() -> None:
    """The twenty-odd resource- and metric-level call sites pass four positional
    arguments and say nothing about an interval. `None` is the honest answer for them:
    a 403 on a resource did not happen at a point in time."""
    gap = record_gap(GAP_TYPE_PERMISSION_DENIED, RESOURCE_ID, None, "403 on the resource")

    assert gap["interval_start"] is None


def test_interval_start_is_carried_through_verbatim() -> None:
    """Passed through exactly as the response spelled it — not reparsed, not
    normalised, not re-rendered. A gap is a record of what arrived, and a
    round-tripped instant would let the record disagree with the document it was read
    from."""
    gap = record_gap(
        GAP_TYPE_METRIC_NOT_EMITTED, RESOURCE_ID, CPU, "no count", INTERVAL_START
    )

    assert gap["interval_start"] == INTERVAL_START


@pytest.mark.parametrize("blank", ["", "   ", "\t\n"])
def test_an_empty_or_blank_interval_start_is_refused(blank: str) -> None:
    """Refused for the reason an empty `metric` is refused, and with the identical
    message shape: an empty string is a second spelling of `None`, and two spellings of
    one absence is precisely the gap this module exists to close.

    Matched on the message rather than on `ValueError` alone, because `GapTypeError` is
    itself a `ValueError` — a bare `pytest.raises(ValueError)` here would pass if the
    call failed for the entirely different reason of an unrecognised gap type.
    """
    with pytest.raises(ValueError, match="interval_start must be None or a non-empty"):
        record_gap(GAP_TYPE_METRIC_NOT_EMITTED, RESOURCE_ID, CPU, "no count", blank)


# --- the `interval_malformed` call site (the second of the two) ---------------------


def test_a_malformed_interval_records_the_interval_it_was_malformed_at() -> None:
    """`collect/accumulate.py`'s `fold_interval` is where `interval_malformed` is built,
    so the timestamp has to reach it as an argument — `azure/metrics.py` is the module
    that reads the response and the accumulator never sees one."""
    accumulator = MetricAccumulator()

    gap = accumulator.fold_interval(
        total=Decimal(720),
        count="not a decimal",
        minimum=None,
        maximum=None,
        resource_id=RESOURCE_ID,
        metric=CPU,
        interval_start=INTERVAL_START,
    )

    assert gap is not None
    assert gap["gap_type"] == GAP_TYPE_INTERVAL_MALFORMED
    assert gap["interval_start"] == INTERVAL_START


def test_a_malformed_interval_with_no_timestamp_still_records_the_gap() -> None:
    """The honest-absence path. An interval whose own start could not be read is still
    a malformed interval and still recorded — it simply names no instant, rather than
    naming the string `"None"`."""
    accumulator = MetricAccumulator()

    gap = accumulator.fold_interval(
        total=Decimal(720),
        count="not a decimal",
        minimum=None,
        maximum=None,
        resource_id=RESOURCE_ID,
        metric=CPU,
    )

    assert gap is not None
    assert gap["gap_type"] == GAP_TYPE_INTERVAL_MALFORMED
    assert gap["interval_start"] is None


# --- the digest that must not have moved -------------------------------------------


def test_a_gap_carrying_no_interval_start_emits_no_such_key() -> None:
    """Omit-when-absent, asserted on the emitted object rather than on the builder's
    intent. This is the mechanism the two digest literals below depend on."""
    document = two_vm_snapshot()

    assert document["gaps"], "the fixture records no gap, so it proves nothing here"
    for gap in document["gaps"]:
        assert "interval_start" not in gap
        assert None not in gap.values()


def test_the_two_vm_snapshot_digest_is_unchanged_by_the_new_field() -> None:
    """The literal was computed before `interval_start` existed. See the module
    docstring on why it is a committed constant rather than a recomputed value."""
    document = two_vm_snapshot()

    assert document[CONTENT_HASH_FIELD] == TWO_VM_DIGEST
    assert document[SNAPSHOT_ID_FIELD] == TWO_VM_DIGEST


def test_the_every_gap_type_snapshot_digest_is_unchanged_by_the_new_field() -> None:
    """The second fixture, and the one that actually exercises the omission across
    more than one gap type: three gaps, two resource-level and one metric-level, none
    of them about an interval."""
    document = snapshot_with_every_gap_type()

    assert len(document["gaps"]) == 3
    assert document[CONTENT_HASH_FIELD] == EVERY_GAP_TYPE_DIGEST
    assert document[SNAPSHOT_ID_FIELD] == EVERY_GAP_TYPE_DIGEST


def test_a_gap_carrying_an_interval_start_does_move_the_digest() -> None:
    """Guard the guard.

    The two literals above assert that the canonical bytes did not move. On their own
    they would pass just as well against a builder that emitted `interval_start`
    nowhere at all — so this is the assertion that proves the field reaches the
    canonical form when it applies, and therefore that the ones above are asserting an
    omission rather than an absence of implementation.
    """
    without = build(
        resources=[vm(resource_id=RESOURCE_ID, name="prod-web-01")],
        gaps=[record_gap(GAP_TYPE_METRIC_NOT_EMITTED, RESOURCE_ID, CPU, "no count")],
    )
    with_interval = build(
        resources=[vm(resource_id=RESOURCE_ID, name="prod-web-01")],
        gaps=[
            record_gap(
                GAP_TYPE_METRIC_NOT_EMITTED, RESOURCE_ID, CPU, "no count", INTERVAL_START
            )
        ],
    )

    assert with_interval["gaps"][0]["interval_start"] == INTERVAL_START
    assert "interval_start" not in without["gaps"][0]
    assert with_interval[CONTENT_HASH_FIELD] != without[CONTENT_HASH_FIELD]
