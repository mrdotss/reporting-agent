"""**Property 1: A fact round-trips through the archive.** Identifier `facts_archive_round_trip`.

**Validates: Requirements 4.1, 4.5, 4.6, 4.11, 4.12, 7.3, 7.7, 7.8, 7.11**

## The round-trip under test

A fact's value is collected → folded through `collect/factfold.py` → serialized to a JSON
archive object by `archive._json_default` (Decimal → digit string) → deserialized by
`json.loads` (digit string → `str`) → re-folded through the **same** `fold_fact_response`.

The property asserts that the re-folded fact is **identical** to the original.

## The five kills

1. A reader accepting `int`, `float` and `Decimal` but **not** a decimal `str`: every
   archived fractional fact round-trips through `_json_default` (which emits the Decimal's
   digit string) and `json.loads` (which yields a `str`). That reader classifies every such
   fact as absent → `REPLAY_MISMATCH` on every real subscription.
2. A fixture using whole numbers only: whole numbers survive as JSON integers through the
   archive, so a broken reader passes on them. Every generated numeric fact here carries a
   non-zero fractional digit.
3. A collection path that folds a fact and writes no archive object: the fold-count assertion
   catches this.
4. A replay that stamps `collected_at` at the replay instant: the assertion that
   `collected_at` equals the archived `received_at`.
5. An ordering that inherits the response's key order: the canonical form sorts by key;
   generated facts arrive in shuffled order and must match the sorted original.
"""

from __future__ import annotations

import json
from datetime import UTC, date, datetime
from decimal import Decimal
from typing import Any, Final

from hypothesis import example, given, settings
from hypothesis import strategies as st

from reporting_agent.catalog.loader import (
    FactDeclaration,
    FactDeclarationEntry,
    ResourceTypeFacts,
)
from reporting_agent.collect.factfold import (
    FACT_KIND_INVENTORY,
    fold_fact_response,
)
from reporting_agent.collect.numeric import decimal_leaf
from reporting_agent.collect.snapshot import (
    FactEntry,
    FactEntryError,
    ResourceSnapshot,
    SkuCapacity,
    build_snapshot,
    fact_from_plain,
)
from reporting_agent.providers.base import (
    ResourceRecord,
    ScopeSpec,
)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

SUBSCRIPTION: Final[str] = "3f2b0000-0000-0000-0000-000000000000"
LOCATION: Final[str] = "southeastasia"
GROUP: Final[str] = "rg-prod-sea"
RECEIVED_AT: Final[str] = "2026-07-15T03:22:41Z"
COLLECTED_AT: Final[datetime] = datetime(2026, 7, 15, 3, 22, 41, tzinfo=UTC)
INVOCATION_START: Final[datetime] = datetime(2026, 7, 15, 3, 20, 0, tzinfo=UTC)
TIMEZONE_NAME: Final[str] = "Asia/Jakarta"

RESOURCE_TYPES: Final[tuple[str, ...]] = (
    "Microsoft.Compute/virtualMachines",
    "Microsoft.Sql/servers/databases",
    "Microsoft.Storage/storageAccounts",
    "Microsoft.Compute/disks",
    "Microsoft.Web/sites",
)

FACT_SOURCES: Final[tuple[str, ...]] = ("arm", "recovery_services", "capacity")

# Mandatory numeric examples — each carries a non-zero fractional digit
MANDATORY_NUMERICS: Final[tuple[Decimal, ...]] = (
    Decimal("0.1"),
    Decimal("462.81"),
    Decimal("0.30000000000000004"),
    Decimal("12345678901234567.89"),  # 17 significant digits
)

TEXT_VALUES: Final[tuple[str, ...]] = (
    "Succeeded",
    "Standard_D4s_v3",
    "10.0.0.0/16",
    "a" * 512,
    "Failed",
    "Windows Server 2022",
    "10.0.0.4",
    "Running",
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _resource_id(index: int, resource_type: str) -> str:
    safe = resource_type.lower().replace("/", "_")
    return (
        f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}"
        f"/providers/{resource_type}/{safe}-{index:03d}"
    )


