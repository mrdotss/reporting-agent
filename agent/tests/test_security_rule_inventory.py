"""Task 6.3 — network security groups: inbound and outbound rules.

Confirms the exact shape task 6.1's own depth check predicted for the next
`mv-expand`-based child type, plus the one genuinely new decision this task adds:
how "omit Azure's own defaults at priority 65000 and above" is implemented.

**Structural exclusion, not a runtime filter.** An NSG carries two genuinely separate
array properties — `properties.securityRules` (author-defined) and
`properties.defaultSecurityRules` (Azure's own five rules, present on every NSG
unconditionally). Confirmed against the resource's own schema: a `securityRules`
entry's `priority` is `required`, ranged 100-4096 — the schema itself forbids an
author-defined rule from ever reaching 65000. So `security_rule_inventory_query`
expands only `properties.securityRules` and never reads `defaultSecurityRules` at
all; "omit defaults" is achieved by never naming the array that holds them, not by
comparing a projected `priority` against 65000 at query time or in Python. A runtime
`where priority < 65000` guard would be redundant against a bound it did not derive
from, and — per task 6.2's own `child_of` lesson — a redundant check that happens to
be correct today is exactly the shape of thing that silently stops being correct
later without anyone noticing why.
"""

from __future__ import annotations

import asyncio

from fakes.azure_ports import FakeInventoryPort
from reporting_agent.azure.clients import (
    SECURITY_RULE_CHILD_RESOURCE_TYPE,
    SUBNET_CHILD_RESOURCE_TYPE,
    child_resources_query,
    security_rule_inventory_query,
)
from reporting_agent.azure.inventory import InventoryCollector
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.catalog.loader import child_type_names, is_child_type, load_catalog

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"


# --------------------------------------------------------------------------- #
# The query itself
# --------------------------------------------------------------------------- #


def test_security_rule_query_expands_securityRules_never_defaultSecurityRules() -> None:
    """The whole implementation of "omit defaults at priority 65000+": never read the
    array that holds them."""
    query = security_rule_inventory_query(subscription_id=SUBSCRIPTION)
    assert "mv-expand rule = properties.securityRules" in query
    assert "defaultSecurityRules" not in query
    assert "65000" not in query, "no runtime priority filter — the exclusion is structural"


def test_security_rule_query_uses_mv_expand_against_the_parent_nsg_type() -> None:
    query = security_rule_inventory_query(subscription_id=SUBSCRIPTION)
    assert "where type =~ 'microsoft.network/networksecuritygroups'" in query.casefold()
    assert f"'{SECURITY_RULE_CHILD_RESOURCE_TYPE.casefold()}'" in query.casefold()


def test_security_rule_query_coalesces_singular_and_plural_address_and_port_forms() -> None:
    """An operator may write one CIDR/port or a list, never both — reading only the
    singular field would silently blank every rule authored with a list."""
    query = security_rule_inventory_query(subscription_id=SUBSCRIPTION)
    assert "coalesce(tostring(rule.properties.sourceAddressPrefix)" in query
    assert "strcat_array(rule.properties.sourceAddressPrefixes" in query
    assert "coalesce(tostring(rule.properties.destinationAddressPrefix)" in query
    assert "strcat_array(rule.properties.destinationAddressPrefixes" in query
    assert "coalesce(tostring(rule.properties.destinationPortRange)" in query
    assert "strcat_array(rule.properties.destinationPortRanges" in query


def test_security_rule_query_reads_access_as_the_action_fact() -> None:
    """Azure's own field name is `access` ('Allow'/'Deny'); this catalogue's fact key
    is `action`, matching section 6's own column name."""
    query = security_rule_inventory_query(subscription_id=SUBSCRIPTION)
    assert "fact_action = tostring(rule.properties.access)" in query


def test_security_rule_query_is_deterministic() -> None:
    first = security_rule_inventory_query(subscription_id=SUBSCRIPTION)
    second = security_rule_inventory_query(subscription_id=SUBSCRIPTION)
    assert first == second


def test_child_resources_query_unions_both_child_queries_in_one_request() -> None:
    """task 6.1's subnets and task 6.3's security rules ride one Resource Graph
    request via `union`, not two HTTP calls — confirmed against Kusto's own
    documented syntax for unioning a full parenthesized sub-query."""
    combined = child_resources_query(subscription_id=SUBSCRIPTION)
    assert "mv-expand subnet = properties.subnets" in combined
    assert "mv-expand rule = properties.securityRules" in combined
    assert "| union (" in combined


# --------------------------------------------------------------------------- #
# The fold: a security rule response is an ordinary page to InventoryCollector
# --------------------------------------------------------------------------- #


