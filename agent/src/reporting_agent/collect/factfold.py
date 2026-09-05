"""The one fact derivation: a response in, `(facts, gaps)` out (Req 5.1-5.5, 5.8-5.10, 7.7).

**Pure.** No clock, no network, no object store, no catalog file read. `received_at` is
supplied, exactly as `collect/archive.py` takes it, because a fold that read the wall clock
would put a different instant into the snapshot on every run and the archive's replay could
never reproduce it.

## Two response shapes, one fold

`kind` selects the reader and nothing else:

* :data:`FACT_KIND_INVENTORY` — a Resource Graph page. Every projectable fact rides the
  inventory query as a `fact_<key>` column (Req 4.7), so the facts arrive in the same response
  the resources do, at no extra request.
* :data:`FACT_KIND_FACTS` — one non-projectable source's own answer: Recovery Services,
  the capacity API, an ARM per-resource read. The port has already flattened it into
  per-resource items (see :func:`_items`), so this module knows nothing about where in a
  provider's JSON a backup status lives.

Everything after the reader is shared: the same declaration walk, the same numeric parse, the
same two ways a key can be absent. One fold rather than one per source is the point — four
readers would be four places for the absence rule to be got subtly differently, and the
absence rule is the whole content of a fact gap.

## The loop is over the declaration, never over the response

:func:`projected_facts_from_row` iterates **the declaration for that row's own resource
type**, and that is what makes Req 5.9 structural rather than a rule someone remembers. A key
the type does not declare is never visited, so it can produce neither a fact nor a gap — no
storage account can collect a `no_reservations` gap, because `no_reservations` is not in the
storage account's declaration to be looked for.

Iterating the *response* instead would invert that: an item carrying an unexpected field would
mint a fact for a key nothing declared, with a `value_kind` and a `unit` nobody could supply.

## The two ways a key is absent, and why they are different gaps

Req 5.8 forbids recording both for one key, so the two are exclusive by construction here:

| what happened | gap |
|---|---|
| the source answered and named nothing for this `(resource, key)` | the key's declared `absent_gap_type` |
| the request failed, or the value is present and unusable | `fact_unavailable` |

*"Azure says there is no backup"* and *"we could not ask Azure about the backup"* are opposite
facts, and a report that showed the first when the second happened would tell a reader their
estate is unprotected on the strength of a failed request.

A **projectable** fact has no `absent_gap_type` at all, so its absence is always
`fact_unavailable` — Resource Graph returning no value for a column it was asked to project is
not a configuration state, it is a column that did not resolve.

## Every numeric leaf goes through `collect/numeric.decimal_leaf`

One reader, both directions, and it never raises: a value that does not parse comes back
`None` and classifies as **unusable**, which is `fact_unavailable`. That is deliberately not
the same as absent — the source did answer, and what it said could not be used, which is a
fact about the response rather than about the estate.

The parsed `Decimal` is then re-serialized in **plain notation** (:func:`_decimal_string`), so
a response carrying `1E+2` reaches the snapshot as `100`. `collect/snapshot.py`'s
`NUMERIC_FACT_GRAMMAR` is anchored and admits no exponent, so a fold that passed the digits
through unchanged would produce a record the snapshot builder refuses — after the collection
has been spent.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from decimal import Decimal
from typing import Final

from reporting_agent.catalog.loader import FactDeclaration, FactDeclarationEntry
from reporting_agent.collect.log import GAP_TYPE_FACT_UNAVAILABLE, record_gap
from reporting_agent.collect.numeric import decimal_leaf
from reporting_agent.providers.base import FactRecord, GapRecord, PlainData

__all__ = [
    "FACT_KINDS",
    "FACT_KIND_FACTS",
    "FACT_KIND_INVENTORY",
    "FACT_VALUE_KIND_NUMERIC",
    "FACT_VALUE_KIND_TEXT",
    "fold_fact_response",
    "projected_facts_from_row",
]

FACT_KIND_INVENTORY: Final[str] = "inventory"
FACT_KIND_FACTS: Final[str] = "facts"
FACT_KINDS: Final[tuple[str, ...]] = (FACT_KIND_INVENTORY, FACT_KIND_FACTS)
"""The two response shapes, and the closed set `kind` is checked against.

