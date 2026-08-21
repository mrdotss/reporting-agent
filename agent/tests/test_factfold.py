"""`collect/factfold.py` — the one fact derivation (Req 5.1-5.5, 5.8-5.10, 7.7, 7.8, 7.11).

The assertions are organised around the two things this fold can get wrong in a way nothing
downstream would notice:

* **which keys it visits.** The loop is over the declaration for the row's own resource type,
  so a key the type does not declare is unreachable — no storage account can collect a
  `no_reservations` gap. A fold iterating the response instead would mint facts for keys
  nothing declared, and every shape assertion would still pass.
* **which of the two absences it records.** "The source answered and named nothing" and "we
  could not ask" are opposite facts (Req 5.8), and the report built on the wrong one tells a
  reader their estate is unprotected on the strength of a failed request.

Every value in this module is fed as it would arrive on the wire: the shipped declarations
wrap numerics in `tostring(...)`, so a numeric fact arrives as a **string**, and the fixtures
here do too. A fixture handing the fold a JSON number would be testing a shape Resource Graph
does not send.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any, Final

import pytest

from reporting_agent.catalog.loader import (
    FactDeclaration,
    FactDeclarationEntry,
    ResourceTypeFacts,
    load_catalog,
)
from reporting_agent.collect.factfold import (
    FACT_KIND_FACTS,
    FACT_KIND_INVENTORY,
    FACT_KINDS,
    FACT_VALUE_KIND_NUMERIC,
    FACT_VALUE_KIND_TEXT,
    fold_fact_response,
    projected_facts_from_row,
)
from reporting_agent.collect.log import (
    DECLARED_GAP_TYPES,
    FACT_GAP_TYPES,
    GAP_TYPE_BACKUP_NOT_CONFIGURED,
    GAP_TYPE_FACT_UNAVAILABLE,
    GAP_TYPE_NO_RESERVATIONS,
)

RECEIVED_AT: Final[str] = "2026-07-01T00:00:00Z"

VM_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
STORAGE_TYPE: Final[str] = "Microsoft.Storage/storageAccounts"

WEB_01: Final[str] = (
    "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/rg-prod"
    "/providers/Microsoft.Compute/virtualMachines/prod-web-01"
)
WEB_02: Final[str] = WEB_01.replace("prod-web-01", "prod-web-02")
STORE_01: Final[str] = (
    "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/rg-prod"
    "/providers/Microsoft.Storage/storageAccounts/prodstore01"
)


# --------------------------------------------------------------------------- #
# A small hand-built declaration, so the assertions are about the fold
# --------------------------------------------------------------------------- #


def entry(**overrides: Any) -> FactDeclarationEntry:
    fields: dict[str, Any] = {
        "resource_type": VM_TYPE,
        "key": "os_type",
        "value_kind": FACT_VALUE_KIND_TEXT,
        "source": "resource_graph",
        "projectable": True,
        "projection": "tostring(properties.osType)",
    }
    fields.update(overrides)
    return FactDeclarationEntry(**fields)


OS_TYPE = entry()
DATA_DISKS = entry(
    key="data_disk_count",
    value_kind=FACT_VALUE_KIND_NUMERIC,
    unit="count",
    projection="tostring(array_length(properties.storageProfile.dataDisks))",
)
BACKUP = entry(
    key="last_backup_status",
    source="recovery_services",
    projectable=False,
    projection=None,
    absent_gap_type=GAP_TYPE_BACKUP_NOT_CONFIGURED,
)
RESERVATION = entry(
    key="reservation_term",
    source="capacity",
    projectable=False,
    projection=None,
    absent_gap_type=GAP_TYPE_NO_RESERVATIONS,
)
ACCESS_TIER = entry(
    resource_type=STORAGE_TYPE,
    key="access_tier",
    projection="tostring(properties.accessTier)",
)


def declaration(*, vm: tuple[FactDeclarationEntry, ...] = (), storage: tuple[FactDeclarationEntry, ...] = ()) -> FactDeclaration:
    types: list[ResourceTypeFacts] = []
    if vm:
        types.append(ResourceTypeFacts(resource_type=VM_TYPE, facts=vm))
    if storage:
        types.append(ResourceTypeFacts(resource_type=STORAGE_TYPE, facts=storage))
    return FactDeclaration(resource_types=tuple(types))


def page(*rows: dict[str, Any]) -> dict[str, Any]:
    return {"totalRecords": len(rows), "count": len(rows), "data": list(rows)}


def row(resource_id: str, *, resource_type: str = VM_TYPE, **facts: Any) -> dict[str, Any]:
    """One Resource Graph row, with its projected columns under the `fact_` prefix."""
    built: dict[str, Any] = {
        "id": resource_id,
        "name": resource_id.rsplit("/", 1)[-1],
        # Lower-cased exactly as the service sends it, which is what makes the
        # case-folded declaration lookup load-bearing rather than decorative.
        "type": resource_type.lower(),
        "location": "southeastasia",
        "resourceGroup": "rg-prod",
        "tags": {},
        "sku": "Standard_D4s_v3",
        "powerState": "PowerState/running",
    }
    built.update({f"fact_{key}": value for key, value in facts.items()})
    return built


def fold(
    body: Any,
    *,
    kind: str = FACT_KIND_INVENTORY,
    source: str = "resource_graph",
    resource_ids: tuple[str, ...] = (WEB_01,),
    declared: FactDeclaration | None = None,
    resource_types: dict[str, str] | None = None,
) -> tuple[tuple[Any, ...], tuple[Any, ...]]:
    return fold_fact_response(
        body,
        kind=kind,
        source=source,
        resource_ids=resource_ids,
        declaration=declared if declared is not None else declaration(vm=(OS_TYPE,)),
        resource_types=resource_types or {WEB_01: VM_TYPE, WEB_02: VM_TYPE},
        received_at=RECEIVED_AT,
    )


def keys_of(facts: tuple[Any, ...]) -> list[str]:
    return [fact["key"] for fact in facts]


def gap_types(gaps: tuple[Any, ...]) -> list[str]:
    return [gap["gap_type"] for gap in gaps]


# --------------------------------------------------------------------------- #
# The happy path, both readers
# --------------------------------------------------------------------------- #


def test_a_projected_column_becomes_a_fact_carrying_its_declared_provenance() -> None:
    """Req 4.2, 4.7, 4.11 — the value comes from the response, and everything else comes
    from the **declaration**.

    Asserted field by field rather than as a shape, because `value_kind`, `source` and `unit`
    are exactly the fields a plausible implementation would derive from the value's characters
    (Req 4.11's own reasoning) and a shape assertion cannot tell the two apart.
    """
    facts, gaps = fold(page(row(WEB_01, os_type="Windows")))

    assert gaps == ()
    assert facts == (
        {
            "resource_id": WEB_01,
            "key": "os_type",
            "value": "Windows",
            "value_kind": FACT_VALUE_KIND_TEXT,
            "source": "resource_graph",
            "collected_at": RECEIVED_AT,
            "unit": None,
        },
    )


def test_a_numeric_fact_carries_its_declared_unit_and_a_decimal_string() -> None:
    """Req 30 — never a JSON number. A snapshot that hashes differently on two machines is
    not immutable, and a JSON number is serialized through `float.__repr__`."""
    facts, gaps = fold(
        page(row(WEB_01, data_disk_count="4")),
        declared=declaration(vm=(DATA_DISKS,)),
    )

    assert gaps == ()
    assert facts[0]["value"] == "4"
    assert isinstance(facts[0]["value"], str)
    assert facts[0]["value_kind"] == FACT_VALUE_KIND_NUMERIC
    assert facts[0]["unit"] == "count"


def test_a_non_projectable_source_answers_through_the_item_reader() -> None:
    """Req 5.4 — the `facts` reader, over the flat per-resource items the port normalizes to.

    The item names its resource and carries the value under the **declared key itself**, with
    no `fact_` prefix: that prefix is Resource Graph's projection artifact and nothing else in
    the product spells it.
    """
    facts, gaps = fold(
        {"value": [{"resource_id": WEB_01, "last_backup_status": "Completed"}]},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(BACKUP,)),
    )

    assert gaps == ()
    assert facts[0]["key"] == "last_backup_status"
    assert facts[0]["value"] == "Completed"
    assert facts[0]["source"] == "recovery_services"


def test_a_bare_list_body_is_read_as_the_item_list() -> None:
    """A port that already unwrapped the envelope should not have to re-wrap it."""
    facts, _gaps = fold(
        [{"id": WEB_01, "last_backup_status": "Completed"}],
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(BACKUP,)),
    )

    assert keys_of(facts) == ["last_backup_status"]


def test_several_resources_fold_in_the_order_they_were_requested() -> None:
    """So two runs over one response emit one order. The snapshot sorts, but a fold whose
    output order came from hash iteration would make a recorded fixture meaningless."""
    facts, gaps = fold(
        page(row(WEB_02, os_type="Linux"), row(WEB_01, os_type="Windows")),
        resource_ids=(WEB_01, WEB_02),
    )

    assert gaps == ()
    assert [fact["resource_id"] for fact in facts] == [WEB_01, WEB_02]


def test_a_repeated_resource_id_is_folded_once() -> None:
    """Otherwise every absence for that resource is recorded twice, and the displayed count
    of absences is not the count of absences."""
    facts, gaps = fold(
        page(row(WEB_01, os_type="Windows")), resource_ids=(WEB_01, WEB_01, WEB_01)
    )

    assert len(facts) == 1
    assert gaps == ()


# --------------------------------------------------------------------------- #
# Req 5.9 — the loop is over the declaration, so an undeclared key is unreachable
# --------------------------------------------------------------------------- #


def test_a_column_the_type_does_not_declare_produces_neither_a_fact_nor_a_gap() -> None:
    """Req 5.9, structurally. The row carries `fact_reservation_term`; the VM's declaration
    in this test does not, so the key is never visited.

    Both halves of "neither" are asserted, because a fold that visited the response would
    produce a fact with no `value_kind` to give it, and one that visited the union of every
    type's declaration would produce a *gap* for a key this type never asks about.
    """
    facts, gaps = fold(
        page(row(WEB_01, os_type="Windows", reservation_term="P1Y")),
        declared=declaration(vm=(OS_TYPE,)),
    )

    assert keys_of(facts) == ["os_type"]
    assert gaps == ()


def test_a_storage_account_cannot_collect_a_reservation_gap() -> None:
    """The requirement's own example, and the one a reader will check.

    `no_reservations` is declared for the VM and not for the storage account, so folding a
    page holding both must record it for the VM alone — not because the storage account's
    response was different, but because the key is not in its declaration to be looked for.
    """
    facts, gaps = fold(
        # The capacity API answered and named no reservation for either resource.
        {"value": []},
        kind=FACT_KIND_FACTS,
        source="capacity",
        resource_ids=(WEB_01, STORE_01),
        declared=declaration(vm=(RESERVATION,), storage=(ACCESS_TIER,)),
        resource_types={WEB_01: VM_TYPE, STORE_01: STORAGE_TYPE},
    )

    assert facts == ()
    assert [(gap["resource_id"], gap["gap_type"]) for gap in gaps] == [
        (WEB_01, GAP_TYPE_NO_RESERVATIONS)
    ]


def test_the_declaration_is_matched_against_the_lower_cased_type_the_service_sends() -> None:
    """Resource Graph lower-cases `type` in its response body. An exact comparison would find
    no declaration for every real row, and the failure would present as a resource type with
    no facts rather than as a spelling mismatch."""
    lowered = row(WEB_01, os_type="Windows")

    assert lowered["type"] == VM_TYPE.lower() != VM_TYPE

    facts, _gaps = fold(page(lowered))
    assert keys_of(facts) == ["os_type"]


def test_a_resource_whose_type_declares_nothing_yields_nothing() -> None:
    facts, gaps = fold(
        page(row(WEB_01, os_type="Windows", resource_type="Microsoft.Nope/things")),
        resource_types={WEB_01: "Microsoft.Nope/things"},
    )

    assert (facts, gaps) == ((), ())


# --------------------------------------------------------------------------- #
# Req 5.1-5.3, 5.8 — the two absences, and never both for one key
# --------------------------------------------------------------------------- #


def test_a_source_that_answered_and_named_nothing_records_the_declared_absence() -> None:
    """Req 5.1-5.3. Not an error: this is what an ordinary subscription looks like."""
    _facts, gaps = fold(
        {"value": [{"resource_id": WEB_01}]},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(BACKUP,)),
    )

    assert gap_types(gaps) == [GAP_TYPE_BACKUP_NOT_CONFIGURED]
    assert gaps[0]["source"] == "recovery_services"
    assert gaps[0]["metric"] == "last_backup_status"


def test_a_resource_the_response_omitted_entirely_records_the_declared_absence() -> None:
    """`resource_ids` is what makes this observable. From the response alone, a resource it
    omits is indistinguishable from a resource nobody asked about."""
    _facts, gaps = fold(
        {"value": []},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        resource_ids=(WEB_01, WEB_02),
        declared=declaration(vm=(BACKUP,)),
    )

    assert [(gap["resource_id"], gap["gap_type"]) for gap in gaps] == [
        (WEB_01, GAP_TYPE_BACKUP_NOT_CONFIGURED),
        (WEB_02, GAP_TYPE_BACKUP_NOT_CONFIGURED),
    ]


@pytest.mark.parametrize("value", ["", "   ", "\t", None])
def test_an_empty_value_is_an_absence_and_records_no_fact(value: object) -> None:
    """Req 5.5 — no `Fact` whose value is the empty string.

    An empty projected column is how Resource Graph spells "this row has no such property",
    and a `coalesce(...)` over two paths that both miss produces exactly that — so this is the
    ordinary absence, not an edge case.
    """
    facts, gaps = fold(
        {"value": [{"resource_id": WEB_01, "last_backup_status": value}]},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(BACKUP,)),
    )

    assert facts == ()
    assert gap_types(gaps) == [GAP_TYPE_BACKUP_NOT_CONFIGURED]


def test_exactly_one_gap_per_absent_resource_and_key_pair() -> None:
    """Req 5.8 — the declared absence **or** `fact_unavailable`, never both.

    Recording both would make the displayed count of absences twice the number of absences,
    which is the specific arithmetic the requirement forbids.
    """
    _facts, gaps = fold(
        {"value": [{"resource_id": WEB_01}]},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(BACKUP,)),
    )

    assert len(gaps) == 1
    assert GAP_TYPE_FACT_UNAVAILABLE not in gap_types(gaps)


def test_a_projectable_key_with_no_value_is_unavailable_not_a_configuration_state() -> None:
    """A projectable fact declares no `absent_gap_type`, and that is the whole reason: a
    column Resource Graph was asked to project and did not resolve is not "not configured",
    it is a column that did not resolve."""
    facts, gaps = fold(page(row(WEB_01)))

    assert facts == ()
    assert gap_types(gaps) == [GAP_TYPE_FACT_UNAVAILABLE]
    assert gaps[0]["source"] == "resource_graph"


def test_one_sources_response_records_no_absence_for_another_sources_keys() -> None:
    """The condition that would otherwise be invisible.

    A Recovery Services answer cannot say anything about a key only the capacity API is
    asked for. Without this, one response would record an absent gap for every other
    source's keys — with `source` correctly populated, so Req 5.10 would still be satisfied
    and the gap would still be wrong.
    """
    _facts, gaps = fold(
        {"value": [{"resource_id": WEB_01, "last_backup_status": "Completed"}]},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(BACKUP, RESERVATION)),
    )

    assert gaps == ()


def test_an_inventory_response_records_no_absence_for_a_non_projectable_key() -> None:
    """A non-projectable key was never in the inventory query, so it cannot be absent from
    its response — the fold must not read "the page did not carry it" as "the source said
    nothing"."""
    facts, gaps = fold(
        page(row(WEB_01, os_type="Windows")),
        declared=declaration(vm=(OS_TYPE, BACKUP, RESERVATION)),
    )

    assert keys_of(facts) == ["os_type"]
    assert gaps == ()


# --------------------------------------------------------------------------- #
# Req 7.7 — every numeric leaf through `decimal_leaf`, and it never raises
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("value", ["not a number", "12.3.4", "NaN", "Infinity", "", "1,024"])
def test_a_numeric_value_that_does_not_parse_is_unavailable_rather_than_raising(
    value: str,
) -> None:
    """Req 7.7 — a malformed body classifies as a gap, never an exception mid-fold.

    `fact_unavailable` and not the declared absence: the source **did** answer, and what it
    said could not be used. That is a fact about the response, not about the estate.
    """
    facts, gaps = fold(
        page(row(WEB_01, data_disk_count=value)),
        declared=declaration(vm=(DATA_DISKS,)),
    )

    assert facts == ()
    assert len(gaps) == 1
    assert gaps[0]["gap_type"] == GAP_TYPE_FACT_UNAVAILABLE
    assert gaps[0]["metric"] == "data_disk_count"


RETENTION = entry(
    key="backup_retention_days",
    value_kind=FACT_VALUE_KIND_NUMERIC,
    unit="days",
    source="recovery_services",
    projectable=False,
    projection=None,
    absent_gap_type=GAP_TYPE_BACKUP_NOT_CONFIGURED,
)
"""A **non-projectable numeric** key — the only shape in which "absent" and "unusable" reach
two *different* gap types, and therefore the only shape that can prove the distinction.

For a projectable key both land on `fact_unavailable` (a projected column declares no
`absent_gap_type`), so a test using one asserts a gap type that is right either way."""


def test_an_unusable_numeric_is_never_reported_as_a_configuration_state() -> None:
    """Req 5.8's distinction, on the one shape where it is visible.

    The source answered `"not a number"` for a retention this resource declares. That is a
    response we cannot use — `fact_unavailable` — and emphatically **not**
    `backup_not_configured`, which would tell a reader their backup is switched off on the
    strength of a value we failed to parse.
    """
    facts, gaps = fold(
        {"value": [{"resource_id": WEB_01, "backup_retention_days": "not a number"}]},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(RETENTION,)),
    )

    assert facts == ()
    assert gap_types(gaps) == [GAP_TYPE_FACT_UNAVAILABLE]
    assert GAP_TYPE_BACKUP_NOT_CONFIGURED not in gap_types(gaps)


