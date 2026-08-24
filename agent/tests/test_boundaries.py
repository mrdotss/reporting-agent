"""Static boundary guards for the agent runtime (Req 18.5, 18.7, 19.7).

Rules 1 through 12, all asserted with `ast` over `src/reporting_agent/**/*.py` — except
rule 12, which also sweeps `tests/`, for the reason recorded where it is defined. The three
below were written before the code they guard; 4 through 9, 11 and 12 were appended as the
packages they cover landed, and each is documented where it is defined rather than restated
here. Rule 7 has two halves — one display *assignment* and one display *computation* — so
it is numbered 7 and 7b, and rules 11 and 12 sit above rule 10 in the file so that rule
10's "no rule above" stays literally true.

**Rule 10 is the completeness rule**, and it is about the other ten: every directory any
of them sweeps must exist and yield at least one module, and the declared set must be
every package in the tree, so no rule here can pass by scanning nothing and no package can
arrive unswept.

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

**This guard was deliberately written before most of the code it guards**, which shaped
two things about it. Both are worth reading, because the first has since been reversed and
the second has not:

* There **used to be no "a scanned directory must be non-empty" rule here**, on the
  grounds that `azure/` held only `__init__.py` and `collect/` was near-empty, so the rule
  would have failed on a correct tree. Every package the rules above sweep now exists and
  holds modules, so that argument has expired and the rule is **rule 10** below, over
  :data:`GUARDED_PACKAGES` — asserted for the whole set at once and, where a rule filters
  its own scan further, again inside that rule. A guard that passes by scanning nothing is
  the failure mode this module is most prone to, and the only reason it was not closed
  from the start was that the tree could not support it yet.
* Because a green run over a sparse tree proves little, every predicate is
  **guard-the-guard tested** against synthetic modules written to `tmp_path`: each
  forbidden spelling must be caught and each canonical one permitted. That discipline is
  kept for every rule added since, and it is what makes each rule's green meaningful
  rather than merely quiet. The `tmp_path` cases deliberately still exercise sparse
  synthetic trees — the *predicates* must stay correct on a tree with an empty package,
  even though the *repository* is now required not to have one.

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
import re
from collections.abc import Callable, Iterable
from pathlib import Path
from typing import Final, NamedTuple

import pytest

AGENT_ROOT = Path(__file__).resolve().parent.parent
SRC_ROOT = AGENT_ROOT / "src" / "reporting_agent"
AZURE_PACKAGE = SRC_ROOT / "azure"

# Rule 12 alone also sweeps the suite: its consumers are largely tests, so a hardcoded
# approach string in a test is the same defect as one in the shipped tree. Every other
# rule here scans `SRC_ROOT` only.
TESTS_ROOT = AGENT_ROOT / "tests"

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
        # The one numeric-leaf reader (Req 7.7). Every value that becomes a snapshot
        # statistic passes through it, on the live side and again on the replay side, so
        # a normalization here would change what both sides read — and change it
        # identically, which is worse than a mismatch: the digest would be self-consistent
        # and different from the one the collection actually produced.
        "collect/numeric.py",
        # The per-local-day fold (Req 35.11). It parses a timestamp and emits decimal
        # strings into `day_buckets[].statistics`, both of which land inside the hashed
        # document — and the replay re-runs it, so a normalization here would make a
        # reproducible snapshot report a mismatch.
        "collect/dayfold.py",
        # The one fact fold (Req 5.x). It produces the `value` strings that land in
        # `resources[].facts[]`, inside the canonical form the `content_hash` is taken
        # over — and a fact key is a snapshot field name, so normalizing either side
        # would change the bytes hashed and change them identically on a replay.
        "collect/factfold.py",
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
    content-addressed artifact and **must now exist**, and every `collect/` module that
    exists must be declared, so a new one cannot join the snapshot path unclassified and
    unguarded.

    The existence half is the completeness rule (rule 10) applied to a hand-written list
    rather than to a directory: this scan is `_snapshot_path_modules()`, which silently
    skips an absent entry, so a renamed module would quietly leave the no-normalization
    rule while the rule stayed green over the remainder. When the list was written most of
    it had not been created yet and absence had to be tolerated; all thirteen exist now,
    so tolerating it buys nothing and costs the rule its reach.

    `compile/` is enumerated rather than swept: most of it neither builds nor hashes an
    artifact, and sweeping it would put the ban on modules that have no hash path to
    protect — which teaches a reader that the rule is about `compile/` rather than about
    digests.
    """
    for relative in sorted(SNAPSHOT_PATH_MODULES):
        assert relative.startswith(("collect/", "compile/")), relative
        assert relative.endswith(".py"), relative
        path = SRC_ROOT / relative
        assert path.is_file(), (
            f"{relative} is declared on the snapshot path and does not exist, so the "
            "no-normalization rule silently skips it; a renamed module must be renamed "
            "in SNAPSHOT_PATH_MODULES too"
        )

    # The scan the rule actually uses sees every declared module, which is the assertion
    # that ties the list above to the rule below it.
    assert {
        p.relative_to(SRC_ROOT).as_posix() for p in _snapshot_path_modules()
    } == set(SNAPSHOT_PATH_MODULES)

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
    scanned = _modules_outside(NARRATE_PACKAGE)
    assert scanned, "the scan matched no modules outside narrate/"
    offenders = _bedrock_offenders(scanned)

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


