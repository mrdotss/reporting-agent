"""`FactEntry` and `resources[].facts` inside the canonical form (Req 4.1-4.6, 4.10-4.13).

Three groups, and the split is the same one `collect/snapshot.py` draws:

* what a **single fact** refuses at construction — an undeclared source or kind, an absent
  receipt instant, a numeric value the grammar does not admit. All it can name is its own key;
* what only the **builder** can refuse — two facts on one resource sharing a key, and a
  `collected_at` outside the run's lifetime. Both need something an entry does not have, and
  both name the resource id;
* what reaches the **canonical form** — the array is emitted always, ordered by key, with every
  value a JSON string, inside the bytes the `content_hash` is taken over.

The third group is where the digest lives, so its assertions are about bytes rather than about
objects: a field that reaches `to_plain_data` and not the canonical form would satisfy every
shape assertion and still leave two runs over one estate with two different snapshot ids.
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Any, Final

import pytest

from reporting_agent.collect.snapshot import (
    DECLARED_FACT_SOURCES,
    DECLARED_FACT_VALUE_KINDS,
    NUMERIC_FACT_GRAMMAR,
    FactEntry,
    FactEntryError,
    canonical_bytes,
)
from snapshot_factory import SUBSCRIPTION_ID, build
from snapshot_factory import vm as _vm

RESOURCE_ID: Final[str] = (
    f"/subscriptions/{SUBSCRIPTION_ID}/resourceGroups/rg-prod"
    f"/providers/Microsoft.Compute/virtualMachines/prod-web-01"
)
OTHER_ID: Final[str] = RESOURCE_ID.replace("prod-web-01", "prod-web-02")

COLLECTED_AT: Final[str] = "2026-07-01T00:30:00Z"
INVOCATION_STARTED_AT: Final[datetime] = datetime(2026, 7, 1, 0, 0, tzinfo=UTC)
SNAPSHOT_WRITTEN_AT: Final[datetime] = datetime(2026, 7, 1, 1, 0, tzinfo=UTC)


def vm(*, resource_id: str = RESOURCE_ID, name: str | None = None, **kwargs: Any) -> Any:
    """`snapshot_factory.vm` with the name derived from the id.

    Every resource in this module is one of two VMs and the name is never what is under test,
    so deriving it keeps each case about the facts it carries.
    """
    return _vm(
        resource_id=resource_id,
        name=name or resource_id.rsplit("/", 1)[-1],
        **kwargs,
    )


def fact(**overrides: Any) -> FactEntry:
    fields: dict[str, Any] = {
        "key": "os_type",
        "value": "Windows",
        "value_kind": "text",
        "source": "resource_graph",
        "collected_at": COLLECTED_AT,
        "formatted": "Windows",
    }
    fields.update(overrides)
    if "formatted" not in overrides and "value" in overrides:
        fields["formatted"] = overrides["value"]
    return FactEntry(**fields)


def numeric(**overrides: Any) -> FactEntry:
    fields: dict[str, Any] = {
        "key": "data_disk_count",
        "value": "4",
        "value_kind": "numeric",
        "unit": "count",
    }
    fields.update(overrides)
    return fact(**fields)


def snapshot(
    *resources: Any,
    invocation_started_at: datetime | None = INVOCATION_STARTED_AT,
) -> dict[str, Any]:
    return build(
        resources=list(resources),
        collected_at=SNAPSHOT_WRITTEN_AT,
        invocation_started_at=invocation_started_at,
    )


def facts_of(document: dict[str, Any], index: int = 0) -> list[dict[str, Any]]:
    return list(document["resources"][index]["facts"])


# --------------------------------------------------------------------------- #
# What one FactEntry refuses (Req 4.11, 4.12)
# --------------------------------------------------------------------------- #


def test_a_well_formed_fact_carries_every_declared_field() -> None:
    """Guard the guard: every refusal below would pass against a class that accepted
    nothing."""
    entry = fact()

    assert entry.to_plain_data() == {
        "key": "os_type",
        "value": "Windows",
        "value_kind": "text",
        "source": "resource_graph",
        "collected_at": COLLECTED_AT,
        "formatted": "Windows",
    }
    assert entry.sort_key == "os_type"


def test_a_numeric_fact_emits_its_unit_and_a_text_fact_omits_the_key() -> None:
    """Omitted rather than `null`, the rule every optional field on `StatisticEntry`
    follows: the emitted object carries exactly the fields that apply to it, so a value's
    shape says what kind of value it is."""
    assert numeric().to_plain_data()["unit"] == "count"
    assert "unit" not in fact().to_plain_data()


@pytest.mark.parametrize("kind", ["decimal", "number", "string", "", None, 1, "NUMERIC"])
def test_an_undeclared_value_kind_is_refused(kind: object) -> None:
    """Req 4.11 — the kind is read from the declaration and never inferred from the value's
    characters. `NUMERIC` is in the list because the check is case-sensitive: a second
    spelling would be a second kind nothing downstream branches on."""
    with pytest.raises(FactEntryError, match="value_kind"):
        fact(value_kind=kind)


@pytest.mark.parametrize(
    "source", ["guesswork", "azure", "", None, "Resource_Graph", "resourcegraph"]
)
def test_an_undeclared_source_is_refused(source: object) -> None:
    """Req 4.2 — a fact that cannot name where it came from is an assertion rather than an
    observation."""
    with pytest.raises(FactEntryError, match="source"):
        fact(source=source)


@pytest.mark.parametrize("collected_at", ["", "   ", None, 17])
def test_an_absent_collected_at_is_refused(collected_at: object) -> None:
    """Req 4.13 — a fact with no receipt instant cannot be checked against the run's own
    lifetime, so the check that would catch a fabricated one could not run."""
    with pytest.raises(FactEntryError, match="collected_at"):
        fact(collected_at=collected_at)


@pytest.mark.parametrize("value", ["", None, 4])
def test_an_absent_value_is_refused(value: object) -> None:
    """Req 5.5 — an absent fact is recorded as a **gap**, never as an empty value. A resource
    carrying `os_type: ""` would read as measured-and-blank."""
    with pytest.raises(FactEntryError, match="value"):
        fact(value=value, formatted="" if value == "" else str(value))


def test_a_formatted_string_differing_from_the_value_is_refused() -> None:
    """A fact carries no unit suffix and no grouping, so the two are one string. A second
    spelling here would be a second display path the verifier would have to choose between —
    the same hole `compile/figures.py` is the sole owner of `formatted` to close."""
    with pytest.raises(FactEntryError, match="differs from value"):
        FactEntry(
            key="os_type",
            value="Windows",
            value_kind="text",
            source="resource_graph",
            collected_at=COLLECTED_AT,
            formatted="Windows Server",
        )


def test_a_unit_on_a_text_fact_is_refused() -> None:
    """There is no unit for `Succeeded`."""
    with pytest.raises(FactEntryError, match="text fact declares no unit"):
        fact(unit="count")


@pytest.mark.parametrize(
    "value",
    [
        "1E+2",  # exponent
        "1e2",
        "+4",  # leading plus
        "1,024",  # grouping separator
        " 4",  # leading whitespace
        "4 ",  # trailing whitespace
        "4\n",  # the case `^…$` would have admitted
        "4.",  # a fractional part with no digits
        ".4",
        "4.5.6",
        "NaN",
        "Infinity",
        "0x10",
        "four",
        "-",
    ],
)
def test_a_numeric_value_outside_the_grammar_is_refused(value: str) -> None:
    """Req 4.12 — this string goes into the canonical form the content hash is taken over, so
    every alternative spelling of one quantity would be a second document with a different id.

    `"4\\n"` is the case that makes the `\\A`/`\\Z` anchoring load-bearing rather than
    stylistic: Python's `$` also matches immediately before a trailing newline, so an `^…$`
    pattern would have admitted a value carrying whitespace the requirement forbids.
    """
    with pytest.raises(FactEntryError, match="does not match"):
        numeric(value=value)


@pytest.mark.parametrize("value", ["4", "-4", "0", "12.345", "-0.5", "1024"])
def test_a_numeric_value_inside_the_grammar_is_accepted(value: str) -> None:
    """Guard the guard: the refusals above would all pass against a grammar matching
    nothing."""
    assert numeric(value=value).value == value
    assert NUMERIC_FACT_GRAMMAR.match(value)


def test_the_grammar_admits_a_trailing_newline_under_the_wrong_anchors() -> None:
    """The anchoring decision, made falsifiable.

    Asserted against a locally-built `^…$` pattern rather than trusting the prose: if someone
    "simplifies" `NUMERIC_FACT_GRAMMAR` back to `^…$`, the refusal test above starts failing
    and this test explains why in one line.
    """
    import re

    loose = re.compile(r"^-?[0-9]+(\.[0-9]+)?$")

    assert loose.match("4\n"), "the premise: `$` matches before a trailing newline"
    assert not NUMERIC_FACT_GRAMMAR.match("4\n")


def test_the_vocabularies_agree_with_the_catalog_loaders() -> None:
    """Mirrored by value rather than imported, so the snapshot validates what it is handed
    without putting a data-file read on the snapshot path. This is what stops the two copies
    from drifting."""
    from reporting_agent.catalog import loader

    assert DECLARED_FACT_SOURCES == loader.DECLARED_FACT_SOURCES
    assert DECLARED_FACT_VALUE_KINDS == loader.DECLARED_FACT_VALUE_KINDS


# --------------------------------------------------------------------------- #
# What only the builder can refuse (Req 4.12, 4.13)
# --------------------------------------------------------------------------- #


def test_two_facts_for_one_resource_sharing_a_key_are_refused() -> None:
    """Refused rather than resolved: whichever value won would be a coin toss between two
    answers from possibly two different sources, and the emitted array's contents would depend
    on which sorted first among equals."""
    with pytest.raises(FactEntryError) as raised:
        snapshot(vm(resource_id=RESOURCE_ID, facts=(fact(), fact(value="Linux"))))

    assert raised.value.key == "os_type"
    assert raised.value.resource_id == RESOURCE_ID
    assert "two facts" in str(raised.value)


def test_the_same_key_on_two_different_resources_is_ordinary() -> None:
    """The negative case that stops the rule above from being implemented as "one fact per
    key per snapshot". Every VM has an `os_type`."""
    document = snapshot(
        vm(resource_id=RESOURCE_ID, facts=(fact(),)),
        vm(resource_id=OTHER_ID, facts=(fact(value="Linux"),)),
    )

    assert [entry["value"] for entry in facts_of(document, 0)] == ["Windows"]
    assert [entry["value"] for entry in facts_of(document, 1)] == ["Linux"]


