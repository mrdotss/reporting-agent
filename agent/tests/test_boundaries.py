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
        # Extracted from `azure/provider.py` so `verify/replay.py` runs the same
        # finalize the collector ran (Req 31.1). It turns accumulators into statistics,
        # so it is squarely on the snapshot path.
        "collect/finalize.py",
        # The ledger's canonical form and its digest (Req 17.x). A normalization here
        # would produce a different `ledger_sha256` for one render, which is the same
        # failure the snapshot rule exists to prevent one level up — and a
        # re-verification asserts the recompiled ledger is byte-identical to the stored
        # one, so the two hash paths have to obey one rule.
        "compile/figures.py",
        # `Figure`'s decimal strings and the path minting the digest is taken over.
        "compile/ast.py",
        # The single value -> display string conversion. A normalization here changes
        # every `formatted` and therefore every digest downstream of it.
        "compile/format.py",
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


SDK_SCAN_PACKAGES: tuple[str, ...] = (
    "collect",
    "compile",
    "render",
    "verify",
    "compare",
    "narrate",
    "storage",
    "providers",
    "catalog",
)
"""The packages the SDK rule now has to actually reach.

Rule 1 is written as "everything outside `azure/`", which was correct and unfalsifiable
while most of the tree was empty: a scan matching four modules passed it. These nine are
asserted present and non-empty so the rule's reach grows with the tree rather than being
re-argued each time a package lands."""


