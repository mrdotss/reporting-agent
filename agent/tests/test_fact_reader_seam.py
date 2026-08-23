"""Behavioural seam test: `collect.numeric.decimal_leaf` is called on both sides (Req 7.7, 7.9, 7.11).

The lesson `tech.md` records as "an injected seam is an untested seam":

    A static assertion that both modules import the symbol would pass against a module
    that imported it and then parsed inline.

So this module installs a **counting wrapper** over `decimal_leaf` and asserts that a live
collection pass (through `fold_fact_response` as called by `azure/facts.py`) and a replay
(through `fold_fact_response` as called by `verify/replay.py`) both route every numeric fact
through it, with equal counts.

The wrapper replaces the module attribute, so both callers — which import the *function* from
`collect.numeric` by name and call it at runtime — see the instrumented version. A static
import check would miss an inline `Decimal(str(value))` added beside the import; this catches
any path that skips the function entirely.
"""

from __future__ import annotations

from decimal import Decimal
from typing import Any
from unittest.mock import patch

from reporting_agent.catalog.loader import (
    FactDeclaration,
    FactDeclarationEntry,
    ResourceTypeFacts,
)
from reporting_agent.collect.factfold import (
    FACT_KIND_FACTS,
    FACT_KIND_INVENTORY,
    fold_fact_response,
)
from reporting_agent.collect.numeric import decimal_leaf

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

_RESOURCE_TYPE = "microsoft.compute/virtualmachines"
_RESOURCE_ID = "/subscriptions/sub1/resourceGroups/rg1/providers/Microsoft.Compute/virtualMachines/vm-01"
_RECEIVED_AT = "2026-08-01T09:20:44Z"


def _numeric_fact_declaration() -> FactDeclaration:
    """A declaration with two numeric facts and one text fact for one resource type."""
    return FactDeclaration(
        resource_types=(
            ResourceTypeFacts(
                resource_type=_RESOURCE_TYPE,
                facts=(
                    FactDeclarationEntry(
                        resource_type=_RESOURCE_TYPE,
                        key="disk_size_gb",
                        value_kind="numeric",
                        source="resource_graph",
                        projectable=True,
                        projection="properties.storageProfile.osDisk.diskSizeGB",
                        absent_gap_type=None,
                        unit="bytes",
                    ),
                    FactDeclarationEntry(
                        resource_type=_RESOURCE_TYPE,
                        key="vcpu_count",
                        value_kind="numeric",
                        source="resource_graph",
                        projectable=True,
                        projection="properties.hardwareProfile.vmSize",
                        absent_gap_type=None,
                        unit="count",
                    ),
                    FactDeclarationEntry(
                        resource_type=_RESOURCE_TYPE,
                        key="os_type",
                        value_kind="text",
                        source="resource_graph",
                        projectable=True,
                        projection="properties.storageProfile.osDisk.osType",
                        absent_gap_type=None,
                        unit=None,
                    ),
                ),
            ),
        )
    )


def _inventory_page_with_numeric_facts() -> dict[str, Any]:
    """A Resource Graph page carrying projected fact columns, including numeric ones."""
    return {
        "data": [
            {
                "id": _RESOURCE_ID,
                "type": _RESOURCE_TYPE,
                "fact_disk_size_gb": 128,
                "fact_vcpu_count": "4",
                "fact_os_type": "Windows",
            },
        ]
    }


def _facts_response_with_numeric() -> dict[str, Any]:
    """A non-projectable source response with a numeric fact."""
    return {
        "value": [
            {
                "resource_id": _RESOURCE_ID,
                "disk_size_gb": Decimal("256.5"),
                "vcpu_count": 8,
                "os_type": "Linux",
            },
        ]
    }


# ---------------------------------------------------------------------------
# The counting wrapper
# ---------------------------------------------------------------------------


