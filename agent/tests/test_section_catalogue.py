"""Tests for the section catalogue and its loader validation (task 3.1).

Covers:
- The shipped catalogue loads and declares 15 entries
- Each rejection the loader enforces, naming the specific malformed entry
- Both halves load the same file and agree on entry set, numbers, groups, positions,
  fixed order, and preset metric sets
- Mutation checks on at least two rejections
"""

from __future__ import annotations

import copy
import json
from pathlib import Path

import pytest

from reporting_agent.catalog.loader import (
    DECLARED_SECTION_GROUPS,
    DECLARED_SECTION_POSITIONS,
    DEFAULT_SECTIONS_PATH,
    FIXED_SECTION_ORDER,
    LoadedSectionCatalogue,
    load_catalog,
    load_section_catalogue,
)
from reporting_agent.errors import CatalogUnusableError


@pytest.fixture()
def catalog():
    """The full loaded metric+fact catalog."""
    return load_catalog()


@pytest.fixture()
def sections(catalog):
    """The loaded section catalogue."""
    return load_section_catalogue(loaded_catalog=catalog)


@pytest.fixture()
def raw_sections():
    """The raw JSON of the sections catalogue."""
    return json.loads(DEFAULT_SECTIONS_PATH.read_text(encoding="utf-8"))


# --- structural correctness of the shipped catalogue -------------------------


class TestShippedCatalogue:
    """The shipped catalogue loads and declares the expected entries."""

    def test_loads_successfully(self, sections: LoadedSectionCatalogue):
        assert sections.catalogue_version == "1.0.0"

    def test_fifteen_entries(self, sections: LoadedSectionCatalogue):
        assert len(sections.entries) == 15

    def test_canonical_numbers_unique(self, sections: LoadedSectionCatalogue):
        numbers = sections.numbers
        assert len(numbers) == len(set(numbers))
        assert numbers == tuple(range(1, 16))

    def test_keys_unique(self, sections: LoadedSectionCatalogue):
        keys = sections.keys
        assert len(keys) == len(set(keys))

    def test_groups_are_declared(self, sections: LoadedSectionCatalogue):
        for entry in sections.entries:
            assert entry.group in DECLARED_SECTION_GROUPS

    def test_positions_are_declared(self, sections: LoadedSectionCatalogue):
        for entry in sections.entries:
            assert entry.position in DECLARED_SECTION_POSITIONS

    def test_fixed_entries_in_declared_order(self, sections: LoadedSectionCatalogue):
        fixed = sections.fixed_entries
        assert tuple(e.key for e in fixed) == FIXED_SECTION_ORDER

    def test_exactly_one_always_entry(self, sections: LoadedSectionCatalogue):
        always = [e for e in sections.entries if e.position == "always"]
        assert len(always) == 1
        assert always[0].key == "coverage_and_verification"

    def test_section_4_three_subsections(self, sections: LoadedSectionCatalogue):
        """Section 4 declares its 4.1/4.2/4.3 sub-sections as three groups
        within ONE entry, so they cannot be selected apart."""
        vm = sections.by_key("virtual_machines")
        assert vm is not None
        # Three heading + resource_table groups → at least 6 expansion blocks
        assert len(vm.expands_to) >= 6
        # All are per=section (the whole VM section, not per-resource for inventory)
        for block in vm.expands_to:
            assert block.per == "section"

    def test_section_6_notes_default_rule_omission(
        self, raw_sections: dict
    ):
        """Section 6 declares that Azure default rules at priority >= 65000 are omitted."""
        azure_sections = raw_sections["providers"]["azure"]["sections"]
        nsg = next(s for s in azure_sections if s["key"] == "network_security_groups")
        assert "notes" in nsg
        assert "65000" in nsg["notes"]
        # The omit config is also in the expands_to
        expansion = nsg["expands_to"]
        table_block = next(b for b in expansion if b["block"] == "resource_table")
        assert table_block["config"]["omit_default_rules_above"] == 65000

    def test_section_9_optional_and_prior_verified(
        self, sections: LoadedSectionCatalogue
    ):
        """Section 9 is optional and draws only on prior runs that passed verification."""
        hist = sections.by_key("historical_vm_utilization")
        assert hist is not None
        assert hist.optional is True
        assert hist.draws_from_prior_verified_runs is True

    def test_declared_inputs_for_the_four_phase_5_sections(
        self, sections: LoadedSectionCatalogue
    ):
        """Sections 3, 5, 6 and 14 declare the resource types/fact sources their own
        collectors supply (tasks 6.1-6.4). Offerability against a real scan is computed
        from these declarations plus `COLLECTED_FACT_SOURCES` (task 6.5) — this test only
        asserts the declaration itself, not the run-time offerability decision, which
        lives in `azure/facts.py`'s `_ADVISOR_*` constants and the app's
        `lib/profiles/offerability.ts`."""
        vnet = sections.by_key("virtual_network")
        assert vnet is not None
        assert "Microsoft.Network/virtualNetworks" in vnet.needs_resource_types

        pip = sections.by_key("public_ip_addresses")
        assert pip is not None
        assert "Microsoft.Network/publicIPAddresses" in pip.needs_resource_types

        nsg = sections.by_key("network_security_groups")
        assert nsg is not None
        assert "Microsoft.Network/networkSecurityGroups" in nsg.needs_resource_types

        recs = sections.by_key("recommendations")
        assert recs is not None
        assert "advisor" in recs.needs_fact_sources

    def test_incident_report_is_author_filled(
        self, sections: LoadedSectionCatalogue
    ):
        """Section 13 is author-filled and never agent-populated."""
        incident = sections.by_key("incident_report")
        assert incident is not None
        assert incident.author_filled is True

    def test_vm_utilization_presets(self, sections: LoadedSectionCatalogue):
        """Section 8 declares standard_utilization, capacity_planning and everything presets."""
        vm_util = sections.by_key("vm_utilization")
        assert vm_util is not None
        preset_names = {name for name, _ in vm_util.presets}
        assert "standard_utilization" in preset_names
        assert "capacity_planning" in preset_names
        assert "everything" in preset_names


