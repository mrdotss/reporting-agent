"""The Resource Graph inventory collector: `skip_token` paging, quota waits, power state.

`InventoryCollector.discover` owns everything Req 20 asks of "THE Inventory_Collector":
it drives one `InventoryPort` through as many pages as Azure hands back, obeys the quota
headers exactly rather than guessing at a backoff, and turns Azure's `powerState.code`
into gaps rather than omissions. The port itself (`azure/ports.py`) issues one page and
does no interpretation of headers or bodies — that interpretation is this module's job,
which is why every behaviour below is testable against `FakeInventoryPort` with no
subscription, no token and no socket.

**Paging stops on the header the response carries, not on a count this module
invents** (Req 20.2). A response with no `skipToken` is the last page; every other
response is followed by another request using that token.

**The quota headers are obeyed literally** (Req 20.3, 20.4, 20.14):

* `x-ms-user-quota-remaining >= 1` issues the next request immediately, with no wait
  at all — not even a token-bucket-style delay this module might otherwise be tempted
  to add "to be polite."
* `== 0` waits for **exactly** the duration `x-ms-user-quota-resets-after` names,
  parsed as a .NET `TimeSpan` string (`d.hh:mm:ss[.fffffff]`), and applies **no
  locally chosen backoff in its place** — the header is authoritative or nothing is.
* `== 0` with that header absent or unparseable falls back to a fixed 5-second wait,
  applied at most 3 times in a row. A 4th consecutive occurrence does not wait a 4th
  time — it raises `ThrottledError`, the retryable terminal code, because repeating a
  guess forever is indistinguishable from a hang.

  "Consecutive" is tracked across pages that hit this specific fallback case only: any
  page that either carries `remaining >= 1` or resolves its wait from a parseable
  `resets-after` header resets the counter, because it proves the quota signal is
  answering normally again.

**Power state produces gaps, never omissions** (Req 20.5, 20.9, 20.10, 20.13). Three
outcomes, and they are not the same fact:

* A projected code of exactly `PowerState/deallocated` or `PowerState/stopped` records
  a `deallocated` gap carrying the *exact* code as its message, and the resource stays
  in the inventory — present, labelled, never dropped — so a stopped VM is reported as
  stopped rather than folding into "0% CPU" as though it were measured idle.
* An absent or empty code on a `Microsoft.Compute/virtualMachines` resource records
  `power_state_unknown`. This check is VM-scoped deliberately: a Storage Account has no
  power state at all, so an empty `powerState` on one is normal and not a gap — Req
  20.13 names the resource type explicitly for exactly this reason.
* Every other code — `running`, and every in-between transition Azure reports —
  produces no gap; it is an ordinary measured state.

Resource-type matching for that VM check is **case-insensitive**, matching the KQL
`type in~ (...)` operator design.md's projection query uses: Resource Graph lowercases
`type` in its response body (`microsoft.compute/virtualmachines`), so an exact-case
comparison against the catalog's `Microsoft.Compute/virtualMachines` spelling would
silently never match and would misclassify every VM in every inventory.

`power_state` — the field carried on every resource alongside the raw code (Req 20.9,
35.3) — is a normalized value drawn from a small declared set that mirrors Azure's own
VM power-state vocabulary (`starting`, `running`, `stopping`, `stopped`, `deallocating`,
`deallocated`) plus `unknown` for anything absent, empty, or outside that set. This is a
second, independent classification from the `deallocated`-gap check above: the gap check
matches the *raw* code against exactly two literal strings (Req 20.5's own wording), while
normalization is what the snapshot's `power_state` field always carries, gap or no gap.

**A resource id repeated across a page boundary keeps exactly one entry** (Req 20.12).
The first occurrence is retained and every later one records a `duplicate_inventory_row`
gap naming the resource id — a page boundary must change neither the resource count nor
the snapshot content, and keeping the first-seen row (rather than the last) makes that
deterministic regardless of which page a duplicate happens to land on.

**Every resource carries `fidelity_tier`** (Req 20.9), stamped from the value the caller
supplies — this module has no opinion on how that tier was derived; that is the
preflight's and the pipeline's job (Req 31.1's ceiling). Inventory just records it
uniformly across every resource it discovers.

The final inventory is returned sorted by resource id ascending in Unicode code-point
order via `providers.base.sort_inventory` (Req 18.9) — defensive rather than merely
assumed, even though a query built with `order by id asc` (design.md) and first-seen
de-duplication should already preserve that order.
"""

from __future__ import annotations

import asyncio
import logging
import re
from collections.abc import Awaitable, Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final

from reporting_agent.redaction import scrub

from reporting_agent.azure.ports import InventoryPort, RawHttpResponse
from reporting_agent.collect.archive import ArchiveWriter
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_DUPLICATE_INVENTORY_ROW,
    GAP_TYPE_POWER_STATE_UNKNOWN,
    record_gap,
)
from reporting_agent.collect.snapshot import rfc3339_utc
from reporting_agent.errors import AuthFailedError, ThrottledError
from reporting_agent.providers.base import (
    DEALLOCATED_POWER_STATE_CODES,
    VIRTUAL_MACHINE_RESOURCE_TYPE,
    DiscoverResult,
    GapRecord,
    InventoryPage,
    ResourceRecord,
    sort_inventory,
)

__all__ = [
    "COUNT_COLUMN",
    "DEALLOCATED_POWER_STATE_CODES",
    "DECLARED_POWER_STATES",
    "DIMENSION_REGIONS",
    "DISTINCT_VALUE_LIMIT",
    "FALLBACK_WAIT_S",
    "INVENTORY_DIMENSIONS",
    "LOCATION_COLUMN",
    "MAX_CONSECUTIVE_FALLBACK_WAITS",
    "POWER_STATE_UNKNOWN",
    "RESOURCE_GRAPH_REQUEST_TARGET",
    "RESOURCE_GRAPH_SOURCE",
    "TYPE_COLUMN",
    "VIRTUAL_MACHINE_RESOURCE_TYPE",
    "DimensionValues",
    "InventoryArchiveContext",
    "InventoryCollector",
    "InventoryDimensions",
    "ResourceCounts",
    "ResourceGraphQueryError",
    "normalize_power_state",
    "parse_quota_remaining",
    "parse_reset_after",
    "read_counts",
    "read_dimension",
    "service_error_text",
]

