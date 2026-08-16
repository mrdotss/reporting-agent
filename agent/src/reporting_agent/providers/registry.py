"""Provider id -> factory (Req 18.4).

The runtime names a provider by id and receives something satisfying
`providers.base.Provider`. Nothing outside this module knows which class implements a
given id, so adding AWS or VMware is a registration, not a caller change.

Registration is **lazy by import target**. `register_lazy("azure",
"reporting_agent.azure.provider:build_provider")` records a string; the module is
imported the first time that id is actually built. Two consequences worth stating:

* An invocation that never touches Azure never imports the Azure SDK, so a unit test of
  `collect/` pays neither the import cost nor a subscription.
* `reporting_agent.azure.provider` is a first-party module. Its first dotted segment is
  `reporting_agent`, not `azure`, so it is not an SDK import and the boundary guard
  (Req 18.5, 18.7) distinguishes the two by that segment.

A second registration of one id raises rather than shadowing the first: a provider
silently replacing another is the kind of bug that surfaces as a wrong report.
"""

from __future__ import annotations

import importlib
from collections.abc import Callable, Mapping
from typing import Final

from reporting_agent.providers.base import PlainData, Provider

__all__ = [
    "AZURE_PROVIDER_ID",
    "ProviderFactory",
    "ProviderFactoryUnavailableError",
    "UnknownProviderError",
    "build",
    "get_factory",
    "provider_ids",
    "register",
    "register_lazy",
    "unregister",
]

type ProviderFactory = Callable[..., Provider]
"""Builds a provider from one invocation's `context`, plus whatever per-run resources
that factory declares as keyword arguments.

The context is plain data — including the per-customer `tenant_id`, `client_id` and
`client_secret` — so a provider is constructed per invocation and holds nothing across
invocations (Req 19.4).

**Why `...` rather than a single positional parameter.** A real factory needs two things
the *context* cannot carry: the run's `ObjectStore` (the archive's sink) and the loaded
Metric_Catalog. Both are process- or run-scoped objects, not plain data, and both are
already held by the caller — so a factory signature that could not accept them would
force each factory to build its own, which means a second boto3 client and a second read
of the catalog file per run. The second read in particular is at odds with Req 14.12 and
Req 32.8: configuration is read once at process start and the catalog is loaded exactly
once. :func:`build` therefore forwards keyword arguments, and a factory that wants none
simply declares none.
"""

AZURE_PROVIDER_ID: Final[str] = "azure"
_AZURE_FACTORY_TARGET: Final[str] = "reporting_agent.azure.provider:build_provider"


class UnknownProviderError(KeyError):
    """No factory is registered for the requested provider id."""


class ProviderFactoryUnavailableError(RuntimeError):
    """A lazily registered factory target could not be imported or is not callable."""


_factories: dict[str, ProviderFactory] = {}
_lazy_targets: dict[str, str] = {}


def register(
    provider_id: str, factory: ProviderFactory, *, replace: bool = False
) -> None:
    """Register a factory under `provider_id`."""
    _check_id(provider_id)
    if not callable(factory):
        raise TypeError(f"factory for {provider_id!r} is not callable")
    _check_free(provider_id, replace=replace)
    _lazy_targets.pop(provider_id, None)
    _factories[provider_id] = factory


def register_lazy(provider_id: str, target: str, *, replace: bool = False) -> None:
    """Register an import target `"package.module:attribute"` resolved on first use."""
    _check_id(provider_id)
    if ":" not in target:
        raise ValueError(
            f"factory target {target!r} for {provider_id!r} must be "
            f'"package.module:attribute"'
        )
    _check_free(provider_id, replace=replace)
    _factories.pop(provider_id, None)
    _lazy_targets[provider_id] = target


def unregister(provider_id: str, *, missing_ok: bool = False) -> None:
    """Remove a registration. Present so a test can restore the registry it changed."""
    removed = _factories.pop(provider_id, None) is not None
    removed = _lazy_targets.pop(provider_id, None) is not None or removed
    if not removed and not missing_ok:
        raise UnknownProviderError(provider_id)


def provider_ids() -> tuple[str, ...]:
    """Every registered provider id, sorted, whether resolved or still lazy."""
    return tuple(sorted(set(_factories) | set(_lazy_targets)))


def get_factory(provider_id: str) -> ProviderFactory:
    """The factory for `provider_id`, importing a lazy target on first use."""
    factory = _factories.get(provider_id)
    if factory is not None:
        return factory
    target = _lazy_targets.get(provider_id)
    if target is None:
        raise UnknownProviderError(provider_id)
    factory = _resolve(provider_id, target)
    _factories[provider_id] = factory
    return factory


def build(provider_id: str, context: Mapping[str, PlainData], **options: object) -> Provider:
    """Build a provider for one invocation.

    `options` are forwarded to the factory as keyword arguments — the run's `object_store`
    and the loaded `catalog`, for the factory that declares them. A factory declaring
    neither is called with the context alone, so passing an option a factory does not
    accept is a `TypeError` at the call site rather than a silently ignored argument.
    """
    return get_factory(provider_id)(context, **options)


def _resolve(provider_id: str, target: str) -> ProviderFactory:
    module_name, _, attribute = target.partition(":")
    try:
        module = importlib.import_module(module_name)
    except ImportError as exc:  # not swallowed: the id is registered, so this is a bug
        raise ProviderFactoryUnavailableError(
            f"provider {provider_id!r}: cannot import {module_name!r}"
        ) from exc
    try:
        factory = getattr(module, attribute)
    except AttributeError as exc:
        raise ProviderFactoryUnavailableError(
            f"provider {provider_id!r}: {module_name!r} has no attribute {attribute!r}"
        ) from exc
    if not callable(factory):
        raise ProviderFactoryUnavailableError(
            f"provider {provider_id!r}: {target!r} is not callable"
        )
    return factory


def _check_id(provider_id: str) -> None:
    if not isinstance(provider_id, str) or not provider_id.strip():
        raise ValueError("a provider id must be a non-empty string")


def _check_free(provider_id: str, *, replace: bool) -> None:
    if replace:
        return
    if provider_id in _factories or provider_id in _lazy_targets:
        raise ValueError(
            f"provider id {provider_id!r} is already registered; "
            f"pass replace=True to override it deliberately"
        )


register_lazy(AZURE_PROVIDER_ID, _AZURE_FACTORY_TARGET)