@pytest.mark.parametrize(
    ("collected_at", "why"),
    [
        ("2026-06-30T23:59:59Z", "before the invocation began"),
        ("2026-07-01T01:00:01Z", "after the snapshot was written"),
        ("2027-01-01T00:00:00Z", "a year later"),
    ],
)
def test_a_collected_at_outside_the_runs_lifetime_is_refused(
    collected_at: str, why: str
) -> None:
    """Req 4.13 — a fact stamped outside the run did not come from it, and a snapshot carrying
    one would attribute an observation to a collection that could not have made it."""
    with pytest.raises(FactEntryError) as raised:
        snapshot(vm(resource_id=RESOURCE_ID, facts=(fact(collected_at=collected_at),)))

    assert raised.value.resource_id == RESOURCE_ID
    assert raised.value.key == "os_type"
    assert "outside this run's lifetime" in str(raised.value), why


@pytest.mark.parametrize(
    "collected_at",
    ["2026-07-01T00:00:00Z", "2026-07-01T00:30:00Z", "2026-07-01T01:00:00Z"],
)
def test_both_bounds_are_inclusive(collected_at: str) -> None:
    """A fact collected in the same second the invocation began, or the same second the
    snapshot was written, is inside the run. An exclusive bound would reject a correct run
    whose first request returned inside the invocation's own first second."""
    document = snapshot(
        vm(resource_id=RESOURCE_ID, facts=(fact(collected_at=collected_at),))
    )

    assert facts_of(document)[0]["collected_at"] == collected_at


