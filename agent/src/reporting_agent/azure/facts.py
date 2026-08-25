"""The fact pass: three subscription-scoped lists, one fold, and no failure that becomes a value.

`FactCollector.collect` is the only thing here. It runs **between inventory and metrics**
(`collect/pipeline.py`), which is where it is nearly free: the per-subscription concurrency
budget is uncontended at that moment, so two to six requests cost seconds against an
8-to-12-minute run rather than extending its critical path.

## What each source can speak about, and why the caller has to say so

`collect/factfold.py` reports an absence only for a resource named in the request's
`resource_ids`. That is the lever this module pulls, and it is the difference between an
honest gap and a confident falsehood:

* The backup list carries `backupManagementType eq 'AzureIaasVM'`, so it answers for
  **virtual machines**. `Microsoft.Sql/servers/databases` also declares
  `last_backup_status` — a SQL backup lives under the `AzureWorkload` management type,
  which this request does not ask for — so a database is **not** in the covered set and
  records neither a fact nor a `backup_not_configured`. Adding that management type is what
  would answer it; claiming the absence in the meantime would print "backup not configured"
  on a database backed up nightly.
* Site Recovery has no subscription-wide list, so replication is one list **per Recovery
  Services vault the run's inventory already holds**. Where the inventory holds none, this
  module folds **nothing** for the replication key: "no vault is in scope" and "no vault
  protects this VM" are not the same statement, and only the second one is
  `replication_not_enabled`.
* Reservations are tenant-scoped, and Reader at subscription scope does **not** grant
  `Microsoft.Capacity/reservationOrders/read`. So a rejection is the *ordinary* outcome, and
  it records `fact_unavailable` naming the source. Collapsing it into `no_reservations` would
  print "no reservations" on a document for a subscription that has plenty — which is the
  exact confusion Req 5.2 and Req 5.4 exist as two separate criteria to prevent.

## One source, two APIs, two absences

`recovery_services` is one declared `source` covering two different services, and
`collect/factfold.py` decides which declared keys a response could have answered by matching
`source` alone. Folding the backup answer against the whole source would therefore record
`backup_not_configured` for `replication_health` — a backup list cannot say whether
replication is on.

So each fold is given a **narrowed declaration** (:func:`narrowed_to_gap_type`) holding only
the keys whose own `absent_gap_type` that API answers for. Derived from the declaration rather
than from a hard-coded list of key names: the API that answers a key is the API whose absence
that key declares.

## No failure becomes a value

There is no `except` handler in this module whose body neither records a typed gap nor
re-raises, and `tests/test_boundaries.py` asserts that of every module on the path from a fact
response to the Snapshot_Builder (Req 5.7). The shape that makes it easy to hold: a
non-2xx envelope is folded as an **unreadable body**, which is one `fact_unavailable` per
declared key, so "the request failed" travels the same path as "the response was garbage" and
neither has a branch that could produce a fact.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

from reporting_agent.azure.ports import FactsPort
from reporting_agent.catalog.loader import FactDeclaration, ResourceTypeFacts
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.factfold import (
    FACT_KIND_FACTS,
    FACT_KIND_INVENTORY,
    fold_fact_response,
)
from reporting_agent.collect.log import GAP_TYPE_FACT_UNAVAILABLE, record_gap
from reporting_agent.collect.snapshot import rfc3339_utc
from reporting_agent.providers.base import (
    FactRecord,
    GapRecord,
    InventoryPage,
    PlainData,
    ResourceRecord,
)

__all__ = [
    "BACKUP_ABSENT_GAP_TYPE",
    "BACKUP_COVERED_RESOURCE_TYPES",
    "BACKUP_REQUEST_TARGET",
    "MAX_FACT_KEY_LENGTH",
    "MAX_FACT_VALUE_LENGTH",
    "RECOVERY_SERVICES_VAULT_TYPE",
    "REPLICATION_ABSENT_GAP_TYPE",
    "REPLICATION_COVERED_RESOURCE_TYPES",
    "REPLICATION_REQUEST_TARGET",
    "RESERVATION_ABSENT_GAP_TYPE",
    "RESERVATION_COVERED_RESOURCE_TYPES",
    "RESERVATION_REQUEST_TARGET",
    "SOURCE_CAPACITY",
    "SOURCE_RECOVERY_SERVICES",
    "FactArchiveContext",
    "FactCollector",
    "FactsResult",
    "declared_keys",
    "narrowed_to_gap_type",
]

logger = logging.getLogger(__name__)

MAX_FACT_KEY_LENGTH: Final[int] = 120
MAX_FACT_VALUE_LENGTH: Final[int] = 512
"""Req 4.1's two bounds, enforced **here** rather than in the Snapshot_Builder.

