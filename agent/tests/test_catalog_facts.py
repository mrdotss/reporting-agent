"""The Fact_Declaration half of the catalog: `facts.v1.json` and what the loader does
with it (Req 1.4, 1.7, 1.8, 4.7, 4.11).

Three groups, and the split matters:

* the **shipped file** — the declaration that actually ships in the image, asserted against
  the vocabularies rather than against a transcription of itself;
* the **loader's refusals** — one malformed entry degrades to an `InvalidEntry` and the run
  continues, while a malformed *file* raises, exactly the asymmetry `test_catalog_loader.py`
  establishes for the metric half;
* the **pairing** — the two files are one document version, so a `catalog_version` in the
  fact half is refused and neither file can be raised without the other.
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any

import pytest

from reporting_agent.catalog.loader import (
    CATALOG_ENTRY_INVALID_GAP_TYPE,
    DECLARED_ABSENT_GAP_TYPES,
    DECLARED_FACT_SOURCES,
    DECLARED_FACT_UNITS,
    DECLARED_FACT_VALUE_KINDS,
    DEFAULT_CATALOG_PATH,
    DEFAULT_FACTS_PATH,
    MAX_FACT_KEY_LENGTH,
    MIN_FACT_KEY_LENGTH,
    FactDeclaration,
    FactDeclarationEntry,
    child_type_names,
    is_child_type,
    load_catalog,
)
from reporting_agent.collect.log import FACT_GAP_TYPES, GAP_TYPE_FACT_UNAVAILABLE
from reporting_agent.compile.format import UNIT_PRESENTATION
from reporting_agent.errors import CatalogUnusableError

VM_TYPE = "Microsoft.Compute/virtualMachines"
DECLARED_TYPE_COUNT = 12
"""7 metric-bearing types, plus four fact-only additions across tasks 6.1-6.3:
`Microsoft.Network/virtualNetworks/subnets` (a child, declares `child_of`),
`Microsoft.Network/virtualNetworks` (first-class, its parent),
`Microsoft.Network/publicIPAddresses` (first-class, no relation to either), and the
task 6.3 pair `Microsoft.Network/networkSecurityGroups/securityRules` (a child,
declares `child_of`) with its own parent `Microsoft.Network/networkSecurityGroups`
(first-class). Every fact-only addition is distinguished from the others by
`child_of` alone, never inferred from either type's presence or absence in
`metrics.v1.json` — see `catalog.loader.is_child_type`'s own docstring for why that
inference was tried once and broke the moment a first-class, metric-less type needed
the identical shape."""


# --------------------------------------------------------------------------- #
# Fixtures for the loader's refusals
# --------------------------------------------------------------------------- #

VALID_FACT: dict[str, Any] = {
    "key": "os_type",
    "value_kind": "text",
    "source": "resource_graph",
    "projectable": True,
    "projection": "tostring(properties.storageProfile.osDisk.osType)",
}

VALID_NON_PROJECTABLE: dict[str, Any] = {
    "key": "last_backup_status",
    "value_kind": "text",
    "source": "recovery_services",
    "projectable": False,
    "absent_gap_type": "backup_not_configured",
}


def write_facts(tmp_path: Path, body: Any, *, name: str = "facts.json") -> Path:
    path = tmp_path / name
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


def facts_file(
    tmp_path: Path,
    facts: list[Any],
    *,
    resource_type: str = VM_TYPE,
    child_of: str | None = None,
) -> Path:
    entry: dict[str, Any] = {"facts": facts}
    if child_of is not None:
        entry["child_of"] = child_of
    return write_facts(tmp_path, {"resource_types": {resource_type: entry}})


def load_with(tmp_path: Path, facts: list[Any]) -> Any:
    """The real metric catalog paired with a fact file this test wrote.

    Both paths are supplied, because supplying one and not the other declares an empty
    fact half — see :func:`load_catalog`'s docstring and the pairing tests below.
    """
    return load_catalog(DEFAULT_CATALOG_PATH, facts_path=facts_file(tmp_path, facts))


# --------------------------------------------------------------------------- #
# The shipped declaration (Req 1.4, 1.7)
# --------------------------------------------------------------------------- #


def test_the_shipped_declaration_loads_with_no_invalid_entry() -> None:
    """Req 1.7. The whole point of a shipped data file: it validates against the schema
    the loader declares, so no run starts with a `catalog_entry_invalid` gap it inherited
    from the image rather than from the subscription."""
    catalog = load_catalog()

    assert catalog.invalid_entries == ()
    assert len(catalog.facts.resource_types) == DECLARED_TYPE_COUNT
    assert catalog.facts.entries, "the shipped declaration declares no fact at all"


def test_every_metric_type_also_appears_in_the_fact_declaration() -> None:
    """Req 1.7, 1.8 — the seven types task 3.2 widened the metric catalog to are the seven
    the fact declaration covers.

    **Task 6.1 and 6.2 both add exceptions on purpose, and for two different reasons.**
    `Microsoft.Network/virtualNetworks/subnets` (task 6.1) is a **child** type: it
    declares `child_of` and no metric is ever requested for it — a sub-record, not a
    deployed thing. `Microsoft.Network/publicIPAddresses` (task 6.2) declares no
    `child_of` at all: it is first-class and counts toward every headline total, and its
    absence from the metric file states only "no platform metric exists for this type,"
    never "this is a sub-record." So the metric-type set is now a strict subset of the
    fact-type set, once **both** the child types and the fact-only-first-class types are
    accounted for separately — asserting the two exclusions by name is what keeps this
    test from silently widening to tolerate a third, unrelated gap.
    """
    catalog = load_catalog()
    metric_types = set(catalog.resource_type_names)
    fact_types = set(catalog.facts.resource_type_names)
    children = set(child_type_names(catalog))
    fact_only_first_class = {
        declared.resource_type
        for declared in catalog.facts.resource_types
        if declared.child_of is None
        and declared.resource_type not in metric_types
    }

    assert fact_types - children - fact_only_first_class == metric_types
    assert children == {
        "Microsoft.Network/virtualNetworks/subnets",
        "Microsoft.Network/networkSecurityGroups/securityRules",
    }
    assert fact_only_first_class == {
        "Microsoft.Network/virtualNetworks",
        "Microsoft.Network/publicIPAddresses",
        "Microsoft.Network/networkSecurityGroups",
    }


def test_every_declared_fact_key_is_lower_snake_case_and_within_the_length_bound() -> None:
    """Req 1.4. A fact key names a snapshot field and a message id, so it is the one shape
    both halves can spell."""
    for entry in load_catalog().facts.entries:
        assert MIN_FACT_KEY_LENGTH <= len(entry.key) <= MAX_FACT_KEY_LENGTH
        assert entry.key == entry.key.lower()
        assert entry.key[0].isalpha()
        assert set(entry.key) <= set("abcdefghijklmnopqrstuvwxyz0123456789_")


def test_no_key_is_declared_twice_within_one_resource_type() -> None:
    """Two entries for one key would make the fold's outcome depend on which it visited
    last. Across *different* types a repeat is ordinary — every type declares `sku_name`."""
    for declared in load_catalog().facts.resource_types:
        keys = [entry.key for entry in declared.facts]
        assert len(keys) == len(set(keys)), declared.resource_type


def test_projectable_and_non_projectable_carry_exactly_one_of_the_two_fields() -> None:
    """Req 4.7, 5.1-5.3 — the mutual exclusion, asserted over the shipped file.

    A projectable fact rides the inventory query and so needs an expression; a
    non-projectable one is asked for separately and so needs the gap to record when its
    source answers and names nothing.
    """
    for entry in load_catalog().facts.entries:
        if entry.projectable:
            assert entry.projection, entry.key
            assert entry.absent_gap_type is None, entry.key
        else:
            assert entry.projection is None, entry.key
            assert entry.absent_gap_type in DECLARED_ABSENT_GAP_TYPES, entry.key


def test_fact_unavailable_is_a_real_gap_type_that_no_fact_may_declare() -> None:
    """Both halves of the exclusion, because either alone is satisfiable by a typo.

    `fact_unavailable` is one of `collect/log.py`'s four fact gap types — so the string is
    live, not a stale name — and it is **not** declarable as an `absent_gap_type`, because
    it means the request *failed*. A fact declaring it would be asserting that failure is a
    configuration state, and the report would then read "not configured" for a resource
    whose fact was simply unreadable.
    """
    assert GAP_TYPE_FACT_UNAVAILABLE in FACT_GAP_TYPES
    assert GAP_TYPE_FACT_UNAVAILABLE not in DECLARED_ABSENT_GAP_TYPES
    assert DECLARED_ABSENT_GAP_TYPES < FACT_GAP_TYPES

    for entry in load_catalog().facts.entries:
        assert entry.absent_gap_type != GAP_TYPE_FACT_UNAVAILABLE


def test_a_numeric_fact_declares_a_unit_and_a_text_fact_declares_none() -> None:
    """Req 4.11 — read from the declaration, never inferred from the characters. There is
    no unit for `Succeeded`."""
    for entry in load_catalog().facts.entries:
        assert entry.value_kind in DECLARED_FACT_VALUE_KINDS
        if entry.value_kind == "numeric":
            assert entry.unit in DECLARED_FACT_UNITS, entry.key
        else:
            assert entry.unit is None, entry.key


def test_every_declared_fact_unit_has_a_presentation_in_the_one_formatting_path() -> None:
    """The link between the two modules, made executable.

    `compile/format.py` is the only place a figure becomes a string (Req 18.6) and it
    *raises* on a unit with no declared presentation. A fact unit the presentation table
    lacks is therefore a run that fails while rendering a fact it collected successfully —
    asserted here, at import time, rather than discovered in the rendering phase.
    """
    presented = {unit for unit, _ in UNIT_PRESENTATION}

    assert DECLARED_FACT_UNITS <= presented
    for entry in load_catalog().facts.entries:
        if entry.unit is not None:
            assert entry.unit in presented, entry.key


def test_a_gibibyte_size_declares_count_rather_than_manufacturing_bytes() -> None:
    """The declared vocabulary has no gibibyte term, and this is the recorded decision.

    Azure reports `diskSizeGB`, `storage.storageSizeGB` and `storageSizeInGB` as integer
    counts of gibibytes. Two options existed and both are wrong in a way worth writing down:

    * multiplying by 1024³ in the projection would declare `bytes` honestly but
      **manufacture nine significant digits out of three** — a `128` becomes
      `137,438,953,472 bytes`, which asserts a measurement resolution Azure never provided;
    * `percent` and `days` are plainly not it.

    So these facts declare `count`, whose presentation is the empty suffix, and the **key**
    carries the unit — a bare `128` under a column the block header names in GiB. The test
    exists so that reading `"unit": "count"` next to a size does not look like an oversight,
    and so a later edit to `bytes` fails here and has to argue with this docstring.
    """
    sized = {
        entry.key: entry
        for entry in load_catalog().facts.entries
        if entry.key.endswith("_gb")
    }

    assert set(sized) == {"disk_size_gb", "storage_size_gb"}
    for entry in sized.values():
        assert entry.value_kind == "numeric"
        assert entry.unit == "count"
        assert "1073741824" not in (entry.projection or ""), (
            "the projection converts gibibytes to bytes, which invents precision "
            "Azure did not report"
        )


def test_arm_is_declared_as_a_source_and_deliberately_not_yet_used() -> None:
    """Req 4.2 declares four sources; the shipped file needs three of them.

    The hole is the mechanism, the same way `azure/definitions.py`'s `UNMAPPED_UNITS` is:
    `arm` is the per-resource control-plane read, and every fact the seven types need today
    is either projectable through Resource Graph or answered by Recovery Services or the
    capacity API. Declaring `arm` without using it keeps the vocabulary Req 4.2 fixed rather
    than one narrowed to today's needs — and asserting the absence means the day a fact
    starts using it, this test fails and the claim gets re-read instead of silently
    outliving its reason.
    """
    used = {entry.source for entry in load_catalog().facts.entries}

    assert used <= DECLARED_FACT_SOURCES
    assert used == DECLARED_FACT_SOURCES - {"arm"}


def test_collected_sources_is_declared_minus_arm_and_matches_the_used_set() -> None:
    """`collected_sources` is Req 15.9/16.1-16.3's offerability input, and it must equal
    the `used` set the test above computes by hand — the property is the same fact
    formalized, not a second, independently-derived answer that could drift from it.

    Asserted as its own claim rather than folded into the test above: `collected_sources`
    is what a section-offerability check imports, so a change to `FactDeclaration` that
    left the property returning something other than "sources at least one entry names"
    should fail here even if `used` (a plain set comprehension re-derived at the test) kept
    passing for an unrelated reason."""
    facts = load_catalog().facts

    assert facts.collected_sources == DECLARED_FACT_SOURCES - {"arm"}
    assert facts.collected_sources == {entry.source for entry in facts.entries}
    assert "arm" not in facts.collected_sources
    assert "advisor" in facts.collected_sources


# --------------------------------------------------------------------------- #
# FactDeclaration's accessors
# --------------------------------------------------------------------------- #


def test_for_resource_type_matches_the_casing_resource_graph_actually_returns() -> None:
    """Req 1.7. Resource Graph lowercases `type` in its response body, so an inventory row
    arrives as `microsoft.compute/virtualmachines`. An exact comparison would find no fact
    for every real row, and the failure would present as a type with no facts."""
    declaration = load_catalog().facts

    assert declaration.for_resource_type(VM_TYPE)
    assert declaration.for_resource_type(VM_TYPE.lower()) == declaration.for_resource_type(
        VM_TYPE
    )
    assert declaration.for_resource_type(VM_TYPE.upper()) == declaration.for_resource_type(
        VM_TYPE
    )
    assert declaration.for_resource_type("Microsoft.Nope/things") == ()


def test_projectable_is_ordered_by_key_and_deduplicated_across_types() -> None:
    """Req 4.7 — what makes two runs over one declaration build a byte-identical query.

    De-duplication is load-bearing rather than tidy: five of the seven types declare
    `sku_name` with the identical projection, and a query naming one column twice is a query
    Resource Graph rejects.
    """
    declaration = load_catalog().facts
    pairs = declaration.projectable()
    keys = [key for key, _ in pairs]

    assert keys == sorted(keys)
    assert len(keys) == len(set(keys))
    # The dedup is real, not vacuous: there genuinely are repeated declarations behind it.
    projectable_entries = [
        entry for entry in declaration.entries if entry.projectable
    ]
    assert len(projectable_entries) > len(pairs)
    assert sum(1 for entry in projectable_entries if entry.key == "sku_name") > 1


def test_one_key_is_one_column_across_every_type_in_the_shipped_file() -> None:
    """Req 4.7, and the constraint that made four projections into `coalesce` expressions.

    A projectable fact's column name comes from its **key alone** — `azure/clients.py` emits
    `fact_<key> = <projection>` into a *single* query serving the whole scope — so two types
    declaring one key with two different expressions would name `fact_<key>` twice and
    Resource Graph would reject the whole query. Not that key's facts: **every** fact for the
    run, including the metrics-side query's own columns.

    Asserted as one projection per key across the file, which is the property the query
    builder actually needs; the de-duplication test above only shows the pairs collapse.
    """
    by_key: dict[str, set[str]] = {}
    for entry in load_catalog().facts.entries:
        if entry.projectable and entry.projection:
            by_key.setdefault(entry.key, set()).add(entry.projection)

    disagreeing = {key: paths for key, paths in by_key.items() if len(paths) > 1}
    assert disagreeing == {}

    # And the case is live: four keys are declared by more than one type, reconciled with
    # one `coalesce` each rather than by giving each type its own key.
    shared = {
        key
        for key in by_key
        if sum(
            1
            for entry in load_catalog().facts.entries
            if entry.key == key and entry.projectable
        )
        > 1
    }
    assert {"os_type", "sku_name", "https_only", "storage_size_gb"} <= shared
    for key in ("os_type", "sku_name", "https_only", "storage_size_gb"):
        assert next(iter(by_key[key])).startswith("coalesce(")


def test_a_second_type_projecting_one_key_differently_is_refused(tmp_path: Path) -> None:
    """The cross-type rule, made executable. The *second* declaration is the invalid one, so
    the first type's fact survives and only the conflicting entry is dropped."""
    path = write_facts(
        tmp_path,
        {
            "resource_types": {
                VM_TYPE: {"facts": [VALID_FACT]},
                "Microsoft.Compute/disks": {
                    "facts": [bad(projection="tostring(properties.osType)")]
                },
            }
        },
    )

    catalog = load_catalog(DEFAULT_CATALOG_PATH, facts_path=path)

    assert [entry.key for entry in catalog.facts.for_resource_type(VM_TYPE)] == [
        VALID_FACT["key"]
    ]
    assert catalog.facts.for_resource_type("Microsoft.Compute/disks") == ()
    assert len(catalog.invalid_entries) == 1
    assert catalog.invalid_entries[0].resource_type == "Microsoft.Compute/disks"
    assert "already projected" in catalog.invalid_entries[0].message
    # The surviving declaration still yields one column for the key.
    assert catalog.facts.projectable() == ((VALID_FACT["key"], VALID_FACT["projection"]),)


