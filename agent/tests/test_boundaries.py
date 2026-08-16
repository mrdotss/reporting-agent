"""Static boundary guards for the agent runtime (Req 18.5, 18.7, 19.7).

Three rules, all asserted with `ast` over `src/reporting_agent/**/*.py`:

1. **Only `src/reporting_agent/azure/` may import an Azure SDK** (Req 18.5, 18.7).
   The test fails on any import whose **first dotted segment is exactly `azure`** from
   a module outside that package. Choosing the first segment rather than a prefix match
   is what removes the need for an allowlist: `reporting_agent.azure.provider` is a
   first-party module whose first segment is `reporting_agent`, so `providers/registry.py`
   may name it (it registers exactly that lazy target) without being an SDK import, and
   a package merely *named* like `azure_helpers` or a submodule like `my.azure.thing` is
   not one either. Relative imports (`level > 0`) are package-internal by construction
   and can never name a distribution. That is the whole rule; there is nothing to except.
   What it buys: `collect/`, `storage/`, `providers/` and `catalog/` stay unit-testable
   without a subscription, and an invocation that never touches Azure never pays the SDK
   import.

2. **`DefaultAzureCredential` is used nowhere** (Req 19.7). The credential is built from
   the values in the invocation `context` only; an ambient fallback would silently
   authenticate as the container's own identity against a customer's subscription.

3. **Nothing on the snapshot path normalizes Unicode.** Property 2.8 requires two key
   spellings differing only by normalization form to hash **differently**, so
   `unicodedata.normalize` must not appear where the snapshot is built, canonicalized or
   hashed. `rfc8785` does not normalize; neither may we.

**This guard is deliberately written before most of the code it guards.** `azure/` holds
only `__init__.py` today and `collect/` is likewise near-empty; sections 6, 9 and 11 add
the SDK modules, the pipeline and the snapshot builder. So the guard must be correct on a
sparse tree, which has two consequences worth stating because both look like omissions:

* There is **no "a scanned directory must be non-empty" rule here.** That rule is real,
  but it belongs to the app-side guard (Req 6.11); applied here it would fail today on a
  perfectly correct tree.
* Because a green run over a sparse tree proves little, every predicate is
  **guard-the-guard tested** against synthetic modules written to `tmp_path`: each
  forbidden spelling must be caught and each canonical one permitted. Those tests are
  what stop this module from passing vacuously until section 6 lands.

Rules 2 and 3 match **code, not text.** Both identifiers legitimately appear in prose —
`azure/credential.py` will explain why the ambient credential is absent, and
`collect/snapshot.py` will explain why nothing normalizes — so a literal text scan would
fail on exactly the tree that documents the rule best. `ast` sees neither docstrings in
statement position nor comments, and an exact-match check on string constants closes the
`getattr(module, "DefaultAzureCredential")` route without flagging prose.

The scan structure, helpers and naming follow `tests/test_dependency_pins.py`, which
guards the three-package Azure Monitor pin over the same tree. One idiom, two guards.
"""

from __future__ import annotations

import ast
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import NamedTuple

import pytest

AGENT_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = AGENT_ROOT / "src" / "reporting_agent"
AZURE_PACKAGE = SRC_ROOT / "azure"

# The rule is on the FIRST dotted segment, matched exactly. See the module docstring.
SDK_ROOT_SEGMENT = "azure"

# Req 19.7 — the ambient credential source that must never appear.
AMBIENT_CREDENTIAL = "DefaultAzureCredential"

# The normalization call banned on the snapshot path, and its module, which is banned
# outright there: nothing on that path has any business importing it under any alias.
NORMALIZE_MODULE = "unicodedata"
NORMALIZE_CALL = f"{NORMALIZE_MODULE}.normalize"

# The snapshot path, declared explicitly rather than inferred, so the rule has a
# definition that survives the files not existing yet. These are the modules that build,
# canonicalize or hash a snapshot, plus the two that feed its content:
#
#   snapshot.py    builds the document, canonicalizes it (RFC 8785) and hashes it
#   pipeline.py    assembles what is handed to the builder
#   accumulate.py  produces the per-resource statistics that land in it
#   sketch.py      produces the quantile estimates that land in it
#   buckets.py     produces the local-day keys that land in it
#   log.py         produces the collection_log entries that land in it
#   archive.py     writes the raw responses replay re-aggregates — a normalization here
#                  would reproduce a *different* digest, which is the one thing replay
#                  exists to rule out
#   __init__.py    on the path by containment; it may not normalize either
#
# Paths are POSIX-relative to SRC_ROOT and are checked only if they exist.
SNAPSHOT_PATH_MODULES = frozenset(
    {
        "collect/__init__.py",
        "collect/pipeline.py",
        "collect/accumulate.py",
        "collect/sketch.py",
        "collect/buckets.py",
        "collect/archive.py",
        "collect/snapshot.py",
        "collect/log.py",
    }
)