Req 5.4 names an over-long value as a `fact_unavailable` case — "answered with a value longer
than the bound criterion 4.1 declares" — so it is a collection outcome, not a snapshot
refusal. A value the source really did carry, too long to record, is a fact that could not be
collected; letting it reach `collect/snapshot.py` would raise there and lose the whole run
over one long string."""

SOURCE_RECOVERY_SERVICES: Final[str] = "recovery_services"
SOURCE_CAPACITY: Final[str] = "capacity"
"""Two of `catalog/loader.py`'s `DECLARED_FACT_SOURCES`, mirrored **by value**.

The same non-coupling `collect/factfold.py` draws against that module: the catalog owns the
vocabulary and this module records which request produced which source. A test asserts the two
spellings agree."""

BACKUP_ABSENT_GAP_TYPE: Final[str] = "backup_not_configured"
REPLICATION_ABSENT_GAP_TYPE: Final[str] = "replication_not_enabled"
RESERVATION_ABSENT_GAP_TYPE: Final[str] = "no_reservations"
"""`catalog/loader.py`'s `DECLARED_ABSENT_GAP_TYPES`, mirrored by value and used **as the
selector** for which declared keys each API answers. See the module docstring."""

RECOVERY_SERVICES_VAULT_TYPE: Final[str] = "Microsoft.RecoveryServices/vaults"
"""The inventory type a replication list is issued per (Req 5.3)."""

BACKUP_COVERED_RESOURCE_TYPES: Final[tuple[str, ...]] = (
    "Microsoft.Compute/virtualMachines",
)
REPLICATION_COVERED_RESOURCE_TYPES: Final[tuple[str, ...]] = (
    "Microsoft.Compute/virtualMachines",
)
RESERVATION_COVERED_RESOURCE_TYPES: Final[tuple[str, ...]] = (
    "Microsoft.Compute/virtualMachines",
)
"""Which resource types each request's answer can speak about — see the module docstring.