def test_projectable_narrowed_to_one_type_is_a_subset_of_the_union() -> None:
    declaration = load_catalog().facts

    narrowed = declaration.projectable(VM_TYPE)

    assert narrowed
    assert set(narrowed) < set(declaration.projectable())
    assert [key for key, _ in narrowed] == sorted(key for key, _ in narrowed)


def test_by_source_returns_every_fact_that_source_answers_for() -> None:
    """What the fact collector iterates: one request per non-projectable source covering
    every fact that source answers for, rather than one request per fact."""
    declaration = load_catalog().facts

    recovery = declaration.by_source("recovery_services")

    assert recovery
    assert {entry.source for entry in recovery} == {"recovery_services"}
    assert all(not entry.projectable for entry in recovery)
    # Partition: every entry belongs to exactly one source's list.
    counted = sum(
        len(declaration.by_source(source)) for source in sorted(DECLARED_FACT_SOURCES)
    )
    assert counted == len(declaration.entries)


def test_keys_spans_every_type_so_a_guard_can_check_a_gap_names_a_declared_key() -> None:
    declaration = load_catalog().facts

    assert declaration.keys == {entry.key for entry in declaration.entries}
    assert "os_type" in declaration.keys
    assert "reservation_term" in declaration.keys


# --------------------------------------------------------------------------- #
# Immutability (Req 32.8)
# --------------------------------------------------------------------------- #