logger = logging.getLogger(__name__)

_ERROR_BODY_LOG_LIMIT: Final[int] = 600
"""How much of a failed query's response body reaches the log.

Enough for Resource Graph's own syntax message and the position it names, and short
enough that a log line is not an echo of the query that produced it."""

Sleep = Callable[[float], Awaitable[None]]

_THROTTLED_STATUS: Final[int] = 429
_AUTH_STATUSES: Final[frozenset[int]] = frozenset({401, 403})


class ResourceGraphQueryError(RuntimeError):
    """A Resource Graph query answered with a status that names no actionable cause.

    Deliberately **not** an `AgentError`: `main.run_invocation` reports an unhandled
    exception as the runtime-defect code, and that is the honest label here. A `400` means
    the KQL this package wrote is wrong and a `5xx` means Azure is unwell; presenting either
    as `AUTH_FAILED` would send a consultant to rotate a secret that is fine, which is the
    "specific enough to be believed and pointing at the wrong thing" failure
    `main._row_error_code` records at length.
    """

    def __init__(self, status: int) -> None:
        super().__init__(
            f"the Azure Resource Graph query answered HTTP {status}, which names no "
            f"cause a consultant can act on; the subscription's inventory was not listed "
            f"and no dimension is reported"
        )
        self.status = status


def _code_and_message(entry: Mapping[str, Any]) -> str:
    """`code: message` for one ARM error or one of its details. **Pure.**

    Resource Graph puts the offending identifier in `token` on a parser failure, and that
    one word is what turns "the query is invalid" into a line to change.
    """
    code = str(entry.get("code") or "").strip()
    message = str(entry.get("message") or "").strip()
    token = str(entry.get("token") or "").strip()
    text = f"{code}: {message}" if code and message else (code or message)
    if token:
        text = f"{text} (token {token!r})" if text else f"token {token!r}"
    return text


def service_error_text(body: object) -> str:
    """Azure's own account of an unsuccessful response, as one bounded line for the log.

    **Pure**, and deliberately separate from the exception. :class:`ResourceGraphQueryError`
    names no cause because a consultant can act on neither a 400 nor a 503; the person who
    *can* act on a 400 is whoever wrote the KQL, and what they need is the service's own
    sentence — `ParserFailure ... 'location'` is the entire diagnosis.

    Discarding it has now cost twice. A `| project` clause carrying `powerState = "", ,
    fact_subnet = ...` was found by reading source, and so was a `summarize` naming
    `location` after the `project` had already dropped it — which reported every
    subscription as empty until someone read the query.

    **The body is parsed JSON, not bytes.** `clients._body_of` parses it (keeping numbers
    exact), so an ARM error arrives as a `Mapping`. The first version of this logging called
    `.decode` on it, which means the one line written to explain a failed child query raised
    `AttributeError` and took the run down instead — a diagnostic that fired only when it was
    needed and destroyed the thing it was reporting on. Every shape a port can hand back is
    handled here and none of them raise.

    Scrubbed and bounded, like every other logged provider string: redaction is not skipped
    because a body "cannot" hold a secret, and a long body is cut rather than echoing the
    whole query into the log.
    """
    if body is None:
        return ""
    if isinstance(body, (bytes, bytearray)):
        text = bytes(body).decode("utf-8", errors="replace")
    elif isinstance(body, str):
        text = body
    elif isinstance(body, Mapping):
        error = body.get("error")
        if isinstance(error, Mapping):
            parts = [_code_and_message(error)]
            details = error.get("details")
            if isinstance(details, Sequence) and not isinstance(details, (str, bytes)):
                parts.extend(
                    _code_and_message(detail)
                    for detail in details
                    if isinstance(detail, Mapping)
                )
            text = "; ".join(part for part in parts if part)
        else:
            text = str(dict(body))
    else:
        text = str(body)
    return (scrub(text) or "")[:_ERROR_BODY_LOG_LIMIT]


def _dimension_failure(status: int) -> Exception:
    """The exception one unsuccessful dimensions response raises. **Pure.**

    Separated from the call site so the mapping from status to code is a value a test can
    assert per status rather than three branches reachable only through a fake port.
    """
    if status == _THROTTLED_STATUS:
        return ThrottledError(
            f"the Azure Resource Graph query for the subscription's distinct inventory "
            f"dimensions answered HTTP {status}; the request was throttled and no "
            f"dimension is reported."
        )
    if status in _AUTH_STATUSES:
        return AuthFailedError(
            f"the Azure Resource Graph query for the subscription's distinct inventory "
            f"dimensions answered HTTP {status}. Reader at the subscription's own scope is "
            f"what lists its inventory, so either the client secret or the role assignment "
            f"is the thing to check."
        )
    return ResourceGraphQueryError(status)

# --- the projection Req 20.1, 20.11 requires, as the field names the query returns --

_FIELD_ID: Final[str] = "id"
_FIELD_NAME: Final[str] = "name"
_FIELD_TYPE: Final[str] = "type"
_FIELD_LOCATION: Final[str] = "location"
_FIELD_RESOURCE_GROUP: Final[str] = "resourceGroup"
_FIELD_TAGS: Final[str] = "tags"
_FIELD_SKU: Final[str] = "sku"
_FIELD_POWER_STATE: Final[str] = "powerState"
_FIELD_DATA: Final[str] = "data"
_FIELD_SKIP_TOKEN: Final[str] = "skipToken"

_QUOTA_REMAINING_HEADER: Final[str] = "x-ms-user-quota-remaining"
_QUOTA_RESETS_AFTER_HEADER: Final[str] = "x-ms-user-quota-resets-after"

# --- power state: the raw-code gap check, and the normalized field ------------------
#
# `VIRTUAL_MACHINE_RESOURCE_TYPE` and `DEALLOCATED_POWER_STATE_CODES` moved to
# `providers/base.py`, beside `is_excluded_from_averages` — the predicate that reads
# them and that `verify/replay.py` must run rather than re-implement. They are
# re-exported through this module's imports so existing readers of
# `azure.inventory.DEALLOCATED_POWER_STATE_CODES` keep resolving.

POWER_STATE_UNKNOWN: Final[str] = "unknown"
"""The normalized value for an absent, empty, or unrecognized power-state code
(Req 35.3's "a declared set that includes an unknown value")."""

