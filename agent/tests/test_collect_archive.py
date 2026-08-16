"""Task 11.6 — `collect/archive.py`: the raw archive writer (Req 26.3-26.12).

Driven against `InMemoryObjectStore`, with no S3 and no network. Every test reasons
about `ArchiveWriter.write` in isolation from `azure/metrics.py`'s own fold loop — the
integration tests in `test_azure_metrics.py` prove the two compose correctly.
"""

from __future__ import annotations

import asyncio
import gzip
import json

from fakes.object_store import InMemoryObjectStore
from reporting_agent.collect.archive import ArchiveWriter, archive_key
from reporting_agent.collect.log import GAP_TYPE_ARCHIVE_WRITE_FAILED

ACTOR_ID = "user_01HQZZZZZZZZZZZZZZZZZZZZZZ"
RUN_ID = "run_01HQZZZZZZZZZZZZZZZZZZZZZZ"
SUBSCRIPTION = "3f2b0000-0000-0000-0000-000000000000"
LOCATION = "southeastasia"
RESOURCE_TYPE = "Microsoft.Compute/virtualMachines"
WINDOW = {"start_utc": "2026-07-01T00:00:00Z", "end_utc": "2026-07-01T01:00:00Z"}


def run(coro):
    return asyncio.run(coro)


class FailingObjectStore:
    """An `ObjectStore` whose `put_bytes` always raises, for Req 26.7's failure path."""

    async def put_bytes(self, key, body, *, content_type="application/octet-stream", tags=None):
        raise RuntimeError("simulated S3 failure")

    async def put_bytes_if_absent(self, key, body, *, content_type="application/octet-stream", tags=None):
        raise RuntimeError("simulated S3 failure")

    async def get_json(self, key):
        raise RuntimeError("not used")


def _write(writer: ArchiveWriter, *, resource_ids=("vm-1",), raw_body=None):
    return run(
        writer.write(
            actor_id=ACTOR_ID,
            run_id=RUN_ID,
            subscription_id=SUBSCRIPTION,
            location=LOCATION,
            resource_type=RESOURCE_TYPE,
            resource_ids=resource_ids,
            grain="PT1H",
            window=WINDOW,
            metric_names=("Percentage CPU",),
            raw_body=raw_body if raw_body is not None else {"values": []},
        )
    )


# --------------------------------------------------------------------------- #
# key format (Req 26.8)
# --------------------------------------------------------------------------- #


def test_archive_key_embeds_the_sequence_location_and_type_zero_padded_to_6_digits() -> None:
    key = archive_key(
        actor_id=ACTOR_ID, run_id=RUN_ID, sequence=3, location=LOCATION, resource_type=RESOURCE_TYPE
    )
    assert key == (
        f"{ACTOR_ID}/snapshots/{RUN_ID}/raw/000003-southeastasia-"
        f"Microsoft.Compute_virtualMachines.json.gz"
    )


def test_two_writes_produce_two_distinct_never_colliding_keys() -> None:
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    first = _write(writer)
    second = _write(writer)

    assert first.key != second.key
    assert first.wrote and second.wrote
    assert len(store) == 2


def test_the_sequence_is_monotonic_and_enumerable_in_fold_order() -> None:
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    results = [_write(writer) for _ in range(5)]

    sequences = [int(r.key.rsplit("/", 1)[-1].split("-", 1)[0]) for r in results]
    assert sequences == sorted(sequences)
    assert sequences == list(range(5))


# --------------------------------------------------------------------------- #
# one object per response, gzip-compressed JSON, provenance embedded (Req 26.3,
# 26.6, 26.9)
# --------------------------------------------------------------------------- #


def test_exactly_one_object_is_written_per_response() -> None:
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    _write(writer)

    assert len(store) == 1


def test_the_object_body_is_gzip_compressed_json_carrying_the_provenance() -> None:
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    result = _write(
        writer,
        resource_ids=("vm-1", "vm-2"),
        raw_body={"values": [{"resourceid": "vm-1"}]},
    )

    stored = store.get(result.key)
    assert stored is not None
    document = json.loads(gzip.decompress(stored.body))

    assert document["grouping_key"] == {
        "subscription_id": SUBSCRIPTION,
        "location": LOCATION,
        "resource_type": RESOURCE_TYPE,
    }
    assert document["grain"] == "PT1H"
    assert document["window"] == WINDOW
    assert document["metric_names"] == ["Percentage CPU"]
    assert document["resource_ids"] == ["vm-1", "vm-2"]
    assert document["raw_response"] == {"values": [{"resourceid": "vm-1"}]}
    assert result.key.endswith(".json.gz")


