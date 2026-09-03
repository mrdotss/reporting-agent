"""Task 6.1 — virtual network subnets as synthetic child resources.

Two things this file proves, and neither is visible from the other:

**The query.** `subnet_inventory_query` is a second, separate Resource Graph query from
`inventory_query` — confirmed necessary rather than assumed: a subnet is not its own row
in the `Resources` table, it is nested inside a VNet's `properties.subnets` array, and
`mv-expand` is the only documented way to read one as an addressable row (Microsoft's own
Resource Graph sample queries use exactly this pattern for subnets and peerings; the
`Resources` table's own documented description is "most Resource Manager resource types
and properties are here" — a subnet's type is never listed as a table row). It emits the
identical eight-column inventory shape `inventory_query` does, so the response folds
through `InventoryCollector`'s existing page fold with **no fold-side change at all** —
proven here by feeding a synthetic subnet-query response through the real fold and
asserting the resulting `ResourceRecord`s look exactly like any other resource.

**The counting boundary.** `resource_counts_query` runs against `Resources` with no
`mv-expand` at all, so it structurally cannot produce a subnet row — a subnet is never a
row in the plain `Resources` table regardless of what the fact catalogue declares. This
is the exact question Guard B (task 1.2/1.3) was written to ask synthetically, before
task 6.1 ever created a real child type: does the same estate report identical
`resource_count` / `type_counts` before and after subnets are declared. Guard B is
re-run here against the two queries' real, distinct KQL text as the affirmative
evidence for why the invariant holds structurally rather than merely by convention —
the two queries are different KQL because they answer different questions, and only
one of them could ever emit a subnet row.
"""

from __future__ import annotations

import asyncio

from fakes.azure_ports import FakeInventoryPort
from reporting_agent.azure.clients import (
    SUBNET_CHILD_RESOURCE_TYPE,
    resource_counts_query,
    subnet_inventory_query,
)
from reporting_agent.azure.inventory import (
    COUNT_COLUMN,
    LOCATION_COLUMN,
    TYPE_COLUMN,
    InventoryCollector,
    read_counts,
)
from reporting_agent.azure.ports import RawHttpResponse
from reporting_agent.catalog.loader import child_type_names, is_child_type, load_catalog

SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"


# --------------------------------------------------------------------------- #
# The query itself
# --------------------------------------------------------------------------- #


def test_subnet_query_uses_mv_expand_against_the_parent_vnet_type() -> None:
    """The structural reason a subnet needs its own query at all: it is nested inside
    the parent VNet's row, so the query must filter to VNets and `mv-expand` their
    `properties.subnets`, never filter to the subnet type itself — that type is never a
    row `Resources` can return."""
    query = subnet_inventory_query(subscription_id=SUBSCRIPTION)
    assert "mv-expand subnet = properties.subnets" in query
    assert "microsoft.network/virtualnetworks" in query.casefold()
    # The child type's own spelling must never appear in a `where type` clause — there
    # is no row of this type to filter for.
    assert f"where type =~ '{SUBNET_CHILD_RESOURCE_TYPE.casefold()}'" not in query.casefold()


def test_subnet_query_emits_the_same_eight_inventory_columns() -> None:
    """Same shape as `inventory_query`'s projection, so the fold needs no change at all."""
    query = subnet_inventory_query(subscription_id=SUBSCRIPTION)
    for column in ("id", "name", "type", "location", "resourceGroup", "tags", "sku", "powerState"):
        assert f"{column} =" in query or f"{column},\n" in query or f", {column} " in query, column


def test_subnet_query_hardcodes_the_child_type_as_a_string_literal() -> None:
    """The row's own `type` column is the constant, not read off any property — a
    `mv-expand`ed subnet element carries no `type` field of its own."""
    query = subnet_inventory_query(subscription_id=SUBSCRIPTION)
    assert f"'{SUBNET_CHILD_RESOURCE_TYPE}'" in query


