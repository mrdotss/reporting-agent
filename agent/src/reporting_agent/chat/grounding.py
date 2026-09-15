"""What a chat answer is allowed to cite: facts, read from artifacts (ask-chat Req 2, 8, 9).

A **fact** is a label and the exact string an artifact already holds. The model is
shown facts with ids and writes the ids; `stream_filter.py` puts the strings back. So a
figure in an answer is always a string this runtime read, never one a model produced.

A fact also carries its decimal `value` and `unit` where it has one, and — for a per-resource
statistic — the key of the matching daily series in its snapshot. Those are what a chart is
built from (`chat/charts.py`): the model names facts, and the runtime draws their values.

Four sources:

- **report** — the figure ledger of a run whose verification passed. The ledger is read as
  bytes and its SHA-256 is compared with the `ledger_sha256` the verification recorded, so a
  ledger that changed after verification contributes nothing.
- **scan** — counts from a connector's saved scan, as the app projected it.
- **live** — per-machine statistics from a live metrics pull's snapshot. Collected by the
  same pipeline as a report, but never verified, and cited as such.
- **price** — Azure list prices, looked up by `pricing/` for the VM sizes a snapshot names.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Final

from reporting_agent.artifacts import reports_key, verification_key
from reporting_agent.chat.charts import SeriesKey, series_index_from_snapshot
from reporting_agent.chat.payload import AttachedLive, AttachedRun, AttachedScan
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.storage.base import ObjectNotFoundError, ObjectStore

__all__ = [
    "MAX_FACTS",
    "Fact",
    "LiveGrounding",
    "LiveUnavailableError",
    "RunGrounding",
    "RunUnavailableError",
    "VmSize",
    "format_statistic",
    "ledger_facts",
    "live_statistic_facts",
    "load_live_grounding",
    "load_run_grounding",
    "number_facts",
    "scan_facts",
    "select_facts",
    "snapshot_vm_sizes",
]

MAX_FACTS: Final[int] = 600
"""The most facts one turn shows the model. Past this the grounding block stops being a
list a model can use and becomes a token bill; relevance picks which survive."""

PASSING_STATUS: Final[str] = "pass"
VIRTUAL_MACHINE_TYPE: Final[str] = "microsoft.compute/virtualmachines"
SOURCE_REPORT: Final[str] = "report"
SOURCE_SCAN: Final[str] = "scan"
SOURCE_LIVE: Final[str] = "live"
SOURCE_PRICE: Final[str] = "price"

_DECIMAL: Final[re.Pattern[str]] = re.compile(r"^-?\d+(?:\.(\d+))?$")


@dataclass(frozen=True, slots=True)
class Fact:
    source: str
    label: str
    formatted: str
    ref: Mapping[str, str]
    value: str | None = None
    """The decimal string the figure was formatted from, when it is a number."""
    unit: str | None = None
    series_key: SeriesKey | None = None
    """The daily series this statistic has in its snapshot, when it has one."""

    def citation(self, fact_id: str) -> dict[str, str]:
        return {
            **dict(self.ref),
            "fact_id": fact_id,
            "source": self.source,
            "label": self.label,
            "formatted": self.formatted,
        }


@dataclass(frozen=True, slots=True)
class VmSize:
    sku: str
    region: str
    resource_name: str


@dataclass(frozen=True, slots=True)
class RunGrounding:
    run: AttachedRun
    facts: tuple[Fact, ...]
    vm_sizes: tuple[VmSize, ...]
    series: Mapping[SeriesKey, Sequence[tuple[str, str]]] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class LiveGrounding:
    live: AttachedLive
    facts: tuple[Fact, ...]
    vm_sizes: tuple[VmSize, ...]
    series: Mapping[SeriesKey, Sequence[tuple[str, str]]] = field(default_factory=dict)


class RunUnavailableError(Exception):
    """An attached report this turn cannot read. The turn continues without it."""

    def __init__(self, run: AttachedRun, reason: str) -> None:
        super().__init__(f"{run.run_id}: {reason}")
        self.run = run
        self.reason = reason


class LiveUnavailableError(Exception):
    """An attached live pull whose snapshot cannot be read. The turn continues without it."""

    def __init__(self, live: AttachedLive, reason: str) -> None:
        super().__init__(f"{live.pull_id}: {reason}")
        self.live = live
        self.reason = reason


async def load_run_grounding(store: ObjectStore, run: AttachedRun) -> RunGrounding:
    """The facts of one attached report, or :class:`RunUnavailableError`."""
    try:
        verification = await store.get_json(
            verification_key(run.owner_actor_id, run.run_id, run.verification_attempt_id)
        )
    except ObjectNotFoundError as exc:
        raise RunUnavailableError(run, "no verification record") from exc

    if verification.get("status") != PASSING_STATUS:
        raise RunUnavailableError(run, "the report did not pass verification")

    try:
        ledger_bytes = await store.get_bytes(
            reports_key(run.owner_actor_id, run.run_id, "ledger.json")
        )
    except ObjectNotFoundError as exc:
        raise RunUnavailableError(run, "no figure ledger") from exc

    expected = verification.get("ledger_sha256")
    if not isinstance(expected, str) or hashlib.sha256(ledger_bytes).hexdigest() != expected:
        raise RunUnavailableError(run, "the figure ledger does not match its verification")

    try:
        ledger = json.loads(ledger_bytes)
    except ValueError as exc:
        raise RunUnavailableError(run, "the figure ledger is not readable") from exc

    facts = list(ledger_facts(ledger, run))

    sizes: tuple[VmSize, ...] = ()
    series: dict[SeriesKey, list[tuple[str, str]]] = {}
    try:
        snapshot = await store.get_json(snapshot_key(run.owner_actor_id, run.run_id))
    except ObjectNotFoundError:
        snapshot = None
    if isinstance(snapshot, Mapping):
        sizes, size_facts = snapshot_vm_sizes(snapshot, _run_ref(run))
        facts.extend(size_facts)
        series = series_index_from_snapshot(snapshot, run.run_id)

    return RunGrounding(run=run, facts=tuple(facts), vm_sizes=sizes, series=series)


async def load_live_grounding(store: ObjectStore, live: AttachedLive) -> LiveGrounding:
    """The facts of one live metrics pull, or :class:`LiveUnavailableError`."""
    try:
        snapshot = await store.get_json(snapshot_key(live.owner_actor_id, live.pull_id))
    except ObjectNotFoundError as exc:
        raise LiveUnavailableError(live, "the pull wrote no snapshot") from exc
    if not isinstance(snapshot, Mapping):
        raise LiveUnavailableError(live, "the pull's snapshot is not readable")

    ref = _live_ref(live)
    facts = list(live_statistic_facts(snapshot, ref, source_id=live.pull_id))
    sizes, size_facts = snapshot_vm_sizes(snapshot, ref, source=SOURCE_LIVE)
    facts.extend(size_facts)
    return LiveGrounding(
        live=live,
        facts=tuple(facts),
        vm_sizes=sizes,
        series=series_index_from_snapshot(snapshot, live.pull_id),
    )


def ledger_facts(ledger: object, run: AttachedRun) -> Iterator[Fact]:
    """One fact per distinct `(snapshot_path, formatted)` in the ledger.

    A figure placed in three blocks is one fact, not three: the model gets one id for one
    measured value, and the chip it produces points at the one snapshot path.
    """
    entries = ledger.get("entries") if isinstance(ledger, Mapping) else None
    if not isinstance(entries, Mapping):
        return
    seen: set[tuple[str, str]] = set()
    for path in sorted(entries):
        entry = entries[path]
        if not isinstance(entry, Mapping):
            continue
        formatted = entry.get("formatted")
        snapshot_path = entry.get("snapshot_path")
        if not isinstance(formatted, str) or not formatted.strip():
            continue
        snapshot_path = snapshot_path if isinstance(snapshot_path, str) else ""
        key = (snapshot_path, formatted)
        if key in seen:
            continue
        seen.add(key)
        ref = _run_ref(run)
        if snapshot_path:
            ref["snapshot_path"] = snapshot_path
        unit = entry.get("unit")
        if isinstance(unit, str) and unit:
            ref["unit"] = unit
        value = entry.get("value")
        yield Fact(
            SOURCE_REPORT,
            _figure_label(entry, str(path)),
            formatted,
            ref,
            value=value if isinstance(value, str) and _DECIMAL.match(value) else None,
            unit=unit if isinstance(unit, str) and unit else None,
            series_key=_ledger_series_key(entry, run.run_id),
        )


def live_statistic_facts(
    snapshot: Mapping[str, Any], ref: Mapping[str, str], *, source_id: str = ""
) -> Iterator[Fact]:
    """One fact per machine statistic in a live pull's snapshot.

    Formatted with the report's own formatter, so `8.06%` in a live answer reads exactly as
    it would in a delivered document; a unit the formatter does not declare falls back to the
    snapshot's decimal string and unit name rather than being dropped.
    """
    resources = snapshot.get("resources")
    if not isinstance(resources, Sequence):
        return
    for index, resource in enumerate(resources):
        if not isinstance(resource, Mapping):
            continue
        name = resource.get("name")
        resource_id = resource.get("resource_id")
        statistics = resource.get("statistics")
        if not isinstance(name, str) or not isinstance(statistics, Sequence):
            continue
        for position, statistic in enumerate(statistics):
            if not isinstance(statistic, Mapping):
                continue
            metric = statistic.get("metric")
            kind = statistic.get("statistic")
            value = statistic.get("value")
            unit = statistic.get("unit")
            if not (
                isinstance(metric, str)
                and isinstance(kind, str)
                and isinstance(value, str)
                and isinstance(unit, str)
            ):
                continue
            label_path = f"resources/{index}/statistics/{position}"
            formatted = format_statistic(value, unit)
            parts = [name, metric, kind]
            instance = statistic.get("instance")
            instance_text = instance if isinstance(instance, str) else ""
            if instance_text:
                parts.append(instance_text)
            yield Fact(
                SOURCE_LIVE,
                " · ".join(parts),
                formatted,
                {**ref, "snapshot_path": label_path, "unit": unit},
                value=value if _DECIMAL.match(value) else None,
                unit=unit,
                series_key=(
                    (source_id, resource_id.casefold(), metric, kind, instance_text)
                    if source_id and isinstance(resource_id, str)
                    else None
                ),
            )


def snapshot_vm_sizes(
    snapshot: Mapping[str, Any],
    ref: Mapping[str, str],
    *,
    source: str = SOURCE_REPORT,
) -> tuple[tuple[VmSize, ...], list[Fact]]:
    """The VM sizes a snapshot names, for pricing, and a size fact per machine."""
    resources = snapshot.get("resources")
    if not isinstance(resources, Sequence):
        return (), []
    sizes: list[VmSize] = []
    facts: list[Fact] = []
    for resource in resources:
        if not isinstance(resource, Mapping):
            continue
        if str(resource.get("resource_type", "")).lower() != VIRTUAL_MACHINE_TYPE:
            continue
        sku = resource.get("sku")
        sku_name = sku.get("name") if isinstance(sku, Mapping) else None
        region = resource.get("location")
        name = resource.get("name")
        if not (isinstance(sku_name, str) and isinstance(region, str) and isinstance(name, str)):
            continue
        sizes.append(VmSize(sku=sku_name, region=region, resource_name=name))
        size_ref = {**ref, "snapshot_path": f"resources › {name} › sku"}
        facts.append(Fact(source, f"{name} · VM size", sku_name, size_ref))
        vcpus = sku.get("vcpus_available") if isinstance(sku, Mapping) else None
        if isinstance(vcpus, str) and vcpus.isdigit():
            facts.append(
                Fact(source, f"{name} · vCPUs", f"{vcpus} vCPU", size_ref, value=vcpus, unit="vcpu")
            )
    return tuple(sizes), facts


def scan_facts(scan: AttachedScan) -> Iterator[Fact]:
    """Counts from a connector's saved scan: the total, per type, per region."""
    inventory = scan.inventory
    ref = {"scan_id": scan.scan_id, "collected_at": scan.collected_at}
    label = scan.connector_label

    total = _count(inventory.get("resourceCount"))
    if total is not None:
        yield Fact(SOURCE_SCAN, f"{label} · resources", total, dict(ref), value=total, unit="count")
    for name, count in _counts(inventory.get("typeCounts")):
        yield Fact(SOURCE_SCAN, f"{label} · resources of type {name}", count, dict(ref), value=count, unit="count")
    for name, count in _counts(inventory.get("regionCounts")):
        yield Fact(SOURCE_SCAN, f"{label} · resources in region {name}", count, dict(ref), value=count, unit="count")


