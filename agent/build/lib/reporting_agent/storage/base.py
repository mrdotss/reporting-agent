"""The `ObjectStore` protocol — the only surface `collect/` uses to write artifacts.

Three operations, and deliberately no fourth:

* `put_bytes` — write an object at a key. Used by `archive.py`, whose keys embed a
  per-run monotonic sequence, so no archive object can overwrite another (Req 26.8).
* `put_bytes_if_absent` — the **conditional** put. `PutObject` with `IfNoneMatch: "*"`,
  which makes write-once an S3 guarantee rather than a read-then-write race. Returns
  `False` when an object already exists at the key, leaving its bytes unchanged and
  writing no second object (Req 34.9).
* `get_json` — read an object back as parsed JSON, for replay and for the app's
  snapshot reads.

**There is no update, no partial rewrite and no delete** (Req 34.6). A snapshot is an
audit artifact: re-running collection writes a *new* snapshot with a new id and leaves
every earlier object byte-identical (Req 34.7). Nothing needs `s3:DeleteObject`, so the
protocol offers nothing to call.

Operations are `async` because the collector is: `archive.py` writes each response
**during** the pass that folds it, and blocking the event loop on a synchronous SDK call
would serialize the writes against the metric requests they interleave with.

Faking this protocol is how `archive.py` and `snapshot.py` are exercised without AWS —
an in-memory store recording conditional-put semantics is enough.

`OWNER_TAG_KEY` and `owner_tags` live here rather than in `s3.py` for the same reason
the protocol does: they are the *vocabulary* of an artifact write, not an S3 mechanism —
a tag key and a one-entry mapping, with no SDK anywhere near them. Keeping them beside
the protocol is what lets `collect/snapshot.py` name the ownership tag without importing
boto3, and `collect/snapshot.py` sits on the transitive import closure of
`verify/replay.py`, whose purity is enforced at build time (Req 31.2, 31.7). A pure
module reaching a cloud SDK for a string constant is exactly the kind of edge that
closure guard exists to catch. `s3.py` re-exports both, so every existing import path
keeps working.
"""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Final, Protocol, runtime_checkable

__all__ = [
    "DEFAULT_CONTENT_TYPE",
    "JSON_CONTENT_TYPE",
    "OWNER_TAG_KEY",
    "JsonValue",
    "ObjectNotFoundError",
    "ObjectStore",
    "ObjectStoreError",
    "owner_tags",
]

type JsonValue = (
    str | bool | int | Decimal | list["JsonValue"] | dict[str, "JsonValue"] | None
)
"""What a stored artifact parses back into.

`Decimal`, never `float`: every metric value is stored as a decimal string, and a JSON
number encountered on a read is parsed as `Decimal` so nothing on the path from a stored
artifact to a hash input can round-trip through binary floating point.
"""

DEFAULT_CONTENT_TYPE: Final[str] = "application/octet-stream"
JSON_CONTENT_TYPE: Final[str] = "application/json"

OWNER_TAG_KEY: Final[str] = "owner-actor-id"
"""The tag key naming the actor that owns an artifact (Req 35.6)."""


def owner_tags(actor_id: str) -> dict[str, str]:
    """The ownership tag every artifact carries (Req 35.6)."""
    return {OWNER_TAG_KEY: actor_id}


class ObjectStoreError(Exception):
    """An object-store operation failed for a reason the caller must handle."""


class ObjectNotFoundError(ObjectStoreError):
    """No object exists at the requested key."""

    def __init__(self, key: str) -> None:
        super().__init__(f"no object at key {key!r}")
        self.key = key


@runtime_checkable
class ObjectStore(Protocol):
    """A private, write-once-friendly object store."""

    async def put_bytes(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = DEFAULT_CONTENT_TYPE,
        tags: Mapping[str, str] | None = None,
    ) -> None:
        """Write `body` at `key`, tagged with `tags` (objects are private)."""
        ...

    async def put_bytes_if_absent(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = DEFAULT_CONTENT_TYPE,
        tags: Mapping[str, str] | None = None,
    ) -> bool:
        """Write `body` at `key` only if no object exists there.

        Returns `True` when this call wrote the object and `False` when an object was
        already present, in which case the existing bytes are left untouched and no
        second object is written (Req 34.9).
        """
        ...

    async def get_json(self, key: str) -> dict[str, JsonValue]:
        """Read and parse the JSON object at `key`.

        Raises `ObjectNotFoundError` if the key holds nothing.
        """
        ...

    async def get_bytes(self, key: str) -> bytes:
        """The raw bytes at `key`, unparsed.

        Distinct from :meth:`get_json` because the raw archive is gzip, not JSON, and
        because the reader that needs it — `verify/replay.py`'s caller — must hand replay
        the bytes as they were written. Parsing and re-serializing anywhere on that path
        would make a replay prove something about this process's JSON encoder rather than
        about the collector's aggregation.

        Raises `ObjectNotFoundError` if the key holds nothing.
        """
        ...

    async def list_keys(self, prefix: str) -> tuple[str, ...]:
        """Every key under `prefix`, in ascending lexical order.

        Ascending order is the contract, not an implementation detail: the raw archive's
        keys embed a zero-padded per-run sequence (`<seq:06d>-…`), so lexical order **is**
        fold order, and Req 31.4 requires each archived object folded once in the order
        the sequence records. A store returning them in arrival order would make a replay
        non-deterministic in exactly the way replay exists to disprove.
        """
        ...