def test_an_offset_instant_is_compared_correctly_rather_than_lexically() -> None:
    """`2026-07-01T07:30:00+07:00` is `00:30:00Z` — inside the window — and sorts *after*
    every `Z` string it should compare as earlier than. A lexical comparison would reject it,
    and Asia/Jakarta is `+07:00`, so this is the product's own timezone rather than a
    hypothetical."""
    document = snapshot(
        vm(resource_id=RESOURCE_ID, facts=(fact(collected_at="2026-07-01T07:30:00+07:00"),))
    )

    assert facts_of(document)[0]["collected_at"] == "2026-07-01T07:30:00+07:00"


@pytest.mark.parametrize("collected_at", ["not an instant", "07:30:00Z", "2026-13-01T00:00:00Z"])
def test_an_unparseable_collected_at_is_refused_by_the_builder(collected_at: str) -> None:
    """Non-empty, so `FactEntry.__post_init__` accepts it, and unusable, so the bound check
    cannot run — which is a refusal rather than a check that quietly passes."""
    with pytest.raises(FactEntryError, match="RFC 3339"):
        snapshot(vm(resource_id=RESOURCE_ID, facts=(fact(collected_at=collected_at),)))


@pytest.mark.parametrize("collected_at", ["2026-07-01T00:30:00", "2026-07-01"])
def test_a_naive_collected_at_is_refused_by_the_builder(collected_at: str) -> None:
    """An instant with no offset cannot be ordered against the run's bounds without inventing
    a zone for it, and inventing one is how a fact from outside the window gets admitted.

    A bare date is here as well as a bare local time: `datetime.fromisoformat` accepts both and
    returns something naive, so both reach this branch rather than the unparseable one.
    """
    with pytest.raises(FactEntryError, match="naive"):
        snapshot(vm(resource_id=RESOURCE_ID, facts=(fact(collected_at=collected_at),)))