:data:`FACT_KIND_INVENTORY` is spelled exactly as `collect/archive.py`'s
`ARCHIVE_KIND_INVENTORY` — **by value, not by import** — because an archived Resource Graph
page and a Resource Graph page being folded are the same response: a replay reads the kind off
the archived object and hands it straight to this fold. Mirroring by value rather than
importing keeps a pure fold out of the archive's import graph, and a test pins the two
together.

The other two do not correspond. `ARCHIVE_KIND_METRICS` is a metrics batch response, which
this fold never sees, and :data:`FACT_KIND_FACTS` covers the non-projectable sources."""

FACT_VALUE_KIND_NUMERIC: Final[str] = "numeric"
FACT_VALUE_KIND_TEXT: Final[str] = "text"
"""Req 4.11's two kinds, mirrored from `catalog/loader.py`'s `DECLARED_FACT_VALUE_KINDS` by
value. The declaration decides which one a key is; this module only branches on it."""

_FACT_FIELD_PREFIX: Final[str] = "fact_"
"""The prefix `azure/clients.py` puts on every projected column, stripped here.

Mirrored by value rather than imported, because `collect/` may not depend on `azure/` for a
constant it can restate in one line — and `tests/test_inventory_facts.py` asserts the two
agree, which is a cheaper coupling than an import that drags the SDK's package into a pure
module's import graph."""

_ROW_ID_KEY: Final[str] = "id"
_ROW_TYPE_KEY: Final[str] = "type"
_ROW_LIST_KEY: Final[str] = "data"
"""The three Resource Graph response keys this reader touches. `type` arrives **lower-cased**
by the service, which is why every declaration lookup goes through
`FactDeclaration.for_resource_type` and its case-folded match rather than a dict index."""

_ITEM_LIST_KEY: Final[str] = "value"
_ITEM_ID_KEYS: Final[tuple[str, ...]] = ("resource_id", "id")
"""The shape a non-projectable source's port hands over: `{"value": [{...}, ...]}` — ARM's
list convention — or a bare list, with each item naming its resource under one of these two
keys and carrying its fact values under the **declared fact keys themselves**, unprefixed.

`azure/facts.py` normalizes into this — not the port, which answers with the envelope the
service sent and interprets nothing. That boundary is deliberate: a backup status lives at
`properties.sourceResourceId` on one API and somewhere else on the next, and a pure fold that
knew those paths would be a pure module that has to change whenever a provider does."""


