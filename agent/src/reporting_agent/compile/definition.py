"""The block-type set, the per-type config schema, and the agent-side validator —
one contract, expressed in two languages.

The two sentinel-delimited declarations below are mirrored in
`app/lib/templates/blocks.ts` (Req 2.5), and a static guard in the web test suite
(`app/test/mirror.static.test.ts`) extracts the sentinel-delimited regions from
both files and compares the block-type sets, every type's config field names,
every field's required status and every enumerated field's permitted values
(Req 2.6). That is why the declarations sit on their own, between sentinel
comments, as plain tuple and dict literals rather than inside a `Pydantic` model
or an `Enum`: the guard needs neither a Python parser nor a TypeScript parser, so
the guard itself cannot drift from what it guards — the same reasoning
`events.py` already applies to the SSE event vocabulary.

**Below the declarations is the `Block_Compiler`'s validator**: the agent-side
counterpart of `app/lib/templates/definition.ts`'s `Template_Validator`, reaching
the **same verdict** for every rule (Req 2.6). Declaration equality is necessary
and not sufficient — a definition the wizard can *save* and the compiler cannot
*compile* turns a save-time validation error into a failed run minutes later,
after inventory and metrics have already been spent. Task 5.2's shared fixture
corpus is what asserts the behavioural half: every fixture through both
validators, same accept-or-reject outcome, same offending block `id` and field
path.

## Why this is a hand-written walk and not a schema library

`app/lib/templates/definition.ts` is a hand-written walk wrapped in one
`z.unknown().superRefine(...)`, for a reason its own docstring records at length:
zod's built-in structural checks abort the parse, and an aborted parse silently
skips an ancestor's cross-field checks, so a definition carrying *two*
simultaneous defects would report one of them. Requirements 2.7 and 6.11 require
**one pass reporting every violation**.

Nothing forces that shape on this side — there is no zod here — but the mirror
does. Two validators that must agree on *which* violations an input carries are
far easier to keep in agreement when they are the same algorithm: the same
recursive walk, the same order of checks, the same `continue` after a
positioning-field rejection so one key does not produce two issues on one side
and one on the other. A `Pydantic` model here would be a second, differently
shaped judge of the same rules, and every divergence would surface as a corpus
fixture whose two halves name different paths. So this module is deliberately a
transliteration, and it is commented as one.

## Three places Python and TypeScript disagree unless made to agree

**1. `bool` is an `int` in Python.** `isinstance(True, int)` is true, so a
`schema_version` of `true` would pass a naive integer check here and fail in
TypeScript, where `typeof true === "boolean"`. Every numeric predicate below
excludes `bool` explicitly.

**2. A JSON `1.0` is a `float` in Python and an integer in JavaScript.**
JavaScript has one number type: `Number.isInteger(1.0)` is `true`, and
`decimal_places: 1.0` is accepted there. `json.load` produces `1.0` as a
`float`, so :func:`_is_finite_integer` accepts an integral float — otherwise the
two halves would disagree on a value that is the *same JSON document*.

**3. `len(str)` counts code points; `String.prototype.length` counts UTF-16 code
units.** They differ for any astral-plane character, so a 64-character block id
containing one emoji is 64 here and 65 there. Every bounded string is measured
with :func:`_utf16_length`, which is what the other half actually measures.

None of the three is hypothetical: each one is a rule where one half accepts and
the other rejects, which is exactly the failure Req 2.6 exists to prevent.

## Layering: this module validates SHAPE

Metric_Catalog **membership** (Req 5.2, 5.3, 5.5) is not checked here, matching
the web half exactly — its `validateMetricSelectionAgainstCatalog` is a
separately composed function taking the catalog as a parameter. What *is* checked
here is every shape-level fact: entries are objects rather than bare strings, so
a percentile entry has somewhere to carry its estimator label and fidelity tier,
and a percentile-shaped statistic without both is rejected (Req 5.7, 5.8). The
compile pipeline composes the catalog check separately, with the
:class:`~reporting_agent.catalog.loader.LoadedCatalog` it already holds.

**Req 5.9 is checked here, and only half of it can be.** "Every resource type a
scope can contain has a metric selection" needs no catalog and no snapshot *when
the scope names resource types* — it is then a cross-field comparison between
`scope`/`scope_override` and `metrics`, so it belongs in this pass where Req 2.6's
both-halves-agree guarantee applies for free. See
:func:`_validate_every_scoped_type_is_selected`. What stays outside any validator
is the case where a scope names **no** resource types: an empty dimension is
unconstrained (Req 3.1, 3.12), so which types it can contain is a fact about the
subscription rather than about the definition, and no save-time or enqueue-time
check can see it. That case surfaces at collection time as a
`metric_not_selected` gap instead — recorded, never silent, and never a
`TEMPLATE_INVALID`, because a subscription-agnostic template (Req 1) meeting a
type it did not select is an ordinary pairing rather than a broken template.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from typing import Final

import rfc8785

from reporting_agent.errors import TemplateInvalidError

# --- BEGIN BLOCK TYPES (mirrored in app/lib/templates/blocks.ts) ---
BLOCK_TYPES: Final[tuple[str, ...]] = (
    "cover",
    "executive_summary",
    "kpi_row",
    "resource_table",
    "top_n_table",
    "timeseries_chart",
    "distribution_chart",
    "capacity_vs_usage",
    "gaps_and_coverage",
    "comparison_delta",
    "verification_record",
    "appendix_methodology",
    "row",
    "page_break",
    "heading",
    "rich_text",
    "historical_trend",
)
# --- END BLOCK TYPES ---

# --- BEGIN COLUMN KINDS (mirrored in app/lib/templates/blocks.ts) ---
COLUMN_KINDS: Final[tuple[str, ...]] = ("metric", "attribute", "fact")
# --- END COLUMN KINDS ---

# --- BEGIN BLOCK CONFIG (mirrored in app/lib/templates/blocks.ts) ---
# `non_empty` names the required string fields whose compilers demand content, and it
# exists because `_is_empty_container` deliberately cannot decide that. An empty
# string's meaning is a fact about the individual field: `heading.text: ""` is a
# legitimately blank heading, while `rich_text.text: ""` saved cleanly and then failed
# the run minutes later at `compile_rich_text`. Telling those apart needs per-field
# knowledge, and this table is already the authority on block configuration — putting
# it in the emptiness rule instead would make that rule a third authority to drift
# from, which is the thing it says in its own docstring it must not become.
#
# Declared only on the types that have such a field; both readers default to empty, so
# an absent `non_empty` and an explicit `[]` mean the same thing. A list of field names
# rather than a nested per-field flag so the Mirror_Guard reads it with the same
# `extractArrayField` it already uses for `required` and `optional` — a new shape would
# have needed a new parser on both sides, which is more mirror to keep honest.
BLOCK_CONFIG: Final[dict[str, dict[str, object]]] = {
    "cover": {
        "required": [],
        "optional": ["subtitle"],
        "enums": {},
    },
    "executive_summary": {
        "required": [],
        "optional": [],
        "enums": {},
    },
    "kpi_row": {
        "required": ["metrics"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "resource_table": {
        "required": ["columns"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "top_n_table": {
        "required": ["columns", "order_by"],
        "optional": ["caption", "show_fidelity"],
        "enums": {"order_by_direction": ["descending", "ascending"]},
        "non_empty": ["order_by"],
    },
    "timeseries_chart": {
        "required": ["metrics"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "distribution_chart": {
        "required": ["metrics"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "capacity_vs_usage": {
        "required": ["capacity_metric", "usage_metric"],
        "optional": ["caption", "show_fidelity"],
        "enums": {},
    },
    "gaps_and_coverage": {
        "required": [],
        "optional": ["caption"],
        "enums": {},
    },
    "comparison_delta": {
        "required": ["run_a", "run_b"],
        "optional": ["caption"],
        "enums": {},
        "non_empty": ["run_a", "run_b"],
    },
    "verification_record": {
        "required": [],
        "optional": ["caption"],
        "enums": {},
    },
    "appendix_methodology": {
        "required": [],
        "optional": ["caption"],
        "enums": {},
    },
    "row": {
        "required": [],
        "optional": [],
        "enums": {},
    },
    "page_break": {
        "required": [],
        "optional": [],
        "enums": {},
    },
    "heading": {
        "required": ["level", "text"],
        "optional": [],
        "enums": {},
    },
    "rich_text": {
        "required": ["text"],
        "optional": [],
        "enums": {},
        "non_empty": ["text"],
    },
    "historical_trend": {
        "required": ["metric", "statistic", "lookback"],
        "optional": ["caption"],
        "enums": {},
    },
}
# --- END BLOCK CONFIG ---

# A declaration that contradicts itself is worth catching at import rather than
# at the first validation: every type is declared exactly once, and every type
# declared in BLOCK_TYPES has exactly one BLOCK_CONFIG entry, and vice versa.
assert len(set(BLOCK_TYPES)) == len(BLOCK_TYPES), BLOCK_TYPES
assert set(BLOCK_CONFIG.keys()) == set(BLOCK_TYPES), BLOCK_CONFIG.keys()

__all__ = [
    "ACCENT_COLOR_MAX_LENGTH",
    "APPROVER_ROLES",
    "BLOCK_CONFIG",
    "BLOCK_ID_MAX_LENGTH",
    "BLOCK_ID_MIN_LENGTH",
    "BLOCK_TYPES",
    "COLUMN_KINDS",
    "DENSITY_VALUES",
    "DESCRIPTION_MAX_LENGTH",
    "DESIGN_PRESETS",
    "DOCUMENT_NUMBER_PLACEHOLDERS",
    "DOCUMENT_NUMBER_VARYING_PLACEHOLDERS",
    "FRONT_MATTER_FORBIDDEN_BLOCK_TYPES",
    "FRONT_MATTER_KEYS",
    "IDENTITY_KEYS",
    "LANGUAGES",
    "LOGO_MAX_LENGTH",
    "MAX_BLOCKS_TOTAL",
    "MAX_CHILDREN_PER_COLUMN",
    "MAX_DECIMAL_PLACES",
    "MAX_DEFINITION_CANONICAL_BYTES",
    "MAX_METRIC_ITEMS_PER_ENTRY",
    "MAX_METRIC_RESOURCE_TYPE_ENTRIES",
    "MAX_PERIOD_LOCAL_DAYS",
    "MAX_RESOURCE_GROUPS",
    "MAX_RESOURCE_TYPES",
    "MAX_ROW_COLUMNS",
    "MAX_SUPPORTED_SCHEMA_VERSION",
    "MAX_TAG_FILTERS",
    "MIN_DECIMAL_PLACES",
    "MIN_METRIC_ITEMS_PER_ENTRY",
    "MIN_PERIOD_LOCAL_DAYS",
    "MIN_ROW_COLUMNS",
    "MIN_SCHEMA_VERSION",
    "NAME_MAX_LENGTH",
    "NAME_MIN_LENGTH",
    "NON_ROW_BLOCK_TYPES",
    "NUMBER_FORMAT_KEYS",
    "PAGE_SIZE_VALUES",
    "PERIOD_KINDS",
    "REPORT_TITLE_MAX_LENGTH",
    "REQUIRED_IDENTITY_KEYS",
    "REQUIRED_TOP_LEVEL_KEYS",
    "RESOURCE_GROUP_MAX_LENGTH",
    "RESOURCE_GROUP_MIN_LENGTH",
    "RESOURCE_TYPE_MAX_LENGTH",
    "SEPARATOR_DEFAULTS",
    "SORT_DIRECTIONS",
    "TABLE_STYLE_VALUES",
    "TAG_KEY_MAX_LENGTH",
    "TAG_KEY_MIN_LENGTH",
    "TAG_VALUE_MAX_LENGTH",
    "TOP_N_MAX_COUNT",
    "TOP_N_MIN_COUNT",
    "FieldIssue",
    "ValidationMode",
    "assert_valid_pinned_definition",
    "canonical_bytes",
    "canonical_digest",
    "collect_definition_issues",
    "format_path",
    "inclusive_local_day_span",
    "is_real_calendar_date",
    "looks_like_azure_identifier",
    "resolved_schema_version",
]


# --- Bounds (Req 2.10, 3.1, 4.2, 5.1, 6.2, 6.3, 7.2) --------------------------------
#
# Every value here is the same number `app/lib/templates/definition.ts` exports under
# the same name. Two declarations of one bound is the cost of the two-language mirror;
# task 5.2's corpus is what makes a divergence a test failure rather than a review
# question, since a bound off by one shows up as one half accepting a fixture the
# other rejects.

NAME_MIN_LENGTH: Final[int] = 1
NAME_MAX_LENGTH: Final[int] = 120
DESCRIPTION_MAX_LENGTH: Final[int] = 1000
REPORT_TITLE_MAX_LENGTH: Final[int] = 200

# --- BEGIN SCHEMA VERSIONS (mirrored in app/lib/templates/definition.ts) ---
# Req 2.9, 13.10 — MIN stays 1 and 2 is the highest this reader accepts. What raises the
# version is exactly three things: `front_matter`, `identity.language`, and the two
# `number_format` separators.
MIN_SCHEMA_VERSION: Final[int] = 1
MAX_SUPPORTED_SCHEMA_VERSION: Final[int] = 2

# The version-conditional key sets, **declared as data rather than as two validators**.
# `collect_definition_issues` resolves the version once and reads the record for it, so no
# branch is written twice and the Mirror_Guard stays a set comparison with no parser on
# either side. Two validators would be two places for a key to be admitted at one version
# and not the other, and the divergence would present as a definition the wizard saves and
# this compiler refuses — minutes into a run, after the collection has been spent.
#
# Three behaviours follow with no rule anybody writes: a v1 definition carrying
# `front_matter`, `identity.language` or either separator is rejected as an **undeclared
# key** by the existing strict checks, at three different levels of the document.
#
# Req 13.13 makes `front_matter` **required** at version 2, not merely permitted, so it
# belongs in this list rather than in a separate optional set.
REQUIRED_TOP_LEVEL_KEYS: Final[dict[int, tuple[str, ...]]] = {
    1: ("schema_version", "identity", "scope", "period", "metrics", "blocks", "design"),
    2: (
        "schema_version",
        "identity",
        "scope",
        "period",
        "metrics",
        "blocks",
        "design",
        "front_matter",
    ),
}

# Req 16.1 — two keys at v1, four at v2.
NUMBER_FORMAT_KEYS: Final[dict[int, tuple[str, ...]]] = {
    1: ("decimal_places", "group_thousands"),
    2: (
        "decimal_places",
        "group_thousands",
        "decimal_separator",
        "grouping_separator",
    ),
}

# Req 15.1 — `identity.language` exists at v2 and nowhere else.
IDENTITY_KEYS: Final[dict[int, tuple[str, ...]]] = {
    1: ("name", "description", "report_title"),
    2: ("name", "description", "report_title", "language"),
}

REQUIRED_IDENTITY_KEYS: Final[dict[int, tuple[str, ...]]] = {
    1: ("name",),
    2: ("name", "language"),
}

# Req 15.1 — the two declared languages, matched **case-sensitively**. `EN` is not a
# spelling of `en`: the value keys a message catalog whose ids are lowercase ASCII by
# pattern, so a second spelling would pin a language the resolver cannot find.
LANGUAGES: Final[tuple[str, ...]] = ("en", "id")

# Req 13.1 — the three sections of the front matter.
FRONT_MATTER_KEYS: Final[tuple[str, ...]] = ("cover", "document_control", "toc")

# Req 13.2 — block types the front matter owns at v2 and above, so they may not also appear
# in `blocks`. Only `cover`: `document_control` and `toc` are **not block types and never
# were**, so a definition naming either in `blocks` is already rejected as an undeclared
# type. `cover` **stays** in `BLOCK_TYPES` because Req 13.11 requires a stored v1
# definition carrying one to keep compiling.
FRONT_MATTER_FORBIDDEN_BLOCK_TYPES: Final[tuple[str, ...]] = ("cover",)
# --- END SCHEMA VERSIONS ---

assert set(REQUIRED_TOP_LEVEL_KEYS) == {MIN_SCHEMA_VERSION, MAX_SUPPORTED_SCHEMA_VERSION}
assert set(NUMBER_FORMAT_KEYS) == set(REQUIRED_TOP_LEVEL_KEYS)
assert set(IDENTITY_KEYS) == set(REQUIRED_TOP_LEVEL_KEYS)
assert set(REQUIRED_IDENTITY_KEYS) == set(REQUIRED_TOP_LEVEL_KEYS)
assert set(FRONT_MATTER_FORBIDDEN_BLOCK_TYPES) <= set(BLOCK_TYPES)

# Req 16.3 — the separators each language implies when the definition declares none.
# Applied at validation time to decide whether the resolved pair is legal, and never
# written back: a declared value is persisted unchanged and an undeclared one stays
# undeclared, so no stored row is rewritten and a v1 definition renders byte-identically
# to the way it always did (Req 16.10).
SEPARATOR_DEFAULTS: Final[dict[str, tuple[str, str]]] = {
    "en": (".", ","),
    "id": (",", "."),
}
"""`language -> (decimal_separator, grouping_separator)`. `en`'s pair is
`compile/format.DEFAULT_NUMBER_FORMAT`'s, which is what a v1 definition has always
rendered with."""

assert set(SEPARATOR_DEFAULTS) == set(LANGUAGES)

MAX_DEFINITION_CANONICAL_BYTES: Final[int] = 262_144

MAX_RESOURCE_TYPES: Final[int] = 20
RESOURCE_TYPE_MAX_LENGTH: Final[int] = 300
MAX_TAG_FILTERS: Final[int] = 10
TAG_KEY_MIN_LENGTH: Final[int] = 1
TAG_KEY_MAX_LENGTH: Final[int] = 512
TAG_VALUE_MAX_LENGTH: Final[int] = 256
MAX_RESOURCE_GROUPS: Final[int] = 50
RESOURCE_GROUP_MIN_LENGTH: Final[int] = 1
RESOURCE_GROUP_MAX_LENGTH: Final[int] = 90
TOP_N_MIN_COUNT: Final[int] = 1
TOP_N_MAX_COUNT: Final[int] = 500

MAX_METRIC_RESOURCE_TYPE_ENTRIES: Final[int] = 25
MIN_METRIC_ITEMS_PER_ENTRY: Final[int] = 1
MAX_METRIC_ITEMS_PER_ENTRY: Final[int] = 40

BLOCK_ID_MIN_LENGTH: Final[int] = 1
BLOCK_ID_MAX_LENGTH: Final[int] = 64
MAX_BLOCKS_TOTAL: Final[int] = 200
MIN_ROW_COLUMNS: Final[int] = 2
MAX_ROW_COLUMNS: Final[int] = 3
MAX_CHILDREN_PER_COLUMN: Final[int] = 8

ACCENT_COLOR_MAX_LENGTH: Final[int] = 64
LOGO_MAX_LENGTH: Final[int] = 512
MIN_DECIMAL_PLACES: Final[int] = 0
MAX_DECIMAL_PLACES: Final[int] = 3

MIN_PERIOD_LOCAL_DAYS: Final[int] = 1
MAX_PERIOD_LOCAL_DAYS: Final[int] = 31


# --- Closed value sets --------------------------------------------------------------

SORT_DIRECTIONS: Final[tuple[str, ...]] = ("descending", "ascending")
DESIGN_PRESETS: Final[tuple[str, ...]] = ("editorial", "corporate", "technical", "minimal")
DENSITY_VALUES: Final[tuple[str, ...]] = ("compact", "normal", "relaxed")
TABLE_STYLE_VALUES: Final[tuple[str, ...]] = ("hairline", "banded", "bordered")
PAGE_SIZE_VALUES: Final[tuple[str, ...]] = ("A4", "Letter")
PERIOD_KINDS: Final[tuple[str, ...]] = (
    "last_24h",
    "last_7d",
    "last_30d",
    "last_full_month",
    "mtd",
    "custom",
)

NON_ROW_BLOCK_TYPES: Final[tuple[str, ...]] = tuple(
    block_type for block_type in BLOCK_TYPES if block_type != "row"
)

_NON_ROW_BLOCK_TYPE_SET: Final[frozenset[str]] = frozenset(NON_ROW_BLOCK_TYPES)

_SCOPE_ALLOWED_KEYS: Final[frozenset[str]] = frozenset(
    {"resource_types", "tag_filters", "resource_groups", "top_n", "sort"}
)
_TOP_N_ALLOWED_KEYS: Final[frozenset[str]] = frozenset({"count", "metric", "statistic"})
_METRIC_ITEM_ALLOWED_KEYS: Final[frozenset[str]] = frozenset(
    {"metric", "derived", "statistic", "estimator", "fidelity_tier"}
)
_LEAF_BLOCK_ALLOWED_KEYS: Final[frozenset[str]] = frozenset(
    {"id", "type", "config", "scope_override"}
)
_ROW_BLOCK_ALLOWED_KEYS: Final[frozenset[str]] = frozenset({"id", "type", "columns"})
_DESIGN_ALLOWED_KEYS: Final[frozenset[str]] = frozenset(
    {
        "preset",
        "accent_color",
        "density",
        "table_style",
        "number_format",
        "cover_page",
        "logo",
        "page_size",
    }
)

# Req 6.6 — `rich_text` carries static prose and no figure. Each of these is already
# absent from `BLOCK_CONFIG["rich_text"]`, so the generic unrecognised-field check
# would reject it anyway; the list exists so the rejection names the specific rule
# rather than merely "not declared", and so one key produces exactly one issue.
_RICH_TEXT_FORBIDDEN_BINDING_FIELDS: Final[frozenset[str]] = frozenset(
    {"metric", "statistic", "resource_id", "scope", "snapshot_path"}
)

type PathSegment = str | int
type Path = tuple[PathSegment, ...]
type ValidationMode = str
"""`"draft"` or `"run"`. A definition carrying zero blocks is a valid draft and an
invalid run (Req 6.8), and nothing else differs between the two."""


# --- Patterns -----------------------------------------------------------------------

_AZURE_GUID_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"\A[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\Z"
)
"""A bare canonically-hyphenated GUID — the shape of an Azure subscription id or
tenant id standing on its own, with no surrounding path."""

_AZURE_RESOURCE_ID_SEGMENT_PATTERN: Final[re.Pattern[str]] = re.compile(
    r"/subscriptions/", re.IGNORECASE
)
"""Every fully qualified Azure resource id, of every provider-path shape, carries
this literal segment, so matching it is sufficient without parsing a path whose
remainder varies by provider. Case-insensitive: Azure resource ids are."""

_LOCAL_DATE_PATTERN: Final[re.Pattern[str]] = re.compile(r"\A\d{4}-\d{2}-\d{2}\Z")

_PERCENTILE_STATISTIC_PATTERN: Final[re.Pattern[str]] = re.compile(r"\Ap[0-9]+\Z")
"""`p` followed only by digits — the same shape `collect/snapshot.py`'s
`_PERCENTILE_KEY_PATTERN` forbids as a bare object key, matched here to decide
whether a metric-selection entry names a percentile and therefore requires both an
estimator label and a fidelity tier (Req 5.7, 5.8). Lowercase `p` only, matching the
collector's own pattern: `P95` is a spelling neither the catalog nor the collector
ever produces."""

_FORBIDDEN_POSITIONING_FIELD_PATTERNS: Final[tuple[tuple[re.Pattern[str], str], ...]] = (
    (re.compile(r"position", re.IGNORECASE), "an absolute position"),
    (re.compile(r"coordinate", re.IGNORECASE), "a coordinate"),
    (re.compile(r"\Aoffset", re.IGNORECASE), "an offset"),
    (re.compile(r"\A(x|y)\Z", re.IGNORECASE), "a coordinate"),
    (
        re.compile(r"absolute.*width|width.*absolute", re.IGNORECASE),
        "an absolute width",
    ),
    (
        re.compile(r"absolute.*height|height.*absolute", re.IGNORECASE),
        "an absolute height",
    ),
    (re.compile(r"page_?assignment", re.IGNORECASE), "an explicit page assignment"),
    (re.compile(r"page_?number", re.IGNORECASE), "an explicit page assignment"),
)
"""Req 6.5 — field-name patterns naming an absolute position, a coordinate, an
offset, an absolute width or height, or an explicit page assignment. A `tuple` of
pairs scanned in declared order, so the label reported for a key matching two
patterns is the same on both sides of the mirror. Matched against every key on a
block object *and* every key inside a block's `config`, because Word is a reflowing
paginated medium and any of these is exactly the free positioning that cannot
survive a page break."""


# --- Issue collection ---------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FieldIssue:
    """One violation, located by field path and by the block it belongs to
    (Req 2.7, 6.11).

    `path` mirrors the segments `app/lib/templates/definition.ts` produces — string
    keys and integer array indices — so the corpus guard of task 5.2 compares two
    lists of the same shape rather than two prose messages.

    `block_id` is the id of the block the violation sits inside, or `None` for a
    violation outside `blocks` entirely (a bad `design.preset`, a missing top-level
    key). It is **tracked during the walk**, not derived from `path` afterwards: the
    corpus guard derives the web half's block id from the path and compares it
    against this field, so a walk that attributed an issue to the wrong block is a
    test failure rather than a tautology.
    """

    path: Path
    message: str
    block_id: str | None = None


def format_path(path: Path) -> str:
    """A field path as `blocks.0.config.metrics`, matching the `path.join(".")` the
    web half uses in its own rejection messages."""
    return ".".join(str(segment) for segment in path)


@dataclass(slots=True)
class _Walk:
    """The one mutable thing a validation pass carries.

    `issues` is the flat sink every check appends to — there is no early return from
    the pass as a whole, which is what makes "one pass reporting every violation"
    (Req 2.7, 6.11) a property of the shape rather than a rule to re-verify after the
    next edit.

    `id_occurrences` and `total_block_count` are the two facts a block walk cannot
    determine locally: whether an id was already used somewhere else in the tree
    (Req 6.7, counting row children) and how many blocks the whole definition carries
    (Req 6.3, likewise).
    """

    issues: list[FieldIssue]
    id_occurrences: dict[str, list[Path]]
    total_block_count: int = 0
    version: int = MIN_SCHEMA_VERSION
    """The resolved `schema_version`, carried on the walk rather than added to
    `_validate_block`, `_validate_leaf_block` and `_validate_row_block`'s signatures.

    The walk state already exists for exactly this — a fact true of the whole document that
    one block's check needs — and threading a parameter through the recursion would put the
    version in three places it is only forwarded from. The web half carries it on
    `BlockWalkState` for the same reason."""
    language: str | None = None
    """`identity.language` where the definition declares a valid one, else `None` — which is
    every v1 definition, where every string id resolves in `en` (Req 15.12)."""

    def add(self, path: Path, message: str, block_id: str | None = None) -> None:
        self.issues.append(FieldIssue(path=path, message=message, block_id=block_id))


# --- Low-level predicates -----------------------------------------------------------


def _utf16_length(value: str) -> int:
    """`value`'s length in UTF-16 code units — what `String.prototype.length`
    measures.

    `len(value)` counts code points, so the two disagree by one for every
    astral-plane character. A 64-code-point block id carrying one emoji is 64 here
    and 65 in the browser, and a bound checked against the wrong count is a rule one
    half enforces and the other does not.
    """
    return len(value.encode("utf-16-le")) // 2


def _is_plain_object(value: object) -> bool:
    """A JSON object. `dict` and nothing else — a `list` is not one, and `None` is
    not one, matching `isPlainObject`'s `typeof === "object" && !== null &&
    !Array.isArray`."""
    return isinstance(value, dict)


def _is_non_empty_string(value: object) -> bool:
    return isinstance(value, str) and len(value) > 0


def _is_finite_integer(value: object) -> bool:
    """An integer, the way JavaScript means one.

    A `bool` is excluded first, because `isinstance(True, int)` is true here and
    `typeof true === "boolean"` there. An integral `float` is **accepted**, because
    JavaScript has one number type and `json.load` renders the same JSON token `1` as
    `int` and `1.0` as `float`; rejecting the latter would make the two halves
    disagree about one document.
    """
    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    if isinstance(value, float):
        return math.isfinite(value) and value.is_integer()
    return False


def _is_boolean(value: object) -> bool:
    return isinstance(value, bool)


def _string_length_in_range(value: str, minimum: int, maximum: int) -> bool:
    length = _utf16_length(value)
    return minimum <= length <= maximum


def _days_in_month(year: int, month: int) -> int:
    if month == 2:
        leap = year % 4 == 0 and (year % 100 != 0 or year % 400 == 0)
        return 29 if leap else 28
    return 30 if month in (4, 6, 9, 11) else 31


def _days_from_civil(year: int, month: int, day: int) -> int:
    """Days since 1970-01-01 for a proleptic Gregorian civil date.

    Howard Hinnant's `days_from_civil`, the same algorithm `period.ts` uses, rather
    than `datetime.date.toordinal`: the web half has no `date` type to lean on, and
    two different day-number bases would give two different `inclusive_local_day_span`
    results for the same pair of dates.
    """
    shifted_year = year - (1 if month <= 2 else 0)
    era = (shifted_year if shifted_year >= 0 else shifted_year - 399) // 400
    year_of_era = shifted_year - era * 400
    day_of_year = (153 * (month + (-3 if month > 2 else 9)) + 2) // 5 + day - 1
    day_of_era = year_of_era * 365 + year_of_era // 4 - year_of_era // 100 + day_of_year
    return era * 146_097 + day_of_era - 719_468


def _parse_civil_date(value: object) -> tuple[int, int, int] | None:
    """`YYYY-MM-DD` to `(year, month, day)`, or `None` for anything that is not a
    calendar date that exists.

    Explicitly **not** `date.fromisoformat`, which since 3.11 also accepts `20260701`
    and week dates — spellings `period.ts`'s `/^\\d{4}-\\d{2}-\\d{2}$/` rejects. The
    day is checked against the month's real length rather than by constructing a
    `date`, so the two halves reject `2026-02-31` for the same reason.
    """
    if not isinstance(value, str) or not _LOCAL_DATE_PATTERN.match(value):
        return None
    year = int(value[0:4])
    month = int(value[5:7])
    day = int(value[8:10])
    if month < 1 or month > 12:
        return None
    if day < 1 or day > _days_in_month(year, month):
        return None
    return (year, month, day)


def is_real_calendar_date(value: object) -> bool:
    """Whether `value` is a `YYYY-MM-DD` calendar date that exists."""
    return _parse_civil_date(value) is not None


def inclusive_local_day_span(start: object, end: object) -> int:
    """The count of local days from `start` to `end` inclusive; `0` when either
    endpoint is not a real date, and negative-or-zero when `end` precedes `start`.

    Returns a number rather than raising, so a validator collecting every violation
    can measure a span it has already reported as malformed without a second control
    flow.
    """
    start_civil = _parse_civil_date(start)
    end_civil = _parse_civil_date(end)
    if start_civil is None or end_civil is None:
        return 0
    return _days_from_civil(*end_civil) - _days_from_civil(*start_civil) + 1


def looks_like_azure_identifier(value: str) -> bool:
    """Whether `value` has the shape of a fully qualified Azure resource identifier,
    a bare subscription id, or a bare tenant id (Req 1.3).

    A scope is expressed as resource *types*, tag filters and resource *groups* —
    categories, never named resources — so anything shaped like an actual identifier
    in one of those fields is exactly the hole this check closes.
    """
    trimmed = value.strip()
    if not trimmed:
        return False
    if _AZURE_GUID_PATTERN.match(trimmed):
        return True
    return _AZURE_RESOURCE_ID_SEGMENT_PATTERN.search(trimmed) is not None


def _azure_identifier_message(path: Path) -> str:
    return (
        f'The value at "{format_path(path)}" looks like a fully qualified Azure '
        f"resource identifier, a subscription identifier, or a tenant identifier. A "
        f"scope is expressed as resource types, tag filters and resource groups — "
        f"never as named resources."
    )


def _forbidden_positioning_label(key: str) -> str | None:
    """The Req 6.5 label for `key`, or `None` if it names nothing forbidden."""
    for pattern, label in _FORBIDDEN_POSITIONING_FIELD_PATTERNS:
        if pattern.search(key):
            return label
    return None


def _positioning_message(key: str, label: str, where: str) -> str:
    return (
        f'The {where} field "{key}" names {label}. No block may carry an absolute '
        f"position, coordinate, offset, absolute width or height, or an explicit "
        f"page assignment — Word is a reflowing paginated medium."
    )


# --- identity (Req 2.10) ------------------------------------------------------------


def _validate_identity(identity: object, path: Path, walk: _Walk) -> None:
    if not _is_plain_object(identity):
        walk.add(path, "identity must be an object.")
        return

    allowed = IDENTITY_KEYS[walk.version]
    for key in identity:
        if key not in allowed:
            walk.add((*path, key), f'Unrecognized identity field "{key}".')

    # Req 15.1 — required at v2. Reported here rather than left to the value check below, so
    # that "you forgot it" and "that is not a language" are two different messages.
    for required in REQUIRED_IDENTITY_KEYS[walk.version]:
        if required not in identity:
            walk.add(
                (*path, required),
                f"identity.{required} is required at schema_version {walk.version}.",
            )

    if "language" in allowed and "language" in identity:
        # Case-sensitive: `EN` is not a spelling of `en`. See LANGUAGES.
        if identity["language"] not in LANGUAGES:
            walk.add(
                (*path, "language"),
                f"identity.language must be exactly one of: {', '.join(LANGUAGES)} "
                f"(case-sensitive).",
            )

    name = identity.get("name")
    if not _is_non_empty_string(name) or not _string_length_in_range(
        name, NAME_MIN_LENGTH, NAME_MAX_LENGTH
    ):
        walk.add(
            (*path, "name"),
            f"identity.name must be a string of {NAME_MIN_LENGTH} to "
            f"{NAME_MAX_LENGTH} characters.",
        )

    if "description" in identity:
        description = identity["description"]
        if (
            not isinstance(description, str)
            or _utf16_length(description) > DESCRIPTION_MAX_LENGTH
        ):
            walk.add(
                (*path, "description"),
                f"identity.description must be a string of at most "
                f"{DESCRIPTION_MAX_LENGTH} characters.",
            )

    if "report_title" in identity:
        report_title = identity["report_title"]
        if (
            not isinstance(report_title, str)
            or _utf16_length(report_title) > REPORT_TITLE_MAX_LENGTH
        ):
            walk.add(
                (*path, "report_title"),
                f"identity.report_title must be a string of at most "
                f"{REPORT_TITLE_MAX_LENGTH} characters.",
            )


# --- scope (Req 1.3, 3.1, 3.2, 3.10) ------------------------------------------------


def _validate_scope_spec(
    scope: object, path: Path, walk: _Walk, block_id: str | None
) -> None:
    """Validate a scope specification — the template default at `scope`, or a block's
    `scope_override` (Req 3.2).

    Every dimension is required to be **present** (an empty list or `None`, never an
    absent key), matching the web half. Requiring presence rather than defaulting is
    what keeps one shape rather than a shape plus a set of implicit defaults this
    reader would have to reproduce exactly.
    """
    if not _is_plain_object(scope):
        walk.add(path, "A scope specification must be an object.", block_id)
        return

    for key in scope:
        if key not in _SCOPE_ALLOWED_KEYS:
            walk.add((*path, key), f'Unrecognized scope field "{key}".', block_id)

    _validate_resource_types(
        scope.get("resource_types"), (*path, "resource_types"), walk, block_id
    )
    _validate_tag_filters(scope.get("tag_filters"), (*path, "tag_filters"), walk, block_id)
    _validate_resource_groups(
        scope.get("resource_groups"), (*path, "resource_groups"), walk, block_id
    )
    _validate_top_n(scope.get("top_n"), (*path, "top_n"), walk, block_id)
    _validate_sort(scope.get("sort"), (*path, "sort"), walk, block_id)


def _is_json_array(value: object) -> bool:
    """A JSON array. `list` only — a `tuple` is not what `json.load` produces, and a
    `str` is emphatically not an array however iterable it is."""
    return isinstance(value, list)


def _validate_resource_types(
    value: object, path: Path, walk: _Walk, block_id: str | None
) -> None:
    if not _is_json_array(value):
        walk.add(path, "resource_types must be an array.", block_id)
        return

    if len(value) > MAX_RESOURCE_TYPES:
        walk.add(
            path,
            f"resource_types accepts at most {MAX_RESOURCE_TYPES} entries.",
            block_id,
        )

    for index, entry in enumerate(value):
        entry_path = (*path, index)
        if not _is_non_empty_string(entry) or not _string_length_in_range(
            entry, 1, RESOURCE_TYPE_MAX_LENGTH
        ):
            walk.add(
                entry_path,
                f"Each resource type must be a string of 1 to "
                f"{RESOURCE_TYPE_MAX_LENGTH} characters.",
                block_id,
            )
            continue
        if looks_like_azure_identifier(entry):
            walk.add(entry_path, _azure_identifier_message(entry_path), block_id)


def _validate_tag_filters(
    value: object, path: Path, walk: _Walk, block_id: str | None
) -> None:
    if not _is_json_array(value):
        walk.add(path, "tag_filters must be an array.", block_id)
        return

    if len(value) > MAX_TAG_FILTERS:
        walk.add(path, f"tag_filters accepts at most {MAX_TAG_FILTERS} entries.", block_id)

    for index, entry in enumerate(value):
        entry_path = (*path, index)
        if not _is_plain_object(entry):
            walk.add(
                entry_path,
                "Each tag filter must be an object of `key` and `value`.",
                block_id,
            )
            continue

        for key in entry:
            if key not in ("key", "value"):
                walk.add(
                    (*entry_path, key),
                    f'Unrecognized tag filter field "{key}".',
                    block_id,
                )

        tag_key = entry.get("key")
        tag_value = entry.get("value")

        if not _is_non_empty_string(tag_key) or not _string_length_in_range(
            tag_key, TAG_KEY_MIN_LENGTH, TAG_KEY_MAX_LENGTH
        ):
            walk.add(
                (*entry_path, "key"),
                f"A tag filter key must be a string of {TAG_KEY_MIN_LENGTH} to "
                f"{TAG_KEY_MAX_LENGTH} characters.",
                block_id,
            )
        elif looks_like_azure_identifier(tag_key):
            walk.add(
                (*entry_path, "key"),
                _azure_identifier_message((*entry_path, "key")),
                block_id,
            )

        if not isinstance(tag_value, str) or _utf16_length(tag_value) > TAG_VALUE_MAX_LENGTH:
            walk.add(
                (*entry_path, "value"),
                f"A tag filter value must be a string of at most "
                f"{TAG_VALUE_MAX_LENGTH} characters.",
                block_id,
            )
        elif looks_like_azure_identifier(tag_value):
            walk.add(
                (*entry_path, "value"),
                _azure_identifier_message((*entry_path, "value")),
                block_id,
            )


def _validate_resource_groups(
    value: object, path: Path, walk: _Walk, block_id: str | None
) -> None:
    if not _is_json_array(value):
        walk.add(path, "resource_groups must be an array.", block_id)
        return

    if len(value) > MAX_RESOURCE_GROUPS:
        walk.add(
            path,
            f"resource_groups accepts at most {MAX_RESOURCE_GROUPS} entries.",
            block_id,
        )

    for index, entry in enumerate(value):
        entry_path = (*path, index)
        if not _is_non_empty_string(entry) or not _string_length_in_range(
            entry, RESOURCE_GROUP_MIN_LENGTH, RESOURCE_GROUP_MAX_LENGTH
        ):
            walk.add(
                entry_path,
                f"Each resource group name must be a string of "
                f"{RESOURCE_GROUP_MIN_LENGTH} to {RESOURCE_GROUP_MAX_LENGTH} "
                f"characters.",
                block_id,
            )
            continue
        if looks_like_azure_identifier(entry):
            walk.add(entry_path, _azure_identifier_message(entry_path), block_id)


def _validate_top_n(value: object, path: Path, walk: _Walk, block_id: str | None) -> None:
    if value is None:
        return
    if not _is_plain_object(value):
        walk.add(path, "top_n must be an object or null.", block_id)
        return

    for key in value:
        if key not in _TOP_N_ALLOWED_KEYS:
            walk.add((*path, key), f'Unrecognized top_n field "{key}".', block_id)

    count = value.get("count")
    if not _is_finite_integer(count) or count < TOP_N_MIN_COUNT or count > TOP_N_MAX_COUNT:
        walk.add(
            (*path, "count"),
            f"top_n.count must be an integer from {TOP_N_MIN_COUNT} to "
            f"{TOP_N_MAX_COUNT}.",
            block_id,
        )

    # Req 3.10 — a top-N without a metric name or without a statistic is a rejection;
    # both are required together, whether or not `count` itself is valid. A ranking
    # with no metric to rank by is not a narrower scope, it is an unanswerable one.
    if not _is_non_empty_string(value.get("metric")):
        walk.add((*path, "metric"), "top_n requires a metric name.", block_id)
    if not _is_non_empty_string(value.get("statistic")):
        walk.add((*path, "statistic"), "top_n requires a statistic.", block_id)


def _validate_sort(value: object, path: Path, walk: _Walk, block_id: str | None) -> None:
    if value is None:
        return
    if not isinstance(value, str) or value not in SORT_DIRECTIONS:
        walk.add(
            path,
            f"sort must be null or one of: {', '.join(SORT_DIRECTIONS)}.",
            block_id,
        )


# --- period (Req 4.1, 4.2) ----------------------------------------------------------


def _validate_period(period: object, path: Path, walk: _Walk) -> None:
    if not _is_plain_object(period):
        walk.add(path, "period must be an object.")
        return

    kind = period.get("kind")
    if not isinstance(kind, str) or kind not in PERIOD_KINDS:
        walk.add(
            (*path, "kind"),
            f"period.kind must be one of: {', '.join(PERIOD_KINDS)}.",
        )
        return

    if kind != "custom":
        for key in period:
            if key != "kind":
                walk.add(
                    (*path, key),
                    f'period.kind "{kind}" carries no field named "{key}".',
                )
        return

    for key in period:
        if key not in ("kind", "start", "end"):
            walk.add((*path, key), f'Unrecognized period field "{key}".')

    start = period.get("start")
    end = period.get("end")
    start_is_valid = is_real_calendar_date(start)
    end_is_valid = is_real_calendar_date(end)

    if not start_is_valid:
        walk.add((*path, "start"), "period.start must be a valid YYYY-MM-DD local date.")
    if not end_is_valid:
        walk.add((*path, "end"), "period.end must be a valid YYYY-MM-DD local date.")

    if start_is_valid and end_is_valid:
        span = inclusive_local_day_span(start, end)
        if span < MIN_PERIOD_LOCAL_DAYS:
            walk.add(path, "period.start must be at or before period.end.")
        elif span > MAX_PERIOD_LOCAL_DAYS:
            walk.add(
                path,
                f"A custom period spans at most {MAX_PERIOD_LOCAL_DAYS} local days; "
                f"this one spans {span}.",
            )


# --- metrics (Req 5.1, 5.7, 5.8) ----------------------------------------------------


def _validate_metric_item(item: object, path: Path, walk: _Walk) -> None:
    if not _is_plain_object(item):
        walk.add(
            path,
            "A metric selection item must be an object, not a bare string — an "
            "object carries a percentile's estimator label and fidelity tier.",
        )
        return

    for key in item:
        if key not in _METRIC_ITEM_ALLOWED_KEYS:
            walk.add((*path, key), f'Unrecognized metric selection field "{key}".')

    has_metric = "metric" in item
    has_derived = "derived" in item

    if has_metric and has_derived:
        walk.add(
            path,
            "A metric selection item names exactly one of `metric` or `derived`, "
            "not both.",
        )
    elif not has_metric and not has_derived:
        walk.add(
            path,
            "A metric selection item must name exactly one of `metric` or `derived`.",
        )

    if has_metric and not _is_non_empty_string(item["metric"]):
        walk.add((*path, "metric"), "metric must be a non-empty string.")
    if has_derived and not _is_non_empty_string(item["derived"]):
        walk.add((*path, "derived"), "derived must be a non-empty string.")

    statistic = item.get("statistic")
    if not _is_non_empty_string(statistic):
        walk.add((*path, "statistic"), "statistic must be a non-empty string.")
        return

    estimator = item.get("estimator")
    fidelity_tier = item.get("fidelity_tier")

    # Req 5.7, 5.8 — a percentile-shaped statistic requires both the catalog's
    # estimator label and its fidelity tier. A percentile computed from hourly
    # buckets runs 20-40 points below the true p95 of the minute samples, so an
    # entry that cannot say how its percentile was produced is not storable.
    if _PERCENTILE_STATISTIC_PATTERN.match(statistic):
        if not _is_non_empty_string(estimator):
            walk.add(
                (*path, "estimator"),
                f'A percentile statistic ("{statistic}") requires the catalog\'s '
                f"estimator label.",
            )
        if not _is_non_empty_string(fidelity_tier):
            walk.add(
                (*path, "fidelity_tier"),
                f'A percentile statistic ("{statistic}") requires its fidelity tier.',
            )
    else:
        if "estimator" in item and not _is_non_empty_string(estimator):
            walk.add(
                (*path, "estimator"),
                "estimator must be a non-empty string when present.",
            )
        if "fidelity_tier" in item and not _is_non_empty_string(fidelity_tier):
            walk.add(
                (*path, "fidelity_tier"),
                "fidelity_tier must be a non-empty string when present.",
            )


def _validate_metrics(metrics: object, path: Path, walk: _Walk) -> None:
    if not _is_plain_object(metrics):
        walk.add(path, "metrics must be an object keyed by resource type.")
        return

    if len(metrics) > MAX_METRIC_RESOURCE_TYPE_ENTRIES:
        walk.add(
            path,
            f"metrics accepts at most {MAX_METRIC_RESOURCE_TYPE_ENTRIES} "
            f"resource-type entries.",
        )

    for resource_type, items in metrics.items():
        entry_path = (*path, resource_type)

        if not _is_json_array(items):
            walk.add(entry_path, f'metrics["{resource_type}"] must be an array.')
            continue

        if (
            len(items) < MIN_METRIC_ITEMS_PER_ENTRY
            or len(items) > MAX_METRIC_ITEMS_PER_ENTRY
        ):
            walk.add(
                entry_path,
                f'metrics["{resource_type}"] must name {MIN_METRIC_ITEMS_PER_ENTRY} '
                f"to {MAX_METRIC_ITEMS_PER_ENTRY} items.",
            )

        for index, item in enumerate(items):
            _validate_metric_item(item, (*entry_path, index), walk)


# --- blocks (Req 6.2 - 6.9) ---------------------------------------------------------


def _config_schema(
    block_type: str,
) -> tuple[
    tuple[str, ...], tuple[str, ...], dict[str, tuple[str, ...]], tuple[str, ...]
]:
    """One declared type's config schema, narrowed out of `BLOCK_CONFIG`'s
    guard-readable literal shape.

    `BLOCK_CONFIG` is annotated `dict[str, dict[str, object]]` deliberately: the
    Mirror_Guard reads it as *text* between sentinels, so it has to stay a plain
    literal rather than becoming a `TypedDict` or a frozen dataclass whose
    construction the guard would then have to parse. This function is where that
    deliberately loose shape is narrowed once, so no caller repeats the widening.

    The fourth element is `non_empty` — the required string fields whose compilers
    demand content. It defaults to an empty tuple, so a type that declares no such
    field reads the same whether it omits the key or spells out `[]`.
    """
    schema = BLOCK_CONFIG[block_type]
    raw_required = schema["required"]
    raw_optional = schema["optional"]
    raw_enums = schema["enums"]
    raw_non_empty = schema.get("non_empty", [])
    assert isinstance(raw_required, list), block_type
    assert isinstance(raw_optional, list), block_type
    assert isinstance(raw_enums, dict), block_type
    assert isinstance(raw_non_empty, list), block_type
    return (
        tuple(str(name) for name in raw_required),
        tuple(str(name) for name in raw_optional),
        {str(key): tuple(str(value) for value in values) for key, values in raw_enums.items()},
        tuple(str(name) for name in raw_non_empty),
    )


def _validate_block_config(
    block_type: str, config: object, path: Path, walk: _Walk, block_id: str | None
) -> None:
    if not _is_plain_object(config):
        walk.add(path, "config must be an object.", block_id)
        return

    required, optional, enums, _non_empty = _config_schema(block_type)
    allowed_field_names = {*required, *optional, *enums}

    for field_name in required:
        if field_name not in config:
            walk.add(
                (*path, field_name),
                f'"{block_type}" requires the config field "{field_name}".',
                block_id,
            )

    for key in config:
        positioning_label = _forbidden_positioning_label(key)
        if positioning_label is not None:
            walk.add(
                (*path, key),
                _positioning_message(key, positioning_label, "config"),
                block_id,
            )
            continue

        if block_type == "rich_text" and key in _RICH_TEXT_FORBIDDEN_BINDING_FIELDS:
            walk.add(
                (*path, key),
                f"rich_text carries static prose and no figure; it may not bind "
                f'"{key}".',
                block_id,
            )
            continue

        if key not in allowed_field_names:
            walk.add(
                (*path, key),
                f'"{block_type}" declares no config field named "{key}".',
                block_id,
            )
            continue

        if key in enums:
            value = config[key]
            if not isinstance(value, str) or value not in enums[key]:
                walk.add(
                    (*path, key),
                    f'"{key}" must be one of: {", ".join(enums[key])}.',
                    block_id,
                )


def _validate_leaf_block(
    block: dict[str, object],
    block_type: str,
    path: Path,
    walk: _Walk,
    block_id: str | None,
) -> None:
    for key in block:
        positioning_label = _forbidden_positioning_label(key)
        if positioning_label is not None:
            walk.add(
                (*path, key),
                _positioning_message(key, positioning_label, "block"),
                block_id,
            )
            continue
        if key not in _LEAF_BLOCK_ALLOWED_KEYS:
            walk.add((*path, key), f'Unrecognized block field "{key}".', block_id)

    # Req 13.2 — at v2 and above the front matter owns the cover, so a `cover` block in
    # `blocks` would emit it twice: once from `front_matter.cover` and once from the block.
    #
    # Rejected rather than ignored, and **named by block id**, because the author put it there
    # deliberately: a silently dropped block is indistinguishable from one that was never
    # configured. The v1 -> v2 migration in the app is what lifts a cover into the front
    # matter; this validator's job is to refuse the state where both carry one.
    #
    # `cover` stays a declared type, so this is about *placement at this version* and not
    # about the type existing — which is what keeps every stored v1 definition compiling.
    if walk.version >= 2 and block_type in FRONT_MATTER_FORBIDDEN_BLOCK_TYPES:
        walk.add(
            (*path, "type"),
            f'Block "{block_id or format_path(path)}" is a "{block_type}" block, which the '
            f"front matter owns at schema_version {walk.version}. Declare it under "
            f"front_matter.{block_type} instead of in blocks.",
            block_id,
        )

    if block_type not in _NON_ROW_BLOCK_TYPE_SET:
        # Req 2.3 — a block whose type is absent from the declared set is rejected by
        # name, and is neither ignored nor dropped. Dropping it would render a
        # document silently missing a section the author configured.
        walk.add(
            (*path, "type"),
            f'"{block_type}" is not a declared block type. Declared types are: '
            f"{', '.join(BLOCK_TYPES)}.",
            block_id,
        )
        # No declared config schema exists for an undeclared type, so the field-name
        # and enum checks have nothing to read; `config`'s own object-ness is still
        # worth reporting, so a caller sees both defects in one pass.
        if "config" in block and not _is_plain_object(block["config"]):
            walk.add((*path, "config"), "config must be an object.", block_id)
    else:
        _validate_block_config(
            block_type, block.get("config"), (*path, "config"), walk, block_id
        )

    if "scope_override" in block:
        _validate_scope_spec(
            block["scope_override"], (*path, "scope_override"), walk, block_id
        )


def _validate_row_block(
    block: dict[str, object], path: Path, walk: _Walk, block_id: str | None
) -> None:
    for key in block:
        if key not in _ROW_BLOCK_ALLOWED_KEYS:
            walk.add((*path, key), f'Unrecognized row field "{key}".', block_id)

    columns = block.get("columns")
    if not _is_json_array(columns):
        walk.add(
            (*path, "columns"), "A row's columns must be an array of arrays.", block_id
        )
        return

    # Req 6.2 — `columns` is a list of lists, so "2 or 3 columns" is this array's own
    # length. There is no separate count field that could disagree with the children
    # it actually holds.
    if len(columns) < MIN_ROW_COLUMNS or len(columns) > MAX_ROW_COLUMNS:
        walk.add(
            (*path, "columns"),
            f"A row must declare {MIN_ROW_COLUMNS} or {MAX_ROW_COLUMNS} columns; "
            f"found {len(columns)}.",
            block_id,
        )

    for column_index, column in enumerate(columns):
        column_path = (*path, "columns", column_index)
        if not _is_json_array(column):
            walk.add(column_path, "Each column must be an array of blocks.", block_id)
            continue
        if len(column) > MAX_CHILDREN_PER_COLUMN:
            walk.add(
                column_path,
                f"A column accepts at most {MAX_CHILDREN_PER_COLUMN} children; "
                f"found {len(column)}.",
                block_id,
            )
        for child_index, child in enumerate(column):
            _validate_block(child, (*column_path, child_index), walk, inside_row=True)


def _validate_block(block: object, path: Path, walk: _Walk, *, inside_row: bool) -> None:
    """Validate one block at `path`, recursing into a `row`'s children.

    The count is incremented **before** the object-ness check, matching the web half:
    a definition of 201 non-objects is over the block bound as well as malformed, and
    reporting only the second would hide the first.

    `inside_row` is `True` for a direct child of a row's column. A grandchild cannot
    be reached through a valid tree, but the input is untrusted, so a `row`-typed
    block is detected at **any** depth rather than only at depth 1 (Req 6.4).
    """
    walk.total_block_count += 1

    if not _is_plain_object(block):
        walk.add(path, "A block must be an object.")
        return

    raw_id = block.get("id")
    block_id: str | None = None
    if _is_non_empty_string(raw_id) and _string_length_in_range(
        raw_id, BLOCK_ID_MIN_LENGTH, BLOCK_ID_MAX_LENGTH
    ):
        block_id = raw_id
        occurrences = walk.id_occurrences.setdefault(raw_id, [])
        if occurrences:
            # Req 6.7 — unique across the whole definition, counting row children. A
            # duplicate id makes the AST's figure paths ambiguous, so the ledger
            # would carry one key for two blocks' figures.
            walk.add(
                (*path, "id"),
                f'Duplicate block id "{raw_id}" — a block id must be unique across '
                f"the whole definition, counting every row's children.",
                block_id,
            )
        occurrences.append(path)
    else:
        walk.add(
            (*path, "id"),
            f"A block id must be a string of {BLOCK_ID_MIN_LENGTH} to "
            f"{BLOCK_ID_MAX_LENGTH} characters.",
        )

    block_type = block.get("type")
    if not isinstance(block_type, str):
        walk.add((*path, "type"), "A block's type must be a string.", block_id)
        return

    if block_type == "row":
        if inside_row:
            named = block_id if block_id is not None else str(path[-1])
            walk.add(
                (*path, "type"),
                f'Block "{named}" is a row nested inside a row. One level of '
                f"nesting only — a row's columns hold no row.",
                block_id,
            )
        _validate_row_block(block, path, walk, block_id)
        return

    _validate_leaf_block(block, block_type, path, walk, block_id)


def _validate_blocks(blocks: object, path: Path, walk: _Walk, mode: str) -> None:
    if not _is_json_array(blocks):
        walk.add(path, "blocks must be an array.")
        return

    # Req 6.8 — zero blocks is a valid draft and an invalid run.
    if mode == "run" and len(blocks) == 0:
        walk.add(
            path,
            "A report run needs at least one block; this definition carries zero. "
            "(A definition with zero blocks is a valid draft, but not a runnable "
            "version.)",
        )

    for index, block in enumerate(blocks):
        _validate_block(block, (*path, index), walk, inside_row=False)

    if walk.total_block_count > MAX_BLOCKS_TOTAL:
        walk.add(
            path,
            f"A definition accepts at most {MAX_BLOCKS_TOTAL} blocks, counting rows "
            f"and their children; this one carries {walk.total_block_count}.",
        )


# --- design (Req 7.1, 7.2) ----------------------------------------------------------


DOCUMENT_NUMBER_PATTERN_MIN_LENGTH: Final[int] = 1
DOCUMENT_NUMBER_PATTERN_MAX_LENGTH: Final[int] = 120

DOCUMENT_NUMBER_PLACEHOLDERS: Final[tuple[str, ...]] = (
    "{template}",
    "{year}",
    "{month}",
    "{run}",
)
"""Req 13.16's closed placeholder set for `document_control.document_number_pattern`.

Closed rather than open, and that is the whole of the no-template-language rule applied one
field down: a pattern is literal characters plus substitutions from **this** list, so there
is no expression to evaluate and nothing that could yield a number without provenance.
"""

DOCUMENT_NUMBER_VARYING_PLACEHOLDERS: Final[frozenset[str]] = frozenset({"{run}"})
"""The placeholders whose value can differ between **two runs of one template over one
resolved period**.

`{template}` is fixed per template; `{year}` and `{month}` come from the resolved period, so
two runs of one template over July 2026 substitute the same values for all three. Only
`{run}` distinguishes them — so a pattern naming none of these produces the *same document
number* for both runs, which makes a document number that is not a number for the document.
"""

_PLACEHOLDER_TOKEN_PATTERN: Final[re.Pattern[str]] = re.compile(r"\{[^{}]*\}")
"""Any `{...}` token, so an **undeclared** placeholder is reported by name rather than
silently treated as a literal. A validator that only looked for the four declared tokens
would accept `{quarter}` as literal text and emit it verbatim into a delivered document."""

_TOC_MIN_LEVEL: Final[int] = 1
_TOC_MAX_LEVEL: Final[int] = 4
"""`toc.max_level`'s bound — the four heading levels `render/themes.py` declares styles for.
A table of contents asking for level 5 would collect headings the themes cannot style."""

_COVER_ALLOWED_KEYS: Final[frozenset[str]] = frozenset(
    {"logo", "contact_block", "subtitle"}
)
_DOCUMENT_CONTROL_ALLOWED_KEYS: Final[frozenset[str]] = frozenset(
    {
        "document_name",
        "document_number_pattern",
        "confidentiality_notice_id",
        "distribution",
        "approvers",
    }
)
_TOC_ALLOWED_KEYS: Final[frozenset[str]] = frozenset({"enabled", "max_level"})

APPROVER_ROLES: Final[tuple[str, ...]] = ("author", "reviewer", "approver", "recipient")
"""Req 13.6's four roles, in the order the signature table presents them.

A closed tuple rather than free text, so the approvers list is four declared slots and not a
list a template can grow — the signature table's row height is a theme style, and a fifth
role would have nowhere to be laid out."""

_APPROVER_ALLOWED_KEYS: Final[frozenset[str]] = frozenset({"role", "name", "title"})

CONTACT_BLOCK_MAX_LENGTH: Final[int] = 500
DOCUMENT_NAME_MAX_LENGTH: Final[int] = 200
DISTRIBUTION_MAX_LENGTH: Final[int] = 500
SUBTITLE_MAX_LENGTH: Final[int] = 200
APPROVER_NAME_MAX_LENGTH: Final[int] = 120
APPROVER_TITLE_MAX_LENGTH: Final[int] = 120


def _validate_front_matter(front_matter: object, path: Path, walk: _Walk) -> None:
    """The `front_matter` section's three subsections and their bounds (Req 13.1, 13.13).

    Every failing field path is reported, and nothing here writes: a v2 definition omitting
    the section, carrying an undeclared key, or violating a bound is rejected with **no
    version row persisted**, which is a property of this function performing no I/O rather
    than a rule the caller has to honour.

    Reached only when the resolved version declares `front_matter` — the caller checks that,
    so a v1 definition carrying the key is reported once, as an undeclared top-level key,
    rather than twice.
    """
    if not _is_plain_object(front_matter):
        walk.add(path, "front_matter must be an object.")
        return

    for key in front_matter:
        if key not in FRONT_MATTER_KEYS:
            walk.add((*path, key), f'Unrecognized front_matter field "{key}".')

    for section in FRONT_MATTER_KEYS:
        if section not in front_matter:
            walk.add(
                (*path, section),
                f"front_matter.{section} is required at schema_version {walk.version}.",
            )

    _validate_cover(front_matter.get("cover"), (*path, "cover"), walk)
    _validate_document_control(
        front_matter.get("document_control"), (*path, "document_control"), walk
    )
    _validate_toc(front_matter.get("toc"), (*path, "toc"), walk)


def _validate_cover(cover: object, path: Path, walk: _Walk) -> None:
    """Req 13.4 — the cover's logo, contact block and subtitle.

    Every field optional: a cover with none of them still emits the report title, the
    subscription's display name and the resolved period, which the compiler derives on its
    own (Req 16.13). There is nothing here a consultant must fill in.
    """
    if cover is None or not _is_plain_object(cover):
        if cover is not None:
            walk.add(path, "front_matter.cover must be an object.")
        return

    for key in cover:
        if key not in _COVER_ALLOWED_KEYS:
            walk.add((*path, key), f'Unrecognized cover field "{key}".')

    _optional_bounded_string(cover, "logo", path, walk, LOGO_MAX_LENGTH)
    _optional_bounded_string(
        cover, "contact_block", path, walk, CONTACT_BLOCK_MAX_LENGTH
    )
    _optional_bounded_string(cover, "subtitle", path, walk, SUBTITLE_MAX_LENGTH)


def _validate_document_control(control: object, path: Path, walk: _Walk) -> None:
    """Req 13.5, 13.6, 13.16 — the document control page."""
    if control is None or not _is_plain_object(control):
        if control is not None:
            walk.add(path, "front_matter.document_control must be an object.")
        return

    for key in control:
        if key not in _DOCUMENT_CONTROL_ALLOWED_KEYS:
            walk.add((*path, key), f'Unrecognized document_control field "{key}".')

    _optional_bounded_string(
        control, "document_name", path, walk, DOCUMENT_NAME_MAX_LENGTH
    )
    _optional_bounded_string(
        control, "distribution", path, walk, DISTRIBUTION_MAX_LENGTH
    )

    if "confidentiality_notice_id" in control:
        notice = control["confidentiality_notice_id"]
        # A **string id**, resolved from the message catalog rather than carried as copy, so
        # the notice appears in the pinned language like every other fixed string. A literal
        # here would be English in an Indonesian document.
        if not _is_non_empty_string(notice) or not notice.startswith("doc."):
            walk.add(
                (*path, "confidentiality_notice_id"),
                "document_control.confidentiality_notice_id must be a `doc.` message "
                "catalog string id, not literal copy.",
            )

    if "document_number_pattern" in control:
        _validate_document_number_pattern(
            control["document_number_pattern"], (*path, "document_number_pattern"), walk
        )

    if "approvers" in control:
        _validate_approvers(control["approvers"], (*path, "approvers"), walk)


def _validate_document_number_pattern(value: object, path: Path, walk: _Walk) -> None:
    """Req 13.16 — literal characters plus the four declared placeholders, and at least one
    that varies between runs.

    Three refusals, and the third is the one worth explaining:

    * not a string of 1 to 120 characters;
    * naming a `{...}` token outside :data:`DOCUMENT_NUMBER_PLACEHOLDERS` — reported **by
      name**, because a validator that only looked for the declared four would accept
      `{quarter}` as literal text and emit it verbatim into a delivered document;
    * naming **no** placeholder whose value differs between two runs of one template over one
      resolved period. `{template}`, `{year}` and `{month}` are all fixed across such a pair,
      so a pattern using only those gives both runs the *same* document number — which makes
      it not a number for the document. Only `{run}` distinguishes them.
    """
    if not isinstance(value, str) or not (
        DOCUMENT_NUMBER_PATTERN_MIN_LENGTH
        <= _utf16_length(value)
        <= DOCUMENT_NUMBER_PATTERN_MAX_LENGTH
    ):
        walk.add(
            path,
            f"document_number_pattern must be a string of "
            f"{DOCUMENT_NUMBER_PATTERN_MIN_LENGTH} to "
            f"{DOCUMENT_NUMBER_PATTERN_MAX_LENGTH} characters.",
        )
        return

    found = _PLACEHOLDER_TOKEN_PATTERN.findall(value)
    undeclared = [token for token in found if token not in DOCUMENT_NUMBER_PLACEHOLDERS]
    if undeclared:
        walk.add(
            path,
            f"document_number_pattern names undeclared placeholder(s) "
            f"{', '.join(sorted(set(undeclared)))}; the declared set is "
            f"{', '.join(DOCUMENT_NUMBER_PLACEHOLDERS)}.",
        )

    if not any(token in DOCUMENT_NUMBER_VARYING_PLACEHOLDERS for token in found):
        walk.add(
            path,
            f"document_number_pattern names no placeholder whose value differs between two "
            f"runs of one template over one resolved period, so both runs would carry the "
            f"same document number. Include one of: "
            f"{', '.join(sorted(DOCUMENT_NUMBER_VARYING_PLACEHOLDERS))}.",
        )


def _validate_approvers(approvers: object, path: Path, walk: _Walk) -> None:
    """Req 13.6 — the four-role approvers list.

    At most one entry per role and no undeclared role. A repeated role would put two names in
    one signature row, and the row height is a theme style rather than something that grows.
    """
    if not isinstance(approvers, list):
        walk.add(path, "document_control.approvers must be an array.")
        return

    if len(approvers) > len(APPROVER_ROLES):
        walk.add(
            path,
            f"document_control.approvers accepts at most {len(APPROVER_ROLES)} entries, "
            f"one per declared role; found {len(approvers)}.",
        )

    seen: set[str] = set()
    for index, entry in enumerate(approvers):
        at = (*path, index)
        if not _is_plain_object(entry):
            walk.add(at, "Each approver must be an object.")
            continue

        for key in entry:
            if key not in _APPROVER_ALLOWED_KEYS:
                walk.add((*at, key), f'Unrecognized approver field "{key}".')

        role = entry.get("role")
        if not isinstance(role, str) or role not in APPROVER_ROLES:
            walk.add(
                (*at, "role"),
                f"approver.role must be one of: {', '.join(APPROVER_ROLES)}.",
            )
        elif role in seen:
            walk.add((*at, "role"), f'Duplicate approver role "{role}".')
        else:
            seen.add(role)

        _optional_bounded_string(entry, "name", at, walk, APPROVER_NAME_MAX_LENGTH)
        _optional_bounded_string(entry, "title", at, walk, APPROVER_TITLE_MAX_LENGTH)


def _validate_toc(toc: object, path: Path, walk: _Walk) -> None:
    """Req 13.9 — `enabled` and `max_level`.

    `front_matter.toc` is retained in the definition even where the image ships no table of
    contents, exactly as a disabled cover is retained: the definition records what the author
    asked for, and what the renderer can deliver is a property of the image rather than of the
    template.
    """
    if toc is None or not _is_plain_object(toc):
        if toc is not None:
            walk.add(path, "front_matter.toc must be an object.")
        return

    for key in toc:
        if key not in _TOC_ALLOWED_KEYS:
            walk.add((*path, key), f'Unrecognized toc field "{key}".')

    if "enabled" in toc and not _is_boolean(toc["enabled"]):
        walk.add((*path, "enabled"), "toc.enabled must be a boolean.")

    if "max_level" in toc:
        level = toc["max_level"]
        if (
            not _is_finite_integer(level)
            or level < _TOC_MIN_LEVEL
            or level > _TOC_MAX_LEVEL
        ):
            walk.add(
                (*path, "max_level"),
                f"toc.max_level must be an integer from {_TOC_MIN_LEVEL} to "
                f"{_TOC_MAX_LEVEL}.",
            )


def _optional_bounded_string(
    holder: dict[str, object],
    key: str,
    path: Path,
    walk: _Walk,
    maximum: int,
) -> None:
    """One optional string field with a length bound, measured in UTF-16 code units.

    Absent is fine; present-and-wrong is reported. `_utf16_length` rather than `len` for the
    reason that function's own docstring gives: a bound checked against code points is a rule
    the browser and this compiler enforce differently.
    """
    if key not in holder:
        return
    value = holder[key]
    if value is None:
        return
    if not isinstance(value, str) or _utf16_length(value) > maximum:
        walk.add(
            (*path, key),
            f"{key} must be null or a string of at most {maximum} characters.",
        )


def resolved_schema_version(value: object) -> int:
    """Which key tables a definition's `schema_version` selects, for a value that may not be
    usable. See :func:`collect_definition_issues` on why this is not a default.

    Public because the **compiler** reads it too: `compile/blocks/__init__.py` dispatches the
    `cover` block on it (Req 13.2), and a second resolution rule there could disagree with
    this one — admitting a definition at one version and compiling it at another. One
    function, two callers.
    """
    if _is_finite_integer(value) and value in REQUIRED_TOP_LEVEL_KEYS:
        return int(value)
    return MIN_SCHEMA_VERSION


def _declared_language(raw: object) -> str | None:
    """The `identity.language` a definition pins, or `None` when it declares none — which is
    every v1 definition, where every string id resolves in `en` (Req 15.12).

    Read for the separator resolution below and, later, to pick the message catalog's
    language. An unrecognised value reads as `None` here and is reported as an issue by
    `_validate_identity`; resolving separators from a language nobody accepts would add a
    second, less informative issue about the same root cause.
    """
    if not _is_plain_object(raw):
        return None
    identity = raw.get("identity")
    if not _is_plain_object(identity):
        return None
    language = identity.get("language")
    return language if language in LANGUAGES else None


def _resolved_separators(
    number_format: object, language: str | None
) -> tuple[object, object]:
    """The `(decimal_separator, grouping_separator)` pair a definition **resolves to**:
    whatever it declares, with anything **absent** filled from the language (Req 16.3).

    `language` of `None` resolves from `en`, which is `compile/format.DEFAULT_NUMBER_FORMAT`'s
    pair — so a v1 definition, which declares no language and no separators, resolves to
    exactly what it has always rendered with.

    Reads and returns; writes nothing back. A declared value stays declared and an undeclared
    one stays undeclared, because "absent" and "equal to the language default" have to remain
    two different stored definitions or migrating one rewrites an immutable row.

    **Absent, not unusable.** The key being present is what makes a value declared, so a
    `decimal_separator` of `null` or `1` is returned as it stands and reported by
    `_separator_problem` — it is not quietly replaced with the language default. Defaulting an
    unusable declaration would accept a definition that says one thing and render a document
    that says another, and it would put this half on the *looser* side of the mirror:
    `app/lib/templates/definition.ts`'s `resolveSeparators` defaults on `=== undefined` alone,
    which for a `JSON.parse`d definition means exactly "the key is absent".

    Hence the `object` return type rather than `str`, and hence `in` rather than `.get()`: in
    Python a missing key and a JSON `null` both read as `None`, so `.get()` cannot tell the two
    apart and would default the one TypeScript reports.
    """
    decimal_default, grouping_default = SEPARATOR_DEFAULTS[language or LANGUAGES[0]]
    if not _is_plain_object(number_format):
        return decimal_default, grouping_default

    return (
        number_format["decimal_separator"]
        if "decimal_separator" in number_format
        else decimal_default,
        number_format["grouping_separator"]
        if "grouping_separator" in number_format
        else grouping_default,
    )


def _separator_problem(value: object) -> str | None:
    """Why `value` is not a usable separator, or `None` (Req 16.2).

    Mirrors `app/lib/templates/definition.ts`'s `separatorProblem` message for message, and
    both mirror `compile/format.NumberFormat.__post_init__`'s clauses — with one deliberate
    asymmetry recorded in both halves: that constructor accepts a **non-empty** string of any
    length, and both validators reject anything but exactly one character. The asymmetry errs
    the safe way — the app and this validator refuse a two-character separator the constructor
    would have accepted, so it never reaches a run.

    Whitespace is refused because `verify/tokens.numeric_tokens` splits a paragraph on it, so a
    whitespace-separated numeral reaches the verifier as several tokens none of which equals the
    ledger's formatted string, and `normalize_pdf_text` collapses every whitespace run to one
    space — neither pass can locate it, and the run is withheld for a number that was right.
    """
    if not isinstance(value, str) or not value:
        return "must be a non-empty string"
    if len(value) != 1:
        return "must be exactly one character"
    # `in "0123456789"` and **not** `str.isdigit()`, and the direction of the difference is
    # the whole reason. `isdigit()` is true for `²` and for every Unicode decimal digit; the
    # app's mirror uses `/[0-9]/u`, which is not. Using `isdigit()` here would make the agent
    # *stricter* than the app, so the wizard would save a separator this compiler then
    # refuses — a save-time error turned into a failed run, which is the one divergence
    # direction the mirror exists to prevent. Where the two must differ, the app has to be
    # the stricter half.
    if value in "0123456789":
        return (
            "must not be a digit — a separator that reads as part of the number makes the "
            "verifier's token extraction ambiguous"
        )
    if value == "-":
        return (
            "must not be a minus sign — a separator that reads as part of the number makes "
            "the verifier's token extraction ambiguous"
        )
    if value.isspace():
        return (
            "must not be whitespace — the verifier splits a paragraph on whitespace, so a "
            "whitespace-separated numeral reaches it as several tokens and the run would be "
            "withheld for a correct number"
        )
    return None


def _validate_number_format(value: object, path: Path, walk: _Walk) -> None:
    if not _is_plain_object(value):
        walk.add(path, "number_format must be an object.")
        return

    allowed = NUMBER_FORMAT_KEYS[walk.version]
    for key in value:
        if key not in allowed:
            walk.add((*path, key), f'Unrecognized number_format field "{key}".')

    # Req 16.2 — checked on the **resolved** pair, not the declared one.
    #
    # Resolved, because the constraint is about what the renderer will emit: a definition
    # declaring only a decimal separator still renders a grouping one, and a pair that
    # collides after defaulting collides in the document. At v1 nothing is declarable and the
    # resolution is `en`'s `.` and `,`, which passes every clause — so this adds no failure to
    # any stored v1 definition.
    decimal_separator, grouping_separator = _resolved_separators(value, walk.language)
    for key, separator in (
        ("decimal_separator", decimal_separator),
        ("grouping_separator", grouping_separator),
    ):
        # Only report on a key this version admits: at v1 an undeclared separator resolves to
        # a legal default, and a *declared* one has already been reported as unrecognized
        # above — a second issue about its characters would be noise about a field that may
        # not exist.
        if key not in allowed:
            continue
        problem = _separator_problem(separator)
        if problem is not None:
            walk.add((*path, key), f"number_format.{key} {problem}.")

    if decimal_separator == grouping_separator and "decimal_separator" in allowed:
        walk.add(
            (*path, "decimal_separator"),
            f"number_format's decimal and grouping separators are both "
            f'"{decimal_separator}"; a reader could not tell one from the other.',
        )

    decimal_places = value.get("decimal_places")
    if (
        not _is_finite_integer(decimal_places)
        or decimal_places < MIN_DECIMAL_PLACES
        or decimal_places > MAX_DECIMAL_PLACES
    ):
        walk.add(
            (*path, "decimal_places"),
            f"decimal_places must be an integer from {MIN_DECIMAL_PLACES} to "
            f"{MAX_DECIMAL_PLACES}.",
        )

    if not _is_boolean(value.get("group_thousands")):
        walk.add((*path, "group_thousands"), "group_thousands must be a boolean.")


def _validate_design(design: object, path: Path, walk: _Walk) -> None:
    if not _is_plain_object(design):
        walk.add(path, "design must be an object.")
        return

    for key in design:
        if key not in _DESIGN_ALLOWED_KEYS:
            walk.add((*path, key), f'Unrecognized design field "{key}".')

    preset = design.get("preset")
    if not isinstance(preset, str) or preset not in DESIGN_PRESETS:
        walk.add(
            (*path, "preset"), f"preset must be one of: {', '.join(DESIGN_PRESETS)}."
        )

    accent_color = design.get("accent_color")
    if (
        not _is_non_empty_string(accent_color)
        or _utf16_length(accent_color) > ACCENT_COLOR_MAX_LENGTH
    ):
        walk.add(
            (*path, "accent_color"),
            f"accent_color must be a non-empty string of at most "
            f"{ACCENT_COLOR_MAX_LENGTH} characters.",
        )

    density = design.get("density")
    if not isinstance(density, str) or density not in DENSITY_VALUES:
        walk.add(
            (*path, "density"), f"density must be one of: {', '.join(DENSITY_VALUES)}."
        )

    table_style = design.get("table_style")
    if not isinstance(table_style, str) or table_style not in TABLE_STYLE_VALUES:
        walk.add(
            (*path, "table_style"),
            f"table_style must be one of: {', '.join(TABLE_STYLE_VALUES)}.",
        )

    _validate_number_format(design.get("number_format"), (*path, "number_format"), walk)

    if not _is_boolean(design.get("cover_page")):
        walk.add((*path, "cover_page"), "cover_page must be a boolean.")

    if "logo" in design and design["logo"] is not None:
        logo = design["logo"]
        if not isinstance(logo, str) or _utf16_length(logo) > LOGO_MAX_LENGTH:
            walk.add(
                (*path, "logo"),
                f"logo must be null or a string of at most {LOGO_MAX_LENGTH} "
                f"characters.",
            )

    page_size = design.get("page_size")
    if not isinstance(page_size, str) or page_size not in PAGE_SIZE_VALUES:
        walk.add(
            (*path, "page_size"),
            f"page_size must be one of: {', '.join(PAGE_SIZE_VALUES)}.",
        )


# --- schema_version and the canonical byte bound (Req 2.9, 2.10) --------------------


def _validate_schema_version(value: object, walk: _Walk) -> None:
    if not _is_finite_integer(value):
        walk.add(("schema_version",), "schema_version must be an integer.")
        return
    if value < MIN_SCHEMA_VERSION or value > MAX_SUPPORTED_SCHEMA_VERSION:
        walk.add(
            ("schema_version",),
            f"schema_version must be between {MIN_SCHEMA_VERSION} and "
            f"{MAX_SUPPORTED_SCHEMA_VERSION} (highest supported); found {value}.",
        )


def canonical_bytes(definition: object) -> bytes:
    """`definition`'s RFC 8785 (JCS) canonical form.

    The same canonicalization `collect/snapshot.py` uses for `snapshot_id` and the
    same one `app/lib/templates/canonical-json.ts` implements, so the digest below
    equals the app's `definition_sha256` for every definition both halves accept
    (Req 9.4). Mutates nothing, and applies **no Unicode normalization**: two key
    spellings differing only by NFC against NFD are two different definitions, and
    normalizing would collapse them onto one content address.
    """
    return rfc8785.dumps(definition)


def canonical_digest(definition: object) -> str:
    """SHA-256 over :func:`canonical_bytes`, as 64 lowercase hexadecimal characters
    (Req 9.4) — the agent-side twin of `lib/templates/version.ts`'s
    `definitionSha256`. Task 5.2's corpus asserts the two agree for every fixture,
    which is the cross-language half of Property 11."""
    return hashlib.sha256(canonical_bytes(definition)).hexdigest()


def _validate_canonical_byte_size(raw: object, walk: _Walk) -> None:
    """Req 2.10 — at most 262,144 bytes of UTF-8 **in RFC 8785 canonical form**, not
    in whatever byte count a default serializer happens to produce.

    A value with no canonical form has already produced a type-mismatch issue
    somewhere else in this walk, so the failure is swallowed rather than reported a
    second, less informative time — matching the web half's `try`/`catch` around the
    same check.
    """
    try:
        size = len(canonical_bytes(raw))
    except (TypeError, ValueError, rfc8785.CanonicalizationError):
        return
    if size > MAX_DEFINITION_CANONICAL_BYTES:
        walk.add(
            (),
            f"The definition's RFC 8785 canonical form is {size} bytes, exceeding "
            f"the {MAX_DEFINITION_CANONICAL_BYTES}-byte bound.",
        )


# --- Req 5.9: every scoped resource type carries a metric selection -----------------


def _validate_every_scoped_type_is_selected(
    raw: dict[str, object], walk: _Walk, mode: str
) -> None:
    """Req 5.9 — a resource type a scope can contain, with no metric selected for it.

    A **cross-field** check on the definition alone: every resource type named in the
    template default `scope` or in any block `scope_override` needs an entry in `metrics`.
    No catalog, no snapshot, no subscription — which is why it belongs in this module's
    shape pass, where Req 2.6's both-halves-agree guarantee applies for free, rather than
    beside the catalog-membership checks.

    **Compared case-insensitively** (Req 3.12). Azure resource type names are
    case-insensitive and Resource Graph lowercases `type` in its response body, so a
    `metrics` key of `microsoft.compute/virtualmachines` selects for a scope naming
    `Microsoft.Compute/virtualMachines`. An exact comparison here would reject a
    definition that is entirely correct — and it would reject exactly the definition an
    inventory-seeded wizard affordance produces.

    ## Only in `run` mode, and that is the requirement rather than a relaxation

    Req 5.9 rejects **a save that persists a version row**. A draft persists none: it is
    written to `report_templates.draft_definition`, and the wizard reaches scope (step 2)
    two steps before metrics (step 4), so enforcing this against a draft would refuse to
    save the ordinary half-authored template between those two steps. Publishing a version
    is where the definition has to be complete, and that is `run` mode — the same mode that
    rejects zero blocks, for the same reason.

    ## What it deliberately cannot see

    A scope naming **no** resource types is unconstrained (Req 3.1 permits zero, Req 3.12
    makes an empty dimension match everything), so which types it can contain is a fact
    about the subscription rather than about the definition. No save-time or enqueue-time
    check can decide it, and `TEMPLATE_INVALID` would be the wrong verdict anyway: a
    subscription-agnostic template (Req 1) pointed at a subscription holding a type it did
    not select is an ordinary pairing, not a broken template. That case is recorded at
    collection time as a `metric_not_selected` gap instead — see `collect/log.py`.

    The issue is reported **at the scope location naming the type**, once per location,
    carrying that location's block id when it is an override. Reporting it at `metrics`
    would name the type in the message and leave the author hunting for which of eight
    blocks introduced it.
    """
    if mode != "run":
        return

    metrics = raw.get("metrics")
    if not _is_plain_object(metrics):
        # Its shape is already an issue; a second one derived from it would be noise.
        return

    selected = {
        resource_type.casefold()
        for resource_type in metrics
        if isinstance(resource_type, str)
    }

    for path, block_id, resource_type in _scoped_resource_types(raw):
        if resource_type.casefold() in selected:
            continue
        walk.add(
            path,
            f'No metric or derived statistic is selected for "{resource_type}", which '
            f"this scope can contain. Every resource type a scope names needs an entry "
            f"in `metrics`, or the report would collect nothing for it.",
            block_id,
        )


def _scoped_resource_types(
    raw: dict[str, object],
) -> list[tuple[Path, str | None, str]]:
    """Every resource type named by a scope, with its field path and owning block id.

    Reads defensively at every level and contributes nothing for a malformed scope: the
    shape validators above have already reported it, and inventing a resource type out of a
    non-string would report a second issue about the first one's symptom.
    """
    found: list[tuple[Path, str | None, str]] = []

    def add_scope(scope: object, path: Path, block_id: str | None) -> None:
        if not _is_plain_object(scope):
            return
        types = scope.get("resource_types")
        if not _is_json_array(types):
            return
        for index, entry in enumerate(types):
            if _is_non_empty_string(entry):
                found.append(((*path, "resource_types", index), block_id, entry))

    def walk_blocks(blocks: object, path: Path) -> None:
        if not _is_json_array(blocks):
            return
        for index, block in enumerate(blocks):
            if not _is_plain_object(block):
                continue
            block_path = (*path, index)
            raw_id = block.get("id")
            block_id = raw_id if isinstance(raw_id, str) else None
            if "scope_override" in block:
                add_scope(
                    block["scope_override"],
                    (*block_path, "scope_override"),
                    block_id,
                )
            columns = block.get("columns")
            if _is_json_array(columns):
                for column_index, column in enumerate(columns):
                    walk_blocks(column, (*block_path, "columns", column_index))

    add_scope(raw.get("scope"), ("scope",), None)
    walk_blocks(raw.get("blocks"), ("blocks",))
    return found


def _validate_required_config_is_filled(
    raw: dict[str, object], walk: _Walk, mode: str
) -> None:
    """A required config field that is present but carries nothing (Req 2.8).

    `BLOCK_CONFIG[type]["required"]` is checked for **presence** by
    `_validate_block_config`, and presence is all a draft can be held to. But a
    `"metrics": []` is present, so it satisfies that check, passes the wizard's save,
    passes `assert_valid_pinned_definition` before a single Azure call is made — and
    then raises `CompileFailedError` inside the block compiler, four minutes of
    inventory and metrics later. Worse, `_phase_one` stops at the first bad block, so
    a template with three unfilled blocks costs three full collections to diagnose,
    one block per run. That is not hypothetical: it is how this check came to exist.

    ## Only in `run` mode, and that is the requirement rather than a relaxation

    The same reasoning as `_validate_every_scoped_type_is_selected` directly above.
    The composer inserts a block with its config placeholders empty — a `top_n_table`
    arrives as `{"columns": [], "order_by": ""}` — because the author has not reached
    the inspector yet. Enforcing this against a draft would refuse to save in the gap
    between dropping a block on the canvas and configuring it, which is every template
    that was ever authored. Publishing a version is where the definition has to be
    complete.

    ## Why the rule is generic rather than per-compiler

    Empty array, empty object, blank string — and nothing about what any particular
    block wants. `read_capacity_ref` knows which SKU capabilities the snapshot records
    and `read_metric_refs` knows what a metric reference looks like; restating either
    here would create a third source of truth to drift from the other two, which is the
    exact defect this function exists to close. This enforces only the part every one of
    those compilers' refusals has in common.

    Reported at the field's own path, so the wizard can mark the offending block rather
    than the author hunting for which of eight blocks is unfilled.
    """
    if mode != "run":
        return

    for path, block_id, block_type, field_name in _empty_required_config_fields(raw):
        walk.add(
            path,
            f'"{block_type}" requires the config field "{field_name}" to carry a '
            f"value; it is present but empty. A block with no metric has nothing to "
            f"show, an empty table reads as an empty scope — which means something "
            f"else entirely to a reader — and a blank string in a field whose "
            f"compiler demands content fails the run minutes after the save looked "
            f"clean.",
            block_id,
        )


def _is_empty_container(value: object) -> bool:
    """Whether a present config value is a **collection** that selected nothing.

    An empty array is an unfilled multi-select and an empty object is a reference
    whose sub-fields were never chosen. Both mean the same thing in every block that
    has one — nothing was picked — which is what lets this be decided without knowing
    which block is asking.

    ## Strings are deliberately excluded, and that is the whole boundary

    An empty string's meaning is a fact about the individual field, not about
    emptiness. `heading.text: ""` is a legitimately blank heading and the definition
    generators emit it as a *valid* case; `comparison_delta.run_a: ""` is genuinely
    unfinished. Telling those apart needs per-field knowledge, and encoding per-field
    knowledge here would make this a third authority on block configuration to drift
    from `BLOCK_CONFIG` and from the block compilers — the exact defect the caller
    exists to close. So this refuses only what is unambiguous.

    **Where the per-field knowledge actually lives.** `BLOCK_CONFIG`'s `non_empty`
    names the required string fields whose compilers demand content, and the caller
    consults it alongside this function. That keeps this rule's boundary exactly where
    this docstring puts it while still catching `rich_text.text: ""` — which used to
    save cleanly and fail the run at `compile_rich_text`, minutes later, with the
    author long gone. `heading.text: ""` is not in any `non_empty` list and is still
    accepted, which the corpus pins as a fixture rather than leaving to this comment.

    `0` and `False` are not empty either: they are values, and a numeric config field
    legitimately holding zero must not be refused.
    """
    return isinstance(value, (list, tuple, dict)) and len(value) == 0


def _empty_required_config_fields(
    raw: dict[str, object],
) -> list[tuple[Path, str | None, str, str]]:
    """Every present-but-empty required config field, with its path and owning block.

    Reads defensively at every level and contributes nothing for a malformed block: the
    shape validators above have already reported it, and a second issue derived from the
    first one's symptom is noise. An undeclared block type has no config schema to read,
    so it is skipped here and reported by `_validate_leaf_block`.
    """
    found: list[tuple[Path, str | None, str, str]] = []

    def walk_blocks(blocks: object, path: Path) -> None:
        if not _is_json_array(blocks):
            return
        for index, block in enumerate(blocks):
            if not _is_plain_object(block):
                continue
            block_path = (*path, index)
            raw_id = block.get("id")
            block_id = raw_id if isinstance(raw_id, str) else None

            block_type = block.get("type")
            if isinstance(block_type, str) and block_type in _NON_ROW_BLOCK_TYPE_SET:
                config = block.get("config")
                if _is_plain_object(config):
                    required, _optional, _enums, non_empty = _config_schema(
                        block_type
                    )
                    for field_name in required:
                        if field_name not in config:
                            continue
                        value = config[field_name]
                        # Two kinds of empty, deliberately kept apart. A container that
                        # selected nothing is unambiguous in every block that has one.
                        # A blank string is only empty where `BLOCK_CONFIG` says the
                        # field's compiler demands content — `heading.text: ""` is a
                        # valid blank heading and stays accepted.
                        if _is_empty_container(value) or (
                            field_name in non_empty and value == ""
                        ):
                            found.append(
                                (
                                    (*block_path, "config", field_name),
                                    block_id,
                                    block_type,
                                    field_name,
                                )
                            )

            columns = block.get("columns")
            if _is_json_array(columns):
                for column_index, column in enumerate(columns):
                    walk_blocks(column, (*block_path, "columns", column_index))

    walk_blocks(raw.get("blocks"), ("blocks",))
    return found


# --- the pass -----------------------------------------------------------------------


def collect_definition_issues(raw: object, *, mode: str = "draft") -> list[FieldIssue]:
    """Every violation in `raw`, in one pass (Req 2.7, 6.11).

    Reaches the same verdict as `app/lib/templates/definition.ts`'s
    `collectDefinitionIssues` for every rule (Req 2.6): the seven required top-level
    keys, undeclared keys and block types rejected **by name**, the layout grammar,
    one level of nesting, duplicate ids across row children, `rich_text` binding
    nothing, the absence of any positioning field, the size and count bounds, and
    `schema_version` bounds with no default applied.

    `mode="run"` additionally rejects a definition carrying zero blocks (Req 6.8).
    Nothing else differs between the two modes, and nothing here writes, reads or
    mutates anything: the return value is the whole output.
    """
    walk = _Walk(issues=[], id_occurrences={})

    if not _is_plain_object(raw):
        walk.add((), "A template definition must be an object.")
        return walk.issues

    # Resolved once and read by every check below.
    #
    # `resolved_schema_version` falls back to the **narrower** version-1 tables for a version
    # this reader cannot use rather than stopping the walk, so Req 2.7's "every failing field
    # path in one pass" survives a broken version — and the broken version is itself still
    # reported by `_validate_schema_version`. This applies no default to the *definition*: it
    # decides which of two key tables the remaining checks consult, nothing more.
    walk.version = resolved_schema_version(raw.get("schema_version"))
    walk.language = _declared_language(raw)

    required_keys = REQUIRED_TOP_LEVEL_KEYS[walk.version]
    for key in required_keys:
        if key not in raw:
            walk.add((key,), f'Missing required top-level key "{key}".')

    # Req 2.4 — an undeclared key is rejected **by name**, never stripped. A stripping
    # validator turns a misspelled field into a definition that saves cleanly and
    # compiles into a document missing whatever the author meant to configure.
    for key in raw:
        if key not in required_keys:
            walk.add((key,), f'Unrecognized top-level key "{key}".')

    _validate_schema_version(raw.get("schema_version"), walk)
    _validate_identity(raw.get("identity"), ("identity",), walk)
    if "front_matter" in required_keys:
        _validate_front_matter(raw.get("front_matter"), ("front_matter",), walk)
    _validate_scope_spec(raw.get("scope"), ("scope",), walk, None)
    _validate_period(raw.get("period"), ("period",), walk)
    _validate_metrics(raw.get("metrics"), ("metrics",), walk)
    _validate_blocks(raw.get("blocks"), ("blocks",), walk, mode)
    _validate_design(raw.get("design"), ("design",), walk)
    _validate_canonical_byte_size(raw, walk)
    _validate_every_scoped_type_is_selected(raw, walk, mode)
    _validate_required_config_is_filled(raw, walk, mode)

    return walk.issues


def assert_valid_pinned_definition(raw: object, *, mode: str = "run") -> dict[str, object]:
    """Return `raw` unchanged, or raise the terminal `TEMPLATE_INVALID` naming every
    failing path (Req 2.8).

    The compile stage's entry point. A **pinned** template version failing validation
    here means the two validators have drifted — the wizard saved something this
    compiler cannot compile — so the run ends before any figure is compiled: no
    document is rendered and no artifact is written. Deferring the failure would
    spend inventory and metrics on a definition that was never compilable.

    `mode` defaults to `"run"` because a pinned version is by definition about to be
    run; a zero-block draft is not something a run can render.
    """
    issues = collect_definition_issues(raw, mode=mode)
    if issues:
        detail = "; ".join(
            f"{format_path(issue.path) or '<root>'}: {issue.message}" for issue in issues
        )
        raise TemplateInvalidError(
            f"the pinned template version failed validation with {len(issues)} "
            f"violation(s): {detail}"
        )
    assert isinstance(raw, dict)  # narrowed: a non-object produces an issue above
    return raw