def _rule_page_body() -> dict[str, object]:
    return {
        "data": [
            {
                "id": (
                    "/subscriptions/3f2b0000-0000-0000-0000-000000000000/"
                    "resourceGroups/rg-net/providers/Microsoft.Network/"
                    "networkSecurityGroups/nsg-web/securityRules/allow-https"
                ),
                "name": "allow-https",
                "type": SECURITY_RULE_CHILD_RESOURCE_TYPE,
                "location": "eastus",
                "resourceGroup": "rg-net",
                "tags": {},
                "sku": "",
                "powerState": "",
                "fact_priority": "100",
                "fact_direction": "Inbound",
                "fact_protocol": "Tcp",
                "fact_source": "*",
                "fact_destination": "*",
                "fact_port": "443",
                "fact_action": "Allow",
            }
        ],
        "$skipToken": None,
    }


def test_a_security_rule_response_folds_through_the_unmodified_inventory_fold() -> None:
    response = RawHttpResponse(status=200, headers={}, body=_rule_page_body())
    port = FakeInventoryPort([response])
    collector = InventoryCollector(port)

    result = asyncio.run(
        collector.discover(
            subscription_id=SUBSCRIPTION,
            resource_types=[SECURITY_RULE_CHILD_RESOURCE_TYPE],
            fidelity_tier="baseline",
        )
    )

    resources = {record["resource_id"]: record for record in result["resources"]}
    assert len(resources) == 1
    assert not result["gaps"]

    rule_id = (
        "/subscriptions/3f2b0000-0000-0000-0000-000000000000/"
        "resourceGroups/rg-net/providers/Microsoft.Network/"
        "networkSecurityGroups/nsg-web/securityRules/allow-https"
    )
    record = resources[rule_id]
    assert record["resource_type"] == SECURITY_RULE_CHILD_RESOURCE_TYPE
    assert record["name"] == "allow-https"
    assert record["power_state"] == "unknown"


# --------------------------------------------------------------------------- #
# is_child_type / catalogue correctness
# --------------------------------------------------------------------------- #


def test_security_rules_is_a_child_type_declaring_the_nsg_as_parent() -> None:
    catalog = load_catalog()
    assert is_child_type(SECURITY_RULE_CHILD_RESOURCE_TYPE, catalog=catalog)
    entry = next(
        rt
        for rt in catalog.facts.resource_types
        if rt.resource_type == SECURITY_RULE_CHILD_RESOURCE_TYPE
    )
    assert entry.child_of == "Microsoft.Network/networkSecurityGroups"


def test_both_child_types_are_listed_and_the_parents_are_not() -> None:
    catalog = load_catalog()
    children = child_type_names(catalog)
    assert SUBNET_CHILD_RESOURCE_TYPE in children
    assert SECURITY_RULE_CHILD_RESOURCE_TYPE in children
    assert "Microsoft.Network/networkSecurityGroups" not in children
    assert "Microsoft.Network/virtualNetworks" not in children


def test_security_rule_facts_are_declared_and_excluded_from_the_ordinary_projection_union() -> None:
    """The identical collision task 6.1 found and fixed with `_non_child_projections`
    — a security rule's fact projections name `rule`, an identifier that exists only
    inside `security_rule_inventory_query`'s own `mv-expand`, and must never ride
    `inventory_query`'s unfiltered clause."""
    from reporting_agent.azure.provider import _non_child_projections

    catalog = load_catalog()
    keys = {entry.key for entry in catalog.facts.for_resource_type(SECURITY_RULE_CHILD_RESOURCE_TYPE)}
    assert keys == {"priority", "direction", "protocol", "source", "destination", "port", "action"}

    filtered = _non_child_projections(catalog)
    filtered_keys = {key for key, _ in filtered}
    for key in keys:
        assert key not in filtered_keys, key


# --------------------------------------------------------------------------- #
# End to end: AzureProvider.discover issues the combined query when NSGs are in scope
# --------------------------------------------------------------------------- #


def _nsg_row() -> dict[str, object]:
    return {
        "id": "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/"
        "rg-net/providers/Microsoft.Network/networkSecurityGroups/nsg-web",
        "name": "nsg-web",
        "type": "microsoft.network/networksecuritygroups",
        "location": "eastus",
        "resourceGroup": "rg-net",
        "tags": {},
        "sku": "",
        "powerState": "",
    }


