"""`compile/snapshot_view.py` — the only source of a value (Req 15.5, 15.11, 16.4, 18.5).

Every document under test is built by the **real** Snapshot_Builder (see
`tests/snapshot_factory.py`), so these tests pin the view against the shape the
collector actually writes rather than against a dict someone typed. A view that kept
passing while the collector's shape moved would surface as a report with missing
figures, not as a red test.
"""

from __future__ import annotations

import dataclasses
from decimal import Decimal

import pytest

import snapshot_factory as sf
from reporting_agent.compile.snapshot_view import (
    CARDINALITY_ESTIMATOR,
    CARDINALITY_NAMESPACE,
    CARDINALITY_SOURCE_KIND,
    CARDINALITY_TOKEN,
    DECIMAL_STRING_PATTERN,
    SKU_CAPABILITIES,
    CountKind,
    SnapshotResolver,
    SnapshotValue,
    SnapshotView,
    build_snapshot_view,
    escape_pointer_token,
    parse_decimal_string,
    pointer,
)
from reporting_agent.errors import CompileFailedError, ErrorCode


@pytest.fixture(scope="module")
def document() -> dict:
    return sf.two_vm_snapshot()


@pytest.fixture(scope="module")
def view(document: dict) -> SnapshotView:
    return build_snapshot_view(document)


def resolve_raw(document: object, raw_pointer: str) -> object:
    """Walk `document` by RFC 6901 pointer, independently of the view's index.

    Deliberately a second implementation: comparing the view's answer against its own
    index would assert nothing about whether the pointer actually addresses that
    position in the bytes on disk.
    """
    node: object = document
    for token in raw_pointer.split("/")[1:]:
        decoded = token.replace("~1", "/").replace("~0", "~")
        if isinstance(node, list):
            node = node[int(decoded)]
        elif isinstance(node, dict):
            node = node[decoded]
        else:  # pragma: no cover - a malformed pointer fails the assertion below
            raise AssertionError(f"{raw_pointer} does not address a position")
    return node


# --------------------------------------------------------------------------- #
# Pointers are derived from position, and they resolve
# --------------------------------------------------------------------------- #


def test_every_indexed_pointer_addresses_exactly_one_value_equal_to_its_decimal_string(
    view: SnapshotView, document: dict
) -> None:
    """The central property (Req 15.5): a pointer resolves to exactly one value, and
    that value's stored decimal string is the string the view parsed.

    Checked over **every** indexed value rather than a sampled one, because the
    interesting failure is an off-by-one in one branch of the walk — day buckets, say,
    or the SKU fields — which a single-value spot check would miss.
    """
    values = view.values()
    assert values, "the fixture snapshot indexed no values"

    stored_values = [
        value
        for value in values
        if not value.pointer.startswith(f"/{CARDINALITY_NAMESPACE}/")
    ]
    assert stored_values, "the fixture snapshot indexed no stored values"

    for value in stored_values:
        addressed = view.resolve_all(value.pointer)
        assert len(addressed) == 1, f"{value.pointer} resolved to {len(addressed)} values"
        assert addressed[0] is value

        stored = resolve_raw(document, value.pointer)
        assert isinstance(stored, str), f"{value.pointer} is a JSON {type(stored).__name__}"
        assert DECIMAL_STRING_PATTERN.match(stored), stored
        assert Decimal(stored) == value.value
        assert stored == f"{value.value:f}", (
            f"{value.pointer}: the view's Decimal does not round-trip to the stored "
            f"string ({stored!r} vs {value.value:f})"
        )


def test_a_derived_cardinality_resolves_and_names_the_collection_it_counted(
    view: SnapshotView, document: dict
) -> None:
    """A count is the one derivation the document format forces.

    `verification_record` must emit the resource count and the gap count **as figures**,
    and a figure needs a re-resolvable `snapshot_path` — but the document carries the
    `resources` array, not its length. So cardinalities live under the reserved
    `/$counts/...` namespace, and the three things that make that honest are asserted here:
    the address re-resolves through the view, it addresses nothing in the document (so it
    cannot be confused for a stored value), and the derivation on the value names the
    collection whose length it is.
    """
    cardinalities = [
        value
        for value in view.values()
        if value.pointer.startswith(f"/{CARDINALITY_NAMESPACE}/")
    ]
    assert cardinalities, "no derived cardinality was indexed"

    for value in cardinalities:
        assert view.resolve(value.pointer) is value
        assert value.pointer.endswith(f"/{CARDINALITY_TOKEN}")
        assert value.estimator == CARDINALITY_ESTIMATOR
        assert value.unit == "count"
        assert value.scale == 0
        assert value.value == value.value.to_integral_value()

        # The derivation is on the value, naming exactly what was counted.
        assert value.formula == f"count({value.derived_from[0].name})"
        assert value.derived_from[0].kind == CARDINALITY_SOURCE_KIND

        # The reserved address is not a position in the document.
        with pytest.raises((KeyError, IndexError, ValueError, AssertionError)):
            resolve_raw(document, value.pointer)


