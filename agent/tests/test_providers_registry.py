"""Unit tests for the provider registry (Req 18.4).

The runtime names a provider by id, so what these assert is that the id -> factory
mapping is the only coupling: an unknown id fails loudly, a duplicate registration fails
rather than shadowing, and a lazy target is imported on first build rather than at import
of the registry — which is what keeps the Azure SDK out of a `collect/` unit test.
"""

from __future__ import annotations

import os
import subprocess
import sys
from collections.abc import Iterator, Mapping
from pathlib import Path

import pytest

from reporting_agent.providers import registry
from reporting_agent.providers.base import (
    Capabilities,
    CollectRequest,
    CollectResult,
    DiscoverResult,
    PlainData,
    Provider,
    ScopeSpec,
)


class StubProvider:
    def __init__(self, context: Mapping[str, PlainData]) -> None:
        self.context = context

    async def discover(self, scope: ScopeSpec) -> DiscoverResult:
        return {"resources": [], "gaps": []}

    async def collect(self, request: CollectRequest) -> CollectResult:
        return {"statistics": {}, "gaps": []}

    def capabilities(self) -> Capabilities:
        return {
            "resource_types": [],
            "metrics": {},
            "grains": ["PT1H"],
            "fidelity_tiers": ["baseline"],
        }


def build_stub(context: Mapping[str, PlainData]) -> Provider:
    return StubProvider(context)


@pytest.fixture(autouse=True)
def restore_registry() -> Iterator[None]:
    """Leave the process-wide registry exactly as it was found."""
    before = registry.provider_ids()
    yield
    for provider_id in registry.provider_ids():
        if provider_id not in before:
            registry.unregister(provider_id)
    assert registry.provider_ids() == before


def test_a_registered_factory_builds_a_provider_from_the_invocation_context() -> None:
    registry.register("stub", build_stub)
    context: dict[str, PlainData] = {"actor_id": "user_1", "subscription_id": "3f2b"}

    provider = registry.build("stub", context)

    assert isinstance(provider, Provider)
    assert isinstance(provider, StubProvider)
    assert provider.context == context


def test_two_builds_of_one_id_return_distinct_provider_instances() -> None:
    registry.register("stub", build_stub)

    first = registry.build("stub", {"actor_id": "user_1"})
    second = registry.build("stub", {"actor_id": "user_2"})

    # One provider per invocation: a provider must never carry one customer's
    # credential into another customer's run.
    assert first is not second


def test_an_unknown_provider_id_raises() -> None:
    with pytest.raises(registry.UnknownProviderError):
        registry.get_factory("gcp")

    with pytest.raises(registry.UnknownProviderError):
        registry.build("gcp", {})


def test_a_duplicate_registration_raises_rather_than_shadowing() -> None:
    registry.register("stub", build_stub)

    def other(context: Mapping[str, PlainData]) -> Provider:
        raise AssertionError("this factory must never be reachable")

    with pytest.raises(ValueError, match="already registered"):
        registry.register("stub", other)
    with pytest.raises(ValueError, match="already registered"):
        registry.register_lazy("stub", "decimal:Decimal")

    assert registry.get_factory("stub") is build_stub


def test_replace_overrides_deliberately() -> None:
    registry.register("stub", build_stub)

    def replacement(context: Mapping[str, PlainData]) -> Provider:
        return StubProvider(context)

    registry.register("stub", replacement, replace=True)

    assert registry.get_factory("stub") is replacement


def test_registration_validates_its_inputs() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        registry.register("", build_stub)
    with pytest.raises(ValueError, match="non-empty"):
        registry.register("   ", build_stub)
    with pytest.raises(TypeError, match="not callable"):
        # A target string where a factory belongs — register_lazy's job, not register's.
        registry.register("stub", "reporting_agent.azure.provider")  # type: ignore[arg-type]
    with pytest.raises(ValueError, match=r"package\.module:attribute"):
        registry.register_lazy("stub", "reporting_agent.azure.provider")


def test_provider_ids_are_sorted_and_include_lazy_registrations() -> None:
    registry.register_lazy("zzz", "decimal:Decimal")
    registry.register("aaa", build_stub)

    ids = registry.provider_ids()

    assert list(ids) == sorted(ids)
    assert {"aaa", "zzz"} <= set(ids)


def test_azure_is_registered_and_still_lazy() -> None:
    """Registered by id, resolved only when built. A registry that imported
    `reporting_agent.azure.provider` eagerly would drag the Azure SDK into every test of
    `collect/`, which is exactly what the plain-data boundary exists to avoid.

    Checked in a **subprocess**, because "not yet imported" is a fact about a whole
    process rather than about this module: `tests/test_azure_provider.py` legitimately
    imports the provider and resolves the factory, and pytest runs both files in one
    interpreter, so a `sys.modules` assertion here would report the other suite's
    imports rather than the registry's own behaviour.
    """
    assert registry.AZURE_PROVIDER_ID in registry.provider_ids()

    probe = (
        "import sys;"
        "from reporting_agent.providers import registry;"
        "assert registry.AZURE_PROVIDER_ID in registry.provider_ids();"
        "assert 'reporting_agent.azure.provider' not in sys.modules;"
        "assert 'azure' not in sys.modules"
    )
    completed = subprocess.run(
        [sys.executable, "-c", probe],
        cwd=Path(__file__).resolve().parent.parent,
        env={**os.environ, "PYTHONPATH": "src"},
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert completed.returncode == 0, completed.stderr


def test_a_lazy_target_is_imported_on_first_use_and_then_cached() -> None:
    registry.register_lazy("lazy", "decimal:Decimal")

    first = registry.get_factory("lazy")
    second = registry.get_factory("lazy")

    assert first is second


def test_registering_a_missing_target_fails_only_when_it_is_built() -> None:
    # register_lazy itself must not import: an id can be registered for a module that
    # only the deployed image installs.
    registry.register_lazy("absent", "reporting_agent.nowhere.provider:build_provider")

    with pytest.raises(registry.ProviderFactoryUnavailableError, match="cannot import"):
        registry.get_factory("absent")


def test_a_lazy_target_missing_its_attribute_reports_which_attribute() -> None:
    registry.register_lazy("misnamed", "decimal:NoSuchFactory")

    with pytest.raises(
        registry.ProviderFactoryUnavailableError, match="NoSuchFactory"
    ):
        registry.get_factory("misnamed")


def test_a_non_callable_lazy_target_is_reported_as_such() -> None:
    registry.register_lazy("not_callable", "decimal:ROUND_HALF_EVEN")

    with pytest.raises(registry.ProviderFactoryUnavailableError, match="not callable"):
        registry.get_factory("not_callable")


def test_unregister_is_strict_unless_told_otherwise() -> None:
    with pytest.raises(registry.UnknownProviderError):
        registry.unregister("never-registered")

    registry.unregister("never-registered", missing_ok=True)