def fold_fact_response(
    body: PlainData,
    *,
    kind: str,
    source: str,
    resource_ids: Sequence[str],
    declaration: FactDeclaration,
    resource_types: Mapping[str, str],
    received_at: str,
) -> tuple[tuple[FactRecord, ...], tuple[GapRecord, ...]]:
    """Fold one fact-bearing response into records and gaps. **Pure.**

    `resource_ids` is every resource the request covered, and it is what makes absence
    observable at all: a `(resource, key)` pair can only be reported as absent by a fold that
    knows the resource was asked about. A response that simply omits a resource is
    indistinguishable, from the response alone, from a resource nobody requested.

    `resource_types` maps resource id to the type as the **inventory** recorded it, so a
    `FACT_KIND_FACTS` item — which carries no type of its own — still resolves to the right
    declaration. For `FACT_KIND_INVENTORY` the row's own `type` is preferred and this mapping
    is the fallback, because the row is the more direct evidence.

    Raises `ValueError` for an undeclared `kind`, and for nothing else. Every other failure
    is a gap: a body that is not the declared shape means the request answered something
    unusable, which is one `fact_unavailable` per `(resource, declared key)` rather than an
    exception a caller mid-collection has to catch.
    """
    if kind not in FACT_KINDS:
        raise ValueError(
            f"{kind!r} is not one of the declared fact response kinds {list(FACT_KINDS)}; "
            f"a typo must fail rather than silently fold the wrong reader"
        )

    # Keyed on the **case-folded** resource id, and looked up the same way below.
    #
    # ARM resource ids are case-insensitive by Azure's own contract, and the services
    # disagree about casing in practice: Advisor answers
    # `/subscriptions/…/resourcegroups/fatechid/providers/microsoft.compute/virtualmachines/cpn-mcp`
    # where Resource Graph holds `…/resourceGroups/FATechID/…/virtualMachines/CPN-MCP`.
    # One inventory in this repo's own evidence carries two casings of one resource group.
    #
    # Folding on the exact string made every one of a subscription's 26 live Advisor
    # recommendations miss its resource, and the delivered report printed "No values
    # recorded for these resources in this period" over a section that had 26 of them.
    # The run was not marked incomplete, because "advisor answered and named no
    # 'category' for this resource" is a truthful sentence about a lookup that silently
    # could not succeed.
    #
    # The fold key is normalised; nothing else is. The `FactRecord` still carries the
    # **inventory's** own spelling of the id, which is what the document renders and what
    # every anchor and every replay resolves against.
    observed: dict[tuple[str, str], PlainData] = {}
    unreadable = False

    if kind == FACT_KIND_INVENTORY:
        rows = _rows(body)
        if rows is None:
            unreadable = True
        else:
            for row in rows:
                resource_id = _text(row.get(_ROW_ID_KEY))
                if not resource_id:
                    # A row with no usable id names nothing to record a fact or a gap
                    # against — the same reading `azure/inventory.py` takes of it.
                    continue
                for column, value in row.items():
                    if isinstance(column, str) and column.startswith(_FACT_FIELD_PREFIX):
                        key = column[len(_FACT_FIELD_PREFIX) :]
                        if key:
                            observed[(resource_id.casefold(), key)] = value
    else:
        items = _items(body)
        if items is None:
            unreadable = True
        else:
            for item in items:
                resource_id = _item_resource_id(item)
                if not resource_id:
                    continue
                for key, value in item.items():
                    if isinstance(key, str) and key not in _ITEM_ID_KEYS:
                        observed[(resource_id.casefold(), key)] = value

    facts: list[FactRecord] = []
    gaps: list[GapRecord] = []

    for resource_id in _unique(resource_ids):
        row_type = _row_type_for(resource_id, body, kind) or resource_types.get(
            resource_id, ""
        )
        for entry in declaration.for_resource_type(row_type):
            if not _entry_is_answered_by(entry, kind=kind, source=source):
                continue
            fact, gap = _fold_one(
                entry,
                resource_id=resource_id,
                observed=observed,
                received_at=received_at,
                unreadable=unreadable,
            )
            if fact is not None:
                facts.append(fact)
            if gap is not None:
                gaps.append(gap)

    return tuple(facts), tuple(gaps)


def projected_facts_from_row(
    row: Mapping[str, PlainData],
    *,
    declaration: FactDeclaration,
    received_at: str,
) -> tuple[tuple[FactRecord, ...], tuple[GapRecord, ...]]:
    """One Resource Graph row's projected facts and its absences. **Pure.**

    The single-row entry point :func:`fold_fact_response` is the page-level wrapper around, and
    the one a caller folding a row as it arrives uses. The loop is over the declaration for
    **this row's own resource type** — see the module docstring on why that is what makes
    Req 5.9 structural.

    Returns `((), ())` for a row with no usable `id`: a row that names no resource names
    nothing to record a fact against, and nothing to record a gap against either.
    """
    resource_id = _text(row.get(_ROW_ID_KEY))
    if not resource_id:
        return (), ()

    return fold_fact_response(
        {_ROW_LIST_KEY: [dict(row)]},
        kind=FACT_KIND_INVENTORY,
        source=_RESOURCE_GRAPH_SOURCE,
        resource_ids=(resource_id,),
        declaration=declaration,
        resource_types={resource_id: _text(row.get(_ROW_TYPE_KEY))},
        received_at=received_at,
    )