DECLARED_POWER_STATES: Final[frozenset[str]] = frozenset(
    {
        "starting",
        "running",
        "stopping",
        "stopped",
        "deallocating",
        "deallocated",
        POWER_STATE_UNKNOWN,
    }
)
"""The normalized `power_state` vocabulary: Azure's own VM power-state transitions plus
`unknown`. A code this module has never seen normalizes to `unknown` rather than to a
value invented on the spot — an unrecognized code is exactly as informative as an
absent one."""

_POWER_STATE_PREFIX_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^PowerState/", re.IGNORECASE
)


def normalize_power_state(raw_power_state: object) -> str:
    """The normalized `power_state` for one raw `powerState.code` value. **Pure.**

    Strips the `PowerState/` prefix (case-insensitively — Azure's own casing is
    consistent, but this function does not trust that), lowercases the remainder, and
    falls back to `"unknown"` for anything absent, blank, non-string, or outside
    :data:`DECLARED_POWER_STATES`. Never raises: a malformed value is exactly the case
    this function exists to make safe.
    """
    if not isinstance(raw_power_state, str):
        return POWER_STATE_UNKNOWN

    stripped = _POWER_STATE_PREFIX_PATTERN.sub("", raw_power_state.strip())
    candidate = stripped.casefold()

    if candidate in DECLARED_POWER_STATES:
        return candidate
    return POWER_STATE_UNKNOWN


def _is_virtual_machine(resource_type: object) -> bool:
    """Case-insensitive match against :data:`VIRTUAL_MACHINE_RESOURCE_TYPE`.

    Resource Graph lowercases `type` in its response body (Req 20.13's whole reason
    for naming a check that must still fire against `microsoft.compute/virtualmachines`
    rather than only against the catalog's mixed-case spelling).
    """
    return isinstance(resource_type, str) and resource_type.casefold() == (
        VIRTUAL_MACHINE_RESOURCE_TYPE.casefold()
    )


# --- the quota headers (Req 20.3, 20.4, 20.14) --------------------------------------

FALLBACK_WAIT_S: Final[float] = 5.0
"""The fixed wait Req 20.14 names for an absent or unparseable
`x-ms-user-quota-resets-after`, applied while `x-ms-user-quota-remaining` is `0`."""

MAX_CONSECUTIVE_FALLBACK_WAITS: Final[int] = 3
"""At most this many consecutive fallback waits before a required further one raises
`ThrottledError` instead (Req 20.14)."""

_DURATION_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"^(?:(?P<days>\d+)\.)?"
    r"(?P<hours>\d{1,2}):(?P<minutes>\d{2}):(?P<seconds>\d{2})"
    r"(?:\.(?P<fraction>\d+))?$"
)
"""A .NET `TimeSpan` string: `[d.]hh:mm:ss[.fffffff]`. `x-ms-user-quota-resets-after`
is exactly this shape when Azure sends it — `"00:00:05"` in every recorded fixture."""


def parse_quota_remaining(value: object) -> int | None:
    """`x-ms-user-quota-remaining` as an `int`, or `None` if absent or unparseable.

    **Pure.** `None` is deliberately the same outcome for "the header was not sent" and
    "the header carries something that is not an integer" — neither Req 20.3 nor
    Req 20.4 applies without a usable value, so both fall through to "issue the next
    request with no interposed wait," which is the safe default in the absence of a
    quota signal rather than an invented backoff.
    """
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        return int(value.strip())
    except ValueError:
        return None


def parse_reset_after(value: object) -> float | None:
    """`x-ms-user-quota-resets-after` as a duration in seconds, or `None` if absent or
    unparseable. **Pure.**

    Accepts the .NET `TimeSpan` shape Azure sends: an optional `d.` days prefix, then
    `hh:mm:ss`, then an optional fractional-seconds suffix. Anything else — an absent
    header, or a value like the fixture's literal `"unknown"` — returns `None`, which
    is what routes the caller to the 5-second fallback (Req 20.14) rather than
    silently treating a malformed header as "no wait needed."
    """
    if not isinstance(value, str) or not value.strip():
        return None

    match = _DURATION_PATTERN.match(value.strip())
    if match is None:
        return None

    days = int(match.group("days") or 0)
    hours = int(match.group("hours"))
    minutes = int(match.group("minutes"))
    seconds = int(match.group("seconds"))
    fraction = match.group("fraction")

    total = float(days * 86400 + hours * 3600 + minutes * 60 + seconds)
    if fraction:
        total += float(f"0.{fraction}")
    return total


# --- row extraction, defensive against a malformed or unsuccessful response ---------


def _rows_from_body(body: object) -> list[Mapping[str, Any]]:
    """The `data` rows of a Resource Graph page. **Pure.**

    A response that did not succeed, or whose body is not the expected shape, yields
    no rows rather than raising — the same defensive convention `azure/skus.py`'s
    `_parse_listing` uses for a malformed listing.
    """
    if not isinstance(body, Mapping):
        return []
    data = body.get(_FIELD_DATA)
    if not isinstance(data, list):
        return []
    return [row for row in data if isinstance(row, Mapping)]


def _skip_token_from_body(body: object) -> str | None:
    """The page's `skipToken`, or `None` when the page is the last one.

    A missing key, a JSON `null`, and an empty string are one fact — "there is no
    further page" — so all three normalize to `None` here rather than three separate
    checks at the call site.
    """
    if not isinstance(body, Mapping):
        return None
    token = body.get(_FIELD_SKIP_TOKEN)
    if isinstance(token, str) and token.strip():
        return token
    return None


def _tags_from_row(raw: object) -> dict[str, str]:
    if not isinstance(raw, Mapping):
        return {}
    return {
        key: value
        for key, value in raw.items()
        if isinstance(key, str) and isinstance(value, str)
    }


def _string_field(row: Mapping[str, Any], field: str) -> str:
    value = row.get(field)
    return value if isinstance(value, str) else ""


# --- the four picker dimensions (Req 9.1, 9.5) --------------------------------------

DIMENSION_RESOURCE_TYPES: Final[str] = "resource_types"
DIMENSION_RESOURCE_GROUPS: Final[str] = "resource_groups"
DIMENSION_TAG_KEYS: Final[str] = "tag_keys"
DIMENSION_TAG_VALUES: Final[str] = "tag_values"
DIMENSION_REGIONS: Final[str] = "regions"