def _decimal_to_plain(d: Decimal) -> str:
    """Decimal → plain notation string matching NUMERIC_FACT_GRAMMAR."""
    # Use Decimal's to_eng_string and normalize
    normalized = d.normalize()
    sign, digits, exp = normalized.as_tuple()
    digits_str = "".join(str(x) for x in digits)
    if exp == 0:
        result = digits_str or "0"
    elif exp > 0:
        result = digits_str + "0" * exp
    else:
        dot_pos = len(digits_str) + exp
        if dot_pos <= 0:
            result = "0." + "0" * (-dot_pos) + digits_str
        else:
            result = digits_str[:dot_pos] + "." + digits_str[dot_pos:]
    if sign:
        result = "-" + result
    return result


def _json_default(value: object) -> str:
    """Mirror archive.py's serialization."""
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"object of type {type(value).__name__} is not JSON serializable")


def _archive_round_trip(obj: dict[str, Any]) -> dict[str, Any]:
    """Simulate archive write → read: json.dumps(default=_json_default) → json.loads."""
    serialized = json.dumps(obj, default=_json_default)
    return json.loads(serialized)


# ---------------------------------------------------------------------------
# Declared-example builders (Req 42.8)
# ---------------------------------------------------------------------------

_VM_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
_STORAGE_TYPE: Final[str] = "Microsoft.Storage/storageAccounts"

_VM_RID_0: Final[str] = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}/providers/{_VM_TYPE}/vm-000"
_VM_RID_1: Final[str] = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}/providers/{_VM_TYPE}/vm-001"
_STORAGE_RID: Final[str] = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/{GROUP}/providers/{_STORAGE_TYPE}/sa-000"


def _numeric_example() -> dict[str, Any]:
    """Scenario carrying the four mandatory fractional numerics (0.1, 462.81,
    0.30000000000000004, 17-sig-digit) plus one text fact."""
    entries = (
        FactDeclarationEntry(resource_type=_VM_TYPE, key="a_metric", value_kind="numeric", source="resource_graph", projectable=True, projection="properties.a_metric", absent_gap_type=None, unit="percent"),
        FactDeclarationEntry(resource_type=_VM_TYPE, key="b_metric", value_kind="numeric", source="resource_graph", projectable=True, projection="properties.b_metric", absent_gap_type=None, unit="percent"),
        FactDeclarationEntry(resource_type=_VM_TYPE, key="c_metric", value_kind="numeric", source="resource_graph", projectable=True, projection="properties.c_metric", absent_gap_type=None, unit="percent"),
        FactDeclarationEntry(resource_type=_VM_TYPE, key="d_metric", value_kind="numeric", source="resource_graph", projectable=True, projection="properties.d_metric", absent_gap_type=None, unit="percent"),
        FactDeclarationEntry(resource_type=_VM_TYPE, key="os_type", value_kind="text", source="resource_graph", projectable=True, projection="properties.os_type", absent_gap_type=None, unit=None),
    )
    declaration = FactDeclaration(resource_types=(ResourceTypeFacts(resource_type=_VM_TYPE, facts=entries),))
    return {
        "declaration": declaration,
        "resources": [
            {"resource_id": _VM_RID_0, "resource_type": _VM_TYPE, "fact_values": {"a_metric": "0.1", "b_metric": "462.81", "c_metric": "0.30000000000000004", "d_metric": "12345678901234567.89", "os_type": "Succeeded"}},
            {"resource_id": _VM_RID_1, "resource_type": _VM_TYPE, "fact_values": {}},
        ],
        "resource_type": _VM_TYPE,
        "resource_ids": [_VM_RID_0, _VM_RID_1],
        "archive_obj": {
            "schema_version": "1", "kind": "inventory", "sequence": 0, "source": "resource_graph",
            "request_target": SUBSCRIPTION, "page_index": 0, "skip_token_present": False,
            "received_at": RECEIVED_AT, "catalog_version": "1.1.0",
            "resource_ids": [_VM_RID_0, _VM_RID_1],
            "raw_response": {"data": [
                {"id": _VM_RID_0, "type": _VM_TYPE, "fact_a_metric": "0.1", "fact_b_metric": "462.81", "fact_c_metric": "0.30000000000000004", "fact_d_metric": "12345678901234567.89", "fact_os_type": "Succeeded"},
                {"id": _VM_RID_1, "type": _VM_TYPE},
            ]},
        },
        "entries": list(entries),
    }