def test_no_module_outside_the_azure_package_imports_an_azure_sdk() -> None:
    """Req 18.5, 18.7 — the Azure SDK lives behind `azure/` and nowhere else."""
    scanned = _modules_outside_azure_package()
    assert scanned, "the scan matched no modules"
    for package in SDK_SCAN_PACKAGES:
        reached = [p for p in scanned if p.is_relative_to(SRC_ROOT / package)]
        assert reached, f"the SDK scan reaches no module under {package}/"
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

    Every declared entry lives in one of the two packages that build or hash a
    content-addressed artifact (absent is fine — a few are not written yet), and every
    `collect/` module that *does* exist must be declared, so a new one cannot join the
    snapshot path unclassified and unguarded.

    `compile/` is enumerated rather than swept: most of it neither builds nor hashes an
    artifact, and sweeping it would put the ban on modules that have no hash path to
    protect — which teaches a reader that the rule is about `compile/` rather than about
    digests.
    """
    for relative in sorted(SNAPSHOT_PATH_MODULES):
        assert relative.startswith(("collect/", "compile/")), relative
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


# --------------------------------------------------------------------------- #
# Req 26.2 — the object-model readers are banned under verify/
# --------------------------------------------------------------------------- #

VERIFY_PACKAGE = SRC_ROOT / "verify"

# `document.paragraphs` and `document.tables` enumerate only the DIRECT CHILDREN of the
# body element. A paragraph inside a table cell, a nested table, a text box or a content
# control is invisible to them — and this product emits a `row` block as a layout table
# with a chart's companion table nested inside it, so the blind spot covers real
# figures on a real document. A verifier reading through those collections extracts
# nothing, finds no unmatched token, records no finding, and PASSES the document. The
# failure is silent, total and indistinguishable from success, which is why it is worth
# a static guard rather than a code-review convention.
DOCX_OBJECT_MODEL_COLLECTIONS = ("paragraphs", "tables")


def _object_model_offenders(modules: Iterable[Path]) -> list[str]:
    """Every ATTRIBUTE access named `paragraphs` or `tables`.

    Attribute access only, deliberately narrower than `_identifier_offenders`: a local
    list named `tables` is an `ast.Name` and is perfectly legitimate — `tokens.py`
    builds one — while `document.tables` is an `ast.Attribute` and is the thing banned.
    Matching names too would fail a correct module for choosing an obvious variable
    name, and a guard that cries wolf gets suppressed.

    The receiver is not type-checked, so the rule is blunt: under `verify/`, nothing
    reads either attribute off anything. There is no legitimate use in this package,
    and a blunt rule needs no type inference to stay honest.
    """
    offenders: list[str] = []
    for path in modules:
        tree = _parse(path)
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Attribute)
                and node.attr in DOCX_OBJECT_MODEL_COLLECTIONS
            ):
                receiver = _dotted(node.value) or "<expr>"
                offenders.append(
                    f"{_label(path)}:{node.lineno} {receiver}.{node.attr}"
                )
    return offenders


def test_the_verify_package_is_scanned_and_is_not_empty() -> None:
    """Non-vacuity first: an absent package and an empty one are the same hole."""
    assert VERIFY_PACKAGE.is_dir(), VERIFY_PACKAGE
    assert _source_modules(VERIFY_PACKAGE), f"no modules under {VERIFY_PACKAGE}"


def test_no_verify_module_reads_the_docx_object_model_collections() -> None:
    """Req 26.2 — `body.iter(qn("w:p"))` is the only reader."""
    offenders = _object_model_offenders(_source_modules(VERIFY_PACKAGE))
    assert not offenders, (
        "verify/ must read through document.element.body.iter(qn('w:p')), never "
        "document.paragraphs or document.tables: " + "; ".join(offenders)
    )


@pytest.mark.parametrize(
    "source",
    [
        "for p in document.paragraphs: pass",
        "for t in document.tables: pass",
        "texts = [p.text for p in doc.paragraphs]",
        "count = len(self._document.tables)",
        "first = document.tables[0].rows",
    ],
)
def test_the_scan_detects_an_object_model_read(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert len(_object_model_offenders([module])) == 1, source


@pytest.mark.parametrize(
    "source",
    [
        # A local list named `tables` is an ast.Name, not an attribute read.
        "tables = []\ntables.append(1)",
        "paragraphs: list[str] = []\nparagraphs.extend(['a'])",
        # The sanctioned reader.
        "for element in document.element.body.iter(qn('w:p')): pass",
        # Prose explaining the ban must not fail the guard.
        '"""document.paragraphs enumerates only direct children of the body."""\n',
        "# never document.tables — it misses a nested table\n",
    ],
)
def test_the_scan_permits_local_names_and_the_sanctioned_reader(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _object_model_offenders([module]), source


# --------------------------------------------------------------------------- #
# Rule 5 — replay's purity is a build-time property (Req 31.2, 31.7)
# --------------------------------------------------------------------------- #
#
# `verify/replay.py` re-runs the aggregation to prove the snapshot is reproducible. If it
# could reach the network, a "replay" could quietly re-collect and then agree with itself,
# and the artifact would prove nothing. Checking for that at run time is not possible —
# the absence of a call is not observable — so it is checked here, over the transitive
# **first-party** import closure, which is where a socket would have to come from.
#
# `reporting_agent.azure.metrics` is deliberately on that closure and is not an SDK
# import: it is first-party code that parses a response body already in memory, and Req
# 31.1 requires replay to fold through it rather than through a second implementation. The
# rule distinguishes the two by import root, so the day someone adds `from azure.core...`
# to that module this guard fails rather than replay opening a socket.

REPLAY_ENTRY_POINT = "verify/replay.py"

FORBIDDEN_ON_REPLAY_CLOSURE: frozenset[str] = frozenset(
    {"azure", "boto3", "httpx", "reporting_agent.storage.s3"}
)
"""The four Req 31.7 names. The first three are import roots; the fourth is an exact
first-party module, because `storage/base.py` is a protocol and pure — it is the S3
implementation that reaches boto3."""

FIRST_PARTY_ROOT = "reporting_agent"


def _module_path(dotted: str, root: Path = SRC_ROOT) -> Path | None:
    """The file a first-party dotted module names, or `None` if it is not one."""
    if dotted.split(".", 1)[0] != FIRST_PARTY_ROOT:
        return None
    relative = Path(*dotted.split(".")[1:])
    for candidate in (root / relative.with_suffix(".py"), root / relative / "__init__.py"):
        if candidate.is_file():
            return candidate
    return None


def _first_party_closure(entry: Path, root: Path = SRC_ROOT) -> dict[Path, list[Import]]:
    """Every first-party module reachable from `entry`, mapped to its own imports.

    A breadth-first walk over `ast`-parsed imports rather than a runtime
    `importlib` walk, deliberately: importing the closure to inspect it would execute every
    module in it, which for a guard against network access is the wrong order of events.
    Nested and function-local imports are included, because `_imports` walks the whole tree
    — a lazy `import boto3` inside a function is still boto3 on the closure.
    """
    seen: dict[Path, list[Import]] = {}
    queue = [entry]
    while queue:
        path = queue.pop()
        resolved = path.resolve()
        if resolved in {p.resolve() for p in seen}:
            continue
        imports = _imports(_parse(path))
        seen[path] = imports
        for imp in imports:
            for dotted in _candidate_sources(imp):
                found = _module_path(dotted, root)
                if found is not None and found.resolve() not in {
                    p.resolve() for p in seen
                }:
                    queue.append(found)
    return seen


def _candidate_sources(imp: Import) -> tuple[str, ...]:
    """The dotted names one import could name.

    `from reporting_agent.verify import findings` names both `reporting_agent.verify` and
    `reporting_agent.verify.findings`, and only the second is the module that matters. Both
    are tried and whichever resolves to a file is followed.
    """
    if imp.source is None:
        return ()
    return (f"{imp.source}.{imp.name}", imp.source)


def _replay_closure_offenders(root: Path = SRC_ROOT) -> list[str]:
    entry = root / REPLAY_ENTRY_POINT
    offenders: list[str] = []
    for path, imports in sorted(_first_party_closure(entry, root).items()):
        for imp in imports:
            source = imp.source
            if source is None:
                continue
            if (
                _first_segment(source) in FORBIDDEN_ON_REPLAY_CLOSURE
                or source in FORBIDDEN_ON_REPLAY_CLOSURE
                or f"{source}.{imp.name}" in FORBIDDEN_ON_REPLAY_CLOSURE
            ):
                offenders.append(f"{_label(path)}:{imp.lineno} {source} -> {imp.name}")
    return offenders


def test_the_replay_closure_is_walked_and_is_not_trivially_small() -> None:
    """Guard the guard. A closure walk that resolved nothing would pass rule 5 silently.

    The named modules are the ones Req 31.1 requires replay to share with the collector —
    if any of them left the closure, replay would have grown its own copy of the
    aggregation and a mismatch would stop meaning what it means.
    """
    closure = {
        _label(path) for path in _first_party_closure(SRC_ROOT / REPLAY_ENTRY_POINT)
    }

    assert len(closure) > 10, sorted(closure)
    for required in (
        "src/reporting_agent/verify/replay.py",
        "src/reporting_agent/azure/metrics.py",
        "src/reporting_agent/collect/finalize.py",
        "src/reporting_agent/collect/snapshot.py",
        "src/reporting_agent/collect/accumulate.py",
    ):
        assert required in closure, sorted(closure)


def test_no_module_on_the_replay_closure_reaches_the_network() -> None:
    """Req 31.7 — the rule itself."""
    offenders = _replay_closure_offenders()

    assert not offenders, (
        "these modules are reachable from verify/replay.py and import a network client, "
        "so a replay could re-collect rather than recompute: " + "; ".join(offenders)
    )


@pytest.mark.parametrize(
    "source",
    [
        "import boto3",
        "import httpx",
        "from azure.identity import ClientSecretCredential",
        "from reporting_agent.storage.s3 import S3ObjectStore",
        "def fetch():\n    import boto3\n    return boto3",
    ],
)
def test_the_replay_closure_scan_detects_a_network_client(
    source: str, tmp_path: Path
) -> None:
    """Mutation-tested, like every other rule here: the guard is only worth its green if
    it has been seen to go red. The reached module is a *transitive* one, so this also
    proves the walk follows edges rather than only reading the entry point."""
    root = tmp_path / "src" / "reporting_agent"
    _write(root, "__init__.py", "")
    _write(root, "verify/__init__.py", "")
    _write(root, "verify/replay.py", "from reporting_agent.collect.pure import fold\n")
    _write(root, "collect/__init__.py", "")
    _write(root, "collect/pure.py", source + "\n\ndef fold():\n    pass\n")

    assert _replay_closure_offenders(root), source


def test_the_replay_closure_scan_permits_the_first_party_azure_package(
    tmp_path: Path,
) -> None:
    """`reporting_agent.azure.metrics` is not `azure.metrics`, and the rule must not
    confuse them — confusing them would force replay to grow a second fold, which is the
    outcome Req 31.1 exists to prevent."""
    root = tmp_path / "src" / "reporting_agent"
    _write(root, "__init__.py", "")
    _write(root, "verify/__init__.py", "")
    _write(
        root,
        "verify/replay.py",
        "from reporting_agent.azure.metrics import fold_batch_response\n",
    )
    _write(root, "azure/__init__.py", "")
    _write(
        root,
        "azure/metrics.py",
        "from reporting_agent.storage.base import ObjectStore\n\n"
        "def fold_batch_response():\n    pass\n",
    )
    _write(root, "storage/__init__.py", "")
    _write(root, "storage/base.py", "class ObjectStore:\n    pass\n")

    assert not _replay_closure_offenders(root)


# --------------------------------------------------------------------------- #
# Rule 6 — the two model call sites are a directory (Req 19.2, 19.7, 35.1)
# --------------------------------------------------------------------------- #
#
# `narrate/` holds the only two places a model is reached in this product. Making that a
# package rather than a convention is what turns "where can a model be reached from" into a
# question with a filesystem answer — and this rule is what keeps the answer true.

NARRATE_PACKAGE = "narrate"

BEDROCK_CLIENT_NAMES: frozenset[str] = frozenset(
    {"bedrock-runtime", "bedrock_runtime", "converse", "invoke_model"}
)
"""How a Bedrock client is reached from Python: the boto3 service name a `client(...)` call
names, and the two operations. Matched as **string constants and attribute reads**, because
`boto3.client("bedrock-runtime")` names the service in a string and there is no import to
catch."""


def _bedrock_offenders(modules: Iterable[Path]) -> list[str]:
    offenders: list[str] = []
    for path in modules:
        tree = _parse(path)
        for node in ast.walk(tree):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and node.value.strip() in BEDROCK_CLIENT_NAMES
            ):
                offenders.append(
                    f"{_label(path)}:{node.lineno} names {node.value.strip()!r}"
                )
            elif isinstance(node, ast.Attribute) and node.attr in BEDROCK_CLIENT_NAMES:
                offenders.append(f"{_label(path)}:{node.lineno} calls .{node.attr}")
    return offenders


def _modules_outside(package: str, root: Path = SRC_ROOT) -> list[Path]:
    return [
        path
        for path in _source_modules(root)
        if path.resolve().relative_to(root.resolve()).parts[0] != package
    ]


def test_no_module_outside_narrate_reaches_a_bedrock_client() -> None:
    """Req 19.2, 35.1. Two call sites, both in one directory, and nothing else anywhere.

    The value is not that a stray call would be wrong today — it is that "audit the model
    call sites" is `ls narrate/` rather than a search of the whole tree, permanently.
    """
    offenders = _bedrock_offenders(_modules_outside(NARRATE_PACKAGE))

    assert not offenders, (
        "these modules outside narrate/ reach a Bedrock client: " + "; ".join(offenders)
    )


def test_the_narrate_package_exists_and_holds_exactly_two_call_sites() -> None:
    """Guard the guard: the rule above passes vacuously on a tree with no `narrate/` at all,
    and it would keep passing if both call sites were deleted."""
    narrate = SRC_ROOT / NARRATE_PACKAGE
    modules = {path.name for path in _source_modules(narrate)}

    assert modules == {"__init__.py", "summary.py", "review.py"}, sorted(modules)
    assert _bedrock_offenders(_source_modules(narrate)), (
        "narrate/ must actually reach a model, or rule 6 is a rule about nothing"
    )


@pytest.mark.parametrize(
    "source",
    [
        'client = boto3.client("bedrock-runtime")',
        'session.client("bedrock_runtime")',
        "response = client.converse(modelId=x)",
        "response = client.invoke_model(body=b)",
    ],
)
def test_the_scan_detects_a_bedrock_client(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _bedrock_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        'client = boto3.client("s3")',
        "value = conversation.text",
        '"""narrate/ holds the only call sites; nothing else may converse."""\n',
    ],
)
def test_the_scan_permits_other_clients_and_prose(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _bedrock_offenders([module]), source


# --------------------------------------------------------------------------- #
# Rule 7 — `formatted` is assigned in exactly one module (Req 18.1, 20.3)
# --------------------------------------------------------------------------- #


FORMATTED_FIELD = "formatted"
FORMATTED_OWNER = "compile/figures.py"
"""`BlockCursor.figure` is the only place a figure's display string comes into existence,
because `compile/format.py` is the only place a value becomes a string and the cursor is the
only caller of it. A second assignment anywhere would be a second display path, and the two
would eventually disagree on one figure in one report."""


def _called_name(node: ast.Call) -> str:
    """The trailing segment of a call's target: `record_finding` for both the bare name and
    `findings.record_finding`."""
    target = node.func
    if isinstance(target, ast.Attribute):
        return target.attr
    return target.id if isinstance(target, ast.Name) else ""


FIGURE_CONSTRUCTOR = "Figure"
"""The only way a display string comes into existence is on a `Figure`, because
`compile/ast.py`'s numeric-leaf guard makes `Figure` the only node that can hold a quantity
at all. So the rule targets `Figure(formatted=...)` and `.formatted =`, and nothing else.