Declared here rather than derived from the fact declaration, because the covering set follows
from the **filter this module's request carries**, not from which types happen to declare the
key. `Microsoft.Sql/servers/databases` declares `last_backup_status` and is deliberately absent
from the backup set for exactly that reason."""

# --- the item shape each source normalizes into -------------------------------------
#
# `collect/factfold.py` folds `{"value": [{"resource_id": ..., "<declared key>": ...}]}`. The
# paths below are where each service puts the resource id and the values; keeping them in this
# module is the boundary its own docstring names — a pure fold that knew them would have to
# change whenever a provider did.

_PROPERTIES: Final[str] = "properties"

_BACKUP_RESOURCE_ID_PATHS: Final[tuple[tuple[str, ...], ...]] = (
    (_PROPERTIES, "sourceResourceId"),
    (_PROPERTIES, "virtualMachineId"),
)
_BACKUP_VALUE_PATHS: Final[dict[str, tuple[str, ...]]] = {
    "last_backup_status": (_PROPERTIES, "lastBackupStatus"),
    "last_restore_point": (_PROPERTIES, "lastRecoveryPoint"),
}

_REPLICATION_RESOURCE_ID_PATHS: Final[tuple[tuple[str, ...], ...]] = (
    (_PROPERTIES, "providerSpecificDetails", "fabricObjectId"),
    (_PROPERTIES, "protectableItemId"),
)
_REPLICATION_VALUE_PATHS: Final[dict[str, tuple[str, ...]]] = {
    "replication_health": (_PROPERTIES, "replicationHealth"),
}

_RESERVATION_VALUE_PATHS: Final[dict[str, tuple[str, ...]]] = {
    "reservation_term": (_PROPERTIES, "term"),
    "reservation_expires_at": (_PROPERTIES, "expiryDate"),
}
_RESERVATION_SKU_PATHS: Final[tuple[tuple[str, ...], ...]] = (
    ("sku", "name"),
    (_PROPERTIES, "skuDescription"),
)
_RESERVATION_SCOPE_TYPE_PATH: Final[tuple[str, ...]] = (_PROPERTIES, "appliedScopeType")
_RESERVATION_SCOPES_PATH: Final[tuple[str, ...]] = (_PROPERTIES, "appliedScopes")
_SHARED_SCOPE: Final[str] = "shared"


@dataclass(frozen=True, slots=True)
class FactsResult:
    """One fact pass's records and gaps.

    A frozen pair rather than a `TypedDict` because nothing crosses the provider boundary as
    plain data here: `collect/pipeline.py` hands `facts` straight to the Snapshot_Builder and
    `gaps` into the run's one gap list.
    """

    facts: tuple[FactRecord, ...] = ()
    gaps: tuple[GapRecord, ...] = ()


def narrowed_to_gap_type(
    declaration: FactDeclaration, absent_gap_type: str
) -> FactDeclaration:
    """`declaration` holding only the keys whose `absent_gap_type` is `absent_gap_type`. **Pure.**

    The mechanism the module docstring describes: `recovery_services` is one declared source
    covering two services, and `collect/factfold.py` selects the keys a response could have
    answered by `source` alone. Narrowing the declaration is what keeps a backup answer from
    reporting an absence for a replication key, without teaching the pure fold a second
    selector it would then need for every future source pair.

    Derived from the declaration, so adding a fourth `recovery_services` key with its own
    absent gap type needs no edit here.
    """
    return FactDeclaration(
        resource_types=tuple(
            ResourceTypeFacts(
                resource_type=declared.resource_type,
                facts=tuple(
                    entry
                    for entry in declared.facts
                    if entry.absent_gap_type == absent_gap_type
                ),
            )
            for declared in declaration.resource_types
        )
    )


BACKUP_REQUEST_TARGET: Final[str] = (
    "/providers/Microsoft.RecoveryServices/backupProtectedItems"
)
REPLICATION_REQUEST_TARGET: Final[str] = (
    "/providers/Microsoft.RecoveryServices/vaults/replicationProtectedItems"
)
RESERVATION_REQUEST_TARGET: Final[str] = (
    "/providers/Microsoft.Capacity/reservationOrders/reservations"
)
"""What was asked, recorded on every archived fact object.

ARM paths rather than full URLs, the same discipline `azure/inventory.py`'s
`RESOURCE_GRAPH_REQUEST_TARGET` keeps: a URL carries the subscription id, and an archived
object is read by a replay that already knows the subscription.