FORMATTED_CONSTRUCTORS: Final[frozenset[str]] = frozenset({"Figure", "TextFact"})
"""The two node types that carry a display string, and therefore the two constructions this
rule watches: `Figure(formatted=...)`, `TextFact(formatted=...)`, and `.formatted =`.

`Figure` because `compile/ast.py`'s numeric-leaf guard makes it the only node that can hold a
quantity at all. `TextFact` because Req 6.12 gives it a `formatted` of its own, and a display
string produced anywhere but `compile/format.py` is a second display path whichever kind of
value it describes. Leaving `TextFact` out would have let an inline `formatted=fact.value`
grow into a translation of a collected value, at the one call site rule 7 was not looking at.

`DerivedCount` is deliberately **not** watched here. Its `formatted` is always `str(value)`
where `value` is a compile-derived integer (a count) — not a measurement that needs scale,
unit suffix, or locale-aware formatting. It never goes through `compile/format.py` because
there is nothing to format: the integer IS its own display, and routing it through a formatter
would add a dependency for zero value. The structural refusal is different: no caller can
supply the integer directly — only `BlockCursor.derived_count` constructs it.

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
                if _called_name(node) not in FORMATTED_CONSTRUCTORS:
                    continue
                offenders.extend(
                    f"{_label(path)}:{keyword.value.lineno} "
                    f"{_called_name(node)}(formatted=…)"
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

    assert scanned, "the scan matched no modules outside the one owner"
    assert (SRC_ROOT / FORMATTED_OWNER).is_file(), (
        f"{FORMATTED_OWNER} does not exist, so excluding it excludes nothing and the "
        "rule below has no owner to be the exception to"
    )

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
        # Both spellings of the text-fact side. Without these the extension to
        # `TextFact` would be a name in a frozenset that no case exercises.
        'fact = TextFact(path=p, formatted="Succeeded")',
        'fact = ast.TextFact(path=p, formatted="Berhasil")',
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
# Rule 7c — inside the owner, `formatted` comes from a formatter (Req 18.1, 6.12)
# --------------------------------------------------------------------------- #
#
# Rule 7 exempts `compile/figures.py`, because something has to assign the field. That
# exemption is a hole exactly the width of the owner module: rule 7 would report green on
# `TextFact(formatted=fact_value.value)` written there, and that spelling is not a
# hypothetical — it is what the factory did before task 5.3, and a mutation run is how the
# gap surfaced.
#
# Why it matters, given the two spellings produce an identical string today: the reason
# `format_text_fact` exists is that rule 14 forbids `compile/format.py` from resolving a
# string id, so a future translation of a collected value has nowhere to live. An inline
# assignment in the owner routes around that protection entirely — a `Messages.text(...)`
# added in `figures.py` would be a translated fact and no rule would say so.
#
# So the value of every `formatted=` keyword in the owner must come from a formatter: either
# the call itself, or a local bound from one. The numeric side binds a local (there are five
# other arguments to compute first) and the text side calls inline, so both spellings are
# admitted and neither is the only one.

FORMATTER_FUNCTIONS: Final[frozenset[str]] = frozenset(
    {"format_figure", "format_text_fact"}
)
"""The public surface of `compile/format.py` that returns a display string. `unit_suffix`
and `display_scale` are deliberately absent: they return a fragment and a number, and a
`formatted` assembled from a fragment in the owner would be the second display path this
rule exists to prevent."""


def _unformatted_owner_offenders(modules: Iterable[Path]) -> list[str]:
    """Every `formatted=` in these modules whose value did not come from a formatter.

    Per enclosing function, so a local named `formatted` in one function cannot vouch for a
    keyword in another. A nested function's assignments are visible to its enclosing scan as
    well — which is more permissive, not less, and there are none on this path today.
    """
    offenders: list[str] = []
    for path in modules:
        for func in ast.walk(_parse(path)):
            if not isinstance(func, ast.FunctionDef | ast.AsyncFunctionDef):
                continue

            from_formatter = {
                target.id
                for node in ast.walk(func)
                if isinstance(node, ast.Assign)
                and isinstance(node.value, ast.Call)
                and _called_name(node.value) in FORMATTER_FUNCTIONS
                for target in node.targets
                if isinstance(target, ast.Name)
            }

            for node in ast.walk(func):
                if (
                    not isinstance(node, ast.Call)
                    or _called_name(node) not in FORMATTED_CONSTRUCTORS
                ):
                    continue
                for keyword in node.keywords:
                    if keyword.arg != FORMATTED_FIELD:
                        continue
                    value = keyword.value
                    if isinstance(value, ast.Call):
                        if _called_name(value) in FORMATTER_FUNCTIONS:
                            continue
                    elif isinstance(value, ast.Name) and value.id in from_formatter:
                        continue
                    offenders.append(
                        f"{_label(path)}:{value.lineno} "
                        f"{_called_name(node)}(formatted=…) does not come from "
                        f"{'/'.join(sorted(FORMATTER_FUNCTIONS))}"
                    )
    return offenders


def test_the_owner_takes_every_display_string_from_the_formatter() -> None:
    """The other half of rule 7: the one module allowed to assign the field may not compute
    the value itself."""
    owner = SRC_ROOT / FORMATTED_OWNER

    assert owner.is_file(), f"{FORMATTED_OWNER} does not exist"

    offenders = _unformatted_owner_offenders([owner])

    assert not offenders, (
        "every display string comes out of compile/format.py, including a text fact's — "
        "an inline assignment here is a display path that rule 14's no-translation "
        "guarantee does not reach: " + "; ".join(offenders)
    )
    # Both admitted spellings are actually present, so neither branch of the check above is
    # dead. The numeric factory binds a local; the text factory calls inline.
    source = owner.read_text(encoding="utf-8")
    assert "formatted=formatted," in source
    assert "formatted=format_text_fact(" in source


@pytest.mark.parametrize(
    "source",
    [
        # The pre-5.3 spelling, and the mutant that survived until this rule landed.
        "def f():\n    return TextFact(path=p, formatted=fact_value.value)\n",
        'def f():\n    return Figure(path=p, formatted=f"{v}%")\n',
        'def f():\n    return Figure(path=p, formatted=str(v) + "%")\n',
        # A local, but bound from something that is not a formatter.
        'def f():\n    s = translate(v)\n    return TextFact(path=p, formatted=s)\n',
        # A local bound from a formatter in a *different* function does not vouch for this one.
        (
            "def a():\n    s = format_text_fact(v, at=at)\n"
            "def b():\n    return TextFact(path=p, formatted=s)\n"
        ),
    ],
)
def test_the_owner_scan_detects_a_value_that_bypassed_the_formatter(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _unformatted_owner_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        "def f():\n    return TextFact(path=p, formatted=format_text_fact(v, at=at))\n",
        "def f():\n    s = format_figure(v, path=p)\n    return Figure(formatted=s)\n",
        "def f():\n    return Figure(formatted=format_figure(v, path=p))\n",
        # The module-qualified spelling of the same call.
        "def f():\n    return Figure(formatted=fmt.format_figure(v, path=p))\n",
        # Reading one is not assigning one, here as everywhere.
        "def f():\n    return figure.formatted\n",
    ],
)
def test_the_owner_scan_permits_a_value_from_the_formatter(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _unformatted_owner_offenders([module]), source


# --------------------------------------------------------------------------- #
# Rule 7b — the display quantization helper has exactly one importer (Req 18.1, 18.3)
# --------------------------------------------------------------------------- #
#
# Rule 7 bans a second *assignment* of `formatted`. This is the same rule one level down:
# it bans a second place that could **compute** one. Req 18.3 pins the display rounding
# mode to half away from zero, which in `decimal`'s vocabulary is `ROUND_HALF_UP`, and
# `compile/format.py` is the only module that may name it.
#
# The mode is what makes this checkable at all, and the reason is worth stating because
# the codebase looks, at a glance, like it contradicts the rule. There are **two**
# quantizations here with two jobs, and they use two different modes on purpose:
#
#   ROUND_HALF_EVEN  collect/snapshot.py, collect/accumulate.py — decides the bytes a
#                    content address is taken over. Banker's rounding is the right neutral
#                    choice for an aggregate, and it must not move.
#   ROUND_HALF_UP    compile/format.py — decides what a human reads.
#
# So a second importer of `ROUND_HALF_UP` is not a stylistic duplicate; it is a second
# module in a position to turn a value into display digits, and the verifier compares
# document tokens against `formatted`. Two modules rounding, and one report eventually
# carries a digit the ledger disagrees with — on a document that was actually correct,
# which is the failure Req 18.1 exists to make unconstructible.
#
# `ROUND_HALF_EVEN` is deliberately **not** guarded: it has two legitimate importers, both
# on the snapshot path, and a rule with two owners is a list rather than a boundary.

QUANTIZATION_HELPER = "ROUND_HALF_UP"
QUANTIZATION_OWNER = FORMATTED_OWNER.replace("figures.py", "format.py")
"""Derived from rule 7's owner rather than written out, so the pair reads as one decision:
`compile/figures.py` is the only module that *assigns* a display string and
`compile/format.py` is the only module that can *compute* one."""


def test_only_the_formatter_imports_the_display_quantization_helper() -> None:
    """Req 18.1, 18.3 — one rounding mode, in one module, for every value and unit."""
    owner = SRC_ROOT / QUANTIZATION_OWNER
    assert owner.is_file(), owner

    scanned = [path for path in _source_modules(SRC_ROOT) if path != owner]
    assert scanned, "the scan matched no modules outside the formatter"

    offenders = _identifier_offenders(scanned, QUANTIZATION_HELPER)

    assert not offenders, (
        f"only {QUANTIZATION_OWNER} may name {QUANTIZATION_HELPER}: it is the display "
        "rounding mode Req 18.3 pins, and a second module naming it is a second path "
        "from a value to display digits — which fails verification on a report that is "
        "correct:\n  " + "\n  ".join(offenders)
    )

    assert _identifier_offenders([owner], QUANTIZATION_HELPER), (
        f"{QUANTIZATION_OWNER} must actually use {QUANTIZATION_HELPER}, or this rule "
        "guards nothing"
    )


def test_the_snapshot_paths_own_rounding_mode_is_untouched_by_that_rule() -> None:
    """The half worth asserting: the *other* mode is still where it belongs.

    Without this, `ROUND_HALF_UP` could be made unique by rewriting the formatter to use
    banker's rounding — every rule in this module would stay green and every displayed
    figure would round differently from the day before.
    """
    snapshot_mode = "ROUND_HALF_EVEN"

    users = {
        path.relative_to(SRC_ROOT).as_posix()
        for path in _source_modules(SRC_ROOT)
        if _identifier_offenders([path], snapshot_mode)
    }

    assert users == {"collect/snapshot.py", "collect/accumulate.py"}, sorted(users)
    assert not _identifier_offenders(
        [SRC_ROOT / QUANTIZATION_OWNER], snapshot_mode
    ), f"{QUANTIZATION_OWNER} rounds half away from zero, never half to even"


@pytest.mark.parametrize(
    "source",
    [
        "from decimal import ROUND_HALF_UP",
        "from decimal import Decimal, ROUND_HALF_UP",
        "from decimal import ROUND_HALF_UP as MODE",
        "import decimal\nv = x.quantize(q, rounding=decimal.ROUND_HALF_UP)",
        "v = x.quantize(q, rounding=ROUND_HALF_UP)",
        'v = x.quantize(q, rounding="ROUND_HALF_UP")',
    ],
)
def test_the_scan_detects_a_second_quantization_site(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _identifier_offenders([module], QUANTIZATION_HELPER), source


@pytest.mark.parametrize(
    "source",
    [
        # The snapshot path's own mode, which this rule must not touch.
        "from decimal import ROUND_HALF_EVEN",
        "from decimal import ROUND_CEILING, ROUND_FLOOR",
        # Reading a string somebody else produced is the sanctioned move.
        "text = figure.formatted",
        # Prose: `collect/snapshot.py` explains why its mode differs from the formatter's,
        # and a text scan would fail on the tree that documents the distinction best.
        '"""Half to even here, unlike the formatter\'s ROUND_HALF_UP display mode."""\n',
        "# ROUND_HALF_UP would be wrong for an aggregate\n",
    ],
)
def test_the_scan_permits_the_other_mode_and_prose_about_this_one(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _identifier_offenders([module], QUANTIZATION_HELPER), source


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

    # Per package, not only over the union: a union of 15 modules stays comfortably above
    # any threshold with one of the two packages renamed out of the scan entirely.
    for package in ARITHMETIC_FREE_PACKAGES:
        assert _source_modules(SRC_ROOT / package), (
            f"the arithmetic scan reaches no module under {package}/"
        )
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


# --------------------------------------------------------------------------- #
# Rule 11 — one numeric-leaf reader, on both sides of the archive (Req 7.7, 7.9)
# --------------------------------------------------------------------------- #
#
# `collect/numeric.py::decimal_leaf` is the only function permitted to turn a value read
# out of a response body into a `Decimal`. The reason is the month the raw archive was
# write-only: the SDK deserializes a metric total as a `Decimal`, the archive serializes
# it to its exact digit string, `json.loads` hands that back as a `str`, and a reader
# refusing the string form classified every archived value as absent — an
# `interval_counts_missing` gap that never happened, samples missing from the count, and
# `REPLAY_MISMATCH` on every subscription whose metrics carry a fractional value.
#
# A second inline reader is how that returns. It need not be a *worse* reader to break
# the system; it only has to disagree about one type form, in one direction, and the
# digest replay compares is computed from that disagreement.
#
# **This is the static half of a two-part guard, and the weaker half.** The behavioural
# half installs a counting wrapper over `decimal_leaf` and asserts a live collection pass
# and a replay route equal numbers of leaves through it — because a static rule can only
# see the constructions it knows how to name. Two independent signals are matched here so
# that a reintroduction has to evade both:
#
#   1. the **key** being read is one a response carries a numeric leaf under, or
#   2. the **binding** being read out of is one this codebase gives a raw response body.
#
# Either fires. Both are deliberately about the response rather than about the `Decimal`
# call, because the legitimate constructions in these three packages are not response
# reads at all and must keep passing: `verify/replay.py` reads a value off the *stored
# snapshot* (already a canonical decimal string), `collect/pipeline.py` reads a
# `GuestCounterRow` whose `value` the provider already stringified, `azure/skus.py` reads
# an extracted `Mapping[str, str]` of SKU capabilities, and `collect/sketch.py` builds
# `Decimal` constants. None of those is a leaf arriving from a body, and a rule that
# flagged them would be answered by an allowlist — which is the thing this file's other
# ten rules are written to avoid needing.

NUMERIC_LEAF_PACKAGES: tuple[str, ...] = ("azure", "collect", "verify")
"""The three packages the rule sweeps: the two that read a live response and the one that
reads the archive. `compile/` and `render/` are downstream of the snapshot and see decimal
strings this codebase produced, never a body."""

NUMERIC_LEAF_READER = "collect/numeric.py"
"""The one module exempt, POSIX-relative to `SRC_ROOT`. Not a list, and not configurable:
the whole content of the rule is that there is exactly one."""

DECIMAL_CONSTRUCTOR = "Decimal"

RESPONSE_NUMERIC_LEAF_KEYS: frozenset[str] = frozenset(
    {
        # Azure Monitor's four per-interval moments — the leaves `_as_decimal` was
        # introduced for and the ones the archive round trip actually broke.
        "total",
        "count",
        "minimum",
        "maximum",
        # The remaining aggregations the batch and ARM per-resource paths can return.
        "average",
        "sum",
        "last",
    }
)
"""Signal 1: the keys a metric or fact response carries a numeric leaf under.

Named after the *data*, not after the variable holding it, so a reintroduction survives
this signal only by renaming the field Azure sends — which it cannot. `"value"` is
deliberately absent: in these three packages that key names an already-canonical decimal
string on the snapshot and on a `GuestCounterRow`, never a raw body leaf, so listing it
would flag two correct readers and teach the next person to add an allowlist."""

RESPONSE_BODY_BINDINGS: frozenset[str] = frozenset(
    {"body", "datum", "entry", "interval", "payload", "point", "raw_response", "response"}
)
"""Signal 2: the names this codebase binds a raw response body or one of its rows to.

This catches a leaf read under a key signal 1 does not know — a fact response's
`lastRecoveryPoint`, say — at the cost of being evadable by renaming the variable. That
is why it is the second signal and not the only one, and why the behavioural seam test
exists. `raw` and `row` are absent on purpose: both name already-extracted values here
(`getattr` results in replay, a `GuestCounterRow` in the pipeline)."""

_MAPPING_READ_METHODS: frozenset[str] = frozenset({"get", "pop", "setdefault"})


def _is_decimal_call(node: ast.AST) -> bool:
    """True for `Decimal(...)` or `decimal.Decimal(...)`, under any receiver."""
    if not isinstance(node, ast.Call):
        return False
    dotted = _dotted(node.func)
    return dotted == DECIMAL_CONSTRUCTOR or (
        dotted is not None and dotted.endswith(f".{DECIMAL_CONSTRUCTOR}")
    )


def _read_root(node: ast.AST) -> str | None:
    """The base identifier of a read chain: `point` for `point["a"].b.get("c")`."""
    current: ast.AST = node
    while True:
        if isinstance(current, ast.Attribute | ast.Subscript):
            current = current.value
        elif isinstance(current, ast.Call):
            current = current.func
        else:
            break
    return current.id if isinstance(current, ast.Name) else None


def _mapping_reads(node: ast.AST) -> list[tuple[str, str | None]]:
    """Every `<mapping>["key"]` and `<mapping>.get("key")` in `node`, as `(key, root)`.

    A string **literal** key only. A variable key — `capabilities.get(name)` in
    `azure/skus.py` — is a lookup in a mapping this codebase built, not a field named in
    a body, and signal 2 is what covers the case where it is.
    """
    reads: list[tuple[str, str | None]] = []
    for child in ast.walk(node):
        if isinstance(child, ast.Subscript):
            key = child.slice
            if isinstance(key, ast.Constant) and isinstance(key.value, str):
                reads.append((key.value, _read_root(child.value)))
        elif (
            isinstance(child, ast.Call)
            and isinstance(child.func, ast.Attribute)
            and child.func.attr in _MAPPING_READ_METHODS
            and child.args
            and isinstance(child.args[0], ast.Constant)
            and isinstance(child.args[0].value, str)
        ):
            reads.append((child.args[0].value, _read_root(child.func.value)))
    return reads


def _numeric_leaf_offenders(modules: Iterable[Path]) -> list[str]:
    """Every `Decimal(...)` built from a response-body read, with the signal that fired.

    The whole argument subtree is inspected, not only its top node, so the `str(...)`
    detour `Decimal(str(point.get("total")))` takes is caught by the same walk.
    """
    offenders: list[str] = []
    for path in modules:
        tree = _parse(path)
        for node in ast.walk(tree):
            if not _is_decimal_call(node):
                continue
            assert isinstance(node, ast.Call)
            for argument in (*node.args, *(kw.value for kw in node.keywords)):
                for key, root in _mapping_reads(argument):
                    if key in RESPONSE_NUMERIC_LEAF_KEYS:
                        offenders.append(
                            f"{_label(path)}:{node.lineno} Decimal(... {key!r} ...)"
                        )
                    elif root in RESPONSE_BODY_BINDINGS:
                        offenders.append(
                            f"{_label(path)}:{node.lineno} Decimal(... {root}[{key!r}] ...)"
                        )
    return offenders


def _numeric_leaf_scanned_modules(root: Path = SRC_ROOT) -> list[Path]:
    """Every module in the three swept packages except the one exempt reader."""
    exempt = (root / NUMERIC_LEAF_READER).resolve()
    return [
        path
        for package in NUMERIC_LEAF_PACKAGES
        for path in _source_modules(root / package)
        if path.resolve() != exempt
    ]


def test_the_one_reader_exists_and_the_scan_reaches_every_package_around_it() -> None:
    """Req 7.9's non-emptiness half, asserted per package rather than over the union.

    A union of eighty modules clears any threshold with one of the three packages renamed
    out of the scan entirely, and the package most likely to be renamed — `verify/`, whose
    replay is the reason the reader moved — is also the smallest.
    """
    reader = SRC_ROOT / NUMERIC_LEAF_READER
    assert reader.is_file(), (
        f"{NUMERIC_LEAF_READER} is the one exempt module and it does not exist, so the "
        "rule below exempts nothing and the reader it names is not where it says"
    )

    for package in NUMERIC_LEAF_PACKAGES:
        assert _source_modules(SRC_ROOT / package), (
            f"the numeric-leaf scan reaches no module under {package}/"
        )

    scanned = _numeric_leaf_scanned_modules()
    assert scanned, "the numeric-leaf scan found zero source files"
    assert reader not in scanned, "the one reader must be exempt from its own rule"


def test_only_the_one_reader_builds_a_decimal_from_a_response_leaf() -> None:
    """Req 7.7, 7.9. Two readers of one leaf is two opinions about what "absent" means.

    The archive stores the digit string; replay reads it back as a `str`. A second reader
    that handles one type form differently makes a perfectly reproducible collection
    report `REPLAY_MISMATCH`, and the failure presents as a positional fault — some
    metrics replay, some do not — rather than as the type fault it is.
    """
    offenders = _numeric_leaf_offenders(_numeric_leaf_scanned_modules())

    assert not offenders, (
        f"only {NUMERIC_LEAF_READER}'s decimal_leaf may parse a numeric leaf out of a "
        "response; call it instead of building a Decimal here: " + "; ".join(offenders)
    )


@pytest.mark.parametrize(
    "source",
    [
        # Signal 1: the key Azure sends, however the mapping is spelled.
        'total = Decimal(entry["total"])',
        'count = Decimal(anything.get("count"))',
        'low = Decimal(str(whatever["minimum"]))',
        'high = decimal.Decimal(series[0].get("maximum"))',
        # Signal 2: a key signal 1 does not know, read out of a response binding.
        'stamp = Decimal(point.get("lastRecoveryPoint"))',
        'size = Decimal(raw_response["properties"]["sizeInBytes"])',
    ],
)
def test_the_scan_detects_a_second_numeric_leaf_reader(source: str, tmp_path: Path) -> None:
    """Guard the guard. Both signals must be seen to find something."""
    module = _write(tmp_path, "offender.py", source)
    assert _numeric_leaf_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        # The sanctioned call, which is not a `Decimal(...)` construction at all.
        'total = decimal_leaf(point.get("total"))',
        # Constants and computed values: `collect/sketch.py` and `collect/accumulate.py`.
        'BIN_WIDTH = Decimal("0.5")',
        "zero = Decimal(0)",
        "target = quantile * Decimal(self._count)",
        'quantile = Decimal(f"0.{name[1:]}")',
        # An already-canonical decimal string off the stored snapshot: `verify/replay.py`.
        'value = Decimal(str(stat.get("value") or "0"))',
        # A `GuestCounterRow` the provider already stringified: `collect/pipeline.py`.
        'reading = Decimal(row["value"])',
        # An extracted capability mapping under a variable key: `azure/skus.py`.
        "parsed = Decimal(capabilities.get(name))",
        # Reading a response leaf without constructing a Decimal from it.
        'if point.get("total") is None: pass',
    ],
)
def test_the_scan_permits_constants_snapshot_reads_and_the_sanctioned_call(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _numeric_leaf_offenders([module]), source


def test_the_numeric_leaf_scan_fails_when_it_finds_no_source_file(tmp_path: Path) -> None:
    """The rule above is "collect modules, assert no offender", and both halves hold of
    the empty set. Rule 10 asserts the packages are non-empty over the real tree; this
    asserts the *collector* returns nothing when they are, so the assertion protecting
    the rule is the one that would actually fire.
    """
    root = tmp_path / "src" / "reporting_agent"
    _write(root, "__init__.py", "")

    assert _numeric_leaf_scanned_modules(root) == []
    assert _numeric_leaf_offenders(_numeric_leaf_scanned_modules(root)) == [], (
        "an empty scan reports no offender, which is exactly why the non-emptiness "
        "assertion above is load-bearing"
    )


# --------------------------------------------------------------------------- #
# Rule 12 — one module declares the TOC approach strings (Req 14.10)
# --------------------------------------------------------------------------- #
#
# `render/toc.py` declares four approach strings and which one this image adopted. The
# rule is that nothing else spells one.
#
# What it prevents is specific. Every front-matter module after task 2.3 *reads*
# `ADOPTED_APPROACH` rather than assuming a value, so the strings travel widely as
# comparisons. A comparison written as `== "two_pass_measure"` keeps compiling after the
# constant is renamed, keeps passing every type check, and silently stops being taken —
# and the branch it guards is the one that emits page numbers. A table of contents that
# quietly stops being emitted is a missing section; one that quietly keeps being emitted
# after its proof was withdrawn is a page number nobody measured.
#
# **This rule is in two tiers, because the four strings are not equally distinctive.**
# That asymmetry is the whole design and is not an accident of implementation:
#
#   Tier 1 — `libreoffice_index_update`, `two_pass_measure`, `conversion_macro`. These
#   have exactly one meaning in this product, so an exact-match scan for the bare literal
#   is precise: any occurrence outside the owner is a second declaration.
#
#   Tier 2 — `none`. A bare-literal scan is **impossible** here and would fail on correct
#   code today: `render/themes.py` writes `'none'` as a Word table-border value, `main.py`
#   formats an empty list as `'none'` in a log line, and a drift sample records its method
#   as `"none"`. None of those is about a table of contents. So for `none` the rule is
#   contextual — a matching string constant compared against, or assigned to, an
#   identifier that names a TOC approach — which is exactly the mistake worth catching and
#   nothing else.
#
# Tier 2 applies to all four strings rather than only to `none`, so the distinctive three
# are caught by both tiers. Belt and braces on the one rule where a false negative is
# invisible: tier 1 catches the literal wherever it is written, tier 2 catches it even if
# somebody defeats tier 1 by assembling the string.
#
# Both tiers sweep `tests/` as well as `src/`, unlike every other rule in this file. The
# consumers that later tasks add are largely tests — the evidence guard and the proof test
# — and a hardcoded candidate name in the *test* that checks the evidence record is the
# same defect with the same consequence. This module is the one exemption, for the reason
# `AMBIENT_CREDENTIAL` is exempt from rule 2: a guard has to name what it searches for.

TOC_APPROACH_OWNER = "render/toc.py"
"""The one module permitted to spell an approach string, POSIX-relative to `SRC_ROOT`.
Not a list, and not configurable: the content of the rule is that there is exactly one."""

TOC_APPROACH_LITERALS: frozenset[str] = frozenset(
    {"libreoffice_index_update", "two_pass_measure", "conversion_macro", "none"}
)
"""The four strings, written here as literals rather than imported from
`render/toc.py`.

Deliberate, and the one place in this file where duplication is the right answer: a guard
that imported the values it checks for would pass no matter what they were, including
after a rename that broke every comparison in the tree. Writing them out means the guard
and the declaration have to be changed together, and
:func:`test_the_toc_approach_rule_covers_every_declared_approach` below asserts the two
sets are equal — so the duplication cannot drift, it can only fail loudly."""

TOC_APPROACH_DISTINCTIVE: frozenset[str] = frozenset(
    {"libreoffice_index_update", "two_pass_measure", "conversion_macro"}
)
"""Tier 1's set: the three whose bare literal has no other meaning in this product. See
the section comment above on why `none` is not among them."""

TOC_APPROACH_IDENTIFIER_MARKER = "approach"
"""Tier 2's context signal, matched as a case-folded substring of an identifier.

`approach` rather than `toc`: the identifiers that carry one of these values are
`ADOPTED_APPROACH`, `TOC_APPROACHES`, and the `approach=` keyword `measure()` takes. A
marker of `toc` would miss the keyword argument, which is the parameter the harness and
the proof test actually pass a candidate through."""


def _toc_scanned_modules() -> list[Path]:
    """Every module under `src/reporting_agent/` and `tests/`, except the owner and this
    guard. `__pycache__` is excluded the way rule 10 excludes it — a stale `.pyc` is not
    source, and whether one exists depends on whether the suite has run before."""
    owner = (SRC_ROOT / TOC_APPROACH_OWNER).resolve()
    guard = Path(__file__).resolve()
    return [
        path
        for path in (*_source_modules(SRC_ROOT), *_source_modules(TESTS_ROOT))
        if "__pycache__" not in path.parts
        and path.resolve() != owner
        and path.resolve() != guard
    ]


def _toc_approach_identifier(node: ast.AST) -> str | None:
    """The identifier `node` names, if it names one — a bare name, an attribute's trailing
    segment, or a keyword argument's name."""
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _names_a_toc_approach(node: ast.AST) -> bool:
    identifier = _toc_approach_identifier(node)
    return identifier is not None and TOC_APPROACH_IDENTIFIER_MARKER in identifier.casefold()


def _matching_literal(node: ast.AST) -> str | None:
    """The approach string `node` is, if it is one exactly. Compared after `strip()` and
    with `==`, so prose mentioning a candidate inside a longer sentence — this file's own
    section comment, `render/toc.py`'s docstring quoted elsewhere — is not a declaration."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        stripped = node.value.strip()
        if stripped in TOC_APPROACH_LITERALS:
            return stripped
    return None


def _toc_approach_offenders(modules: Iterable[Path]) -> list[str]:
    """Every second spelling of an approach string, by either tier."""
    offenders: list[str] = []
    for path in modules:
        tree = _parse(path)
        for node in ast.walk(tree):
            # Tier 1: a distinctive literal, anywhere.
            literal = _matching_literal(node)
            if literal is not None and literal in TOC_APPROACH_DISTINCTIVE:
                offenders.append(f"{_label(path)}:{node.lineno} literal {literal!r}")
                continue

            # Tier 2: any of the four, in a TOC-approach context.
            for value_node, context_nodes in _toc_approach_contexts(node):
                matched = _matching_literal(value_node)
                if matched is not None and any(
                    _names_a_toc_approach(context) for context in context_nodes
                ):
                    offenders.append(
                        f"{_label(path)}:{node.lineno} approach context {matched!r}"
                    )
    return offenders


def _toc_approach_contexts(
    node: ast.AST,
) -> list[tuple[ast.AST, tuple[ast.AST, ...]]]:
    """Every `(value, identifiers-that-would-make-it-a-TOC-approach)` pair in `node`.

    The three shapes a second declaration takes: a comparison against an approach-named
    identifier, an assignment to one, and a keyword argument named like one.
    """
    if isinstance(node, ast.Compare):
        operands = [node.left, *node.comparators]
        return [(value, tuple(operands)) for value in operands]
    if isinstance(node, ast.Assign) and node.value is not None:
        return [(node.value, tuple(node.targets))]
    if isinstance(node, ast.AnnAssign) and node.value is not None:
        return [(node.value, (node.target,))]
    if isinstance(node, ast.keyword) and node.arg is not None:
        return [(node.value, (ast.Name(id=node.arg),))]
    return []


def test_the_toc_approach_scan_sees_source_files() -> None:
    """Guard the guard. Both trees, because the rule is the only one here that sweeps
    `tests/` and a typo in that root would silently halve it."""
    scanned = _toc_scanned_modules()

    assert scanned, "the TOC approach rule scanned nothing, so it asserts nothing"
    assert any(path.is_relative_to(SRC_ROOT) for path in scanned), scanned[:5]
    assert any(path.is_relative_to(TESTS_ROOT) for path in scanned), scanned[:5]


def test_the_toc_approach_owner_exists_and_declares_every_approach() -> None:
    """The exemption is only meaningful if the exempt module is there and is the thing it
    claims to be. Without this, a rename of `render/toc.py` would leave the rule sweeping
    a tree in which nothing declares the strings and everything is therefore compliant."""
    owner = SRC_ROOT / TOC_APPROACH_OWNER

    assert owner.is_file(), f"{TOC_APPROACH_OWNER} is exempt from rule 12 and absent"

    declared = {
        literal
        for node in ast.walk(_parse(owner))
        if (literal := _matching_literal(node)) is not None
    }
    assert declared == TOC_APPROACH_LITERALS, sorted(
        TOC_APPROACH_LITERALS.symmetric_difference(declared)
    )


def test_the_toc_approach_rule_covers_every_declared_approach() -> None:
    """The duplication in `TOC_APPROACH_LITERALS` cannot drift.

    `render/toc.py` declares `TOC_APPROACHES` as the closed set; this asserts the guard
    checks for exactly that set and not a subset it happens to remember. A fifth candidate
    added there without being added here would otherwise be free to appear anywhere.
    """
    from reporting_agent.render.toc import ADOPTED_APPROACH, TOC_APPROACHES

    assert set(TOC_APPROACHES) == TOC_APPROACH_LITERALS
    assert TOC_APPROACH_DISTINCTIVE < TOC_APPROACH_LITERALS
    assert ADOPTED_APPROACH in TOC_APPROACHES


def test_no_module_outside_the_owner_declares_a_toc_approach_string() -> None:
    """Rule 12 over the real tree."""
    offenders = _toc_approach_offenders(_toc_scanned_modules())

    assert offenders == [], (
        f"only {TOC_APPROACH_OWNER} may spell a table-of-contents approach string; every "
        "consumer imports the constant, so that a rename cannot leave a comparison that "
        "still compiles and is never true (Req 14.10): " + "; ".join(offenders)
    )


@pytest.mark.parametrize(
    "source",
    [
        # Tier 1: the distinctive literals, in any position at all.
        'APPROACH = "two_pass_measure"',
        'if resolved == "libreoffice_index_update": pass',
        'CANDIDATES = ["conversion_macro"]',
        'render(mode="two_pass_measure")',
        'def emit(kind: str = "conversion_macro") -> None: pass',
        # Tier 2: `none`, which tier 1 cannot see, in each of the three shapes.
        'ADOPTED_APPROACH = "none"',
        'if approach == "none": pass',
        'if "none" == self.adopted_approach: pass',
        'measure(definition, snapshot, approach="none")',
        'TOC_APPROACH: str = "none"',
    ],
)
def test_the_toc_approach_scan_detects_a_second_declaration(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _toc_approach_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        # The canonical consumer: import the name, compare the name.
        "from reporting_agent.render.toc import ADOPTED_APPROACH, TOC_APPROACH_NONE\n"
        "if ADOPTED_APPROACH == TOC_APPROACH_NONE: pass",
        # The three legitimate `none` values in this tree today, each of which a bare
        # literal scan would have failed on. These are the cases tier 2 exists to permit.
        "borders = ('none', 0, 'auto')",
        "message = f\"(open: {opened or 'none'})\"",
        'drift_sample = {"n": 0, "method": "none", "seed": seed}',
        'shape = Shape((), "none", None, 0)',
        # Prose naming a candidate is not a declaration; the match is exact after strip.
        '"""The two_pass_measure candidate doubles the conversion."""',
        # An approach-named identifier compared against something that is not a candidate.
        'if approach == "unevaluated": pass',
    ],
)
def test_the_toc_approach_scan_permits_the_constants_and_unrelated_none(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _toc_approach_offenders([module]), source


# --------------------------------------------------------------------------- #
# Rule 14 — the formatter cannot translate (Req 6.12, 6.13)
# --------------------------------------------------------------------------- #
#
# `compile/format.py` produces every `formatted` string in the runtime (rule 7). Req 6.13
# says a fact's value reaches the document as the string the API returned, in either
# language — `Succeeded` stays `Succeeded` in an Indonesian report, because a fact's value
# is **collected data** and the Message_Catalog is **fixed copy**, and those are different
# kinds of string.
#
# The rule is structural rather than a test of behaviour, and the difference is the point.
# A test can assert that `format_text_fact("Succeeded")` returns `Succeeded`; it cannot
# assert that no future edit adds a lookup for some *other* value. Denying the module both
# the catalog import and the vocabulary of string ids means there is nothing in scope to
# resolve against — a translation would have to add an import first, and that is the line
# this rule draws.
#
# Both halves matter. The import alone would be evaded by `from reporting_agent import
# compile as c; c.messages.Messages(...)`; a bare string id alone would be a false positive
# on prose. Together they say: this module names no catalog and no id.

FORMATTER_MODULE = "compile/format.py"

CATALOG_MODULES: Final[frozenset[str]] = frozenset(
    {
        "reporting_agent.compile.messages",
        "reporting_agent.messages",
    }
)
"""The two module paths that can resolve a string id. `compile/messages.py` holds
`Messages.text`, and the `messages` package holds the catalog JSON it reads."""

STRING_ID_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^(?:doc|chart|ui)\.[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$"
)
"""The catalog's own id namespace, from `messages/catalog.v1.json` — a closed prefix set,
lowercase ASCII, dotted. Anchored, so `doc.table.header` matches and the prose
`see doc.table.header for the label` does not: this scans **string literals**, and a
sentence containing an id is not an id."""


def _catalog_import_offenders(modules: Iterable[Path]) -> list[str]:
    """Every import of a catalog module, in any of the three spellings."""
    offenders: list[str] = []
    for path in modules:
        for node in ast.walk(_parse(path)):
            if isinstance(node, ast.Import):
                offenders.extend(
                    f"{_label(path)}:{node.lineno} import {alias.name}"
                    for alias in node.names
                    if alias.name in CATALOG_MODULES
                )
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if module in CATALOG_MODULES:
                    offenders.append(f"{_label(path)}:{node.lineno} from {module}")
                    continue
                # `from reporting_agent.compile import messages` — the module arrives as a
                # name rather than in the module path, which a check on `node.module`
                # alone would miss entirely.
                offenders.extend(
                    f"{_label(path)}:{node.lineno} from {module} import {alias.name}"
                    for alias in node.names
                    if f"{module}.{alias.name}" in CATALOG_MODULES
                )
    return offenders


def _string_id_offenders(modules: Iterable[Path]) -> list[str]:
    """Every string literal that **is** a catalog id."""
    offenders: list[str] = []
    for path in modules:
        for node in ast.walk(_parse(path)):
            if (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and STRING_ID_PATTERN.match(node.value)
            ):
                offenders.append(f"{_label(path)}:{node.lineno} {node.value!r}")
    return offenders


def test_the_formatter_imports_no_catalog_and_names_no_string_id() -> None:
    """Req 6.12, 6.13 — the module that produces every display string has nothing in scope
    to translate one with."""
    module = SRC_ROOT / FORMATTER_MODULE

    assert module.is_file(), (
        f"{FORMATTER_MODULE} does not exist, so this rule scans nothing"
    )

    assert not _catalog_import_offenders([module]), (
        f"{FORMATTER_MODULE} produces every `formatted` string, so it may not import a "
        f"message catalog: a fact's value is collected data and translating it would put a "
        f"string in the document that the API never returned — which the verifier then "
        f"compares against the string it did return."
    )
    assert not _string_id_offenders([module]), (
        f"{FORMATTER_MODULE} names a Message_Catalog string id. Fixed copy is resolved by "
        f"the blocks; a display string is not."
    )


def test_the_formatter_actually_produces_a_text_facts_display_string() -> None:
    """The anchor. Both scans above pass trivially on a module that formats nothing, so the
    rule is pinned against the function it exists to constrain."""
    from reporting_agent.compile.format import format_text_fact

    assert format_text_fact("Succeeded", at="t") == "Succeeded"


@pytest.mark.parametrize(
    "source",
    [
        "from reporting_agent.compile.messages import Messages",
        "import reporting_agent.compile.messages",
        "from reporting_agent.compile import messages",
        "from reporting_agent.messages import CATALOG_PATH",
        'label = "doc.table.header.resource"',
        'label = "chart.axis.utilization_percent"',
        'label = "ui.template.untitled_placeholder"',
    ],
)
def test_the_translation_scan_detects_both_halves(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _catalog_import_offenders([module]) or _string_id_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        # A near-miss import: same leading path, different module.
        "from reporting_agent.compile.snapshot_view import DECIMAL_STRING_PATTERN",
        "from reporting_agent.errors import CompileFailedError",
        # Prose naming an id is not an id, and neither is a dotted attribute path.
        '"""See doc.table.header for the label."""',
        "scale = number_format.decimal_places",
        # A single segment, an uppercase segment, and an unknown prefix are all outside
        # the namespace — so the pattern cannot fire on an ordinary dotted string.
        'unit = "percent"',
        'key = "Doc.Table.Header"',
        'metric = "microsoft.compute.percentage_cpu"',
    ],
)
def test_the_translation_scan_permits_the_formatter_as_it_stands(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _catalog_import_offenders([module]), source
    assert not _string_id_offenders([module]), source


# --------------------------------------------------------------------------- #
# Rule 13 — no bare suppression on the path from a fact response to the snapshot
# --------------------------------------------------------------------------- #
#
# Req 5.7, and it is a **build**-time requirement rather than a review note: "the
# Build_Pipeline SHALL fail IF a module on the path from a fact response to the
# Snapshot_Builder declares an exception handler whose body records no typed gap and
# re-raises no exception."
#
# The failure it forecloses is the one this whole spec is arranged against. A fact-collection
# failure that is swallowed leaves no hole a reader can see: the fact is simply absent from the
# document, and an absent configuration cell reads exactly like a configured one with nothing
# to report. `except Exception: pass` around a backup lookup is how "backup: —" reaches a page
# nobody can distinguish from "no backup configured".
#
# The rule is deliberately **narrow and structural**: a handler must either record a typed gap
# — a `record_gap` call, or one of the declared wrappers around it — or leave by `raise`.
# Logging is not enough on its own, because a log line is not on the artifact a customer reads.
FACT_PATH_MODULES = frozenset(
    {
        # The collector: three sources, and the module that decides what each answer covers.
        "azure/facts.py",
        # The fold: every value and every absence between a response and a `FactRecord`.
        "collect/factfold.py",
        # The one numeric-leaf reader, shared with the metric path (rule 11).
        "collect/numeric.py",
        # The pipeline hands each `FactRecord` to `FactEntry`, and the Snapshot_Builder is the
        # far end of the path this rule names.
        "collect/pipeline.py",
        "collect/snapshot.py",
    }
)
"""Every module a fact travels through, from a response to the hashed document.

Deliberately **not** `azure/clients.py`: a port builds a request and wraps an answer, and its
one handler rebuilds a rejected `HttpResponseError` into an envelope the caller reads as
"not ok" — which is neither a gap nor a re-raise, and is correct, because the classification
happens one layer up in `azure/facts.py` where this rule does apply. Nor `collect/archive.py`,
whose handler does record a gap but which is on the *archive* path rather than between a fact
response and the snapshot; task 4.4's `"facts"` kind is what puts it on this one."""

GAP_RECORDING_CALLS: tuple[str, ...] = ("record_gap", "_unavailable", "_absent")
"""What counts as "records a typed gap" inside a handler body.

`record_gap` is the one gate every gap passes through — `collect/log.py` raises for an
undeclared type — and the two underscored names are `collect/factfold.py`'s own wrappers
around it. Declared by name rather than resolved, because this is a syntactic guard: a scan
that tried to prove a call eventually reaches `record_gap` would be a type checker, and one
that accepted any call at all would accept `logger.warning`."""


FACT_PATH_HANDLER_EXEMPTIONS: frozenset[tuple[str, str]] = frozenset(
    {
        # `decimal_leaf` **is** on the fact path, and its handler returns `None` — the one
        # declared spelling of "this leaf is absent". The gap is recorded one frame up, by
        # `collect/factfold._fold_one`, which turns that `None` into `fact_unavailable`. So the
        # failure is not converted into a *value*; it is converted into the absence the caller
        # is obliged to classify. `test_a_leaf_that_does_not_parse_still_reaches_a_typed_gap`
        # asserts that obligation is met, so this exemption rests on a behavioural assertion
        # rather than on this comment.
        ("collect/numeric.py", "decimal_leaf"),
        # Teardown, after the snapshot is written. An exception here would replace a real
        # terminal error with a cleanup one, and there is no fact in scope to record a gap
        # against.
        ("collect/pipeline.py", "_close_quietly"),
        # The **guest-counter** path, not the fact path: an unreadable Log Analytics row is
        # governed by Req 31.7, which requires the resource to be downgraded to `baseline`
        # rather than a gap recorded here.
        ("collect/pipeline.py", "_fold_guest_rows"),
        # The package's own version, read once at import. Not a response at all.
        ("collect/snapshot.py", "_agent_version"),
    }
)
"""The handlers on the declared modules that are exempt, each by enclosing function and each
for a stated reason.

An exemption list rather than a narrower module set, because the alternative is worse in both
directions: declaring only `azure/facts.py` and `collect/factfold.py` would drop
`collect/numeric.py` — genuinely on the path — out of the rule, while declaring the whole
`collect` package would exempt nothing and the rule would be deleted the first time it fired.

Keyed by `(module, function)` and **not** by line number, so an exemption survives an edit
above it. The residual looseness is that a *second* handler added to an already-exempt
function inherits the pass; it is bounded by these four functions being short and none of them
being where a fact response is read.

The set is asserted **equal** to the offenders the scan finds, not merely a superset of them —
so an exemption kept after its handler learnt to record a gap fails as loudly as a missing one.
That equality is what caught three entries this list originally carried for handlers that
already re-raise: `_local_date`, `statistic_from_plain` and `_parse_rfc3339` never needed
exempting, and claiming they did would have hidden a real regression in any of them."""


def _handler_offenders(
    modules: Iterable[Path],
    exemptions: frozenset[tuple[str, str]] = frozenset(),
) -> list[str]:
    """Every `except` handler whose body neither records a typed gap nor raises.

    Reported as `<module>:<line> in <function>`, because the enclosing function is what an
    exemption is keyed on — a line number would go stale on the next edit above it.
    """
    offenders: list[str] = []
    for path in modules:
        label = _label(path)
        relative = label.removeprefix("src/reporting_agent/")
        for enclosing, handler in _handlers_with_enclosing_function(_parse(path)):
            if _records_a_gap_or_raises(handler):
                continue
            if (relative, enclosing) in exemptions:
                continue
            offenders.append(f"{label}:{handler.lineno} in {enclosing}")
    return offenders


def _handlers_with_enclosing_function(
    tree: ast.AST,
) -> list[tuple[str, ast.ExceptHandler]]:
    """Every handler in the module, paired with the name of the function it sits in.

    `<module>` for a handler at module scope, and the **innermost** enclosing function for a
    nested one, which is the granularity an exemption should be expressible at.
    """
    found: list[tuple[str, ast.ExceptHandler]] = []

    def walk(node: ast.AST, enclosing: str) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, ast.FunctionDef | ast.AsyncFunctionDef):
                walk(child, child.name)
                continue
            if isinstance(child, ast.ExceptHandler):
                found.append((enclosing, child))
            walk(child, enclosing)

    walk(tree, "<module>")
    return found