def test_the_declared_cardinalities_equal_the_documents_own_lengths(
    view: SnapshotView, document: dict
) -> None:
    resource_count = view.cardinality("resources")
    gap_count = view.cardinality("gaps")
    assert resource_count is not None and gap_count is not None

    assert resource_count.value == Decimal(len(document["resources"]))
    assert gap_count.value == Decimal(len(document["gaps"]))

    for tier, expected in view.tier_counts().items():
        tier_value = view.cardinality("fidelity_tier", tier)
        assert tier_value is not None
        assert tier_value.value == Decimal(expected)

    for gap_type, entries in view.gaps_by_type():
        group = view.cardinality("gaps", "by_type", gap_type)
        assert group is not None
        assert group.value == Decimal(len(entries))

    archive = view.cardinality("raw_archive", "objects")
    assert archive is not None
    assert archive.value == Decimal(view.raw_archive_object_count)


def test_an_absent_cardinality_resolves_to_none(view: SnapshotView) -> None:
    assert view.cardinality("nothing") is None
    assert view.cardinality("gaps", "by_type", "not_a_gap_type") is None


def test_a_statistic_pointer_names_the_position_the_walk_found_it_at(
    view: SnapshotView,
) -> None:
    resource = view.resources[0]
    value = view.stat(resource.resource_id, sf.CPU, "avg")
    assert value is not None
    assert value.pointer.startswith(f"{resource.pointer_prefix}/statistics/")
    assert value.pointer.endswith("/value")


def test_a_day_bucket_pointer_addresses_the_day_bucket_not_the_window(
    view: SnapshotView,
) -> None:
    resource = view.resources[0]
    window_value = view.stat(resource.resource_id, sf.CPU, "avg")
    day_value = view.day_stat(resource.resource_id, sf.CPU, "avg", sf.DAY_ONE)

    assert window_value is not None and day_value is not None
    assert "/day_buckets/" in day_value.pointer
    assert "/day_buckets/" not in window_value.pointer
    # The two are different values at different addresses, which is why the window and
    # day indexes are kept apart rather than collapsed into one lookup.
    assert day_value.pointer != window_value.pointer
    assert day_value.window == sf.DAY_ONE
    assert window_value.window == f"{sf.DAY_ONE}/{sf.DAY_TWO}"


def test_a_sku_capacity_is_a_value_with_its_own_pointer(view: SnapshotView) -> None:
    """`capacity_vs_usage` emits a capacity as a figure, so a capacity needs provenance
    of the same kind a metric value has (Req 16.6)."""
    resource = view.resources[0]

    for capability, unit in SKU_CAPABILITIES:
        value = view.sku_capacity(resource.resource_id, capability)
        assert value is not None, capability
        assert value.pointer == f"{resource.pointer_prefix}/sku/{capability}"
        assert value.unit == unit
        assert value.metric == f"sku.{capability}"
        assert view.resolve(value.pointer) is value


def test_an_unresolvable_pointer_resolves_to_nothing(view: SnapshotView) -> None:
    assert view.resolve_all("/resources/999/statistics/0/value") == ()
    assert view.resolve("/resources/999/statistics/0/value") is None
    assert view.resolve_all("") == ()


def test_the_view_satisfies_the_snapshot_resolver_protocol(view: SnapshotView) -> None:
    """`compile/ast.py` depends on the protocol, not the class, so its re-resolution
    check can be exercised against a resolver that returns nothing or two values."""
    assert isinstance(view, SnapshotResolver)


# --------------------------------------------------------------------------- #
# A miss is None, not an exception
# --------------------------------------------------------------------------- #