The replication target names the vault segment without a vault id, deliberately. One archived
object covers **every** vault the run listed, because `azure/facts.py` folds the accumulated
items as one response — so naming one vault would name whichever happened to be first.
"""


def declared_keys(declaration: FactDeclaration) -> tuple[str, ...]:
    """Every declared key in `declaration`, sorted and deduplicated. **Pure.**

    Read against a **narrowed** declaration, so the result is exactly the set of keys the
    request being archived answers for — which is what `collect/archive.py::write_facts`
    carries as `fact_keys` and what a replay narrows by. See that method on why the keys have
    to travel rather than being re-derived from the gap type they were narrowed on.

    Deduplicated because one key is declared per resource type and several types can declare
    the same key; sorted so two runs archive byte-identical objects for one response.
    """
    return tuple(
        sorted(
            {
                entry.key
                for declared in declaration.resource_types
                for entry in declared.facts
            }
        )
    )


@dataclass(frozen=True, slots=True)
class FactArchiveContext:
    """What :meth:`FactCollector.collect` needs in order to archive a fact response.

    One object rather than three more keyword arguments, mirroring
    `azure/inventory.py`'s `InventoryArchiveContext` — and for the same reason: the three are
    meaningless apart, and grouping them makes "archive the fact responses" one decision at
    the call site rather than three that could disagree.

    **Optional.** `FactCollector` takes `archive_context=None` and then archives nothing,
    which is what keeps every existing caller — and every unit test about the fold — working
    without a run id it has no use for. A run that collects facts and archives none is a run
    whose replay reports `archive_incomplete` rather than a mismatch, which is the honest
    outcome for an archive that was never written.
    """

    actor_id: str
    run_id: str
    catalog_version: str


class FactCollector:
    """The fact pass over one run (Req 4.7, 4.8, 4.9, 5.1-5.5, 5.8-5.10).

    `semaphore` is the **same** `asyncio.Semaphore` object `azure/metrics.py` holds for this
    subscription, handed over by `azure/provider.py` through
    `MetricsCollector.semaphore_for(...)`. Req 4.9 asks for fact requests to count against the
    metric requests' budget rather than against a second one of their own, and sharing the
    object is the only way to mean that — two semaphores of eight would be sixteen in flight.

    `clock` supplies each response's receipt instant, so `collected_at` is an observation about
    when the value was seen and a test drives it rather than the wall clock deciding what lands
    in a snapshot digest.

    `archive` receives one `"facts"` object per folded response (Req 7.1), written **before**
    the fold, so no record derived from a response exists before the response is archived. A
    projected fact's page is archived by `azure/inventory.py` in the pass that produced it and
    is not re-archived here — one response, one object, whichever pass issued it.

    `archive_context` carries the actor, the run and the catalog version those objects need. It
    is **optional**: with none, this collector folds exactly as before and writes nothing,
    which keeps every unit test about the fold free of a run id it has no use for.
    """

    __slots__ = (
        "archive",
        "archive_context",
        "clock",
        "declaration",
        "port",
        "semaphore",
    )

    def __init__(
        self,
        port: FactsPort,
        archive: ArchiveWriter,
        *,
        declaration: FactDeclaration,
        semaphore: asyncio.Semaphore,
        clock: Callable[[], datetime] = lambda: datetime.now(UTC),
        archive_context: FactArchiveContext | None = None,
    ) -> None:
        self.port = port
        self.archive = archive
        self.declaration = declaration
        self.semaphore = semaphore
        self.clock = clock
        self.archive_context = archive_context

    async def collect(
        self,
        *,
        resources: Sequence[ResourceRecord],
        inventory_pages: Sequence[InventoryPage],
        subscription_id: str,
    ) -> FactsResult:
        """Every fact for every resource, from the pages the caller has plus three lists.

        `inventory_pages` are the Resource Graph pages the run **already** paged (Req 4.7): a
        projectable fact costs no request of its own because it was a column in a query that
        had to be issued anyway. `subscription_id` is not on the constructor because the port's
        backup list is scoped by it and one collector serves one run's one subscription — it
        travels with the call that needs it rather than as state that could disagree.

        Returns records and gaps; raises only what a caller cannot continue past. Every
        per-source failure is a gap.
        """
        facts: list[FactRecord] = []
        gaps: list[GapRecord] = []

        types_by_id = {
            record["resource_id"]: record["resource_type"] for record in resources
        }

        projected_facts, projected_gaps = self._fold_pages(inventory_pages, types_by_id)
        facts.extend(projected_facts)
        gaps.extend(projected_gaps)

        for source_facts, source_gaps in await asyncio.gather(
            self._collect_backup(resources, types_by_id, subscription_id),
            self._collect_replication(resources, types_by_id),
            self._collect_reservations(resources, types_by_id),
        ):
            facts.extend(source_facts)
            gaps.extend(source_gaps)

        bounded, bound_gaps = _within_bounds(facts)
        gaps.extend(bound_gaps)
        return FactsResult(facts=tuple(bounded), gaps=tuple(gaps))

    # --- the projectable half, from pages already paged (Req 4.7) --------------------

    def _fold_pages(
        self,
        inventory_pages: Sequence[InventoryPage],
        types_by_id: Mapping[str, str],
    ) -> tuple[list[FactRecord], list[GapRecord]]:
        """Fold every Resource Graph page's `fact_<key>` columns.

        `received_at` is **carried on each page** rather than read here: the pages arrived
        at different instants and a fact's `collected_at` is when *its* response was
        received (Req 4.3, 4.13). One instant for all of them would be a clock default
        dressed as an observation — and re-reading the clock *per page* at fold time,
        which is what this did, is the same mistake wearing the right shape. The fold runs
        after the page arrives, so its reading is a different instant from the one the
        archive stored; a fold that crossed a second boundary stamped every projected fact
        one second late and the replay, which re-derives from the archived value, reported
        a mismatch on a snapshot that was reproducible.

        The `resource_ids` for each page are the ids the page itself carries, so a resource on
        page two records no absence from page one — which would otherwise be one
        `fact_unavailable` per projectable key for every resource on every other page.
        """
        facts: list[FactRecord] = []
        gaps: list[GapRecord] = []
        for page in inventory_pages:
            body = page["body"]
            page_ids = _page_resource_ids(body)
            if not page_ids:
                continue
            page_facts, page_gaps = fold_fact_response(
                body,
                kind=FACT_KIND_INVENTORY,
                source="",  # unread for the inventory kind: it selects on `projectable`
                resource_ids=page_ids,
                declaration=self.declaration,
                resource_types=types_by_id,
                # The instant the page was received, as the archive recorded it — not
                # this fold's own reading of the clock.
                received_at=page["received_at"],
            )
            facts.extend(page_facts)
            gaps.extend(page_gaps)
        return facts, gaps

    # --- the three lists ------------------------------------------------------------

    async def _collect_backup(
        self,
        resources: Sequence[ResourceRecord],
        types_by_id: Mapping[str, str],
        subscription_id: str,
    ) -> tuple[tuple[FactRecord, ...], tuple[GapRecord, ...]]:
        """One subscription-scoped backup list, folded for the types its filter covers."""
        covered = _covered_ids(resources, BACKUP_COVERED_RESOURCE_TYPES)
        declared = narrowed_to_gap_type(self.declaration, BACKUP_ABSENT_GAP_TYPE)
        if not covered or not declared.entries:
            return (), ()

        async with self.semaphore:
            response = await self.port.list_backup_protected_items(
                subscription_id=subscription_id
            )
        received_at = self._now()
        body = _normalized(
            response.body if response.ok else None,
            id_paths=_BACKUP_RESOURCE_ID_PATHS,
            value_paths=_BACKUP_VALUE_PATHS,
        )

        gaps = await self._archive(
            source=SOURCE_RECOVERY_SERVICES,
            request_target=BACKUP_REQUEST_TARGET,
            declared=declared,
            resource_ids=covered,
            received_at=received_at,
            body=body,
        )

        facts, fold_gaps = fold_fact_response(
            body,
            kind=FACT_KIND_FACTS,
            source=SOURCE_RECOVERY_SERVICES,
            resource_ids=covered,
            declaration=declared,
            resource_types=types_by_id,
            received_at=received_at,
        )
        return facts, (*gaps, *fold_gaps)

    async def _collect_replication(
        self,
        resources: Sequence[ResourceRecord],
        types_by_id: Mapping[str, str],
    ) -> tuple[tuple[FactRecord, ...], tuple[GapRecord, ...]]:
        """One replication list per Recovery Services vault in the run's inventory (Req 5.3).

        **Where the inventory holds no vault, this folds nothing at all** — no fact and no gap.
        Site Recovery has no subscription-wide list, so with no vault in scope there is no
        request that could have answered, and `replication_not_enabled` would then be a claim
        about a service nobody asked. A vault outside the run's scope is invisible from here,
        and "invisible" is not "absent".
        """
        vaults = _vault_ids(resources)
        covered = _covered_ids(resources, REPLICATION_COVERED_RESOURCE_TYPES)
        declared = narrowed_to_gap_type(self.declaration, REPLICATION_ABSENT_GAP_TYPE)
        if not vaults or not covered or not declared.entries:
            if covered and declared.entries:
                logger.info(
                    "no %s is in this run's inventory, so replication was not listed; no "
                    "replication fact and no replication gap is recorded for %d resource(s).",
                    RECOVERY_SERVICES_VAULT_TYPE,
                    len(covered),
                )
            return (), ()

        items: list[Mapping[str, PlainData]] = []
        readable = True
        for vault_id in vaults:
            async with self.semaphore:
                response = await self.port.list_replication_protected_items(
                    vault_id=vault_id
                )
            if not response.ok:
                # One unreadable vault makes the whole answer unreadable, deliberately. A
                # partial listing cannot distinguish "this VM is not replicated" from "the
                # vault protecting it is the one that failed", so the honest outcome for every
                # covered resource is `fact_unavailable` rather than a mix of one true gap and
                # one false one.
                logger.warning(
                    "the replication list for vault %r answered HTTP %d; replication is "
                    "reported as unavailable for this run rather than as not enabled.",
                    vault_id,
                    response.status,
                )
                readable = False
                break
            items.extend(_items_of(response.body))

        received_at = self._now()
        body = _normalized(
            {"value": items} if readable else None,
            id_paths=_REPLICATION_RESOURCE_ID_PATHS,
            value_paths=_REPLICATION_VALUE_PATHS,
        )

        # One object for every vault the run listed, because the accumulated items are folded
        # as **one** response. Written after the last vault request and before the fold.
        gaps = await self._archive(
            source=SOURCE_RECOVERY_SERVICES,
            request_target=REPLICATION_REQUEST_TARGET,
            declared=declared,
            resource_ids=covered,
            received_at=received_at,
            body=body,
        )

        facts, fold_gaps = fold_fact_response(
            body,
            kind=FACT_KIND_FACTS,
            source=SOURCE_RECOVERY_SERVICES,
            resource_ids=covered,
            declaration=declared,
            resource_types=types_by_id,
            received_at=received_at,
        )
        return facts, (*gaps, *fold_gaps)

    async def _collect_reservations(
        self,
        resources: Sequence[ResourceRecord],
        types_by_id: Mapping[str, str],
    ) -> tuple[tuple[FactRecord, ...], tuple[GapRecord, ...]]:
        """One reservation listing, matched to resources by applied scope and SKU (Req 5.2).

        **The two outcomes are not collapsed, and that is the whole point of this method.**
        A rejected `Microsoft.Capacity` request folds an unreadable body, which is
        `fact_unavailable` naming the source; a successful listing that covers nothing folds an
        empty item list, which is `no_reservations`. Reader at subscription scope does not grant
        the reservation read, so the first is the common case — and reporting it as the second
        would print "no reservations" on a document for a subscription that has plenty.
        """
        covered = _covered_ids(resources, RESERVATION_COVERED_RESOURCE_TYPES)
        declared = narrowed_to_gap_type(self.declaration, RESERVATION_ABSENT_GAP_TYPE)
        if not covered or not declared.entries:
            return (), ()

        async with self.semaphore:
            response = await self.port.list_reservations()
        received_at = self._now()

        # **One** guard on `response.ok`, not two. A second, redundant check reads as
        # defence in depth and is the opposite: either one alone keeps the behaviour correct,
        # so neither is covered by a test and both can rot. The status decides here and the
        # rest of this method reads `normalized`.
        normalized: PlainData = None
        if response.ok:
            normalized = _normalized(
                {"value": _reservation_items(response.body, resources)},
                id_paths=(("resource_id",),),
                value_paths=_RESERVATION_VALUE_PATHS,
            )
        else:
            logger.info(
                "the reservation listing answered HTTP %d; every reservation fact is "
                "reported as unavailable rather than as absent.",
                response.status,
            )

        gaps = await self._archive(
            source=SOURCE_CAPACITY,
            request_target=RESERVATION_REQUEST_TARGET,
            declared=declared,
            resource_ids=covered,
            received_at=received_at,
            body=normalized,
        )

        facts, fold_gaps = fold_fact_response(
            normalized,
            kind=FACT_KIND_FACTS,
            source=SOURCE_CAPACITY,
            resource_ids=covered,
            declaration=declared,
            resource_types=types_by_id,
            received_at=received_at,
        )
        return facts, (*gaps, *fold_gaps)

    async def _archive(
        self,
        *,
        source: str,
        request_target: str,
        declared: FactDeclaration,
        resource_ids: Sequence[str],
        received_at: str,
        body: PlainData,
    ) -> tuple[GapRecord, ...]:
        """Archive one fact response, before it is folded (Req 7.1). Returns its gaps.

        The ordering is the requirement: the object lands, and only then does any record
        derived from it exist. Observable as the call order a recording object store sees,
        which is how `tests/test_facts_archive.py` checks it rather than reading this comment.

        `declared` is the **narrowed** declaration this source answers for, so `fact_keys`
        names exactly the keys a replay must narrow to. Passing the full declaration here
        would archive an object claiming the backup request answered for the replication key.

        Returns `()` with no context — a collector built without one archives nothing, and a
        write failure returns its `archive_write_failed` gaps rather than raising, so the fold
        below runs either way.
        """
        context = self.archive_context
        if context is None:
            return ()

        result = await self.archive.write_facts(
            actor_id=context.actor_id,
            run_id=context.run_id,
            source=source,
            request_target=request_target,
            fact_keys=declared_keys(declared),
            received_at=received_at,
            catalog_version=context.catalog_version,
            resource_ids=resource_ids,
            raw_body=body,
        )
        return result.gaps

    def _now(self) -> str:
        """This response's receipt instant, RFC 3339 UTC, whole seconds (Req 4.3)."""
        return rfc3339_utc(self.clock())