def test_subnet_query_projects_no_available_ips_field() -> None:
    """Deliberately absent — see the module and function docstrings. Azure has no
    static available-IP-count property; the honest half this query can answer is the
    used `ipConfigurations` count, which a derived statistic combines with the address
    prefix's own mask math. A KQL expression computing the subnet mask arithmetic here
    would be a second, undeclared formula next to `DerivedEntry.formula`."""
    query = subnet_inventory_query(subscription_id=SUBSCRIPTION)
    assert "fact_available_ips" not in query
    assert "fact_ip_configuration_count" in query


def test_subnet_query_is_deterministic() -> None:
    """Two calls with the same argument build byte-identical text — the same guarantee
    every other query builder in this module carries."""
    first = subnet_inventory_query(subscription_id=SUBSCRIPTION)
    second = subnet_inventory_query(subscription_id=SUBSCRIPTION)
    assert first == second


def test_subnet_query_escapes_the_subscription_id() -> None:
    """The subscription id crosses from outside this process (the invocation context)
    and is not trusted verbatim, exactly as `inventory_query` treats it."""
    query = subnet_inventory_query(subscription_id="abc' or 1=1 --")
    assert "abc'' or 1=1 --" in query


def test_subnet_query_is_a_genuinely_different_query_from_the_counts_query() -> None:
    """The structural fact behind Guard B holding for real, not only synthetically:
    the counts query and the subnet query differ in their `where` clause and their use
    of `mv-expand`, so a subnet can appear in the answer to one and never the other."""
    subnet_query = subnet_inventory_query(subscription_id=SUBSCRIPTION)
    counts_query = resource_counts_query(subscription_id=SUBSCRIPTION)
    assert "mv-expand" in subnet_query
    assert "mv-expand" not in counts_query
    assert subnet_query != counts_query


# --------------------------------------------------------------------------- #
# The fold: a subnet response is an ordinary page to InventoryCollector
# --------------------------------------------------------------------------- #


def _subnet_page_body() -> dict[str, object]:
    """One synthetic Resource Graph response, shaped exactly as
    `subnet_inventory_query`'s projection would produce for a VNet with two subnets."""
    return {
        "data": [
            {
                "id": (
                    "/subscriptions/3f2b0000-0000-0000-0000-000000000000/"
                    "resourceGroups/rg-net/providers/Microsoft.Network/"
                    "virtualNetworks/vnet-a/subnets/app-tier"
                ),
                "name": "app-tier",
                "type": SUBNET_CHILD_RESOURCE_TYPE,
                "location": "eastus",
                "resourceGroup": "rg-net",
                "tags": {},
                "sku": "",
                "powerState": "",
                "fact_subnet": "app-tier",
                "fact_address_prefix": "10.0.1.0/24",
                "fact_ip_configuration_count": "3",
                "fact_peering_state": "",
            },
            {
                "id": (
                    "/subscriptions/3f2b0000-0000-0000-0000-000000000000/"
                    "resourceGroups/rg-net/providers/Microsoft.Network/"
                    "virtualNetworks/vnet-a/subnets/data-tier"
                ),
                "name": "data-tier",
                "type": SUBNET_CHILD_RESOURCE_TYPE,
                "location": "eastus",
                "resourceGroup": "rg-net",
                "tags": {},
                "sku": "",
                "powerState": "",
                "fact_subnet": "data-tier",
                "fact_address_prefix": "10.0.2.0/24",
                "fact_ip_configuration_count": "0",
                "fact_peering_state": "",
            },
        ],
        "$skipToken": None,
    }


