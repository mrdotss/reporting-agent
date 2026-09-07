"""What "Total Resources" counts — the estate, not every row of the snapshot.

A snapshot's `resources` list holds three kinds of row, and only one of them is a thing
somebody deployed:

* a **first-class resource** — a VM, a disk, a public IP address;
* a **sub-record** of one — `Microsoft.Network/virtualNetworks/subnets`,
  `.../networkSecurityGroups/securityRules` — which exists so a section can table it;
* a **finding** about one — `Microsoft.Advisor/recommendations`, one row per
  recommendation since a recommendation became its own table row.

All three belong in the snapshot. Only the first is a resource, and the catalogue already
says which is which: `child_of` on a fact-catalogue entry, the mechanism
`tests/test_public_ip_facts.py` describes, and the same declaration the app's scan page
counts by (`app/lib/scans/view.ts`).

The regression this file pins came from the second and third kinds arriving without the
count learning about them. A real subscription holding **23** deployed resources reported
**80** — 23 + 32 sub-records + 25 Advisor findings — on a page whose every other figure
was correct, and it contradicted the scan summary the customer had read minutes earlier.
Two numbers for one estate, from one product, is worse than either being wrong alone.

`child_resource_types` **defaults to empty**, and that default is load-bearing rather than
convenience: `build_snapshot_view` is also called on prior runs' stored snapshots for the
historical trend, where no count of this kind is minted into the document, and a view
built without the argument must behave exactly as it did before this change.
"""

from __future__ import annotations

from reporting_agent.catalog.loader import child_type_names, load_catalog
from reporting_agent.collect.snapshot import ResourceSnapshot, SkuCapacity
from reporting_agent.compile.snapshot_view import build_snapshot_view
from snapshot_factory import build as build_fixture
from snapshot_factory import resource_record as make_rec

VM_TYPE = "Microsoft.Compute/virtualMachines"
SUBNET_TYPE = "Microsoft.Network/virtualNetworks/subnets"
ADVISOR_TYPE = "Microsoft.Advisor/recommendations"

SUB = "/subscriptions/sub-1/resourceGroups/rg-prod/providers"


def _resource(rid: str, name: str, resource_type: str, group: str = "rg-prod"):
    return ResourceSnapshot(
        record=make_rec(
            resource_id=rid, name=name, resource_type=resource_type, resource_group=group
        ),
        sku=SkuCapacity(name="", vcpus_available=None, memory_bytes=None),
        statistics=(),
        day_buckets=(),
        facts=(),
    )


def _estate() -> dict:
    """Two VMs, three subnets and four Advisor findings — nine rows, two resources."""
    resources = [
        _resource(f"{SUB}/Microsoft.Compute/virtualMachines/vm-01", "vm-01", VM_TYPE),
        _resource(f"{SUB}/Microsoft.Compute/virtualMachines/vm-02", "vm-02", VM_TYPE),
        *(
            _resource(
                f"{SUB}/Microsoft.Network/virtualNetworks/vnet-1/subnets/sub-{n}",
                f"sub-{n}",
                SUBNET_TYPE,
            )
            for n in range(1, 4)
        ),
        *(
            _resource(f"{SUB}/Microsoft.Advisor/recommendations/rec-{n}", f"rec-{n}", ADVISOR_TYPE)
            for n in range(1, 5)
        ),
    ]
    return build_fixture(
        resources=resources, resource_types=[VM_TYPE, SUBNET_TYPE, ADVISOR_TYPE]
    )


def _count(view, *tokens) -> int | None:
    value = view.cardinality(*tokens)
    return None if value is None else int(value.value)


def test_the_resource_count_is_the_estate_not_the_row_count() -> None:
    """The headline. Nine rows, two of them deployed."""
    view = build_snapshot_view(
        _estate(), child_resource_types=(SUBNET_TYPE, ADVISOR_TYPE)
    )
    assert _count(view, "resources") == 2


def test_sub_records_and_findings_are_both_excluded() -> None:
    """Not one or the other: the outage needed both, and a fix that dropped only the
    Advisor rows would still have reported 5 for an estate of 2."""
    doc = _estate()
    only_advisor = build_snapshot_view(doc, child_resource_types=(ADVISOR_TYPE,))
    only_subnets = build_snapshot_view(doc, child_resource_types=(SUBNET_TYPE,))
    assert _count(only_advisor, "resources") == 5
    assert _count(only_subnets, "resources") == 6