def _records_a_gap_or_raises(handler: ast.ExceptHandler) -> bool:
    """Whether this handler's **own** body records a gap or raises.

    A nested handler's subtree is skipped, which is what makes the claim above true rather
    than merely intended: `except Exception:` wrapping an inner `try` that re-raises still
    swallows at the outer level, and an `ast.walk` over the whole body would read the inner
    `raise` as the outer handler's own.
    """
    pending: list[ast.AST] = list(handler.body)
    while pending:
        node = pending.pop()
        if isinstance(node, ast.Raise):
            return True
        if (
            isinstance(node, ast.Call)
            and _handler_call_name(node.func) in GAP_RECORDING_CALLS
        ):
            return True
        pending.extend(
            child for child in ast.iter_child_nodes(node)
            if not isinstance(child, ast.ExceptHandler)
        )
    return False


def _handler_call_name(func: ast.expr) -> str:
    """A call target's trailing segment. Named apart from `_called_name` above on purpose:
    that one takes the `Call` and this one takes its `func`, and one name for both is how a
    rule silently starts scanning for the wrong thing."""
    if isinstance(func, ast.Name):
        return func.id
    if isinstance(func, ast.Attribute):
        return func.attr
    return ""


def _fact_path_modules(root: Path = SRC_ROOT) -> list[Path]:
    return sorted(p for p in (root / rel for rel in FACT_PATH_MODULES) if p.is_file())