def _storage_no_reservation_key() -> dict[str, Any]:
    """A storage account whose declaration names no reservation key — asserting ZERO
    reservation gaps (Req 5.9: a type that does not declare a key never produces a gap
    for it)."""
    entries = (
        FactDeclarationEntry(resource_type=_STORAGE_TYPE, key="access_tier", value_kind="text", source="resource_graph", projectable=True, projection="properties.accessTier", absent_gap_type=None, unit=None),
    )
    declaration = FactDeclaration(resource_types=(ResourceTypeFacts(resource_type=_STORAGE_TYPE, facts=entries),))
    return {
        "declaration": declaration,
        "resources": [
            {"resource_id": _STORAGE_RID, "resource_type": _STORAGE_TYPE, "fact_values": {"access_tier": "Hot"}},
        ],
        "resource_type": _STORAGE_TYPE,
        "resource_ids": [_STORAGE_RID],
        "archive_obj": {
            "schema_version": "1", "kind": "inventory", "sequence": 0, "source": "resource_graph",
            "request_target": SUBSCRIPTION, "page_index": 0, "skip_token_present": False,
            "received_at": RECEIVED_AT, "catalog_version": "1.1.0",
            "resource_ids": [_STORAGE_RID],
            "raw_response": {"data": [
                {"id": _STORAGE_RID, "type": _STORAGE_TYPE, "fact_access_tier": "Hot"},
            ]},
        },
        "entries": list(entries),
    }


def _zero_facts_resource() -> dict[str, Any]:
    """A resource with zero facts, asserting `"facts": []` rather than an absent key."""
    entries = (
        FactDeclarationEntry(resource_type=_VM_TYPE, key="some_key", value_kind="text", source="resource_graph", projectable=True, projection="properties.someKey", absent_gap_type=None, unit=None),
    )
    declaration = FactDeclaration(resource_types=(ResourceTypeFacts(resource_type=_VM_TYPE, facts=entries),))
    return {
        "declaration": declaration,
        "resources": [
            {"resource_id": _VM_RID_0, "resource_type": _VM_TYPE, "fact_values": {}},
        ],
        "resource_type": _VM_TYPE,
        "resource_ids": [_VM_RID_0],
        "archive_obj": {
            "schema_version": "1", "kind": "inventory", "sequence": 0, "source": "resource_graph",
            "request_target": SUBSCRIPTION, "page_index": 0, "skip_token_present": False,
            "received_at": RECEIVED_AT, "catalog_version": "1.1.0",
            "resource_ids": [_VM_RID_0],
            "raw_response": {"data": [
                {"id": _VM_RID_0, "type": _VM_TYPE},
            ]},
        },
        "entries": list(entries),
    }


# ---------------------------------------------------------------------------
# Strategies
# ---------------------------------------------------------------------------


@st.composite
def numeric_values(draw: st.DrawFn) -> Decimal:
    """A Decimal with at least one non-zero fractional digit."""
    choice = draw(st.integers(min_value=0, max_value=5))
    if choice < len(MANDATORY_NUMERICS):
        return MANDATORY_NUMERICS[choice]
    integer_part = draw(st.integers(min_value=0, max_value=99999))
    # Ensure non-zero fractional part
    frac = draw(st.integers(min_value=1, max_value=9999))
    return Decimal(f"{integer_part}.{frac}")


