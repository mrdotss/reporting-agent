"""The Catalog_Evidence_Guard: every catalog entry checked against the recorded Metric
Definitions response it was derived from (Req 1.6, 2.1-2.4, 2.6, 2.7, 2.9-2.11).

## What this defends against

A guessed metric name makes a metric **permanently uncollectable with nothing failing at
run time**. Azure answers a request for a metric it does not have with a per-resource
error, the collector records a typed gap, the run completes, verification passes, and the
delivered document simply never mentions that metric. Nobody is told. So the control has to
be a build-time comparison against evidence, and that is what this module is.

## Why it lives in `src/` and not in the test that calls it

Two reasons, and the second is the load-bearing one:

* `tests/test_catalog_evidence.py` **imports** this function, so Property 5 generates
  against the implementation rather than against a copy of the rule written in a test. A
  guard reimplemented in its own test proves the test's version correct.
* `.dockerignore` excludes `tests/`, and criterion 2.6 requires this to run in the
  container image build. A guard that only ran in the suite could not stop an image
  carrying a catalog entry the evidence beside it contradicts — the same reasoning that
  puts `compile/ast.py`'s and `render/themes.py`'s `--assert-build` entry points in `src/`.

## The unit mapping, and why comparing units as strings would fail every correct entry

The Metric Definitions API reports its own unit vocabulary — `Percent`, `Bytes`,
`BytesPerSecond` — while a catalog entry's `unit` is constrained to
:data:`~reporting_agent.catalog.loader.DECLARED_UNITS`, which is `percent`, `bytes` and
`count_per_second`. The two are different vocabularies for the same quantities, so
comparing them as equal strings would reject every entry in the file (Req 2.9).

:data:`UNIT_MAPPING` is therefore the association, declared once. **Three reported units
have no term deliberately**, and that is an explicit decision rather than an omission —
see :data:`UNMAPPED_UNITS`.

## The near-miss rule

A portal display name and an API metric name differ by exactly case, surrounding
whitespace and separator substitution: `Percentage Cpu`, ` Percentage CPU`,
`Percentage_CPU` and `Percentage-CPU` against `Percentage CPU`. An exact-string comparison
already rejects all four — but it rejects them with the same message it gives a genuinely
absent metric, which sends a reader looking for a metric Azure does not have instead of at
a typo. So a near miss is detected and reported as a near miss (Req 2.7).
"""

from __future__ import annotations

import json
import os
import re
import sys
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

from reporting_agent.catalog.loader import (
    LoadedCatalog,
    load_catalog,
)

__all__ = [
    "EVIDENCE_DIR_ENV",
    "SECRET_FIELD_NAMES",
    "UNIT_MAPPING",
    "UNMAPPED_UNITS",
    "EvidenceFinding",
    "assert_catalog_is_evidenced",
    "check_catalog_evidence",
    "evidence_directory",
    "evidence_filename",
    "load_fixture",
]

EVIDENCE_DIR_ENV: Final[str] = "RPT_EVIDENCE_DIR"
"""An override for :func:`evidence_directory`, for a build that stages the evidence
somewhere other than the two layouts below."""

UNIT_MAPPING: Final[Mapping[str, str]] = {
    "Percent": "percent",
    "Bytes": "bytes",
    "BytesPerSecond": "bytes",
    "CountPerSecond": "count_per_second",
}
"""Each reported unit name, associated with exactly one term of `DECLARED_UNITS` (Req 2.9).

`BytesPerSecond` maps to **`bytes`**, not to `count_per_second`, and that pairing is the one
worth stating: both names end in `PerSecond`, so a mapping written by pattern rather than by
quantity would put a byte rate in the count family. The unit family is what selects the
sketch, so getting it wrong sketches the wrong distribution and the percentile that comes
out is a number about nothing.

`Count` is **absent on purpose** even though it looks like it belongs beside
`CountPerSecond` — see :data:`UNMAPPED_UNITS`."""