def test_the_fact_declaration_is_frozen_all_the_way_down() -> None:
    """The same guarantee `LoadedCatalog` gives, and the reason the declaration groups by a
    tuple of frozen pairs rather than by a dict: a mapping field on a frozen dataclass is
    still mutable *through the mapping*, so `by_resource_type["x"] = ()` would have been a
    reachable write inside an object this module promises is frozen."""
    catalog = load_catalog()
    declaration = catalog.facts

    with pytest.raises(dataclasses.FrozenInstanceError):
        catalog.facts = FactDeclaration()  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        declaration.resource_types = ()  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        declaration.resource_types[0].facts = ()  # type: ignore[misc]
    with pytest.raises(dataclasses.FrozenInstanceError):
        declaration.entries[0].key = "renamed"  # type: ignore[misc]
    with pytest.raises(TypeError):
        declaration.resource_types[0] = declaration.resource_types[0]  # type: ignore[index]


# --------------------------------------------------------------------------- #
# The pairing: two files, one document version (Req 1.7)
# --------------------------------------------------------------------------- #


def test_a_catalog_version_inside_the_fact_file_is_refused(tmp_path: Path) -> None:
    """Declaring one is itself the failure, so the two files cannot be raised apart.

    A second version string would be invisible when it disagreed: the snapshot records one
    `catalog_version`, and both halves would claim to be it.
    """
    path = write_facts(
        tmp_path,
        {
            "catalog_version": "1.0.0",
            "resource_types": {VM_TYPE: {"facts": [VALID_FACT]}},
        },
    )

    with pytest.raises(CatalogUnusableError, match="catalog_version"):
        load_catalog(DEFAULT_CATALOG_PATH, facts_path=path)