def test_a_subnet_response_folds_through_the_unmodified_inventory_fold() -> None:
    """The whole point of matching `inventory_query`'s column shape: no fold-side code
    changes at all. Fed through `InventoryCollector.discover`'s real, public fold via a
    fake port scripted with a subnet-shaped page, a subnet row becomes an ordinary
    `ResourceRecord` with a real ARM id — with **zero** change to `_fold_page` itself.
    """
    response = RawHttpResponse(status=200, headers={}, body=_subnet_page_body())
    port = FakeInventoryPort([response])
    collector = InventoryCollector(port)

    result = asyncio.run(
        collector.discover(
            subscription_id=SUBSCRIPTION,
            resource_types=[SUBNET_CHILD_RESOURCE_TYPE],
            fidelity_tier="baseline",
        )
    )

    resources = {record["resource_id"]: record for record in result["resources"]}
    assert len(resources) == 2
    assert not result["gaps"], (
        "a subnet carries no power state and is not a VM, so no gap is expected"
    )

    app_tier_id = (
        "/subscriptions/3f2b0000-0000-0000-0000-000000000000/"
        "resourceGroups/rg-net/providers/Microsoft.Network/"
        "virtualNetworks/vnet-a/subnets/app-tier"
    )
    record = resources[app_tier_id]
    assert record["resource_type"] == SUBNET_CHILD_RESOURCE_TYPE
    assert record["name"] == "app-tier"
    assert record["resource_group"] == "rg-net"
    assert record["location"] == "eastus"
    assert record["power_state"] == "unknown"  # no power state, correctly normalized
    assert record["fidelity_tier"] == "baseline"


# --------------------------------------------------------------------------- #
# Guard B against the REAL catalogue, now that 6.1 creates the first real child type
# --------------------------------------------------------------------------- #


def test_guard_b_holds_against_the_real_shipped_catalogue_with_subnets_declared() -> None:
    """Task 1.2/1.3's Guard B has only ever run against a synthetic estate. This is the
    first time a real child type — `Microsoft.Network/virtualNetworks/subnets` — is
    actually declared in the shipped `facts.v1.json`, so this test re-runs the exact
    same invariant against `load_catalog()`'s real, loaded result rather than a
    hand-built `child_types` tuple.

    If this ever fails, the fix belongs in `read_counts` or in `is_child_type`, never
    in this test — the whole point of Guard B is that the partition must hold for
    whatever the real catalogues declare, not for a fixture built to make it pass.
    """
    catalog = load_catalog()
    children = child_type_names(catalog)
    assert SUBNET_CHILD_RESOURCE_TYPE in children, (
        "6.1 must add the subnet type to facts.v1.json for this guard to be checking "
        "anything real"
    )
    assert is_child_type(SUBNET_CHILD_RESOURCE_TYPE, catalog=catalog)
    assert not is_child_type("Microsoft.Network/virtualNetworks", catalog=catalog), (
        "the parent VNet type must stay a headline type — only the synthetic child "
        "row is a sub-record"
    )

    # One estate: 2 VMs, 1 VNet, 1 NSG (4 deployed things), plus 4 subnets the VNet
    # owns (the sub-records this task adds). Six rows total across two regions.
    rows = [
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 1},
        {TYPE_COLUMN: "microsoft.compute/virtualmachines", LOCATION_COLUMN: "westus", COUNT_COLUMN: 1},
        {TYPE_COLUMN: "microsoft.network/virtualnetworks", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 1},
        {TYPE_COLUMN: "microsoft.network/networksecuritygroups", LOCATION_COLUMN: "eastus", COUNT_COLUMN: 1},
        {TYPE_COLUMN: SUBNET_CHILD_RESOURCE_TYPE.casefold(), LOCATION_COLUMN: "eastus", COUNT_COLUMN: 4},
    ]

    before = read_counts(rows, child_types=())
    after = read_counts(rows, child_types=children)

    # The real assertion: the deployed things stay 4 regardless of whether the real
    # catalogue's declared child types are applied, and only `child_type_counts`
    # differs — the original synthetic Guard B's own invariant, now driven by
    # `child_type_names(load_catalog())` instead of a hand-typed tuple.
    assert after.resource_count == 4
    assert dict(after.type_counts) == {
        "microsoft.compute/virtualmachines": 2,
        "microsoft.network/virtualnetworks": 1,
        "microsoft.network/networksecuritygroups": 1,
    }
    assert dict(after.child_type_counts) == {
        SUBNET_CHILD_RESOURCE_TYPE.casefold(): 4,
    }
    # And with no child type declared, the same four subnet-carrying rows would have
    # inflated resource_count to 8 — the exact failure Guard B exists to catch.
    assert before.resource_count == 8