def test_a_stat_miss_returns_none_rather_than_raising(view: SnapshotView) -> None:
    """A metric a resource does not emit is a recorded gap, not a compile failure. A
    block that meets one renders the row without that cell; raising here would promote
    an ordinary gap into a terminal error."""
    resource = view.resources[0]

    assert view.stat(resource.resource_id, "Network In Total", "avg") is None
    assert view.stat(resource.resource_id, sf.CPU, "p99") is None
    assert view.stat("/subscriptions/nope/virtualMachines/absent", sf.CPU, "avg") is None
    assert view.stat(resource.resource_id, sf.CPU, "avg", instance="C:") is None


def test_a_day_stat_miss_returns_none_rather_than_raising(view: SnapshotView) -> None:
    resource = view.resources[0]
    assert view.day_stat(resource.resource_id, sf.CPU, "avg", "2026-07-09") is None
    assert view.day_stat(resource.resource_id, "Network In Total", "avg", sf.DAY_ONE) is None


def test_an_absent_resource_resolves_to_none(view: SnapshotView) -> None:
    assert view.resource("/subscriptions/nope/absent") is None
    assert view.resource(view.resources[0].resource_id) is view.resources[0]


def test_a_day_series_omits_days_with_no_value_rather_than_zero_filling(
    view: SnapshotView,
) -> None:
    """A missing day is a gap. A zero would read as a measured idle day, which is the
    single error this whole package exists to prevent."""
    resource = view.resources[0]

    series = view.day_series(resource.resource_id, sf.CPU, "avg")
    assert [local_day for local_day, _ in series] == [sf.DAY_ONE, sf.DAY_TWO]

    # A metric with no day buckets at all yields an empty series, not two zeros.
    assert view.day_series(resource.resource_id, sf.MEMORY_USED_PCT, "avg") == ()


def test_a_day_series_is_ordered_by_local_day(view: SnapshotView) -> None:
    resource = view.resources[0]
    days = [local_day for local_day, _ in view.day_series(resource.resource_id, sf.CPU, "avg")]
    assert days == sorted(days)


# --------------------------------------------------------------------------- #
# The view rejects mutation
# --------------------------------------------------------------------------- #


def test_the_view_rejects_field_assignment(view: SnapshotView) -> None:
    with pytest.raises(dataclasses.FrozenInstanceError):
        view.snapshot_id = "rewritten"  # type: ignore[misc]


def test_a_value_rejects_field_assignment(view: SnapshotView) -> None:
    value = view.stat(view.resources[0].resource_id, sf.CPU, "avg")
    assert value is not None
    with pytest.raises(dataclasses.FrozenInstanceError):
        value.value = Decimal("0")  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        value.pointer = "/resources/0/statistics/0/value"  # type: ignore[misc]


def test_a_resource_rejects_field_assignment_and_its_tags_reject_item_assignment(
    view: SnapshotView,
) -> None:
    """A frozen dataclass blocks assignment *through the dataclass* and would happily
    hand out a mutable dict to edit in place — which is why `tags` is a read-only
    mapping proxy rather than a `dict`."""
    resource = view.resources[0]

    with pytest.raises(dataclasses.FrozenInstanceError):
        resource.fidelity_tier = "enhanced"  # type: ignore[misc]

    with pytest.raises(TypeError):
        resource.tags["env"] = "staging"  # type: ignore[index]


def test_every_collection_on_the_view_is_immutable(view: SnapshotView) -> None:
    assert isinstance(view.resources, tuple)
    assert isinstance(view.gaps, tuple)
    assert isinstance(view.day_names, tuple)
    assert isinstance(view.values(), tuple)

    with pytest.raises(TypeError):
        view.tier_counts()["baseline"] = 99  # type: ignore[index]


# --------------------------------------------------------------------------- #
# Counts
# --------------------------------------------------------------------------- #


def test_counts_read_from_the_document(view: SnapshotView, document: dict) -> None:
    assert view.count(CountKind.RESOURCES) == len(document["resources"])
    assert view.count(CountKind.GAPS) == len(document["gaps"])
    assert view.count(CountKind.DAY_BUCKETS) == sum(
        len(resource["day_buckets"]) for resource in document["resources"]
    )
    assert view.count(CountKind.STATISTICS) == sum(
        len(resource["statistics"]) + sum(len(b["statistics"]) for b in resource["day_buckets"])
        for resource in document["resources"]
    )