def test_the_fact_path_is_walked_and_every_declared_module_exists() -> None:
    """A guard that passes by scanning nothing is the first failure mode to rule out — and for
    this rule a *missing* declared module is a real regression rather than a rename to
    tolerate, because every one of them is a module this spec creates or extends."""
    walked = _fact_path_modules()
    assert len(walked) == len(FACT_PATH_MODULES), sorted(
        rel for rel in FACT_PATH_MODULES if not (SRC_ROOT / rel).is_file()
    )
    assert any(
        isinstance(node, ast.ExceptHandler)
        for path in walked
        for node in ast.walk(_parse(path))
    ), "no handler anywhere on the fact path, so the rule would pass vacuously"


def test_no_module_on_the_fact_path_suppresses_an_exception_bare() -> None:
    """Req 5.7 — the rule itself."""
    offenders = _handler_offenders(
        _fact_path_modules(), exemptions=FACT_PATH_HANDLER_EXEMPTIONS
    )
    assert not offenders, (
        "these handlers neither record a typed gap nor re-raise, so a fact-collection "
        "failure they catch becomes an absent cell a reader cannot distinguish from a "
        f"configured one: {offenders}"
    )


def _reported_handlers(modules: Iterable[Path]) -> set[tuple[str, str]]:
    """Every `(module, function)` the rule would report, exemptions **not** applied."""
    return {
        (_label(path).removeprefix("src/reporting_agent/"), enclosing)
        for path in modules
        for enclosing, handler in _handlers_with_enclosing_function(_parse(path))
        if not _records_a_gap_or_raises(handler)
    }