def test_the_key_ends_in_json_gz() -> None:
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    result = _write(writer)

    assert result.key.endswith(".json.gz")


# --------------------------------------------------------------------------- #
# no re-read of Azure (Req 26.5) — nothing in this module's signature offers a
# transport of any kind
# --------------------------------------------------------------------------- #


def test_write_takes_no_azure_transport_argument() -> None:
    """A static confirmation that `write`'s signature carries no port or client:
    every argument is data the caller already had in hand."""
    import inspect

    parameters = inspect.signature(ArchiveWriter.write).parameters
    assert "port" not in parameters
    assert "client" not in parameters
    assert "credential" not in parameters


# --------------------------------------------------------------------------- #
# a rejected request writes no object (Req 26.10) — by construction: this
# module is simply never called for one
# --------------------------------------------------------------------------- #


def test_a_writer_never_called_for_a_rejected_request_writes_nothing() -> None:
    store = InMemoryObjectStore()
    ArchiveWriter(store=store)  # constructed, never asked to write

    assert len(store) == 0


# --------------------------------------------------------------------------- #
# a failed write: archive_write_failed per resource, folds anyway, incomplete
# flag (Req 26.4, 26.7, 26.12)
# --------------------------------------------------------------------------- #


def test_a_failed_write_records_one_archive_write_failed_gap_per_resource() -> None:
    writer = ArchiveWriter(store=FailingObjectStore())

    result = _write(writer, resource_ids=("vm-1", "vm-2", "vm-3"))

    assert result.wrote is False
    assert len(result.gaps) == 3
    assert {gap["resource_id"] for gap in result.gaps} == {"vm-1", "vm-2", "vm-3"}
    assert all(gap["gap_type"] == GAP_TYPE_ARCHIVE_WRITE_FAILED for gap in result.gaps)
    assert all(gap["metric"] is None for gap in result.gaps)


def test_a_failed_write_marks_the_writer_archive_incomplete() -> None:
    writer = ArchiveWriter(store=FailingObjectStore())
    assert writer.archive_incomplete is False

    _write(writer)

    assert writer.archive_incomplete is True


def test_archive_incomplete_stays_true_after_a_later_successful_write() -> None:
    """Once incomplete, permanently incomplete for the run — a later success does not
    un-flag it, because the earlier failed write's data is still unreplayable."""
    store = InMemoryObjectStore()
    failing_writer = ArchiveWriter(store=FailingObjectStore())
    _write(failing_writer)
    assert failing_writer.archive_incomplete is True

    # Simulate "the same instance, later, against a store that now works" by
    # swapping in a working store directly - representative of the property under
    # test (the flag is sticky), not a suggested production pattern.
    failing_writer.store = store
    _write(failing_writer)

    assert failing_writer.archive_incomplete is True
    assert len(store) == 1


def test_a_working_writer_never_flips_the_incomplete_flag() -> None:
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    for _ in range(3):
        _write(writer)

    assert writer.archive_incomplete is False


# --------------------------------------------------------------------------- #
# input validation
# --------------------------------------------------------------------------- #


def test_an_empty_resource_ids_sequence_is_rejected() -> None:
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    try:
        _write(writer, resource_ids=())
    except ValueError:
        pass
    else:
        raise AssertionError("expected ValueError for empty resource_ids")


# --------------------------------------------------------------------------- #
# concurrent writes never collide on the sequence counter
# --------------------------------------------------------------------------- #


async def _write_many(writer: ArchiveWriter, count: int) -> list[str]:
    results = await asyncio.gather(
        *[
            writer.write(
                actor_id=ACTOR_ID,
                run_id=RUN_ID,
                subscription_id=SUBSCRIPTION,
                location=LOCATION,
                resource_type=RESOURCE_TYPE,
                resource_ids=(f"vm-{i}",),
                grain="PT1H",
                window=WINDOW,
                metric_names=("Percentage CPU",),
                raw_body={"values": []},
            )
            for i in range(count)
        ]
    )
    return [r.key for r in results]


def test_concurrent_writes_never_produce_a_duplicate_key() -> None:
    store = InMemoryObjectStore()
    writer = ArchiveWriter(store=store)

    keys = run(_write_many(writer, 25))

    assert len(keys) == len(set(keys)) == 25
    assert len(store) == 25