def test_the_replay_path_asserts_no_bound(recwarn: pytest.WarningsRecorder) -> None:
    """`invocation_started_at=None` is the decision the replay path makes.

    Replay re-derives a document that was already validated when it was written and has no
    invocation of its own, so re-checking the bound against a fresh instant would fail every
    stored snapshot. The **key** check still runs, which is what stops `None` from disabling
    validation wholesale.
    """
    del recwarn
    outside = fact(collected_at="2020-01-01T00:00:00Z")

    document = snapshot(
        vm(resource_id=RESOURCE_ID, facts=(outside,)), invocation_started_at=None
    )
    assert facts_of(document)[0]["collected_at"] == "2020-01-01T00:00:00Z"

    with pytest.raises(FactEntryError, match="two facts"):
        snapshot(
            vm(resource_id=RESOURCE_ID, facts=(fact(), fact(value="Linux"))),
            invocation_started_at=None,
        )


# --------------------------------------------------------------------------- #
# What reaches the canonical form (Req 4.6, 34.8)
# --------------------------------------------------------------------------- #


def test_the_facts_array_is_emitted_always_including_empty() -> None:
    """Req 4.6. Omitting the key would make "this resource has no facts" and "this snapshot
    predates facts" the same document, and would make the digest depend on whether a source
    happened to answer."""
    document = snapshot(vm(resource_id=RESOURCE_ID))

    assert facts_of(document) == []
    assert "facts" in document["resources"][0]
    assert b'"facts"' in canonical_bytes(document)