def _exemption_drift(
    declared: frozenset[tuple[str, str]], reported: set[tuple[str, str]]
) -> dict[str, list[tuple[str, str]]]:
    """Both directions of disagreement between the exemption list and the scan. **Pure.**

    A function rather than an inline set comparison so the comparison itself is testable — a
    superset check would satisfy the assertion below on today's tree, and the direction it
    silently drops is the one that matters.
    """
    return {
        "exempt but no longer an offender": sorted(declared - reported),
        "an offender and not exempt": sorted(reported - declared),
    }


def test_every_declared_exemption_names_a_handler_that_is_still_there() -> None:
    """A stale exemption is worse than none: it reads as a considered decision while
    exempting nothing, and the next handler added to that function inherits the pass.

    Both directions — see :func:`_exemption_drift`.
    """
    drift = _exemption_drift(
        FACT_PATH_HANDLER_EXEMPTIONS, _reported_handlers(_fact_path_modules())
    )
    assert not any(drift.values()), drift


@pytest.mark.parametrize(
    ("declared", "reported", "expected"),
    [
        # A stale exemption: the direction a superset check would silently drop.
        (
            frozenset({("a.py", "f"), ("b.py", "g")}),
            {("a.py", "f")},
            "exempt but no longer an offender",
        ),
        # A new offender nobody exempted.
        (
            frozenset({("a.py", "f")}),
            {("a.py", "f"), ("b.py", "g")},
            "an offender and not exempt",
        ),
    ],
)
def test_the_drift_comparison_catches_both_directions(
    declared: frozenset[tuple[str, str]],
    reported: set[tuple[str, str]],
    expected: str,
) -> None:
    drift = _exemption_drift(declared, reported)
    assert drift[expected], drift
    assert not _exemption_drift(declared, set(declared))["an offender and not exempt"]