def test_a_catalog_version_is_refused_even_when_it_agrees_with_the_metric_half(
    tmp_path: Path,
) -> None:
    """The *key* is refused, not a mismatch between two values.

    Refusing only a disagreement would leave the file free to declare an agreeing version
    today and drift tomorrow, which is the failure this rule exists to make impossible.
    """
    agreeing = load_catalog().catalog_version
    path = write_facts(
        tmp_path,
        {
            "catalog_version": agreeing,
            "resource_types": {VM_TYPE: {"facts": [VALID_FACT]}},
        },
    )

    with pytest.raises(CatalogUnusableError, match="catalog_version"):
        load_catalog(DEFAULT_CATALOG_PATH, facts_path=path)


def test_the_shipped_fact_file_declares_no_version_of_its_own() -> None:
    """The shipped file obeying its own rule, read as data rather than through the loader —
    so this still fails if the refusal above were removed."""
    body = json.loads(DEFAULT_FACTS_PATH.read_text(encoding="utf-8"))

    assert "catalog_version" not in body
    assert set(body) == {"resource_types"}


def test_a_metric_path_with_no_fact_path_declares_no_facts() -> None:
    """The two paths default together and only together.

    Completing a caller's half-document with the image's other half would produce a
    `LoadedCatalog` whose halves came from two documents and whose `catalog_version`
    describes only one of them.
    """
    paired = load_catalog()
    unpaired = load_catalog(DEFAULT_CATALOG_PATH)

    assert paired.facts.resource_types
    assert unpaired.facts == FactDeclaration()
    assert unpaired.facts.entries == ()
    assert unpaired.facts.projectable() == ()


