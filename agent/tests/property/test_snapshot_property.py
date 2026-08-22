"""Property 2 — JCS canonicalization and content addressing are stable.

**Validates: Requirements 34.1, 34.2, 34.3, 34.4, 34.5, 42.2, 42.4, 42.8**

*Invariant / round-trip.* Generate a snapshot-shaped structure, then generate
permutations of every object's key insertion order and assert the canonical form is
byte-identical across all of them — which is the only sense in which "immutable" and
"content-addressed" mean anything an auditor could check.

Everything asserted here about `rfc8785` 0.1.4 (the pinned version) was verified
against the installed package rather than read off the RFC, because three of its
behaviours are the whole reason design.md chose it over `json.dumps(sort_keys=True)`:

* **Keys sort by UTF-16 code unit, not by Unicode code point.** An astral character is
  a surrogate pair in UTF-16, so `"\U0001F600"` (high surrogate `U+D83D`) sorts
  **before** `"\uE000"` and `"\uFB00"` — and **after** `"\uD7FF"`. Under code-point
  order the first two comparisons invert. `sorted()` on Python `str` is code-point
  order, so a hand-rolled `json.dumps(sort_keys=True)` disagrees with JCS on exactly
  this input and on nothing a hand-written test would think to try.
* **No Unicode normalization.** `"\u00e9"` (NFC) and `"e\u0301"` (NFD) canonicalize to
  different bytes and therefore hash differently, which Property 2.8 requires.
* **A `Decimal` is refused and a `float` is accepted.** `rfc8785.dumps` raises
  `CanonicalizationError` for a `Decimal` and happily renders `1.5` as the number
  token `1.5`. Those two facts point the same way: a metric value must already be a
  `str` by the time it reaches canonicalization, and the thing that has to be
  *guarded* is the `float` — hence `assert_no_floats` on the hash path (Req 34.10) and
  hence :func:`assert_number_tokens_are_integers` below, which is what would catch a
  float that slipped past the guard (Property 2.5).

  An integer beyond 2^53 is refused too — `rfc8785.dumps({"a": 9007199254740993})`
  raises `IntegerDomainError`, because JCS number serialization is defined through the
  IEEE-754 double domain. The declared decimal strings are therefore not merely a
  determinism convention: `9007199254740993` has **no** representation as a JSON
  number in a JCS document at all, and can only travel as a string.

Four classes of failure a plausible implementation gets wrong, one assertion group
each:

* **Ordering.** Any implementation that sorts keys itself — by code point, by
  `locale`, or by relying on Python's insertion order — produces a digest that depends
  on how the document was assembled. Killed by the permutation invariance over every
  generated structure and by the UTF-16-vs-code-point pair above.
* **Numeric round-tripping.** A metric value that passes through a binary float
  changes the digest, silently, for four of the values a real snapshot carries:
  `9007199254740993` collapses to `...992`, `0.30000000000000004` to `0.3`, and a
  17-significant-digit value to a 16-digit one. Each is a declared example, asserted
  both to survive byte-for-byte and to hash **differently** from its float-collapsed
  twin.
* **Over-eager stripping.** `content_hash` and `snapshot_id` are excluded from the
  canonical input at the **top level only** (Req 34.4). A recursive strip of every
  field named `content_hash` at every depth looks equivalent and is not: it makes two
  structures differing only in a nested `content_hash` hash alike, which Property 2.8
  forbids outright.
* **In-process hash randomization.** A `set` iterated anywhere on the snapshot path
  orders by string hashes, which differ between processes. A single-process test cannot
  see this at all, so :func:`test_the_digest_is_identical_across_two_processes_with_
  different_hash_seeds` computes the digest in two child interpreters under different
  `PYTHONHASHSEED` values and compares them to each other and to this process's.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import unicodedata
from datetime import UTC, date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from random import Random
from typing import Any

import pytest
import rfc8785
from hypothesis import example, given
from hypothesis import strategies as st

import reporting_agent
from reporting_agent.collect.buckets import BASE_GRAIN, resolve_window
from reporting_agent.collect.snapshot import (
    CONTENT_HASH_FIELD,
    SNAPSHOT_ID_FIELD,
    FloatInSnapshotError,
    ResourceSnapshot,
    SkuCapacity,
    StatisticEntry,
    build_snapshot,
    canonical_bytes,
    content_hash,
    decimal_string,
    verify_content_hash,
)
from reporting_agent.providers.base import GapRecord, PlainData, ResourceRecord, ScopeSpec

# --- the declared alphabet (Req 34's Property 2.6) ----------------------------------
#
# Every one of these appears in every generated structure, so the alphabet requirement
# is structural rather than something the generator might get around to.

ASTRAL_KEY = "\U0001f600"
"""A character outside the Basic Multilingual Plane: U+1F600, encoded in UTF-16 as the
surrogate pair D83D DE00. Its **first UTF-16 code unit** is what decides its order."""

BMP_LIGATURE_KEY = "\ufb00"
BMP_PRIVATE_USE_KEY = "\ue000"
"""Two BMP characters above U+D800. Under UTF-16 code-unit order they sort **after**
:data:`ASTRAL_KEY` (D83D < E000 < FB00); under Unicode code-point order they sort
**before** it (U+E000 < U+FB00 < U+1F600). This is the pair that distinguishes JCS
from `json.dumps(sort_keys=True)`."""

BMP_BELOW_SURROGATES_KEY = "\ud7ff"
"""The control for the pair above: U+D7FF is below the surrogate range, so it sorts
before the astral key under **both** orders. If this one flipped, the test data would
be wrong rather than the implementation."""

UPPER_KEY = "A"
LOWER_KEY = "a"
"""A pair of keys differing only by letter case. `"A"` (U+0041) precedes `"a"`
(U+0061), so a case-insensitive sort puts them in an order JCS never would."""

ESCAPE_VALUE = 'quote " backslash \\ newline \n tab \t control \x00 astral \U0001f600'
"""A string requiring JSON escaping in four different ways, plus an astral character
that JCS emits as raw UTF-8 rather than as an escape."""

NFC_KEY = "\u00e9"
NFD_KEY = "e\u0301"
"""`é` in composed and decomposed form. Different bytes, therefore different digests
(Property 2.8) — an implementation calling `unicodedata.normalize` anywhere on this
path makes them hash alike, and `tests/test_boundaries.py` scans the snapshot path for
exactly that call."""

DECLARED_UNICODE_KEYS: tuple[str, ...] = (
    ASTRAL_KEY,
    BMP_LIGATURE_KEY,
    BMP_PRIVATE_USE_KEY,
    BMP_BELOW_SURROGATES_KEY,
    UPPER_KEY,
    LOWER_KEY,
    NFC_KEY,
    NFD_KEY,
)


# --- the declared metric-value decimal strings (Req 34's Property 2.7) --------------
#
# (the value, the value it collapses to through a binary double). Each pair is a
# *different digest* assertion: a metric value that round-trips through a float is not
# the same measurement, and the digest is the only place that shows.

DECLARED_DECIMAL_STRINGS: tuple[tuple[str, str], ...] = (
    # 2^53 + 1. Unrepresentable as a double at all: `float("9007199254740993")` is
    # 9007199254740992.0, and `rfc8785` refuses the integer outright.
    ("9007199254740993", "9007199254740992"),
    # The classic: 0.1 has no exact binary expansion.
    ("0.1", "0.1000000000000000055511151231257827"),
    # What 0.1 + 0.2 actually is in binary, against what a reader assumes it is.
    ("0.30000000000000004", "0.3"),
    # 17 significant digits — one more than a double carries, so the last is lost.
    ("1.2345678901234567", "1.2345678901234568"),
)

DECLARED_VALUES: tuple[str, ...] = tuple(value for value, _ in DECLARED_DECIMAL_STRINGS)


PERMUTATION_COUNT = 10
"""Req 34's Property 2.1 floor: at least 10 permutations of each object's key
insertion order. The two deterministic re-orderings below run in addition to these."""


# --- key-order permutation ----------------------------------------------------------


def permute_key_order(value: PlainData, rng: Random) -> PlainData:
    """`value` rebuilt with every object's key **insertion order** shuffled.

    Array order is preserved deliberately. JCS orders object keys and leaves arrays
    exactly as it finds them (Req 34.8), so shuffling a list would change the document
    rather than re-spell it, and the byte-identity assertion would be false for a
    correct implementation.
    """
    if isinstance(value, dict):
        items = list(value.items())
        rng.shuffle(items)
        return {key: permute_key_order(item, rng) for key, item in items}
    if isinstance(value, list):
        return [permute_key_order(item, rng) for item in value]
    return value


def reorder_keys(value: PlainData, *, reverse: bool) -> PlainData:
    """`value` rebuilt with every object's keys inserted in sorted (or reverse-sorted)
    Python order — code-point order, which is *not* JCS order.

    Two deterministic re-spellings that run alongside the shuffles, so a structure
    whose objects happen to be small still gets a key order genuinely different from
    the one it was built with.
    """
    if isinstance(value, dict):
        return {
            key: reorder_keys(item, reverse=reverse)
            for key, item in sorted(value.items(), key=lambda kv: kv[0], reverse=reverse)
        }
    if isinstance(value, list):
        return [reorder_keys(item, reverse=reverse) for item in value]
    return value


def key_order_variants(document: dict[str, PlainData], seed: int) -> list[dict[str, PlainData]]:
    """At least 12 spellings of `document` differing only in key insertion order: the
    original, sorted, reverse-sorted, and :data:`PERMUTATION_COUNT` shuffles."""
    rng = Random(seed)
    variants: list[dict[str, PlainData]] = [
        document,
        cast_document(reorder_keys(document, reverse=False)),
        cast_document(reorder_keys(document, reverse=True)),
    ]
    variants.extend(
        cast_document(permute_key_order(document, rng)) for _ in range(PERMUTATION_COUNT)
    )
    return variants


def cast_document(value: PlainData) -> dict[str, PlainData]:
    """The permutation helpers are typed over `PlainData` because they recurse; a
    top-level document is always an object, and this is where that is asserted rather
    than assumed."""
    assert isinstance(value, dict)
    return value


# --- the number-token check (Req 34.2 / Property 2.5) -------------------------------


class NumberTokenError(AssertionError):
    """A canonical form carried a JSON number token that was not an integer."""


def _reject_float(token: str) -> object:
    raise NumberTokenError(
        f"the canonical form carries the non-integer number token {token!r}: no metric "
        f"value may be serialized as a JSON number (Req 34.2)"
    )


def _reject_constant(token: str) -> object:
    raise NumberTokenError(f"the canonical form carries the constant {token!r}")


def strip_json_strings(text: str) -> str:
    """`text` with every string literal removed, so what remains is structure, number
    tokens and whitespace.

    A scanner rather than a regex: JCS escapes `"` as `\\"` and `\\` as `\\\\`, so a
    naive `".*?"` would end a string inside an escape and leave string content behind
    to be mistaken for a number token.
    """
    out: list[str] = []
    in_string = False
    escaped = False
    for char in text:
        if in_string:
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
            continue
        out.append(char)
    assert not in_string, "unterminated string in the canonical form"
    return "".join(out)


_LITERAL_TOKEN = re.compile(r"true|false|null")
_INTEGER_TOKEN = re.compile(r"-?\d+")


def assert_number_tokens_are_integers(canonical: bytes) -> None:
    """Every JSON number token in `canonical` is an integer token containing no `.`,
    no `e` and no `E` (Req 34.2 / Property 2.5).

    Two independent mechanisms, because each catches something the other does not:

    * `json.loads` with a `parse_float` hook that **raises** is exact — the hook is
      called for precisely the tokens the JSON grammar classifies as non-integer
      numbers, with no tokenizing of our own to get wrong.
    * The text scan catches a token the parser would accept as an integer but which
      still carries a forbidden character in a position `parse_float` never sees, and
      it fails loudly if a future `rfc8785` emitted something exotic.
    """
    text = canonical.decode("utf-8")
    json.loads(text, parse_float=_reject_float, parse_constant=_reject_constant)

    # `true`, `false` and `null` are literals, not number tokens, and two of them carry
    # an `e`. They are removed before the character check rather than special-cased
    # inside it, so what remains is only structure and number tokens.
    outside_strings = _LITERAL_TOKEN.sub("", strip_json_strings(text))
    forbidden = sorted({char for char in outside_strings if char in ".eE"})
    assert not forbidden, (
        f"the canonical form carries {forbidden} outside a string literal, so some "
        f"number token is not an integer (Req 34.2): {outside_strings!r}"
    )
    assert not re.search(r"[-]?\d+[.eE]", outside_strings)

    # Nothing else is left: every remaining run of characters is an integer token or a
    # structural character, which is a stronger statement than "no dot, e or E".
    residue = _INTEGER_TOKEN.sub("", outside_strings)
    assert not residue.strip("{}[]:, \t\n\r"), (
        f"the canonical form carries an unexpected token outside a string literal: "
        f"{residue!r}"
    )


# --- the generated snapshot structure (Property 2.6, 2.7) ---------------------------

_ASCII_KEY_ALPHABET = "abcXYZ_-0.9 "
"""Ordinary ASCII for the generated portion of the alphabet, including a space and a
dot so a generated *key* can look like a number without being one."""

leaf_values = st.one_of(
    st.text(alphabet=_ASCII_KEY_ALPHABET + ASTRAL_KEY, max_size=6),
    st.integers(min_value=-(10**9), max_value=10**9),
    st.booleans(),
    st.none(),
    st.sampled_from(DECLARED_VALUES),
    st.just(ESCAPE_VALUE),
)
"""Every leaf is plain data and **no leaf is a `float` or a `Decimal`**: by the time a
document is hashed every metric value is already a string (Req 34.1, 34.2), so a
generated `float` here would be testing a shape the pipeline cannot produce — the
`float` case is covered directly by
:func:`test_a_float_is_refused_on_the_hash_path_and_would_break_the_integer_token_rule`.
"""

generated_keys = st.one_of(
    st.text(alphabet=_ASCII_KEY_ALPHABET, min_size=1, max_size=4),
    st.sampled_from(DECLARED_UNICODE_KEYS),
    st.just(ESCAPE_VALUE),
)


def nested_blob(depth: int) -> st.SearchStrategy[PlainData]:
    """A dict/list tree of exactly `depth` container levels, kept small so
    `HealthCheck.data_too_large` stays a real signal rather than noise."""
    if depth <= 0:
        return leaf_values
    child = nested_blob(depth - 1)
    return st.one_of(
        st.dictionaries(generated_keys, child, min_size=1, max_size=3),
        st.lists(child, min_size=1, max_size=3),
    )


@st.composite
def snapshot_structures(draw: st.DrawFn) -> dict[str, PlainData]:
    """A snapshot-shaped plain-data document satisfying every clause of Property 2.6
    and 2.7 by construction.

    * **Depth ≥ 4** — `resources` (1) → a resource object (2) → `statistics` (3) → a
      statistic object (4) → `derived_from` (5) → a source object (6).
    * **The declared alphabet** — every key in :data:`DECLARED_UNICODE_KEYS` appears
      under `tags`, including the case-differing pair, the astral key and both
      normalization forms; :data:`ESCAPE_VALUE` appears as both a key and a value.
    * **An empty object and an empty array** at the top level.
    * **All four declared decimal strings** as metric values, every time.
    * A freely generated nested blob alongside them, so the property is not only ever
      exercised against one shape.
    """
    resource_count = draw(st.integers(min_value=1, max_value=2))
    resources: list[PlainData] = []
    for index in range(resource_count):
        statistics: list[PlainData] = []
        for value in DECLARED_VALUES:
            statistics.append(
                {
                    "metric": draw(st.sampled_from(["Percentage CPU", "Available Memory Bytes"])),
                    "statistic": draw(st.sampled_from(["avg", "min", "max"])),
                    "value": value,
                    "unit": draw(st.sampled_from(["percent", "bytes"])),
                    "sample_count": draw(st.integers(min_value=0, max_value=44640)),
                    "derived_from": [
                        {"kind": "metric", "name": draw(st.sampled_from(["a", "B", ASTRAL_KEY]))}
                    ],
                }
            )
        resources.append(
            {
                "resource_id": f"/subscriptions/s/resourceGroups/rg/providers/vm-{index}",
                "tags": {key: draw(leaf_values) for key in DECLARED_UNICODE_KEYS},
                ESCAPE_VALUE: ESCAPE_VALUE,
                "statistics": statistics,
                "day_buckets": [],
            }
        )

    return {
        "schema_version": "1.0.0",
        "run_id": draw(st.text(alphabet=_ASCII_KEY_ALPHABET, min_size=1, max_size=8)),
        "declared_values": list(DECLARED_VALUES),
        "empty_object": {},
        "empty_array": [],
        "resources": resources,
        "generated": draw(nested_blob(4)),
    }


DECLARED_STRUCTURE: dict[str, PlainData] = {
    "schema_version": "1.0.0",
    "run_id": "run-1",
    "declared_values": list(DECLARED_VALUES),
    "empty_object": {},
    "empty_array": [],
    "resources": [
        {
            "resource_id": "/subscriptions/s/resourceGroups/rg/providers/vm-0",
            "tags": dict.fromkeys(DECLARED_UNICODE_KEYS, "v"),
            ESCAPE_VALUE: ESCAPE_VALUE,
            "statistics": [
                {
                    "metric": "Percentage CPU",
                    "statistic": "avg",
                    "value": value,
                    "unit": "percent",
                    "sample_count": 44640,
                    "derived_from": [{"kind": "metric", "name": ASTRAL_KEY}],
                }
                for value in DECLARED_VALUES
            ],
            "day_buckets": [],
        }
    ],
    "generated": {UPPER_KEY: [{LOWER_KEY: [ESCAPE_VALUE]}]},
}
"""The declared example (Req 42.8): every clause of Property 2.6 and 2.7 in one fixed
document, so the four decimal strings, the astral key, the case-differing pair, both
normalization forms, the escaping string, the empty object and the empty array are
exercised on **every** execution rather than only when the generator draws them."""


# --- Property 2.1, 2.2, 2.5, 2.7 ----------------------------------------------------


@given(structure=snapshot_structures(), seed=st.integers(min_value=0, max_value=2**32 - 1))
@example(structure=DECLARED_STRUCTURE, seed=0)
@example(structure=DECLARED_STRUCTURE, seed=1)
def test_canonical_form_is_byte_identical_under_every_key_order_permutation(
    structure: dict[str, PlainData], seed: int
) -> None:
    """Req 34.3, 34.4 / Property 2.1, 2.2, 2.5.

    At least 12 spellings of one document differing only in key insertion order all
    canonicalize to the **same bytes** and hash to the same digest, and every number
    token in that canonical form is an integer.
    """
    variants = key_order_variants(structure, seed)
    assert len(variants) >= PERMUTATION_COUNT

    # Non-vacuity: the variants really are different spellings. A permutation helper
    # that quietly returned its input would make every assertion below trivially true,
    # so the difference is asserted rather than assumed.
    assert any(list(variant) != list(structure) for variant in variants)

    expected_bytes = canonical_bytes(structure)
    expected_digest = content_hash(structure)

    for variant in variants:
        # Property 2.1 — byte-identical, not merely equal-hashing. A digest-only
        # assertion would pass an implementation that produced different bytes and
        # hashed something else.
        assert canonical_bytes(variant) == expected_bytes
        # Property 2.2 — structures equal ignoring key order share a digest.
        assert content_hash(variant) == expected_digest

    # Property 2.5 / Req 34.2 — every number token an integer. The declared decimal
    # strings are in every generated structure, so this is also the assertion that a
    # metric value stayed a string (Property 2.7).
    assert_number_tokens_are_integers(expected_bytes)
    assert len(expected_digest) == 64
    assert re.fullmatch(r"[0-9a-f]{64}", expected_digest)

    # Property 2.7 — each declared decimal string survives byte-for-byte inside the
    # canonical form, digits intact.
    text = expected_bytes.decode("utf-8")
    for value in DECLARED_VALUES:
        assert f'"{value}"' in text


def test_two_independently_built_documents_equal_ignoring_key_order_hash_identically() -> None:
    """Property 2.2, asserted directly rather than only as a corollary of permutation
    invariance: two documents written out by hand in different key orders, nested
    differently in insertion order at every level, hash the same."""
    first: dict[str, PlainData] = {
        "run_id": "run-1",
        "resources": [{"resource_id": "vm-0", "statistics": [{"value": "0.1", "unit": "percent"}]}],
        "window": {"start": "2026-07-01", "end": "2026-07-31"},
    }
    second: dict[str, PlainData] = {
        "window": {"end": "2026-07-31", "start": "2026-07-01"},
        "resources": [{"statistics": [{"unit": "percent", "value": "0.1"}], "resource_id": "vm-0"}],
        "run_id": "run-1",
    }

    assert list(first) != list(second)
    assert canonical_bytes(first) == canonical_bytes(second)
    assert content_hash(first) == content_hash(second)


# --- Property 2.3 / Req 34.4 --------------------------------------------------------


@given(
    structure=snapshot_structures(),
    injected=st.sampled_from(
        [
            "0" * 64,
            "f" * 64,
            "not a digest at all",
            "",
        ]
    ),
)
@example(structure=DECLARED_STRUCTURE, injected="0" * 64)
def test_the_top_level_hash_fields_do_not_affect_the_digest(
    structure: dict[str, PlainData], injected: str
) -> None:
    """Req 34.4 / Property 2.3 — the digest is unchanged by the presence, the absence
    or the content of the two top-level hash fields, because they are excluded from the
    canonicalized input. Including either would make the computation circular."""
    bare_bytes = canonical_bytes(structure)
    bare_digest = content_hash(structure)

    for value in (injected, bare_digest):
        carrying = dict(structure)
        carrying[CONTENT_HASH_FIELD] = value
        carrying[SNAPSHOT_ID_FIELD] = value
        assert canonical_bytes(carrying) == bare_bytes
        assert content_hash(carrying) == bare_digest

    # One field without the other, in both directions: neither is special.
    only_hash = dict(structure) | {CONTENT_HASH_FIELD: injected}
    only_id = dict(structure) | {SNAPSHOT_ID_FIELD: injected}
    assert content_hash(only_hash) == bare_digest
    assert content_hash(only_id) == bare_digest

    # The caller's mapping is untouched — `canonical_bytes` copies rather than pops.
    assert CONTENT_HASH_FIELD not in structure
    assert SNAPSHOT_ID_FIELD not in structure


# --- Property 2.8 — the nested `content_hash`, and any difference in a value --------


@given(
    structure=snapshot_structures(),
    first_value=st.text(alphabet=_ASCII_KEY_ALPHABET, min_size=1, max_size=8),
    second_value=st.text(alphabet=_ASCII_KEY_ALPHABET, min_size=1, max_size=8),
)
@example(structure=DECLARED_STRUCTURE, first_value="a", second_value="b")
def test_a_nested_content_hash_changes_the_digest(
    structure: dict[str, PlainData], first_value: str, second_value: str
) -> None:
    """Req 34.4 / Property 2.8 — a field named `content_hash` **below** the top level
    is ordinary document content: adding one changes the digest, and changing its value
    changes the digest again.

    This is the assertion that fails a recursive strip. Popping every field named
    `content_hash` at every depth passes the top-level exclusion test above and makes
    these two structures hash alike, which is a snapshot whose id does not address its
    own bytes.
    """
    resources = structure["resources"]
    assert isinstance(resources, list)
    first_resource = resources[0]
    assert isinstance(first_resource, dict)

    without = content_hash(structure)

    def with_nested(value: str) -> str:
        nested = dict(first_resource) | {CONTENT_HASH_FIELD: value}
        return content_hash(dict(structure) | {"resources": [nested, *resources[1:]]})

    assert with_nested(first_value) != without
    if first_value != second_value:
        assert with_nested(first_value) != with_nested(second_value)

    # Depth 4, inside a statistic object rather than a resource: the exclusion is a
    # top-level rule, not a first-two-levels rule.
    statistics = first_resource["statistics"]
    assert isinstance(statistics, list)
    first_statistic = statistics[0]
    assert isinstance(first_statistic, dict)
    deep = dict(first_resource) | {
        "statistics": [dict(first_statistic) | {CONTENT_HASH_FIELD: first_value}, *statistics[1:]]
    }
    assert content_hash(dict(structure) | {"resources": [deep, *resources[1:]]}) != without

    # `snapshot_id` nested below the top level is content too, on the same terms.
    nested_id = dict(first_resource) | {SNAPSHOT_ID_FIELD: first_value}
    assert content_hash(dict(structure) | {"resources": [nested_id, *resources[1:]]}) != without


@given(
    structure=snapshot_structures(),
    replacement=st.sampled_from([value for _, value in DECLARED_DECIMAL_STRINGS]),
)
@example(structure=DECLARED_STRUCTURE, replacement="9007199254740992")
def test_any_difference_in_a_value_changes_the_digest(
    structure: dict[str, PlainData], replacement: str
) -> None:
    """Property 2.8 — changing one metric value anywhere in the document changes the
    digest. The replacements are exactly the values a binary float round-trip would
    collapse the declared strings to, so this is also the float-round-trip check
    (Property 2.7) expressed as a digest inequality."""
    original = content_hash(structure)

    declared = structure["declared_values"]
    assert isinstance(declared, list)
    assert replacement not in declared

    mutated = dict(structure) | {"declared_values": [replacement, *declared[1:]]}
    assert content_hash(mutated) != original


# --- Property 2.5 — the float that would break the rule -----------------------------


def test_a_float_is_refused_on_the_hash_path_and_would_break_the_integer_token_rule() -> None:
    """Req 34.10 / Property 2.5, from both ends.

    `canonical_bytes` refuses a `float` with a path-carrying error, and
    :func:`assert_number_tokens_are_integers` — the checker every generated case above
    runs — genuinely fails on what `rfc8785` would have emitted for that same float.
    A checker that could not fail would make Property 2.5 vacuous, so it is exercised
    against a real violation here.
    """
    document: dict[str, Any] = {"resources": [{"statistics": [{"value": 12.48}]}]}

    with pytest.raises(FloatInSnapshotError) as excinfo:
        canonical_bytes(document)
    assert excinfo.value.path == "$.resources[0].statistics[0].value"

    # What `rfc8785` does with the float `canonical_bytes` just refused: it accepts it
    # and emits a non-integer number token.
    unguarded = rfc8785.dumps(document)
    assert b"12.48" in unguarded
    with pytest.raises(NumberTokenError):
        assert_number_tokens_are_integers(unguarded)

    # A `Decimal` does not reach the token stage at all — it is refused outright, which
    # is why every metric value is already a string by the time a document is hashed.
    with pytest.raises(rfc8785.CanonicalizationError):
        rfc8785.dumps({"value": Decimal("12.48")})

    # And an integer beyond 2^53 has no JCS number representation at all, which is the
    # second, independent reason `9007199254740993` can only travel as a string.
    with pytest.raises(rfc8785.CanonicalizationError):
        rfc8785.dumps({"value": 9007199254740993})


# --- Property 2.7 / Req 34.1, 34.2 — the declared decimal strings -------------------


@pytest.mark.parametrize(("value", "float_collapsed"), DECLARED_DECIMAL_STRINGS)
def test_a_declared_decimal_string_survives_canonicalization_byte_for_byte(
    value: str, float_collapsed: str
) -> None:
    """Req 34.1, 34.2 / Property 2.7 — the four declared metric values canonicalize as
    **strings**, digit for digit, and hash differently from the value they would
    collapse to through a binary double."""
    canonical = canonical_bytes({"value": value})

    assert canonical == b'{"value":"' + value.encode("ascii") + b'"}'
    assert_number_tokens_are_integers(canonical)

    assert content_hash({"value": value}) != content_hash({"value": float_collapsed})

    # The collapse is real, not hypothetical: for three of the four, `float(value)`
    # round-trips to a different decimal string than the one that went in.
    assert Decimal(value) != Decimal(float_collapsed)


def test_the_declared_decimal_strings_round_trip_through_decimal_string_in_plain_notation() -> None:
    """Req 34.1 — `decimal_string` is the one place a metric value becomes a string,
    and it emits plain notation carrying no exponent at every declared value's own
    scale.

    `9007199254740993` at scale 0 is the sharp case: it is 2^53 + 1, so an
    implementation that took `Decimal(float(value))` anywhere on this path emits
    `9007199254740992` and the digest moves. The two values carrying more fractional
    digits than the catalog's maximum scale of 9 are asserted only for plain notation
    and for the scale they are quantized to — the catalog's scale is the serialization
    contract, and pretending otherwise here would be testing a scale the loader
    forbids.
    """
    assert decimal_string(Decimal("9007199254740993"), 0) == "9007199254740993"
    assert decimal_string(Decimal("0.1"), 1) == "0.1"
    assert decimal_string(Decimal("0.1"), 9) == "0.100000000"
    assert decimal_string(Decimal("0.30000000000000004"), 9) == "0.300000000"
    assert decimal_string(Decimal("1.2345678901234567"), 9) == "1.234567890"

    # Plain notation, always: `str(Decimal("1E+3"))` is `"1E+3"`, and a snapshot
    # carrying `1E+3` where another machine wrote `1000` is not content-addressed.
    assert decimal_string(Decimal("1E+3"), 0) == "1000"
    for value, _ in DECLARED_DECIMAL_STRINGS:
        for scale in (0, 2, 9):
            rendered = decimal_string(Decimal(value), scale)
            assert "e" not in rendered and "E" not in rendered
            assert rendered.count("-") == 0
            assert_number_tokens_are_integers(canonical_bytes({"value": rendered}))


# --- Property 2.8 — Unicode normalization form ---------------------------------------


def test_keys_differing_only_by_unicode_normalization_form_hash_differently() -> None:
    """Property 2.8 — `"\\u00e9"` (NFC) and `"e\\u0301"` (NFD) are the same character to
    a reader and different keys to JCS.

    An implementation calling `unicodedata.normalize` anywhere on the snapshot path
    makes these two documents hash alike, which would mean two snapshots with different
    bytes claiming the same id. The `unicodedata` calls here are the test data's own
    self-check: they assert the two spellings really are normalization variants, so a
    typo in the literals shows up as a failure of this test rather than as a silently
    weaker assertion.
    """
    assert NFC_KEY != NFD_KEY
    assert unicodedata.normalize("NFC", NFD_KEY) == NFC_KEY
    assert unicodedata.normalize("NFD", NFC_KEY) == NFD_KEY

    composed: dict[str, PlainData] = {NFC_KEY: "1"}
    decomposed: dict[str, PlainData] = {NFD_KEY: "1"}

    assert canonical_bytes(composed) != canonical_bytes(decomposed)
    assert content_hash(composed) != content_hash(decomposed)

    # The same in a value position, and nested, so the rule is not accidentally
    # limited to top-level keys.
    assert content_hash({"tags": {"name": NFC_KEY}}) != content_hash({"tags": {"name": NFD_KEY}})
    assert content_hash({"a": {NFC_KEY: {}}}) != content_hash({"a": {NFD_KEY: {}}})

    # And both spellings in one object are two distinct keys, not a collision.
    both = canonical_bytes({NFC_KEY: "1", NFD_KEY: "2"})
    assert both.count(b'"') == 8


# --- Property 2.6 — UTF-16 code-unit key order, verified against rfc8785 ------------


def test_object_keys_are_ordered_by_utf16_code_unit_not_by_code_point() -> None:
    """Property 2.6 — the ordering assertion that kills `json.dumps(sort_keys=True)`.

    Verified empirically against the pinned `rfc8785` 0.1.4 rather than inferred:

    * `"A"` before `"a"` — U+0041 < U+0061 under both orders, so this one only kills a
      case-insensitive or locale-aware sort.
    * :data:`ASTRAL_KEY` (U+1F600) before `"\\ue000"` and before `"\\ufb00"` — and this
      **inverts** under code-point order, because an astral character's first UTF-16
      code unit is a high surrogate in D800-DBFF, numerically below every BMP
      character from U+E000 up. `sorted()` on Python `str` is code-point order, so a
      hand-rolled canonicalizer disagrees with JCS on exactly this input.
    * :data:`ASTRAL_KEY` **after** `"\\ud7ff"`, which is below the surrogate range — the
      control that proves the assertion above is about UTF-16 order rather than about
      astral characters always sorting first.
    """
    assert canonical_bytes({LOWER_KEY: 1, UPPER_KEY: 2}) == b'{"A":2,"a":1}'

    # The pair that inverts. Code-point order would put "\ue000" / "\ufb00" first.
    assert ord(ASTRAL_KEY) > ord(BMP_PRIVATE_USE_KEY)
    assert ord(ASTRAL_KEY) > ord(BMP_LIGATURE_KEY)
    assert sorted([ASTRAL_KEY, BMP_PRIVATE_USE_KEY, BMP_LIGATURE_KEY]) == [
        BMP_PRIVATE_USE_KEY,
        BMP_LIGATURE_KEY,
        ASTRAL_KEY,
    ]

    canonical = canonical_bytes(
        {BMP_LIGATURE_KEY: 1, BMP_PRIVATE_USE_KEY: 2, ASTRAL_KEY: 3, BMP_BELOW_SURROGATES_KEY: 4}
    )
    assert canonical == (
        b'{"'
        + BMP_BELOW_SURROGATES_KEY.encode("utf-8", "surrogatepass")
        + b'":4,"'
        + ASTRAL_KEY.encode("utf-8")
        + b'":3,"'
        + BMP_PRIVATE_USE_KEY.encode("utf-8")
        + b'":2,"'
        + BMP_LIGATURE_KEY.encode("utf-8")
        + b'":1}'
    )

    # Stated as an order over positions, so the intent survives a future encoding
    # change in the assertion above.
    positions = [canonical.index(key.encode("utf-8", "surrogatepass")) for key in
                 (BMP_BELOW_SURROGATES_KEY, ASTRAL_KEY, BMP_PRIVATE_USE_KEY, BMP_LIGATURE_KEY)]
    assert positions == sorted(positions)


# --- Property 2.4 / Req 34.3 — two processes, two hash seeds -------------------------

_CHILD_PROGRAM = """
import json
import sys

