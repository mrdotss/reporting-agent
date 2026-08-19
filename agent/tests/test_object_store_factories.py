"""The three seams where production — and only production — builds an object store.

## What this exists to stop

Every test in this suite injects `object_store`. That is the right default: a unit test
has no business reaching S3, and the injection is what makes the collector and the
document phases testable at all. But it has a cost that went uncollected until a live
run paid it — the *fallback* branch, the `or _s3_store(...)` that runs when nothing was
injected, is executed by no test anywhere. It is the one line of the pipeline whose only
caller is a deployed container. `test_report_run_end_to_end.py` gets closest and still
misses it: it names both `_s3_store` seams and `monkeypatch.setattr`s them away, so the
end-to-end run proves everything about the pipeline except that its store can be built.

So it drifted. `report_pipeline._s3_store` passed `region_name=` — boto3's keyword, not
`S3ObjectStore`'s, which is `region`. Type checking does not catch it because the store
is constructed behind a local import inside a function returning the `ObjectStore`
protocol. The suite was green, the image built, the run collected 23 of 23 resources over
four minutes of Azure calls, and then died with a `TypeError` on the first line that
tried to write the snapshot.

The fix is one word. This file is the part that matters: it *calls* all three factories,
so a keyword that the constructor does not accept is a red test rather than a wasted run.
Each assertion is deliberately about what reaches the boto3 client, not about internal
attributes — the region only matters because it selects an endpoint, so that is where it
is checked.

Constructing a store resolves no credentials: `S3ObjectStore` builds its client on first
use, which is what lets this file exercise the real factories rather than a mimic of them.
"""

from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any

import pytest

from reporting_agent.storage.s3 import S3ObjectStore

BUCKET = "mr-harness"
REGION = "us-east-1"


@pytest.fixture
def captured_client_kwargs(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Intercept the lazy boto3 construction and record what it was handed.

    The store is asked for its `client` property to trigger this; nothing else in the
    file touches AWS, and this stub means nothing in the file could.
    """
    seen: dict[str, Any] = {}

    def fake_client(service: str, **kwargs: Any) -> object:
        seen["service"] = service
        seen.update(kwargs)
        return object()

    monkeypatch.setattr("reporting_agent.storage.s3.boto3.client", fake_client)
    return seen


def _report_pipeline_store() -> object:
    from reporting_agent.report_pipeline import _s3_store

    return _s3_store(BUCKET, REGION)


def _collect_pipeline_store() -> object:
    from reporting_agent.collect.pipeline import _s3_store

    return _s3_store(BUCKET, REGION)


def _provider_store() -> object:
    from reporting_agent.azure.provider import _default_object_store

    return _default_object_store()


#: Every seam at which application code names `S3ObjectStore`. Kept as a table so adding
#: a fourth is one line, and so the enumeration guard below can assert the table is whole.
FACTORIES: Mapping[str, Callable[[], object]] = {
    "report_pipeline._s3_store": _report_pipeline_store,
    "collect.pipeline._s3_store": _collect_pipeline_store,
    "azure.provider._default_object_store": _provider_store,
}


@pytest.fixture(autouse=True)
def _configured(monkeypatch: pytest.MonkeyPatch) -> None:
    """`_default_object_store` reads the configuration itself, so the environment has to
    hold one. The other two take their bucket and region as arguments; setting these is
    harmless for them and keeps the parametrization uniform."""
    monkeypatch.setenv("AWS_REGION", REGION)
    monkeypatch.setenv("RPT_ARTIFACT_BUCKET", BUCKET)
    monkeypatch.setenv("RPT_PROSE_MODEL_ID", "anthropic.claude-3-5-haiku-20241022-v1:0")


@pytest.mark.parametrize("name", sorted(FACTORIES))
def test_each_factory_constructs_a_store(name: str) -> None:
    """The regression itself. A keyword the constructor does not accept raises here.

    This is the whole assertion the live failure needed and did not have: it does not
    matter what the returned store *is* until it can be built at all.
    """
    store = FACTORIES[name]()

    assert isinstance(store, S3ObjectStore)


@pytest.mark.parametrize("name", sorted(FACTORIES))
def test_each_factory_binds_the_configured_bucket(name: str) -> None:
    store = FACTORIES[name]()

    assert isinstance(store, S3ObjectStore)
    assert store.bucket == BUCKET


@pytest.mark.parametrize("name", sorted(FACTORIES))
def test_each_factory_reaches_boto3_with_the_configured_region(
    name: str, captured_client_kwargs: dict[str, Any]
) -> None:
    """The region has to survive all the way to the client, not merely be accepted.

    A factory that swallowed its region — passing nothing, or storing it under a name the
    property does not read — would pass the two tests above and still build a client
    against the wrong endpoint. That is the same class of defect as the keyword mismatch,
    one layer further in, so it gets its own assertion rather than being assumed.
    """
    store = FACTORIES[name]()

    _ = store.client  # forces the lazy construction the fixture intercepts

    assert captured_client_kwargs["service"] == "s3"
    assert captured_client_kwargs["region_name"] == REGION


def test_no_application_module_builds_a_store_outside_this_table() -> None:
    """The table above is only a guard while it is complete.

    A fourth factory added tomorrow would be exactly as untested as the three were, so
    this counts the construction sites in `src/` and fails when one appears that the
    table does not name. Test files and the store's own module are excluded: the former
    are not production seams, and the latter is the class itself.
    """
    from pathlib import Path

    source_root = Path(__file__).resolve().parents[1] / "src" / "reporting_agent"
    own_module = source_root / "storage" / "s3.py"

    constructing: set[str] = set()
    for path in source_root.rglob("*.py"):
        if path == own_module:
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if "S3ObjectStore(" in line and not line.lstrip().startswith("#"):
                constructing.add(str(path.relative_to(source_root)))

    assert len(constructing) == len(FACTORIES), (
        "these modules construct an S3ObjectStore: "
        + "; ".join(sorted(constructing))
        + " — every one of them must be called by FACTORIES above, because a "
        "construction site no test executes is the defect this file exists for"
    )