def test_the_no_argument_call_loads_the_shipped_pair() -> None:
    explicit = load_catalog(DEFAULT_CATALOG_PATH, facts_path=DEFAULT_FACTS_PATH)

    assert load_catalog().facts == explicit.facts


@pytest.mark.parametrize(
    ("body", "why"),
    [
        ("not json at all", "invalid JSON"),
        ("[]", "a JSON array at the top level"),
        ('{"resource_types": []}', "`resource_types` that is not an object"),
        ('{"resource_types": null}', "no `resource_types` at all"),
    ],
)
def test_a_malformed_fact_file_raises_rather_than_degrading(
    tmp_path: Path, body: str, why: str
) -> None:
    """A fact half that cannot be read *at all* is not a run collecting fewer facts — it is
    a run rendering every fact-bearing block empty with no gap saying why."""
    path = tmp_path / "facts.json"
    path.write_text(body, encoding="utf-8")

    with pytest.raises(CatalogUnusableError):
        load_catalog(DEFAULT_CATALOG_PATH, facts_path=path)


def test_a_fact_file_that_does_not_exist_raises(tmp_path: Path) -> None:
    with pytest.raises(CatalogUnusableError, match="could not be read"):
        load_catalog(DEFAULT_CATALOG_PATH, facts_path=tmp_path / "absent.json")


def test_an_empty_resource_types_object_is_readable_and_declares_nothing(
    tmp_path: Path,
) -> None:
    """Distinct from the metric half, which refuses an empty `resource_types`: a run with no
    declared facts and a usable metric catalog is a report without fact blocks, which is a
    narrower product than intended but not an unusable one."""
    path = write_facts(tmp_path, {"resource_types": {}})

    catalog = load_catalog(DEFAULT_CATALOG_PATH, facts_path=path)

    assert catalog.facts.entries == ()
    assert catalog.entries


# --------------------------------------------------------------------------- #
# Per-entry validation degrades (Req 32.4, 32.5)
# --------------------------------------------------------------------------- #


def bad(**overrides: Any) -> dict[str, Any]:
    """`VALID_FACT` with fields replaced; a value of `...` removes the field."""
    entry = dict(VALID_FACT)
    for field, value in overrides.items():
        if value is ...:
            entry.pop(field, None)
        else:
            entry[field] = value
    return entry


@pytest.mark.parametrize(
    ("entry", "why"),
    [
        (bad(key=...), "no key"),
        (bad(key=""), "an empty key"),
        (bad(key="Os_Type"), "an upper-case key"),
        (bad(key="os-type"), "a hyphen in the key"),
        (bad(key="9lives"), "a key starting with a digit"),
        (bad(key="_leading"), "a key starting with an underscore"),
        (bad(key="os type"), "a space in the key"),
        (bad(key="x" * (MAX_FACT_KEY_LENGTH + 1)), "a key past the length bound"),
        (bad(key=17), "a key that is not a string"),
        (bad(value_kind=...), "no value_kind"),
        (bad(value_kind="decimal"), "an undeclared value_kind"),
        (bad(source=...), "no source"),
        (bad(source="guesswork"), "an undeclared source"),
        (bad(projectable=...), "no projectable flag"),
        (bad(projectable="yes"), "a projectable flag that is not a boolean"),
        (bad(projection=...), "a projectable fact with no projection"),
        (bad(projection=""), "a projectable fact with an empty projection"),
        (bad(absent_gap_type="backup_not_configured"), "a projectable fact naming a gap"),
        (
            bad(projectable=False, projection="tostring(x)", absent_gap_type=...),
            "a non-projectable fact carrying a projection",
        ),
        (
            bad(projectable=False, projection=..., absent_gap_type=...),
            "a non-projectable fact naming no gap",
        ),
        (
            bad(projectable=False, projection=..., absent_gap_type="fact_unavailable"),
            "a non-projectable fact naming `fact_unavailable`",
        ),
        (
            bad(projectable=False, projection=..., absent_gap_type="deallocated"),
            "a non-projectable fact naming a gap type outside the declared three",
        ),
        (bad(value_kind="numeric", unit=...), "a numeric fact with no unit"),
        (bad(value_kind="numeric", unit="count_per_second"), "a metric unit on a fact"),
        (bad(unit="bytes"), "a unit on a text fact"),
        ("not an object", "an entry that is not an object"),
        (17, "an entry that is a number"),
    ],
)
def test_one_malformed_fact_entry_degrades_to_one_invalid_entry(
    tmp_path: Path, entry: Any, why: str
) -> None:
    """Req 32.4, 32.5 — the entry costs itself, not the run, and it is recorded as a
    `catalog_entry_invalid` gap the app can surface."""
    catalog = load_with(tmp_path, [entry, VALID_NON_PROJECTABLE])

    assert catalog.facts.for_resource_type(VM_TYPE) == (
        FactDeclarationEntry(
            resource_type=VM_TYPE,
            key=VALID_NON_PROJECTABLE["key"],
            value_kind="text",
            source="recovery_services",
            projectable=False,
            absent_gap_type="backup_not_configured",
        ),
    ), why
    recorded = [
        item for item in catalog.invalid_entries if item.resource_type == VM_TYPE
    ]
    assert len(recorded) == 1, why
    assert recorded[0].gap_type == CATALOG_ENTRY_INVALID_GAP_TYPE
    assert recorded[0].message


