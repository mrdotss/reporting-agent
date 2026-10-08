"""Charts in a chat answer, built from facts the runtime read (ask-chat Req 9).

A model never draws a number. It asks for a chart the way it cites a figure — by fact id —
and this module builds the chart from values the runtime already holds:

- **compare** — two to twelve facts sharing one unit, one bar each. Each bar's value is the
  fact's own decimal string and its label the fact's own formatted string, so a bar and the
  figure chip beside it can never disagree.
- **daily** — one fact whose statistic the snapshot also carries per local day. The series
  is read from that snapshot's `day_buckets`, the same buckets a report's time-series chart
  plots; the model named which statistic, never its values. Kept for answers stored before
  `trend`; a new answer asks for `trend`.
- **trend** — one to four such facts sharing a unit, one daily series each, so machines can
  be read against one another. Each series says whether it is verified or live.
- **spread** — per-machine statistics of one metric (average, p95, max, …) laid on one
  scale, to show the room each machine has. The facts are grouped by the machine and metric
  their own series key names; nothing is inferred from a label.
- **stats** — two to four headline figures as tiles, each with its daily series when the
  snapshot carries one.

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
    "MAX_SPREAD_ROWS",
    "MAX_STAT_TILES",
    "MAX_TREND_SERIES",
    "ChartRequest",
    "SeriesIndex",
    "build_chart",
    "series_index_from_snapshot",
]

CHART_KINDS: Final[frozenset[str]] = frozenset({"compare", "daily", "trend", "spread", "stats"})
MAX_COMPARE_BARS: Final[int] = 12
MAX_TREND_SERIES: Final[int] = 4
"""Four lines is what one chart can carry with a distinct colour, dash and marker each."""
MAX_SPREAD_ROWS: Final[int] = 12
MAX_STAT_TILES: Final[int] = 4
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
    if len(set(request.fact_ids)) != len(request.fact_ids):
        return None
    chosen = [facts[fact_id] for fact_id in request.fact_ids if fact_id in facts]
    if len(chosen) != len(request.fact_ids) or not chosen:
        return None

    source = "live" if all(fact.source == "live" for fact in chosen) else (
        "mixed" if any(fact.source == "live" for fact in chosen) else "verified"
    )

    if request.kind == "stats":
        return _stats(request, chart_id, chosen, source, series, format_value)

    if any(fact.value is None or fact.unit is None for fact in chosen):
        return None

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
                "source": _series_source(fact),
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

    if request.kind == "trend":
        return _trend(request, chart_id, chosen, source, series, format_value)
    if request.kind == "spread":
        return _spread(request, chart_id, chosen, source)

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
            {"day": day, "value": value, "formatted": _point_format(fact, format_value)(value, fact.unit)}
            for day, value in points
        ],
    }


def _point_format(fact: Any, format_value: Any) -> Any:
    """Formats a fact's daily points in the unit its own figure reads in.

    A report that pins `bytes_as_gib` prints memory as `0.19 GiB`; its daily points are
    stored in bytes and would otherwise read `211,029,208.0 bytes` beside that chip.
    """
    if fact.unit == "bytes" and isinstance(fact.formatted, str) and fact.formatted.endswith(" GiB"):
        return lambda value, unit: format_value(value, unit, gib=True)
    return format_value


def _series_source(fact: Any) -> str:
    return "live" if fact.source == "live" else "verified"


def _points(fact: Any, series: SeriesIndex, format_value: Any) -> list[dict[str, str]]:
    """A fact's daily series as chart points, or `[]` when the snapshot carries none."""
    if fact.series_key is None or fact.unit is None:
        return []
    points = list(series.get(fact.series_key, ()))[:MAX_DAILY_POINTS]
    if len(points) < 2:
        return []
    point_format = _point_format(fact, format_value)
    return [{"day": day, "value": value, "formatted": point_format(value, fact.unit)} for day, value in points]