INVENTORY_DIMENSIONS: Final[tuple[str, ...]] = (
    DIMENSION_RESOURCE_TYPES,
    DIMENSION_RESOURCE_GROUPS,
    DIMENSION_TAG_KEYS,
    DIMENSION_TAG_VALUES,
    DIMENSION_REGIONS,
)
"""The four dimensions Req 9.1 names — and the **three** names that would otherwise drift.

One declaration serves as the column `azure/clients.distinct_dimensions_query` emits, the
field :func:`read_dimension` looks for in the answer, and the key `list_inventory` puts on
`done`. Three spellings that agree today is how a picker ends up silently empty for one
dimension: the query renames a column, the reader finds nothing there, and "no resource
groups in this subscription" is a perfectly plausible-looking answer.
"""

TYPE_COLUMN: Final[str] = "type"
COUNT_COLUMN: Final[str] = "resource_count"
LOCATION_COLUMN: Final[str] = "location"
"""The three columns `azure/clients.resource_counts_query` emits and :func:`read_counts`
reads back. Declared here for the reason :data:`INVENTORY_DIMENSIONS` is: a query that
renames a column and a reader that keeps looking for the old name produce a count of zero,
and "this subscription holds no virtual machines" is a plausible-looking answer."""

DISTINCT_VALUE_LIMIT: Final[int] = 2000
"""Req 9.1's per-dimension bound: at most this many distinct values are returned.

The query asks the service for one more than this (see `_MAKE_SET_LIMIT` there), because
receiving `DISTINCT_VALUE_LIMIT + 1` is the only available evidence that the true set is
larger — Resource Graph reports no total beside an aggregate. :func:`read_dimension` cuts
back to this bound and sets `truncated`."""


@dataclass(frozen=True, slots=True)
class DimensionValues:
    """One dimension's distinct values, and whether the bound cut them (Req 9.1).

    `truncated` travels **with** the values rather than as a separate flag per response,
    because it is a fact about this dimension alone: a subscription can carry three resource
    types and forty thousand tag values, and a single response-level flag would either
    understate the complete dimensions or overstate the cut one. The picker reads it per
    dimension to decide whether to keep offering free entry (Req 9.6).
    """

    values: tuple[str, ...]
    truncated: bool

    def __post_init__(self) -> None:
        if len(self.values) > DISTINCT_VALUE_LIMIT:
            raise ValueError(
                f"a dimension carries {len(self.values)} values, past Req 9.1's bound of "
                f"{DISTINCT_VALUE_LIMIT}; the reader cuts to the bound and sets "
                f"`truncated` rather than returning more than it promised"
            )
        if len(set(self.values)) != len(self.values):
            raise ValueError(
                "a dimension carries a repeated value; these are the *distinct* values "
                "of one dimension, so a duplicate means the read folded two columns"
            )
        if list(self.values) != sorted(self.values):
            raise ValueError(
                "a dimension's values are not ascending in Unicode code-point order "
                "(Req 9.1); the order is the picker's presentation order"
            )

    def to_plain_data(self) -> dict[str, Any]:
        return {"values": list(self.values), "truncated": self.truncated}


@dataclass(frozen=True, slots=True)
class InventoryDimensions:
    """The four dimensions one `distinct_dimensions` call resolved (Req 9.1).

    Carries **no** subscription id, no tenant id, no client id and no resource id — not as a
    filter applied on the way out, but because the query projected none of them and there is
    no field here to hold one (Req 9.5).
    """

    resource_types: DimensionValues
    resource_groups: DimensionValues
    tag_keys: DimensionValues
    tag_values: DimensionValues
    regions: DimensionValues = DimensionValues(values=(), truncated=False)
    """The distinct regions the subscription's resources sit in.

    Defaulted so every existing construction site — the tests that build four dimensions,
    and any caller predating the scan — keeps working unchanged. It rides the same
    aggregate query as the other four: `make_set_if(location, ...)` adds no `by` clause and
    projects no `id`, so the query's one-row shape and Req 9.5's structural exclusion of
    resource identifiers both survive it."""

    def to_plain_data(self) -> dict[str, Any]:
        """The four dimensions as the mapping `list_inventory` merges onto `done`.

        Keyed by :data:`INVENTORY_DIMENSIONS` rather than by four literals, so a dimension
        added to that tuple without a field here fails loudly instead of being absent from
        the payload.
        """
        return {name: getattr(self, name).to_plain_data() for name in INVENTORY_DIMENSIONS}


def read_dimension(row: Mapping[str, Any], name: str) -> DimensionValues:
    """One dimension out of the aggregate row. **Pure.**

    Three things happen here and each is a requirement rather than tidying:

    * **Non-strings are dropped.** `make_set_if` over a `tostring(...)` projection yields
      strings, but a `null` in a tag bag can still reach the array, and a `None` in a
      picker's option list is an option a consultant can select and a run cannot collect.
    * **Sorted ascending in Unicode code-point order** (Req 9.1). Python's `sorted` on `str`
      compares code points, which is exactly the order named; the service returns an
      aggregate set in no specified order, so this is where the order comes from.
    * **Cut to :data:`DISTINCT_VALUE_LIMIT`, with `truncated` set from the count the service
      returned.** The cut happens **after** the sort, so a truncated dimension is the
      lexicographically first 2000 of what came back rather than an arbitrary 2000 of it.

    An absent or non-array column reads as an empty, untruncated dimension. That is the one
    place this function is deliberately lenient, and the leniency is bounded: `list_inventory`
    reports nothing at all when the query itself did not answer, so an empty dimension here
    means the query answered and this dimension is genuinely empty.
    """
    raw = row.get(name)
    if not isinstance(raw, Sequence) or isinstance(raw, (str, bytes)):
        return DimensionValues(values=(), truncated=False)

    unique = {value for value in raw if isinstance(value, str) and value}
    truncated = len(unique) > DISTINCT_VALUE_LIMIT
    return DimensionValues(
        values=tuple(sorted(unique)[:DISTINCT_VALUE_LIMIT]), truncated=truncated
    )