def test_the_well_formed_entry_is_accepted_so_the_rejections_above_mean_something(
    tmp_path: Path,
) -> None:
    """Guard the guard. Every case above would also pass against a loader that rejected
    every fact, so the unmodified entry has to load."""
    catalog = load_with(tmp_path, [VALID_FACT, VALID_NON_PROJECTABLE])

    assert catalog.invalid_entries == ()
    assert [entry.key for entry in catalog.facts.for_resource_type(VM_TYPE)] == [
        VALID_FACT["key"],
        VALID_NON_PROJECTABLE["key"],
    ]


def test_a_repeated_key_within_one_type_rejects_the_second_and_keeps_the_first(
    tmp_path: Path,
) -> None:
    """Req 1.4. Which of the two survives is the declaration order, so the outcome does not
    depend on a dict's iteration."""
    catalog = load_with(
        tmp_path, [VALID_FACT, bad(projection="tostring(properties.somethingElse)")]
    )

    kept = catalog.facts.for_resource_type(VM_TYPE)
    assert [entry.key for entry in kept] == [VALID_FACT["key"]]
    assert kept[0].projection == VALID_FACT["projection"]
    assert len(catalog.invalid_entries) == 1
    assert "repeated" in catalog.invalid_entries[0].message


def test_the_same_key_in_two_different_types_is_ordinary(tmp_path: Path) -> None:
    """Six of the seven shipped types declare `sku_name`; a repeat across types with the
    **identical** projection is the normal case and must not be mistaken for either the
    within-type repeat above or the differing-projection conflict below."""
    path = write_facts(
        tmp_path,
        {
            "resource_types": {
                VM_TYPE: {"facts": [VALID_FACT]},
                "Microsoft.Compute/disks": {"facts": [dict(VALID_FACT)]},
            }
        },
    )

    catalog = load_catalog(DEFAULT_CATALOG_PATH, facts_path=path)

    assert catalog.invalid_entries == ()
    assert catalog.facts.keys == {VALID_FACT["key"]}
    assert len(catalog.facts.entries) == 2
    # Two declarations, one column.
    assert catalog.facts.projectable() == ((VALID_FACT["key"], VALID_FACT["projection"]),)


def test_a_resource_type_whose_body_is_not_an_object_costs_only_that_type(
    tmp_path: Path,
) -> None:
    path = write_facts(
        tmp_path,
        {
            "resource_types": {
                VM_TYPE: {"facts": [VALID_FACT]},
                "Microsoft.Compute/disks": ["not", "an", "object"],
            }
        },
    )

    catalog = load_catalog(DEFAULT_CATALOG_PATH, facts_path=path)

    assert catalog.facts.for_resource_type(VM_TYPE)
    assert catalog.facts.for_resource_type("Microsoft.Compute/disks") == ()
    assert [item.resource_type for item in catalog.invalid_entries] == [
        "Microsoft.Compute/disks"
    ]


def test_a_facts_field_that_is_not_a_list_costs_only_that_type(tmp_path: Path) -> None:
    path = write_facts(tmp_path, {"resource_types": {VM_TYPE: {"facts": {}}}})

    catalog = load_catalog(DEFAULT_CATALOG_PATH, facts_path=path)

    assert catalog.facts.for_resource_type(VM_TYPE) == ()
    assert len(catalog.invalid_entries) == 1
    assert "must be a JSON array" in catalog.invalid_entries[0].message


def test_a_type_declaring_no_facts_key_is_not_an_error(tmp_path: Path) -> None:
    """A resource type with metrics and no facts is an ordinary declaration."""
    path = write_facts(tmp_path, {"resource_types": {VM_TYPE: {}}})

    catalog = load_catalog(DEFAULT_CATALOG_PATH, facts_path=path)

    assert catalog.invalid_entries == ()
    assert catalog.facts.for_resource_type(VM_TYPE) == ()


def test_an_invalid_entry_names_the_key_it_could_read(tmp_path: Path) -> None:
    """So the `catalog_entry_invalid` gap says *which* fact was dropped. `None` only when
    the key itself was unreadable — never the empty string that failed validation."""
    catalog = load_with(tmp_path, [bad(source="guesswork"), bad(key="")])

    by_key = {item.metric: item for item in catalog.invalid_entries}
    assert set(by_key) == {VALID_FACT["key"], None}
    assert "guesswork" in by_key[VALID_FACT["key"]].message


def test_one_entry_collects_every_reason_it_failed(tmp_path: Path) -> None:
    """A fact that is wrong three ways should not have to be fixed three times."""
    catalog = load_with(
        tmp_path, [bad(value_kind="decimal", source="guesswork", key="Bad-Key")]
    )

    assert len(catalog.invalid_entries) == 1
    message = catalog.invalid_entries[0].message
    assert "decimal" in message
    assert "guesswork" in message
    assert "Bad-Key" in message