# --- loader rejection tests --------------------------------------------------


class TestLoaderRejections:
    """Each validation rule rejects and names the specific malformed entry."""

    def _mutate_and_load(self, raw: dict, catalog=None) -> str:
        """Write the mutated raw to a temp file and try to load, returning the error."""
        import tempfile

        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False
        ) as f:
            json.dump(raw, f)
            f.flush()
            path = Path(f.name)
        try:
            load_section_catalogue(path, loaded_catalog=catalog)
            return ""
        except CatalogUnusableError as e:
            return str(e)
        finally:
            path.unlink(missing_ok=True)

    def test_reject_duplicate_number(self, raw_sections: dict, catalog):
        raw = copy.deepcopy(raw_sections)
        # Set section 2's number to 1 (duplicate)
        raw["providers"]["azure"]["sections"][1]["number"] = 1
        err = self._mutate_and_load(raw, catalog)
        assert "duplicate number" in err
        assert "resource_groups" in err

    def test_reject_duplicate_key(self, raw_sections: dict, catalog):
        raw = copy.deepcopy(raw_sections)
        # Set section 2's key to same as section 1
        raw["providers"]["azure"]["sections"][1]["key"] = "azure_subscription"
        err = self._mutate_and_load(raw, catalog)
        assert "duplicate key" in err

    def test_reject_expands_to_invalid_block(self, raw_sections: dict, catalog):
        raw = copy.deepcopy(raw_sections)
        raw["providers"]["azure"]["sections"][0]["expands_to"][0]["block"] = "nonexistent_block"
        err = self._mutate_and_load(raw, catalog)
        assert "nonexistent_block" in err
        assert "BLOCK_TYPES" in err
        assert "azure_subscription" in err

    def test_reject_fixed_out_of_order(self, raw_sections: dict, catalog):
        raw = copy.deepcopy(raw_sections)
        # Swap backup_report and incident_report in the JSON
        sections = raw["providers"]["azure"]["sections"]
        idx_backup = next(i for i, s in enumerate(sections) if s["key"] == "backup_report")
        idx_incident = next(i for i, s in enumerate(sections) if s["key"] == "incident_report")
        sections[idx_backup], sections[idx_incident] = sections[idx_incident], sections[idx_backup]
        err = self._mutate_and_load(raw, catalog)
        assert "fixed entry" in err

    def test_reject_more_than_one_always(self, raw_sections: dict, catalog):
        raw = copy.deepcopy(raw_sections)
        # Change a free entry to always
        raw["providers"]["azure"]["sections"][0]["position"] = "always"
        err = self._mutate_and_load(raw, catalog)
        assert "more than one" in err
        assert "always" in err

    def test_reject_preset_naming_undeclared_metric(self, raw_sections: dict, catalog):
        raw = copy.deepcopy(raw_sections)
        # Add a preset with a metric the catalogue does not declare
        vm_util_idx = next(
            i for i, s in enumerate(raw["providers"]["azure"]["sections"])
            if s["key"] == "vm_utilization"
        )
        raw["providers"]["azure"]["sections"][vm_util_idx]["presets"]["bad"] = [
            {"metric": "Nonexistent Metric XYZ", "statistic": "avg"}
        ]
        err = self._mutate_and_load(raw, catalog)
        assert "Nonexistent Metric XYZ" in err
        assert "vm_utilization" in err

    def test_reject_invalid_group(self, raw_sections: dict, catalog):
        raw = copy.deepcopy(raw_sections)
        raw["providers"]["azure"]["sections"][0]["group"] = "invalid_group"
        err = self._mutate_and_load(raw, catalog)
        assert "group" in err
        assert "invalid_group" in err

    def test_reject_invalid_position(self, raw_sections: dict, catalog):
        raw = copy.deepcopy(raw_sections)
        raw["providers"]["azure"]["sections"][0]["position"] = "invalid_pos"
        err = self._mutate_and_load(raw, catalog)
        assert "position" in err
        assert "invalid_pos" in err

    def test_reject_invalid_per_in_expands_to(self, raw_sections: dict, catalog):
        raw = copy.deepcopy(raw_sections)
        raw["providers"]["azure"]["sections"][0]["expands_to"][0]["per"] = "invalid"
        err = self._mutate_and_load(raw, catalog)
        assert "per" in err
        assert "azure_subscription" in err