# --- normalization and bounds -------------------------------------------------------


def _normalized(
    body: PlainData,
    *,
    id_paths: Sequence[Sequence[str]],
    value_paths: Mapping[str, Sequence[str]],
) -> PlainData:
    """One service's list body as the `(resource_id, key)` item shape the fold reads. **Pure.**

    `None` in, `None` out — which the fold reads as an unreadable body and turns into one
    `fact_unavailable` per declared key. That is how "the request was rejected" reaches the
    same code path as "the response was garbage", with no branch between them that could
    produce a fact.
    """
    if body is None:
        return None
    items = _items_of(body)
    normalized: list[dict[str, PlainData]] = []
    for item in items:
        resource_id = ""
        for path in id_paths:
            resource_id = _text_at(item, path)
            if resource_id:
                break
        if not resource_id:
            continue
        entry: dict[str, PlainData] = {"resource_id": resource_id}
        for key, path in value_paths.items():
            found = _text_at(item, path)
            if found:
                entry[key] = found
        normalized.append(entry)
    return {"value": normalized}


def _reservation_items(
    body: PlainData, resources: Sequence[ResourceRecord]
) -> list[dict[str, PlainData]]:
    """One item per `(resource, covering reservation)` pair. **Pure.**

    A reservation names no resource — it names an applied scope and a SKU — so the covering
    relation has to be computed rather than read. A reservation covers a resource where its
    applied scope contains that resource **and** its SKU is the resource's own SKU.

    A resource no reservation covers produces **no item**, which the fold then records as
    `no_reservations` for that resource alone. That is what makes the gap per-resource rather
    than per-subscription: one VM on a reserved size and one on an on-demand size in the same
    subscription are two different answers.
    """
    covering: list[dict[str, PlainData]] = []
    reservations = _items_of(body)
    for record in resources:
        for reservation in reservations:
            if not _reservation_covers(reservation, record):
                continue
            entry: dict[str, PlainData] = {"resource_id": record["resource_id"]}
            for key, path in _RESERVATION_VALUE_PATHS.items():
                found = _text_at(reservation, path)
                if found:
                    entry[key] = found
            covering.append({**entry, _PROPERTIES: reservation.get(_PROPERTIES)})
            break
    return covering