def select_facts(facts: Sequence[Fact], *, query: str, cap: int = MAX_FACTS) -> list[Fact]:
    """At most `cap` facts, preferring those whose label shares words with the question.

    Price facts are always kept: there are few of them, and a cost question whose words
    happen not to match a SKU label must still see them.
    """
    if len(facts) <= cap:
        return list(facts)
    words = set(re.findall(r"[a-z0-9]{3,}", query.lower()))
    scored = [
        (
            fact.source == SOURCE_PRICE,
            sum(1 for word in words if word in fact.label.lower()),
            -index,
            index,
        )
        for index, fact in enumerate(facts)
    ]
    keep = sorted(scored, reverse=True)[:cap]
    return [facts[index] for *_rest, index in sorted(keep, key=lambda item: item[3])]


def number_facts(facts: Iterable[Fact]) -> dict[str, Fact]:
    """Ids `f1`, `f2`, … in order. Ids are per turn; a stored answer keeps its citations."""
    return {f"f{position}": fact for position, fact in enumerate(facts, start=1)}


def format_statistic(value: str, unit: str, *, path: str = "chat") -> str:
    """A decimal string as a report prints it, or `<value> <unit>` for an undeclared unit."""
    match = _DECIMAL.match(value)
    if match is None:
        return f"{value} {unit}".strip()
    from reporting_agent.compile.format import format_figure
    from reporting_agent.errors import CompileFailedError

    try:
        return format_figure(value, unit=unit, catalog_scale=len(match.group(1) or ""), path=path)
    except CompileFailedError:
        return f"{value} {unit}".strip()


