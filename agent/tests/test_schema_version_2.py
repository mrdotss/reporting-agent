"""`schema_version` 2 — the version-conditional key tables, `front_matter`, and the one
dispatch in the compiler (Req 13.1, 13.2, 13.10, 13.11, 13.13, 13.16, 15.1, 16.1).

Three things this module is deliberately *not*:

**Not the cross-language corpus.** `tests/fixtures/definitions/` and
`tests/test_definition_corpus.py` are the Mirror_Guard's behavioural half, extended with
version 1 and 2 cases by task 7.3. Until then the agent validates `front_matter`'s per-field
bounds and `app/lib/templates/definition.ts` does not, so a rejecting front-matter fixture in
the shared corpus would fail the comparison for the right reason at the wrong time. The
asymmetry is recorded in that file, at the call site that skips the section.

**Not a migration test.** There is no migration in the agent and none is needed: a stored v1
row is compiled as v1 for as long as it exists, which is what makes an archived report
reproducible from its pinned version. :func:`test_compiling_mutates_no_definition` is the
assertion that stands in for the absence.

**Not a second validator.** Every check here goes through `collect_definition_issues`, the one
walk, so a rule asserted here is the rule the pipeline's gate applies.
"""

from __future__ import annotations

import copy
from typing import Any

import pytest

import definition_factory as df
import snapshot_factory as sf
from reporting_agent.compile.ast import Paragraph
from reporting_agent.compile.blocks import FRONT_MATTER_SCHEMA_VERSION, compile_document
from reporting_agent.compile.definition import (
    APPROVER_NAME_MAX_LENGTH,
    APPROVER_ROLES,
    APPROVER_TITLE_MAX_LENGTH,
    CONTACT_BLOCK_MAX_LENGTH,
    DISTRIBUTION_MAX_LENGTH,
    DOCUMENT_NAME_MAX_LENGTH,
    DOCUMENT_NUMBER_PATTERN_MAX_LENGTH,
    DOCUMENT_NUMBER_PLACEHOLDERS,
    DOCUMENT_NUMBER_VARYING_PLACEHOLDERS,
    FRONT_MATTER_FORBIDDEN_BLOCK_TYPES,
    FRONT_MATTER_KEYS,
    IDENTITY_KEYS,
    LANGUAGES,
    LOGO_MAX_LENGTH,
    MAX_SUPPORTED_SCHEMA_VERSION,
    MIN_SCHEMA_VERSION,
    NUMBER_FORMAT_KEYS,
    REQUIRED_IDENTITY_KEYS,
    REQUIRED_TOP_LEVEL_KEYS,
    SEPARATOR_DEFAULTS,
    SUBTITLE_MAX_LENGTH,
    collect_definition_issues,
    format_path,
    resolved_schema_version,
)
from reporting_agent.compile.snapshot_view import build_snapshot_view

# --------------------------------------------------------------------------- #
# Fixtures — a v2 definition, and the smallest edit that breaks one
# --------------------------------------------------------------------------- #

VALID_FRONT_MATTER: dict[str, Any] = {
    "cover": {
        "logo": "s3://bucket/logo.png",
        "contact_block": "Acme Consulting\nreports@example.test",
        "subtitle": "Monthly utilization review",
    },
    "document_control": {
        "document_name": "Infrastructure Utilization Report",
        "document_number_pattern": "ACME-{template}-{year}{month}-{run}",
        "confidentiality_notice_id": "doc.confidentiality.internal",
        "distribution": "Acme platform team; Acme finance",
        "approvers": [
            {"role": "author", "name": "R. Prakoso", "title": "Consultant"},
            {"role": "reviewer", "name": "S. Dewi", "title": "Principal"},
        ],
    },
    "toc": {"enabled": True, "max_level": 3},
}


def v2(
    blocks: list[dict[str, Any]] | None = None,
    *,
    front_matter: object = None,
    language: object = "en",
    number_format: dict[str, Any] | None = None,
    schema_version: object = 2,
    drop_front_matter: bool = False,
    drop_language: bool = False,
) -> dict[str, Any]:
    """A `schema_version` 2 definition, built by raising a v1 one.

    Built from :func:`definition_factory.definition` rather than written out, so a v2 fixture
    and a v1 fixture differ **only** in the three things that raise the version — the
    `front_matter` section, `identity.language` and the two separators. A hand-written v2
    literal would drift from the v1 shape and the tests below would stop comparing the two.
    """
    body = df.definition(
        blocks if blocks is not None else [df.block("h", "heading", {"level": 1, "text": "Findings"})],
        validate=False,
    )
    body["schema_version"] = schema_version

    if not drop_front_matter:
        body["front_matter"] = (
            copy.deepcopy(VALID_FRONT_MATTER) if front_matter is None else front_matter
        )

    identity = body["identity"]
    assert isinstance(identity, dict)
    if not drop_language:
        identity["language"] = language

    design = body["design"]
    assert isinstance(design, dict)
    if number_format is not None:
        design["number_format"] = number_format

    return body