def test_the_counts_query_cannot_produce_a_subnet_row_at_all() -> None:
    """The stronger claim behind Guard B holding in practice, not just in the reader's
    partition logic: `resource_counts_query` runs `Resources | summarize count() by
    type, location` with no `mv-expand`, so it is structurally incapable of returning
    a `Microsoft.Network/virtualNetworks/subnets` row — that type is never a row in the
    plain `Resources` table, subnet or no subnet declaration. This is why the headline
    counts cannot move from 6.1: not because `read_counts` filters the row out, but
    because the row the filter would need to see is never produced by this query in
    the first place.

    A synthetic test can only assert this by absence-of-mv-expand, since there is no
    real subscription to query here — but that absence is the entire structural
    argument, and it is the one thing a purely synthetic Guard B (task 1.3's own) could
    never have shown on its own.
    """
    counts_query = resource_counts_query(subscription_id=SUBSCRIPTION)
    assert "mv-expand" not in counts_query
    assert SUBNET_CHILD_RESOURCE_TYPE.casefold() not in counts_query.casefold()


# --------------------------------------------------------------------------- #
# The real surprise: a child type's own facts must never reach inventory_query
# --------------------------------------------------------------------------- #


def test_a_child_types_facts_are_excluded_from_the_general_projection_union() -> None:
    """The defect this task actually found: `FactDeclaration.projectable()` with no
    argument returns the union across every declared type, including a child type's.
    A child type's projection expression names an identifier (`subnet`) that exists
    only inside `subnet_inventory_query`'s own `mv-expand` — `inventory_query` never
    runs that `mv-expand`, so appending the identifier to its `project` clause would
    make the WHOLE inventory query fail, for every resource type, on every run, the
    moment `Microsoft.Network/virtualNetworks/subnets` declares any projectable fact.

    `_non_child_projections` is the fix, and it excludes by **owning type** rather than by
    key. The difference is live: a network interface declares `subnet` too — the name read
    out of `properties.ipConfigurations[0].properties.subnet.id`, which this query *can*
    evaluate — and excluding by key dropped that one along with the child's, so section
    4.2's subnet column was empty and nothing said why. A key owned only by a child type is
    still absent; a key a first-class type also declares keeps that type's expression.

    Proven against the real, shipped catalogue, not a hand-built one — this is the fact
    declaration `AzureProvider.discover` actually loads and passes to `inventory.discover`.
    """
    from reporting_agent.azure.provider import _non_child_projections
    from reporting_agent.catalog.loader import child_type_names, load_catalog

    catalog = load_catalog()
    filtered = _non_child_projections(catalog)
    filtered_keys = {key for key, _ in filtered}

    children = child_type_names(catalog)
    child_keys = {
        entry.key
        for declared in catalog.facts.resource_types
        if declared.resource_type in children
        for entry in declared.facts
    }
    first_class_keys = {
        entry.key
        for declared in catalog.facts.resource_types
        if declared.resource_type not in children
        for entry in declared.facts
        if entry.projectable and entry.projection
    }

    # Owned by a child type and by nothing else: these must never ride this query.
    # `peering_state` left this list when the parent type declared it too — a peering is a
    # property of a virtual network, not of a subnet, and the two now read it by the
    # identical expression, so it is covered by the both-sides case below rather than here.
    for key in ("address_prefix", "ip_configuration_count"):
        assert key in child_keys, "this guard is only meaningful while these are subnet keys"
        assert key not in first_class_keys, (
            f"{key!r} is no longer child-only, so it proves nothing here"
        )
        assert key not in filtered_keys, (
            f"{key!r} is declared only by the child type "
            f"{SUBNET_CHILD_RESOURCE_TYPE!r} and must never ride inventory_query's "
            f"own projection clause"
        )

    # Declared on both sides of the line. It belongs here — as the interface's expression,
    # never as the subnet's, which names an identifier this query does not bind.
    assert "subnet" in child_keys and "subnet" in first_class_keys
    assert "subnet" in filtered_keys
    assert "ipConfigurations" in dict(filtered)["subnet"]
    assert "subnet.name" not in dict(filtered)["subnet"]

    # And the fix must not have thrown out anything else: every projectable fact a
    # first-class type declares is still present.
    assert filtered_keys == first_class_keys