@dataclass(frozen=True, slots=True)
class ResourceCounts:
    """The scan's counts, **partitioned** between deployed resources and sub-records.

    `resource_count` and `type_counts` cover the types a reader means by "how much is
    deployed here"; `child_type_counts` covers the child types — a subnet, a security rule —
    which are addressable resources but not deployed things (see
    `catalog.loader.is_child_type`).

    `region_counts` is the per-region headline count — only non-child types, for the same
    reason `type_counts` excludes them: a region's count must not inflate when Phase 5's
    collectors start emitting sub-records. The scan screen uses it to state, for a region
    whose data plane refused, the count of scanned resources *in that region* (Req 5.4).

    The partition is the whole point, and the reason is a timing one. Phase 5 adds the
    collectors that emit sub-records, so under one uniform count an untouched subscription
    would report 47 resources one month and 71 the next with nothing deployed, and a customer
    comparing two consecutive reports would read that as infrastructure growth. Correct
    arithmetic, misleading number — which is the failure this product exists to prevent.

    A section that genuinely wants a sub-record count — a virtual-network section stating
    that a VNet has four subnets — reads `child_type_counts`. No surface adds the two
    together.
    """

    resource_count: int
    type_counts: Mapping[str, int]
    child_type_counts: Mapping[str, int]
    region_counts: Mapping[str, int]

    def to_plain_data(self) -> dict[str, Any]:
        return {
            COUNT_COLUMN: self.resource_count,
            "type_counts": dict(self.type_counts),
            "child_type_counts": dict(self.child_type_counts),
            "region_counts": dict(self.region_counts),
        }


def read_counts(
    rows: Sequence[Mapping[str, Any]], *, child_types: Sequence[str]
) -> ResourceCounts:
    """Partition the count query's rows into headline and child counts. **Pure.**

    Rows are now `(type, location, count)` triples — the same resource type can appear in
    several rows when it has resources in multiple regions. The per-type accumulation sums
    across locations, and the per-region map is built from the same answer, counting only
    non-child types (for the same reason `type_counts` excludes children: a region's count
    must not inflate when Phase 5's collectors start emitting sub-records).

    `child_types` comes from `catalog.loader.child_type_names(catalog)`, so the partition is
    derived from the two catalogs and there is no type list embedded in query text that
    someone would have to keep in step with them by hand.

    Matched case-insensitively, because Resource Graph lower-cases `type` in its response
    body while the catalogs declare Azure's own casing. An exact comparison would classify
    every real row as a non-child type and the partition would silently do nothing — which is
    the same failure as not partitioning at all, arrived at through a spelling mismatch.

    A row whose count is absent, negative or not an integer is **skipped, not zero-filled**:
    a type present in the answer with an unreadable count is not a type with no resources.
    `bool` is excluded explicitly — `isinstance(True, int)` is `True` in Python, and a `True`
    that reached a count column would otherwise be read as the number 1.
    """
    folded_children = {name.casefold() for name in child_types if isinstance(name, str)}

    type_counts: dict[str, int] = {}
    child_type_counts: dict[str, int] = {}
    region_counts: dict[str, int] = {}
    for row in rows:
        resource_type = row.get(TYPE_COLUMN)
        count = row.get(COUNT_COLUMN)
        location = row.get(LOCATION_COLUMN)
        if not isinstance(resource_type, str) or not resource_type.strip():
            continue
        if isinstance(count, bool) or not isinstance(count, int) or count < 0:
            continue
        is_child = resource_type.casefold() in folded_children
        target = child_type_counts if is_child else type_counts
        target[resource_type] = target.get(resource_type, 0) + count

        # Per-region counts: non-child types only, for the same invariance reason.
        if not is_child and isinstance(location, str) and location.strip():
            region_counts[location] = region_counts.get(location, 0) + count

    return ResourceCounts(
        resource_count=sum(type_counts.values()),
        type_counts=type_counts,
        child_type_counts=child_type_counts,
        region_counts=region_counts,
    )


RESOURCE_GRAPH_SOURCE: Final[str] = "resource_graph"
"""The fact-declaration `source` name for a projected fact (Req 4.7).

The same string the fact declaration uses, so a gap naming its source and an archived page
naming its source name the same thing. Declared here because this is the module that
queries it."""

RESOURCE_GRAPH_REQUEST_TARGET: Final[str] = (
    "/providers/Microsoft.ResourceGraph/resources"
)
"""What was asked, recorded on every archived page.

The ARM path rather than a full URL: a URL carries the subscription id, and an archived
object is read by a replay that already knows the subscription. Keeping the identifier
subscription-free is the same discipline the metric-definition fixtures keep."""


@dataclass(frozen=True, slots=True)
class InventoryArchiveContext:
    """What :meth:`InventoryCollector.discover` needs in order to archive a page.

    One object rather than five more keyword arguments on `discover`, because the five are
    meaningless apart: there is no sensible call that supplies an actor id and no writer, or
    a writer and no catalog version. Grouping them makes "archive the pages" a single
    decision at the call site instead of five that could disagree.

    `catalog_version` is on the page because the projection that produced its facts came
    from that catalog. A replay re-deriving a fact has to know which declaration was in
    force, and the snapshot's own `catalog_version` answers that for the run — but an
    object that travels alone through an S3 lifecycle policy should not need the snapshot
    to be interpretable.
    """

    writer: ArchiveWriter
    actor_id: str
    run_id: str
    catalog_version: str
    source: str = RESOURCE_GRAPH_SOURCE
    request_target: str = RESOURCE_GRAPH_REQUEST_TARGET


