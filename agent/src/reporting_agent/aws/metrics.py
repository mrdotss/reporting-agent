"""CloudWatch metrics: plan, request, archive and fold, into the collector's own accumulators.

The Azure fold hands every interval's `{total, count, minimum, maximum}` to a
`MetricAccumulator`. CloudWatch's `GetMetricData` answers the same four questions — `Sum`,
`SampleCount`, `Minimum`, `Maximum` over one period — so an AWS figure is folded by **the
same accumulator**, finalized by the same `collect/finalize.py` and hashed into the same
snapshot. Only the reading of the response is AWS's own, and it is this module's
:func:`fold_cloudwatch_document`.

## One document, folded twice

A call's response is first turned into a plain **document** — the queries, every result
series with its timestamps as ISO strings and its values as exact decimal strings, and the
call's provenance — and that document is what is archived **and** what is folded, live.
`verify/replay.py` later folds the archived copy through this same function. Folding the
boto3 response directly while archiving a converted copy would leave two readings of one
answer; this way there is one, and a replay mismatch can only mean the aggregation is not
deterministic.

## Purity

This module's top level imports nothing that opens a connection: the fold and the document
builder are pure, and the collector reaches CloudWatch only through a client handed to it.
`verify/replay.py` imports this module, and `tests/test_boundaries.py` checks that its
import closure reaches no `boto3`.

## Values

boto3 parses CloudWatch's values into `float`. Each is written as `repr(value)` — Python's
shortest string that round-trips to the same float — and read back with `Decimal`, so the
digits folded are exactly the digits archived, on every machine, every time.
"""

from __future__ import annotations

import asyncio
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal, InvalidOperation
from typing import Any, Final

from reporting_agent.catalog.loader import (
    AGGREGATION_COUNT,
    AGGREGATION_MAXIMUM,
    AGGREGATION_MINIMUM,
    AGGREGATION_TOTAL,
)
from reporting_agent.collect.accumulate import MetricAccumulator
from reporting_agent.collect.archive import ARCHIVE_KIND_CLOUDWATCH, ArchiveWriter
from reporting_agent.collect.dayfold import DayFold
from reporting_agent.collect.log import (
    GAP_TYPE_INTERVAL_COUNTS_MISSING,
    GAP_TYPE_METRIC_ERROR,
    GAP_TYPE_PERMISSION_DENIED,
    GAP_TYPE_REGION_UNREACHABLE,
    record_gap,
)
from reporting_agent.providers.base import GapRecord

__all__ = [
    "CLOUDWATCH_DOCUMENT_VERSION",
    "DIMENSION_BY_TYPE",
    "MAX_QUERIES_PER_CALL",
    "STAT_BY_AGGREGATION",
    "CloudWatchCollector",
    "MetricQuery",
    "build_document",
    "dimension_value",
    "fold_cloudwatch_document",
    "grain_seconds",
    "plan_queries",
]

CLOUDWATCH_DOCUMENT_VERSION: Final[str] = "1.0.0"

MAX_QUERIES_PER_CALL: Final[int] = 500
"""`GetMetricData`'s own limit on queries per request."""

STAT_BY_AGGREGATION: Final[Mapping[str, str]] = {
    AGGREGATION_TOTAL: "Sum",
    AGGREGATION_COUNT: "SampleCount",
    AGGREGATION_MINIMUM: "Minimum",
    AGGREGATION_MAXIMUM: "Maximum",
}
"""The catalog's aggregation names, which are Azure's, to CloudWatch's statistic names."""

_AGGREGATION_BY_STAT: Final[Mapping[str, str]] = {stat: agg for agg, stat in STAT_BY_AGGREGATION.items()}

DIMENSION_BY_TYPE: Final[Mapping[str, str]] = {
    "AWS::EC2::Instance": "InstanceId",
    "AWS::EC2::Volume": "VolumeId",
    "AWS::RDS::DBInstance": "DBInstanceIdentifier",
}
"""The one dimension that names a resource's own series in its namespace."""

_ARN_TAIL: Final[Mapping[str, re.Pattern[str]]] = {
    "AWS::EC2::Instance": re.compile(r":instance/(i-[0-9a-f]+)$"),
    "AWS::EC2::Volume": re.compile(r":volume/(vol-[0-9a-f]+)$"),
    "AWS::RDS::DBInstance": re.compile(r":db:([A-Za-z0-9-]+)$"),
}