# --------------------------------------------------------------------------- #
# Helpers — the same shape as tests/test_dependency_pins.py
# --------------------------------------------------------------------------- #


class Import(NamedTuple):
    """One imported name, with the dotted source it came from.

    `source` is the absolute dotted module: `azure.identity` for
    `from azure.identity import X`, and the full `a.b.c` for `import a.b.c` — unlike the
    helper in `test_dependency_pins.py`, which keeps only the bound name because its
    predicates are name-based. A first-segment rule needs the whole path.

    `source` is `None` for a relative import (`level > 0`), which is package-internal by
    construction and can therefore never name a distribution.
    """

    source: str | None
    name: str
    lineno: int


def _parse(path: Path) -> ast.AST:
    return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))


def _imports(tree: ast.AST) -> list[Import]:
    """Every import in the module, including ones nested in functions or `if` blocks."""
    found: list[Import] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom):
            source = node.module if node.level == 0 else None
            for alias in node.names:
                found.append(Import(source, alias.name, node.lineno))
        elif isinstance(node, ast.Import):
            for alias in node.names:
                found.append(Import(alias.name, alias.name, node.lineno))
    return found


def _first_segment(source: str | None) -> str | None:
    """The first dotted segment of an absolute import source, or `None` if relative."""
    if source is None:
        return None
    return source.split(".", 1)[0]


def _is_azure_sdk_import(imp: Import) -> bool:
    """True only for an import rooted at the `azure` namespace package itself."""
    return _first_segment(imp.source) == SDK_ROOT_SEGMENT


def _dotted(node: ast.AST) -> str | None:
    """`a.b.c` for an attribute chain over a plain name; `None` for anything else."""
    parts: list[str] = []
    current: ast.AST = node
    while isinstance(current, ast.Attribute):
        parts.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        parts.append(current.id)
        return ".".join(reversed(parts))
    return None


def _label(path: Path) -> str:
    """Agent-relative where possible; guard-the-guard cases live under `tmp_path`."""
    try:
        return str(path.relative_to(AGENT_ROOT))
    except ValueError:
        return str(path)


def _source_modules(root: Path) -> list[Path]:
    return sorted(root.rglob("*.py"))


def _is_inside_azure_package(path: Path, root: Path) -> bool:
    """True for a module under `<root>/azure/` — the one package exempt from rule 1."""
    return path.resolve().relative_to(root.resolve()).parts[0] == SDK_ROOT_SEGMENT


def _modules_outside_azure_package(root: Path = SRC_ROOT) -> list[Path]:
    return [p for p in _source_modules(root) if not _is_inside_azure_package(p, root)]


def _snapshot_path_modules(root: Path = SRC_ROOT) -> list[Path]:
    """The declared snapshot-path modules that exist yet. An absent one is not a failure."""
    return sorted(p for p in (root / rel for rel in SNAPSHOT_PATH_MODULES) if p.is_file())


def _import_offenders(
    modules: Iterable[Path], predicate: Callable[[Import], bool]
) -> list[str]:
    offenders: list[str] = []
    for path in modules:
        for imp in _imports(_parse(path)):
            if predicate(imp):
                source = imp.source or "<relative import>"
                offenders.append(f"{_label(path)}:{imp.lineno} {source} -> {imp.name}")
    return offenders


def _identifier_offenders(modules: Iterable[Path], identifier: str) -> list[str]:
    """Every *use* of `identifier`: imported, referenced, attribute-accessed, or named
    exactly by a string constant (the `getattr` / `import_module` route).

    Deliberately not a text scan — a docstring explaining why the identifier is absent
    must not fail the guard. An exact-match string constant is a name, not prose.
    """
    offenders: list[str] = []
    for path in modules:
        tree = _parse(path)
        for imp in _imports(tree):
            if imp.name == identifier or imp.source == identifier:
                offenders.append(f"{_label(path)}:{imp.lineno} import {identifier}")
        for node in ast.walk(tree):
            if isinstance(node, ast.Name) and node.id == identifier:
                offenders.append(f"{_label(path)}:{node.lineno} name {identifier}")
            elif isinstance(node, ast.Attribute) and node.attr == identifier:
                offenders.append(f"{_label(path)}:{node.lineno} attribute {identifier}")
            elif (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and node.value.strip() == identifier
            ):
                offenders.append(f"{_label(path)}:{node.lineno} string {identifier!r}")
    return offenders