def test_the_group_rollup_counts_the_same_thing_as_the_headline() -> None:
    """The two disagreeing is what made the report visibly incoherent: §1 said 80 and §2's
    per-group rows summed to 80 while the estate held 23. Whatever the headline counts,
    the rollup beneath it counts."""
    view = build_snapshot_view(
        _estate(), child_resource_types=(SUBNET_TYPE, ADVISOR_TYPE)
    )
    assert _count(view, "resource_group", "by_name", "rg-prod") == 2
    assert _count(view, "resources") == 2


def test_a_per_type_count_still_reaches_every_type() -> None:
    """Deliberately **not** filtered. A per-type count names its own type, so `3` under
    `.../subnets` is unambiguous where `rg-prod holds 9` is not — and filtering here would
    delete the figure a subnet or recommendation section resolves its own row count from,
    trading a misleading total for a missing one."""
    view = build_snapshot_view(
        _estate(), child_resource_types=(SUBNET_TYPE, ADVISOR_TYPE)
    )
    assert _count(view, "resource_type", "by_name", SUBNET_TYPE) == 3
    assert _count(view, "resource_type", "by_name", ADVISOR_TYPE) == 4
    assert _count(view, "resource_type", "by_name", VM_TYPE) == 2


def test_the_distinct_type_count_is_the_reportable_estate() -> None:
    """Three types are present; one is a resource type. This is the figure the scan page
    shows as `TYPES`, and the two are read side by side."""
    view = build_snapshot_view(
        _estate(), child_resource_types=(SUBNET_TYPE, ADVISOR_TYPE)
    )
    assert _count(view, "resource_type") == 1


def test_omitting_the_argument_preserves_the_previous_behaviour_exactly() -> None:
    """The default is what a prior run's view is built with. It must count as it always
    did, or the historical path starts disagreeing with the runs it is plotting."""
    view = build_snapshot_view(_estate())
    assert _count(view, "resources") == 9
    assert _count(view, "resource_group", "by_name", "rg-prod") == 9
    assert _count(view, "resource_type") == 3


def test_the_comparison_is_case_insensitive() -> None:
    """ARM resource type ids are case-insensitive, and Resource Graph returns them
    lower-cased while the catalogue declares them in camel case. Three separate defects
    in this product have come from comparing them with `==`; this one is not going to be
    the fourth."""
    doc = _estate()
    shouted = build_snapshot_view(
        doc, child_resource_types=(SUBNET_TYPE.upper(), ADVISOR_TYPE.lower())
    )
    assert _count(shouted, "resources") == 2


def test_the_fidelity_tier_tally_counts_what_the_headline_counts() -> None:
    """The coverage appendix labels these rows "Resources at fidelity tier <tier>". If the
    tally counted every row, that appendix would report 9 baseline resources on a page
    whose subscription overview reports 2 — one document contradicting itself about the
    size of the estate it describes, which is worse than either number alone."""
    view = build_snapshot_view(
        _estate(), child_resource_types=(SUBNET_TYPE, ADVISOR_TYPE)
    )
    assert sum(view.tier_counts().values()) == _count(view, "resources") == 2
    assert _count(view, "fidelity_tier", "baseline") == 2


def test_the_shipped_catalogue_declares_all_three_excluded_kinds() -> None:
    """The fix is only as good as the declaration behind it. If a fourth sub-record or
    finding type is added without `child_of`, it silently rejoins the resource count —
    so assert against the real catalogue, not the fixture's."""
    declared = {name.casefold() for name in child_type_names(load_catalog())}
    assert SUBNET_TYPE.casefold() in declared
    assert ADVISOR_TYPE.casefold() in declared
    assert "microsoft.network/networksecuritygroups/securityrules" in declared
    assert VM_TYPE.casefold() not in declared


def test_the_reported_count_matches_the_compiled_one() -> None:
    """One estate, one number, across two modules that derive it independently.

    `collect/pipeline.py` puts `resource_count` on the `snapshot_ready` event; the app
    stores it and prints it in the run list under `ui.run_list.resources`.
    `compile/snapshot_view.py` mints the figure the report's subscription overview states.
    Nothing makes them agree except both counting the same thing, so this asserts they do
    — the failure it guards against is a run row reading 80 beside a report reading 23.
    """
    from reporting_agent.collect.pipeline import _estate_resource_count

    doc = _estate()
    view = build_snapshot_view(
        doc, child_resource_types=(SUBNET_TYPE, ADVISOR_TYPE)
    )
    assert _estate_resource_count(doc) == _count(view, "resources")


def test_the_reported_count_is_not_the_record_count() -> None:
    """Mutation guard on the test above: two counts of every row would also be equal."""
    from reporting_agent.collect.pipeline import _estate_resource_count

    doc = _estate()
    assert _estate_resource_count(doc) < len(doc["resources"])