def paths_of(definition: object, *, mode: str = "run") -> list[str]:
    """Every failing field path, sorted — Req 2.7's one pass, as a comparable value."""
    return sorted(
        format_path(issue.path)
        for issue in collect_definition_issues(definition, mode=mode)  # type: ignore[arg-type]
    )


def messages_at(definition: object, path: str, *, mode: str = "run") -> list[str]:
    return [
        issue.message
        for issue in collect_definition_issues(definition, mode=mode)  # type: ignore[arg-type]
        if format_path(issue.path) == path
    ]


def front_matter_with(**sections: Any) -> dict[str, Any]:
    """The valid front matter with one or more subsections replaced wholesale."""
    body = copy.deepcopy(VALID_FRONT_MATTER)
    body.update(sections)
    return body


def control_with(**fields: Any) -> dict[str, Any]:
    """The valid front matter whose `document_control` carries `fields` merged in.

    `None` removes a field, so a test can express "the same document control without a
    document number" without restating the other four.
    """
    body = copy.deepcopy(VALID_FRONT_MATTER)
    control = body["document_control"]
    assert isinstance(control, dict)
    for key, value in fields.items():
        if value is _ABSENT:
            control.pop(key, None)
        else:
            control[key] = value
    return body


class _Absent:
    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "<absent>"


_ABSENT = _Absent()


# --------------------------------------------------------------------------- #
# The declarations — data, not two validators (Req 13.10)
# --------------------------------------------------------------------------- #


def test_the_version_tables_are_keyed_by_exactly_the_supported_versions() -> None:
    expected = set(range(MIN_SCHEMA_VERSION, MAX_SUPPORTED_SCHEMA_VERSION + 1))
    assert set(REQUIRED_TOP_LEVEL_KEYS) == expected
    assert set(NUMBER_FORMAT_KEYS) == expected
    assert set(IDENTITY_KEYS) == expected
    assert set(REQUIRED_IDENTITY_KEYS) == expected
    # The count itself, not the pair: `MAX_SUPPORTED_SCHEMA_VERSION` grew from 2 to 3 for
    # sections/provider, and a test asserting the old pair `(1, 2)` would go red on every
    # future version bump for a reason unrelated to what it is meant to guard — the range
    # of keyed versions, not which two versions happen to exist today.
    assert MIN_SCHEMA_VERSION == 1
    assert MAX_SUPPORTED_SCHEMA_VERSION >= 3


def test_version_two_adds_exactly_front_matter_at_the_top_level() -> None:
    """The only new top-level key, and **required** rather than permitted (Req 13.13)."""
    one = REQUIRED_TOP_LEVEL_KEYS[1]
    two = REQUIRED_TOP_LEVEL_KEYS[2]
    assert set(two) - set(one) == {"front_matter"}
    assert set(one) - set(two) == set()


def test_version_two_adds_exactly_the_two_separators_to_the_number_format() -> None:
    assert set(NUMBER_FORMAT_KEYS[2]) - set(NUMBER_FORMAT_KEYS[1]) == {
        "decimal_separator",
        "grouping_separator",
    }
    assert len(NUMBER_FORMAT_KEYS[1]) == 2
    assert len(NUMBER_FORMAT_KEYS[2]) == 4


def test_version_two_adds_exactly_language_to_the_identity_and_requires_it() -> None:
    assert set(IDENTITY_KEYS[2]) - set(IDENTITY_KEYS[1]) == {"language"}
    assert set(REQUIRED_IDENTITY_KEYS[2]) - set(REQUIRED_IDENTITY_KEYS[1]) == {"language"}
    assert set(REQUIRED_IDENTITY_KEYS[1]) == {"name"}
    for version, keys in REQUIRED_IDENTITY_KEYS.items():
        assert set(keys) <= set(IDENTITY_KEYS[version]), version


def test_the_separator_defaults_cover_every_declared_language() -> None:
    assert set(SEPARATOR_DEFAULTS) == set(LANGUAGES)
    assert SEPARATOR_DEFAULTS["en"] == (".", ",")
    assert SEPARATOR_DEFAULTS["id"] == (",", ".")


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (1, 1),
        (2, 2),
        # An integral float **is** a usable version: JavaScript has one number type, so
        # rejecting `2.0` where the wizard accepts `2` would make the two halves disagree
        # about one stored document.
        (2.0, 2),
        (0, MIN_SCHEMA_VERSION),
        # 3 became a genuinely usable version when sections/provider were added — using it
        # here as the "unusable" example would silently start testing the wrong number the
        # moment MAX_SUPPORTED_SCHEMA_VERSION moved. 99 stays out of range regardless.
        (99, MIN_SCHEMA_VERSION),
        ("2", MIN_SCHEMA_VERSION),
        (2.5, MIN_SCHEMA_VERSION),
        (True, MIN_SCHEMA_VERSION),
        (None, MIN_SCHEMA_VERSION),
    ],
)
def test_an_unusable_schema_version_resolves_to_the_narrower_table(
    value: object, expected: int
) -> None:
    """Req 2.7 — a broken version selects the v1 tables rather than stopping the walk, so
    every *other* failing path is still reported in the same pass. It applies no default to
    the definition; the broken version is itself still an issue."""
    assert resolved_schema_version(value) == expected


