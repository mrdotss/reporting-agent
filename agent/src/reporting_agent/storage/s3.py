"""`ObjectStore` over S3 with boto3.

Objects are **private** and tagged `owner-actor-id=<actor_id>` (Req 35.6), and every key
this store is asked to write starts with the actor id segment
(`<actor_id>/snapshots/<runId>/…`), which is what makes download authorization in the app
a first-segment comparison against the signed-in user's id rather than a prefix match.

boto3 is synchronous, so each call runs in a worker thread. The client itself is
thread-safe for the operations used here, and one instance is reused for the process so
the credential and endpoint resolution happen once.

The conditional put is `PutObject` with `IfNoneMatch: "*"`. Two service responses mean
"someone else owns these bytes":

* **412 `PreconditionFailed`** — an object already exists at the key.
* **409 `ConditionalRequestConflict`** — a concurrent conditional write to the same key
  is in flight.

Both return `False` and log, because the caller's contract is identical either way: the
existing bytes are untouched and no second object is written (Req 34.9). Neither is
retried — a retry would either fail again or, worse, race the other writer.
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Final
from urllib.parse import urlencode

import boto3
from botocore.exceptions import ClientError

from reporting_agent.storage.base import (
    DEFAULT_CONTENT_TYPE,
    OWNER_TAG_KEY,
    JsonValue,
    ObjectNotFoundError,
    ObjectStoreError,
    owner_tags,
)

# `OWNER_TAG_KEY` and `owner_tags` are defined in `base.py` — a tag key and a one-entry
# mapping need no SDK, and `collect/snapshot.py` names the ownership tag while sitting on
# the pure import closure of `verify/replay.py` (Req 31.2, 31.7). They are re-exported
# here so every existing caller and test keeps its import path.
__all__ = ["OWNER_TAG_KEY", "S3ObjectStore", "encode_tags", "owner_tags"]

logger = logging.getLogger(__name__)

_ALREADY_EXISTS_CODES: Final[frozenset[str]] = frozenset(
    {"PreconditionFailed", "ConditionalRequestConflict"}
)
_ALREADY_EXISTS_STATUSES: Final[frozenset[int]] = frozenset({409, 412})
_NOT_FOUND_CODES: Final[frozenset[str]] = frozenset({"NoSuchKey", "NotFound", "404"})


def encode_tags(tags: Mapping[str, str]) -> str:
    """Render tags as the URL-encoded query string the `Tagging` header expects.

    Keys are sorted so one tag set produces one header string, whatever order the caller
    built the mapping in.
    """
    return urlencode(sorted((str(key), str(value)) for key, value in tags.items()))


class S3ObjectStore:
    """`ObjectStore` backed by one S3 bucket.

    `client` is injectable so the store is testable without AWS. Left unset, the boto3
    client is built on first use rather than in `__init__`, so constructing a store
    resolves no credentials.
    """

    def __init__(
        self,
        bucket: str,
        *,
        client: Any | None = None,
        region: str | None = None,
    ) -> None:
        if not bucket:
            raise ValueError("an artifact bucket name is required")
        self.bucket = bucket
        self._client = client
        self._region = region

    @property
    def client(self) -> Any:
        if self._client is None:
            self._client = boto3.client("s3", region_name=self._region)
        return self._client

    async def put_bytes(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = DEFAULT_CONTENT_TYPE,
        tags: Mapping[str, str] | None = None,
    ) -> None:
        await asyncio.to_thread(
            self._put, key, body, content_type=content_type, tags=tags, if_absent=False
        )

    async def put_bytes_if_absent(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str = DEFAULT_CONTENT_TYPE,
        tags: Mapping[str, str] | None = None,
    ) -> bool:
        return await asyncio.to_thread(
            self._put_if_absent, key, body, content_type=content_type, tags=tags
        )

    async def get_json(self, key: str) -> dict[str, JsonValue]:
        return await asyncio.to_thread(self._get_json, key)

    # --- the synchronous bodies, each run in a worker thread -----------------------

    def _put(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str,
        tags: Mapping[str, str] | None,
        if_absent: bool,
    ) -> None:
        params: dict[str, Any] = {
            "Bucket": self.bucket,
            "Key": key,
            "Body": body,
            "ContentType": content_type,
        }
        if tags:
            params["Tagging"] = encode_tags(tags)
        if if_absent:
            params["IfNoneMatch"] = "*"
        self.client.put_object(**params)

    def _put_if_absent(
        self,
        key: str,
        body: bytes,
        *,
        content_type: str,
        tags: Mapping[str, str] | None,
    ) -> bool:
        try:
            self._put(key, body, content_type=content_type, tags=tags, if_absent=True)
        except ClientError as exc:
            if _is_already_exists(exc):
                # Req 34.9: leave the existing bytes alone, write nothing, log the
                # attempt. The key carries an actor id and a run id, never a secret.
                logger.warning(
                    "conditional put refused: an object already exists at s3://%s/%s",
                    self.bucket,
                    key,
                )
                return False
            raise
        return True

    def _get_json(self, key: str) -> dict[str, JsonValue]:
        try:
            response = self.client.get_object(Bucket=self.bucket, Key=key)
        except ClientError as exc:
            if _is_not_found(exc):
                raise ObjectNotFoundError(key) from exc
            raise
        raw = response["Body"].read()
        document = json.loads(raw, parse_float=Decimal)
        if not isinstance(document, dict):
            raise ObjectStoreError(
                f"s3://{self.bucket}/{key} is a JSON "
                f"{type(document).__name__}, not an object"
            )
        return document


def _error_code(exc: ClientError) -> str:
    response = getattr(exc, "response", None) or {}
    error = response.get("Error") or {}
    return str(error.get("Code", ""))


def _status_code(exc: ClientError) -> int | None:
    response = getattr(exc, "response", None) or {}
    metadata = response.get("ResponseMetadata") or {}
    status = metadata.get("HTTPStatusCode")
    return status if isinstance(status, int) else None


def _is_already_exists(exc: ClientError) -> bool:
    return (
        _error_code(exc) in _ALREADY_EXISTS_CODES
        or _status_code(exc) in _ALREADY_EXISTS_STATUSES
    )


def _is_not_found(exc: ClientError) -> bool:
    return _error_code(exc) in _NOT_FOUND_CODES or _status_code(exc) == 404