from reporting_agent.collect.snapshot import canonical_bytes, content_hash

document = json.load(open(sys.argv[1], encoding="utf-8"))


def reorder(value, reverse):
    if isinstance(value, dict):
        return {
            key: reorder(item, reverse)
            for key, item in sorted(value.items(), key=lambda kv: kv[0], reverse=reverse)
        }
    if isinstance(value, list):
        return [reorder(item, reverse) for item in value]
    return value


digests = [
    content_hash(document),
    content_hash(reorder(document, False)),
    content_hash(reorder(document, True)),
]
assert canonical_bytes(document) == canonical_bytes(reorder(document, True))
print(json.dumps({"hash_randomization": sys.flags.hash_randomization, "digests": digests}))
"""
"""What each child process computes: the digest of the document as the file spells it,
plus the digests of two re-spellings with different key insertion orders. All three
must agree, in both children, and with this process — so the check covers ordering
that depends on in-process string hashing *and* ordering that depends on insertion
order, in one pass."""


def _run_child(program: Path, document: Path, hash_seed: str) -> dict[str, object]:
    """Run `program` in a fresh interpreter under `PYTHONHASHSEED=<hash_seed>`.

    `sys.executable` is the venv interpreter, but the package is **not installed** into
    it — `pyproject.toml` puts `src` on the path through pytest's `pythonpath` setting,
    which a child process does not inherit. `PYTHONPATH` is therefore set from
    `reporting_agent.__file__`'s parent, which is that same `src` directory whichever
    way the suite was invoked, and the child runs from a directory that is *not* the
    agent root so an accidental implicit-cwd import would fail loudly instead of
    masking a missing `PYTHONPATH`.
    """
    source_root = Path(reporting_agent.__file__).resolve().parent.parent
    env = dict(os.environ)
    env["PYTHONHASHSEED"] = hash_seed
    env["PYTHONPATH"] = str(source_root)

    # A fixed argv, no shell, and no external input: the program and the document are
    # both written by this test into `tmp_path`.
    completed = subprocess.run(
        [sys.executable, str(program), str(document)],
        capture_output=True,
        text=True,
        cwd=str(program.parent),
        env=env,
        timeout=120,
        check=False,
    )
    assert completed.returncode == 0, completed.stderr
    parsed = json.loads(completed.stdout)
    assert isinstance(parsed, dict)
    return parsed


def test_the_digest_is_identical_across_two_processes_with_different_hash_seeds(
    tmp_path: Path,
) -> None:
    """Req 34.3 / Property 2.4 — the same document hashes to the same digest in two
    separate OS processes started from the same source with different interpreter
    hash-randomization seeds, and equals this process's digest.

    A single-process test cannot see this failure mode at all. `PYTHONHASHSEED` changes
    the hash of every `str`, so a `set` iterated anywhere on the snapshot path — a
    "which fields do we exclude" `frozenset`, a de-duplicated resource-type set — would
    order differently in the two children and produce two digests. That is exactly why
    `collect/snapshot.py` spells its excluded-field collection as a `tuple`.

    The declared document is :data:`DECLARED_STRUCTURE`, so the astral key, the
    case-differing pair, both normalization forms and the four decimal strings all
    cross the process boundary.
    """
    document_path = tmp_path / "document.json"
    document_path.write_text(
        json.dumps(DECLARED_STRUCTURE, ensure_ascii=False), encoding="utf-8"
    )
    program_path = tmp_path / "child_digest.py"
    program_path.write_text(_CHILD_PROGRAM, encoding="utf-8")

    # The file round-trips to exactly the structure this process hashed, so a mismatch
    # below is the implementation's doing and not the transport's.
    reloaded = json.loads(document_path.read_text(encoding="utf-8"), parse_float=_reject_float)
    assert reloaded == DECLARED_STRUCTURE
    parent_digest = content_hash(DECLARED_STRUCTURE)

    first = _run_child(program_path, document_path, "0")
    second = _run_child(program_path, document_path, "12345")

    # The seeds genuinely differ in effect: seed 0 disables randomization, so the two
    # children really are two different string-hashing regimes rather than two runs of
    # the same one.
    assert first["hash_randomization"] == 0
    assert second["hash_randomization"] == 1

    digests = [parent_digest]
    for child in (first, second):
        child_digests = child["digests"]
        assert isinstance(child_digests, list)
        assert len(child_digests) == 3
        digests.extend(child_digests)

    assert len(set(digests)) == 1, digests
    assert re.fullmatch(r"[0-9a-f]{64}", parent_digest)


# --- Property 2.1-2.5 through the real builder (Req 34.5) ---------------------------

_JAKARTA = timezone(timedelta(hours=7))

_TAG_KEYS: tuple[str, ...] = DECLARED_UNICODE_KEYS


@st.composite
def built_snapshots(draw: st.DrawFn) -> dict[str, PlainData]:
    """A document from the real :func:`build_snapshot`, over generated resources, gaps
    and scope — so the top-level assertions above are also exercised against the shape
    the collector actually produces rather than only against generated look-alikes.

    Tag keys come from :data:`DECLARED_UNICODE_KEYS` rather than from free text because
    a tag key becomes an **object key** in the emitted document, and `build_snapshot`
    rejects an object key spelled `p` followed only by digits (Req 28.4). Generating
    `"p95"` here would be generating a document the builder is required to refuse.
    """
    resource_count = draw(st.integers(min_value=1, max_value=3))
    resources: list[ResourceSnapshot] = []
    for index in range(resource_count):
        record: ResourceRecord = {
            "resource_id": f"/subscriptions/sub/resourceGroups/rg/providers/vm-{index}",
            "name": draw(st.text(alphabet=_ASCII_KEY_ALPHABET + ASTRAL_KEY, max_size=8)),
            "resource_type": "Microsoft.Compute/virtualMachines",
            "location": draw(st.sampled_from(["southeastasia", "eastus"])),
            "resource_group": "rg",
            "tags": {key: draw(st.sampled_from(["prod", "dev", ESCAPE_VALUE])) for key in _TAG_KEYS},
            "sku_name": "Standard_E32-8s_v5",
            "power_state_raw": draw(st.sampled_from(["PowerState/running", "PowerState/deallocated"])),
            "power_state": draw(st.sampled_from(["running", "deallocated", "unknown"])),
            "fidelity_tier": draw(st.sampled_from(["baseline", "enhanced"])),
        }
        statistics = tuple(
            StatisticEntry(
                metric=metric,
                statistic=statistic,
                value=draw(
                    st.decimals(
                        min_value=Decimal(0),
                        max_value=Decimal("100"),
                        places=6,
                        allow_nan=False,
                        allow_infinity=False,
                    )
                ),
                unit="percent",
                estimator="exact_count_weighted",
                fidelity_tier=record["fidelity_tier"],
                sample_count=draw(st.integers(min_value=1, max_value=44640)),
                scale=2,
            )
            for metric in ("Percentage CPU", "Available Memory Percentage")
            for statistic in ("avg", "min", "max")
        )
        resources.append(
            ResourceSnapshot(
                record=record,
                sku=SkuCapacity(
                    name=record["sku_name"],
                    vcpus_available=draw(st.integers(min_value=1, max_value=128)),
                    memory_bytes=Decimal(draw(st.integers(min_value=1, max_value=10**15))),
                ),
                statistics=statistics,
            )
        )

    gaps: list[GapRecord] = [
        {
            "gap_type": draw(st.sampled_from(["deallocated", "metric_not_emitted", "permission_denied"])),
            "resource_id": resource.resource_id,
            "metric": draw(st.one_of(st.none(), st.just("Percentage CPU"))),
            "message": draw(st.sampled_from(["not emitted for this SKU", ESCAPE_VALUE])),
        }
        for resource in resources
    ]

    scope: ScopeSpec = {
        "subscription_id": "00000000-0000-0000-0000-000000000000",
        "resource_types": ["Microsoft.Compute/virtualMachines"],
        "resource_groups": draw(st.sampled_from([[], ["rg", "rg-2"], ["rg-2", "rg"]])),
        "tag_filters": dict.fromkeys(_TAG_KEYS, "prod"),
    }
    window = resolve_window(date(2026, 7, 1), date(2026, 7, 31), _JAKARTA)

    return build_snapshot(
        invocation_started_at=None,
        run_id=draw(st.text(alphabet=_ASCII_KEY_ALPHABET, min_size=1, max_size=8)),
        scope=scope,
        scope_verified=True,
        collected_at=datetime(2026, 8, 1, 3, 15, 42, 987654, tzinfo=UTC),
        timezone_name="Asia/Jakarta",
        tz=_JAKARTA,
        window=window,
        grain=BASE_GRAIN,
        metrics_by_resource_type={
            "Microsoft.Compute/virtualMachines": ["Percentage CPU", "Available Memory Percentage"]
        },
        resources=resources,
        gaps=gaps,
        catalog_version="1.0.0",
        raw_archive_complete=True,
        raw_archive_object_count=draw(st.integers(min_value=0, max_value=500)),
    )


@given(document=built_snapshots(), seed=st.integers(min_value=0, max_value=2**32 - 1))
def test_a_built_snapshot_carries_a_snapshot_id_equal_to_its_own_content_hash(
    document: dict[str, PlainData], seed: int
) -> None:
    """Req 34.5, 34.3 / Property 2.1, 2.3, 2.5 through the real builder.

    `snapshot_id` equals `content_hash` character for character, both are 64 lowercase
    hexadecimal characters, the digest addresses the document's own bytes, every number
    token in those bytes is an integer, key-order permutations do not move the digest,
    and mutating any nested value makes `verify_content_hash` refuse the document.
    """
    digest = document[CONTENT_HASH_FIELD]
    snapshot_id = document[SNAPSHOT_ID_FIELD]

    assert isinstance(digest, str)
    assert snapshot_id == digest
    assert re.fullmatch(r"[0-9a-f]{64}", digest)

    # Req 34.4 — the digest is over the body without the two hash fields, so the stored
    # document's own id checks out against its own bytes.
    assert content_hash(document) == digest
    verify_content_hash(document)

    canonical = canonical_bytes(document)
    assert_number_tokens_are_integers(canonical)
    variants = key_order_variants(document, seed)
    assert any(list(variant) != list(document) for variant in variants)

    # Every metric value in a built document is a string, never a number token: this is
    # Req 34.1 and 34.2 observed on the builder's real output.
    for resource in _resource_objects(document):
        for statistic in _statistic_objects(resource):
            assert isinstance(statistic["value"], str)

    for variant in variants:
        assert canonical_bytes(variant) == canonical
        assert content_hash(variant) == digest
        verify_content_hash(variant)

    # A mutated nested value is refused rather than silently re-hashed: the id no
    # longer addresses the bytes.
    resources = document["resources"]
    assert isinstance(resources, list)
    first = resources[0]
    assert isinstance(first, dict)
    mutated = dict(document) | {
        "resources": [dict(first) | {"location": "mutated"}, *resources[1:]]
    }
    assert content_hash(mutated) != digest
    with pytest.raises(ValueError, match=CONTENT_HASH_FIELD):
        verify_content_hash(mutated)


def _resource_objects(document: dict[str, PlainData]) -> list[dict[str, PlainData]]:
    resources = document["resources"]
    assert isinstance(resources, list)
    out: list[dict[str, PlainData]] = []
    for resource in resources:
        assert isinstance(resource, dict)
        out.append(resource)
    return out


def _statistic_objects(resource: dict[str, PlainData]) -> list[dict[str, PlainData]]:
    statistics = resource["statistics"]
    assert isinstance(statistics, list)
    out: list[dict[str, PlainData]] = []
    for statistic in statistics:
        assert isinstance(statistic, dict)
        out.append(statistic)
    return out