def _reservation_covers(
    reservation: Mapping[str, PlainData], record: ResourceRecord
) -> bool:
    """Whether `reservation` covers `record`. **Pure.**

    Two conditions, both necessary. A `Shared` applied scope covers the whole subscription; a
    `Single` one lists the subscription or resource-group ids a covered resource id begins
    with. And the reserved SKU has to be the resource's own SKU, because a reservation for one
    VM size says nothing about a VM of another.

    Case-folded on both, because ARM echoes a resource id back with whatever casing the caller
    used and a SKU name is not case-significant.
    """
    sku = (record.get("sku_name") or "").casefold()
    if not sku:
        return False

    reserved = ""
    for path in _RESERVATION_SKU_PATHS:
        reserved = _text_at(reservation, path)
        if reserved:
            break
    if reserved.casefold() != sku:
        return False

    scope_type = _text_at(reservation, _RESERVATION_SCOPE_TYPE_PATH).casefold()
    if scope_type == _SHARED_SCOPE:
        return True

    resource_id = record["resource_id"].casefold()
    raw_scopes = _value_at(reservation, _RESERVATION_SCOPES_PATH)
    scopes = raw_scopes if isinstance(raw_scopes, list) else []
    return any(
        isinstance(scope, str) and scope.strip() and resource_id.startswith(scope.casefold())
        for scope in scopes
    )


