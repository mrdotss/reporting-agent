"""Task 6.2 — public IP addresses: address, allocation method, SKU, association.

The mechanical case task 6.1's depth check predicted: `Microsoft.Network/
publicIPAddresses` is a first-class Resource Graph resource (no `mv-expand`, no
child-type collision), so its facts ride the existing `inventory_query` projection
union exactly like every other first-class type's facts already do — no new query,
no new port method, no provider wiring.

**A real design defect this task's own implementation surfaced, and its real
fix.** Declaring a fact-only type used to be indistinguishable from declaring a
child type — both looked like "present in `facts.v1.json`, absent from
`metrics.v1.json`" to `is_child_type`'s old inference, because every child type
declared before this one also happened to have no metric. `publicIPAddresses` broke
that coincidence: it has facts and genuinely no platform metric, but it is a
first-class resource that counts toward every headline total, not a sub-record.

The fix — recorded in `catalog.loader.is_child_type`'s own corrected docstring — is
`child_of`: a declared field on a fact-catalogue entry naming its parent resource
type, or absent for a first-class type. `publicIPAddresses` declares no `child_of`,
so it is first-class with no metrics.v1.json entry at all and no fabricated
evidence fixture — Req 2.1/2.2's verified-evidence invariant, which requires a real
Azure-observed fixture for every metrics.v1.json entry, is untouched by this task.
`Microsoft.Network/virtualNetworks/subnets` (task 6.1) declares
`child_of: "Microsoft.Network/virtualNetworks"` and is correctly excluded.
"""

from __future__ import annotations

from reporting_agent.catalog.loader import child_type_names, is_child_type, load_catalog

PUBLIC_IP_TYPE = "Microsoft.Network/publicIPAddresses"


def test_public_ip_addresses_is_not_a_child_type() -> None:
    """It declares no `child_of` — first-class, not a sub-record."""
    catalog = load_catalog()
    assert not is_child_type(PUBLIC_IP_TYPE, catalog=catalog)
    assert PUBLIC_IP_TYPE not in child_type_names(catalog)


def test_public_ip_addresses_has_no_metrics_v1_entry_and_no_child_of() -> None:
    """First-class with no platform metric is declared as `facts.v1.json` alone, no
    `child_of`, and deliberately NO `metrics.v1.json` entry — a fabricated empty-metrics
    entry there would have required a real Azure-observed evidence fixture it has none
    of (Req 2.1/2.2), which is exactly the invariant this design keeps intact."""
    catalog = load_catalog()
    assert PUBLIC_IP_TYPE not in catalog.resource_type_names
    declared = catalog.facts.for_resource_type(PUBLIC_IP_TYPE)
    assert declared, "the type must still declare its four facts"
    entry = next(
        rt for rt in catalog.facts.resource_types if rt.resource_type == PUBLIC_IP_TYPE
    )
    assert entry.child_of is None


def test_public_ip_addresses_declares_the_four_section_5_facts() -> None:
    """address, allocation_method, sku, association — section 5's own column list."""
    catalog = load_catalog()
    facts = catalog.facts.for_resource_type(PUBLIC_IP_TYPE)
    keys = {entry.key for entry in facts}
    # Section 5's own columns, which is what this test is about. Advisor's three are
    # declared on **every** type — it recommends across the estate rather than a fixed
    # tuple — so they are excluded rather than listed here, and asserted separately.
    projected = [entry for entry in facts if entry.source != "advisor"]
    assert {entry.key for entry in projected} == {
        "address",
        "allocation_method",
        "sku",
        "association",
    }
    assert {"category", "impact", "recommendation"} <= keys
    for entry in projected:
        assert entry.projectable, entry.key
        assert entry.source == "resource_graph", entry.key
        assert entry.value_kind == "text", entry.key


def test_public_ip_addresses_facts_ride_the_ordinary_projection_union() -> None:
    """No mv-expand, no collision risk: unlike task 6.1's child-type facts, these
    facts are safe to include in the union `AzureProvider.discover` passes to
    `inventory_query` unfiltered — proven by confirming none of the four keys is
    excluded by `_non_child_projections`."""
    from reporting_agent.azure.provider import _non_child_projections

    catalog = load_catalog()
    filtered = _non_child_projections(catalog)
    filtered_keys = {key for key, _ in filtered}
    for key in ("address", "allocation_method", "sku", "association"):
        assert key in filtered_keys, key


def test_guard_b_distinguishes_a_real_child_type_from_a_fact_only_first_class_type() -> None:
    """Guard B, corrected: the real shipped catalogue now carries BOTH kinds of
    metric-less fact-only type in one estate — `Microsoft.Network/virtualNetworks/
    subnets` (a real child, declares `child_of`) and `Microsoft.Network/
    publicIPAddresses` (first-class, declares none). The old declared-by-facts-alone
    test could not have told them apart; this is the check that proves the corrected
    `child_of` mechanism does, against the real catalogue rather than a synthetic one.

    One estate: two VMs, one VNet (parent), four of its subnets, and two public IP
    addresses. `resource_count` must be 5 (VMs + VNet + IPs — every deployed thing);
    only the subnets move to `child_type_counts`.
    """
    from reporting_agent.azure.inventory import (
        COUNT_COLUMN,
        LOCATION_COLUMN,
        TYPE_COLUMN,
        read_counts,
    )

    catalog = load_catalog()
    children = child_type_names(catalog)
    assert "Microsoft.Network/virtualNetworks/subnets" in children
    assert "Microsoft.Network/publicIPAddresses" not in children

    rows = [
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 2},
        {TYPE_COLUMN: "microsoft.network/virtualnetworks", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 1},
        {
            TYPE_COLUMN: "microsoft.network/virtualnetworks/subnets",
            LOCATION_COLUMN: "eastus",
            COUNT_COLUMN: 4,
        },
        {TYPE_COLUMN: PUBLIC_IP_TYPE.casefold(), LOCATION_COLUMN: "eastus", COUNT_COLUMN: 2},
    ]

    counts = read_counts(rows, child_types=children)

    assert counts.resource_count == 5, "2 VMs + 1 VNet + 2 public IPs — every deployed thing"
    assert dict(counts.type_counts) == {
        "microsoft.compute/virtualmachines": 2,
        "microsoft.network/virtualnetworks": 1,
        PUBLIC_IP_TYPE.casefold(): 2,
    }
    assert dict(counts.child_type_counts) == {
        "microsoft.network/virtualnetworks/subnets": 4,
    }