def test_discover_issues_the_combined_query_when_only_nsgs_are_in_scope() -> None:
    """The gate widened for task 6.3: a scope naming ONLY
    `Microsoft.Network/networkSecurityGroups` (no VNets at all) still triggers
    `discover_child_resources` — the combined query's subnet leg simply contributes
    no rows, and the security-rule leg does the real work."""
    import test_azure_provider as tap

    harness = tap.Harness(
        inventory=[
            tap.inventory_page([_nsg_row()]),
            RawHttpResponse(status=200, headers={}, body=_rule_page_body()),
        ]
    )
    nsg_scope = tap.ScopeSpec(
        subscription_id=SUBSCRIPTION,
        resource_types=["Microsoft.Network/networkSecurityGroups"],
        resource_groups=[],
        tag_filters={},
    )

    result = asyncio.run(harness.provider.discover(nsg_scope))
    ids = {record["resource_id"] for record in result["resources"]}

    nsg_id = (
        "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/"
        "rg-net/providers/Microsoft.Network/networkSecurityGroups/nsg-web"
    )
    rule_id = (
        "/subscriptions/3f2b0000-0000-0000-0000-000000000000/"
        "resourceGroups/rg-net/providers/Microsoft.Network/"
        "networkSecurityGroups/nsg-web/securityRules/allow-https"
    )
    assert nsg_id in ids
    assert rule_id in ids
    assert any(
        record["resource_type"] == SECURITY_RULE_CHILD_RESOURCE_TYPE for record in result["resources"]
    )


def test_an_unconstrained_scope_still_discovers_child_resources() -> None:
    """`resource_types: []` means every type, and this gate has to read it that way.

    `inventory_query` applies its `| where type in~ (...)` only `if resource_types`, so an
    empty list collects everything — which is how a real run collected three network
    security groups in the first place. The gate on `discover_child_resources` read the
    same empty list as "names neither parent", because `any()` over nothing is false, and
    issued no child query at all.

    The consequence was silent and total: every security rule and every subnet missing
    from every report whose profile did not enumerate resource types by hand, with **no
    gap recorded** — nothing had been asked for, so nothing was reported absent. Section 6
    printed "None of these facts were collected for the resources in this table: priority,
    direction, protocol, …" and read as a collection failure.

    Every other test in this file names its types explicitly, which is why none of them
    could see it. The empty scope is the one a profile produces by default.
    """
    import test_azure_provider as tap

    harness = tap.Harness(
        inventory=[
            tap.inventory_page([_nsg_row()]),
            RawHttpResponse(status=200, headers={}, body=_rule_page_body()),
        ]
    )
    unconstrained = tap.ScopeSpec(
        subscription_id=SUBSCRIPTION,
        resource_types=[],
        resource_groups=[],
        tag_filters={},
    )

    result = asyncio.run(harness.provider.discover(unconstrained))
    types = {record["resource_type"] for record in result["resources"]}

    assert SECURITY_RULE_CHILD_RESOURCE_TYPE in types, (
        "an unconstrained scope collected the parent NSG but none of its rules, so the "
        "section renders every rule fact as uncollected with no gap explaining it"
    )


def test_the_child_page_is_returned_for_fact_folding() -> None:
    """The child query's page must reach `collect_facts`, or its facts are lost.

    The query projects a `fact_` column per fact the child type declares — a rule's
    `priority`, a subnet's `address_prefix` — and `azure/facts.py::_fold_pages` is what
    turns those columns into facts. `discover_child_resources` returned its resources and
    not its page, so eleven security rules reached the snapshot carrying **no facts at
    all** and section 6 reported "None of these facts were collected" about a resource
    whose facts were sitting in the archived response.

    It also made the run unreproducible. `verify/replay.py` folds **every archived
    object**, and this page is archived unconditionally. Replay folded the facts the live
    run had not, recorded eight `fact_unavailable` gaps for the columns the response left
    empty, and produced a snapshot digest that could not match the recorded one —
    `REPLAY_MISMATCH`, on a run where nothing was wrong with the data.

    That asymmetry is the thing to guard: the live fold and the replay fold have to agree
    about which archived pages produce facts, and a page that is archived but not folded
    is exactly where they part.
    """
    import test_azure_provider as tap

    harness = tap.Harness(
        inventory=[
            tap.inventory_page([_nsg_row()]),
            RawHttpResponse(status=200, headers={}, body=_rule_page_body()),
        ]
    )
    scope = tap.ScopeSpec(
        subscription_id=SUBSCRIPTION,
        resource_types=["Microsoft.Network/networkSecurityGroups"],
        resource_groups=[],
        tag_filters={},
    )

    result = asyncio.run(harness.provider.discover(scope))

    pages = list(result.get("inventory_pages") or ())
    assert len(pages) >= 2, (
        "the child-resource page was not returned for fact folding, so every fact on a "
        "subnet or a security rule is dropped and the replay disagrees about the snapshot"
    )