# --------------------------------------------------------------------------- #
# The widened whole-catalog gate (Req 1.7, 32.7)
# --------------------------------------------------------------------------- #

ONE_INVALID_METRIC: dict[str, Any] = {
    "catalog_version": "1.0.0",
    "resource_types": {VM_TYPE: {"metrics": [{"name": "Broken"}]}},
}


def write_metrics(tmp_path: Path, body: Any) -> Path:
    path = tmp_path / "metrics.json"
    path.write_text(json.dumps(body), encoding="utf-8")
    return path


def test_a_catalog_with_no_valid_metric_but_a_valid_fact_is_usable(
    tmp_path: Path,
) -> None:
    """Req 32.7 widened by one term. A type declaring no metric this run can collect but a
    fact it can project still contributes a section to the document, so counting only the
    three metric-shaped kinds would refuse a fact-only declaration as unusable."""
    catalog = load_catalog(
        write_metrics(tmp_path, ONE_INVALID_METRIC),
        facts_path=facts_file(tmp_path, [VALID_FACT]),
    )

    assert catalog.entries == ()
    assert catalog.facts.entries
    assert len(catalog.invalid_entries) == 1


def test_no_valid_entry_of_any_of_the_four_kinds_is_catalog_unusable(
    tmp_path: Path,
) -> None:
    """The same pair with the fact half also invalid — and the gate fires. Together with the
    test above, this is what pins the gate to the *fact* term rather than to any non-empty
    fact file."""
    with pytest.raises(CatalogUnusableError, match="fact"):
        load_catalog(
            write_metrics(tmp_path, ONE_INVALID_METRIC),
            facts_path=facts_file(tmp_path, [bad(source="guesswork")]),
        )


def test_no_valid_metric_and_an_empty_fact_declaration_is_catalog_unusable(
    tmp_path: Path,
) -> None:
    """The pre-existing behaviour, unchanged: an unpaired metric catalog with nothing valid
    in it still raises, so widening the gate did not weaken it."""
    with pytest.raises(CatalogUnusableError):
        load_catalog(write_metrics(tmp_path, ONE_INVALID_METRIC))


# --------------------------------------------------------------------------- #
# is_child_type / child_type_names — the fact-only resource types (task 1.2)
# --------------------------------------------------------------------------- #

CHILD_TYPE = "Microsoft.Network/virtualNetworks/subnets"
CHILD_PARENT = "Microsoft.Network/virtualNetworks"
"""`CHILD_PARENT` must be a real metric-catalog type for `_child_catalog`'s `child_of`
validation to resolve — `Microsoft.Network/virtualNetworks` is not one in the shipped
metric catalog, so these fixtures declare it in the fact file alongside the child, the
same two-entries-in-one-file shape task 6.1's own real catalogue edit uses."""


def _child_catalog(tmp_path: Path) -> Any:
    """The real metric catalog paired with a fact file declaring a child type AND its
    parent — the exact shape a real child-type declaration has, `child_of` included."""
    facts_path = tmp_path / "child.json"
    facts_path.write_text(
        json.dumps(
            {
                "resource_types": {
                    CHILD_TYPE: {"child_of": CHILD_PARENT, "facts": [VALID_FACT]},
                    CHILD_PARENT: {"facts": [VALID_FACT]},
                }
            }
        ),
        encoding="utf-8",
    )
    return load_catalog(DEFAULT_CATALOG_PATH, facts_path=facts_path)


def test_a_type_declaring_child_of_is_a_child_type(tmp_path: Path) -> None:
    """Task 6.2's correction: the test is `child_of`, not "declared by facts and not by
    metrics" — that inference broke the instant a first-class, metric-less type
    (`Microsoft.Network/publicIPAddresses`, task 6.2) needed the identical shape for an
    unrelated, legitimate reason."""
    assert is_child_type(CHILD_TYPE, catalog=_child_catalog(tmp_path)) is True


def test_a_type_declared_by_both_halves_is_not_a_child_type(tmp_path: Path) -> None:
    """A virtual machine has facts *and* metrics, and declares no `child_of`. It is a
    deployed thing, it counts toward every headline total, and an unrequested metric
    for it is a real gap."""
    catalog = load_catalog(
        DEFAULT_CATALOG_PATH, facts_path=facts_file(tmp_path, [VALID_FACT], resource_type=VM_TYPE)
    )

    assert is_child_type(VM_TYPE, catalog=catalog) is False


def test_a_fact_only_type_with_no_child_of_is_not_a_child_type(tmp_path: Path) -> None:
    """The exact case task 6.2 found: a type declared in `facts.v1.json` alone, with
    genuinely no platform metric, but no `child_of` either — first-class, not a
    sub-record. `Microsoft.Network/publicIPAddresses` is this case in the real,
    shipped catalogue; this fixture is the same shape without depending on it."""
    catalog = load_catalog(
        DEFAULT_CATALOG_PATH,
        facts_path=facts_file(tmp_path, [VALID_FACT], resource_type="Microsoft.Network/publicIPAddresses"),
    )

    assert is_child_type("Microsoft.Network/publicIPAddresses", catalog=catalog) is False


def test_a_type_declared_by_neither_half_is_not_a_child_type(tmp_path: Path) -> None:
    """An unsupported type — Cognitive Services, a network watcher — is absent from the
    catalogs entirely. It is not a sub-record of anything, and it must keep recording the
    gap that says nobody selected a metric for it."""
    assert is_child_type("Microsoft.CognitiveServices/accounts", catalog=_child_catalog(tmp_path)) is False