def test_a_resource_count_narrows_by_fidelity_tier() -> None:
    document = sf.build(
        resources=[
            sf.vm(resource_id="/vm/a", name="a", fidelity_tier="baseline"),
            sf.vm(resource_id="/vm/b", name="b", fidelity_tier="enhanced"),
            sf.vm(resource_id="/vm/c", name="c", fidelity_tier="enhanced"),
        ]
    )
    view = build_snapshot_view(document)

    assert view.count(CountKind.RESOURCES) == 3
    assert view.count(CountKind.RESOURCES, fidelity_tier="baseline") == 1
    assert view.count(CountKind.RESOURCES, fidelity_tier="enhanced") == 2
    # An absent tier is zero, not a KeyError — the tier vocabulary is the snapshot's.
    assert view.count(CountKind.RESOURCES, fidelity_tier="premium") == 0
    assert dict(view.tier_counts()) == {"baseline": 1, "enhanced": 2}


def test_a_tier_filter_is_refused_for_a_kind_it_does_not_define(view: SnapshotView) -> None:
    """A "gap count for the enhanced tier" is not a quantity the snapshot defines, and
    answering it with the unfiltered count would be worse than refusing."""
    with pytest.raises(ValueError, match="fidelity_tier"):
        view.count(CountKind.GAPS, fidelity_tier="baseline")


def test_tier_counts_are_ordered_by_tier_name() -> None:
    document = sf.build(
        resources=[
            sf.vm(resource_id="/vm/z", name="z", fidelity_tier="enhanced"),
            sf.vm(resource_id="/vm/a", name="a", fidelity_tier="baseline"),
        ]
    )
    counts = build_snapshot_view(document).tier_counts()
    assert list(counts) == sorted(counts)


# --------------------------------------------------------------------------- #
# Gaps
# --------------------------------------------------------------------------- #


def test_gaps_group_by_type_then_resource_id_both_ascending() -> None:
    view = build_snapshot_view(sf.snapshot_with_every_gap_type())
    grouped = view.gaps_by_type()

    assert [gap_type for gap_type, _ in grouped] == sorted(
        gap_type for gap_type, _ in grouped
    )
    for _, entries in grouped:
        assert [entry.resource_id for entry in entries] == sorted(
            entry.resource_id for entry in entries
        )
    # Every recorded gap survives grouping — Req 29.9 ties the count the
    # `snapshot_ready` event carries to the count recorded during collection.
    assert sum(len(entries) for _, entries in grouped) == view.count(CountKind.GAPS)


def test_a_resource_level_gap_carries_a_null_metric() -> None:
    view = build_snapshot_view(sf.snapshot_with_every_gap_type())
    resource_level = [gap for gap in view.gaps if gap.metric is None]
    assert resource_level, "the fixture declares resource-level gaps"
    assert all(gap.resource_id for gap in resource_level)


# --------------------------------------------------------------------------- #
# Decimal strings, and the refusal of anything else
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "raw", ["0", "-0", "1000", "12.48", "-0.5", "0.000001", "9007199254740993", "007"]
)
def test_a_decimal_string_parses(raw: str) -> None:
    assert DECIMAL_STRING_PATTERN.match(raw)
    assert parse_decimal_string(raw, "/at") == Decimal(raw)


@pytest.mark.parametrize(
    "raw",
    [
        "",
        "-",
        "1.",
        ".5",
        "+1",
        "1e5",
        "1E+3",
        "NaN",
        "Infinity",
        "-inf",
        " 1 ",
        "1_000",
        "1,000",
        "0x10",
    ],
)
def test_a_non_decimal_string_is_refused(raw: str) -> None:
    assert not DECIMAL_STRING_PATTERN.match(raw)
    with pytest.raises(CompileFailedError):
        parse_decimal_string(raw, "/at")


@pytest.mark.parametrize("raw", [12.48, 12, True, None, [], {}])
def test_a_json_number_or_any_non_string_is_refused(raw: object) -> None:
    """A `float` would mean `Decimal(float)` — a binary approximation baked into an
    audit artifact. An `int` would mean the collector failed to render a value as a
    string. Neither is repaired here."""
    with pytest.raises(CompileFailedError) as caught:
        parse_decimal_string(raw, "/resources/0/statistics/0/value")
    assert caught.value.code is ErrorCode.COMPILE_FAILED
    assert "/resources/0/statistics/0/value" in str(caught.value)


def test_scale_is_the_stored_strings_fractional_digit_count(view: SnapshotView) -> None:
    for value in view.values():
        _, _, fraction = f"{value.value:f}".partition(".")
        assert value.scale == len(fraction)