@pytest.mark.parametrize(
    "source",
    [
        "try:\n    x = 1\nexcept Exception:\n    pass\n",
        "try:\n    x = 1\nexcept ValueError:\n    x = 0\n",
        "try:\n    x = 1\nexcept Exception as exc:\n    logger.warning('%s', exc)\n",
        "def f():\n    try:\n        x = 1\n    except Exception:\n        return None\n",
        # Evidence inside a *nested* handler does not acquit the outer one.
        "try:\n    x = 1\nexcept Exception:\n    try:\n        y = 2\n"
        "    except Exception:\n        raise\n",
    ],
)
def test_the_handler_scan_detects_a_bare_suppression(tmp_path: Path, source: str) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _handler_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        "try:\n    x = 1\nexcept Exception:\n    raise\n",
        "try:\n    x = 1\nexcept Exception as exc:\n    raise ValueError('x') from exc\n",
        "try:\n    x = 1\nexcept Exception:\n    gaps.append(record_gap('a', 'b', None, 'c'))\n",
        "def f():\n    try:\n        x = 1\n    except Exception:\n"
        "        return _unavailable(entry, rid, 'why')\n",
        "def f():\n    try:\n        x = 1\n    except Exception:\n"
        "        return _absent(entry, rid)\n",
        # Logging **beside** a gap is fine; it is logging *instead* of one that is not.
        "try:\n    x = 1\nexcept Exception as exc:\n    logger.warning('%s', exc)\n"
        "    gaps.append(record_gap('a', 'b', None, 'c'))\n",
    ],
)
def test_the_handler_scan_permits_a_gap_or_a_raise(tmp_path: Path, source: str) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _handler_offenders([module]), source


