"""A children-scoped table lists sub-records, not findings filed under the same parent.

`BlockContext.resources_for` resolves `_scope: "children"` by **id containment**: every
resource whose id begins with the parent's id and a slash. ARM puts containment in the id,
so that is the right question to ask — until two different kinds of record answer it the
same way.

`Microsoft.Advisor/recommendations` became one row per recommendation, each filed under
the resource it is about:

    /subscriptions/…/virtualNetworks/mr-vnet/providers/Microsoft.Advisor/recommendations/23398b93

That begins with the virtual network's id, so a subnet table asking "what is under this
VNet" got it. A delivered report listed the recommendation
`MR-VNet (Virtual Network) — Use NAT gateway for outbound connectivity` as a subnet — and
because a table's columns are sized from their values, that 68-character title took the
width and left `IP configuration count` a column too narrow to print its own header
inside its border. One leaked row, two visible defects, neither of them near the cause.

The fix is the filter every other table already uses. These tests are behavioural rather
than catalogue-shaped — `test_section_catalogue.py` holds the declaration, this holds
what the declaration does.
"""

from __future__ import annotations

from decimal import Decimal

from reporting_agent.collect.snapshot import ResourceSnapshot, SkuCapacity
from reporting_agent.compile.blocks.base import (
    CHILD_SCOPE_CHILDREN,
    DesignSettings,
    CHILD_SCOPE_CONFIG_KEY,
    RESOURCE_ID_CONFIG_KEY,
    RESOURCE_TYPES_CONFIG_KEY,
    BlockContext,
)
from reporting_agent.compile.figures import FigureLedger
from reporting_agent.compile.sections import BlockSpec
from reporting_agent.compile.scope import ScopeRules
from reporting_agent.compile.snapshot_view import build_snapshot_view
from snapshot_factory import build as build_fixture
from snapshot_factory import resource_record as make_rec

VNET = "/subscriptions/sub-1/resourceGroups/rg-prod/providers/Microsoft.Network/virtualNetworks/vnet-1"
VNET_TYPE = "Microsoft.Network/virtualNetworks"
SUBNET_TYPE = "Microsoft.Network/virtualNetworks/subnets"
ADVISOR_TYPE = "Microsoft.Advisor/recommendations"


def _resource(resource_id: str, name: str, resource_type: str) -> ResourceSnapshot:
    return ResourceSnapshot(
        record=make_rec(
            resource_id=resource_id, name=name, resource_type=resource_type
        ),
        sku=SkuCapacity(name="", vcpus_available=None, memory_bytes=None),
        statistics=(),
        day_buckets=(),
        facts=(),
    )


def _view():
    """One VNet, two of its subnets, and one Advisor finding filed under the VNet.

    The finding's id is lower-cased ahead of its provider segment, as Resource Graph
    returns it and as the delivered snapshot recorded it — so this also covers the
    case-folded containment the resolver relies on.
    """
    return build_snapshot_view(
        build_fixture(
            resources=[
                _resource(VNET, "vnet-1", VNET_TYPE),
                _resource(f"{VNET}/subnets/gateway", "gateway", SUBNET_TYPE),
                _resource(f"{VNET}/subnets/workload", "workload", SUBNET_TYPE),
                _resource(
                    f"{VNET.lower()}/providers/Microsoft.Advisor/recommendations/23398b93",
                    "vnet-1 (Virtual Network) — Use NAT gateway for outbound connectivity",
                    ADVISOR_TYPE,
                ),
            ]
        )
    )


def _context(view):
    return BlockContext(
        view=view,
        ledger=FigureLedger(),
        design=DesignSettings.from_plain(None),
        default_scope=ScopeRules(),
    )


def _block(*, types: list[str] | None) -> BlockSpec:
    config: dict = {
        RESOURCE_ID_CONFIG_KEY: VNET,
        CHILD_SCOPE_CONFIG_KEY: CHILD_SCOPE_CHILDREN,
    }
    if types is not None:
        config[RESOURCE_TYPES_CONFIG_KEY] = types
    return BlockSpec(id="b-subnets", type="resource_table", config=config)


def test_a_declared_child_type_excludes_a_finding_filed_under_the_same_parent() -> None:
    view = _view()
    resolved = _context(view).resources_for(_block(types=[SUBNET_TYPE]), view)
    assert [r.name for r in resolved] == ["gateway", "workload"]


def test_the_finding_really_is_contained_by_the_parent() -> None:
    """Guard on the fixture, not on the code. If the Advisor id ever stops nesting under
    its parent, the test above starts passing for a reason that has nothing to do with the
    filter — so assert the containment the filter is there to survive."""
    view = _view()
    resolved = _context(view).resources_for(_block(types=None), view)
    names = [r.name for r in resolved]
    assert any("NAT gateway" in name for name in names), (
        "the fixture no longer reproduces the containment this filter exists for"
    )
    assert len(resolved) == 3


def test_narrowing_to_the_child_type_keeps_every_real_child() -> None:
    """The filter must not be so narrow it empties the table it was meant to clean —
    the failure mode that trades a wrong row for a missing section."""
    view = _view()
    with_types = _context(view).resources_for(_block(types=[SUBNET_TYPE]), view)
    assert len(with_types) == 2


def test_the_type_comparison_is_case_insensitive() -> None:
    """Resource Graph lower-cases what the catalogue declares in camel case."""
    view = _view()
    resolved = _context(view).resources_for(_block(types=[SUBNET_TYPE.upper()]), view)
    assert [r.name for r in resolved] == ["gateway", "workload"]