def _ledger_series_key(entry: Mapping[str, Any], source_id: str) -> SeriesKey | None:
    resource_id = entry.get("resource_id")
    metric = entry.get("metric")
    statistic = entry.get("statistic")
    if not (isinstance(resource_id, str) and isinstance(metric, str) and isinstance(statistic, str)):
        return None
    return (source_id, resource_id.casefold(), metric, statistic, "")


def _run_ref(run: AttachedRun) -> dict[str, str]:
    return {
        "run_id": run.run_id,
        "customer_name": run.customer_name,
        "period_display": run.period_display,
    }


def _live_ref(live: AttachedLive) -> dict[str, str]:
    return {
        "pull_id": live.pull_id,
        "connector_label": live.connector_label,
        "period_display": live.window_display,
        "collected_at": live.collected_at,
    }


def _figure_label(entry: Mapping[str, Any], path: str) -> str:
    parts: list[str] = []
    resource_id = entry.get("resource_id")
    if isinstance(resource_id, str) and resource_id:
        parts.append(resource_id.rstrip("/").rsplit("/", 1)[-1])
    for name in ("metric", "statistic", "estimator_label"):
        value = entry.get(name)
        if isinstance(value, str) and value:
            parts.append(value)
    return " · ".join(parts) if parts else path


def _count(value: object) -> str | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, int) and value >= 0:
        return str(value)
    if isinstance(value, str) and value.isdigit():
        return value
    return None


def _counts(value: object) -> Iterator[tuple[str, str]]:
    """`{name: count}` or `[{type|name|region|value: …, count: …}]`, whichever was stored."""
    if isinstance(value, Mapping):
        for name in sorted(value):
            count = _count(value[name])
            if count is not None:
                yield str(name), count
        return
    if isinstance(value, Sequence) and not isinstance(value, (str, bytes)):
        for item in value:
            if not isinstance(item, Mapping):
                continue
            name = next(
                (item[key] for key in ("type", "name", "region", "value", "key") if isinstance(item.get(key), str)),
                None,
            )
            count = _count(item.get("count", item.get("total")))
            if name is not None and count is not None:
                yield name, count