# --------------------------------------------------------------------------- #
# Rule 10 — no rule above may pass by scanning nothing
# --------------------------------------------------------------------------- #
#
# Every rule in this module is of the form "collect a set of modules, assert no offender".
# Both halves can be true of the empty set, so every one of them reports the same green on
# a correct tree and on a scan that resolved to nothing. That is not a hypothetical: the
# scans are keyed on directory names, so a package rename, a moved file, or a typo in a
# constant reduces a rule to a no-op *and removes the failure that would say so*.
#
# The module docstring records why this rule did not exist at first — the tree was too
# sparse to support it, and it would have failed on correct code. That is no longer the
# case, so the rule lands here, once, over the full set of packages, rather than being
# argued again inside each rule.
#
# Two directions are asserted, and the second is the one that keeps this honest over time:
#
#   1. every package the rules above sweep **exists and yields at least one module**;
#   2. that declared set is **exactly** the set of packages in the tree, so a package added
#      tomorrow fails here until somebody decides which rules reach into it.
#
# Direction 2 is what makes this a completeness rule rather than a non-emptiness rule. A
# new package that no rule sweeps is precisely as unguarded as an empty one, and it is much
# harder to notice, because nothing about it looks wrong.

GUARDED_PACKAGES: tuple[str, ...] = (
    "azure",
    "catalog",
    "collect",
    "compare",
    "compile",
    "compile/blocks",
    "messages",
    "narrate",
    "providers",
    "render",
    "storage",
    "verify",
)
"""Every package under `src/reporting_agent/`, each swept by at least one rule above.

`azure/` is here even though rule 1 *exempts* it: the exemption is only meaningful if the
package exists, and `test_the_scan_exempts_the_azure_package_and_only_it` would pass over
an absent one. `compile/blocks/` is listed separately from `compile/` because the rules
recurse and it is where most of `compile/` actually is — a listing that stopped reaching it
would leave rules 3, 7 and 7b covering the block compilers not at all."""


def _package_directories(root: Path = SRC_ROOT) -> set[str]:
    """Every directory under `root` holding a Python module, POSIX-relative to `root`.

    `__pycache__` is excluded: it holds no source, it is not checked in, and its presence
    depends on whether the suite has been run before — which would make direction 2 below
    pass or fail according to the state of a build cache.
    """
    return {
        path.parent.relative_to(root).as_posix()
        for path in _source_modules(root)
        if path.parent != root and "__pycache__" not in path.parts
    }


def test_every_guarded_package_exists_and_is_not_empty() -> None:
    """Direction 1. A rule that swept an absent directory would report a clean pass."""
    empty = [
        package
        for package in GUARDED_PACKAGES
        if not _source_modules(SRC_ROOT / package)
    ]

    assert not empty, (
        "these packages are declared guarded and are absent or hold no module, so every "
        f"rule scanning them asserts nothing: {empty}"
    )


def test_the_guarded_set_is_every_package_in_the_tree() -> None:
    """Direction 2. An unswept package is as unguarded as an empty one, and quieter."""
    declared = set(GUARDED_PACKAGES)
    present = _package_directories()

    assert present - declared == set(), (
        "these packages exist and no rule in this module is declared to reach them; add "
        f"each one to GUARDED_PACKAGES deliberately: {sorted(present - declared)}"
    )
    assert declared - present == set(), (
        "these packages are declared guarded and do not exist, so the declaration is "
        f"stale and the rules naming them scan nothing: {sorted(declared - present)}"
    )


def test_every_package_the_rules_name_is_in_the_guarded_set() -> None:
    """The declaration is tied to the rules that consume it, not merely to the tree.

    Without this, `GUARDED_PACKAGES` could agree with the filesystem perfectly while a
    rule scanned a package name that appears in neither — a rule sweeping `compile/blocks`
    spelled `compile/block` would be a permanent no-op and both assertions above would
    still pass.
    """
    named = {
        *SDK_SCAN_PACKAGES,
        *ARITHMETIC_FREE_PACKAGES,
        *NUMERIC_LEAF_PACKAGES,
        NUMERIC_LEAF_READER.split("/", 1)[0],
        NARRATE_PACKAGE,
        SDK_ROOT_SEGMENT,
        VERIFY_PACKAGE.name,
        *{relative.split("/", 1)[0] for relative in SNAPSHOT_PATH_MODULES},
        *{relative.split("/", 1)[0] for relative in FACT_PATH_MODULES},
        *{
            relative.split("/", 1)[0]
            for relative in (
                FORMATTED_OWNER,
                QUANTIZATION_OWNER,
                REPLAY_ENTRY_POINT,
                TOC_APPROACH_OWNER,
            )
        },
    }

    assert named <= set(GUARDED_PACKAGES), sorted(named - set(GUARDED_PACKAGES))


def test_the_completeness_rule_would_catch_an_empty_or_unswept_package(
    tmp_path: Path,
) -> None:
    """Guard the guard, in both directions, on a synthetic tree.

    The `tmp_path` cases for rules 1 through 9 deliberately build sparse trees, because
    those *predicates* must stay correct on one. This rule is the opposite claim — that the
    **repository** may not be sparse — so it gets its own synthetic tree rather than
    borrowing theirs.
    """
    root = tmp_path / "src" / "reporting_agent"
    _write(root, "__init__.py", "")
    _write(root, "collect/__init__.py", "")
    _write(root, "collect/snapshot.py", "def build():\n    pass\n")
    # An empty package: a directory with no module at all.
    (root / "render").mkdir(parents=True)
    # An unswept package: real modules, named in no declaration.
    _write(root, "smuggle/thing.py", "import boto3\n")

    present = _package_directories(root)

    assert not _source_modules(root / "render"), "the empty package must stay empty"
    assert "render" not in present, "an empty package yields no module and so no entry"
    assert "smuggle" in present, present
    assert "smuggle" not in GUARDED_PACKAGES

    # A stale declaration is caught by the same comparison, from the other side.
    assert set(GUARDED_PACKAGES) - present, (
        "the synthetic tree must be missing declared packages, or direction 2's second "
        "assertion is untested"
    )