UNMAPPED_UNITS: Final[Mapping[str, str]] = {
    "Count": (
        "a count is not a rate. The only remaining term is `count_per_second`, and mapping "
        "a gauge like `AppConnections` or a monotonic counter like `Transactions` to it "
        "would label a quantity as a rate in the delivered document and sketch it in the "
        "wrong unit family. `DECLARED_UNITS` has no `count` term, so a metric reported in "
        "`Count` cannot be declared until one is added deliberately."
    ),
    "Seconds": (
        "no duration term exists in `DECLARED_UNITS`. `CpuTime` and "
        "`ReplicationLagSeconds` are real metrics and both are excluded from the catalog "
        "for this reason rather than being recorded in a unit that is not theirs."
    ),
    "Unspecified": (
        "the API's own admission that it does not know the unit. Choosing one here would "
        "be this module inventing the fact it exists to check."
    ),
}
"""Reported units with **no** term, each with the reason recorded.

Criterion 2.10 requires a reported unit the mapping has no term for to *fail*, naming the
type, the metric and the unit — so this is not a gap in the mapping, it is the mechanism.
A catalog entry declaring a metric Azure reports in one of these units is refused, loudly,
rather than quietly assigned the nearest-looking term.

Declared as a mapping to its reason rather than as a bare set, so the failure message can
say **why** there is no term instead of only that there is none."""

SECRET_FIELD_NAMES: Final[tuple[str, ...]] = (
    "id",
    "resourceId",
    "resourceid",
    "subscriptionId",
    "tenantId",
    "clientId",
    "clientSecret",
    "client_secret",
    "access_token",
    "authorization",
)
"""Field names a fixture may not carry (Req 2.5, 2.11).

`id` and `resourceId` are here because the Metric Definitions API returns both as **fully
qualified resource ids**, which carry a subscription id. A metric definition is identical
across every resource of one type in one region — that is the premise of the definition
probe's cache — so nothing about a particular resource is evidence of anything, and the
recorded fixtures omit both."""

_GUID_RE: Final[re.Pattern[str]] = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
"""A subscription or tenant id shape, matched anywhere in a string value.

Complements the field-name check: a fixture could carry a subscription id inside a
`displayDescription` rather than under a field this module knows the name of."""

_SUBSCRIPTION_PATH_RE: Final[re.Pattern[str]] = re.compile(
    r"/subscriptions/", re.IGNORECASE
)

_SEPARATOR_SENTINEL: Final[str] = "\x1f"
_SEPARATORS: Final[str] = " _-/."
"""The five characters the near-miss rule collapses (Req 2.7): space, underscore, hyphen,
forward slash and period. Exactly the set that differs between a portal display name and an
API metric name."""

_PACKAGE_PARENT: Final[Path] = Path(__file__).resolve().parent.parent


@dataclass(frozen=True, slots=True)
class EvidenceFinding:
    """One disagreement between the catalog and its evidence.

    Carries the resource type, the metric and the field rather than a formatted sentence,
    so the caller decides the presentation and a property test can assert *which* field
    disagreed rather than matching a message.
    """

    resource_type: str
    metric: str | None
    field: str
    message: str

    def __str__(self) -> str:
        metric = self.metric if self.metric is not None else "<no metric>"
        return f"{self.resource_type} / {metric} / {self.field}: {self.message}"


def evidence_directory() -> Path:
    """Where the recorded fixtures live, in the image and in the checkout.

    Resolved from the **checkout marker** rather than from whichever candidate happens to
    exist, exactly as `render/themes.py`'s `theme_directory` resolves the themes and for the
    same reason: probing for an existing directory makes the answer depend on the
    filesystem rather than on the layout, and the two layouts differ legitimately.

    * checkout — `agent/tests/fixtures/metric_definitions/`, beside the suite that reads it
    * image — `/app/evidence/metric_definitions/`, copied by the Dockerfile, because
      `.dockerignore` excludes `tests/` and criterion 2.6 requires this guard to run in the
      build
    """
    override = os.environ.get(EVIDENCE_DIR_ENV)
    if override:
        return Path(override)

    checkout_root = _PACKAGE_PARENT.parent.parent
    if (checkout_root / "pyproject.toml").is_file():
        return checkout_root / "tests" / "fixtures" / "metric_definitions"
    return _PACKAGE_PARENT.parent / "evidence" / "metric_definitions"


def evidence_filename(resource_type: str) -> str:
    """`Microsoft.Compute/virtualMachines` -> `microsoft.compute__virtualmachines.json`.

    Lower-cased because Resource Graph lower-cases `type` and `for_resource_type` folds case
    to match, so the file name follows the same rule the lookup does. `/` becomes `__`
    rather than `_` or `-`, because a single underscore, a hyphen and a period all occur
    **inside** the segments themselves (`Microsoft.Compute`, `flexibleServers`), so
    substituting one of those would let two distinct types collide on one filename.
    """
    return resource_type.lower().replace("/", "__") + ".json"