def _within_bounds(
    facts: Sequence[FactRecord],
) -> tuple[list[FactRecord], list[GapRecord]]:
    """Drop every fact outside Req 4.1's bounds, recording `fact_unavailable` for each.

    Req 5.4 names an over-long value as a collection failure rather than a snapshot refusal,
    and the distinction is not academic: `collect/snapshot.py` raises and writes no object, so
    letting one 600-character string through would cost the whole run rather than one cell.
    """
    kept: list[FactRecord] = []
    gaps: list[GapRecord] = []
    for fact in facts:
        problem = _bound_problem(fact)
        if problem is None:
            kept.append(fact)
            continue
        gaps.append(
            record_gap(
                GAP_TYPE_FACT_UNAVAILABLE,
                fact["resource_id"],
                fact["key"],
                f"{fact['key']!r} was answered by {fact['source']} with a value this "
                f"snapshot cannot record: {problem}.",
                source=fact["source"],
            )
        )
    return kept, gaps


def _bound_problem(fact: FactRecord) -> str | None:
    """Why `fact` is outside Req 4.1's bounds, or `None`. **Pure.**"""
    key = fact["key"]
    value = fact["value"]
    if not key or len(key) > MAX_FACT_KEY_LENGTH:
        return (
            f"its key is {len(key)} characters, outside 1 to {MAX_FACT_KEY_LENGTH}"
        )
    if not value or len(value) > MAX_FACT_VALUE_LENGTH:
        return (
            f"the value is {len(value)} characters, outside 1 to {MAX_FACT_VALUE_LENGTH}"
        )
    return None


