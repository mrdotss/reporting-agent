"""Unit tests for the S3 object store, against a stubbed boto3 client.

No AWS call is made: the stub records the parameters `put_object` and `get_object` were
given and models the one service behaviour the design depends on — a conditional
`PutObject` refusing a key that already holds an object (Req 34.9).
"""

from __future__ import annotations

import asyncio
import io
import json
from collections.abc import Mapping
from decimal import Decimal
from typing import Any

import pytest
from botocore.exceptions import ClientError

from reporting_agent.storage.base import (
    JSON_CONTENT_TYPE,
    ObjectNotFoundError,
    ObjectStore,
    ObjectStoreError,
)
from reporting_agent.storage.s3 import (
    OWNER_TAG_KEY,
    S3ObjectStore,
    encode_tags,
    owner_tags,
)

BUCKET = "rpt-artifacts"
ACTOR = "user_01HQ"
SNAPSHOT_KEY = f"{ACTOR}/snapshots/run_01HQ/snapshot.json"


def client_error(code: str, status: int, operation: str) -> ClientError:
    return ClientError(
        {
            "Error": {"Code": code, "Message": code},
            "ResponseMetadata": {"HTTPStatusCode": status},
        },
        operation,
    )


class StubS3Client:
    """Enough of the S3 client to exercise the store, and no more."""

    def __init__(self, *, objects: Mapping[str, bytes] | None = None) -> None:
        self.objects: dict[str, bytes] = dict(objects or {})
        self.put_calls: list[dict[str, Any]] = []
        self.get_calls: list[dict[str, Any]] = []
        self.put_error: ClientError | None = None
        self.get_error: ClientError | None = None

    def put_object(self, **params: Any) -> dict[str, Any]:
        self.put_calls.append(params)
        if self.put_error is not None:
            raise self.put_error
        key = params["Key"]
        if params.get("IfNoneMatch") == "*" and key in self.objects:
            raise client_error("PreconditionFailed", 412, "PutObject")
        self.objects[key] = params["Body"]
        return {"ETag": '"stub"'}

    def get_object(self, **params: Any) -> dict[str, Any]:
        self.get_calls.append(params)
        if self.get_error is not None:
            raise self.get_error
        key = params["Key"]
        if key not in self.objects:
            raise client_error("NoSuchKey", 404, "GetObject")
        return {"Body": io.BytesIO(self.objects[key])}


def store(client: StubS3Client) -> S3ObjectStore:
    return S3ObjectStore(BUCKET, client=client)


# --- shape --------------------------------------------------------------------------


def test_the_store_satisfies_the_object_store_protocol() -> None:
    assert isinstance(store(StubS3Client()), ObjectStore)


def test_the_protocol_offers_no_delete_or_update_operation() -> None:
    declared = {
        name
        for name in ObjectStore.__protocol_attrs__  # type: ignore[attr-defined]
        if not name.startswith("_")
    }

    # Req 34.6: there is no update path and nothing that deletes a written snapshot, so
    # the protocol exposes nothing to call.
    assert declared == {"put_bytes", "put_bytes_if_absent", "get_json"}


def test_a_bucket_name_is_required() -> None:
    with pytest.raises(ValueError, match="bucket"):
        S3ObjectStore("")


def test_constructing_a_store_with_an_injected_client_builds_no_boto3_client() -> None:
    client = StubS3Client()

    assert store(client).client is client


# --- tags ---------------------------------------------------------------------------


def test_tags_encode_as_a_url_encoded_query_string_in_sorted_key_order() -> None:
    encoded = encode_tags({"zeta": "last", OWNER_TAG_KEY: ACTOR})

    assert encoded == f"owner-actor-id={ACTOR}&zeta=last"
    assert encode_tags({"k": "a b&c=d"}) == "k=a+b%26c%3Dd"


def test_owner_tags_names_the_owning_actor() -> None:
    assert owner_tags(ACTOR) == {OWNER_TAG_KEY: ACTOR}


# --- put_bytes ----------------------------------------------------------------------


def test_put_bytes_writes_the_body_with_its_content_type_and_tags() -> None:
    client = StubS3Client()

    asyncio.run(
        store(client).put_bytes(
            f"{ACTOR}/snapshots/run_01HQ/raw/000001-southeastasia.json.gz",
            b"gzipped",
            content_type="application/gzip",
            tags=owner_tags(ACTOR),
        )
    )

    (call,) = client.put_calls
    assert call["Bucket"] == BUCKET
    assert call["Body"] == b"gzipped"
    assert call["ContentType"] == "application/gzip"
    assert call["Tagging"] == f"owner-actor-id={ACTOR}"
    assert "IfNoneMatch" not in call


def test_put_bytes_omits_the_tagging_header_when_no_tags_are_given() -> None:
    client = StubS3Client()

    asyncio.run(store(client).put_bytes("k", b"body"))

    assert "Tagging" not in client.put_calls[0]