# --------------------------------------------------------------------------- #
# Rule 15 — no clock on the replay/fact-fold path (Req 7.11)
# --------------------------------------------------------------------------- #
#
# `collect/factfold.py` is pure: it takes `received_at` as a parameter and reads no clock.
# `verify/replay.py` drives it: it takes every `received_at` from the archived object and
# stamps nothing itself. A clock read in either module would put an instant that changes on
# every call into the canonical form, and the digest replay compares is computed from that
# instant — so every run that replays would mismatch even though the collection was correct.
#
# The lesson is the same as `collect/snapshot.py`'s ban on `unicodedata.normalize`:
# determinism is not a style preference on a hash path.

NO_CLOCK_MODULES: tuple[str, ...] = (
    "collect/factfold.py",
    "verify/replay.py",
)
"""The two modules that must never read a clock.

`verify/replay.py` is also on the replay closure (rule 5) and is already forbidden from
reaching the network. This rule adds the narrower constraint that it may not *time* anything
either — a clock is not a network client, so rule 5 does not catch it."""

CLOCK_TOKENS: frozenset[str] = frozenset({"datetime.now", "time.time", "utcnow"})
"""The three spellings of a clock read.

`datetime.now`    — the common wall-clock call, with or without a tz argument.
`time.time`       — the POSIX-epoch float; rarer but just as non-deterministic.
`utcnow`          — deprecated and dangerous (`datetime.utcnow()` returns naive).

Matched as **attribute chains** for `datetime.now` and `time.time`, and as a bare
**attribute or name** for `utcnow` (which appears as both `datetime.utcnow` and the
occasionally imported bare name).
"""


def _clock_offenders(modules: Iterable[Path]) -> list[str]:
    """Every clock-read token in the given modules.

    Deliberately looks at attribute chains and name occurrences rather than imports,
    because a function that constructs a datetime from its arguments and then calls `.now()`
    on it is not detectable from the import alone — and `datetime` is imported for
    annotations on both modules today.
    """
    offenders: list[str] = []
    for path in modules:
        tree = _parse(path)
        for node in ast.walk(tree):
            # Attribute chain: `datetime.now`, `time.time`, `datetime.utcnow`
            if isinstance(node, ast.Attribute):
                chain = _dotted(node)
                if chain is not None and chain in CLOCK_TOKENS:
                    offenders.append(f"{_label(path)}:{node.lineno} {chain}")
                elif node.attr == "utcnow":
                    offenders.append(f"{_label(path)}:{node.lineno} .utcnow")
            # Bare name: a locally imported `utcnow` (unlikely but covered).
            elif isinstance(node, ast.Name) and node.id == "utcnow":
                offenders.append(f"{_label(path)}:{node.lineno} name utcnow")
            # String constant: `getattr(dt, "utcnow")` or similar dynamic dispatch.
            elif (
                isinstance(node, ast.Constant)
                and isinstance(node.value, str)
                and node.value.strip() in CLOCK_TOKENS
            ):
                offenders.append(f"{_label(path)}:{node.lineno} string {node.value!r}")
    return offenders


def _no_clock_scanned_modules() -> list[Path]:
    return [SRC_ROOT / rel for rel in NO_CLOCK_MODULES if (SRC_ROOT / rel).is_file()]


def test_no_clock_modules_exist() -> None:
    """The two modules the no-clock rule covers must both exist, or the rule scans nothing."""
    for rel in NO_CLOCK_MODULES:
        path = SRC_ROOT / rel
        assert path.is_file(), (
            f"{rel} is declared clock-free and does not exist, so the rule below "
            "asserts nothing for it"
        )


def test_no_clock_on_the_fact_fold_or_replay_path() -> None:
    """Req 7.11. A clock read here makes every replay mismatch.

    `collect/factfold.py` takes `received_at` as a parameter — the instant the caller
    recorded when it received the response. `verify/replay.py` reads that instant from the
    archived object. Neither may substitute its own clock.
    """
    offenders = _clock_offenders(_no_clock_scanned_modules())

    assert not offenders, (
        "these modules read a clock, so a `collected_at` or `received_at` stamped at the "
        "replay instant enters the canonical form and produces REPLAY_MISMATCH on every "
        "run however correct the collection was: " + "; ".join(offenders)
    )


@pytest.mark.parametrize(
    "source",
    [
        "import datetime\nnow = datetime.now()",
        "from datetime import datetime\nts = datetime.now(tz=timezone.utc)",
        "import time\nts = time.time()",
        "from datetime import datetime\nts = datetime.utcnow()",
        "ts = dt.utcnow()",
        'fn = getattr(dt_module, "utcnow")',
    ],
)
def test_the_clock_scan_detects_a_clock_read(source: str, tmp_path: Path) -> None:
    module = _write(tmp_path, "offender.py", source)
    assert _clock_offenders([module]), source


@pytest.mark.parametrize(
    "source",
    [
        # Annotations and type hints are not calls.
        "from datetime import datetime\ndef f(ts: datetime) -> None: pass",
        # A parameter named `received_at` is the correct pattern.
        "def fold(body, *, received_at: str) -> None: pass",
        # Prose about the ban.
        '"""This module reads no clock (Req 7.11)."""',
        "# datetime.now would put a non-deterministic instant into the hash",
        # Reading a stored datetime value from an object is fine.
        "stored_at = document.get('received_at')",
        "instant = record['collected_at']",
    ],
)
def test_the_clock_scan_permits_annotations_and_stored_reads(
    source: str, tmp_path: Path
) -> None:
    module = _write(tmp_path, "permitted.py", source)
    assert not _clock_offenders([module]), source


# --------------------------------------------------------------------------- #
# Rule 15b — replay closure includes factfold, numeric and catalog/loader
# --------------------------------------------------------------------------- #
#
# Task 4.4 widened the replay's transitive first-party closure to include
# `collect/factfold.py` (for fact re-derivation), `collect/numeric.py` (the one numeric
# reader it calls) and `catalog/loader.py` (the declarations it resolves against).
# Asserting them present here means a refactor that moves them off the closure — which
# would force replay to grow its own fold — fails this test rather than silently breaking
# the one-fold guarantee.


def test_the_replay_closure_includes_the_fact_fold_and_its_dependencies() -> None:
    """Req 7.9, 7.11. The replay's closure must include the fact fold path.

    If any of these modules left the closure, replay would have grown a second derivation
    and the one-fold argument would be broken — which means a fact that differed between
    collection and replay would no longer be a genuine error.
    """
    closure = {
        _label(path) for path in _first_party_closure(SRC_ROOT / REPLAY_ENTRY_POINT)
    }

    for required in (
        "src/reporting_agent/collect/factfold.py",
        "src/reporting_agent/collect/numeric.py",
        "src/reporting_agent/catalog/loader.py",
    ):
        assert required in closure, (
            f"{required} is not on the replay closure — replay may have grown its own "
            f"fold, breaking the one-derivation guarantee. Closure: {sorted(closure)}"
        )


# --------------------------------------------------------------------------- #
# Rule 15c — the SDK boundary scan explicitly reaches factfold and numeric
# --------------------------------------------------------------------------- #
#
# Both modules are under `collect/`, which is in `SDK_SCAN_PACKAGES`, so they are already
# swept by rule 1. This test is the **explicit** assertion the task requires — it names
# the two files and fails if the scan does not actually see them. Belt and braces: rule 1's
# per-package assertion would pass if the directory held other files and these two were
# renamed.


def test_the_sdk_boundary_scan_reaches_factfold_and_numeric() -> None:
    """Req 7.9. Both pure modules must be swept by the SDK boundary rule."""
    scanned = set(_modules_outside_azure_package())

    factfold = SRC_ROOT / "collect" / "factfold.py"
    numeric = SRC_ROOT / "collect" / "numeric.py"

    assert factfold.is_file(), f"{factfold} does not exist"
    assert numeric.is_file(), f"{numeric} does not exist"

    assert factfold in scanned, (
        f"{factfold} is not in the SDK boundary scan — it would not be caught importing "
        "an Azure SDK"
    )
    assert numeric in scanned, (
        f"{numeric} is not in the SDK boundary scan — it would not be caught importing "
        "an Azure SDK"
    )


def test_the_sdk_boundary_scan_fails_on_an_empty_directory(tmp_path: Path) -> None:
    """The scan must return nothing meaningful (and therefore assert nothing) for a tree
    whose only non-azure module is the root __init__.py,
    so the non-emptiness assertion that wraps it is what actually protects the rule.

    This test proves the collector returns no package-level modules when packages are
    absent, which is why the per-package `assert reached` in
    `test_no_module_outside_the_azure_package_imports_an_azure_sdk` is load-bearing
    rather than cosmetic.
    """
    root = tmp_path / "src" / "reporting_agent"
    _write(root, "__init__.py", "")
    _write(root, "azure/__init__.py", "")
    # No modules in any of the SDK_SCAN_PACKAGES directories
    scanned = _modules_outside_azure_package(root)
    # Only the root __init__.py should be outside azure/
    assert all(p.name == "__init__.py" for p in scanned), (
        "with no package directories present, only __init__.py should be scanned"
    )
    # None of the SDK_SCAN_PACKAGES are reachable
    for package in SDK_SCAN_PACKAGES:
        reached = [p for p in scanned if p.is_relative_to(root / package)]
        assert not reached, (
            f"package {package}/ should not be reachable in an empty tree"
        )