def _trend(
    request: ChartRequest,
    chart_id: str,
    chosen: Sequence[Any],
    source: str,
    series: SeriesIndex,
    format_value: Any,
) -> dict[str, Any] | None:
    """One to four daily series sharing a unit. Every named fact must have its series."""
    if not 1 <= len(chosen) <= MAX_TREND_SERIES:
        return None
    if len({fact.unit for fact in chosen}) != 1:
        return None
    drawn = [_points(fact, series, format_value) for fact in chosen]
    if any(not points for points in drawn):
        return None
    labels = _bar_labels([fact.label for fact in chosen]) if len(chosen) > 1 else [_safe(chosen[0].label)]
    return {
        "id": chart_id,
        "kind": "trend",
        "title": _title(request.title, chosen),
        "unit": chosen[0].unit,
        "source": source,
        "series": [
            {"fact_id": fact_id, "label": label, "source": _series_source(fact), "points": points}
            for fact_id, fact, label, points in zip(request.fact_ids, chosen, labels, drawn, strict=True)
        ],
    }


def _spread(request: ChartRequest, chart_id: str, chosen: Sequence[Any], source: str) -> dict[str, Any] | None:
    """Per-machine statistics of one metric on one scale.

    Grouped by the series key without its statistic — the source, the resource, the metric
    and the instance — so two statistics belong to one row only when the snapshot says they
    measure the same thing on the same machine. Each row needs two statistics to be a spread.
    """
    if len({fact.unit for fact in chosen}) != 1 or any(fact.series_key is None for fact in chosen):
        return None
    if len({fact.series_key[2] for fact in chosen}) != 1:
        return None
    groups: dict[tuple[str, str, str, str], list[tuple[str, Any]]] = {}
    for fact_id, fact in zip(request.fact_ids, chosen, strict=True):
        source_id, resource, metric, _statistic, instance = fact.series_key
        groups.setdefault((source_id, resource, metric, instance), []).append((fact_id, fact))
    if not 1 <= len(groups) <= MAX_SPREAD_ROWS:
        return None
    if any(len(members) < 2 for members in groups.values()):
        return None
    if any(len({fact.series_key[3] for _id, fact in members}) != len(members) for members in groups.values()):
        return None

    # A row's name is what its facts' labels share, less what every row shares and less the
    # statistic names: `vm-a · Percentage CPU · avg` and `· p95` make the row `vm-a`.
    statistics = {fact.series_key[3] for fact in chosen}
    every = set(chosen[0].label.split(" · ")).intersection(*(fact.label.split(" · ") for fact in chosen[1:]))
    rows = []
    for (_source_id, resource, _metric, _instance), members in groups.items():
        shared = set(members[0][1].label.split(" · ")).intersection(
            *(fact.label.split(" · ") for _id, fact in members[1:])
        )
        own = [part for part in members[0][1].label.split(" · ") if part in shared and part not in every and part not in statistics]
        ordered = sorted(members, key=lambda member: float(member[1].value))
        rows.append(
            {
                "label": _safe(" · ".join(own)) or resource,
                "source": "live" if any(fact.source == "live" for _id, fact in members) else "verified",
                "stats": [
                    {
                        "fact_id": fact_id,
                        "statistic": _safe(fact.series_key[3]),
                        "value": fact.value,
                        "formatted": fact.formatted,
                    }
                    for fact_id, fact in ordered
                ],
            }
        )
    metric = _safe(chosen[0].series_key[2])
    return {
        "id": chart_id,
        "kind": "spread",
        "title": _safe(request.title)[:MAX_TITLE_CHARS] or metric[:MAX_TITLE_CHARS],
        "unit": chosen[0].unit,
        "source": source,
        "rows": rows,
    }


def _stats(
    request: ChartRequest,
    chart_id: str,
    chosen: Sequence[Any],
    source: str,
    series: SeriesIndex,
    format_value: Any,
) -> dict[str, Any] | None:
    """Two to four headline figures. A tile carries its daily series when there is one."""
    if not 2 <= len(chosen) <= MAX_STAT_TILES:
        return None
    labels = _bar_labels([fact.label for fact in chosen])
    return {
        "id": chart_id,
        "kind": "stats",
        "title": _safe(request.title)[:MAX_TITLE_CHARS],
        "source": source,
        "tiles": [
            {
                "fact_id": fact_id,
                "label": label,
                "formatted": fact.formatted,
                "source": _series_source(fact),
                "points": _points(fact, series, format_value),
            }
            for fact_id, fact, label in zip(request.fact_ids, chosen, labels, strict=True)
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