def load_fixture(resource_type: str, *, directory: Path | None = None) -> dict[str, Any]:
    """The recorded response for `resource_type`. Raises `FileNotFoundError` if absent."""
    root = directory if directory is not None else evidence_directory()
    return json.loads((root / evidence_filename(resource_type)).read_text(encoding="utf-8"))


def _normalized(name: str) -> str:
    """`name` case-folded, trimmed, and with every separator collapsed to one sentinel."""
    folded = name.strip().casefold()
    for character in _SEPARATORS:
        folded = folded.replace(character, _SEPARATOR_SENTINEL)
    return folded


def _reported_metrics(fixture: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """The fixture's metric definitions, keyed by the exact reported name."""
    body = fixture.get("body")
    values = body.get("value") if isinstance(body, Mapping) else None
    reported: dict[str, dict[str, Any]] = {}
    for definition in values or []:
        if not isinstance(definition, Mapping):
            continue
        name_field = definition.get("name")
        name = name_field.get("value") if isinstance(name_field, Mapping) else name_field
        if isinstance(name, str) and name:
            reported[name] = dict(definition)
    return reported


def _walk_strings(value: object, path: str = "$") -> Iterable[tuple[str, str]]:
    """Every string leaf in `value`, with its `$.a[0].b` path."""
    if isinstance(value, Mapping):
        for key, child in value.items():
            yield from _walk_strings(child, f"{path}.{key}")
    elif isinstance(value, (list, tuple)):
        for index, child in enumerate(value):
            yield from _walk_strings(child, f"{path}[{index}]")
    elif isinstance(value, str):
        yield path, value


def _fixture_secret_findings(
    resource_type: str, fixture: Mapping[str, Any]
) -> list[EvidenceFinding]:
    """Req 2.5, 2.11 — the exclusion asserted rather than trusted.

    Checked three ways, because a subscription id can reach a fixture through any of them:
    a **field name** the API returns ids under, a **GUID-shaped** value anywhere, and a
    `/subscriptions/` **path segment** anywhere. The `provenance` block is checked too — it
    is hand-written, which makes it the most likely place for a real id to be pasted.
    """
    findings: list[EvidenceFinding] = []

    for path, value in _walk_strings(fixture):
        leaf = path.rsplit(".", 1)[-1].split("[", 1)[0]
        if leaf in SECRET_FIELD_NAMES:
            findings.append(
                EvidenceFinding(
                    resource_type,
                    None,
                    path,
                    f"the fixture carries a {leaf!r} field, which the API returns as a "
                    f"fully qualified resource id; a metric definition is identical across "
                    f"every resource of one type in one region, so nothing about a "
                    f"particular resource is evidence of anything (Req 2.5)",
                )
            )
        if _GUID_RE.search(value):
            findings.append(
                EvidenceFinding(
                    resource_type,
                    None,
                    path,
                    "the fixture carries a GUID-shaped value, which is the shape of a "
                    "subscription id and a tenant id (Req 2.11)",
                )
            )
        if _SUBSCRIPTION_PATH_RE.search(value):
            findings.append(
                EvidenceFinding(
                    resource_type,
                    None,
                    path,
                    "the fixture carries a '/subscriptions/' path segment, so it names a "
                    "particular subscription (Req 2.11)",
                )
            )

    for key in SECRET_FIELD_NAMES:
        for definition in _reported_metrics(fixture).values():
            if key in definition:
                findings.append(
                    EvidenceFinding(
                        resource_type,
                        str(definition.get("name")),
                        key,
                        f"a metric definition carries the field {key!r} (Req 2.11)",
                    )
                )

    return findings


def _provenance_findings(
    resource_type: str, fixture: Mapping[str, Any]
) -> list[EvidenceFinding]:
    """Req 2.5 — the resource type, the region and a whole-second RFC 3339 `Z` instant."""
    provenance = fixture.get("provenance")
    if not isinstance(provenance, Mapping):
        return [
            EvidenceFinding(
                resource_type, None, "provenance", "the fixture records no provenance block"
            )
        ]

    findings: list[EvidenceFinding] = []
    declared_type = provenance.get("resource_type")
    if declared_type != resource_type:
        findings.append(
            EvidenceFinding(
                resource_type,
                None,
                "provenance.resource_type",
                f"the fixture records the resource type {declared_type!r}; the file name is "
                f"derived from this field, so a mismatch means the evidence for one type is "
                f"filed under another",
            )
        )
    region = provenance.get("region")
    if not isinstance(region, str) or not region.strip():
        findings.append(
            EvidenceFinding(
                resource_type, None, "provenance.region", "the fixture records no region"
            )
        )
    captured = provenance.get("captured_at")
    if not isinstance(captured, str) or not re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", captured
    ):
        findings.append(
            EvidenceFinding(
                resource_type,
                None,
                "provenance.captured_at",
                f"the capture instant must be a UTC RFC 3339 instant with a 'Z' designator "
                f"and whole-second precision, got {captured!r} (Req 2.5)",
            )
        )
    return findings


