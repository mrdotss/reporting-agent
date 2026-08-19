"""The archive has to be readable by the only thing that reads it.

## What this exists to stop

`collect/archive.py` writes a raw response so `verify/replay.py` can re-run the
aggregation over it and prove the snapshot reproducible (Req 31.1). That makes the two
modules a single round trip, and a round trip is only correct end to end — either half
can be impeccable on its own while the pair loses data.

Which is what happened. The Azure SDK hands live collection a `Decimal` for `total`,
`minimum` and `maximum`. The archive serializes that Decimal to its exact digit string,
deliberately, so no precision is lost to a float. `json.loads` on the way back yields a
`str`. And `_as_decimal` — the reader on *both* sides — accepted `int`, `float` and
`Decimal` but not `str`, so every value the archive had preserved perfectly came back
classified as absent.

The damage was silent and total: each such interval became an `interval_counts_missing`
gap, its samples left the count, `max` collapsed to nothing, and the recomputed digest
could not match. `REPLAY_MISMATCH` on any subscription whose metrics carry a fractional
value — which is all of them. On the first live run to reach verification, the three
metrics whose totals are whole byte counts replayed exactly and the five with fractional
values did not.

Every existing replay test passed throughout, because their fixtures use whole numbers.
That is the gap this file closes: it asserts the **round trip**, with values that only a
round trip can break, rather than asserting each half against a fixture written in the
one shape that happens to survive.
"""

from __future__ import annotations

import gzip
import json
from decimal import Decimal
from typing import Any

import pytest

from reporting_agent.azure.metrics import _as_decimal, fold_resource_metrics
from reporting_agent.collect.accumulate import new_accumulator

RESOURCE = (
    "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg"
    "/providers/Microsoft.Compute/virtualMachines/vm-01"
)


def _json_default(value: object) -> str:
    """The archive's own encoder hook, imported by behaviour rather than by name so this
    file fails if `archive.py` stops rendering a Decimal as its digit string."""
    from reporting_agent.collect.archive import _json_default as real

    return real(value)


def _entry(metric: str, points: list[dict[str, Any]]) -> dict[str, Any]:
    return {
        "id": f"{RESOURCE}/providers/Microsoft.Insights/metrics/{metric}",
        "name": {"value": metric, "localizedValue": metric},
        "unit": "Bytes",
        "errorCode": "Success",
        "timeseries": [{"data": points}],
    }


#: Deliberately fractional, and as `Decimal` — the shape the real SDK produces and the
#: one every existing replay fixture avoids by using whole numbers.
FRACTIONAL = [
    {
        "timeStamp": "2026-07-01T00:00:00Z",
        "total": Decimal("66829984.11"),
        "count": 60,
        "minimum": Decimal("94242.72"),
        "maximum": Decimal("5565981.11"),
    },
    {
        "timeStamp": "2026-07-01T01:00:00Z",
        "total": Decimal("20.98"),
        "count": 119,
        "minimum": Decimal("0.09"),
        "maximum": Decimal("1.27"),
    },
]

WHOLE = [
    {
        "timeStamp": "2026-07-01T00:00:00Z",
        "total": 2736471,
        "count": 60,
        "minimum": 35928,
        "maximum": 122146,
    },
]


def _fold(points: list[dict[str, Any]]) -> tuple[Any, list[Any]]:
    accumulator, _ = new_accumulator(
        "magnitude", resource_id=RESOURCE, metric="Disk Write Bytes", excluded=False
    )
    gaps = fold_resource_metrics(
        resource_id=RESOURCE,
        entries=[_entry("Disk Write Bytes", points)],
        requested_metric_names=["Disk Write Bytes"],
        accumulators={(RESOURCE, "Disk Write Bytes"): accumulator},
        day_fold=None,
    )
    return accumulator, gaps


def _through_the_archive(points: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Exactly what the archive does to a body and what replay gets back: serialize with
    the archive's encoder, gzip it, and re-read with a plain `json.loads`."""
    body = {"value": [_entry("Disk Write Bytes", points)]}
    written = gzip.compress(json.dumps(body, default=_json_default).encode("utf-8"))
    recovered = json.loads(gzip.decompress(written))
    return recovered["value"][0]["timeseries"][0]["data"]


@pytest.mark.parametrize(
    ("label", "points"),
    [("fractional decimals", FRACTIONAL), ("whole numbers", WHOLE)],
)
def test_a_body_folds_identically_before_and_after_the_archive(
    label: str, points: list[dict[str, Any]]
) -> None:
    """The invariant that was missing.

    `whole numbers` is the case the existing fixtures already cover and it passed
    throughout the defect — it is here as the control, so the parametrization shows the
    fault is about the *shape of the value* and not about archiving at all.
    """
    live, live_gaps = _fold(points)
    replayed, replayed_gaps = _fold(_through_the_archive(points))

    assert replayed.count == live.count, label
    assert replayed.total == live.total, label
    assert replayed.minimum == live.minimum, label
    assert replayed.maximum == live.maximum, label
    assert len(replayed_gaps) == len(live_gaps), label


def test_the_archive_preserves_a_decimal_exactly_as_its_digits() -> None:
    """The write half, asserted on its own so a regression is attributable.

    If this fails, the archive is losing precision and the round-trip test above would
    fail with it — this is what says which half moved.
    """
    recovered = _through_the_archive(FRACTIONAL)

    assert recovered[0]["total"] == "66829984.11"
    assert recovered[0]["maximum"] == "5565981.11"


def test_a_decimal_string_reads_back_as_the_same_decimal() -> None:
    """The read half. `_as_decimal` is the seam the round trip runs through."""
    assert _as_decimal("66829984.11") == Decimal("66829984.11")
    assert _as_decimal("0") == Decimal(0)
    assert _as_decimal("-1.5") == Decimal("-1.5")


@pytest.mark.parametrize("value", ["", "  ", "abc", "1.2.3", "NaN%", None, [], {}, True])
def test_a_value_that_is_not_a_number_is_still_absent(value: object) -> None:
    """Accepting strings must not accept *any* string.

    A malformed body has to classify as a gap rather than raise mid-fold, and `True` is
    here because `bool` is an `int` subclass — a JSON `true` reaching a numeric leaf is
    a malformed body, not the number one.
    """
    assert _as_decimal(value) is None