def test_the_same_key_absent_rather_than_unusable_is_the_configuration_state() -> None:
    """The other side of the pair, over the identical declaration — so the two tests together
    pin the branch rather than one gap type. The source answered and named nothing, which for
    a non-projectable key *is* a configuration state."""
    facts, gaps = fold(
        {"value": [{"resource_id": WEB_01}]},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(RETENTION,)),
    )

    assert facts == ()
    assert gap_types(gaps) == [GAP_TYPE_BACKUP_NOT_CONFIGURED]


def test_a_usable_numeric_on_a_non_projectable_key_becomes_a_fact() -> None:
    """Guard the guard: the two refusals above would both pass against a fold that never
    accepted a non-projectable numeric at all."""
    facts, gaps = fold(
        {"value": [{"resource_id": WEB_01, "backup_retention_days": "30"}]},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(RETENTION,)),
    )

    assert gaps == ()
    assert facts[0]["value"] == "30"
    assert facts[0]["unit"] == "days"


def test_the_unusable_message_names_the_value_as_unusable_not_as_missing() -> None:
    """For a *projectable* key both outcomes are `fact_unavailable`, so the message is the only
    thing that distinguishes them — and a `collection_log` reader deciding whether to chase a
    permissions problem or a parsing one reads exactly that."""
    _facts, unusable = fold(
        page(row(WEB_01, data_disk_count="not a number")),
        declared=declaration(vm=(DATA_DISKS,)),
    )
    _facts2, missing = fold(page(row(WEB_01)), declared=declaration(vm=(DATA_DISKS,)))

    assert "not a usable number" in unusable[0]["message"]
    assert "carried no value" in missing[0]["message"]
    assert unusable[0]["message"] != missing[0]["message"]