# --------------------------------------------------------------------------- #
# The v1 side of the dispatch — the three keys are undeclared, not optional
# --------------------------------------------------------------------------- #


def test_a_v1_definition_carrying_front_matter_is_an_undeclared_top_level_key() -> None:
    """Req 13.10 — no new rule needed: the existing strict check does it, so the message is
    about an unrecognized key rather than about versions."""
    body = df.definition([df.block("h", "heading", {"level": 1, "text": "x"})], validate=False)
    body["front_matter"] = copy.deepcopy(VALID_FRONT_MATTER)

    assert paths_of(body) == ["front_matter"]
    assert "Unrecognized" in messages_at(body, "front_matter")[0]


def test_a_v1_definition_carrying_identity_language_is_an_undeclared_identity_key() -> None:
    body = df.definition([df.block("h", "heading", {"level": 1, "text": "x"})], validate=False)
    body["identity"]["language"] = "en"

    assert paths_of(body) == ["identity.language"]


def test_a_v1_definition_carrying_a_separator_is_an_undeclared_number_format_key() -> None:
    body = df.definition([df.block("h", "heading", {"level": 1, "text": "x"})], validate=False)
    body["design"]["number_format"] = {
        "decimal_places": 2,
        "group_thousands": True,
        "decimal_separator": ",",
    }

    assert paths_of(body) == ["design.number_format.decimal_separator"]


def test_the_three_v1_refusals_are_reported_together_in_one_pass() -> None:
    """Req 2.7 — three levels of the document, one pass. A validator that returned on the
    first undeclared key would report one of these and hide the other two."""
    body = df.definition([df.block("h", "heading", {"level": 1, "text": "x"})], validate=False)
    body["front_matter"] = copy.deepcopy(VALID_FRONT_MATTER)
    body["identity"]["language"] = "en"
    body["design"]["number_format"]["grouping_separator"] = "."

    assert paths_of(body) == [
        "design.number_format.grouping_separator",
        "front_matter",
        "identity.language",
    ]


def test_a_v1_definition_is_accepted_unchanged() -> None:
    """Req 13.11, 16.10 — raising the supported version rewrites nothing. `df.definition`
    validates by default, so this passing at all is the assertion; the explicit call is here
    so the intent is readable rather than implied by a helper's default."""
    body = df.definition([df.block("h", "heading", {"level": 1, "text": "x"})])
    assert body["schema_version"] == 1
    assert collect_definition_issues(body, mode="run") == []


# --------------------------------------------------------------------------- #
# The v2 side — front_matter is required, and its keys are closed
# --------------------------------------------------------------------------- #


def test_a_valid_v2_definition_is_accepted() -> None:
    assert paths_of(v2()) == []


def test_a_v2_definition_omitting_front_matter_is_rejected_at_that_key() -> None:
    """Two issues at the one path, which is what **every** required top-level section already
    produces: one from the required-key check and one from the section's own validator reading
    an absent value. `front_matter` is not special-cased, and the check below is what says so —
    a `front_matter` reporting once while `identity` reports twice would be a section the
    wizard renders differently from the other five for no reason a reader could find.
    """
    absent_front_matter = paths_of(v2(drop_front_matter=True))
    assert absent_front_matter == ["front_matter", "front_matter"]

    for section in ("identity", "scope", "period", "metrics", "design"):
        body = v2()
        del body[section]
        assert paths_of(body) == [section, section], section


def test_a_v2_definition_omitting_identity_language_is_rejected() -> None:
    assert paths_of(v2(drop_language=True)) == ["identity.language"]


@pytest.mark.parametrize("language", ["en", "id"])
def test_each_declared_language_is_accepted(language: str) -> None:
    assert paths_of(v2(language=language)) == []


@pytest.mark.parametrize("language", ["EN", "En", "ID", "id-ID", "", "eng", None, 1])
def test_every_other_language_is_rejected_case_sensitively(language: object) -> None:
    """Req 15.1 — `EN` is not a spelling of `en`. The value keys a message catalog whose ids
    are lowercase by pattern, so a second spelling would pin a language the resolver cannot
    find."""
    assert paths_of(v2(language=language)) == ["identity.language"]


def test_front_matter_must_be_an_object() -> None:
    assert paths_of(v2(front_matter="nonsense")) == ["front_matter"]
    assert paths_of(v2(front_matter=[])) == ["front_matter"]


def test_an_undeclared_front_matter_key_is_named() -> None:
    assert paths_of(v2(front_matter=front_matter_with(appendix={}))) == [
        "front_matter.appendix"
    ]


def test_every_missing_front_matter_section_is_named_in_one_pass() -> None:
    """Req 13.1, 13.13 — all three, together. A walk that returned on the first absent
    section would make the author save three times to learn three things."""
    assert paths_of(v2(front_matter={})) == [
        f"front_matter.{section}" for section in sorted(FRONT_MATTER_KEYS)
    ]


def test_the_declared_front_matter_sections_are_exactly_three() -> None:
    assert FRONT_MATTER_KEYS == ("cover", "document_control", "toc")


