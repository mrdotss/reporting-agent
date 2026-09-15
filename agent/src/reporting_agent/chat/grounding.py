"""What a chat answer is allowed to cite: facts, read from verified artifacts (ask-chat Req 2).

A **fact** is a label and the exact string a verified artifact already holds. The model is
shown facts with ids and writes the ids; `stream_filter.py` puts the strings back. So a
figure in an answer is always a string this runtime read, never one a model produced.

Three sources:

- **report** — the figure ledger of a run whose verification passed. The ledger is read as
  bytes and its SHA-256 is compared with the `ledger_sha256` the verification recorded, so a
  ledger that changed after verification contributes nothing.
- **scan** — counts from a connector's saved scan, as the app projected it.
- **price** — Azure list prices, looked up by `pricing/` for the VM sizes a snapshot names.
"""

from __future__ import annotations

import hashlib
import json
import re
from collections.abc import Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final

from reporting_agent.artifacts import reports_key, verification_key
from reporting_agent.chat.payload import AttachedRun, AttachedScan
from reporting_agent.collect.snapshot import snapshot_key
from reporting_agent.storage.base import ObjectNotFoundError, ObjectStore

__all__ = [
    "MAX_FACTS",
    "Fact",
    "RunGrounding",
    "RunUnavailableError",
    "VmSize",
    "ledger_facts",
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
SOURCE_PRICE: Final[str] = "price"


@dataclass(frozen=True, slots=True)
class Fact:
    source: str
    label: str
    formatted: str
    ref: Mapping[str, str]

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


class RunUnavailableError(Exception):
    """An attached report this turn cannot read. The turn continues without it."""

    def __init__(self, run: AttachedRun, reason: str) -> None:
        super().__init__(f"{run.run_id}: {reason}")
        self.run = run
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
    try:
        snapshot = await store.get_json(snapshot_key(run.owner_actor_id, run.run_id))
    except ObjectNotFoundError:
        snapshot = None
    if isinstance(snapshot, Mapping):
        sizes, size_facts = snapshot_vm_sizes(snapshot, run)
        facts.extend(size_facts)

    return RunGrounding(run=run, facts=tuple(facts), vm_sizes=sizes)


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
        yield Fact(SOURCE_REPORT, _figure_label(entry, str(path)), formatted, ref)


def snapshot_vm_sizes(
    snapshot: Mapping[str, Any], run: AttachedRun
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
        ref = _run_ref(run)
        ref["snapshot_path"] = f"resources › {name} › sku"
        facts.append(Fact(SOURCE_REPORT, f"{name} · VM size", sku_name, ref))
        vcpus = sku.get("vcpus_available") if isinstance(sku, Mapping) else None
        if isinstance(vcpus, str) and vcpus.isdigit():
            facts.append(Fact(SOURCE_REPORT, f"{name} · vCPUs", f"{vcpus} vCPU", ref))
    return tuple(sizes), facts


def scan_facts(scan: AttachedScan) -> Iterator[Fact]:
    """Counts from a connector's saved scan: the total, per type, per region."""
    inventory = scan.inventory
    ref = {"scan_id": scan.scan_id, "collected_at": scan.collected_at}
    label = scan.connector_label

    total = _count(inventory.get("resourceCount"))
    if total is not None:
        yield Fact(SOURCE_SCAN, f"{label} · resources", total, dict(ref))
    for name, count in _counts(inventory.get("typeCounts")):
        yield Fact(SOURCE_SCAN, f"{label} · resources of type {name}", count, dict(ref))
    for name, count in _counts(inventory.get("regionCounts")):
        yield Fact(SOURCE_SCAN, f"{label} · resources in region {name}", count, dict(ref))


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


def _run_ref(run: AttachedRun) -> dict[str, str]:
    return {
        "run_id": run.run_id,
        "customer_name": run.customer_name,
        "period_display": run.period_display,
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