_GRAIN_SECONDS: Final[Mapping[str, int]] = {"PT1M": 60, "PT5M": 300, "PT15M": 900, "PT1H": 3600, "P1D": 86400}

_DENIED_STATUS: Final[frozenset[str]] = frozenset({"Forbidden"})


def grain_seconds(grain: str) -> int:
    """The CloudWatch period for a run's grain. A grain CloudWatch cannot serve raises."""
    try:
        return _GRAIN_SECONDS[grain]
    except KeyError:
        raise ValueError(f"grain {grain!r} has no CloudWatch period") from None


def dimension_value(resource_type: str, resource_id: str) -> str | None:
    """The dimension value CloudWatch keys this resource's series by, from its ARN."""
    pattern = _ARN_TAIL.get(resource_type)
    match = pattern.search(resource_id) if pattern else None
    return match.group(1) if match else None


@dataclass(frozen=True, slots=True)
class MetricQuery:
    """One series asked for: one statistic of one metric of one resource."""

    id: str
    resource_id: str
    metric: str
    stat: str
    dimension: str

    def to_plain(self) -> dict[str, str]:
        return {"id": self.id, "resource_id": self.resource_id, "metric": self.metric, "stat": self.stat}


def plan_queries(
    *,
    resource_type: str,
    resource_ids: Sequence[str],
    metric_names: Sequence[str],
    aggregations_by_metric: Mapping[str, Sequence[str]],
) -> list[list[MetricQuery]]:
    """The calls to make, each at most 500 queries, a resource's queries never split. **Pure.**

    Ids are positional (`q<resource>_<metric>_<stat>`), so one inventory plans one set of
    requests, and `GetMetricData`'s id rule — a lowercase letter first — holds.
    """
    calls: list[list[MetricQuery]] = []
    current: list[MetricQuery] = []
    for r_index, resource_id in enumerate(sorted(resource_ids)):
        dimension = dimension_value(resource_type, resource_id)
        if dimension is None:
            continue
        queries = [
            MetricQuery(
                id=f"q{r_index}_{m_index}_{STAT_BY_AGGREGATION[agg].lower()}",
                resource_id=resource_id,
                metric=metric,
                stat=STAT_BY_AGGREGATION[agg],
                dimension=dimension,
            )
            for m_index, metric in enumerate(metric_names)
            for agg in sorted(aggregations_by_metric.get(metric, ()))
            if agg in STAT_BY_AGGREGATION
        ]
        if current and len(current) + len(queries) > MAX_QUERIES_PER_CALL:
            calls.append(current)
            current = []
        current.extend(queries)
    if current:
        calls.append(current)
    return calls


def _instant(value: object) -> str | None:
    if isinstance(value, datetime):
        return value.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return value if isinstance(value, str) and value else None


def build_document(
    *,
    account_id: str,
    region: str,
    resource_type: str,
    grain: str,
    window: Mapping[str, str],
    metric_names: Sequence[str],
    queries: Sequence[MetricQuery],
    pages: Sequence[Mapping[str, Any]],
) -> dict[str, Any]:
    """One call's answer as plain, exact, ordered data — what is archived and folded. **Pure.**

    Pages are merged per query id; each series is sorted by timestamp, so the document does
    not depend on the order CloudWatch returned points or pages in.
    """
    series: dict[str, dict[str, Any]] = {}
    for page in pages:
        for result in page.get("MetricDataResults") or []:
            entry = series.setdefault(
                str(result.get("Id")), {"status": "Complete", "points": {}, "messages": []}
            )
            status = result.get("StatusCode")
            if isinstance(status, str) and status not in ("Complete", "PartialData"):
                entry["status"] = status
            for message in result.get("Messages") or []:
                text = message.get("Value") if isinstance(message, Mapping) else None
                if isinstance(text, str):
                    entry["messages"].append(text)
            for stamp, value in zip(result.get("Timestamps") or [], result.get("Values") or [], strict=False):
                instant = _instant(stamp)
                if instant is not None and isinstance(value, int | float | Decimal):
                    entry["points"][instant] = repr(float(value)) if isinstance(value, float) else str(value)

    return {
        "kind": ARCHIVE_KIND_CLOUDWATCH,
        "schema_version": CLOUDWATCH_DOCUMENT_VERSION,
        "grouping_key": {"account_id": account_id, "location": region, "resource_type": resource_type},
        "grain": grain,
        "window": dict(window),
        "metric_names": list(metric_names),
        "resource_ids": sorted({query.resource_id for query in queries}),
        "queries": [query.to_plain() for query in queries],
        "results": [
            {
                "id": query_id,
                "status": entry["status"],
                "messages": sorted(set(entry["messages"])),
                "timestamps": sorted(entry["points"]),
                "values": [entry["points"][stamp] for stamp in sorted(entry["points"])],
            }
            for query_id, entry in sorted(series.items())
        ],
    }