def test_the_child_type_test_folds_case(tmp_path: Path) -> None:
    """Resource Graph lower-cases `type` in its response body, so an inventory row arrives
    as `microsoft.network/virtualnetworks/subnets`. An exact comparison would answer
    `False` for every real row and every sub-record would be counted as a deployed
    resource — the defect, arrived at through a spelling mismatch."""
    catalog = _child_catalog(tmp_path)

    assert is_child_type(CHILD_TYPE.casefold(), catalog=catalog) is True
    assert is_child_type(CHILD_TYPE.upper(), catalog=catalog) is True


@pytest.mark.parametrize("value", ["", "   ", None, 42, [], {}])
def test_a_non_type_is_not_a_child_type(value: object, tmp_path: Path) -> None:
    """Total over its input rather than raising: this is called per inventory row, and a
    malformed row must not end a run."""
    assert is_child_type(value, catalog=_child_catalog(tmp_path)) is False  # type: ignore[arg-type]


def test_a_type_whose_metric_entries_are_all_invalid_is_still_not_a_child_type(
    tmp_path: Path,
) -> None:
    """The distinction that protects a real resource from being demoted to a sub-record.

    A metric catalog entry that fails validation is a **catalog bug** — it degrades to an
    `InvalidEntry` and a `catalog_entry_invalid` gap. `child_of` is a declared fact about
    the *fact*-catalogue entry, not a derivation from whether the metric side happened to
    validate, so a metric-catalog bug can never turn this type into a child type — it was
    never eligible to be one in the first place, because it declares no `child_of`.
    """
    metrics_path = write_metrics(tmp_path, ONE_INVALID_METRIC)
    catalog = load_catalog(
        metrics_path, facts_path=facts_file(tmp_path, [VALID_FACT], resource_type=VM_TYPE)
    )
    broken = catalog.for_resource_type(VM_TYPE)

    assert broken is not None and not broken.has_valid_entries, (
        "this test is only meaningful while the type's metric entries are all invalid"
    )
    assert is_child_type(VM_TYPE, catalog=catalog) is False


def test_child_of_naming_an_undeclared_parent_is_invalid(tmp_path: Path) -> None:
    """`child_of` names a real fact, not a free-text label: a typo'd parent would make a
    subnet's parent silently absent from every place that reads it, so it is checked
    against the pair's own declarations rather than accepted as any string."""
    facts_path = facts_file(
        tmp_path, [VALID_FACT], resource_type=CHILD_TYPE, child_of="Microsoft.Typo/doesNotExist"
    )
    catalog = load_catalog(DEFAULT_CATALOG_PATH, facts_path=facts_path)

    messages = [entry.message for entry in catalog.invalid_entries]
    assert any("child_of" in message and "Microsoft.Typo/doesNotExist" in message for message in messages)
    # And the type is folded out of the fact declaration for the run to still use it —
    # it is invalid, not absent, so it degrades rather than silently vanishing... except
    # `child_of` failing validation does not remove the type's own facts; only the
    # relationship claim is rejected. Confirmed here rather than assumed:
    assert catalog.facts.for_resource_type(CHILD_TYPE), (
        "an invalid child_of degrades that one claim, not the whole entry's facts"
    )


def test_child_of_naming_a_real_type_from_either_half_is_valid(tmp_path: Path) -> None:
    """The parent may be declared by the metric catalogue (the ordinary case — a VNet, an
    NSG) or by the fact catalogue itself (a chain of sub-records, not used today but not
    structurally forbidden either)."""
    catalog = _child_catalog(tmp_path)
    assert not any("child_of" in entry.message for entry in catalog.invalid_entries)


def test_child_type_names_lists_every_child_type_and_nothing_else(tmp_path: Path) -> None:
    """The list form the scan's count filter is built from, so that filter is derived from
    the catalogs rather than hand-maintained."""
    facts_path = tmp_path / "two.json"
    facts_path.write_text(
        json.dumps(
            {
                "resource_types": {
                    CHILD_TYPE: {"child_of": CHILD_PARENT, "facts": [VALID_FACT]},
                    CHILD_PARENT: {"facts": [VALID_FACT]},
                    VM_TYPE: {"facts": [VALID_FACT]},
                }
            }
        ),
        encoding="utf-8",
    )
    catalog = load_catalog(DEFAULT_CATALOG_PATH, facts_path=facts_path)

    assert child_type_names(catalog) == (CHILD_TYPE,), (
        "the virtual machine type is declared by both halves and is not a child type"
    )


def test_the_shipped_catalogs_declare_no_child_type_yet() -> None:
    """Task 6.1 was that deliberate edit. Task 6.3 is the second: the shipped pair now
    declares exactly two child types, `Microsoft.Network/virtualNetworks/subnets`
    (task 6.1) and `Microsoft.Network/networkSecurityGroups/securityRules` (task 6.3).
    This test's job is to move forward with every task that deliberately grows this
    set, rather than staying pinned to whatever the set happened to be when a prior
    task landed — a third child type appearing in a later task's catalogue edit still
    turns this assertion red until it is updated too.
    """
    assert child_type_names(load_catalog()) == (
        "Microsoft.Network/virtualNetworks/subnets",
        "Microsoft.Network/networkSecurityGroups/securityRules",
    )