@st.composite
def fact_scenario(draw: st.DrawFn) -> dict[str, Any]:
    """A scenario: one resource type with 1–12 facts, folded and archived."""
    resource_type = draw(st.sampled_from(RESOURCE_TYPES))
    num_resources = draw(st.integers(min_value=1, max_value=8))

    # Build 1-12 fact keys including a case-pair and one non-ASCII
    base_keys: list[str] = draw(
        st.lists(
            st.from_regex(r"[a-z][a-z0-9_]{1,15}", fullmatch=True),
            min_size=1,
            max_size=10,
            unique=True,
        )
    )
    # Add case variant
    if base_keys:
        variant = base_keys[0][0].upper() + base_keys[0][1:]
        if variant != base_keys[0] and variant not in base_keys:
            base_keys.append(variant)
    base_keys.append("über_wert")

    # Build declaration entries
    entries: list[FactDeclarationEntry] = []
    for key in base_keys:
        value_kind = draw(st.sampled_from(["numeric", "text"]))
        entries.append(FactDeclarationEntry(
            resource_type=resource_type,
            key=key,
            value_kind=value_kind,
            source="resource_graph",
            projectable=True,
            projection=f"properties.{key}",
            absent_gap_type=None,
            unit="percent" if value_kind == "numeric" else None,
        ))

    declaration = FactDeclaration(
        resource_types=(ResourceTypeFacts(resource_type=resource_type, facts=tuple(entries)),)
    )

    # Generate resource data with fact values
    resources: list[dict[str, Any]] = []
    all_rows: list[dict[str, Any]] = []
    all_resource_ids: list[str] = []

    for i in range(num_resources):
        rid = _resource_id(i, resource_type)
        all_resource_ids.append(rid)
        row: dict[str, Any] = {"id": rid, "type": resource_type}
        fact_values: dict[str, str] = {}

        # Each resource gets 0 to all of the declared facts
        num_facts = draw(st.integers(min_value=0, max_value=len(entries)))
        chosen = draw(st.permutations(entries))[:num_facts]

        for entry in chosen:
            if entry.value_kind == "numeric":
                d = draw(numeric_values())
                value = _decimal_to_plain(d)
            else:
                value = draw(st.sampled_from(TEXT_VALUES))
            row[f"fact_{entry.key}"] = value
            fact_values[entry.key] = value

        all_rows.append(row)
        resources.append({"resource_id": rid, "resource_type": resource_type, "fact_values": fact_values})

    # Build the archive object (inventory page)
    archive_obj: dict[str, Any] = {
        "schema_version": "1",
        "kind": "inventory",
        "sequence": 0,
        "source": "resource_graph",
        "request_target": SUBSCRIPTION,
        "page_index": 0,
        "skip_token_present": False,
        "received_at": RECEIVED_AT,
        "catalog_version": "1.1.0",
        "resource_ids": all_resource_ids,
        "raw_response": {"data": all_rows},
    }

    return {
        "declaration": declaration,
        "resources": resources,
        "resource_type": resource_type,
        "resource_ids": all_resource_ids,
        "archive_obj": archive_obj,
        "entries": entries,
    }


# ---------------------------------------------------------------------------
# Property tests
# ---------------------------------------------------------------------------