class InventoryCollector:
    """Pages an `InventoryPort` to completion, resolving one run's inventory.

    One instance per run, constructed over that run's `InventoryPort`. `sleep` is
    injected — defaulting to `asyncio.sleep` — so a test drives every quota wait
    instantly rather than in real time, the same seam `heartbeat.py` and
    `progress.py` use for their own clocks.
    """

    def __init__(
        self,
        port: InventoryPort,
        *,
        sleep: Sleep = asyncio.sleep,
        now: Callable[[], datetime] = lambda: datetime.now(UTC),
    ) -> None:
        self._port = port
        self._sleep = sleep
        self._now = now

    async def discover(
        self,
        *,
        subscription_id: str,
        resource_types: Sequence[str],
        fidelity_tier: str,
        fact_projections: Sequence[tuple[str, str]] = (),
        archive: InventoryArchiveContext | None = None,
    ) -> DiscoverResult:
        """Page the run's whole inventory (Req 20.1, 20.2, 20.11).

        Scopes every request to `subscription_id` and to `resource_types`, following
        `skip_token` until a page carries none, obeying the quota headers exactly
        (Req 20.3, 20.4, 20.14), and recording every power-state and duplicate-row gap
        along the way (Req 20.5, 20.9, 20.10, 20.12, 20.13).

        `fact_projections` is handed to the port, which appends one projected column per
        pair to the query (Req 4.7). `archive`, when supplied, receives **each page as it
        arrives** (Req 7.1): a projected fact makes this response a fact-producing
        response, and a fact-producing response absent from the archive is a fact a replay
        cannot re-derive — which reports `REPLAY_MISMATCH` on a run that collected
        correctly. Both default to absent, so a caller with no fact declaration and no
        archive behaves exactly as before.

        **A page is archived only when this query projected a fact.** Criterion 7.1's
        obligation is over fact-*producing* responses, and with no projection this response
        produces none: every other field it carries — the id, the type, the SKU, the power
        state — is recorded on the snapshot itself, and Req 31.4 explicitly permits a replay
        to read a resource's identity and capacity from there. Archiving it anyway would add
        an object per page to the run's `raw_archive.object_count` that a replay folds
        nothing from, which is a cost with no reader: more objects, a larger archive, and a
        count whose growth no longer tracks the responses a replay actually needs. So the
        condition is the presence of a projection, not the presence of a writer.


        The page is archived **before** it is folded, matching the collector's own
        write-then-fold order (Req 26.3, 26.4): the object lands first, so a fold that
        raises cannot leave a folded page with no archived counterpart. A failed write
        records gaps and the page is folded regardless — an inventory that cannot be
        archived is still an inventory that was collected.

        Raises `ThrottledError` if a 4th consecutive quota-fallback wait would be
        required (Req 20.14). Raises `ValueError` for a blank `subscription_id`, since
        there is no scope to query without one.
        """
        if not isinstance(subscription_id, str) or not subscription_id.strip():
            raise ValueError("subscription_id must be a non-empty string")

        resources: dict[str, ResourceRecord] = {}
        gaps: list[GapRecord] = []
        pages: list[InventoryPage] = []
        skip_token: str | None = None
        consecutive_fallback_waits = 0
        page_index = 0
        # Resolved once, before the loop, so every page of one `skip_token` sequence is
        # treated the same way — a run that archived its first page and not its fourth
        # would report an archive a replay cannot use and no reason why.
        archive_pages = archive is not None and bool(fact_projections)

        while True:
            response = await self._port.query_resources(
                subscription_id=subscription_id,
                resource_types=resource_types,
                skip_token=skip_token,
                fact_projections=fact_projections,
            )

            if not response.ok:
                logger.warning(
                    "Resource Graph query for subscription %r returned status %d; "
                    "treating this page as carrying no rows and no further page. "
                    "The service said: %s",
                    subscription_id,
                    response.status,
                    service_error_text(response.body),
                )
                break

            next_token = _skip_token_from_body(response.body)

            # The page's receipt instant, read **once, here** — where the page actually
            # arrived (Req 4.3, 4.13). It is what the archive records and what the fact
            # fold stamps onto every `collected_at` derived from this page, so the two
            # cannot disagree. Reading it again at fold time is the defect this replaces:
            # a fold that crossed a second boundary stamped facts one second after the
            # archived page said they were received, and the replay re-derives from the
            # archived value, so a reproducible snapshot reported REPLAY_MISMATCH.
            received_at = rfc3339_utc(self._now())

            if archive_pages:
                assert archive is not None  # narrowed by `archive_pages`
                gaps.extend(
                    await self._archive_page(
                        archive,
                        subscription_id=subscription_id,
                        body=response.body,
                        page_index=page_index,
                        skip_token_present=next_token is not None,
                        received_at=received_at,
                    )
                )

            self._fold_page(response.body, resources, gaps, fidelity_tier=fidelity_tier)
            # Retained only where a fact was projected into the query, so a run with no fact
            # declaration holds no page at all and the memory cost is exactly the cost of the
            # feature that needs it (Req 4.7). `azure/facts.py` folds these.
            if fact_projections:
                pages.append(
                    InventoryPage(body=response.body, received_at=received_at)
                )

            skip_token = next_token
            page_index += 1
            if skip_token is None:
                break

            consecutive_fallback_waits = await self._wait_for_quota(
                response, consecutive_fallback_waits
            )

        return DiscoverResult(
            resources=sort_inventory(resources.values()),
            gaps=gaps,
            inventory_pages=pages,
        )

    async def distinct_dimensions(self, *, subscription_id: str) -> InventoryDimensions:
        """The four picker dimensions, from **one** Resource Graph query (Req 9.1, 9.5).

        One call to the port and no loop: the query aggregates with no `by` clause, so the
        answer is a single row and there is no continuation token to follow. Req 9.2's "one
        query per cache miss" is therefore a property of this method's shape.

        Nothing is archived and no gap is recorded. This is not a collection: it feeds three
        pickers in the template wizard, produces no snapshot, no figure and no run row, and
        an object written under a run prefix for it would be an archive entry no replay folds
        anything from.

        **A response that did not succeed raises rather than returning four empty
        dimensions.** Four empty dimensions is a claim about the subscription — Req 9.9's
        "an empty option list a consultant would read as an empty subscription" — and the one
        thing a failed query does not license is a claim about what is in there. The three
        cases are told apart because they call for different actions:

        * `429` raises :class:`ThrottledError`, the retryable code, so the wizard can say
          "try again" rather than "we could not read this subscription".
        * `401` and `403` raise :class:`AuthFailedError`, which is the code that means the
          credentials or the role assignment are wrong — the thing a consultant can fix.
        * every other non-2xx raises :class:`ResourceGraphQueryError`, which the router
          reports as the runtime-defect code. A `400` from Resource Graph is a defect in the
          KQL **this module wrote**, and a `500` is Azure's; neither is an expired secret, and
          `main._row_error_code`'s own recorded lesson is that presenting a specific wrong
          code is worse than presenting the general right one. A consultant sent to rotate a
          working secret by a transient 503 is exactly that failure.
        """
        if not isinstance(subscription_id, str) or not subscription_id.strip():
            raise ValueError("subscription_id must be a non-empty string")

        response = await self._port.query_distinct_dimensions(
            subscription_id=subscription_id
        )
        if not response.ok:
            logger.warning(
                "the distinct-dimensions query for subscription %r returned status %d; "
                "no dimension is reported. The service said: %s",
                subscription_id,
                response.status,
                service_error_text(response.body),
            )
            raise _dimension_failure(response.status)

        rows = _rows_from_body(response.body)
        # An aggregate over an empty `Resources` table returns **no row at all**, not a row
        # of empty sets — an entirely empty subscription is a real case (Req 9.9 routes it to
        # the free-entry fallback rather than treating it as an error), so an absent row reads
        # as four empty dimensions rather than as a malformed answer.
        row = rows[0] if rows else {}
        return InventoryDimensions(
            resource_types=read_dimension(row, DIMENSION_RESOURCE_TYPES),
            resource_groups=read_dimension(row, DIMENSION_RESOURCE_GROUPS),
            tag_keys=read_dimension(row, DIMENSION_TAG_KEYS),
            tag_values=read_dimension(row, DIMENSION_TAG_VALUES),
            regions=read_dimension(row, DIMENSION_REGIONS),
        )

    async def resource_counts(
        self, *, subscription_id: str, child_types: Sequence[str] = ()
    ) -> ResourceCounts:
        """The scan's per-type counts, partitioned by child type (task 1.3).

        A **separate** method from :meth:`distinct_dimensions`, not a second query inside it.
        That method's docstring states "one call to the port and no loop" and Req 9.2's "one
        query per cache miss" as properties of its *shape*; issuing a second query there
        would quietly make both false. The two also serve different callers — the wizard's
        pickers need dimensions, the scan screen needs counts — so a caller that wants one
        does not pay for the other.

        `child_types` is an argument rather than a catalog on this collector, because this
        module is the Azure boundary and the partition is a **catalog** fact: the caller —
        `main.handle_list_inventory`, which already holds a `LoadedCatalog` — passes
        `child_type_names(catalog)`. Giving this class a catalog dependency would let an
        Azure-layer object answer a question about declarations, and the default of `()`
        would then be a silently wrong partition rather than an explicit "no child types".

        Fails the same way `distinct_dimensions` does, and for the same reason: counts of
        zero are a claim about the subscription, and a failed query licenses no claim.
        """
        if not isinstance(subscription_id, str) or not subscription_id.strip():
            raise ValueError("subscription_id must be a non-empty string")

        response = await self._port.query_resource_counts(subscription_id=subscription_id)
        if not response.ok:
            logger.warning(
                "the resource-count query for subscription %r returned status %d; "
                "no count is reported. The service said: %s",
                subscription_id,
                response.status,
                service_error_text(response.body),
            )
            raise _dimension_failure(response.status)

        return read_counts(_rows_from_body(response.body), child_types=child_types)

    async def discover_child_resources(
        self,
        *,
        subscription_id: str,
        fidelity_tier: str,
        archive: InventoryArchiveContext | None = None,
    ) -> DiscoverResult:
        """Every synthetic child resource this run's scope can name (task 6.1, Req 16.4,
        16.9, 16.10).

        A **separate** method from :meth:`discover`, matching :meth:`resource_counts`'s own
        separation from :meth:`distinct_dimensions` and for the identical reason: one call
        to the port and no `skip_token` loop, as properties of this method's shape rather
        than an accident of today's response size. `mv-expand`'s own row-limit cap already
        bounds the answer (Req 16.4's own note on why no paging is attempted here), so
        adding a loop this method never needs would misstate what it promises.

        Reuses :meth:`_fold_page` completely unchanged: `query_child_resources`'s response
        is shaped as the identical eight inventory columns `query_resources` produces, so a
        child resource — a subnet, a future security rule — becomes an ordinary
        `ResourceRecord` through the exact fold every other resource goes through. No
        power-state gap is expected (a child resource carries no power state at all), and
        none is asserted here — the fold's own VM-only check already reads that correctly.

        Archived **before** the fold, matching :meth:`discover`'s own write-then-fold order
        (Req 7.1, 26.3, 26.4): unconditionally, unlike the main inventory page, because
        every child-resource response is fact-producing by construction — there is no
        "no fact was projected" case for a query whose entire purpose is to name a
        resource's facts.
        """
        if not isinstance(subscription_id, str) or not subscription_id.strip():
            raise ValueError("subscription_id must be a non-empty string")

        response = await self._port.query_child_resources(subscription_id=subscription_id)
        if not response.ok:
            # The status alone said a query failed and not why. A 400 from Resource Graph
            # is a **syntax error in the KQL this package wrote**, and its body names the
            # position — which is the whole diagnosis, and it was being discarded. One run
            # reported `status 400` for a query whose `| project` clause carried
            # `powerState = "", , fact_subnet = ...`; the body would have said so, and
            # instead every subnet and every security rule was quietly absent from the
            # report with a one-line warning that could not be acted on.
            #
            # Scrubbed and bounded by `service_error_text`, which also handles the fact
            # that the body is parsed JSON: this line used to call `.decode` on it and
            # raised `AttributeError` on the one path it exists to report.
            logger.warning(
                "the child-resource query for subscription %r returned status %d; "
                "no child resource is recorded for this run. The service said: %s",
                subscription_id,
                response.status,
                service_error_text(response.body),
            )
            return DiscoverResult(resources=[], gaps=[])

        received_at = rfc3339_utc(self._now())
        gaps: list[GapRecord] = []
        if archive is not None:
            gaps.extend(
                await self._archive_page(
                    archive,
                    subscription_id=subscription_id,
                    body=response.body,
                    page_index=0,
                    skip_token_present=False,
                    received_at=received_at,
                )
            )

        resources: dict[str, ResourceRecord] = {}
        self._fold_page(response.body, resources, gaps, fidelity_tier=fidelity_tier)

        return DiscoverResult(
            resources=sort_inventory(resources.values()),
            gaps=gaps,
            # **The page, so its facts are folded.** This query projects a `fact_` column
            # per fact the child type declares — a subnet's `address_prefix`, a rule's
            # `priority` — and `azure/facts.py::_fold_pages` is what turns those columns
            # into facts and their absences into gaps. Returning the resources without the
            # page folded the child rows and dropped every fact on them, so a security
            # rule reached the snapshot carrying nothing and section 6 said "None of these
            # facts were collected" about a resource whose facts were in the response.
            #
            # It also made the run unreproducible: `verify/replay.py` folds **every
            # archived object**, and this page was archived. Replay found the facts the
            # live run had not, recorded eight `fact_unavailable` gaps for the ones the
            # response left empty, and produced a snapshot digest that could not match —
            # `REPLAY_MISMATCH` on a run where nothing was wrong with the data.
            inventory_pages=[
                InventoryPage(body=response.body, received_at=received_at)
            ],
        )

    async def _archive_page(
        self,
        archive: InventoryArchiveContext,
        *,
        subscription_id: str,
        body: object,
        page_index: int,
        skip_token_present: bool,
        received_at: str,
    ) -> list[GapRecord]:
        """Archive one Resource Graph page, returning any gap the write produced.

        Returns `[]` — writing nothing — for a page carrying no usable resource id.
        `ArchiveWriter.write_inventory` refuses an empty `resource_ids` by design, and a
        page with no rows is the ordinary last page of a `skip_token` sequence rather than
        a failure: archiving an object that names no resource would add an object to the
        run's count that a replay could attribute to nothing.

        `received_at` is passed in rather than read here, and it is the *same* value the
        caller pairs with the retained page (see :class:`InventoryPage`). It still comes
        from this instance's injected clock — the caller reads it — so a test drives it
        rather than the wall clock deciding what lands in a committed fixture. Reading it
        here as well would recreate the two-separable-values defect one call deeper.
        """
        resource_ids = [
            row[_FIELD_ID]
            for row in _rows_from_body(body)
            if isinstance(row.get(_FIELD_ID), str) and row[_FIELD_ID].strip()
        ]
        if not resource_ids:
            return []

        result = await archive.writer.write_inventory(
            actor_id=archive.actor_id,
            run_id=archive.run_id,
            source=archive.source,
            request_target=archive.request_target,
            page_index=page_index,
            skip_token_present=skip_token_present,
            received_at=received_at,
            catalog_version=archive.catalog_version,
            resource_ids=resource_ids,
            raw_body=body,
        )
        if not result.wrote:
            logger.warning(
                "inventory page %d for subscription %r was not archived; this run's raw "
                "archive is incomplete and a projected fact cannot be replayed from it.",
                page_index,
                subscription_id,
            )
        return list(result.gaps)

    def _fold_page(
        self,
        body: object,
        resources: dict[str, ResourceRecord],
        gaps: list[GapRecord],
        *,
        fidelity_tier: str,
    ) -> None:
        """Fold one page's rows into `resources` and `gaps`, in place.

        The first occurrence of a resource id wins (Req 20.12): a later duplicate
        records a gap and contributes nothing else, so the resource count and content
        are identical whichever side of a page boundary a duplicate happened to fall
        on.
        """
        for row in _rows_from_body(body):
            resource_id = row.get(_FIELD_ID)
            if not isinstance(resource_id, str) or not resource_id.strip():
                continue  # a row with no usable id names nothing to record a gap against

            if resource_id in resources:
                gaps.append(
                    record_gap(
                        GAP_TYPE_DUPLICATE_INVENTORY_ROW,
                        resource_id,
                        None,
                        f"resource {resource_id!r} was already present in this "
                        f"inventory collection from an earlier page; this later, "
                        f"duplicate row was discarded and the first-seen entry was "
                        f"retained, so the page boundary changes neither the "
                        f"resource count nor the snapshot content.",
                    )
                )
                continue

            resource_type = _string_field(row, _FIELD_TYPE)
            raw_power_state = _string_field(row, _FIELD_POWER_STATE)
            is_vm = _is_virtual_machine(resource_type)

            if raw_power_state in DEALLOCATED_POWER_STATE_CODES:
                gaps.append(
                    record_gap(
                        GAP_TYPE_DEALLOCATED,
                        resource_id,
                        None,
                        raw_power_state,
                    )
                )
            elif is_vm and not raw_power_state.strip():
                gaps.append(
                    record_gap(
                        GAP_TYPE_POWER_STATE_UNKNOWN,
                        resource_id,
                        None,
                        f"the projected powerState.code is absent or empty for this "
                        f"{VIRTUAL_MACHINE_RESOURCE_TYPE} resource, so its power "
                        f"state cannot be distinguished from a measured value.",
                    )
                )

            resources[resource_id] = ResourceRecord(
                resource_id=resource_id,
                name=_string_field(row, _FIELD_NAME),
                resource_type=resource_type,
                location=_string_field(row, _FIELD_LOCATION),
                resource_group=_string_field(row, _FIELD_RESOURCE_GROUP),
                tags=_tags_from_row(row.get(_FIELD_TAGS)),
                sku_name=_string_field(row, _FIELD_SKU),
                power_state_raw=raw_power_state,
                power_state=normalize_power_state(raw_power_state),
                fidelity_tier=fidelity_tier,
            )

    async def _wait_for_quota(
        self, response: RawHttpResponse, consecutive_fallback_waits: int
    ) -> int:
        """Apply Req 20.3/20.4/20.14's wait, if any, before the next page is requested.

        Returns the updated consecutive-fallback-wait count. Raises `ThrottledError`
        rather than waiting a 4th consecutive time when the fallback case recurs after
        3 consecutive occurrences.
        """
        remaining = parse_quota_remaining(response.header(_QUOTA_REMAINING_HEADER))

        if remaining is None or remaining >= 1:
            # Req 20.3, and the safe default when the header is absent entirely: issue
            # the next request immediately, with no invented backoff.
            return 0

        reset_after = parse_reset_after(response.header(_QUOTA_RESETS_AFTER_HEADER))
        if reset_after is not None:
            # Req 20.4 — exactly the header's duration, no locally chosen substitute.
            await self._sleep(reset_after)
            return 0

        # Req 20.14 — the header is absent or unparseable while quota is exhausted.
        next_count = consecutive_fallback_waits + 1
        if next_count > MAX_CONSECUTIVE_FALLBACK_WAITS:
            raise ThrottledError(
                f"Azure Resource Graph reported x-ms-user-quota-remaining=0 with an "
                f"absent or unparseable x-ms-user-quota-resets-after header for the "
                f"{next_count}th consecutive page; a {FALLBACK_WAIT_S:.0f}-second "
                f"fallback wait was already applied "
                f"{MAX_CONSECUTIVE_FALLBACK_WAITS} times in a row, and a required "
                f"further wait is refused rather than repeated indefinitely."
            )

        await self._sleep(FALLBACK_WAIT_S)
        return next_count