# --------------------------------------------------------------------------- #
# front_matter.cover (Req 13.4)
# --------------------------------------------------------------------------- #


def test_a_cover_may_declare_none_of_its_fields() -> None:
    """Every field optional: the compiler derives the title, the customer and the resolved
    window on its own, so there is nothing here a consultant must fill in."""
    assert paths_of(v2(front_matter=front_matter_with(cover={}))) == []


def test_a_cover_field_may_be_null() -> None:
    assert (
        paths_of(
            v2(
                front_matter=front_matter_with(
                    cover={"logo": None, "contact_block": None, "subtitle": None}
                )
            )
        )
        == []
    )


@pytest.mark.parametrize(
    ("field", "maximum"),
    [
        ("logo", LOGO_MAX_LENGTH),
        ("contact_block", CONTACT_BLOCK_MAX_LENGTH),
        ("subtitle", SUBTITLE_MAX_LENGTH),
    ],
)
def test_each_cover_string_is_accepted_at_its_bound_and_rejected_one_past_it(
    field: str, maximum: int
) -> None:
    at_bound = v2(front_matter=front_matter_with(cover={field: "x" * maximum}))
    past_bound = v2(front_matter=front_matter_with(cover={field: "x" * (maximum + 1)}))

    assert paths_of(at_bound) == []
    assert paths_of(past_bound) == [f"front_matter.cover.{field}"]


def test_a_cover_string_bound_is_measured_in_utf16_code_units() -> None:
    """A bound checked against code points is a rule the browser and this compiler enforce
    differently: an astral character is one code point and two UTF-16 code units, so a
    definition the wizard refuses would compile here."""
    astral = "\U0001f600" * (SUBTITLE_MAX_LENGTH // 2)
    assert len(astral) == SUBTITLE_MAX_LENGTH // 2

    assert paths_of(v2(front_matter=front_matter_with(cover={"subtitle": astral}))) == []
    assert paths_of(
        v2(front_matter=front_matter_with(cover={"subtitle": astral + "\U0001f600"}))
    ) == ["front_matter.cover.subtitle"]


def test_an_undeclared_cover_field_is_named() -> None:
    assert paths_of(v2(front_matter=front_matter_with(cover={"banner": "x"}))) == [
        "front_matter.cover.banner"
    ]


def test_a_non_object_cover_is_rejected() -> None:
    assert paths_of(v2(front_matter=front_matter_with(cover="x"))) == [
        "front_matter.cover"
    ]


# --------------------------------------------------------------------------- #
# front_matter.document_control (Req 13.5, 13.6, 13.16)
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("field", "maximum"),
    [
        ("document_name", DOCUMENT_NAME_MAX_LENGTH),
        ("distribution", DISTRIBUTION_MAX_LENGTH),
    ],
)
def test_each_document_control_string_is_bounded(field: str, maximum: int) -> None:
    assert paths_of(v2(front_matter=control_with(**{field: "x" * maximum}))) == []
    assert paths_of(v2(front_matter=control_with(**{field: "x" * (maximum + 1)}))) == [
        f"front_matter.document_control.{field}"
    ]


@pytest.mark.parametrize(
    "notice",
    ["Internal use only", "", "confidentiality.internal", "docs.x", None, 1],
)
def test_the_confidentiality_notice_must_be_a_doc_message_id_not_copy(
    notice: object,
) -> None:
    """Req 13.5 — a **string id** resolved from the message catalog, so the notice appears in
    the pinned language like every other fixed string. Literal copy here would be English in
    an Indonesian document."""
    assert paths_of(v2(front_matter=control_with(confidentiality_notice_id=notice))) == [
        "front_matter.document_control.confidentiality_notice_id"
    ]


def test_a_doc_prefixed_notice_id_is_accepted() -> None:
    assert (
        paths_of(v2(front_matter=control_with(confidentiality_notice_id="doc.x")))
        == []
    )


def test_every_document_control_field_is_optional() -> None:
    assert paths_of(v2(front_matter=front_matter_with(document_control={}))) == []


def test_an_undeclared_document_control_field_is_named() -> None:
    assert paths_of(v2(front_matter=control_with(revision="3"))) == [
        "front_matter.document_control.revision"
    ]


# --------------------------------------------------------------------------- #
# document_number_pattern (Req 13.16)
# --------------------------------------------------------------------------- #


def test_the_declared_placeholder_set_is_closed_and_only_run_varies() -> None:
    assert DOCUMENT_NUMBER_PLACEHOLDERS == ("{template}", "{year}", "{month}", "{run}")
    assert DOCUMENT_NUMBER_VARYING_PLACEHOLDERS == frozenset({"{run}"})
    assert DOCUMENT_NUMBER_VARYING_PLACEHOLDERS <= set(DOCUMENT_NUMBER_PLACEHOLDERS)


@pytest.mark.parametrize(
    "pattern",
    [
        "{run}",
        "ACME-{run}",
        "{template}/{year}/{month}/{run}",
        "{run}{run}",
        "x" * (DOCUMENT_NUMBER_PATTERN_MAX_LENGTH - len("{run}")) + "{run}",
    ],
)
def test_a_pattern_of_literals_and_declared_placeholders_is_accepted(
    pattern: str,
) -> None:
    assert len(pattern) <= DOCUMENT_NUMBER_PATTERN_MAX_LENGTH
    assert paths_of(v2(front_matter=control_with(document_number_pattern=pattern))) == []