def test_put_bytes_propagates_a_service_error() -> None:
    client = StubS3Client()
    client.put_error = client_error("AccessDenied", 403, "PutObject")

    with pytest.raises(ClientError):
        asyncio.run(store(client).put_bytes("k", b"body"))


# --- the conditional put (Req 34.9) -------------------------------------------------


def test_a_conditional_put_sends_if_none_match_and_reports_the_write() -> None:
    client = StubS3Client()

    written = asyncio.run(
        store(client).put_bytes_if_absent(
            SNAPSHOT_KEY,
            b'{"snapshot_id":"9f2c"}',
            content_type=JSON_CONTENT_TYPE,
            tags=owner_tags(ACTOR),
        )
    )

    assert written is True
    (call,) = client.put_calls
    assert call["IfNoneMatch"] == "*"
    assert call["Key"] == SNAPSHOT_KEY
    assert call["ContentType"] == JSON_CONTENT_TYPE
    assert client.objects[SNAPSHOT_KEY] == b'{"snapshot_id":"9f2c"}'


def test_a_second_conditional_put_leaves_the_existing_bytes_untouched() -> None:
    client = StubS3Client()
    target = store(client)
    first = b'{"snapshot_id":"first"}'

    assert asyncio.run(target.put_bytes_if_absent(SNAPSHOT_KEY, first)) is True
    written = asyncio.run(target.put_bytes_if_absent(SNAPSHOT_KEY, b'{"id":"second"}'))

    assert written is False
    assert client.objects[SNAPSHOT_KEY] == first
    assert [call["Key"] for call in client.put_calls] == [SNAPSHOT_KEY, SNAPSHOT_KEY]
    assert len(client.objects) == 1


def test_a_refused_conditional_put_is_logged_with_the_key(
    caplog: pytest.LogCaptureFixture,
) -> None:
    client = StubS3Client(objects={SNAPSHOT_KEY: b"already here"})

    with caplog.at_level("WARNING"):
        written = asyncio.run(store(client).put_bytes_if_absent(SNAPSHOT_KEY, b"new"))

    assert written is False
    assert SNAPSHOT_KEY in caplog.text


def test_a_concurrent_conditional_write_conflict_reports_no_write() -> None:
    client = StubS3Client()
    client.put_error = client_error("ConditionalRequestConflict", 409, "PutObject")

    assert asyncio.run(store(client).put_bytes_if_absent(SNAPSHOT_KEY, b"new")) is False


def test_a_412_without_a_recognised_error_code_still_reports_no_write() -> None:
    client = StubS3Client()
    client.put_error = ClientError(
        {"Error": {"Code": ""}, "ResponseMetadata": {"HTTPStatusCode": 412}},
        "PutObject",
    )

    assert asyncio.run(store(client).put_bytes_if_absent(SNAPSHOT_KEY, b"new")) is False


def test_a_conditional_put_propagates_an_unrelated_service_error() -> None:
    client = StubS3Client()
    client.put_error = client_error("AccessDenied", 403, "PutObject")

    with pytest.raises(ClientError):
        asyncio.run(store(client).put_bytes_if_absent(SNAPSHOT_KEY, b"new"))


# --- get_json -----------------------------------------------------------------------


def test_get_json_parses_the_stored_document() -> None:
    document = {"snapshot_id": "9f2c", "resource_count": 200, "gaps": []}
    client = StubS3Client(objects={SNAPSHOT_KEY: json.dumps(document).encode()})

    assert asyncio.run(store(client).get_json(SNAPSHOT_KEY)) == document
    assert client.get_calls == [{"Bucket": BUCKET, "Key": SNAPSHOT_KEY}]


def test_get_json_parses_a_json_number_with_a_fraction_as_a_decimal() -> None:
    # Nothing this store reads may re-enter the hash path through a binary float.
    client = StubS3Client(objects={"k": b'{"value": 12.48}'})

    parsed = asyncio.run(store(client).get_json("k"))

    assert parsed["value"] == Decimal("12.48")
    assert isinstance(parsed["value"], Decimal)


def test_get_json_raises_object_not_found_for_a_missing_key() -> None:
    client = StubS3Client()

    with pytest.raises(ObjectNotFoundError) as caught:
        asyncio.run(store(client).get_json("absent"))

    assert caught.value.key == "absent"


def test_get_json_rejects_a_document_that_is_not_a_json_object() -> None:
    client = StubS3Client(objects={"k": b"[1, 2, 3]"})

    with pytest.raises(ObjectStoreError, match="not an object"):
        asyncio.run(store(client).get_json("k"))


def test_get_json_propagates_an_unrelated_service_error() -> None:
    client = StubS3Client()
    client.get_error = client_error("AccessDenied", 403, "GetObject")

    with pytest.raises(ClientError):
        asyncio.run(store(client).get_json("k"))
