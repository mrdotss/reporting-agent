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
    DECLARED_GAP_TYPES,
    FACT_GAP_TYPES,
    GAP_TYPE_BACKUP_NOT_CONFIGURED,
    GAP_TYPE_INTERVAL_MALFORMED,
    GAP_TYPE_METRIC_NOT_EMITTED,
    GAP_TYPE_PERMISSION_DENIED,
    record_gap,
)
from reporting_agent.collect.snapshot import (
    CONTENT_HASH_FIELD,
    SNAPSHOT_ID_FIELD,
    SNAPSHOT_SCHEMA_VERSION,
)
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

# The two fixtures' digests, pinned **at a stated `SNAPSHOT_SCHEMA_VERSION`**.
#
# A change here is not a fixture to refresh. It means every archived report's snapshot would
# now re-hash differently, which is the one thing an immutable content-addressed document may
# not do — so a moved digest is either a defect or a **declared shape bump**, and the two are
# told apart by whether `SNAPSHOT_SCHEMA_VERSION` moved with it.
#
# History, kept because it is the evidence that each field addition was digest-neutral on its
# own:
#
#   1.0.x  7fa6dc73…  /  cd0e1ccd…   computed at commit 09e9449 from a pristine `git worktree`
#                                    before `interval_start` existed, and unchanged by
#                                    `interval_start` and then by `source` — both omitted when
#                                    absent, which is what kept them stable
#   1.2.0  1e5c01fc…  /  bf5a9b24…   `resources[].facts` is emitted **always, including empty**
#                                    (Req 4.6), so every digest moved at that bump by design
#
# `test_omitting_a_field_is_digest_neutral_whatever_the_schema_version` below asserts the part
# of this that must hold forever, without a literal: the omission itself changes nothing.
PINNED_AT_SCHEMA_VERSION: Final[str] = "1.2.0"
TWO_VM_DIGEST: Final[str] = (
    "1e5c01fca8a4c4911c220b0f22fde4000f28390c196d5da0018aa904928cf0fd"
)
EVERY_GAP_TYPE_DIGEST: Final[str] = (
    "bf5a9b24809c5675721f1e597b5d535a83c5b7db3ffeb91e992b4c44daf3be5a"
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


def test_the_pinned_digests_are_pinned_at_the_current_schema_version() -> None:
    """The guard on the two literals below.

    They are absolute digests, so they move whenever the snapshot's *shape* changes — and a
    shape change is legitimate exactly when `SNAPSHOT_SCHEMA_VERSION` is bumped to declare it.
    This test is what makes the pair of facts inseparable: recomputing a literal without
    bumping the version fails here, and so does bumping the version without recomputing.

    Without it, "refresh the constant until the test goes green" would be an available and
    invisible response to a genuine content-addressing defect.
    """
    assert PINNED_AT_SCHEMA_VERSION == SNAPSHOT_SCHEMA_VERSION, (
        f"the digests below were pinned at snapshot schema {PINNED_AT_SCHEMA_VERSION} and the "
        f"module now declares {SNAPSHOT_SCHEMA_VERSION}. If the shape change was deliberate, "
        f"recompute both literals and move this constant in the same edit; if it was not, the "
        f"digest change is the defect"
    )


def test_the_two_vm_snapshot_digest_is_unchanged_by_the_new_field() -> None:
    """The literal was computed before `interval_start` existed and has moved only once since,
    at the declared `1.2.0` shape bump. See the constants above for the history."""
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


# --- the four fact gap types, and `source` (Req 5.1-5.4, 5.10) ----------------------


def test_the_declared_gap_type_partition_holds_exactly_twenty_five_values() -> None:
    """The count is asserted in `collect/log.py` itself; this asserts *which* five were
    added, because a count is satisfied by any five strings."""
    assert len(DECLARED_GAP_TYPES) == 25
    assert FACT_GAP_TYPES == {
        "backup_not_configured",
        "no_reservations",
        "replication_not_enabled",
        "advisor_not_available",
        "fact_unavailable",
    }
    assert FACT_GAP_TYPES < DECLARED_GAP_TYPES


@pytest.mark.parametrize("gap_type", sorted(FACT_GAP_TYPES))
def test_a_fact_gap_must_name_the_source_it_queried(gap_type: str) -> None:
    """Req 5.10, enforced at the gate rather than trusted to the fold.

    A fact gap's entire content is "I asked a named source and it named nothing". One
    that cannot say where it looked asserts an absence with no evidence behind it, which
    is indistinguishable from never having asked.
    """
    with pytest.raises(ValueError, match="must name the source that was queried"):
        record_gap(gap_type, RESOURCE_ID, "last_backup_status", "no protected item")


@pytest.mark.parametrize("gap_type", sorted(FACT_GAP_TYPES))
def test_a_fact_gap_carrying_its_source_is_accepted(gap_type: str) -> None:
    gap = record_gap(
        gap_type,
        RESOURCE_ID,
        "last_backup_status",
        "no protected item",
        source="recovery_services",
    )

    assert gap["source"] == "recovery_services"
    assert gap["interval_start"] is None


@pytest.mark.parametrize("blank", ["", "   "])
def test_an_empty_source_is_refused(blank: str) -> None:
    """Refused for the reason an empty `metric` is refused: a second spelling of `None`."""
    with pytest.raises(ValueError, match="source must be None or a non-empty"):
        record_gap(
            GAP_TYPE_METRIC_NOT_EMITTED, RESOURCE_ID, CPU, "no count", source=blank
        )


def test_a_metric_gap_needs_no_source_and_carries_none() -> None:
    """The twenty original types are unaffected — the conditional requirement is scoped to
    the four, so every existing call site keeps working with four positional arguments."""
    gap = record_gap(GAP_TYPE_PERMISSION_DENIED, RESOURCE_ID, None, "403 on the resource")

    assert gap["source"] is None


def test_a_gap_carrying_no_source_emits_no_such_key() -> None:
    document = two_vm_snapshot()

    for gap in document["gaps"]:
        assert "source" not in gap


def test_adding_source_moved_neither_committed_digest() -> None:
    """The same two literals the `interval_start` tests pin, asserted again after a second
    field was added.

    Not redundant: the omission is what keeps them stable, and it is a separate omission
    per field. A change that emitted `source` as `null` on the twenty types that do not
    carry one would move both digests exactly as emitting `interval_start` as `null`
    would, and the two fields are omitted by two different lines of code.
    """
    assert two_vm_snapshot()[CONTENT_HASH_FIELD] == TWO_VM_DIGEST
    assert snapshot_with_every_gap_type()[CONTENT_HASH_FIELD] == EVERY_GAP_TYPE_DIGEST


def test_omitting_a_field_is_digest_neutral_whatever_the_schema_version() -> None:
    """The part of the two literals' claim that must hold **forever**, asserted without one.

    The literals above are absolute, so a declared shape bump moves them and the history in the
    constants is the only record that each field addition was neutral at the time. This is the
    same claim in a form no bump can invalidate: a gap that carries `interval_start=None` and
    `source=None` hashes identically to one whose dict never had those keys.

    That equality is what "omitted when absent" *means*, and it is the property that keeps every
    archived snapshot's digest reproducible across a field addition. A builder that emitted
    either field as `null` would fail here at any schema version.
    """
    from reporting_agent.collect.snapshot import canonical_bytes

    absent = canonical_bytes(
        build(
            resources=[vm(resource_id=RESOURCE_ID, name="prod-web-01")],
            gaps=[
                record_gap(
                    GAP_TYPE_PERMISSION_DENIED, RESOURCE_ID, None, "403 on the resource"
                )
            ],
        )
    )

    assert b'"interval_start"' not in absent
    assert b'"source"' not in absent

    # The positive control, without which the two assertions above would pass just as happily
    # against a builder that emitted neither field under any circumstances — which is the
    # "asserting an omission rather than an absence of implementation" trap the interval tests
    # already guard against with their own digest-moves case.
    present = canonical_bytes(
        build(
            resources=[vm(resource_id=RESOURCE_ID, name="prod-web-01")],
            gaps=[
                record_gap(
                    GAP_TYPE_METRIC_NOT_EMITTED,
                    RESOURCE_ID,
                    CPU,
                    "no count",
                    INTERVAL_START,
                ),
                record_gap(
                    GAP_TYPE_BACKUP_NOT_CONFIGURED,
                    RESOURCE_ID,
                    "last_backup_status",
                    "no backup",
                    source="recovery_services",
                ),
            ],
        )
    )

    assert b'"interval_start"' in present
    assert b'"source"' in present


def test_a_gap_carrying_a_source_does_move_the_digest() -> None:
    """Guard the guard, for `source` this time: the omission above is an omission and not
    an absence of implementation."""
    without = build(
        resources=[vm(resource_id=RESOURCE_ID, name="prod-web-01")],
        gaps=[record_gap(GAP_TYPE_METRIC_NOT_EMITTED, RESOURCE_ID, CPU, "no count")],
    )
    with_source = build(
        resources=[vm(resource_id=RESOURCE_ID, name="prod-web-01")],
        gaps=[
            record_gap(
                "backup_not_configured",
                RESOURCE_ID,
                "last_backup_status",
                "no protected item",
                source="recovery_services",
            )
        ],
    )

    assert with_source["gaps"][0]["source"] == "recovery_services"
    assert "source" not in without["gaps"][0]
    assert with_source[CONTENT_HASH_FIELD] != without[CONTENT_HASH_FIELD]