Three spellings are deliberately **not** offenders, and each would be a false positive with a
cost. `record_finding(..., formatted=...)` quotes a string a figure already carries so a
reviewer can read the finding without opening the document. `_check_anchor(formatted=...)`
forwards one into a comparison. `text = figure.formatted` is what every renderer and every
pass does. Banning any of them would teach the code to spell the field differently, which is
the guard being evaded rather than enforced."""


def _formatted_assignment_offenders(modules: Iterable[Path]) -> list[str]:
    """Every construction of a `Figure` carrying `formatted=`, and every `.formatted =`.

    Writes only. See :data:`FIGURE_CONSTRUCTOR` for what is deliberately excluded.
    """
    offenders: list[str] = []
    for path in modules:
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.Call):
                if _called_name(node) != FIGURE_CONSTRUCTOR:
                    continue
                offenders.extend(
                    f"{_label(path)}:{keyword.value.lineno} Figure(formatted=…)"
                    for keyword in node.keywords
                    if keyword.arg == FORMATTED_FIELD
                )
            elif isinstance(node, ast.Assign):
                for target in node.targets:
                    if (
                        isinstance(target, ast.Attribute)
                        and target.attr == FORMATTED_FIELD
                    ):
                        offenders.append(f"{_label(path)}:{node.lineno} .formatted =")
    return offenders


def test_a_figures_formatted_string_is_assigned_in_exactly_one_module() -> None:
    """One display path, structurally. A figure whose `formatted` came from somewhere else
    would verify against a document nobody produced from it."""
    scanned = [
        path
        for path in _source_modules(SRC_ROOT)
        if path.relative_to(SRC_ROOT).as_posix() != FORMATTED_OWNER
    ]

    offenders = _formatted_assignment_offenders(scanned)

    assert not offenders, (
        f"only {FORMATTED_OWNER} may assign a figure's display string: "
        + "; ".join(offenders)
    )
    assert _formatted_assignment_offenders([SRC_ROOT / FORMATTED_OWNER]), (
        f"{FORMATTED_OWNER} must actually assign it, or this rule guards nothing"
    )


@pytest.mark.parametrize(
    "source",
    [
        'figure = Figure(path=p, formatted="12.4%")',
        'figure = ast.Figure(path=p, formatted="12.4%")',
        'node.formatted = "12.4%"',
    ],
)
def test_the_scan_detects_a_second_display_path(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _formatted_assignment_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        "text = figure.formatted",
        "if entry.formatted in document: pass",
        "strings = [f.formatted for f in ledger]",
        'record_finding(TYPE, message, formatted=figure.formatted)',
        "_check_anchor(anchor=a, formatted=ledger[p].formatted)",
    ],
)
def test_the_scan_permits_reading_a_formatted_string(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _formatted_assignment_offenders([module]), source


# --------------------------------------------------------------------------- #
# Rule 8 — nothing downstream of the compiler does arithmetic on a figure
# --------------------------------------------------------------------------- #
#
# `compile/` computes; `render/` and `verify/` do not. A renderer that added two figures
# would put a number in the document with no `snapshot_path` — unconstructible as a `Figure`
# and therefore, by design, unverifiable — and a verifier that did arithmetic on a `value`
# would be checking the document against something the snapshot never said.

ARITHMETIC_FREE_PACKAGES: tuple[str, ...] = ("render", "verify")

VALUE_FIELD = "value"

_ARITHMETIC_OPS: tuple[type[ast.operator], ...] = (
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.Pow,
)


def _reads_a_figure_value(node: ast.AST) -> bool:
    """True for an attribute read spelled `<something>.value`.

    Deliberately shallow. `figure.value`, `entry.value` and `point.y.value` are all figure
    values in this codebase, and narrowing to a receiver named `figure` would miss every one
    that arrives under another name — which is most of them.
    """
    return isinstance(node, ast.Attribute) and node.attr == VALUE_FIELD


def _figure_arithmetic_offenders(modules: Iterable[Path]) -> list[str]:
    offenders: list[str] = []
    for path in modules:
        tree = _parse(path)
        for node in ast.walk(tree):
            if not isinstance(node, ast.BinOp) or not isinstance(node.op, _ARITHMETIC_OPS):
                continue
            if _reads_a_figure_value(node.left) or _reads_a_figure_value(node.right):
                offenders.append(
                    f"{_label(path)}:{node.lineno} arithmetic on a .value"
                )
    return offenders


def test_no_renderer_or_verifier_performs_arithmetic_on_a_figures_value() -> None:
    """A number computed after the compile has no snapshot position behind it.

    The consequence is not merely a style violation: such a number cannot be a `Figure`, so
    it reaches the document as prose and the masking pass withholds the report — or, worse in
    a verifier, it becomes a comparison against a value the snapshot never recorded.
    """
    scanned = [
        path
        for package in ARITHMETIC_FREE_PACKAGES
        for path in _source_modules(SRC_ROOT / package)
    ]

    assert len(scanned) > 10, "the scan must actually reach render/ and verify/"
    offenders = _figure_arithmetic_offenders(scanned)

    assert not offenders, (
        "render/ and verify/ compute nothing from a figure's value: " + "; ".join(offenders)
    )


@pytest.mark.parametrize(
    "source",
    [
        "total = figure.value + other.value",
        "share = figure.value / denominator",
        "delta = a - point.y.value",
        "scaled = entry.value * 100",
    ],
)
def test_the_scan_detects_arithmetic_on_a_figure_value(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _figure_arithmetic_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        "text = figure.value",
        "joined = prefix + suffix",
        "ordinal = index + 1",
        "label = f'{figure.value}'",
        "if figure.value == recorded: pass",
    ],
)
def test_the_scan_permits_reading_and_unrelated_arithmetic(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _figure_arithmetic_offenders([module]), source


# --------------------------------------------------------------------------- #
# Rule 9 — Req 19.7's enumeration, over an empty set
# --------------------------------------------------------------------------- #


TOOL_REGISTRY_NAMES: frozenset[str] = frozenset(
    {"tool", "tools", "toolConfig", "tool_config", "toolSpec", "tool_choice"}
)
"""How a tool would reach a model: the Strands `@tool` decorator, or a Converse call carrying
a `toolConfig`. Both would have to appear somewhere for a model to be able to *call* anything
in this runtime."""


def test_the_runtime_exposes_zero_operations_to_a_model() -> None:
    """Req 19.7, and the reason it is stated as an enumeration.

    The requirement asks for a test that no operation returns a per-timestamp value to a
    model or accepts a number from one into a figure position. Enumerating such operations
    and asserting each is safe would be a test that grows weaker with every operation added.

    Asserting the set is **empty** is the strongest form the requirement can take, and it is
    available here only because there is no tool registry at all: `narrate/`'s two call sites
    are single-shot Converse calls with no tool list, so there is nothing a model could
    invoke even if it tried.
    """
    exposed: list[str] = []
    for path in _source_modules(SRC_ROOT):
        tree = _parse(path)
        for node in ast.walk(tree):
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef):
                exposed.extend(
                    f"{_label(path)}:{node.lineno} @{name}"
                    for name in _decorator_names(node)
                    if name in TOOL_REGISTRY_NAMES
                )
            elif isinstance(node, ast.Call):
                exposed.extend(
                    f"{_label(path)}:{node.lineno} {keyword.arg}="
                    for keyword in node.keywords
                    if keyword.arg in TOOL_REGISTRY_NAMES
                )

    assert exposed == [], (
        "this runtime exposes an operation to a model; Req 19.7's assertion over an empty "
        "set no longer holds and every such operation needs auditing: " + "; ".join(exposed)
    )


def _decorator_names(node: ast.FunctionDef | ast.AsyncFunctionDef) -> list[str]:
    """The trailing dotted segment of each decorator, called or not."""
    names: list[str] = []
    for decorator in node.decorator_list:
        target = decorator.func if isinstance(decorator, ast.Call) else decorator
        while isinstance(target, ast.Attribute):
            names.append(target.attr)
            break
        else:
            if isinstance(target, ast.Name):
                names.append(target.id)
    return names


@pytest.mark.parametrize(
    "source",
    [
        "@tool\ndef query_snapshot():\n    pass",
        "client.converse(modelId=m, toolConfig={'tools': []})",
    ],
)
def test_the_enumeration_would_detect_a_tool(source: str, tmp_path: Path) -> None:
    """Guard the guard: an assertion over an empty set is worthless unless it has been seen
    to find something."""
    module = _write(tmp_path, "offender.py", source)
    tree = _parse(module)
    found = [
        node
        for node in ast.walk(tree)
        if (
            isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
            and any(name in TOOL_REGISTRY_NAMES for name in _decorator_names(node))
        )
        or (
            isinstance(node, ast.Call)
            and any(k.arg in TOOL_REGISTRY_NAMES for k in node.keywords)
        )
    ]

    assert found, source