def test_an_empty_numeric_value_is_absent_rather_than_unusable() -> None:
    """The one case in the parametrization above that is **not** unusable, separated out so
    the distinction is on the record: an empty column is an absence, and a projectable key's
    absence is `fact_unavailable` for a different reason. Both land on the same gap type here,
    and the *message* is what differs — so this asserts the message rather than the type."""
    _facts, gaps = fold(
        page(row(WEB_01, data_disk_count="")),
        declared=declaration(vm=(DATA_DISKS,)),
    )

    assert "carried no value" in gaps[0]["message"]


def test_a_numeric_value_in_exponent_notation_is_written_in_plain_notation() -> None:
    """`str(Decimal("1E+2"))` is `"1E+2"`, which the snapshot's anchored numeric grammar
    rejects — so a fold that passed the digits through would build a record the snapshot
    builder refuses, after the collection has already been spent."""
    facts, _gaps = fold(
        page(row(WEB_01, data_disk_count="1E+2")),
        declared=declaration(vm=(DATA_DISKS,)),
    )

    assert facts[0]["value"] == "100"
    assert "E" not in facts[0]["value"]


def test_a_decimal_arriving_as_a_decimal_is_preserved_exactly() -> None:
    """A port backed by the real SDK hands back `Decimal` already. Its digit string must
    survive rather than round-tripping through a float."""
    facts, _gaps = fold(
        page(row(WEB_01, data_disk_count=Decimal("0.1"))),
        declared=declaration(vm=(DATA_DISKS,)),
    )

    assert facts[0]["value"] == "0.1"


