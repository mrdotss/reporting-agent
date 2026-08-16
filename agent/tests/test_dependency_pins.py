"""Guards for the pins whose *shape* is load-bearing: Azure Monitor, and rendering.

Two independent guards live here because they fail the same way — an `ImportError` or a
silently wrong number in a deployed run, rather than a red suite.

**Part one — the three-package Azure Monitor pin.**
`azure-monitor-query` 2.0.0 is **logs-only**: it removed both `MetricsClient` and
`MetricsQueryClient`. The metrics surface therefore lives in two other packages, and
all three must be installed together:

| package | provides | used for |
|---|---|---|
| `azure-monitor-querymetrics` | `MetricsClient.query_resources` | batch metric values, regional data plane |
| `azure-mgmt-monitor` | `MonitorManagementClient` | metric definitions + the per-resource fallback |
| `azure-monitor-query` | `LogsQueryClient` | the enhanced tier ONLY |

Installing a subset raises an `ImportError` that reads like a version-pin problem and
is not. The Dockerfile asserts the split at build time; these tests assert it in the
suite, so a wrong pin fails here rather than in a deployed run (Req 17.5, 17.6, 17.10).

The AST scan closes the other half: no module under `src/reporting_agent/` may import
`MetricsClient` from `azure.monitor.query`, and none may import `MetricsQueryClient`
from anywhere, because that name exists in **no** pinned package (Req 17.7).

**Part two — the rendering pins, and two distributions that must never be installed.**
`python-docx` emits the `.docx` from the compiled document AST (Req 20.1), `pypdf`
extracts the produced `.pdf`'s text for the fidelity gate (Req 33.5), and `matplotlib`
renders the embedded chart images (Req 22.14) on the **Agg** backend and no other.

The backend is asserted rather than assumed, and it is asserted to come from
`reporting_agent/__init__.py` — not from a fixture in this file. A test-only mechanism
would prove nothing about the image, and matplotlib resolves its backend **once**, at
first import, from `MPLBACKEND`. On a developer machine with a display this same
process resolves `tkagg` without that line, so the assertion is load-bearing rather
than tautological.

The second AST scan states the two absences as a rule (Req 20.2, 18.5):

* **`docxtpl`** — there is no template document and no placeholder to substitute. A
  substitution engine would reopen the hole the AST closes: a user-authored expression
  yields a figure with no `snapshot_path`, which the Verifier cannot trace.
* **`pandas`** — float-backed. No `float` may sit on the path from a snapshot value to
  a `formatted` string, because the snapshot hash and the ledger match both depend on
  one decimal spelling. `pyproject.toml`'s banned-api table forbids both in the editor;
  this scan is what fails CI, where ruff may not have run.
"""

from __future__ import annotations

import ast
import os
import subprocess
import sys
import tomllib
from collections.abc import Callable
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

import pytest

AGENT_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = AGENT_ROOT / "src" / "reporting_agent"
PYPROJECT = AGENT_ROOT / "pyproject.toml"

# The one canonical source for each client. A reversed import path is the mistake the
# three-package split invites, so the mapping is stated once and asserted below.
CANONICAL_SOURCES = {
    "MetricsClient": "azure.monitor.querymetrics",
    "MonitorManagementClient": "azure.mgmt.monitor",
    "LogsQueryClient": "azure.monitor.query",
}

# Exists in no pinned package at all — `azure-monitor-query` 2.0.0 removed it.
NONEXISTENT_CLIENT = "MetricsQueryClient"

REQUIRED_PINS = {
    "azure-monitor-query": "azure-monitor-query>=2,<3",
    "azure-monitor-querymetrics": "azure-monitor-querymetrics>=1,<2",
    "azure-mgmt-monitor": "azure-mgmt-monitor==7.0.0",
}

# The rendering closure, pinned exactly — a renderer that produces a byte-identical
# document across two runs cannot float its own version. `{distribution: import name}`,
# because none of the three agree on the two.
RENDER_PINS = {
    "python-docx": ("python-docx==1.2.0", "docx"),
    "pypdf": ("pypdf==6.16.1", "pypdf"),
    "matplotlib": ("matplotlib==3.11.1", "matplotlib"),
}

# Never installed, never imported. See the module docstring; both are also in
# pyproject.toml's banned-api table.
BANNED_DISTRIBUTIONS = ("docxtpl", "pandas")

# The only backend a headless container can use, and the only one that renders
# reproducibly. Set in reporting_agent/__init__.py, asserted below.
CHART_BACKEND = "Agg"
BACKEND_ENV_VAR = "MPLBACKEND"