def _normalization_offenders(modules: Iterable[Path]) -> list[str]:
    """Any route to `unicodedata.normalize`: the import under any alias, the attribute
    call, or the module named by a string constant.

    Matching on a receiver spelled `unicodedata` rather than on the bare attribute name
    is required, not fussiness: `Decimal.normalize()` is a legitimate call on this path
    and a blanket `.normalize` ban would forbid it.
    """
    offenders: list[str] = []
    for path in modules:
        tree = _parse(path)
        for imp in _imports(tree):
            if _first_segment(imp.source) == NORMALIZE_MODULE:
                offenders.append(
                    f"{_label(path)}:{imp.lineno} imports {imp.source} -> {imp.name}"
                )
        for node in ast.walk(tree):
            if isinstance(node, ast.Attribute) and _dotted(node) == NORMALIZE_CALL:
                offenders.append(f"{_label(path)}:{node.lineno} calls {NORMALIZE_CALL}")
            elif (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and node.value.strip() in {NORMALIZE_MODULE, NORMALIZE_CALL}
            ):
                offenders.append(
                    f"{_label(path)}:{node.lineno} names {node.value.strip()!r}"
                )
    return offenders


def _write(root: Path, relative: str, source: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(source, encoding="utf-8")
    return path


# --------------------------------------------------------------------------- #
# Req 18.5 / 18.7 — the SDK boundary over the real tree
# --------------------------------------------------------------------------- #


def test_the_scan_sees_source_files() -> None:
    """A guard that passes by scanning nothing is the failure mode to rule out first.

    Asserted over `src/reporting_agent/` as a whole, NOT per package: `azure/` and
    `collect/` are legitimately near-empty until sections 6 and 9 land, so a
    per-directory non-emptiness rule would fail on a correct tree today. The app-side
    guard (Req 6.11) owns that rule; this one does not.
    """
    assert SRC_ROOT.is_dir(), SRC_ROOT
    assert AZURE_PACKAGE.is_dir(), f"{AZURE_PACKAGE} is the one exempt package"
    assert _source_modules(SRC_ROOT), f"no Python modules found under {SRC_ROOT}"


def test_the_azure_package_is_the_only_thing_excluded_from_the_scan() -> None:
    scanned = set(_modules_outside_azure_package())
    inside = {p for p in _source_modules(SRC_ROOT) if p.is_relative_to(AZURE_PACKAGE)}
    assert scanned == set(_source_modules(SRC_ROOT)) - inside
    assert not scanned & inside


def test_no_module_outside_the_azure_package_imports_an_azure_sdk() -> None:
    """Req 18.5, 18.7 — the Azure SDK lives behind `azure/` and nowhere else."""
    scanned = _modules_outside_azure_package()
    assert scanned, "the scan matched no modules"
    offenders = _import_offenders(scanned, _is_azure_sdk_import)
    assert not offenders, (
        "only modules under src/reporting_agent/azure/ may import an Azure SDK, so that "
        "collect/, storage/, providers/ and catalog/ stay unit-testable without a "
        "subscription; move the call behind a port in azure/:\n  " + "\n  ".join(offenders)
    )


def test_the_lazy_provider_target_is_a_first_party_import_not_an_sdk_one() -> None:
    """The first-segment rule is what makes an allowlist unnecessary (Req 18.7).

    `providers/registry.py` registers `reporting_agent.azure.provider:build_provider`.
    A prefix match on `azure` would flag it and force an exception; the first segment is
    `reporting_agent`, so there is nothing to except.
    """
    registry = SRC_ROOT / "providers" / "registry.py"
    assert registry.is_file(), registry
    assert "reporting_agent.azure.provider" in registry.read_text(encoding="utf-8")
    assert _first_segment("reporting_agent.azure.provider") == "reporting_agent"
    assert not _import_offenders([registry], _is_azure_sdk_import)


# --------------------------------------------------------------------------- #
# Req 19.7 — no ambient credential
# --------------------------------------------------------------------------- #


def test_no_module_uses_the_ambient_default_azure_credential() -> None:
    """Req 19.7 — the credential comes from the invocation `context`, never the ambient
    chain, which would authenticate as the container's own identity."""
    offenders = _identifier_offenders(_source_modules(SRC_ROOT), AMBIENT_CREDENTIAL)
    assert not offenders, (
        f"{AMBIENT_CREDENTIAL} must appear nowhere: exactly one ClientSecretCredential "
        "is built per invocation from the tenant_id / client_id / client_secret in that "
        "invocation's context (Req 19.1, 19.7):\n  " + "\n  ".join(offenders)
    )


# --------------------------------------------------------------------------- #
# Property 2.8 — no Unicode normalization on the snapshot path
# --------------------------------------------------------------------------- #


def test_no_snapshot_path_module_normalizes_unicode() -> None:
    offenders = _normalization_offenders(_snapshot_path_modules())
    assert not offenders, (
        f"{NORMALIZE_CALL} must not appear on the snapshot path: Property 2.8 requires "
        "two key spellings differing only by normalization form to hash differently, and "
        "rfc8785 does not normalize:\n  " + "\n  ".join(offenders)
    )


def test_the_declared_snapshot_path_stays_honest() -> None:
    """The declaration is explicit, so it needs its own guard against drifting.

    Every declared entry must be a `collect/` module (absent is fine — most are not
    written yet), and every `collect/` module that *does* exist must be declared, so a
    new one cannot join the snapshot path unclassified and unguarded.
    """
    for relative in sorted(SNAPSHOT_PATH_MODULES):
        assert relative.startswith("collect/"), relative
        assert relative.endswith(".py"), relative
        path = SRC_ROOT / relative
        assert not path.exists() or path.is_file(), path

    collect_root = SRC_ROOT / "collect"
    existing = {
        p.relative_to(SRC_ROOT).as_posix() for p in _source_modules(collect_root)
    }
    undeclared = existing - SNAPSHOT_PATH_MODULES
    assert not undeclared, (
        "these collect/ modules are not declared in SNAPSHOT_PATH_MODULES, so the "
        "no-normalization rule does not reach them; add each one deliberately: "
        f"{sorted(undeclared)}"
    )


# --------------------------------------------------------------------------- #
# Guard the guard — the real tree is sparse, so each predicate is proven on
# synthetic modules under tmp_path
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    "source",
    [
        "import azure",
        "import azure.identity",
        "import azure.identity as ident",
        "from azure.identity import ClientSecretCredential",
        "from azure.mgmt.resourcegraph import ResourceGraphClient",
        "from azure.monitor.querymetrics import MetricsClient",
        "from azure.core.exceptions import HttpResponseError as Boom",
        "def build():\n    from azure.identity import ClientSecretCredential",
        "if True:\n    import azure.mgmt.compute",
        "try:\n    import azure.identity\nexcept ImportError:\n    pass",
    ],
)
def test_the_scan_detects_an_azure_sdk_import(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    offenders = _import_offenders([module], _is_azure_sdk_import)
    assert len(offenders) == 1, offenders


@pytest.mark.parametrize(
    "source",
    [
        # First-party: the first segment is `reporting_agent`, not `azure`.
        "from reporting_agent.azure.provider import build_provider",
        "import reporting_agent.azure.provider",
        "from reporting_agent.azure import ports",
        "from reporting_agent.providers.base import Provider",
        # Relative imports are package-internal and can name no distribution.
        "from . import provider",
        "from .provider import build_provider",
        "from ..providers.base import Provider",
        # Exact segment match, so a merely azure-ish name is not an SDK import.
        "import azure_helpers",
        "from azure_helpers.client import thing",
        "import azurely.things",
        "import my.azure.thing",
        "from my.azure.thing import other",
        # Ordinary stdlib and third-party imports.
        "import ast",
        "from decimal import Decimal",
        "import rfc8785",
        "import boto3",
    ],
)
def test_the_scan_permits_first_party_relative_and_unrelated_imports(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _import_offenders([module], _is_azure_sdk_import)


def test_the_scan_exempts_the_azure_package_and_only_it(tmp_path: Path) -> None:
    """Selection guard: the same offending import passes inside `azure/` and fails outside."""
    sdk_import = "from azure.identity import ClientSecretCredential\n"
    inside = _write(tmp_path, "azure/credential.py", sdk_import)
    outside = _write(tmp_path, "collect/pipeline.py", sdk_import)
    nested = _write(tmp_path, "azure/inner/helper.py", sdk_import)
    top_level = _write(tmp_path, "main.py", sdk_import)

    scanned = _modules_outside_azure_package(tmp_path)
    assert set(scanned) == {outside, top_level}
    assert inside not in scanned and nested not in scanned

    offenders = _import_offenders(scanned, _is_azure_sdk_import)
    assert len(offenders) == 2, offenders
    assert {_label(inside), _label(nested)}.isdisjoint(
        offender.split(":", 1)[0] for offender in offenders
    )
    # The exemption is the file's location, not its content: the identical import is an
    # offender when the same predicate is pointed at the exempt modules directly.
    assert len(_import_offenders([inside, nested], _is_azure_sdk_import)) == 2


def test_the_guard_holds_on_a_tree_whose_guarded_packages_are_still_empty(
    tmp_path: Path,
) -> None:
    """Sections 6, 9 and 11 have not landed. The guard must be green, not blank, today.

    An `azure/` and a `collect/` holding only `__init__.py` must produce no offenders and
    raise nothing — which is why this module carries no non-emptiness rule.
    """
    _write(tmp_path, "azure/__init__.py", '"""The only SDK package."""\n')
    collect_init = _write(tmp_path, "collect/__init__.py", '"""The pure pipeline."""\n')

    scanned = _modules_outside_azure_package(tmp_path)
    assert scanned == [collect_init]
    assert not _import_offenders(scanned, _is_azure_sdk_import)
    assert not _identifier_offenders(scanned, AMBIENT_CREDENTIAL)
    assert not _normalization_offenders([collect_init])
    assert _snapshot_path_modules(tmp_path) == [collect_init]


@pytest.mark.parametrize(
    "source",
    [
        "from azure.identity import DefaultAzureCredential",
        "from azure.identity.aio import DefaultAzureCredential as Cred",
        "import azure.identity\ncred = azure.identity.DefaultAzureCredential()",
        "from azure import identity\ncred = identity.DefaultAzureCredential()",
        "cred = DefaultAzureCredential()",
        'cred = getattr(identity, "DefaultAzureCredential")()',
    ],
)
def test_the_scan_detects_the_ambient_credential(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _identifier_offenders([module], AMBIENT_CREDENTIAL), source


@pytest.mark.parametrize(
    "source",
    [
        "from azure.identity import ClientSecretCredential",
        "cred = ClientSecretCredential(tenant_id, client_id, client_secret)",
        # Prose, not a call: `azure/credential.py` will document exactly this rule, and
        # a text scan would fail on the tree that documents it best.
        '"""Nothing here uses DefaultAzureCredential (Req 19.7)."""\n',
        "# DefaultAzureCredential would authenticate as the container itself.\n",
        'MESSAGE = "the ambient DefaultAzureCredential chain is never used"\n',
    ],
)
def test_the_scan_permits_the_explicit_credential_and_prose_about_the_ambient_one(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _identifier_offenders([module], AMBIENT_CREDENTIAL), source


@pytest.mark.parametrize(
    "source",
    [
        "import unicodedata\nkey = unicodedata.normalize('NFC', key)",
        "import unicodedata as ud\nkey = ud.normalize('NFC', key)",
        "from unicodedata import normalize\nkey = normalize('NFC', key)",
        "from unicodedata import normalize as n\nkey = n('NFKC', key)",
        "def build(doc):\n    import unicodedata\n    return doc",
        'mod = importlib.import_module("unicodedata")',
        'fn = registry["unicodedata.normalize"]',
    ],
)
def test_the_scan_detects_unicode_normalization(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _normalization_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        "import rfc8785\nbody = rfc8785.dumps(doc)",
        "import hashlib\ndigest = hashlib.sha256(body).hexdigest()",
        # Decimal.normalize() is legitimate here, which is why the rule matches a
        # receiver spelled `unicodedata` and not a bare `.normalize` attribute.
        "from decimal import Decimal\nvalue = Decimal('1.500').normalize()",
        "value = accumulator.normalize()",
        # Prose again: collect/snapshot.py will explain why nothing normalizes.
        '"""No Unicode normalization anywhere on the hash path (Property 2.8)."""\n',
        "# unicodedata.normalize would make two spellings hash identically.\n",
    ],
)
def test_the_scan_permits_decimal_normalize_and_prose_about_normalization(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _normalization_offenders([module]), source