def test_a_fractional_numeric_value_keeps_its_digits() -> None:
    """Fractional rather than whole, deliberately: a whole number survives a float round trip
    and a fractional one does not, which is the shape the archive's own `Decimal` defect
    took."""
    facts, _gaps = fold(
        page(row(WEB_01, data_disk_count="12.345")),
        declared=declaration(vm=(DATA_DISKS,)),
    )

    assert facts[0]["value"] == "12.345"


def test_a_boolean_column_is_recorded_rather_than_dropped() -> None:
    """A projection like `tostring(properties.zoneRedundant)` can hand back a JSON boolean if
    the service declines to stringify it, and `True` is a fact worth recording."""
    facts, _gaps = fold(page(row(WEB_01, os_type=True)))

    assert facts[0]["value"] == "true"


# --------------------------------------------------------------------------- #
# The unreadable response
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize("body", [None, "not an object", 17, {}, {"data": "not a list"}])
def test_an_unreadable_inventory_body_is_one_unavailable_gap_per_declared_key(
    body: object,
) -> None:
    """A body that is not the declared shape means the request answered something unusable,
    which is a gap per `(resource, key)` rather than an exception a caller mid-collection has
    to catch."""
    facts, gaps = fold(body, declared=declaration(vm=(OS_TYPE, DATA_DISKS)))

    assert facts == ()
    assert gap_types(gaps) == [GAP_TYPE_FACT_UNAVAILABLE, GAP_TYPE_FACT_UNAVAILABLE]
    assert {gap["metric"] for gap in gaps} == {"os_type", "data_disk_count"}


