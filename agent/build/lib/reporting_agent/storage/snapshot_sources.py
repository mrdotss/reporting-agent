"""Snapshot reads for independently authorized, persisted source runs.

The authenticated app worker obtains this map from readSnapshotSources, which joins
sources to the accepted run's workspace, project and connection. Public report
requests cannot supply it. Writes always retain the current execution's paths.
"""
from __future__ import annotations
from collections.abc import Mapping
from typing import Any
from reporting_agent.storage.base import DEFAULT_CONTENT_TYPE, ObjectStore


def snapshot_source_actors(value: object) -> dict[str, str]:
    if value is None:
        return {}
    if not isinstance(value, Mapping) or len(value) > 1000:
        raise ValueError("Invalid snapshot source map")
    result: dict[str, str] = {}
    for run_id, actor_id in value.items():
        if not all(isinstance(part, str) and part and len(part) <= 200
                   and "/" not in part and "\\" not in part and part not in (".", "..")
                   for part in (run_id, actor_id)):
            raise ValueError("Invalid snapshot source identity")
        result[run_id] = actor_id
    return result


class SnapshotSourceStore:
    def __init__(self, store: ObjectStore, actor_id: str, current_run_id: str,
                 sources: Mapping[str, str]):
        self.store = store
        self.actor_id = actor_id
        self.current_run_id = current_run_id
        self.sources = dict(sources)

    def _read_key(self, key: str) -> str:
        parts = key.split("/", 3)
        if len(parts) == 4 and parts[0] == self.actor_id and parts[1] == "snapshots":
            run_id = parts[2]
            if run_id != self.current_run_id and run_id in self.sources:
                return f"{self.sources[run_id]}/snapshots/{run_id}/{parts[3]}"
        return key

    async def get_json(self, key: str) -> dict[str, Any]:
        return await self.store.get_json(self._read_key(key))

    async def get_bytes(self, key: str) -> bytes:
        return await self.store.get_bytes(self._read_key(key))

    async def list_keys(self, prefix: str) -> tuple[str, ...]:
        return await self.store.list_keys(self._read_key(prefix))

    async def put_bytes(self, key: str, body: bytes, *, content_type: str = DEFAULT_CONTENT_TYPE,
                        tags: Mapping[str, str] | None = None) -> None:
        await self.store.put_bytes(key, body, content_type=content_type, tags=tags)

    async def put_bytes_if_absent(self, key: str, body: bytes, *, content_type: str = DEFAULT_CONTENT_TYPE,
                                  tags: Mapping[str, str] | None = None) -> bool:
        return await self.store.put_bytes_if_absent(key, body, content_type=content_type, tags=tags)
