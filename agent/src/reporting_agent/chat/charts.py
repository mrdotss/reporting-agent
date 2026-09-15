"""Charts in a chat answer, built from facts the runtime read (ask-chat Req 9).

A model never draws a number. It asks for a chart the way it cites a figure — by fact id —
and this module builds the chart from values the runtime already holds:

- **compare** — two to twelve facts sharing one unit, one bar each. Each bar's value is the
  fact's own decimal string and its label the fact's own formatted string, so a bar and the
  figure chip beside it can never disagree.
- **daily** — one fact whose statistic the snapshot also carries per local day. The series
  is read from that snapshot's `day_buckets`, the same buckets a report's time-series chart
  plots; the model named which statistic, never its values.

A request that names an unknown fact, mixes units, or has nothing to plot builds nothing, and
the directive is dropped from the answer rather than rendered as an empty or guessed chart.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

__all__ = [
    "CHART_KINDS",
    "MAX_COMPARE_BARS",
    "MAX_DAILY_POINTS",
    "ChartRequest",
    "SeriesIndex",
    "build_chart",
    "series_index_from_snapshot",
]

CHART_KINDS: Final[frozenset[str]] = frozenset({"compare", "daily"})
MAX_COMPARE_BARS: Final[int] = 12
MAX_DAILY_POINTS: Final[int] = 93
MAX_TITLE_CHARS: Final[int] = 80

_DECIMAL: Final[re.Pattern[str]] = re.compile(r"^-?\d+(?:\.\d+)?$")
_UNSAFE: Final[re.Pattern[str]] = re.compile(r"[<>⟦⟧\r\n\t]+")

SeriesKey = tuple[str, str, str, str, str]
"""`(source id, resource id casefolded, metric, statistic, instance)` — one daily series."""

SeriesIndex = Mapping[SeriesKey, Sequence[tuple[str, str]]]
"""A series key to its `(local_day, decimal value)` points, in day order."""


@dataclass(frozen=True, slots=True)
class ChartRequest:
    kind: str
    fact_ids: tuple[str, ...]
    title: str


def series_index_from_snapshot(
    snapshot: Mapping[str, Any], source_id: str
) -> dict[SeriesKey, list[tuple[str, str]]]:
    """Every per-day statistic a snapshot carries, keyed for :func:`build_chart`."""
    index: dict[SeriesKey, list[tuple[str, str]]] = {}
    resources = snapshot.get("resources")
    if not isinstance(resources, Sequence):
        return index
    for resource in resources:
        if not isinstance(resource, Mapping):
            continue
        resource_id = resource.get("resource_id")
        buckets = resource.get("day_buckets")
        if not isinstance(resource_id, str) or not isinstance(buckets, Sequence):
            continue
        for bucket in buckets:
            if not isinstance(bucket, Mapping):
                continue
            day = bucket.get("local_day")
            statistics = bucket.get("statistics")
            if not isinstance(day, str) or not isinstance(statistics, Sequence):
                continue
            for statistic in statistics:
                if not isinstance(statistic, Mapping):
                    continue
                metric = statistic.get("metric")
                kind = statistic.get("statistic")
                value = statistic.get("value")
                if not (isinstance(metric, str) and isinstance(kind, str) and isinstance(value, str)):
                    continue
                if not _DECIMAL.match(value):
                    continue
                instance = statistic.get("instance")
                key: SeriesKey = (
                    source_id,
                    resource_id.casefold(),
                    metric,
                    kind,
                    instance if isinstance(instance, str) else "",
                )
                index.setdefault(key, []).append((day, value))
    for points in index.values():
        points.sort(key=lambda point: point[0])
    return index


def build_chart(
    request: ChartRequest,
    *,
    chart_id: str,
    facts: Mapping[str, Any],
    series: SeriesIndex,
    format_value: Any,
) -> dict[str, Any] | None:
    """The chart a request names, as plain data, or `None` when it cannot be built.

    `facts` maps a fact id to a `grounding.Fact`; `format_value(value, unit)` formats a
    decimal string the way a figure is formatted, so a daily point reads like a chip.
    """
    if request.kind not in CHART_KINDS:
        return None
    chosen = [facts[fact_id] for fact_id in request.fact_ids if fact_id in facts]
    if len(chosen) != len(request.fact_ids) or not chosen:
        return None
    if any(fact.value is None or fact.unit is None for fact in chosen):
        return None

    source = "live" if all(fact.source == "live" for fact in chosen) else (
        "mixed" if any(fact.source == "live" for fact in chosen) else "verified"
    )

    if request.kind == "compare":
        if not 2 <= len(chosen) <= MAX_COMPARE_BARS:
            return None
        units = {fact.unit for fact in chosen}
        if len(units) != 1:
            return None
        labels = _bar_labels([fact.label for fact in chosen])
        bars = [
            {
                "fact_id": fact_id,
                "label": label,
                "value": fact.value,
                "formatted": fact.formatted,
            }
            for fact_id, fact, label in zip(request.fact_ids, chosen, labels, strict=True)
        ]
        return {
            "id": chart_id,
            "kind": "compare",
            "title": _title(request.title, chosen),
            "unit": chosen[0].unit,
            "source": source,
            "bars": bars,
        }

    # daily
    if len(chosen) != 1:
        return None
    fact = chosen[0]
    key = fact.series_key
    if key is None:
        return None
    points = list(series.get(key, ()))[:MAX_DAILY_POINTS]
    if len(points) < 2:
        return None
    return {
        "id": chart_id,
        "kind": "daily",
        "title": _title(request.title, chosen),
        "unit": fact.unit,
        "source": source,
        "series_label": fact.label,
        "points": [
            {"day": day, "value": value, "formatted": format_value(value, fact.unit)}
            for day, value in points
        ],
    }


def _bar_labels(labels: Sequence[str]) -> list[str]:
    """Each bar's own words: the label segments that are not shared by every bar.

    `vm-01 · Percentage CPU · avg` and `vm-02 · Percentage CPU · avg` label as `vm-01` and
    `vm-02` — the metric is the chart's, the machine is the bar's. Two price facts differing
    only by operating system label as `Linux` and `Windows`. A label left empty falls back to
    the whole label.
    """
    split = [label.split(" · ") for label in labels]
    shared = set(split[0]).intersection(*split[1:]) if split else set()
    result = []
    for parts, label in zip(split, labels, strict=True):
        own = [part for part in parts if part not in shared]
        result.append(_safe(" · ".join(own) if own else label))
    return result


def _title(requested: str, chosen: Sequence[Any]) -> str:
    title = _safe(requested)
    if title:
        return title[:MAX_TITLE_CHARS]
    parts = chosen[0].label.split(" · ")
    return _safe(" · ".join(parts[1:]) if len(parts) > 1 else chosen[0].label)[:MAX_TITLE_CHARS]


def _safe(value: str) -> str:
    return _UNSAFE.sub(" ", value).strip()
