"""The Req 5.4 narrowing is invariant under resource-type recasing.

**Validates: Req 5.4, 3.12, 45.1**

Azure resource type names are **case-insensitive**, and Resource Graph lowercases `type` in
its response body. So one type reaches the narrowing under up to three independent spellings
in one run: the definition's `metrics` key, the definition's `scope.resource_types` entry, and
the Metric_Catalog's own declaration. `Microsoft.Compute/virtualMachines` and
`microsoft.compute/virtualmachines` are the same type, and every comparison between two of
those spellings has to agree with that.

The invariant, stated once: **recasing every resource type in a definition changes nothing
about what the run requests.** The named cases in `tests/test_report_pipeline.py` are
instances of it; this is the general statement, and it is asserted over the shared definition
corpus rather than over generated definitions because the corpus is what both halves of the
mirror already agree is a real definition.

What it kills, and why the suite did not already:

* **An exact-case catalog lookup** in `report_pipeline._derived_source_metrics`. It fails
  **closed** — `()` — so a derived statistic's source metric is dropped from the request, the
  figure it feeds has no input, and nothing anywhere names a spelling mismatch. The run still
  renders, still verifies and still completes, which is exactly why 2739 passing tests did not
  notice.
* **An exact-case selection lookup** in `collect/pipeline._requested_metrics`, which empties
  the intersection for the affected type.
* **A casefolded index that overwrites instead of unioning.** One type legitimately arrives
  under two keys, because `union_scope` folds a top-N ranking metric into the *scope's*
  spelling while the selection is keyed by the *definition's*. Last-one-wins then drops either
  the selection or the ranking metric depending on dict iteration order — a defect that would
  reproduce intermittently.

A definition the corpus declares as a **rejection** is skipped: `requested_metric_union` runs
after `_assert_compilable`, so it is never asked about a definition the validator refused, and
a deliberately malformed scope has no meaningful union to be invariant about.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any, Final

import pytest
from hypothesis import example, given, settings
from hypothesis import strategies as st

import definition_corpus as corpus
from reporting_agent.catalog.loader import load_catalog
from reporting_agent.report_pipeline import requested_metric_union

CATALOG: Final = load_catalog()

# The three recasings the fix has to be invariant under. `.lower()` is the one that matters
# most in practice — it is what Resource Graph returns, so it is what any Task 13 affordance
# seeding a `metrics` map from observed inventory will write.
RECASINGS: Final[dict[str, Callable[[str], str]]] = {
    "lower": str.lower,
    "upper": str.upper,
    "catalog": lambda name: _catalog_spelling(name),
    "swapped": str.swapcase,
}


def _catalog_spelling(name: str) -> str:
    """`name` as the catalog declares it, or unchanged when the catalog declares nothing.

    Included as a recasing of its own because it is the spelling the *fixed* code returns its
    keys in, so a comparison that only ever saw lowercase input could pass while the
    normalization ran the wrong way.
    """
    entry = CATALOG.for_resource_type(name)
    return entry.resource_type if entry is not None else name


def _recase(document: object, recase: Callable[[str], str]) -> Any:
    """`document` with every resource type respelled, and nothing else touched.

    Three places carry one: the `metrics` map's keys, `scope.resource_types`, and every
    block's `scope_override.resource_types` at either nesting level. A recasing that missed
    one of the three would make the property weaker in the exact way the defect was — it is
    the *disagreement* between two spellings that breaks, not a uniform respelling.
    """
    if not isinstance(document, dict):
        return document

    result = dict(document)

    metrics = result.get("metrics")
    if isinstance(metrics, dict):
        respelled: dict[str, Any] = {}
        for resource_type, items in metrics.items():
            key = recase(resource_type) if isinstance(resource_type, str) else resource_type
            respelled[key] = items
        result["metrics"] = respelled

    if isinstance(result.get("scope"), dict):
        result["scope"] = _recase_scope(result["scope"], recase)

    blocks = result.get("blocks")
    if isinstance(blocks, list):
        result["blocks"] = [_recase_block(block, recase) for block in blocks]

    return result


def _recase_scope(scope: object, recase: Callable[[str], str]) -> Any:
    if not isinstance(scope, dict):
        return scope
    result = dict(scope)
    types = result.get("resource_types")
    if isinstance(types, list):
        result["resource_types"] = [
            recase(entry) if isinstance(entry, str) else entry for entry in types
        ]
    return result


def _recase_block(block: object, recase: Callable[[str], str]) -> Any:
    if not isinstance(block, dict):
        return block
    result = dict(block)
    if "scope_override" in result:
        result["scope_override"] = _recase_scope(result["scope_override"], recase)
    columns = result.get("columns")
    if isinstance(columns, list):
        result["columns"] = [
            [_recase_block(child, recase) for child in column]
            if isinstance(column, list)
            else column
            for column in columns
        ]
    return result


class CatalogCapabilities:
    """A provider whose capability map is the catalog's, which is what the real one is.

    `AzureProvider.capabilities()` reads `metrics` straight out of the loaded catalog and
    returns platform metric names only, so building the fake from the same catalog keeps the
    third spelling in play — the one `_requested_metrics` compares the scope against — without
    dragging a subscription, a credential or the Azure SDK into a property test.
    """

    def capabilities(self) -> dict[str, Any]:
        return {
            "metrics": {
                entry.resource_type: sorted(metric.name for metric in entry.metrics)
                for entry in CATALOG.resource_types
                if entry.has_valid_entries
            }
        }


def _scope_types(document: object) -> list[str]:
    """The resource types the run's `scope` would carry — the union across the definition.

    The app forms this union and puts it in the invoke payload, so a property test that read
    only `definition["scope"]` would miss the block overrides that widen it, and with them the
    scope-versus-capability comparison that is one of the three at issue.
    """
    found: list[str] = []

    def add(scope: object) -> None:
        if not isinstance(scope, dict):
            return
        types = scope.get("resource_types")
        if isinstance(types, list):
            found.extend(entry for entry in types if isinstance(entry, str))

    def walk(blocks: object) -> None:
        if not isinstance(blocks, list):
            return
        for block in blocks:
            if not isinstance(block, dict):
                continue
            add(block.get("scope_override"))
            columns = block.get("columns")
            if isinstance(columns, list):
                for column in columns:
                    walk(column)

    if isinstance(document, dict):
        add(document.get("scope"))
        walk(document.get("blocks"))
    return found


def requested_at_the_port(document: object) -> dict[str, list[str]]:
    """What one definition actually causes to be requested from Azure.

    **Both stages, composed the way `run_generate_report` composes them**, and that
    composition is the point. Asserting over `requested_metric_union` alone would miss
    `_requested_metrics`' own two comparisons entirely, and it merges nothing — so a union
    carrying one type under two keys still looks correct in isolation while the request built
    from it drops half the metrics. The map this returns is the one whose keys reach
    `CollectRequest.metrics_by_resource_type`.
    """
    from reporting_agent.collect.pipeline import _requested_metrics

    union = requested_metric_union(document, CATALOG)
    scope = {"resource_types": _scope_types(document)}
    return _requested_metrics(
        CatalogCapabilities(),  # type: ignore[arg-type]
        scope,  # type: ignore[arg-type]
        union,
    )


ACCEPTED: Final[tuple[corpus.CorpusEntry, ...]] = tuple(
    entry for entry in corpus.load_manifest() if not entry.rejects
)


def test_the_corpus_offers_something_to_be_invariant_about() -> None:
    """A guard on the guard. If the corpus ever held only rejections, or only definitions
    whose scope names no resource type, the property below would pass over an empty space and
    say nothing — the failure mode that makes a green suite worse than no suite."""
    assert ACCEPTED, "the corpus declares no accepted definition"

    with_types = [
        entry
        for entry in ACCEPTED
        if isinstance(entry.document, dict)
        and isinstance(entry.document.get("metrics"), dict)
        and entry.document["metrics"]
    ]
    assert with_types, "no accepted fixture carries a metric selection to recase"


def _fixture(name: str) -> corpus.CorpusEntry:
    """One corpus fixture by file name, for an `@example`.

    Raises rather than skipping if the fixture is renamed: a declared counterexample that
    quietly stops running is worse than one that fails, because Req 42.8's whole point is that
    a case which found a defect keeps being checked.
    """
    for entry in ACCEPTED:
        if entry.file == name:
            return entry
    raise AssertionError(f"the corpus no longer declares an accepted fixture named {name!r}")


# The two cases the defect was found with, retained per Req 42.8.
#
# `lower` on the fixture carrying block scope overrides is the reproduction: lowercase is what
# Resource Graph returns, so it is what any inventory-seeded `metrics` map will hold, and the
# overrides mean the scope union is assembled from more than one place. `swapped` is the
# nastier shape — the definition's spelling disagreeing with the catalog's in *both*
# directions at once, which a normalization applied in only one direction still passes.
@example(entry=_fixture("accept-block-scope-overrides.json"), recasing="lower")
@example(entry=_fixture("accept-block-scope-overrides.json"), recasing="swapped")
@settings(max_examples=200)
@given(
    entry=st.sampled_from(ACCEPTED),
    recasing=st.sampled_from(sorted(RECASINGS)),
)
def test_recasing_every_resource_type_leaves_the_request_identical(
    entry: corpus.CorpusEntry, recasing: str
) -> None:
    """Req 5.4 with Req 3.12 — the invariant.

    The baseline is the corpus fixture as written; the comparison is the same fixture with
    every resource type respelled. Both go through the real `requested_metric_union` against
    the real catalog.
    """
    baseline = requested_at_the_port(entry.document)
    respelled = requested_at_the_port(_recase(entry.document, RECASINGS[recasing]))

    assert respelled == baseline, (
        f"{entry.file} under {recasing!r} requested a different metric set: "
        f"{respelled} != {baseline}"
    )


@pytest.mark.parametrize("recasing", sorted(RECASINGS))
def test_no_recasing_empties_a_request_that_was_not_empty(recasing: str) -> None:
    """The specific shape of the defect, asserted as its own case.

    Every failure mode this property targets fails **closed** — an empty request rather than a
    wrong one — so "not empty" is the assertion that catches it soonest and reads most
    plainly in a failure. Equality above subsumes this; it is here because a future change
    that weakened the comparison would still have to explain deleting this.
    """
    checked = 0
    for entry in ACCEPTED:
        baseline = requested_at_the_port(entry.document)
        if not any(names for names in baseline.values()):
            continue
        checked += 1
        respelled = requested_at_the_port(_recase(entry.document, RECASINGS[recasing]))
        assert any(names for names in respelled.values()), (
            f"{entry.file} requested metrics as written and none under {recasing!r}: a "
            f"resource-type comparison failed closed. baseline={baseline}"
        )

    # Without this the loop above would pass by skipping every fixture, which is the same
    # green-for-the-wrong-reason failure the corpus guard at the top of this module prevents.
    assert checked, "no accepted fixture requested any metric, so nothing was compared"