def _decimal(text: object) -> Decimal | None:
    if not isinstance(text, str):
        return None
    try:
        value = Decimal(text)
    except InvalidOperation:
        return None
    return value if value.is_finite() else None


def fold_cloudwatch_document(
    document: Mapping[str, Any],
    accumulators: Mapping[tuple[str, str], MetricAccumulator],
    day_fold: DayFold | None = None,
) -> list[GapRecord]:
    """Fold one CloudWatch document into `accumulators`, in place; return its gaps. **Pure.**

    Per `(resource, metric)`: its statistic series are joined by timestamp. A series CloudWatch
    refused (`Forbidden`) records `permission_denied`, any other failed status `metric_error`,
    and folds nothing. At each timestamp, an interval missing a `Sum` or `SampleCount` the
    request asked for records `interval_counts_missing` and is excluded, as Azure's is;
    otherwise the four values go to the accumulator and the day fold. A pair with no point at
    all folds nothing and records nothing here — finalization records `no_samples` for it.
    """
    results = {str(result.get("id")): result for result in document.get("results") or [] if isinstance(result, Mapping)}
    by_pair: dict[tuple[str, str], dict[str, Mapping[str, Any]]] = {}
    for query in document.get("queries") or []:
        if not isinstance(query, Mapping):
            continue
        result = results.get(str(query.get("id")))
        if result is None:
            continue
        pair = (str(query.get("resource_id")), str(query.get("metric")))
        by_pair.setdefault(pair, {})[str(query.get("stat"))] = result

    gaps: list[GapRecord] = []
    for (resource_id, metric), stats in sorted(by_pair.items()):
        failed = sorted({str(result.get("status")) for result in stats.values()} - {"Complete"})
        if failed:
            denied = any(status in _DENIED_STATUS for status in failed)
            messages = sorted({m for result in stats.values() for m in result.get("messages") or []})
            gaps.append(
                record_gap(
                    GAP_TYPE_PERMISSION_DENIED if denied else GAP_TYPE_METRIC_ERROR,
                    resource_id,
                    metric,
                    f"CloudWatch answered {', '.join(failed)} for metric {metric!r} on "
                    f"{resource_id!r}" + (f": {'; '.join(messages)}" if messages else "") + ".",
                )
            )
            continue

        accumulator = accumulators.get((resource_id, metric))
        if accumulator is None:
            continue
        points: dict[str, dict[str, Decimal | None]] = {}
        for stat, result in stats.items():
            aggregation = _AGGREGATION_BY_STAT.get(stat)
            if aggregation is None:
                continue
            for stamp, text in zip(result.get("timestamps") or [], result.get("values") or [], strict=False):
                points.setdefault(str(stamp), {})[aggregation] = _decimal(text)

        requested = accumulator.aggregations
        for stamp in sorted(points):
            values = points[stamp]
            total = values.get(AGGREGATION_TOTAL)
            count = values.get(AGGREGATION_COUNT)
            missing = (
                (AGGREGATION_TOTAL in requested or AGGREGATION_COUNT in requested) and total is None
            ) or (AGGREGATION_COUNT in requested and count is None)
            if missing:
                gaps.append(
                    record_gap(
                        GAP_TYPE_INTERVAL_COUNTS_MISSING,
                        resource_id,
                        metric,
                        f"an interval for metric {metric!r} on resource {resource_id!r} "
                        f"omits its Sum or its SampleCount; excluded from the average.",
                        stamp,
                    )
                )
                continue
            minimum = values.get(AGGREGATION_MINIMUM)
            maximum = values.get(AGGREGATION_MAXIMUM)
            fold_gap = accumulator.fold_interval(
                total=total,
                count=count,
                minimum=minimum,
                maximum=maximum,
                resource_id=resource_id,
                metric=metric,
                interval_start=stamp,
            )
            if fold_gap is not None:
                gaps.append(fold_gap)
            if day_fold is not None:
                day_fold.fold(
                    resource_id=resource_id,
                    metric=metric,
                    aggregations=accumulator.aggregations,
                    timestamp=stamp,
                    total=total,
                    count=count,
                    minimum=minimum,
                    maximum=maximum,
                )
    return gaps


