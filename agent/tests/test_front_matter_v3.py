"""Task 4.1 — `front_matter` at schema_version 3 (Req 12.1, 12.3, 12.4, 12.5, 12.6,
12.7, 14.1-14.4).

Mirrors `app/lib/templates/front-matter-v3.test.ts`. The shared JSON fixture corpus's
`accept-schema-version-3-minimal.json` is deliberately minimal — no `distribution`, no
`confidentiality_notice_id` — so it does not exercise any of the branches this task
adds; this file builds its own minimal valid v3 definition and targets exactly the
new branches: `distribution` as rows, `confidentiality_notice_id` becoming
Brand-only, and the approver `company` / `signature_key` fields.
"""

from __future__ import annotations

import copy
from typing import Any

from reporting_agent.compile.definition import collect_definition_issues


def _valid_v3_definition() -> dict[str, Any]:
    return {
        "schema_version": 3,
        "identity": {"name": "Test v3", "language": "en"},
        "provider": "azure",
        "sections": [
            {
                "id": "sec_vm",
                "type": "vm_utilization",
                "selection": {
                    "resource_types": ["Microsoft.Compute/virtualMachines"],
                    "resource_groups": [],
                    "tag_filters": [],
                    "top_n": None,
                    "sort": None,
                },
                "metrics": [{"metric": "Percentage CPU", "statistic": "avg"}],
                "presentation": "chart_and_table",
            }
        ],
        "period": {"kind": "last_full_month"},
        "design": {
            "preset": "editorial",
            "accent_color": "oklch(0.52 0.105 223)",
            "density": "normal",
            "table_style": "hairline",
            "page_size": "A4",
            "number_format": {
                "decimal_places": 1,
                "group_thousands": True,
                "decimal_separator": ".",
                "grouping_separator": ",",
            },
            "cover_page": True,
            "logo": None,
        },
        "front_matter": {
            "cover": {"subtitle": "Test"},
            "document_control": {
                "document_name": "Test",
                "document_number_pattern": "RPT-{year}{month}-{run}",
                "approvers": [
                    {"role": "author", "name": "A"},
                    {"role": "reviewer", "name": "B"},
                    {"role": "approver", "name": "C"},
                    {"role": "recipient", "name": "D"},
                ],
            },
            "toc": {"enabled": True, "max_level": 3},
        },
    }


def _valid_v2_definition() -> dict[str, Any]:
    return {
        "schema_version": 2,
        "identity": {
            "name": "Monthly utilization",
            "description": "",
            "report_title": "Monthly report",
            "language": "en",
        },
        "scope": {
            "resource_types": ["Microsoft.Compute/virtualMachines"],
            "tag_filters": [],
            "resource_groups": [],
            "top_n": None,
            "sort": None,
        },
        "period": {"kind": "last_full_month"},
        "metrics": {},
        "blocks": [],
        "design": {
            "preset": "editorial",
            "accent_color": "oklch(0.52 0.105 223)",
            "density": "normal",
            "table_style": "hairline",
            "page_size": "A4",
            "number_format": {"decimal_places": 1, "group_thousands": True},
            "cover_page": True,
            "logo": None,
        },
        "front_matter": {"cover": {}, "document_control": {}, "toc": {}},
    }


def _paths(issues: list[Any]) -> list[str]:
    return [".".join(str(part) for part in issue.path) for issue in issues]


def test_the_minimal_v3_fixture_itself_validates() -> None:
    assert collect_definition_issues(_valid_v3_definition()) == []


class TestCustomerNameAtV3:
    """Req 12.2 — customer_name moves onto identity at v3, additive."""

    def test_v3_accepts_identity_customer_name(self) -> None:
        definition = _valid_v3_definition()
        definition["identity"]["customer_name"] = "Contoso Ltd"
        assert collect_definition_issues(definition) == []

    def test_v3_customer_name_is_optional(self) -> None:
        # Draft mode must allow saving a profile before naming a customer,
        # exactly as report_title is optional at every version.
        definition = _valid_v3_definition()
        assert "customer_name" not in definition["identity"]
        assert collect_definition_issues(definition) == []

    def test_v3_rejects_an_over_long_customer_name(self) -> None:
        definition = _valid_v3_definition()
        definition["identity"]["customer_name"] = "x" * 201
        issues = collect_definition_issues(definition)
        assert "identity.customer_name" in _paths(issues)

    def test_v2_rejects_customer_name_as_an_unrecognized_field(self) -> None:
        definition = _valid_v2_definition()
        definition["identity"]["customer_name"] = "Contoso Ltd"
        issues = collect_definition_issues(definition)
        assert "identity.customer_name" in _paths(issues)