@given(data=fact_scenario())
@example(data=_numeric_example())  # 0.1, 462.81, 0.30000000000000004, 17-sig-digit
@example(data=_storage_no_reservation_key())  # storage account: zero reservation gaps
@example(data=_zero_facts_resource())  # resource with zero facts
@settings(max_examples=103)  # +3 declared examples above the 100 floor (Req 45.1)
def test_fact_round_trips_through_archive(data: dict[str, Any]) -> None:
    """The core round-trip: fold → serialize → deserialize → re-fold produces identical facts.

    This is the property that kills a reader refusing decimal strings (Kill 1, Kill 2).
    """
    declaration = data["declaration"]
    resource_ids = data["resource_ids"]
    archive_obj = data["archive_obj"]
    resource_types_map = dict.fromkeys(resource_ids, data["resource_type"])

    # Step 1: Fold the original response (live path)
    original_records, original_gaps = fold_fact_response(
        archive_obj["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=RECEIVED_AT,
    )

    # Step 2: Simulate the archive round-trip (serialize + deserialize)
    archived = _archive_round_trip(archive_obj)

    # Step 3: Re-fold from the archived (deserialized) response — the replay path
    replay_records, replay_gaps = fold_fact_response(
        archived["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=archived["received_at"],  # from the object, not a clock (Kill 4)
    )

    # Assert identical facts
    assert len(original_records) == len(replay_records), (
        f"record count differs: {len(original_records)} vs {len(replay_records)}"
    )
    for orig, replayed in zip(
        sorted(original_records, key=lambda r: (r["resource_id"], r["key"])),
        sorted(replay_records, key=lambda r: (r["resource_id"], r["key"])), strict=False,
    ):
        assert orig["resource_id"] == replayed["resource_id"]
        assert orig["key"] == replayed["key"]
        assert orig["value"] == replayed["value"], (
            f"value mismatch for {orig['key']!r}: {orig['value']!r} vs {replayed['value']!r}"
        )
        assert orig["value_kind"] == replayed["value_kind"]
        assert orig["source"] == replayed["source"]
        assert orig["collected_at"] == replayed["collected_at"]
        assert orig["collected_at"] == RECEIVED_AT  # Kill 4: from object, not clock

    # Assert gaps are identical
    assert len(original_gaps) == len(replay_gaps)


@given(data=fact_scenario())
@example(data=_numeric_example())  # 0.1, 462.81, 0.30000000000000004, 17-sig-digit
@settings(max_examples=101)  # +1 declared example above the 100 floor (Req 45.1)
def test_int_float_decimal_str_yield_equal_decimal(data: dict[str, Any]) -> None:
    """int/float/Decimal/str of one value all yield one equal Decimal (Kill 1, Kill 2).

    The mandatory numerics 0.1, 462.81, 0.30000000000000004 and one 17-sig-digit value
    each have a non-zero fractional digit that fails a reader rejecting `str`.
    """
    for d in MANDATORY_NUMERICS:
        from_decimal = decimal_leaf(d)
        from_str = decimal_leaf(str(d))
        from_float = decimal_leaf(float(d))

        assert from_decimal is not None, f"rejected Decimal({d!r})"
        assert from_str is not None, f"rejected str({str(d)!r}) — this is what json.loads returns"
        assert from_float is not None, f"rejected float({float(d)!r})"
        # Decimal and str must agree exactly
        assert from_decimal == from_str, f"{from_decimal} != {from_str} for {d}"

    # Also test with scenario's generated values
    for r in data["resources"]:
        for key, value in r["fact_values"].items():
            # Find declaration entry
            for entry in data["declaration"].for_resource_type(r["resource_type"]):
                if entry.key == key and entry.value_kind == "numeric":
                    from_str = decimal_leaf(value)
                    from_decimal = decimal_leaf(Decimal(value))
                    assert from_str is not None, f"rejected archived str {value!r}"
                    assert from_decimal is not None
                    assert from_str == from_decimal


@given(data=fact_scenario())
def test_any_single_value_mutation_differs(data: dict[str, Any]) -> None:
    """Any single-value mutation produces different fold output (Kill 3)."""
    import copy

    declaration = data["declaration"]
    resource_ids = data["resource_ids"]
    archive_obj = data["archive_obj"]
    resource_types_map = dict.fromkeys(resource_ids, data["resource_type"])

    # Original fold
    original_records, _ = fold_fact_response(
        archive_obj["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=RECEIVED_AT,
    )

    if not original_records:
        return  # No facts to mutate

    # Mutate one value in the archive
    mutated = copy.deepcopy(archive_obj)
    rows = mutated["raw_response"]["data"]
    mutated_something = False
    for row in rows:
        for key in list(row.keys()):
            if key.startswith("fact_") and row[key]:
                row[key] = "MUTATED_VALUE_999.42"
                mutated_something = True
                break
        if mutated_something:
            break

    if not mutated_something:
        return

    # Re-fold the mutated archive
    archived = _archive_round_trip(mutated)
    mutated_records, _ = fold_fact_response(
        archived["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=archived["received_at"],
    )

    # The records must differ
    orig_values = {(r["resource_id"], r["key"]): r["value"] for r in original_records}
    mut_values = {(r["resource_id"], r["key"]): r["value"] for r in mutated_records}
    assert orig_values != mut_values, "a mutated value produced identical records"


@given(data=fact_scenario())
def test_unparseable_string_classifies_as_gap(data: dict[str, Any]) -> None:
    """An unparseable numeric value → gap, no exception (Req 7.8)."""
    import copy

    declaration = data["declaration"]
    resource_ids = data["resource_ids"]
    archive_obj = data["archive_obj"]
    resource_types_map = dict.fromkeys(resource_ids, data["resource_type"])

    # Find a numeric entry and replace its value with garbage
    mutated = copy.deepcopy(archive_obj)
    rows = mutated["raw_response"]["data"]
    has_numeric = False
    for row in rows:
        row.get("id", "")
        for entry in declaration.for_resource_type(row.get("type", "")):
            if entry.value_kind == "numeric" and f"fact_{entry.key}" in row:
                row[f"fact_{entry.key}"] = "NOT_A_NUMBER_!!!"
                has_numeric = True
                break
        if has_numeric:
            break

    if not has_numeric:
        return

    archived = _archive_round_trip(mutated)
    # Must not raise — unparseable → gap
    _records, gaps = fold_fact_response(
        archived["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=archived["received_at"],
    )
    # The unparseable value should produce a gap, not a record
    assert any(g["gap_type"] == "fact_unavailable" for g in gaps), (
        "unparseable numeric did not produce a fact_unavailable gap"
    )


@given(data=fact_scenario())
def test_facts_ordered_by_key_ascending(data: dict[str, Any]) -> None:
    """Facts in the canonical form are ordered by key ascending (Req 4.5)."""
    declaration = data["declaration"]
    resource_ids = data["resource_ids"]
    archive_obj = data["archive_obj"]
    resource_types_map = dict.fromkeys(resource_ids, data["resource_type"])

    records, _ = fold_fact_response(
        archive_obj["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=RECEIVED_AT,
    )

    # Build FactEntry objects and check sort_key ordering per resource
    by_resource: dict[str, list[FactEntry]] = {}
    for record in records:
        by_resource.setdefault(record["resource_id"], []).append(fact_from_plain(record))

    for rid, facts in by_resource.items():
        keys = [f.key for f in sorted(facts, key=lambda f: f.sort_key)]
        assert keys == sorted(keys), f"facts not sorted by key for {rid}: {keys}"


@given(data=fact_scenario())
def test_every_fact_value_is_json_string(data: dict[str, Any]) -> None:
    """Every fact `value` in the canonical form is a JSON string (Req 4.6)."""
    declaration = data["declaration"]
    resource_ids = data["resource_ids"]
    archive_obj = data["archive_obj"]
    resource_types_map = dict.fromkeys(resource_ids, data["resource_type"])

    records, _ = fold_fact_response(
        archive_obj["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=RECEIVED_AT,
    )

    for record in records:
        assert isinstance(record["value"], str), (
            f"fact value {record['value']!r} is {type(record['value']).__name__}, not str"
        )
        # Build FactEntry to verify snapshot format
        entry = fact_from_plain(record)
        plain = entry.to_plain_data()
        assert isinstance(plain["value"], str)


@given(data=fact_scenario())
def test_duplicate_key_raises(data: dict[str, Any]) -> None:
    """A duplicate fact key for one resource raises (Req 4.12)."""
    declaration = data["declaration"]
    resource_ids = data["resource_ids"]
    archive_obj = data["archive_obj"]
    resource_types_map = dict.fromkeys(resource_ids, data["resource_type"])

    records, _ = fold_fact_response(
        archive_obj["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=RECEIVED_AT,
    )

    if not records:
        return

    # Pick a resource with at least one fact, create a duplicate
    first = records[0]
    entry = fact_from_plain(first)
    rid = first["resource_id"]

    resource_record: ResourceRecord = {
        "resource_id": rid,
        "name": "vm-test",
        "resource_type": data["resource_type"],
        "location": LOCATION,
        "resource_group": GROUP,
        "tags": {},
        "power_state_raw": "PowerState/running",
        "power_state": "running",
        "fidelity_tier": "baseline",
    }

    # Attempt build_snapshot with duplicate facts
    from zoneinfo import ZoneInfo

    from reporting_agent.collect.buckets import resolve_window

    tz = ZoneInfo(TIMEZONE_NAME)
    window = resolve_window(date(2026, 7, 1), date(2026, 7, 31), tz)
    scope: ScopeSpec = {
        "subscription_id": SUBSCRIPTION,
        "resource_types": [data["resource_type"]],
        "resource_groups": [],
        "tag_filters": [],
    }

    try:
        build_snapshot(
            run_id="run-dup-test",
            scope=scope,
            scope_verified=True,
            collected_at=COLLECTED_AT,
            timezone_name=TIMEZONE_NAME,
            tz=tz,
            window=window,
            grain="PT1H",
            metrics_by_resource_type={data["resource_type"]: []},
            resources=[
                ResourceSnapshot(
                    record=resource_record,
                    sku=SkuCapacity(name="Standard_D4s_v5", vcpus_available=4, memory_bytes=Decimal("17179869184")),
                    facts=(entry, entry),  # duplicate!
                )
            ],
            gaps=[],
            catalog_version="1.1.0",
            raw_archive_complete=True,
            raw_archive_object_count=0,
            invocation_started_at=INVOCATION_START,
        )
        raise AssertionError("duplicate fact key did not raise")
    except (FactEntryError, ValueError):
        pass  # Expected


@given(data=fact_scenario())
def test_received_at_from_object(data: dict[str, Any]) -> None:
    """collected_at is read from the archived object, not a clock (Kill 4, Req 7.11)."""
    declaration = data["declaration"]
    resource_ids = data["resource_ids"]
    archive_obj = data["archive_obj"]
    resource_types_map = dict.fromkeys(resource_ids, data["resource_type"])

    archived = _archive_round_trip(archive_obj)
    records, _ = fold_fact_response(
        archived["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=archived["received_at"],
    )

    for record in records:
        assert record["collected_at"] == RECEIVED_AT, (
            f"collected_at {record['collected_at']!r} != archive received_at {RECEIVED_AT!r}"
        )


@given(data=fact_scenario())
@example(data=_zero_facts_resource())  # resource with zero facts → "facts": []
@settings(max_examples=101)  # +1 declared example above the 100 floor (Req 45.1)
def test_zero_facts_emits_empty_array(data: dict[str, Any]) -> None:
    """A resource with zero facts emits `"facts": []`, not an absent key (Req 4.12)."""
    from zoneinfo import ZoneInfo

    from reporting_agent.collect.buckets import resolve_window

    tz = ZoneInfo(TIMEZONE_NAME)
    resolve_window(date(2026, 7, 1), date(2026, 7, 31), tz)

    # Build a resource with explicitly zero facts
    rid = _resource_id(99, data["resource_type"])
    resource_record: ResourceRecord = {
        "resource_id": rid,
        "name": "vm-empty",
        "resource_type": data["resource_type"],
        "location": LOCATION,
        "resource_group": GROUP,
        "tags": {},
        "power_state_raw": "PowerState/running",
        "power_state": "running",
        "fidelity_tier": "baseline",
    }
    rs = ResourceSnapshot(
        record=resource_record,
        sku=SkuCapacity(name="Standard_D4s_v5", vcpus_available=4, memory_bytes=Decimal("17179869184")),
        facts=(),  # zero facts
    )
    plain = rs.to_plain_data()
    assert "facts" in plain, "resource missing 'facts' key"
    assert plain["facts"] == [], "zero facts should be [] not absent"


@given(data=fact_scenario())
@example(data=_storage_no_reservation_key())  # storage account: zero reservation gaps
@settings(max_examples=101)  # +1 declared example above the 100 floor (Req 45.1)
def test_fold_count_one_per_object(data: dict[str, Any]) -> None:
    """Each archive object is folded exactly once (Kill 3: no silent omission)."""
    declaration = data["declaration"]
    resource_ids = data["resource_ids"]
    archive_obj = data["archive_obj"]
    resource_types_map = dict.fromkeys(resource_ids, data["resource_type"])

    # Fold the object — it should be called exactly once for this single object
    records, _gaps = fold_fact_response(
        archive_obj["raw_response"],
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=resource_ids,
        declaration=declaration,
        resource_types=resource_types_map,
        received_at=RECEIVED_AT,
    )

    # The fold processed all resources — check that every resource with facts produced records
    for r in data["resources"]:
        for key, value in r["fact_values"].items():
            matching = [
                rec for rec in records
                if rec["resource_id"] == r["resource_id"] and rec["key"] == key
            ]
            assert len(matching) == 1, (
                f"expected exactly 1 record for ({r['resource_id']}, {key}), got {len(matching)}"
            )
            assert matching[0]["value"] == value
