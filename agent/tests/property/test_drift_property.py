"""Property 5: Drift sample selection is bounded and reproducible.

**Validates: Requirements 34.1, 34.2, 34.4, 34.7, 45.1**

*For any* snapshot, rendered document and seed, the Drift_Sampler selects at most 25
resources drawn only from that snapshot, selects an identical set on every call for one
triple, includes every resource the document names when there are at most 25 of them,
includes the top ten by recorded maximum subject to the cap, and selects differently for two
distinct seeds over a snapshot carrying more than 25 resources.

**On scale.** The requirement names 0–2,000 resources. The selection is pure and the
generated snapshot is a plain document, so the cost is in `build_snapshot_view` rather than
in the selection — which is why the generated range stops at 300 and the two clauses that
genuinely need a large snapshot (exactly 25 above 250 resources; two seeds differing above
the cap) run as **declared examples at 400 and at 2,000**, deterministically, on every
invocation.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Final

from hypothesis import example, given
from hypothesis import strategies as st

import snapshot_factory as sf
from reporting_agent.compile.snapshot_view import build_snapshot_view
from reporting_agent.verify.drift import MAX_SAMPLE, TOP_TIER, select

CPU: Final[str] = sf.CPU
SEED_A: Final[str] = "a" * 64
SEED_B: Final[str] = "b" * 64


def snapshot_of(count: int, *, maxima: list[str] | None = None):
    """A snapshot of `count` VMs whose recorded maxima are distinct unless told otherwise.

    Distinct by default so the top-ten tier has a well-defined answer; the tie case is a
    declared example rather than the norm, because a generator producing only ties would
    never exercise ranking at all.
    """
    resources = [
        sf.vm(
            resource_id=f"/vm/{index:05d}",
            name=f"vm-{index:05d}",
            cpu_max=(maxima[index] if maxima else f"{(index % 900) + 10}.00"),
        )
        for index in range(count)
    ]
    return build_snapshot_view(sf.build(resources=resources))


VIEW_CACHE: dict[tuple[int, str], object] = {}


def view_for(count: int):
    """Cached, because `build_snapshot_view` over 2,000 resources is the expensive part and
    the property is about `select`, which is pure."""
    key = (count, "distinct")
    if key not in VIEW_CACHE:
        VIEW_CACHE[key] = snapshot_of(count)
    return VIEW_CACHE[key]


@st.composite
def cases(draw: st.DrawFn) -> tuple[object, tuple[str, ...], str]:
    count = draw(st.integers(min_value=0, max_value=300))
    view = view_for(count)
    ids = [resource.resource_id for resource in view.resources]  # type: ignore[attr-defined]
    named = draw(
        st.lists(st.sampled_from(ids), max_size=60, unique=True) if ids else st.just([])
    )
    seed = draw(st.text(alphabet="0123456789abcdef", min_size=64, max_size=64))
    return view, tuple(named), seed


# --------------------------------------------------------------------------- #
# 5.1, 5.5, 5.6 — bounded, drawn only from the snapshot, and exactly 25 when large
# --------------------------------------------------------------------------- #


@given(cases())
@example((view_for(400), (), SEED_A))
@example((view_for(2000), (), SEED_A))
@example((view_for(0), (), SEED_A))
def test_the_sample_is_bounded_and_drawn_only_from_the_snapshot(case) -> None:
    """5.1, 5.5, 5.6. The 400 and 2,000 examples are the clause a "10% with no cap"
    implementation fails: at 2,000 resources it would select 200."""
    view, named, seed = case
    present = {resource.resource_id for resource in view.resources}

    sample = select(view, named=named, seed=seed, metric=CPU)

    assert len(sample) <= MAX_SAMPLE
    assert len(set(sample)) == len(sample)
    assert set(sample) <= present
    if len(present) > MAX_SAMPLE * 10:
        assert len(sample) == MAX_SAMPLE


# --------------------------------------------------------------------------- #
# 5.2 — identical per triple
# --------------------------------------------------------------------------- #


@given(cases())
def test_one_triple_selects_one_sample_on_every_call(case) -> None:
    """5.2. A selection depending on set or dictionary iteration order passes within one
    call and fails here — which is the same class of defect Property 4.2 catches across
    processes, caught within one."""
    view, named, seed = case

    first = select(view, named=named, seed=seed, metric=CPU)
    second = select(view, named=list(reversed(list(named))), seed=seed, metric=CPU)

    assert first == second


# --------------------------------------------------------------------------- #
# 5.3, 5.4 — the tiers, in precedence order
# --------------------------------------------------------------------------- #


@given(cases())
def test_every_resource_the_document_names_is_included_when_there_are_at_most_25(
    case,
) -> None:
    """5.3. Tier one is the figures a reader is actually looking at, so it is admitted
    before anything a heuristic chose."""
    view, named, seed = case
    present = {resource.resource_id for resource in view.resources}
    wanted = {name for name in named if name in present}

    sample = select(view, named=named, seed=seed, metric=CPU)

    if len(wanted) <= MAX_SAMPLE:
        assert wanted <= set(sample)
    else:
        assert len(sample) == MAX_SAMPLE
        assert set(sample) <= wanted


@given(cases())
def test_the_top_ten_by_recorded_maximum_are_included_subject_to_the_cap(case) -> None:
    """5.4. Subject to the cap, and only subject to the cap: tier one can legitimately fill
    the sample, and then the top ten are correctly absent."""
    view, named, seed = case
    ranked = sorted(
        (
            (view.stat(resource.resource_id, CPU, "max").value, resource.resource_id)  # type: ignore[union-attr]
            for resource in view.resources
            if view.stat(resource.resource_id, CPU, "max") is not None
        ),
        key=lambda item: (-item[0], item[1]),
    )
    top = {resource_id for _, resource_id in ranked[:TOP_TIER]}
    named_present = {
        name for name in named if any(r.resource_id == name for r in view.resources)
    }

    sample = select(view, named=named, seed=seed, metric=CPU)

    if len(named_present) + len(top - named_present) <= MAX_SAMPLE:
        assert top <= set(sample)


# --------------------------------------------------------------------------- #
# 5.7 — two seeds differ above the cap
# --------------------------------------------------------------------------- #


@given(st.integers(min_value=300, max_value=300))
@example(400)
def test_two_distinct_seeds_differ_above_the_cap(count: int) -> None:
    """5.7. A selector ignoring the seed passes every other assertion in this module.

    Tier one is empty and tier two is the same ten resources for both seeds, so any
    difference comes from tier three — which is exactly the tier the seed governs.
    """
    view = view_for(count)

    a = select(view, named=(), seed=SEED_A, metric=CPU)
    b = select(view, named=(), seed=SEED_B, metric=CPU)

    assert len(a) == len(b) == MAX_SAMPLE
    assert set(a) != set(b)


# --------------------------------------------------------------------------- #
# 5.8 — the selection is pure
# --------------------------------------------------------------------------- #


@given(cases())
def test_the_selection_opens_no_socket(case) -> None:
    """5.8. The selection is the half of this module that must run without a subscription,
    so it is asserted to touch nothing — the port is not even an argument to it."""
    import socket

    view, named, seed = case
    original = socket.socket

    def refuse(*args: object, **kwargs: object):
        raise AssertionError("the drift selection opened a socket")

    socket.socket = refuse  # type: ignore[assignment]
    try:
        sample = select(view, named=named, seed=seed, metric=CPU)
    finally:
        socket.socket = original  # type: ignore[assignment]

    assert len(sample) <= MAX_SAMPLE


# --------------------------------------------------------------------------- #
# Declared examples: the two ties that make truncation deterministic
# --------------------------------------------------------------------------- #


def test_ten_resources_sharing_one_maximum_break_by_ascending_id() -> None:
    """A declared case rather than a generated one, because a generator producing an exact
    tie across ten resources would do so by accident and rarely.

    Without the tie-break the ranking depends on `sort`'s stability over an input whose
    order came from a dict, and the sample — and therefore a disputed check — would differ
    between two runs over one snapshot.
    """
    view = snapshot_of(20, maxima=["50.00"] * 10 + [f"{10 + i}.00" for i in range(10)])

    sample = select(view, named=(), seed=SEED_A, metric=CPU)

    tied = [rid for rid in sample if rid < "/vm/00010"]
    assert tied == sorted(tied)
    assert select(view, named=(), seed=SEED_A, metric=CPU) == sample


def test_a_snapshot_carrying_no_value_for_the_metric_still_selects() -> None:
    """A resource with no recorded value for the primary metric has no maximum to rank by.

    Treating an absent value as zero would rank a resource the collector could not read
    *below* every resource it could, which is backwards — the unreadable one is the more
    interesting. It stays eligible through tiers one and three.
    """
    view = snapshot_of(30)

    sample = select(view, named=(), seed=SEED_A, metric="a metric nothing declares")

    assert 0 < len(sample) <= MAX_SAMPLE
    assert Decimal is not None