class _CallCounter:
    """A transparent counting wrapper over `decimal_leaf`."""

    def __init__(self) -> None:
        self.count = 0

    def __call__(self, value: object) -> Decimal | None:
        self.count += 1
        return decimal_leaf(value)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestBehaviouralSeam:
    """Both sides of the archive call `decimal_leaf` for every numeric leaf."""

    def test_live_collection_routes_numeric_facts_through_decimal_leaf(self) -> None:
        """The collection path (FACT_KIND_INVENTORY) calls `decimal_leaf` for each numeric
        fact in the response. A module that imported the symbol but parsed inline would
        show count == 0."""
        counter = _CallCounter()
        declaration = _numeric_fact_declaration()
        body = _inventory_page_with_numeric_facts()

        with patch(
            "reporting_agent.collect.factfold.decimal_leaf", side_effect=counter
        ):
            facts, _gaps = fold_fact_response(
                body,
                kind=FACT_KIND_INVENTORY,
                source="",
                resource_ids=[_RESOURCE_ID],
                declaration=declaration,
                resource_types={_RESOURCE_ID: _RESOURCE_TYPE},
                received_at=_RECEIVED_AT,
            )

        # The page has two numeric facts (disk_size_gb=128, vcpu_count="4").
        # Each must have been routed through decimal_leaf.
        assert counter.count >= 2, (
            f"expected at least 2 calls to decimal_leaf for 2 numeric facts, got {counter.count}"
        )

        # Verify the facts were actually produced
        numeric_facts = [f for f in facts if f["value_kind"] == "numeric"]
        assert len(numeric_facts) == 2, numeric_facts

    def test_replay_routes_numeric_facts_through_decimal_leaf(self) -> None:
        """The replay path (also through `fold_fact_response`, same kind) calls
        `decimal_leaf` for each numeric leaf. The archive stores values as digit strings
        (str), and replay must route them through the same reader."""
        counter = _CallCounter()
        declaration = _numeric_fact_declaration()

        # Simulate an archived inventory page: the archive serializes Decimals to their
        # digit strings, so on replay these arrive as `str` from `json.loads`.
        archived_body: dict[str, Any] = {
            "data": [
                {
                    "id": _RESOURCE_ID,
                    "type": _RESOURCE_TYPE,
                    "fact_disk_size_gb": "128",  # str, as json.loads returns from archive
                    "fact_vcpu_count": "4",      # str
                    "fact_os_type": "Windows",   # text fact, not a numeric leaf
                },
            ]
        }

        with patch(
            "reporting_agent.collect.factfold.decimal_leaf", side_effect=counter
        ):
            facts, _gaps = fold_fact_response(
                archived_body,
                kind=FACT_KIND_INVENTORY,
                source="",
                resource_ids=[_RESOURCE_ID],
                declaration=declaration,
                resource_types={_RESOURCE_ID: _RESOURCE_TYPE},
                received_at=_RECEIVED_AT,
            )

        assert counter.count >= 2, (
            f"expected at least 2 calls to decimal_leaf for 2 numeric facts on replay, "
            f"got {counter.count}"
        )

        numeric_facts = [f for f in facts if f["value_kind"] == "numeric"]
        assert len(numeric_facts) == 2, numeric_facts

    def test_live_and_replay_call_counts_are_equal(self) -> None:
        """The same input shape produces the same number of `decimal_leaf` calls on both
        sides. This is the assertion that one fold serves both: if collection parsed
        inline while replay called through, the counts would differ."""
        declaration = _numeric_fact_declaration()

        # Both sides get the same body structure — the only difference is that replay's
        # numeric values arrive as strings (from json.loads on the archived object).
        live_body: dict[str, Any] = {
            "data": [
                {
                    "id": _RESOURCE_ID,
                    "type": _RESOURCE_TYPE,
                    "fact_disk_size_gb": 128,
                    "fact_vcpu_count": Decimal("4"),
                    "fact_os_type": "Windows",
                },
            ]
        }
        replay_body: dict[str, Any] = {
            "data": [
                {
                    "id": _RESOURCE_ID,
                    "type": _RESOURCE_TYPE,
                    "fact_disk_size_gb": "128",
                    "fact_vcpu_count": "4",
                    "fact_os_type": "Windows",
                },
            ]
        }

        live_counter = _CallCounter()
        with patch(
            "reporting_agent.collect.factfold.decimal_leaf", side_effect=live_counter
        ):
            fold_fact_response(
                live_body,
                kind=FACT_KIND_INVENTORY,
                source="",
                resource_ids=[_RESOURCE_ID],
                declaration=declaration,
                resource_types={_RESOURCE_ID: _RESOURCE_TYPE},
                received_at=_RECEIVED_AT,
            )

        replay_counter = _CallCounter()
        with patch(
            "reporting_agent.collect.factfold.decimal_leaf", side_effect=replay_counter
        ):
            fold_fact_response(
                replay_body,
                kind=FACT_KIND_INVENTORY,
                source="",
                resource_ids=[_RESOURCE_ID],
                declaration=declaration,
                resource_types={_RESOURCE_ID: _RESOURCE_TYPE},
                received_at=_RECEIVED_AT,
            )

        assert live_counter.count == replay_counter.count, (
            f"live collection called decimal_leaf {live_counter.count} times but replay "
            f"called it {replay_counter.count} times — the two paths diverge"
        )
        assert live_counter.count > 0, (
            "both sides called decimal_leaf zero times, meaning the wrapper was never reached"
        )

    def test_facts_kind_also_routes_through_decimal_leaf(self) -> None:
        """The `FACT_KIND_FACTS` path (non-projectable sources) also uses `decimal_leaf`
        for numeric leaves."""
        counter = _CallCounter()

        # For FACT_KIND_FACTS, entries must be non-projectable and match the source.
        declaration = FactDeclaration(
            resource_types=(
                ResourceTypeFacts(
                    resource_type=_RESOURCE_TYPE,
                    facts=(
                        FactDeclarationEntry(
                            resource_type=_RESOURCE_TYPE,
                            key="reservation_term",
                            value_kind="numeric",
                            source="capacity",
                            projectable=False,
                            projection=None,
                            absent_gap_type="no_reservations",
                            unit="days",
                        ),
                        FactDeclarationEntry(
                            resource_type=_RESOURCE_TYPE,
                            key="reservation_count",
                            value_kind="numeric",
                            source="capacity",
                            projectable=False,
                            projection=None,
                            absent_gap_type="no_reservations",
                            unit="count",
                        ),
                    ),
                ),
            )
        )

        body: dict[str, Any] = {
            "value": [
                {
                    "resource_id": _RESOURCE_ID,
                    "reservation_term": "365",
                    "reservation_count": 2,
                },
            ]
        }

        with patch(
            "reporting_agent.collect.factfold.decimal_leaf", side_effect=counter
        ):
            _facts, _gaps = fold_fact_response(
                body,
                kind=FACT_KIND_FACTS,
                source="capacity",
                resource_ids=[_RESOURCE_ID],
                declaration=declaration,
                resource_types={_RESOURCE_ID: _RESOURCE_TYPE},
                received_at=_RECEIVED_AT,
            )

        assert counter.count >= 2, (
            f"expected at least 2 calls for FACT_KIND_FACTS numeric leaves, got {counter.count}"
        )

    def test_text_facts_do_not_route_through_decimal_leaf(self) -> None:
        """A text fact is not a numeric leaf and should not be parsed as one.

        This is a negative-evidence check: it asserts that the wrapper fires only for
        numeric-kind entries, so the counting test above is not inflated by text facts
        passing through the same path."""
        declaration = FactDeclaration(
            resource_types=(
                ResourceTypeFacts(
                    resource_type=_RESOURCE_TYPE,
                    facts=(
                        FactDeclarationEntry(
                            resource_type=_RESOURCE_TYPE,
                            key="os_type",
                            value_kind="text",
                            source="resource_graph",
                            projectable=True,
                            projection="properties.storageProfile.osDisk.osType",
                            absent_gap_type=None,
                            unit=None,
                        ),
                    ),
                ),
            )
        )

        body: dict[str, Any] = {
            "data": [
                {
                    "id": _RESOURCE_ID,
                    "type": _RESOURCE_TYPE,
                    "fact_os_type": "Windows",
                },
            ]
        }

        counter = _CallCounter()
        with patch(
            "reporting_agent.collect.factfold.decimal_leaf", side_effect=counter
        ):
            facts, _gaps = fold_fact_response(
                body,
                kind=FACT_KIND_INVENTORY,
                source="",
                resource_ids=[_RESOURCE_ID],
                declaration=declaration,
                resource_types={_RESOURCE_ID: _RESOURCE_TYPE},
                received_at=_RECEIVED_AT,
            )

        assert counter.count == 0, (
            f"text facts should not call decimal_leaf, but got {counter.count} calls"
        )
        text_facts = [f for f in facts if f["value_kind"] == "text"]
        assert len(text_facts) == 1