# --- mutation checks ---------------------------------------------------------


class TestMutationChecks:
    """Mutation-check at least two rejections: remove the check and the test fails."""

    def test_mutation_duplicate_number_is_caught(self, raw_sections: dict, catalog):
        """If we did NOT check for duplicate numbers, this duplicate would load fine."""
        raw = copy.deepcopy(raw_sections)
        raw["providers"]["azure"]["sections"][1]["number"] = 1
        import tempfile

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(raw, f)
            f.flush()
            path = Path(f.name)
        try:
            with pytest.raises(CatalogUnusableError, match="duplicate number"):
                load_section_catalogue(path, loaded_catalog=catalog)
        finally:
            path.unlink(missing_ok=True)

    def test_mutation_fixed_order_is_caught(self, raw_sections: dict, catalog):
        """If we did NOT enforce fixed order, swapped entries would load fine."""
        raw = copy.deepcopy(raw_sections)
        sections = raw["providers"]["azure"]["sections"]
        idx_backup = next(i for i, s in enumerate(sections) if s["key"] == "backup_report")
        idx_incident = next(i for i, s in enumerate(sections) if s["key"] == "incident_report")
        sections[idx_backup], sections[idx_incident] = sections[idx_incident], sections[idx_backup]
        import tempfile

        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            json.dump(raw, f)
            f.flush()
            path = Path(f.name)
        try:
            with pytest.raises(CatalogUnusableError, match="fixed entry"):
                load_section_catalogue(path, loaded_catalog=catalog)
        finally:
            path.unlink(missing_ok=True)


# --- cross-half agreement ----------------------------------------------------


class TestCrossHalfAgreement:
    """Both halves load the same file and agree on entry set, canonical numbers,
    declared types, fact sources, fixed positions and preset metric sets."""

    def test_same_file_path(self):
        """The app imports from the same path the agent reads."""
        # The app's sections.ts imports from
        # ../../../agent/src/reporting_agent/catalog/sections.v1.json
        # relative to app/lib/profiles/sections.ts
        app_import_path = (
            Path(__file__).resolve().parents[2]
            / "app"
            / "lib"
            / "profiles"
            / ".."
            / ".."
            / ".."
            / "agent"
            / "src"
            / "reporting_agent"
            / "catalog"
            / "sections.v1.json"
        ).resolve()
        assert app_import_path == DEFAULT_SECTIONS_PATH

    def test_raw_json_is_valid(self, raw_sections: dict):
        """The raw JSON file parses to what both halves read."""
        assert raw_sections["catalogue_version"] == "1.0.0"
        sections = raw_sections["providers"]["azure"]["sections"]
        assert len(sections) == 15

    def test_entry_set_agreement(self, sections: LoadedSectionCatalogue, raw_sections: dict):
        """Keys from the loader match keys in the raw JSON."""
        raw_keys = tuple(
            s["key"] for s in raw_sections["providers"]["azure"]["sections"]
        )
        assert sections.keys == raw_keys

    def test_numbers_agreement(self, sections: LoadedSectionCatalogue, raw_sections: dict):
        """Numbers from the loader match the raw JSON."""
        raw_numbers = tuple(
            s["number"] for s in raw_sections["providers"]["azure"]["sections"]
        )
        assert sections.numbers == raw_numbers

    def test_fixed_positions_agreement(self, sections: LoadedSectionCatalogue):
        """Fixed entries in the loader match FIXED_SECTION_ORDER."""
        fixed_keys = tuple(e.key for e in sections.fixed_entries)
        assert fixed_keys == FIXED_SECTION_ORDER

    def test_preset_metric_sets(self, sections: LoadedSectionCatalogue, catalog):
        """Presets that name explicit metrics are validated against the metric catalogue."""
        vm_util = sections.by_key("vm_utilization")
        assert vm_util is not None
        for preset_name, preset_value in vm_util.presets:
            if preset_value == "*":
                continue
            # Each metric in the preset must exist in the VM metric catalogue
            rt_catalog = catalog.for_resource_type("Microsoft.Compute/virtualMachines")
            assert rt_catalog is not None
            all_metric_names = {m.name for m in rt_catalog.metrics} | {
                d.statistic_id for d in rt_catalog.derived
            }
            for metric_name, _ in preset_value:
                assert metric_name in all_metric_names, (
                    f"preset {preset_name!r} references metric {metric_name!r} "
                    f"not in VM catalogue"
                )