# --------------------------------------------------------------------------- #
# Req 17.5 / 17.6 — the installed packages export what the collector imports
# --------------------------------------------------------------------------- #


def test_metrics_client_imports_from_querymetrics() -> None:
    """Batch metric values (Req 17.5)."""
    from azure.monitor.querymetrics import MetricsClient

    assert callable(MetricsClient)
    assert hasattr(MetricsClient, "query_resources")


def test_monitor_management_client_imports_from_mgmt_monitor() -> None:
    """Metric definitions and the per-resource regional fallback (Req 17.5, 17.10)."""
    from azure.mgmt.monitor import MonitorManagementClient

    assert callable(MonitorManagementClient)


def test_logs_query_client_imports_from_monitor_query() -> None:
    """The enhanced tier only (Req 17.5)."""
    from azure.monitor.query import LogsQueryClient

    assert callable(LogsQueryClient)


@pytest.mark.parametrize("name", ["MetricsClient", NONEXISTENT_CLIENT])
def test_both_metrics_clients_are_absent_from_azure_monitor_query(name: str) -> None:
    """Req 17.6 — pinning only a subset of the three fails here, not in production.

    Checked three ways because they fail independently: the attribute, the declared
    public surface, and the `from ... import` that a collector module would write.
    """
    import azure.monitor.query as monitor_query

    assert not hasattr(monitor_query, name), (
        f"azure.monitor.query unexpectedly exposes {name}; "
        f"the installed azure-monitor-query is {version('azure-monitor-query')}, "
        "and the pin requires >=2,<3, which is logs-only"
    )
    assert name not in getattr(monitor_query, "__all__", ()), (
        f"{name} appears in azure.monitor.query.__all__: {monitor_query.__all__}"
    )
    with pytest.raises(ImportError):
        exec(f"from azure.monitor.query import {name}", {})


def test_azure_monitor_query_exports_logs_clients_only() -> None:
    import azure.monitor.query as monitor_query

    exported = set(monitor_query.__all__)
    assert exported == {
        "LogsBatchQuery",
        "LogsQueryClient",
        "LogsQueryError",
        "LogsQueryPartialResult",
        "LogsQueryResult",
        "LogsQueryStatus",
        "LogsTable",
        "LogsTableRow",
        "MonitorQueryLogsClient",
    }, sorted(exported)


# --------------------------------------------------------------------------- #
# Req 17.2 / 17.3 / 17.10 — the pins themselves, and the environment matching them
# --------------------------------------------------------------------------- #


def _declared_dependencies() -> list[str]:
    with PYPROJECT.open("rb") as handle:
        return tomllib.load(handle)["project"]["dependencies"]


@pytest.mark.parametrize(("package", "pin"), sorted(REQUIRED_PINS.items()))
def test_pyproject_pins_all_three_azure_monitor_packages(package: str, pin: str) -> None:
    declared = [d.replace(" ", "") for d in _declared_dependencies()]
    assert pin in declared, (
        f"{package} must be pinned as `{pin}` in {PYPROJECT.name}; declared: {declared}"
    )


def test_installed_versions_satisfy_the_pins() -> None:
    """A drifted environment must fail here rather than at the first metrics call."""
    assert version("azure-mgmt-monitor") == "7.0.0"  # Req 17.10 — exactly 7.0.0
    assert version("azure-monitor-query").split(".")[0] == "2"  # Req 17.2
    assert version("azure-monitor-querymetrics").split(".")[0] == "1"  # Req 17.3


# --------------------------------------------------------------------------- #
# Req 17.7 — the AST scan over src/reporting_agent/
# --------------------------------------------------------------------------- #


def _source_modules() -> list[Path]:
    return sorted(SRC_ROOT.rglob("*.py"))