@dataclass(slots=True)
class CloudWatchCollector:
    """Requests, archives and folds one run's CloudWatch metrics.

    `clients` is `(service, region) -> client`; `semaphore` bounds concurrent calls across
    the whole run (CloudWatch's `GetMetricData` quota is per account and region).
    """

    clients: Any
    archive_writer: ArchiveWriter
    account_id: str
    semaphore: asyncio.Semaphore

    async def collect_group(
        self,
        *,
        actor_id: str,
        run_id: str,
        region: str,
        resource_type: str,
        namespace: str,
        resource_ids: Sequence[str],
        metric_names: Sequence[str],
        aggregations_by_metric: Mapping[str, Sequence[str]],
        accumulators: Mapping[tuple[str, str], MetricAccumulator],
        day_fold: DayFold,
        grain: str,
        window: Mapping[str, str],
    ) -> tuple[list[GapRecord], bool]:
        """Every call for one `(region, resource type)` group. Returns its gaps, and whether
        the region answered at all (a refused or unreachable region folds nothing)."""
        from botocore.exceptions import BotoCoreError, ClientError

        gaps: list[GapRecord] = []
        period = grain_seconds(grain)
        calls = plan_queries(
            resource_type=resource_type,
            resource_ids=resource_ids,
            metric_names=metric_names,
            aggregations_by_metric=aggregations_by_metric,
        )
        reachable = True
        for queries in calls:
            request = [
                {
                    "Id": query.id,
                    "MetricStat": {
                        "Metric": {
                            "Namespace": namespace,
                            "MetricName": query.metric,
                            "Dimensions": [{"Name": DIMENSION_BY_TYPE[resource_type], "Value": query.dimension}],
                        },
                        "Period": period,
                        "Stat": query.stat,
                    },
                    "ReturnData": True,
                }
                for query in queries
            ]
            try:
                pages = await self._call(region, request, window)
            except (ClientError, BotoCoreError) as exc:
                reachable = False
                code = exc.response.get("Error", {}).get("Code", "") if isinstance(exc, ClientError) else type(exc).__name__
                for resource_id in sorted({query.resource_id for query in queries}):
                    gaps.append(
                        record_gap(
                            GAP_TYPE_REGION_UNREACHABLE,
                            resource_id,
                            None,
                            f"CloudWatch in {region} did not answer ({code}); no metric was "
                            f"collected for this resource.",
                        )
                    )
                continue

            document = build_document(
                account_id=self.account_id,
                region=region,
                resource_type=resource_type,
                grain=grain,
                window=window,
                metric_names=metric_names,
                queries=queries,
                pages=pages,
            )
            written = await self.archive_writer.write_document(
                actor_id=actor_id,
                run_id=run_id,
                location=region,
                resource_type=resource_type,
                resource_ids=document["resource_ids"],
                document=document,
            )
            gaps.extend(written.gaps)
            gaps.extend(fold_cloudwatch_document(document, accumulators, day_fold))
        return gaps, reachable

    async def _call(self, region: str, request: list[dict[str, Any]], window: Mapping[str, str]) -> list[dict[str, Any]]:
        client = self.clients("cloudwatch", region)
        start = datetime.fromisoformat(window["start_utc"].replace("Z", "+00:00"))
        end = datetime.fromisoformat(window["end_utc"].replace("Z", "+00:00"))

        def fetch() -> list[dict[str, Any]]:
            pages: list[dict[str, Any]] = []
            token: str | None = None
            while True:
                arguments: dict[str, Any] = {
                    "MetricDataQueries": request,
                    "StartTime": start,
                    "EndTime": end,
                    "ScanBy": "TimestampAscending",
                }
                if token:
                    arguments["NextToken"] = token
                page = client.get_metric_data(**arguments)
                pages.append(page)
                token = page.get("NextToken")
                if not token:
                    return pages

        async with self.semaphore:
            return await asyncio.to_thread(fetch)