def test_no_value_on_the_view_is_a_float(view: SnapshotView) -> None:
    for value in view.values():
        assert isinstance(value.value, Decimal)
        assert not isinstance(value.value, float)
    for resource in view.resources:
        for capacity in (resource.sku.vcpus_available, resource.sku.memory_bytes):
            assert capacity is None or isinstance(capacity, Decimal)


# --------------------------------------------------------------------------- #
# Pointer construction, escaping, and the refusal of a fabricated provenance
# --------------------------------------------------------------------------- #


def test_pointer_builds_an_rfc_6901_pointer() -> None:
    assert pointer("resources", 3, "statistics", 0, "value") == (
        "/resources/3/statistics/0/value"
    )
    assert pointer("gaps", 0) == "/gaps/0"


@pytest.mark.parametrize(
    ("token", "escaped"),
    [
        ("value", "value"),
        ("a/b", "a~1b"),
        ("a~b", "a~0b"),
        ("~/", "~0~1"),
        ("/subscriptions/x", "~1subscriptions~1x"),
    ],
)
def test_pointer_tokens_escape_tilde_before_slash(token: str, escaped: str) -> None:
    """`~` first: the other order would re-escape the `~` the `/` replacement
    introduces, silently addressing a different position."""
    assert escape_pointer_token(token) == escaped


def _valid_value(**over: object) -> dict[str, object]:
    base: dict[str, object] = {
        "value": Decimal("1.00"),
        "unit": "percent",
        "statistic": "avg",
        "estimator": "exact_count_weighted",
        "fidelity_tier": "baseline",
        "scale": 2,
        "metric": sf.CPU,
        "resource_id": "/vm/a",
        "window": "2026-07-01/2026-07-02",
        "pointer": "/resources/0/statistics/0/value",
    }
    base.update(over)
    return base


def test_a_snapshot_value_accepts_a_pointer_the_walk_could_have_produced() -> None:
    assert SnapshotValue(**_valid_value()).pointer.endswith("/value")  # type: ignore[arg-type]
    assert SnapshotValue(
        **_valid_value(pointer="/resources/2/sku/memory_bytes")  # type: ignore[arg-type]
    ).pointer.endswith("/memory_bytes")


@pytest.mark.parametrize(
    "bad",
    [
        "",
        "resources/0/statistics/0/value",  # no leading slash
        "/resources/0/statistics/0",  # does not address a value field
        "/resources/0/statistics/0/sample_count",  # addresses a count, not a value
        "/resources/0/name",
    ],
)
def test_a_snapshot_value_refuses_a_pointer_that_addresses_no_value(bad: str) -> None:
    """The pointer is *derived* from position by the walk. Nothing mints a
    `SnapshotValue` from a caller-supplied provenance, and this check is what makes a
    fabricated one detectable rather than merely discouraged."""
    with pytest.raises(CompileFailedError):
        SnapshotValue(**_valid_value(pointer=bad))  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# Documents the view refuses to read
# --------------------------------------------------------------------------- #


def test_a_document_missing_a_required_field_is_a_compile_failure() -> None:
    document = sf.two_vm_snapshot()
    del document["window"]
    with pytest.raises(CompileFailedError, match="/window"):
        build_snapshot_view(document)


def test_a_value_that_is_a_json_number_is_a_compile_failure_naming_the_pointer() -> None:
    document = sf.two_vm_snapshot()
    document["resources"][0]["statistics"][0]["value"] = 12.48

    with pytest.raises(CompileFailedError) as caught:
        build_snapshot_view(document)
    assert "/resources/0/statistics/0/value" in str(caught.value)
    assert caught.value.terminal is True


def test_a_resource_with_no_resolvable_sku_capacity_yields_no_capacity_value() -> None:
    """The snapshot omits an unresolved capability rather than carrying a zero. The
    view preserves that: no capacity figure is emitted, which is a different document
    from one emitting `0`."""
    document = sf.build(
        resources=[
            sf.vm(
                resource_id="/vm/a",
                name="a",
                vcpus_available=None,
                memory_bytes=None,
            )
        ]
    )
    view = build_snapshot_view(document)

    assert view.sku_capacity("/vm/a", "vcpus_available") is None
    assert view.sku_capacity("/vm/a", "memory_bytes") is None
    assert view.resources[0].sku.vcpus_available is None
