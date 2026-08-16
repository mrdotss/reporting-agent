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
from typing import Any, Final

from reporting_agent.azure.ports import InventoryPort, RawHttpResponse
from reporting_agent.collect.log import (
    GAP_TYPE_DEALLOCATED,
    GAP_TYPE_DUPLICATE_INVENTORY_ROW,
    GAP_TYPE_POWER_STATE_UNKNOWN,
    record_gap,
)
from reporting_agent.errors import ThrottledError
from reporting_agent.providers.base import (
    DiscoverResult,
    GapRecord,
    ResourceRecord,
    sort_inventory,
)

__all__ = [
    "DEALLOCATED_POWER_STATE_CODES",
    "DECLARED_POWER_STATES",
    "FALLBACK_WAIT_S",
    "MAX_CONSECUTIVE_FALLBACK_WAITS",
    "POWER_STATE_UNKNOWN",
    "VIRTUAL_MACHINE_RESOURCE_TYPE",
    "InventoryCollector",
    "normalize_power_state",
    "parse_quota_remaining",
    "parse_reset_after",
]

logger = logging.getLogger(__name__)

Sleep = Callable[[float], Awaitable[None]]

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

VIRTUAL_MACHINE_RESOURCE_TYPE: Final[str] = "Microsoft.Compute/virtualMachines"
"""The one resource type Req 20.13's absent-power-state check applies to. Matched
case-insensitively against a row's projected `type`, because Resource Graph lowercases
it in its response body."""

# --- power state: the raw-code gap check, and the normalized field ------------------

DEALLOCATED_POWER_STATE_CODES: Final[frozenset[str]] = frozenset(
    {"PowerState/deallocated", "PowerState/stopped"}
)
"""The exact projected codes Req 20.5 names. Matched literally against the raw code —
not normalized first — because the requirement's own wording is "equals
`PowerState/deallocated` or `PowerState/stopped`", and matching after normalization
would let a third, unanticipated spelling of "stopped" slip through unrecorded."""

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


class InventoryCollector:
    """Pages an `InventoryPort` to completion, resolving one run's inventory.

    One instance per run, constructed over that run's `InventoryPort`. `sleep` is
    injected — defaulting to `asyncio.sleep` — so a test drives every quota wait
    instantly rather than in real time, the same seam `heartbeat.py` and
    `progress.py` use for their own clocks.
    """

    def __init__(self, port: InventoryPort, *, sleep: Sleep = asyncio.sleep) -> None:
        self._port = port
        self._sleep = sleep

    async def discover(
        self,
        *,
        subscription_id: str,
        resource_types: Sequence[str],
        fidelity_tier: str,
    ) -> DiscoverResult:
        """Page the run's whole inventory (Req 20.1, 20.2, 20.11).

        Scopes every request to `subscription_id` and to `resource_types`, following
        `skip_token` until a page carries none, obeying the quota headers exactly
        (Req 20.3, 20.4, 20.14), and recording every power-state and duplicate-row gap
        along the way (Req 20.5, 20.9, 20.10, 20.12, 20.13).

        Raises `ThrottledError` if a 4th consecutive quota-fallback wait would be
        required (Req 20.14). Raises `ValueError` for a blank `subscription_id`, since
        there is no scope to query without one.
        """
        if not isinstance(subscription_id, str) or not subscription_id.strip():
            raise ValueError("subscription_id must be a non-empty string")

        resources: dict[str, ResourceRecord] = {}
        gaps: list[GapRecord] = []
        skip_token: str | None = None
        consecutive_fallback_waits = 0

        while True:
            response = await self._port.query_resources(
                subscription_id=subscription_id,
                resource_types=resource_types,
                skip_token=skip_token,
            )

            if not response.ok:
                logger.warning(
                    "Resource Graph query for subscription %r returned status %d; "
                    "treating this page as carrying no rows and no further page.",
                    subscription_id,
                    response.status,
                )
                break

            self._fold_page(response.body, resources, gaps, fidelity_tier=fidelity_tier)

            skip_token = _skip_token_from_body(response.body)
            if skip_token is None:
                break

            consecutive_fallback_waits = await self._wait_for_quota(
                response, consecutive_fallback_waits
            )

        return DiscoverResult(resources=sort_inventory(resources.values()), gaps=gaps)

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