def check_catalog_evidence(
    catalog: LoadedCatalog | None = None,
    *,
    directory: Path | None = None,
    fixtures: Mapping[str, Mapping[str, Any]] | None = None,
) -> list[EvidenceFinding]:
    """Every disagreement between `catalog` and its recorded evidence.

    Returns findings rather than raising, so a caller reports **all** of them in one run —
    one fix pass clears the build, the same reason `render/themes.py`'s theme guard reports
    every missing `(theme, style)` pair at once.

    `fixtures` supplies the evidence directly, keyed by resource type, for a property test
    generating fixture and catalog pairs. When it is `None` the fixtures are read from
    `directory` (default: :func:`evidence_directory`).
    """
    loaded = catalog if catalog is not None else load_catalog()
    findings: list[EvidenceFinding] = []

    for entry in loaded.resource_types:
        resource_type = entry.resource_type

        if fixtures is not None:
            fixture = fixtures.get(resource_type)
            if fixture is None:
                findings.append(
                    EvidenceFinding(
                        resource_type,
                        None,
                        "fixture",
                        "no recorded Metric Definitions fixture exists for this resource "
                        "type, so an entry was added without the evidence it was derived "
                        "from (Req 2.4)",
                    )
                )
                continue
        else:
            try:
                fixture = load_fixture(resource_type, directory=directory)
            except FileNotFoundError:
                findings.append(
                    EvidenceFinding(
                        resource_type,
                        None,
                        "fixture",
                        f"no recorded Metric Definitions fixture at "
                        f"{evidence_filename(resource_type)!r}, so an entry was added "
                        f"without the evidence it was derived from (Req 2.4)",
                    )
                )
                continue
            findings.extend(_provenance_findings(resource_type, fixture))

        findings.extend(_fixture_secret_findings(resource_type, fixture))
        reported = _reported_metrics(fixture)
        normalized_reported = {_normalized(name): name for name in reported}

        for metric in entry.metrics:
            findings.extend(
                _metric_findings(
                    resource_type,
                    metric_name=metric.name,
                    declared_unit=metric.unit,
                    declared_aggregations=metric.aggregations,
                    reported=reported,
                    normalized_reported=normalized_reported,
                )
            )

    return findings