@pytest.mark.parametrize("pattern", ["", "x" * 121, None, 1, ["{run}"]])
def test_a_pattern_outside_one_to_one_hundred_and_twenty_characters_is_rejected(
    pattern: object,
) -> None:
    issues = messages_at(
        v2(front_matter=control_with(document_number_pattern=pattern)),
        "front_matter.document_control.document_number_pattern",
    )
    assert len(issues) == 1, issues
    assert "1 to 120 characters" in issues[0]


def test_a_pattern_at_the_length_bound_is_accepted() -> None:
    pattern = "{run}" + "x" * (DOCUMENT_NUMBER_PATTERN_MAX_LENGTH - len("{run}"))
    assert len(pattern) == DOCUMENT_NUMBER_PATTERN_MAX_LENGTH
    assert paths_of(v2(front_matter=control_with(document_number_pattern=pattern))) == []


def test_an_undeclared_placeholder_is_rejected_by_name() -> None:
    """Reported **by name**, because a validator that only looked for the declared four would
    treat `{quarter}` as literal text and emit it verbatim into a delivered document."""
    issues = messages_at(
        v2(front_matter=control_with(document_number_pattern="{quarter}-{run}")),
        "front_matter.document_control.document_number_pattern",
    )
    assert len(issues) == 1, issues
    assert "{quarter}" in issues[0]


def test_an_empty_placeholder_token_is_rejected_by_name() -> None:
    issues = messages_at(
        v2(front_matter=control_with(document_number_pattern="{}-{run}")),
        "front_matter.document_control.document_number_pattern",
    )
    assert len(issues) == 1, issues
    assert "{}" in issues[0]


@pytest.mark.parametrize(
    "pattern",
    [
        "ACME-0001",
        "{template}",
        "{template}-{year}-{month}",
        "{year}{month}",
    ],
)
def test_a_pattern_naming_nothing_that_varies_between_two_runs_is_rejected(
    pattern: str,
) -> None:
    """Req 13.16 — `{template}` is fixed per template and `{year}`/`{month}` come from the
    resolved period, so two runs of one template over July 2026 substitute the same values
    for all three and both documents carry the same number."""
    issues = messages_at(
        v2(front_matter=control_with(document_number_pattern=pattern)),
        "front_matter.document_control.document_number_pattern",
    )
    assert len(issues) == 1, issues
    assert "{run}" in issues[0]


def test_an_undeclared_placeholder_and_an_invariant_pattern_are_reported_together() -> None:
    """Two independent faults in one field, both named. A check that returned after the
    undeclared placeholder would hide the reason the pattern is unusable even once fixed."""
    issues = messages_at(
        v2(front_matter=control_with(document_number_pattern="{quarter}")),
        "front_matter.document_control.document_number_pattern",
    )
    assert len(issues) == 2, issues
    assert any("{quarter}" in message for message in issues)
    assert any("differs between two" in message for message in issues)


def test_a_length_violation_suppresses_the_placeholder_checks() -> None:
    """A non-string carries no tokens to inspect, so reporting "names no varying
    placeholder" about it would be a second issue with no separate fix."""
    issues = messages_at(
        v2(front_matter=control_with(document_number_pattern=42)),
        "front_matter.document_control.document_number_pattern",
    )
    assert len(issues) == 1, issues


def test_the_pattern_is_optional() -> None:
    assert paths_of(v2(front_matter=control_with(document_number_pattern=_ABSENT))) == []


# --------------------------------------------------------------------------- #
# front_matter.document_control.approvers (Req 13.6)
# --------------------------------------------------------------------------- #


def test_the_four_declared_roles_in_signature_order() -> None:
    assert APPROVER_ROLES == ("author", "reviewer", "approver", "recipient")


def test_one_entry_per_declared_role_is_accepted() -> None:
    approvers = [{"role": role} for role in APPROVER_ROLES]
    assert paths_of(v2(front_matter=control_with(approvers=approvers))) == []


def test_more_entries_than_declared_roles_is_rejected_at_the_list() -> None:
    approvers = [{"role": role} for role in APPROVER_ROLES] + [{"role": "author"}]
    assert paths_of(v2(front_matter=control_with(approvers=approvers))) == [
        "front_matter.document_control.approvers",
        "front_matter.document_control.approvers.4.role",
    ]


def test_a_repeated_role_is_rejected_at_the_second_entry() -> None:
    """A repeated role would put two names in one signature row, and the row height is a
    theme style rather than something that grows."""
    approvers = [{"role": "author", "name": "A"}, {"role": "author", "name": "B"}]
    assert paths_of(v2(front_matter=control_with(approvers=approvers))) == [
        "front_matter.document_control.approvers.1.role"
    ]