def test_a_row_with_no_usable_id_names_nothing_to_record_against() -> None:
    facts, gaps = fold(page({"type": VM_TYPE.lower(), "fact_os_type": "Windows"}))

    assert facts == ()
    assert gap_types(gaps) == [GAP_TYPE_FACT_UNAVAILABLE]


def test_an_undeclared_kind_raises_rather_than_folding_the_wrong_reader() -> None:
    with pytest.raises(ValueError, match="not one of the declared fact response kinds"):
        fold(page(row(WEB_01, os_type="Windows")), kind="inventory_page")


# --------------------------------------------------------------------------- #
# Purity, and the gap gate
# --------------------------------------------------------------------------- #


def test_the_fold_reads_no_clock_and_stamps_what_it_was_given() -> None:
    """`received_at` is supplied, exactly as `collect/archive.py` takes it. A fold that read
    the wall clock would put a different instant into the snapshot on every run, and the
    archive's replay could never reproduce it."""
    facts, _gaps = fold(page(row(WEB_01, os_type="Windows")))

    assert facts[0]["collected_at"] == RECEIVED_AT


def test_the_fold_mutates_neither_the_body_nor_the_declaration() -> None:
    body = page(row(WEB_01, os_type="Windows"))
    before = repr(body)
    declared = declaration(vm=(OS_TYPE, DATA_DISKS))

    fold(body, declared=declared)

    assert repr(body) == before
    assert declared == declaration(vm=(OS_TYPE, DATA_DISKS))