def _metric_findings(
    resource_type: str,
    *,
    metric_name: str,
    declared_unit: str,
    declared_aggregations: Sequence[str],
    reported: Mapping[str, Mapping[str, Any]],
    normalized_reported: Mapping[str, str],
) -> list[EvidenceFinding]:
    """One declared metric, checked against the fixture (Req 2.2, 2.3, 2.7, 2.9, 2.10)."""
    findings: list[EvidenceFinding] = []
    definition = reported.get(metric_name)

    if definition is None:
        # The near-miss rule first, because it is the more useful message for the same
        # rejection: an exact-string comparison already refuses all four spellings, but it
        # refuses them as "absent", which sends a reader looking for a metric Azure does
        # not have instead of at a typo.
        near = normalized_reported.get(_normalized(metric_name))
        if near is not None:
            findings.append(
                EvidenceFinding(
                    resource_type,
                    metric_name,
                    "name",
                    f"the declared name {metric_name!r} differs from the fixture's "
                    f"{near!r} only by letter case, surrounding whitespace or a "
                    f"substituted separator — the exact ways a portal display name "
                    f"differs from an API metric name (Req 2.7)",
                )
            )
        else:
            findings.append(
                EvidenceFinding(
                    resource_type,
                    metric_name,
                    "name",
                    f"the fixture reports no metric named {metric_name!r}; a guessed name "
                    f"makes a metric permanently uncollectable with nothing failing at run "
                    f"time (Req 2.3)",
                )
            )
        return findings

    reported_unit = definition.get("unit")
    if not isinstance(reported_unit, str):
        findings.append(
            EvidenceFinding(
                resource_type, metric_name, "unit", "the fixture reports no unit"
            )
        )
    elif reported_unit in UNMAPPED_UNITS:
        findings.append(
            EvidenceFinding(
                resource_type,
                metric_name,
                "unit",
                f"the fixture reports the unit {reported_unit!r}, which the unit mapping "
                f"has no term for: {UNMAPPED_UNITS[reported_unit]} (Req 2.10)",
            )
        )
    elif reported_unit not in UNIT_MAPPING:
        findings.append(
            EvidenceFinding(
                resource_type,
                metric_name,
                "unit",
                f"the fixture reports the unit {reported_unit!r}, which the unit mapping "
                f"has no term for and which is not among the units recorded as "
                f"deliberately unmapped; add it to one or the other explicitly (Req 2.10)",
            )
        )
    else:
        expected = UNIT_MAPPING[reported_unit]
        if declared_unit != expected:
            findings.append(
                EvidenceFinding(
                    resource_type,
                    metric_name,
                    "unit",
                    f"the catalog declares the unit {declared_unit!r}; the fixture reports "
                    f"{reported_unit!r}, whose mapped term is {expected!r}. The unit family "
                    f"selects the sketch, so a wrong unit sketches the wrong distribution "
                    f"(Req 2.2, 2.3)",
                )
            )

    supported = definition.get("supportedAggregationTypes")
    supported_set = {item for item in supported or [] if isinstance(item, str)}
    unsupported = [
        aggregation
        for aggregation in declared_aggregations
        if aggregation not in supported_set
    ]
    if unsupported:
        findings.append(
            EvidenceFinding(
                resource_type,
                metric_name,
                "aggregations",
                f"the catalog requests {unsupported} which the fixture does not report as "
                f"supported; it reports {sorted(supported_set)}. Asking Azure for an "
                f"aggregation it does not serve returns intervals with nothing in them "
                f"(Req 2.2, 2.3)",
            )
        )

    return findings


def assert_catalog_is_evidenced(
    catalog: LoadedCatalog | None = None, *, directory: Path | None = None
) -> None:
    """Raise `AssertionError` naming every disagreement, or return.

    The form the suite and the image build both call. Every finding in one message, so one
    fix pass clears it.
    """
    findings = check_catalog_evidence(catalog, directory=directory)
    if findings:
        joined = "\n  ".join(str(finding) for finding in findings)
        raise AssertionError(
            f"{len(findings)} catalog entr(y/ies) disagree with the recorded Metric "
            f"Definitions evidence committed beside them:\n  {joined}"
        )


def _main(argv: Sequence[str]) -> int:
    """`python -m reporting_agent.catalog.evidence --assert-build` (Req 2.6).

    The same entry-point shape `compile/ast.py` and `render/themes.py` use, so the
    Dockerfile's three build guards read identically.
    """
    if "--assert-build" not in argv:
        print(
            "usage: python -m reporting_agent.catalog.evidence --assert-build",
            file=sys.stderr,
        )
        return 2

    catalog = load_catalog()
    directory = evidence_directory()
    if not directory.is_dir():
        print(
            f"the evidence directory {directory} does not exist, so the catalog guard "
            f"would pass by checking nothing",
            file=sys.stderr,
        )
        return 1

    try:
        assert_catalog_is_evidenced(catalog, directory=directory)
    except AssertionError as failure:
        print(str(failure), file=sys.stderr)
        return 1

    metrics = sum(len(entry.metrics) for entry in catalog.resource_types)
    print(
        f"catalog evidence ok: {metrics} metric(s) across "
        f"{len(catalog.resource_types)} resource type(s) checked against "
        f"{directory}"
    )
    return 0


if __name__ == "__main__":  # pragma: no cover - exercised through the Dockerfile
    raise SystemExit(_main(sys.argv[1:]))