_RESOURCE_GRAPH_SOURCE: Final[str] = "resource_graph"
"""The source every projectable fact records, mirrored by value from
`catalog/loader.py`'s `DECLARED_FACT_SOURCES`. A projected column came from the inventory
query, so its provenance is not a parameter a caller could get wrong."""


# --- one entry, one resource -------------------------------------------------------


def _fold_one(
    entry: FactDeclarationEntry,
    *,
    resource_id: str,
    observed: Mapping[tuple[str, str], PlainData],
    received_at: str,
    unreadable: bool,
) -> tuple[FactRecord | None, GapRecord | None]:
    """`(fact, gap)` for one declared key on one resource — **at most one of each, never
    both**.

    That exclusivity is Req 5.8 expressed as a return type. A key that produced a value has
    no absence to record, and a key that produced none has no fact to record; a shape that
    could return both would let a displayed absence count be twice the number of absences.
    """
    if unreadable:
        return None, _unavailable(entry, resource_id, "the response could not be read")

    # Case-folded, matching how `observed` was built — see its own note.
    lookup = (resource_id.casefold(), entry.key)
    if lookup not in observed:
        return None, _absent(entry, resource_id)

    raw = observed[lookup]
    text = _text(raw)

    # Req 5.5 — no `Fact` whose value is the empty string. An empty projected column is how
    # Resource Graph spells "this row has no such property", and `coalesce(...)` over two
    # paths that both miss produces exactly that, so this is the ordinary absence rather
    # than an edge case.
    if not text.strip():
        return None, _absent(entry, resource_id)

    if entry.value_kind == FACT_VALUE_KIND_NUMERIC:
        parsed = decimal_leaf(raw if isinstance(raw, Decimal) else text)
        if parsed is None or not parsed.is_finite():
            # The source answered and what it said cannot be used. Distinct from absent:
            # the estate said something, and the something was unusable.
            return None, _unavailable(
                entry,
                resource_id,
                f"the value is not a usable number for the declared numeric key "
                f"{entry.key!r}",
            )
        value = _decimal_string(parsed)
    else:
        value = text

    return (
        FactRecord(
            resource_id=resource_id,
            key=entry.key,
            value=value,
            value_kind=entry.value_kind,
            source=entry.source,
            collected_at=received_at,
            unit=entry.unit,
        ),
        None,
    )


def _absent(entry: FactDeclarationEntry, resource_id: str) -> GapRecord:
    """The gap for a key the source answered about and named nothing for.

    A **non-projectable** key names its own `absent_gap_type` — `backup_not_configured`,
    `no_reservations`, `replication_not_enabled` — and those are not errors: they are what an
    ordinary subscription looks like. A **projectable** key declares none, so its absence is
    `fact_unavailable`; see the module docstring.
    """
    if entry.absent_gap_type:
        return record_gap(
            entry.absent_gap_type,
            resource_id,
            entry.key,
            f"{entry.source} answered and named no {entry.key!r} for this resource",
            source=entry.source,
        )
    return _unavailable(
        entry, resource_id, f"the response carried no value for {entry.key!r}"
    )


def _unavailable(
    entry: FactDeclarationEntry, resource_id: str, why: str
) -> GapRecord:
    return record_gap(
        GAP_TYPE_FACT_UNAVAILABLE,
        resource_id,
        entry.key,
        f"{entry.key!r} could not be collected from {entry.source}: {why}",
        source=entry.source,
    )