class TestDistributionBecomesRowsAtV3:
    """Req 12.6 — rows at v3, unchanged string at v1/v2."""

    def test_v3_accepts_recipient_company_note_rows(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["distribution"] = [
            {"recipient": "Ops team", "company": "Contoso", "note": "cc finance"},
            {"recipient": "CTO"},
        ]
        assert collect_definition_issues(definition) == []

    def test_v3_rejects_a_string_distribution(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["distribution"] = (
            "Ops team, CTO"
        )
        issues = collect_definition_issues(definition)
        assert "front_matter.document_control.distribution" in _paths(issues)

    def test_v3_distribution_row_requires_non_empty_recipient(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["distribution"] = [
            {"company": "Contoso", "note": "no recipient"}
        ]
        issues = collect_definition_issues(definition)
        assert "front_matter.document_control.distribution.0.recipient" in _paths(
            issues
        )

    def test_v3_distribution_row_rejects_unrecognized_field(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["distribution"] = [
            {"recipient": "Ops", "phone": "555-0100"}
        ]
        issues = collect_definition_issues(definition)
        assert "front_matter.document_control.distribution.0.phone" in _paths(issues)

    def test_more_than_50_rows_is_rejected(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["distribution"] = [
            {"recipient": f"Recipient {i}"} for i in range(51)
        ]
        issues = collect_definition_issues(definition)
        assert "front_matter.document_control.distribution" in _paths(issues)

    def test_empty_distribution_array_is_accepted(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["distribution"] = []
        assert collect_definition_issues(definition) == []

    def test_v2_still_accepts_the_free_text_string_form_unchanged(self) -> None:
        definition = _valid_v2_definition()
        definition["front_matter"]["document_control"]["distribution"] = (
            "Ops team, CTO"
        )
        assert collect_definition_issues(definition) == []


class TestConfidentialityIsBrandInheritedAtV3:
    """Req 12.7 — at v3 the notice is prose on the profile, and the id is not a field."""

    def test_v3_rejects_confidentiality_notice_id(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"][
            "confidentiality_notice_id"
        ] = "doc.confidentiality.default"

        issues = collect_definition_issues(definition)
        assert (
            "front_matter.document_control.confidentiality_notice_id"
            in _paths(issues)
        )
        # The message has to say where the notice *does* go. It used to point at a Brand
        # page, which no longer exists — an error naming a place the reader cannot open is
        # worse than no explanation.
        assert any(
            "document_control.confidentiality_notice" in issue.message for issue in issues
        )

    def test_v2_still_accepts_and_validates_confidentiality_notice_id(self) -> None:
        definition = _valid_v2_definition()
        definition["front_matter"]["document_control"][
            "confidentiality_notice_id"
        ] = "doc.confidentiality.default"
        assert collect_definition_issues(definition) == []

        bad_definition = copy.deepcopy(definition)
        bad_definition["front_matter"]["document_control"][
            "confidentiality_notice_id"
        ] = "not-a-catalog-id"
        issues = collect_definition_issues(bad_definition)
        assert (
            "front_matter.document_control.confidentiality_notice_id"
            in _paths(issues)
        )


class TestApproverCompanyAndSignatureKeyAreAdditiveAtV3:
    """Req 12.4 — new fields at v3, still refused at v1/v2."""

    def test_v3_approver_accepts_company_and_signature_key(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["approvers"] = [
            {
                "role": "author",
                "name": "Alice",
                "title": "Lead Consultant",
                "company": "Contoso Consulting",
                "signature_key": "signatures/u123/author.png",
            }
        ]
        assert collect_definition_issues(definition) == []

    def test_v3_approver_accepts_null_signature_key(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["approvers"] = [
            {"role": "author", "name": "Alice", "signature_key": None}
        ]
        assert collect_definition_issues(definition) == []

    def test_v2_approver_rejects_company_and_signature_key(self) -> None:
        definition = _valid_v2_definition()
        definition["front_matter"]["document_control"]["approvers"] = [
            {"role": "author", "name": "Alice", "company": "Contoso"}
        ]
        issues = collect_definition_issues(definition)
        assert (
            "front_matter.document_control.approvers.0.company" in _paths(issues)
        )

    def test_company_is_bounded_the_same_as_title(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["approvers"] = [
            {"role": "author", "name": "Alice", "company": "x" * 121}
        ]
        issues = collect_definition_issues(definition)
        assert (
            "front_matter.document_control.approvers.0.company" in _paths(issues)
        )

    def test_empty_string_signature_key_is_rejected(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["approvers"] = [
            {"role": "author", "name": "Alice", "signature_key": ""}
        ]
        issues = collect_definition_issues(definition)
        assert (
            "front_matter.document_control.approvers.0.signature_key"
            in _paths(issues)
        )

    def test_signature_key_over_the_length_ceiling_is_rejected(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["approvers"] = [
            {"role": "author", "name": "Alice", "signature_key": "s" * 513}
        ]
        issues = collect_definition_issues(definition)
        assert (
            "front_matter.document_control.approvers.0.signature_key"
            in _paths(issues)
        )

    def test_the_closed_four_role_set_is_still_enforced_at_v3(self) -> None:
        definition = _valid_v3_definition()
        definition["front_matter"]["document_control"]["approvers"] = [
            {"role": "author", "name": "A"},
            {"role": "reviewer", "name": "B"},
            {"role": "approver", "name": "C"},
            {"role": "recipient", "name": "D"},
            {"role": "witness", "name": "E"},
        ]
        issues = collect_definition_issues(definition)
        assert any(
            ".".join(str(p) for p in issue.path).startswith(
                "front_matter.document_control.approvers"
            )
            for issue in issues
        )
