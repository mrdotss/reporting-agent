"""The raw archive: one gzip-compressed JSON object per folded response (Req 26).

`ArchiveWriter.write` is the only way a raw Azure response reaches S3. It is called
by `azure/metrics.py` **once per response it chooses to fold** — never for a rejected
request (a response-too-large rejection, a 429, a non-2xx) — which is what makes
Req 26.10 ("a rejected request writes no object") true by construction rather than by
a check inside this module: this module has no idea what a rejection looks like, and
does not need to.

**The key embeds a per-run monotonic sequence** (Req 26.8):

    <actor_id>/snapshots/<runId>/raw/<seq:06d>-<location>-<type>.json.gz

so no two objects in one run ever collide, and a run's raw objects enumerate in fold
order. The sequence is a plain counter on the instance, guarded by a `threading.Lock`
for the same reason `tests/fakes/object_store.py` guards its dict: a real
`S3ObjectStore.put_bytes` runs its boto3 call in a worker thread
(`asyncio.to_thread`), so two concurrent archive writes can race on this counter from
two real threads, not just two `asyncio` tasks on one thread.

**The object body carries its own provenance** (Req 26.6): the grouping key, the
requested grain, the requested window and the requested metric names travel alongside
the raw response, so replay (`verify/replay.py`, a later spec) can re-aggregate from
the archive alone with no other context.

**A failed write never stops collection** (Req 26.4, 26.7): `write` never raises. A
failure records one `archive_write_failed` gap **per resource** in the response's
grouping key — the caller still folds the response into the Accumulator and the
Sketch — and flips `archive_incomplete` so the snapshot this run produces can record
that its raw archive cannot be fully replayed (Req 26.12). Nothing here re-reads Azure
to build the archive (Req 26.5): every argument to `write` is data the caller already
has in hand from the response it is folding.

Retaining only `{total, count, min, max}` plus the sketch per `(resource, metric)`
pair — the bound that does not vary with how many points were folded (Req 26.2,
26.11) — is `collect/accumulate.py`'s job, not this module's: this module only ever
holds one response's raw body long enough to serialize it, and never accumulates
anything itself.
"""

from __future__ import annotations

import gzip
import json
import logging
import threading
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from decimal import Decimal
from typing import Any, Final

from reporting_agent.collect.log import GAP_TYPE_ARCHIVE_WRITE_FAILED, record_gap
from reporting_agent.providers.base import GapRecord
from reporting_agent.storage.base import JSON_CONTENT_TYPE, ObjectStore

__all__ = [
    "ARCHIVE_KINDS",
    "ARCHIVE_KIND_INVENTORY",
    "ARCHIVE_KIND_METRICS",
    "ARCHIVE_SCHEMA_VERSION",
    "ArchiveWriteResult",
    "ArchiveWriter",
    "archive_key",
    "archive_kind_of",
    "inventory_archive_key",
]

logger = logging.getLogger(__name__)

_TAGS: Final[dict[str, str]] = {"content-encoding": "gzip"}
"""Object tags, not HTTP headers (`ObjectStore.put_bytes` has no `ContentEncoding`
parameter) — the key's own `.json.gz` suffix is what Req 26.3 actually requires; this
tag is a convenience for a human browsing the bucket, not a contract this module
relies on being read back."""


ARCHIVE_SCHEMA_VERSION: Final[str] = "1.0.0"
"""The archived object's own `schema_version`, carried by every **inventory** object.

Not retrofitted onto a metrics object, and that is the whole reason the dispatch below
reads a *default* rather than a required field: adding a key to the metrics shape would
mean every object already written lacks it, so a reader would have to tolerate its absence
anyway. Tolerating the absence is therefore the contract, and writing it on the objects
that never lacked it is the only honest version of that."""

ARCHIVE_KIND_METRICS: Final[str] = "metrics"
ARCHIVE_KIND_INVENTORY: Final[str] = "inventory"

ARCHIVE_KINDS: Final[tuple[str, ...]] = (ARCHIVE_KIND_METRICS, ARCHIVE_KIND_INVENTORY)
"""The object kinds the archive holds, and the closed set :func:`archive_kind_of` returns
a member of."""