def _entry_is_answered_by(
    entry: FactDeclarationEntry, *, kind: str, source: str
) -> bool:
    """Whether this declared key is one **this** response could have answered.

    Two conditions, and both matter. A `FACT_KIND_INVENTORY` response answers the
    **projectable** keys and only those, whatever their declared source — a projected column
    is a column, and a non-projectable key was never in that query to be absent from it. A
    `FACT_KIND_FACTS` response answers the non-projectable keys of the **one source** it came
    from, so a Recovery Services answer cannot record an absence for a key only the capacity
    API is asked for.

    Without the second condition, one source's response would record an absent gap for every
    other source's keys — Req 5.10's `source` field would still be populated, correctly, and
    the gap would still be wrong.
    """
    if kind == FACT_KIND_INVENTORY:
        return entry.projectable
    return not entry.projectable and entry.source == source


# --- readers -----------------------------------------------------------------------


def _rows(body: PlainData) -> list[Mapping[str, PlainData]] | None:
    """A Resource Graph page's `data` rows, or `None` if the body is not that shape."""
    if not isinstance(body, Mapping):
        return None
    raw = body.get(_ROW_LIST_KEY)
    if not isinstance(raw, list):
        return None
    return [row for row in raw if isinstance(row, Mapping)]


def _items(body: PlainData) -> list[Mapping[str, PlainData]] | None:
    """A non-projectable source's normalized items, or `None` if the body is not that shape.

    A bare list is accepted alongside `{"value": [...]}` because a port that already unwrapped
    the envelope should not have to re-wrap it to be readable here.
    """
    raw: PlainData
    if isinstance(body, list):
        raw = body
    elif isinstance(body, Mapping):
        raw = body.get(_ITEM_LIST_KEY)
    else:
        return None
    if not isinstance(raw, list):
        return None
    return [item for item in raw if isinstance(item, Mapping)]


def _item_resource_id(item: Mapping[str, PlainData]) -> str:
    for key in _ITEM_ID_KEYS:
        found = _text(item.get(key))
        if found:
            return found
    return ""


def _row_type_for(resource_id: str, body: PlainData, kind: str) -> str:
    """The resource type an inventory row declares for `resource_id`, or `""`.

    Only meaningful for `FACT_KIND_INVENTORY` — a normalized fact item carries no type — and
    preferred over the caller's mapping there because the row is the response's own statement
    about what the resource is.
    """
    if kind != FACT_KIND_INVENTORY:
        return ""
    for row in _rows(body) or ():
        if _text(row.get(_ROW_ID_KEY)) == resource_id:
            return _text(row.get(_ROW_TYPE_KEY))
    return ""


def _text(value: PlainData) -> str:
    """`value` as a string, or `""`.

    A `str` is returned as-is; `bool` and numeric leaves are rendered, because a projection
    like `tostring(properties.zoneRedundant)` can hand back a JSON boolean if the service
    declines to stringify it, and `True` is a fact worth recording rather than a hole.
    `None` — and a container, which no leaf should ever be — is `""`, the absence spelling
    this module already treats as absent.
    """
    if isinstance(value, str):
        return value
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal):
        return _decimal_string(value) if value.is_finite() else ""
    if isinstance(value, int):
        return str(value)
    return ""


def _decimal_string(value: Decimal) -> str:
    """`value` in plain notation, never exponent notation.

    `str(Decimal("1E+2"))` is `"1E+2"`, which `collect/snapshot.py`'s anchored
    `NUMERIC_FACT_GRAMMAR` rejects — so a fold that passed the digits through would build a
    record the snapshot builder refuses, after the collection has already been spent.
    `format(value, "f")` is the same quantity written the way the grammar admits.
    """
    return format(value, "f")


def _unique(resource_ids: Sequence[str]) -> list[str]:
    """`resource_ids` de-duplicated, in first-seen order.

    Order-preserving rather than a `set`, so two runs over one response emit their records in
    one order — the snapshot sorts, but a fold whose output order depended on hash iteration
    would make a fixture's recorded order meaningless. A duplicate id would otherwise record
    every one of that resource's absences twice.
    """
    seen: set[str] = set()
    ordered: list[str] = []
    for resource_id in resource_ids:
        if isinstance(resource_id, str) and resource_id and resource_id not in seen:
            seen.add(resource_id)
            ordered.append(resource_id)
    return ordered