# --- readers ------------------------------------------------------------------------


def _covered_ids(
    resources: Sequence[ResourceRecord], resource_types: Sequence[str]
) -> tuple[str, ...]:
    """Every resource id of one of `resource_types`, in inventory order. **Pure.**

    Case-folded, because Resource Graph lower-cases `type` in its response body while these
    constants carry the catalog's spelling — an exact comparison would cover nothing on every
    real subscription.
    """
    wanted = {name.casefold() for name in resource_types}
    return tuple(
        record["resource_id"]
        for record in resources
        if record["resource_type"].casefold() in wanted
    )


def _vault_ids(resources: Sequence[ResourceRecord]) -> tuple[str, ...]:
    return _covered_ids(resources, (RECOVERY_SERVICES_VAULT_TYPE,))


def _page_resource_ids(page: PlainData) -> tuple[str, ...]:
    """Every resource id one Resource Graph page names, in row order. **Pure.**"""
    if not isinstance(page, Mapping):
        return ()
    rows = page.get("data")
    if not isinstance(rows, list):
        return ()
    found: list[str] = []
    seen: set[str] = set()
    for row in rows:
        if not isinstance(row, Mapping):
            continue
        resource_id = row.get("id")
        if isinstance(resource_id, str) and resource_id.strip() and resource_id not in seen:
            seen.add(resource_id)
            found.append(resource_id)
    return tuple(found)


def _items_of(body: PlainData) -> list[Mapping[str, PlainData]]:
    """An ARM list body's `value` array, or a bare list, as mappings. **Pure.**"""
    raw: PlainData
    if isinstance(body, list):
        raw = body
    elif isinstance(body, Mapping):
        raw = body.get("value")
    else:
        return []
    if not isinstance(raw, list):
        return []
    return [item for item in raw if isinstance(item, Mapping)]


def _value_at(item: Mapping[str, PlainData], path: Sequence[str]) -> PlainData:
    """The value at a dotted path through nested mappings, or `None`. **Pure.**"""
    current: PlainData = item
    for segment in path:
        if not isinstance(current, Mapping):
            return None
        current = current.get(segment)
    return current


def _text_at(item: Mapping[str, PlainData], path: Sequence[str]) -> str:
    """The value at `path` as a non-empty string, or `""`. **Pure.**

    A `bool` renders rather than reading as absent, the same reading
    `collect/factfold.py._text` takes: `false` is an answer.
    """
    found = _value_at(item, path)
    if isinstance(found, str):
        return found.strip()
    if isinstance(found, bool):
        return "true" if found else "false"
    if isinstance(found, int):
        return str(found)
    return ""


# Contradictions worth catching at import rather than on the first collection.
assert MAX_FACT_KEY_LENGTH == 120 and MAX_FACT_VALUE_LENGTH == 512
assert RESERVATION_COVERED_RESOURCE_TYPES  # a source covering nothing would fold nothing
assert "Microsoft.Sql/servers/databases" not in BACKUP_COVERED_RESOURCE_TYPES, (
    "the backup list is filtered to AzureIaasVM, so it cannot speak for a SQL database; "
    "covering one here would record backup_not_configured for a database backed up nightly"
)