def archive_kind_of(document: Mapping[str, object]) -> str:
    """Which kind of archived object `document` is (Req 7.2). **Pure.**

    Dispatches on the **declared `kind` field**, defaulting to
    :data:`ARCHIVE_KIND_METRICS` when it is absent — because every object written before
    this field existed is a metrics response and carries no `kind`, so absence *is* the
    metrics claim rather than an unknown.

    Deliberately **not** a guess from the shape of the body. A metrics batch response
    carries `values`, a per-resource fallback carries `value`, and a Resource Graph page
    carries `data` — so shape-sniffing works right up until one of those three services
    renames a field or a new kind arrives whose body resembles an existing one, at which
    point a replay folds an object as the wrong kind and reports a mismatch on a
    reproducible snapshot. A declared field cannot be wrong by coincidence.

    An unrecognised declared `kind` is returned as-is rather than coerced, so a caller can
    refuse it by name; coercing it to `metrics` would fold a fact response as a metric one.
    """
    kind = document.get("kind")
    if kind is None:
        return ARCHIVE_KIND_METRICS
    return str(kind)


def archive_key(*, actor_id: str, run_id: str, sequence: int, location: str, resource_type: str) -> str:
    """The object key for one archived response (Req 26.8). **Pure.**

    `resource_type` commonly contains a `/` (`Microsoft.Compute/virtualMachines`);
    left as-is it would silently nest the object under an extra prefix inside `raw/`
    rather than naming it as one flat `<seq>-<location>-<type>.json.gz` entry the way
    the design's key format states it, so it is flattened to `_` here, in this one
    place, rather than at every call site that builds a key.
    """
    safe_type = resource_type.replace("/", "_")
    return f"{actor_id}/snapshots/{run_id}/raw/{sequence:06d}-{location}-{safe_type}.json.gz"


def inventory_archive_key(
    *, actor_id: str, run_id: str, sequence: int, source: str, page_index: int
) -> str:
    """The object key for one archived inventory page (Req 7.1). **Pure.**

    Shares the `<seq:06d>-` prefix with :func:`archive_key` for a reason that is not
    cosmetic: a replay reads the archive by listing the run's `raw/` prefix and sorting
    the keys, so sorting by key has to equal sorting by sequence. A key that led with the
    source name instead would interleave inventory pages among the metric objects in an
    order that depends on the alphabet, and the sequence the snapshot names would no
    longer be the sequence a replay folds in.

    `page_index` is in the key as well as in the body, so a human listing the bucket can
    see the paging without decompressing anything.
    """
    safe_source = source.replace("/", "_")
    return (
        f"{actor_id}/snapshots/{run_id}/raw/"
        f"{sequence:06d}-{ARCHIVE_KIND_INVENTORY}-{safe_source}-{page_index:04d}.json.gz"
    )


@dataclass(frozen=True, slots=True)
class ArchiveWriteResult:
    """The outcome of one `ArchiveWriter.write` call.

    `wrote` is `False` only when the underlying store raised; `gaps` is then one
    `archive_write_failed` `GapRecord` per resource in the write's `resource_ids`
    (Req 26.7) and is empty otherwise. `key` is always the key that was attempted,
    whether or not the write succeeded — a caller logging a failure names the key
    that did not land.
    """

    wrote: bool
    key: str
    gaps: tuple[GapRecord, ...] = ()


def _json_default(value: object) -> str:
    """`json.dumps`'s `default=` for a value it cannot serialize natively.

    The only such value this module expects is `Decimal`, if a caller's raw response
    body was decoded with `parse_float=Decimal` — rendered as its exact digit string,
    never through a `float` detour. Anything else is a genuine bug in what got handed
    to `write`, so it still raises `TypeError` rather than being silently stringified.
    """
    if isinstance(value, Decimal):
        return str(value)
    raise TypeError(f"object of type {type(value).__name__} is not JSON serializable")


