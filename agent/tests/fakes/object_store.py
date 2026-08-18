"""An in-memory `ObjectStore` fake, for `collect/archive.py` and `collect/snapshot.py`.

Implements `reporting_agent.storage.base.ObjectStore` in full — `put_bytes`,
`put_bytes_if_absent`, `get_json` — over a plain `dict`, with no S3, no network and no
boto3 anywhere in the path. What it exists to get right is the one behaviour the real
`S3ObjectStore` earns from the service rather than from application code: a
conditional put refuses a key that already holds an object, leaving the existing
bytes untouched and writing no second object (Req 34.9). `tests/test_storage_s3.py`
proves that behaviour against a stubbed boto3 client; this fake proves the identical
contract against a store that `collect/` can use directly with no stub at all.

A `threading.Lock` guards every mutation for the same reason `InvocationCredential`
and the fakes in `azure_ports.py` take one: `archive.py` writes each response during
the same fold pass that processes it (Req 26.3), and that fold happens across
`asyncio.to_thread` workers, so two archive writes for two different responses can
race on this store's dict from two real threads at once. The lock is what makes the
conditional put's check-then-write atomic against that race, which is the one thing
an unsynchronized `dict.setdefault` would get wrong under concurrency.
"""

from __future__ import annotations

import json
import threading
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from reporting_agent.storage.base import (
    DEFAULT_CONTENT_TYPE,
    JsonValue,
    ObjectNotFoundError,
    ObjectStore,
    ObjectStoreError,
)

__all__ = ["InMemoryObjectStore", "StoredObject"]


@dataclass(frozen=True, slots=True)
class StoredObject:
    """One object as the fake holds it: bytes, content type, tags.

    Frozen and returned by value from the inspection helpers below, so a test cannot
    reach into the store's internals and mutate what a "written" object contains out
    from under a later assertion.
    """

    body: bytes
    content_type: str
    tags: Mapping[str, str]


class InMemoryObjectStore:
    """`ObjectStore` over a `dict`, for exercising `archive.py` and `snapshot.py`
    without AWS.

    Every write is recorded in call order in `.calls`, tagged with which of the three
    operations produced it and whether a conditional put was refused — the same
    "what did the caller actually send" visibility `FakeInventoryPort` and friends
    give `azure/`'s modules, applied to the one port `collect/` writes through.
    """

    def __init__(self, *, objects: Mapping[str, bytes] | None = None) -> None:
        self._objects: dict[str, StoredObject] = {
            key: StoredObject(body=body, content_type=DEFAULT_CONTENT_TYPE, tags={})
            for key, body in (objects or {}).items()
        }
        self._lock = threading.Lock()
        self.calls: list[dict[str, Any]] = []

    # --- ObjectStore protocol ---------------------------------------------------

    async def put_bytes(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = DEFAULT_CONTENT_TYPE,
        tags: Mapping[str, str] | None = None,
    ) -> None:
        with self._lock:
            self._objects[key] = StoredObject(
                body=body, content_type=content_type, tags=dict(tags or {})
            )
            self.calls.append(
                {"op": "put_bytes", "key": key, "conditional": False, "wrote": True}
            )

    async def put_bytes_if_absent(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = DEFAULT_CONTENT_TYPE,
        tags: Mapping[str, str] | None = None,
    ) -> bool:
        with self._lock:
            if key in self._objects:
                self.calls.append(
                    {"op": "put_bytes_if_absent", "key": key, "conditional": True, "wrote": False}
                )
                return False
            self._objects[key] = StoredObject(
                body=body, content_type=content_type, tags=dict(tags or {})
            )
            self.calls.append(
                {"op": "put_bytes_if_absent", "key": key, "conditional": True, "wrote": True}
            )
            return True

    async def get_bytes(self, key: str) -> bytes:
        with self._lock:
            stored = self._objects.get(key)
        if stored is None:
            raise ObjectNotFoundError(key)
        return stored.body

    async def list_keys(self, prefix: str) -> tuple[str, ...]:
        """Ascending lexical order, matching the protocol's contract.

        The one caller is replay's fold order, and the archive's keys embed a zero-padded
        sequence — so lexical order *is* fold order, and a fake returning insertion order
        would let a replay pass here and go non-deterministic against S3.
        """
        with self._lock:
            return tuple(sorted(key for key in self._objects if key.startswith(prefix)))

    async def get_json(self, key: str) -> dict[str, JsonValue]:
        with self._lock:
            stored = self._objects.get(key)
        if stored is None:
            raise ObjectNotFoundError(key)
        document = json.loads(stored.body, parse_float=Decimal)
        if not isinstance(document, dict):
            raise ObjectStoreError(
                f"{key} is a JSON {type(document).__name__}, not an object"
            )
        return document

    # --- test-only inspection, not part of the ObjectStore protocol -------------

    def keys(self) -> tuple[str, ...]:
        with self._lock:
            return tuple(sorted(self._objects))

    def get(self, key: str) -> StoredObject | None:
        with self._lock:
            return self._objects.get(key)

    def __contains__(self, key: str) -> bool:
        with self._lock:
            return key in self._objects

    def __len__(self) -> int:
        with self._lock:
            return len(self._objects)


# A static, cheap guard that the fake actually satisfies the protocol it stands in
# for — the same idea as `test_storage_s3.py`'s
# `test_the_store_satisfies_the_object_store_protocol`, checked once at import so a
# drift in either the protocol or this fake is caught before any test that uses it
# runs.
assert isinstance(InMemoryObjectStore(), ObjectStore)