@pytest.mark.parametrize("role", ["signatory", "Author", "", None, 1])
def test_an_undeclared_role_is_rejected(role: object) -> None:
    assert paths_of(v2(front_matter=control_with(approvers=[{"role": role}]))) == [
        "front_matter.document_control.approvers.0.role"
    ]


def test_an_undeclared_approver_field_is_named() -> None:
    assert paths_of(
        v2(front_matter=control_with(approvers=[{"role": "author", "email": "x"}]))
    ) == ["front_matter.document_control.approvers.0.email"]


@pytest.mark.parametrize(
    ("field", "maximum"),
    [("name", APPROVER_NAME_MAX_LENGTH), ("title", APPROVER_TITLE_MAX_LENGTH)],
)
def test_each_approver_string_is_bounded(field: str, maximum: int) -> None:
    entry = {"role": "author", field: "x" * maximum}
    over = {"role": "author", field: "x" * (maximum + 1)}
    assert paths_of(v2(front_matter=control_with(approvers=[entry]))) == []
    assert paths_of(v2(front_matter=control_with(approvers=[over]))) == [
        f"front_matter.document_control.approvers.0.{field}"
    ]


def test_a_non_array_approvers_is_rejected_at_the_list() -> None:
    assert paths_of(v2(front_matter=control_with(approvers={}))) == [
        "front_matter.document_control.approvers"
    ]


def test_a_non_object_approver_entry_is_rejected_at_its_index() -> None:
    assert paths_of(v2(front_matter=control_with(approvers=["author"]))) == [
        "front_matter.document_control.approvers.0"
    ]


def test_an_empty_approvers_list_is_accepted() -> None:
    assert paths_of(v2(front_matter=control_with(approvers=[]))) == []


# --------------------------------------------------------------------------- #
# front_matter.toc (Req 13.9)
# --------------------------------------------------------------------------- #


def test_both_toc_fields_are_optional() -> None:
    assert paths_of(v2(front_matter=front_matter_with(toc={}))) == []


@pytest.mark.parametrize("enabled", [True, False])
def test_toc_enabled_accepts_either_boolean(enabled: bool) -> None:
    assert paths_of(v2(front_matter=front_matter_with(toc={"enabled": enabled}))) == []


@pytest.mark.parametrize("enabled", ["true", 1, 0, None, []])
def test_toc_enabled_refuses_anything_but_a_boolean(enabled: object) -> None:
    assert paths_of(v2(front_matter=front_matter_with(toc={"enabled": enabled}))) == [
        "front_matter.toc.enabled"
    ]


@pytest.mark.parametrize("level", [1, 2, 3, 4])
def test_toc_max_level_accepts_the_four_styled_heading_levels(level: int) -> None:
    assert paths_of(v2(front_matter=front_matter_with(toc={"max_level": level}))) == []


@pytest.mark.parametrize("level", [0, 5, -1, 1.5, "3", None, True])
def test_toc_max_level_refuses_a_level_no_theme_styles(level: object) -> None:
    assert paths_of(v2(front_matter=front_matter_with(toc={"max_level": level}))) == [
        "front_matter.toc.max_level"
    ]


def test_an_undeclared_toc_field_is_named() -> None:
    assert paths_of(v2(front_matter=front_matter_with(toc={"depth": 2}))) == [
        "front_matter.toc.depth"
    ]


# --------------------------------------------------------------------------- #
# One pass across every subsection (Req 2.7)
# --------------------------------------------------------------------------- #


def test_every_failing_front_matter_path_is_reported_in_one_pass() -> None:
    body = v2(
        front_matter={
            "cover": {"subtitle": "x" * (SUBTITLE_MAX_LENGTH + 1), "banner": 1},
            "document_control": {
                "document_name": "x" * (DOCUMENT_NAME_MAX_LENGTH + 1),
                "document_number_pattern": "{quarter}",
                "confidentiality_notice_id": "Internal only",
                "approvers": [{"role": "nobody"}],
            },
            "toc": {"enabled": "yes", "max_level": 9},
        }
    )

    assert paths_of(body) == [
        "front_matter.cover.banner",
        "front_matter.cover.subtitle",
        "front_matter.document_control.approvers.0.role",
        "front_matter.document_control.confidentiality_notice_id",
        "front_matter.document_control.document_name",
        "front_matter.document_control.document_number_pattern",
        "front_matter.document_control.document_number_pattern",
        "front_matter.toc.enabled",
        "front_matter.toc.max_level",
    ]


def test_a_broken_schema_version_still_reports_every_other_failing_path() -> None:
    """Req 2.7 — the narrower table is selected so the walk continues. `front_matter` and
    `identity.language` then read as undeclared, which is the v1 verdict, and the version
    itself is reported alongside them.

    Uses `99`, not `3`: `3` is now a genuinely supported version (sections/provider), so it
    resolves to its own table and reports its own set of missing keys rather than v1's.
    """
    body = v2(schema_version=99)
    assert paths_of(body) == ["front_matter", "identity.language", "schema_version"]


# --------------------------------------------------------------------------- #
# The number-format separators, checked on the RESOLVED pair (Req 16.2, 16.3)
# --------------------------------------------------------------------------- #