def test_two_folds_over_one_response_produce_identical_output() -> None:
    """Determinism, asserted rather than assumed — replay re-runs this fold over the archived
    response and compares a digest taken over its output."""
    body = page(row(WEB_01, os_type="Windows"), row(WEB_02, os_type="Linux"))
    args = {"resource_ids": (WEB_01, WEB_02), "declared": declaration(vm=(OS_TYPE,))}

    assert fold(body, **args) == fold(body, **args)


def test_every_gap_the_fold_records_names_its_source() -> None:
    """Req 5.10, over every gap this module can produce. `record_gap` enforces it for the four
    fact types, so this asserts the fold reaches that gate rather than building a record
    around it."""
    _facts, absent = fold(
        {"value": [{"resource_id": WEB_01}]},
        kind=FACT_KIND_FACTS,
        source="recovery_services",
        declared=declaration(vm=(BACKUP, RESERVATION)),
    )
    _facts2, unavailable = fold(page(row(WEB_01)))

    for gap in (*absent, *unavailable):
        assert gap["gap_type"] in FACT_GAP_TYPES
        assert gap["gap_type"] in DECLARED_GAP_TYPES
        assert isinstance(gap["source"], str) and gap["source"].strip()
        assert gap["interval_start"] is None


def test_the_gap_names_the_key_in_the_metric_field() -> None:
    """So a `collection_log` reader can group by which fact was missing. The field is called
    `metric` because `GapRecord` is one shape for every gap; what it carries here is the fact
    key, and every key the fold names is one some type declares."""
    _facts, gaps = fold(page(row(WEB_01)), declared=declaration(vm=(OS_TYPE, DATA_DISKS)))

    assert {gap["metric"] for gap in gaps} == {"os_type", "data_disk_count"}