@dataclass(slots=True)
class ArchiveWriter:
    """Writes each folded response to the raw archive, in the same pass that folds it
    (Req 26.3, 26.9), and tracks whether every write this run attempted succeeded
    (Req 26.12).

    One instance per run, over that run's `ObjectStore`. `archive_incomplete` starts
    `False` and becomes permanently `True` on the first failed write — `collect/
    pipeline.py` (task 11.9) reads it once, when building the snapshot, to record
    whether this run's archive can be replayed in full.
    """

    store: ObjectStore
    _sequence: int = field(default=0, repr=False)
    _lock: threading.Lock = field(default_factory=threading.Lock, repr=False)
    _incomplete: bool = field(default=False, repr=False)
    _written: int = field(default=0, repr=False)

    @property
    def archive_incomplete(self) -> bool:
        """Whether at least one write this run attempted failed (Req 26.12)."""
        return self._incomplete

    @property
    def object_count(self) -> int:
        """How many objects this run actually landed in the archive.

        Counts **successful** writes, not attempts, which is why it is not simply
        `_sequence`: a sequence number is consumed by a write that then failed, and the
        snapshot's `raw_archive.object_count` is a claim about how many objects a replay
        would find at the run's `raw/` prefix (Req 26.12). Read once, when the snapshot is
        built.
        """
        return self._written

    def _next_sequence(self) -> int:
        with self._lock:
            sequence = self._sequence
            self._sequence += 1
        return sequence

    async def write(
        self,
        *,
        actor_id: str,
        run_id: str,
        subscription_id: str,
        location: str,
        resource_type: str,
        resource_ids: Sequence[str],
        grain: str,
        window: Mapping[str, str],
        metric_names: Sequence[str],
        raw_body: object,
    ) -> ArchiveWriteResult:
        """Write one folded response to the raw archive.

        `resource_ids` is every resource this specific response answered for — the
        batch's resource ids, or the single resource id for a per-resource fallback
        response — and is what Req 26.7's "every resource in that response's grouping
        key" names when the write fails. Never called for a response the caller
        rejected outright (Req 26.10): a caller that never calls `write` for a
        rejection is what makes "a rejected request writes no object" true with no
        check in this module at all.

        Never raises. On a store failure, returns `wrote=False` with one
        `archive_write_failed` gap per resource in `resource_ids`, and flips
        `archive_incomplete` to `True` for the remainder of this instance's life —
        the caller folds the response into the Accumulator and the Sketch regardless
        (Req 26.7) and continues collection.

        Raises `ValueError` for empty `resource_ids`: a response naming no resource is
        not a response this method has any business archiving.
        """
        if not resource_ids:
            raise ValueError(
                "resource_ids must be non-empty; a response naming no resource is "
                "not one this method can archive"
            )

        sequence = self._next_sequence()
        key = archive_key(
            actor_id=actor_id,
            run_id=run_id,
            sequence=sequence,
            location=location,
            resource_type=resource_type,
        )

        document: dict[str, Any] = {
            "grouping_key": {
                "subscription_id": subscription_id,
                "location": location,
                "resource_type": resource_type,
            },
            "grain": grain,
            "window": dict(window),
            "metric_names": list(metric_names),
            "resource_ids": list(resource_ids),
            "raw_response": raw_body,
        }

        try:
            body_bytes = gzip.compress(
                json.dumps(document, default=_json_default).encode("utf-8")
            )
            await self.store.put_bytes(
                key, body_bytes, content_type=JSON_CONTENT_TYPE, tags=_TAGS
            )
        except Exception as exc:
            self._incomplete = True
            logger.warning(
                "archive write failed for key %r (grouping key %r/%r/%r, %d "
                "resource(s)); folding the response anyway and marking this run's "
                "raw archive incomplete: %s",
                key,
                subscription_id,
                location,
                resource_type,
                len(resource_ids),
                exc,
            )
            gaps = tuple(
                record_gap(
                    GAP_TYPE_ARCHIVE_WRITE_FAILED,
                    resource_id,
                    None,
                    f"the raw archive write for key {key!r} failed: {exc}; this "
                    f"resource's metrics were still folded into the accumulator and "
                    f"the sketch, but this run's raw archive is incomplete and "
                    f"cannot be fully replayed.",
                )
                for resource_id in resource_ids
            )
            return ArchiveWriteResult(wrote=False, key=key, gaps=gaps)

        with self._lock:
            self._written += 1
        return ArchiveWriteResult(wrote=True, key=key)

    async def write_inventory(
        self,
        *,
        actor_id: str,
        run_id: str,
        source: str,
        request_target: str,
        page_index: int,
        skip_token_present: bool,
        received_at: str,
        catalog_version: str,
        resource_ids: Sequence[str],
        raw_body: object,
    ) -> ArchiveWriteResult:
        """Write one **inventory** page to the raw archive (Req 7.1, 7.2).

        A separate method rather than a `kind` argument on :meth:`write`, because the two
        object shapes have almost nothing in common: a metrics object is identified by a
        `(subscription, location, resource_type)` grouping key over a window at a grain,
        and an inventory page is identified by its source, its request target and its
        position in a `skip_token` sequence. One method taking the union would have every
        caller passing four `None`s, and the shape a reader gets would depend on which
        arguments happened to be set rather than on a declared field.

        **Why an inventory page is archived at all.** It was not, until a projected fact
        made the inventory response a *fact-producing* response. Req 7.1 requires every
        response that produces a fact to be archived in the pass that folds it, for the
        same reason a metrics response is: a fact absent from the archive is a fact a
        replay cannot re-derive, which makes the recomputed snapshot differ and reports
        `REPLAY_MISMATCH` on a run that collected perfectly.

        Shares this instance's sequence counter, `archive_incomplete` flag and
        `object_count` with :meth:`write`, and that sharing is required rather than
        convenient: the snapshot records **one** `raw_archive.object_count`, and a replay
        refuses to proceed when the number of objects supplied differs from the number the
        sequence names. Two writers would produce two counts and one of them would be
        wrong.

        Never raises, exactly as :meth:`write` never does. On a store failure it records
        one `archive_write_failed` gap per resource on the page and flips
        `archive_incomplete`; the caller keeps the page's records and continues, because a
        run that cannot archive its inventory is still a run that collected an inventory.
        """
        if not resource_ids:
            raise ValueError(
                "resource_ids must be non-empty; an inventory page naming no resource is "
                "not one this method can archive"
            )

        sequence = self._next_sequence()
        key = inventory_archive_key(
            actor_id=actor_id,
            run_id=run_id,
            sequence=sequence,
            source=source,
            page_index=page_index,
        )

        # `kind` is declared, `schema_version` is declared, and the field order below is
        # the order the object's own contract lists them in — see `archive_kind_of` on why
        # the dispatch reads a field rather than sniffing the body.
        document: dict[str, Any] = {
            "schema_version": ARCHIVE_SCHEMA_VERSION,
            "kind": ARCHIVE_KIND_INVENTORY,
            "sequence": sequence,
            "source": source,
            "request_target": request_target,
            "page_index": page_index,
            "skip_token_present": bool(skip_token_present),
            "received_at": received_at,
            "catalog_version": catalog_version,
            "resource_ids": list(resource_ids),
            "raw_response": raw_body,
        }

        try:
            body_bytes = gzip.compress(
                json.dumps(document, default=_json_default).encode("utf-8")
            )
            await self.store.put_bytes(
                key, body_bytes, content_type=JSON_CONTENT_TYPE, tags=_TAGS
            )
        except Exception as exc:
            self._incomplete = True
            logger.warning(
                "archive write failed for inventory key %r (source %r, page %d, %d "
                "resource(s)); keeping the page's records and marking this run's raw "
                "archive incomplete: %s",
                key,
                source,
                page_index,
                len(resource_ids),
                exc,
            )
            gaps = tuple(
                record_gap(
                    GAP_TYPE_ARCHIVE_WRITE_FAILED,
                    resource_id,
                    None,
                    f"the raw archive write for inventory key {key!r} failed: {exc}; "
                    f"this resource's inventory record and any projected fact were "
                    f"still kept, but this run's raw archive is incomplete and cannot "
                    f"be fully replayed.",
                )
                for resource_id in resource_ids
            )
            return ArchiveWriteResult(wrote=False, key=key, gaps=gaps)

        with self._lock:
            self._written += 1
        return ArchiveWriteResult(wrote=True, key=key)