def test_mutation_check_a_naive_unfiltered_union_would_have_broken_every_run() -> None:
    """Mutation check for the fix above: reverting to the naive
    `catalog.facts.projectable()` call — the exact form the collision was found in —
    must reintroduce the child type's identifiers into the projection set. This proves
    the test above is actually connected to the defect, not merely to a name."""
    from reporting_agent.catalog.loader import load_catalog

    catalog = load_catalog()
    naive = {key for key, _ in catalog.facts.projectable()}
    assert "subnet" in naive, (
        "if this ever fails, the naive call itself stopped including the child "
        "type's facts and the mutation check no longer proves anything"
    )


# --------------------------------------------------------------------------- #
# End to end: AzureProvider.discover actually issues the second query and merges it
# --------------------------------------------------------------------------- #


def _child_query_response() -> RawHttpResponse:
    return RawHttpResponse(status=200, headers={}, body=_subnet_page_body())


def test_discover_issues_the_child_query_only_when_vnets_are_in_scope() -> None:
    """The gate: a scope that never mentions `Microsoft.Network/virtualNetworks` must
    never call `query_child_resources` at all — the whole reason `FakeInventoryPort`
    shares one queue across its methods is so a test can notice an unscripted extra
    call. This scope requests only VMs, so scripting zero responses for the child
    query and getting no `ExhaustedScriptError` is the proof the call never fires."""
    import test_azure_provider as tap

    harness = tap.Harness(
        inventory=[tap.inventory_page([tap.inventory_row("prod-web-01")])]
    )
    result = asyncio.run(harness.provider.discover(tap.scope()))
    assert [r["resource_id"] for r in result["resources"]] == [
        tap.resource_id("prod-web-01")
    ]


def test_discover_issues_the_child_query_and_merges_subnets_when_vnets_are_in_scope() -> None:
    """The real wiring, proven end to end: a scope naming
    `Microsoft.Network/virtualNetworks` causes `AzureProvider.discover` to call
    `query_child_resources` (the second, scripted response) and merge its rows into
    the same `resources` list the main inventory query populated — a subnet sits
    beside its parent VNet in one inventory, with no fold-side or caller-side
    special-casing needed downstream of this method.
    """
    import test_azure_provider as tap

    vnet_row = {
        "id": "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/"
        "rg-net/providers/Microsoft.Network/virtualNetworks/vnet-a",
        "name": "vnet-a",
        "type": "microsoft.network/virtualnetworks",
        "location": "eastus",
        "resourceGroup": "rg-net",
        "tags": {},
        "sku": "",
        "powerState": "",
    }
    harness = tap.Harness(
        inventory=[
            tap.inventory_page([vnet_row]),
            _child_query_response(),
        ]
    )
    vnet_scope = tap.ScopeSpec(
        subscription_id=SUBSCRIPTION,
        resource_types=["Microsoft.Network/virtualNetworks"],
        resource_groups=[],
        tag_filters={},
    )

    result = asyncio.run(harness.provider.discover(vnet_scope))
    ids = {record["resource_id"] for record in result["resources"]}

    assert vnet_row["id"] in ids
    assert any(SUBNET_CHILD_RESOURCE_TYPE in record["resource_type"] for record in result["resources"])
    subnet_records = [
        record for record in result["resources"] if record["resource_type"] == SUBNET_CHILD_RESOURCE_TYPE
    ]
    assert len(subnet_records) == 2, "both subnets from the scripted child response landed"
    assert not any(gap["gap_type"] == "power_state_unknown" for gap in result["gaps"]), (
        "a subnet is not a VM, so the absent power state must not be flagged"
    )


def test_child_resources_are_filtered_by_the_same_group_and_tag_scope() -> None:
    """A resource-group filter that excludes the parent VNet must also exclude its
    subnets — a subnet surviving alone in the inventory after its parent was filtered
    out would be the exact opposite of what the filter means."""
    import test_azure_provider as tap

    vnet_row = {
        "id": "/subscriptions/3f2b0000-0000-0000-0000-000000000000/resourceGroups/"
        "rg-net/providers/Microsoft.Network/virtualNetworks/vnet-a",
        "name": "vnet-a",
        "type": "microsoft.network/virtualnetworks",
        "location": "eastus",
        "resourceGroup": "rg-net",
        "tags": {},
        "sku": "",
        "powerState": "",
    }
    harness = tap.Harness(
        inventory=[
            tap.inventory_page([vnet_row]),
            _child_query_response(),
        ]
    )
    vnet_scope = tap.ScopeSpec(
        subscription_id=SUBSCRIPTION,
        resource_types=["Microsoft.Network/virtualNetworks"],
        resource_groups=["rg-some-other-group"],
        tag_filters={},
    )

    result = asyncio.run(harness.provider.discover(vnet_scope))
    assert result["resources"] == []