def test_v2_accepts_the_two_declared_separators() -> None:
    assert (
        paths_of(
            v2(
                number_format={
                    "decimal_places": 2,
                    "group_thousands": True,
                    "decimal_separator": ",",
                    "grouping_separator": ".",
                }
            )
        )
        == []
    )


def test_a_declared_decimal_separator_is_checked_against_the_defaulted_grouping_one() -> None:
    """The one case only the **resolved** pair catches: `id` defaults grouping to `.`, so a
    declared decimal `.` collides with a value the definition never states. Checking the two
    declared fields in isolation would accept this and render `1.234.56`."""
    body = v2(
        language="id",
        number_format={
            "decimal_places": 2,
            "group_thousands": True,
            "decimal_separator": ".",
        },
    )
    assert paths_of(body) == ["design.number_format.decimal_separator"]


def test_a_declared_grouping_separator_is_checked_against_the_defaulted_decimal_one() -> None:
    """The mirror image, and it is reported at `decimal_separator` even though that is the
    field the definition does **not** carry.

    A **fixed** path on purpose. The collision is one fault about a pair, so there is no
    single field to blame; reporting it at whichever half happened to be declared would make
    the location state-dependent, and a state-dependent location is what the two halves of the
    mirror would eventually disagree about. `app/lib/templates/definition.ts` picks the same
    fixed field, and the message names both resolved values so the author can still act on it.
    """
    body = v2(
        language="en",
        number_format={
            "decimal_places": 2,
            "group_thousands": True,
            "grouping_separator": ".",
        },
    )
    assert paths_of(body) == ["design.number_format.decimal_separator"]


@pytest.mark.parametrize("separator", ["", "..", "5", "-", " ", "\t", "\u00a0"])
def test_an_unusable_separator_is_rejected(separator: object) -> None:
    body = v2(
        number_format={
            "decimal_places": 2,
            "group_thousands": True,
            "decimal_separator": separator,
            "grouping_separator": ",",
        }
    )
    assert paths_of(body) == ["design.number_format.decimal_separator"]


@pytest.mark.parametrize("separator", [None, 1, [], {}])
def test_a_declared_separator_that_is_not_a_string_is_reported_not_defaulted(
    separator: object,
) -> None:
    """The key being **present** is what makes a value declared, so an unusable declaration is
    reported rather than quietly replaced by the language default.

    Two reasons it matters. Substituting the default would accept a definition that says one
    thing and render a document that says another. And it would put this half on the *looser*
    side of the mirror: `resolveSeparators` in `app/lib/templates/definition.ts` defaults on
    `=== undefined` alone, which for a `JSON.parse`d definition means exactly "absent" — so
    the wizard reports `decimal_separator: null` and, before this, the agent did not.

    In Python that distinction needs `in` rather than `.get()`: a missing key and a JSON
    `null` both read as `None`.
    """
    body = v2(
        number_format={
            "decimal_places": 2,
            "group_thousands": True,
            "decimal_separator": separator,
            "grouping_separator": ",",
        }
    )
    assert paths_of(body) == ["design.number_format.decimal_separator"]


def test_two_unusable_separators_report_their_own_fault_and_the_collision() -> None:
    """Both declared `null` is three issues: one per field, plus the collision — because two
    unusable separators are also equal to each other.

    Pinned because it is the one case where the per-field check and the pair check overlap, and
    it is the case a "return after the first problem" simplification would silently change.
    Verified to match `collectDefinitionIssues` in `app/lib/templates/definition.ts` value for
    value, across all fifteen separator shapes these tests cover.
    """
    body = v2(
        number_format={
            "decimal_places": 2,
            "group_thousands": True,
            "decimal_separator": None,
            "grouping_separator": None,
        }
    )
    assert paths_of(body) == [
        "design.number_format.decimal_separator",
        "design.number_format.decimal_separator",
        "design.number_format.grouping_separator",
    ]


def test_an_absent_separator_is_defaulted_from_the_language_and_not_reported() -> None:
    """The other direction of the same rule, so the fix above cannot be "report everything":
    absent is legal and resolves from the language."""
    for language, (decimal, grouping) in SEPARATOR_DEFAULTS.items():
        body = v2(
            language=language,
            number_format={"decimal_places": 2, "group_thousands": True},
        )
        assert paths_of(body) == [], language
        assert decimal != grouping, language


def test_a_superscript_digit_is_not_treated_as_a_digit() -> None:
    """`"\u00b2".isdigit()` is true in Python and `/[0-9]/u.test("\u00b2")` is false in
    JavaScript. Using `isdigit` would make the agent **stricter** than the wizard, so a
    definition the browser saves would fail the run minutes later."""
    body = v2(
        number_format={
            "decimal_places": 2,
            "group_thousands": True,
            "decimal_separator": "\u00b2",
            "grouping_separator": ",",
        }
    )
    assert paths_of(body) == []


# --------------------------------------------------------------------------- #
# The compiler's one dispatch (Req 13.2, 13.11)
# --------------------------------------------------------------------------- #


def view() -> object:
    return build_snapshot_view(sf.build(resources=[sf.vm(resource_id="/vm/a", name="a")]))