def _imported_names(tree: ast.AST) -> list[tuple[str | None, str, int]]:
    """Every imported name as `(module, name, lineno)`.

    `module` is the absolute dotted source for `from X import name`, and `None` for a
    plain `import a.b.c` — whose imported name is taken to be the last dotted segment —
    and for a relative `from .x import name`. Relative imports (`level > 0`) are
    package-internal by construction and can never name a pinned package, so reporting
    them as `None` keeps them out of every source-qualified predicate while still
    surfacing the bare name to the `MetricsQueryClient` check, which is deliberately
    source-agnostic.
    """
    found: list[tuple[str | None, str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            module = node.module if node.level == 0 else None
            for alias in node.names:
                found.append((module, alias.name, node.lineno))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                found.append((None, alias.name.rsplit(".", 1)[-1], node.lineno))
    return found


def _label(path: Path) -> str:
    """Agent-relative where possible; the guard-the-guard cases live under tmp_path."""
    try:
        return str(path.relative_to(AGENT_ROOT))
    except ValueError:
        return str(path)


def _offenders(
    modules: list[Path],
    predicate: Callable[[str | None, str], bool],
) -> list[str]:
    offenders: list[str] = []
    for path in modules:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        for module, name, lineno in _imported_names(tree):
            if predicate(module, name):
                source = module or "<plain import>"
                offenders.append(f"{_label(path)}:{lineno} {source} -> {name}")
    return offenders


def test_the_scan_sees_source_files() -> None:
    """A guard that passes by scanning nothing is the failure mode to rule out first."""
    modules = _source_modules()
    assert modules, f"no Python modules found under {SRC_ROOT}"
    assert SRC_ROOT.is_dir()


def test_no_module_imports_metrics_client_from_azure_monitor_query() -> None:
    """Req 17.7 — `azure-monitor-query` >=2 exports no `MetricsClient`."""
    offenders = _offenders(
        _source_modules(),
        lambda module, name: module == "azure.monitor.query" and name == "MetricsClient",
    )
    assert not offenders, (
        "MetricsClient must be imported from azure.monitor.querymetrics, "
        "not azure.monitor.query:\n  " + "\n  ".join(offenders)
    )


def test_no_module_imports_metrics_query_client_from_anywhere() -> None:
    """Req 17.7 — `MetricsQueryClient` exists in no pinned package."""
    offenders = _offenders(
        _source_modules(),
        lambda module, name: name == NONEXISTENT_CLIENT,
    )
    assert not offenders, (
        f"{NONEXISTENT_CLIENT} exists in no pinned package; batch metric values come "
        "from azure.monitor.querymetrics.MetricsClient:\n  " + "\n  ".join(offenders)
    )


@pytest.mark.parametrize(
    "source",
    [
        "from azure.monitor.query import MetricsClient",
        "from azure.monitor.query import LogsQueryClient, MetricsClient",
        "from azure.monitor.query import MetricsClient as MC",
    ],
)
def test_the_scan_detects_metrics_client_from_azure_monitor_query(
    source: str, tmp_path: Path
) -> None:
    """Guard the guard: the predicate must actually catch the pattern it forbids."""
    module = tmp_path / "offender.py"
    module.write_text(source, encoding="utf-8")
    offenders = _offenders(
        [module],
        lambda mod, name: mod == "azure.monitor.query" and name == "MetricsClient",
    )
    assert len(offenders) == 1, offenders


@pytest.mark.parametrize(
    "source",
    [
        "from azure.monitor.query import MetricsQueryClient",
        "from azure.monitor.querymetrics import MetricsQueryClient",
        "from somewhere.entirely.unrelated import MetricsQueryClient",
        "import azure.monitor.query.MetricsQueryClient",
    ],
)
def test_the_scan_detects_metrics_query_client_from_anywhere(
    source: str, tmp_path: Path
) -> None:
    module = tmp_path / "offender.py"
    module.write_text(source, encoding="utf-8")
    offenders = _offenders([module], lambda mod, name: name == NONEXISTENT_CLIENT)
    assert len(offenders) == 1, offenders


@pytest.mark.parametrize(
    "source",
    [
        "from azure.monitor.querymetrics import MetricsClient",
        "from . import MetricsClient",
        "from .querymetrics import MetricsClient",
        "from azure.mgmt.monitor import MonitorManagementClient",
        "from azure.monitor.query import LogsQueryClient",
    ],
)
def test_the_scan_permits_the_canonical_import_paths(source: str, tmp_path: Path) -> None:
    module = tmp_path / "permitted.py"
    module.write_text(source, encoding="utf-8")
    forbidden = _offenders(
        [module],
        lambda mod, name: (mod == "azure.monitor.query" and name == "MetricsClient")
        or name == NONEXISTENT_CLIENT,
    )
    assert not forbidden, forbidden


def test_canonical_sources_are_the_installed_ones() -> None:
    """Req 17.5 — the mapping this module asserts against is the real one."""
    import importlib

    for name, module_path in CANONICAL_SOURCES.items():
        assert hasattr(importlib.import_module(module_path), name), f"{module_path}.{name}"


# --------------------------------------------------------------------------- #
# Req 20.1 / 33.5 / 22.14 — the rendering closure imports and is pinned exactly
# --------------------------------------------------------------------------- #


def test_python_docx_imports_and_exposes_document() -> None:
    """Req 20.1 — the DOCX emitter, whose only source of content is the document AST."""
    from docx import Document

    assert callable(Document)


def test_pypdf_imports_and_exposes_the_reader() -> None:
    """Req 33.5 — PDF text extraction for the fidelity gate."""
    from pypdf import PdfReader

    assert callable(PdfReader)


def test_matplotlib_imports() -> None:
    """Req 22.14 — the static chart images embedded in the document."""
    import matplotlib

    assert matplotlib.__version__


@pytest.mark.parametrize(("distribution", "pin"), sorted((k, v[0]) for k, v in RENDER_PINS.items()))
def test_pyproject_pins_the_rendering_packages_exactly(distribution: str, pin: str) -> None:
    declared = [d.replace(" ", "") for d in _declared_dependencies()]
    assert pin in declared, (
        f"{distribution} must be pinned as `{pin}` in {PYPROJECT.name}; declared: {declared}"
    )


@pytest.mark.parametrize("distribution", sorted(RENDER_PINS))
def test_installed_rendering_versions_match_the_pins(distribution: str) -> None:
    """A drifted environment must fail here, not on the first rendered document."""
    expected = RENDER_PINS[distribution][0].split("==", 1)[1]
    assert version(distribution) == expected


@pytest.mark.parametrize("distribution", BANNED_DISTRIBUTIONS)
def test_the_banned_distributions_are_absent_from_the_environment(distribution: str) -> None:
    """Not installed, so an import cannot succeed even by accident (Req 20.2, 18.5)."""
    with pytest.raises(PackageNotFoundError):
        version(distribution)


# --------------------------------------------------------------------------- #
# Req 22.14 — the Agg backend, and the fact that the package selects it
# --------------------------------------------------------------------------- #


def test_matplotlib_selects_the_agg_backend() -> None:
    """Importing the package is what configures it — see the module docstring.

    Order matters and is the whole point: matplotlib resolves its backend once, at first
    import, from `MPLBACKEND`. `reporting_agent/__init__.py` sets that variable, so any
    module of ours that imports matplotlib gets Agg in the container, in this suite, and
    on a machine with a display, where the same process otherwise resolves an
    interactive backend.
    """
    import importlib

    # By name, and deliberately not as an `import reporting_agent` statement: the import
    # formatter would sort a first-party import *after* `import matplotlib` and silently
    # invert the one ordering this test exists to assert.
    importlib.import_module("reporting_agent")

    import matplotlib

    assert os.environ.get(BACKEND_ENV_VAR) == CHART_BACKEND
    assert matplotlib.get_backend() == CHART_BACKEND


@pytest.mark.parametrize(
    "order",
    [
        "import reporting_agent; import matplotlib",
        # The hard case: matplotlib got there first and has already resolved a backend,
        # so setting MPLBACKEND afterwards would be silently too late.
        "import matplotlib; import reporting_agent",
    ],
)
def test_the_package_selects_agg_in_a_bare_interpreter_in_either_import_order(
    order: str,
) -> None:
    """The mechanism has a non-test home, proved where no fixture can reach.

    A fixture in this file, or in `conftest.py`, would make the assertion above pass
    while the image rendered on whatever backend it happened to resolve. So this runs a
    **fresh interpreter with no pytest, no conftest and `MPLBACKEND` explicitly removed
    from the environment** — the same conditions as the container, where the entrypoint
    is `python -m reporting_agent.main`. Both import orders are asserted, because
    ordering is the one thing a caller controls and the guarantee must not depend on it.

    On a machine with a display this same interpreter resolves an interactive backend
    without the package, which is what the companion assertion below rules out.
    """
    environment = {k: v for k, v in os.environ.items() if k != BACKEND_ENV_VAR}
    environment["PYTHONPATH"] = str(SRC_ROOT.parent)
    completed = subprocess.run(  # sys.executable, a fixed argv, no shell
        [sys.executable, "-c", f"{order}; print(matplotlib.get_backend())"],
        capture_output=True,
        text=True,
        env=environment,
        timeout=120,
        check=True,
    )
    assert completed.stdout.strip() == CHART_BACKEND, completed.stderr


def test_the_backend_assertion_is_not_tautological() -> None:
    """Guard the guard: without the package, this interpreter resolves *something*.

    If matplotlib happened to resolve Agg here anyway — a headless CI box with no GUI
    toolkit installed — the test above would pass while proving nothing. That is a fine
    state of the world, but it must be visible rather than mistaken for evidence, so the
    backend chosen without us is reported rather than asserted.
    """
    environment = {k: v for k, v in os.environ.items() if k != BACKEND_ENV_VAR}
    completed = subprocess.run(  # sys.executable, a fixed argv, no shell
        [sys.executable, "-c", "import matplotlib; print(matplotlib.get_backend())"],
        capture_output=True,
        text=True,
        env=environment,
        timeout=120,
        check=True,
    )
    unconfigured = completed.stdout.strip()
    assert unconfigured, completed.stderr
    if unconfigured == CHART_BACKEND:
        pytest.skip(
            "this interpreter resolves Agg with no configuration at all (no GUI toolkit "
            "available), so the assertion above is satisfied by the environment rather "
            "than by reporting_agent — it is still correct, but it proves nothing here"
        )


# --------------------------------------------------------------------------- #
# Req 20.2 / 18.5 — the AST scan for the two banned distributions
# --------------------------------------------------------------------------- #


def _import_roots(tree: ast.AST) -> list[tuple[str, int]]:
    """Every import's **distribution root** as `(root, lineno)`.

    The first dotted segment, matched exactly, which is what makes an allowlist
    unnecessary: `import pandas.api.types` and `from pandas import DataFrame` both root
    at `pandas`, while a package merely named like `pandas_stub` does not. Relative
    imports (`level > 0`) are package-internal by construction and can never name a
    distribution, so they are skipped rather than reported.

    Distinct from `_imported_names` above, which keeps the **bound name** because its
    predicates are name-based. A root rule needs the other half of the same node.
    """
    roots: list[tuple[str, int]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            if node.level == 0 and node.module:
                roots.append((node.module.split(".", 1)[0], node.lineno))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                roots.append((alias.name.split(".", 1)[0], node.lineno))
    return roots


def _root_offenders(modules: list[Path], banned: str) -> list[str]:
    offenders: list[str] = []
    for path in modules:
        tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
        offenders.extend(
            f"{_label(path)}:{lineno} -> {root}"
            for root, lineno in _import_roots(tree)
            if root == banned
        )
    return offenders


BANNED_REASONS = {
    "docxtpl": (
        "there is no template document and no placeholder to substitute (Req 20.2). The "
        ".docx is emitted by walking the compiled document AST with python-docx, which is "
        "what makes provenance structural rather than a rule someone remembers"
    ),
    "pandas": (
        "pandas is float-backed, and no float may sit on the path from a snapshot value "
        "to a `formatted` string (Req 18.5) — the snapshot hash and the ledger match both "
        "depend on one decimal spelling. Accumulation, bucketing and roll-ups are Decimal, "
        "in reporting_agent.collect"
    ),
}


@pytest.mark.parametrize("banned", BANNED_DISTRIBUTIONS)
def test_no_module_imports_a_banned_distribution(banned: str) -> None:
    offenders = _root_offenders(_source_modules(), banned)
    assert not offenders, f"{banned} must not be imported: {BANNED_REASONS[banned]}:\n  " + "\n  ".join(
        offenders
    )


def test_every_banned_distribution_has_a_stated_reason() -> None:
    """A ban with no reason attached invites someone to delete it as unexplained."""
    assert set(BANNED_REASONS) == set(BANNED_DISTRIBUTIONS)


@pytest.mark.parametrize(
    ("source", "banned"),
    [
        ("import pandas", "pandas"),
        ("import pandas as pd", "pandas"),
        ("import pandas.api.types", "pandas"),
        ("from pandas import DataFrame", "pandas"),
        ("from pandas.api.types import is_numeric_dtype", "pandas"),
        ("import docxtpl", "docxtpl"),
        ("from docxtpl import DocxTemplate", "docxtpl"),
    ],
)
def test_the_scan_detects_a_banned_import(source: str, banned: str, tmp_path: Path) -> None:
    """Guard the guard: every spelling of the import must be caught, aliases included."""
    module = tmp_path / "offender.py"
    module.write_text(source, encoding="utf-8")
    assert len(_root_offenders([module], banned)) == 1, source


@pytest.mark.parametrize(
    ("source", "banned"),
    [
        # Exact first-segment matching, so a lookalike distribution is not a false hit.
        ("import pandas_stub", "pandas"),
        ("from pandas_helpers import frame", "pandas"),
        ("import docxtpl_shim", "docxtpl"),
        # The canonical emitter, and a relative import that can name no distribution.
        ("from docx import Document", "docxtpl"),
        ("from .accumulate import fold", "pandas"),
        ("from decimal import Decimal", "pandas"),
    ],
)
def test_the_scan_permits_what_is_not_banned(source: str, banned: str, tmp_path: Path) -> None:
    module = tmp_path / "permitted.py"
    module.write_text(source, encoding="utf-8")
    assert _root_offenders([module], banned) == []