# --------------------------------------------------------------------------- #
# `projected_facts_from_row` — the single-row entry point
# --------------------------------------------------------------------------- #


def test_the_row_entry_point_folds_one_row_against_its_own_type() -> None:
    facts, gaps = projected_facts_from_row(
        row(WEB_01, os_type="Windows"),
        declaration=declaration(vm=(OS_TYPE,)),
        received_at=RECEIVED_AT,
    )

    assert gaps == ()
    assert facts[0]["key"] == "os_type"
    assert facts[0]["resource_id"] == WEB_01


def test_the_row_entry_point_records_no_absence_for_a_non_projectable_key() -> None:
    facts, gaps = projected_facts_from_row(
        row(WEB_01, os_type="Windows"),
        declaration=declaration(vm=(OS_TYPE, BACKUP)),
        received_at=RECEIVED_AT,
    )

    assert keys_of(facts) == ["os_type"]
    assert gaps == ()


def test_the_row_entry_point_returns_nothing_for_a_row_with_no_id() -> None:
    assert projected_facts_from_row(
        {"type": VM_TYPE.lower(), "fact_os_type": "Windows"},
        declaration=declaration(vm=(OS_TYPE,)),
        received_at=RECEIVED_AT,
    ) == ((), ())


def test_the_row_entry_point_and_the_page_fold_agree_about_one_row() -> None:
    """One derivation, reached two ways. If they disagreed, a collector folding rows as they
    arrive would build a different snapshot from one folding the page."""
    one = row(WEB_01, os_type="Windows")
    declared = declaration(vm=(OS_TYPE, DATA_DISKS))

    assert projected_facts_from_row(
        one, declaration=declared, received_at=RECEIVED_AT
    ) == fold(page(one), declared=declared)