def styles_of(compiled: object) -> list[str]:
    return [
        node.style  # type: ignore[union-attr]
        for node in compiled.document.blocks  # type: ignore[attr-defined]
        if isinstance(node, Paragraph)
    ]


COVER_BLOCK = df.block("cover", "cover", {"subtitle": "Monthly review"})
HEADING_BLOCK = df.block("h", "heading", {"level": 1, "text": "Findings"})


def test_the_front_matter_floor_is_the_version_that_first_requires_front_matter() -> None:
    """Derived from the key table rather than restated, so a floor moved to 3 fails here
    instead of quietly compiling a second cover into every v2 document."""
    first_requiring = min(
        version
        for version, keys in REQUIRED_TOP_LEVEL_KEYS.items()
        if "front_matter" in keys
    )
    assert FRONT_MATTER_SCHEMA_VERSION == first_requiring
    assert MIN_SCHEMA_VERSION < FRONT_MATTER_SCHEMA_VERSION <= MAX_SUPPORTED_SCHEMA_VERSION
    assert FRONT_MATTER_FORBIDDEN_BLOCK_TYPES == ("cover",)


def test_a_v1_definition_compiles_its_cover_block_exactly_as_today() -> None:
    """Req 13.11 — what keeps every stored v1 row and all five `starters.ts` covers
    rendering byte-identically."""
    compiled = compile_document(
        df.definition([COVER_BLOCK, HEADING_BLOCK], name="Titled"),
        view=view(),
        subscription_display_name="Acme",
    )
    assert styles_of(compiled) == ["Title", "Subtitle", "Body Text", "Body Text", "Heading 1"]


def test_a_v2_definition_compiles_no_cover_block_even_when_one_is_present() -> None:
    """Req 13.2 — the front matter owns the cover from v2 on, so compiling the block as well
    would put two covers in one document.

    `validate=False` on purpose: the validator refuses a `cover` in `blocks` at v2 on both
    sides of the mirror, so the only way to reach this branch is drift between the two halves
    — which is exactly the case the compiler has to survive. Skipping loses no section,
    because `render/front_matter.py` emits the cover from `front_matter.cover`.
    """
    body = v2([COVER_BLOCK, HEADING_BLOCK])
    assert paths_of(body) == ["blocks.0.type"], "the validator should refuse this shape"

    compiled = compile_document(body, view=view(), subscription_display_name="Acme")

    assert styles_of(compiled) == ["Heading 1"]
    assert "cover" not in compiled.nodes_by_block
    assert compiled.figure_count == 0


def test_a_v2_definition_with_no_cover_block_compiles_every_other_block() -> None:
    compiled = compile_document(v2([HEADING_BLOCK]), view=view())
    assert styles_of(compiled) == ["Heading 1"]
    assert set(compiled.nodes_by_block) == {"h"}


def test_the_compiler_and_the_validator_resolve_the_version_through_one_function() -> None:
    """A definition whose `schema_version` is unusable is read as v1 by **both**, so its
    cover block compiles. A second resolution rule in the compiler — `int(...) >= 2`, say —
    would skip it here while the validator reported it against the v1 tables, and the
    document would silently lose its cover.

    Uses `99`: `3` is now a genuinely supported version, so `resolved_schema_version(3)`
    correctly returns `3` rather than `MIN_SCHEMA_VERSION`, and this test would otherwise be
    asserting the resolver is broken on the day it starts working.
    """
    body = v2([COVER_BLOCK, HEADING_BLOCK], schema_version=99)
    assert resolved_schema_version(99) == MIN_SCHEMA_VERSION

    compiled = compile_document(body, view=view(), subscription_display_name="Acme")

    assert styles_of(compiled)[0] == "Title"
    assert "cover" in compiled.nodes_by_block


def test_a_definition_carrying_no_schema_version_compiles_its_cover_block() -> None:
    body = df.definition([COVER_BLOCK, HEADING_BLOCK], validate=False)
    del body["schema_version"]

    compiled = compile_document(body, view=view(), subscription_display_name="Acme")

    assert "cover" in compiled.nodes_by_block


def test_the_cover_page_flag_still_governs_the_cover_at_v1() -> None:
    """Req 16.13 — the version skip is a separate rule from the flag, and turning the flag
    off at v1 still carries no empty cover."""
    body = df.definition([COVER_BLOCK, HEADING_BLOCK], validate=False)
    design = body["design"]
    assert isinstance(design, dict)
    design["cover_page"] = False

    compiled = compile_document(body, view=view())

    assert styles_of(compiled) == ["Heading 1"]


def test_compiling_mutates_no_definition() -> None:
    """**No migration in the agent, and none is needed.** A stored v1 row is compiled as v1
    for as long as it exists, which is what makes an archived report reproducible from its
    pinned version — a migration here would mean a two-year-old report rendered through
    today's reading of its definition."""
    for body in (
        df.definition([COVER_BLOCK, HEADING_BLOCK]),
        v2([HEADING_BLOCK]),
    ):
        before = copy.deepcopy(body)
        compile_document(body, view=view(), subscription_display_name="Acme")
        assert body == before