# --------------------------------------------------------------------------- #
# Every Resource Graph query this module writes must parse
# --------------------------------------------------------------------------- #


def _every_resource_graph_query() -> dict[str, str]:
    """Each query builder in `azure/clients.py`, called with plausible arguments.

    Enumerated from `__all__` rather than listed here, so a fourth query added later is
    covered without this test being edited — the same reason the gap-type and
    exclusion-reason guards derive their subjects from the declarations they check.
    """
    import inspect

    from reporting_agent.azure import clients

    built: dict[str, str] = {}
    for name in clients.__all__:
        if not name.endswith("_query"):
            continue
        builder = getattr(clients, name)
        parameters = inspect.signature(builder).parameters
        arguments: dict[str, object] = {}
        if "subscription_id" in parameters:
            arguments["subscription_id"] = "3f2b0000-0000-0000-0000-000000000000"
        if "resource_types" in parameters:
            arguments["resource_types"] = ["Microsoft.Compute/virtualMachines"]
        if "fact_projections" in parameters:
            arguments["fact_projections"] = [("os_type", "tostring(properties.osType)")]
        try:
            built[name] = builder(**arguments)
        except TypeError:  # pragma: no cover - a builder needing arguments not modelled
            continue
    return built


def test_no_query_carries_an_empty_projection_column() -> None:
    """A `| project` column list must name a column between every pair of commas.

    `subnet_inventory_query` and `security_rule_inventory_query` both ended their fixed
    columns with `powerState = "",` and then opened every fact line with its own `,`,
    producing `powerState = "", , fact_subnet = ...`. Resource Graph answers that with a
    **400**, and the collector logs "the child-resource query returned status 400; no
    child resource is recorded for this run" and carries on — so every subnet and every
    security rule was silently absent from every report.

    Nothing caught it because every test in this file and in
    `test_security_rule_inventory.py` asserts on *fragments* — that the query contains an
    `mv-expand`, that it names the right type, that a fact column is projected. A fragment
    assertion cannot see a comma between two fragments. This reads the whole clause.

    `inventory_query` had it right all along: its last fixed column carries no trailing
    comma because its projection loop supplies one per fact line. The two child queries
    copied the shape and kept the comma.
    """
    import re

    for name, query in _every_resource_graph_query().items():
        for clause in re.findall(r"\| project (.+?)(?=\n\| |\Z)", query, re.S):
            columns = [part.strip() for part in clause.split(",")]
            empty = [index for index, part in enumerate(columns) if not part]
            assert not empty, (
                f"{name}: the `| project` clause has an empty column at position(s) "
                f"{empty}, which Resource Graph answers with a 400. Clause:\n{clause}"
            )


def test_no_query_contains_two_commas_in_a_row() -> None:
    """The same defect stated the way it appears in the text, so the failure names it.

    Kept beside the clause check rather than folded into it: this one is legible in a
    diff and cannot be argued with, and it is the exact shape a builder that appends its
    own separator produces.
    """
    import re

    for name, query in _every_resource_graph_query().items():
        assert not re.search(r",\s*,", query, re.S), (
            f"{name} contains two consecutive commas, so it does not parse"
        )


def test_the_guard_covers_every_query_the_module_exports() -> None:
    """Non-vacuity: a builder this could not call is a builder it does not check."""
    from reporting_agent.azure import clients

    exported = {name for name in clients.__all__ if name.endswith("_query")}
    built = set(_every_resource_graph_query())

    assert built == exported, (
        f"these query builders were not exercised: {sorted(exported - built)}"
    )