# --------------------------------------------------------------------------- #
# The shipped declaration, end to end
# --------------------------------------------------------------------------- #


def test_the_shipped_declaration_folds_a_real_projected_row() -> None:
    """Against `catalog/facts.v1.json` rather than a hand-built declaration, so the fold and
    the shipped data are checked against each other and not only against a fixture."""
    shipped = load_catalog().facts
    projected = dict(shipped.projectable(VM_TYPE))

    assert projected, "the shipped declaration projects no VM fact"

    facts, gaps = fold_fact_response(
        page(row(WEB_01, **dict.fromkeys(projected, "Windows"))),
        kind=FACT_KIND_INVENTORY,
        source="resource_graph",
        resource_ids=(WEB_01,),
        declaration=shipped,
        resource_types={WEB_01: VM_TYPE},
        received_at=RECEIVED_AT,
    )

    # Every projectable VM key produced a fact; the numeric ones rejected "Windows" as
    # unusable, which is the honest outcome for a numeric key carrying a word.
    numeric = {
        declared.key
        for declared in shipped.for_resource_type(VM_TYPE)
        if declared.projectable and declared.value_kind == FACT_VALUE_KIND_NUMERIC
    }
    assert set(keys_of(facts)) == set(projected) - numeric
    assert {gap["metric"] for gap in gaps} == numeric
    assert set(gap_types(gaps)) <= {GAP_TYPE_FACT_UNAVAILABLE}


def test_the_inventory_kind_is_spelled_the_way_the_archive_spells_it() -> None:
    """The one string the two modules share, matched by value.

    An archived Resource Graph page and a Resource Graph page being folded are the **same
    response**, so `archive_kind_of(document) == ARCHIVE_KIND_INVENTORY` and
    `kind == FACT_KIND_INVENTORY` have to agree — a replay reads the kind off the archived
    object and hands it straight to this fold.

    The other two do not correspond and must not be asserted equal: `ARCHIVE_KIND_METRICS` is
    a metrics batch response, which this fold never sees, and `FACT_KIND_FACTS` covers the
    non-projectable sources, whose responses are folded before they are archived under their
    own kind. Asserting the whole sets equal would couple two vocabularies that are only
    partly the same thing.
    """
    from reporting_agent.collect.archive import ARCHIVE_KIND_INVENTORY, ARCHIVE_KINDS

    assert FACT_KIND_INVENTORY == ARCHIVE_KIND_INVENTORY
    assert FACT_KIND_INVENTORY in ARCHIVE_KINDS
    assert FACT_KIND_FACTS not in ARCHIVE_KINDS
    assert FACT_KINDS == (FACT_KIND_INVENTORY, FACT_KIND_FACTS)