def test_the_facts_array_is_ordered_by_key_in_code_point_order() -> None:
    """Req 34.8 — produced here, never inherited from the order responses arrived in. Two runs
    whose sources answered in different orders must hash identically."""
    keys = ("zone_redundant", "os_type", "Zulu", "access_tier", "vm_size", "_leading")
    document = snapshot(
        vm(
            resource_id=RESOURCE_ID,
            facts=tuple(fact(key=key, value=f"v-{key}") for key in keys),
        )
    )

    emitted = [entry["key"] for entry in facts_of(document)]
    assert emitted == sorted(keys)
    # Code point order, not case-insensitive or locale order: `Z` sorts before `_` and `_`
    # before `a`, which a locale-aware comparison would not guarantee.
    assert emitted[0] == "Zulu"
    assert emitted[1] == "_leading"


def test_reordering_the_input_does_not_change_the_digest() -> None:
    """The property the ordering exists for, asserted on the digest rather than on the array."""
    entries = tuple(
        fact(key=key, value=f"v-{key}") for key in ("os_type", "vm_size", "access_tier")
    )
    forward = snapshot(vm(resource_id=RESOURCE_ID, facts=entries))
    reversed_ = snapshot(vm(resource_id=RESOURCE_ID, facts=tuple(reversed(entries))))

    assert forward["content_hash"] == reversed_["content_hash"]


def test_every_value_is_a_json_string_including_a_numeric_facts() -> None:
    """Req 4.6, 34.1 — never a JSON number. A JSON number is serialized through
    `float.__repr__`, and a snapshot that hashes differently on two machines is not immutable
    in any useful sense.

    Asserted on the **bytes**, because `to_plain_data` returning a `str` is not the same claim
    as the canonical form carrying a quoted string.
    """
    document = snapshot(vm(resource_id=RESOURCE_ID, facts=(numeric(value="4"),)))

    assert facts_of(document)[0]["value"] == "4"
    assert b'"value":"4"' in canonical_bytes(document)
    assert b'"value":4' not in canonical_bytes(document)
    # And it survives a JSON round trip as a string rather than becoming an int.
    reparsed = json.loads(canonical_bytes(document))
    assert reparsed["resources"][0]["facts"][0]["value"] == "4"


def test_a_fact_changes_the_digest() -> None:
    """Guard the guard for the whole group: the array reaches the hashed bytes, so the
    ordering and always-emitted assertions above are about something."""
    without = snapshot(vm(resource_id=RESOURCE_ID))
    with_one = snapshot(vm(resource_id=RESOURCE_ID, facts=(fact(),)))

    assert without["content_hash"] != with_one["content_hash"]


def test_a_resource_with_no_statistics_still_carries_its_facts() -> None:
    """The requirement's own case, and the reason `facts` is independent of `statistics`.

    A stopped machine's size, OS and backup status are all readable while it is switched off,
    and they are exactly what a right-sizing reader wants about a machine nobody is using.
    Emitting facts only for resources that produced a measurement would drop the configuration
    of every resource the report most needs to talk about.
    """
    document = snapshot(
        vm(
            resource_id=RESOURCE_ID,
            power_state="deallocated",
            statistics=[],
            facts=(fact(),),
        )
    )

    resource = document["resources"][0]
    assert resource["statistics"] == []
    assert [entry["key"] for entry in resource["facts"]] == ["os_type"]


def test_the_snapshot_schema_version_declares_the_shape_bump() -> None:
    """`facts` is emitted always, so every digest moved at this bump. The version is what tells
    a reader that a stored snapshot and today's recomputation genuinely disagree rather than
    that something is broken."""
    from reporting_agent.collect.snapshot import SNAPSHOT_SCHEMA_VERSION

    assert SNAPSHOT_SCHEMA_VERSION == "1.2.0"
    assert snapshot(vm(resource_id=RESOURCE_ID))["schema_version"] == "1.2.0"
