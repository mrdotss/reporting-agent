"""The message catalog and its resolver (Req 15.2, 15.4, 15.5).

## The assertion this module exists for

**The `en` id set equals the `id` id set, and a difference names every id in one and not
the other.** A count comparison would pass on two catalogs that disagree about two ids in
opposite directions, which is the shape a copy edit actually produces — somebody adds an
`en` value and removes an obsolete `id` one in the same change.

## The behaviour worth testing hardest

`Messages.text` must **fail** rather than fall back. That is easy to write and easy to
regress into kindness later, because every fallback looks like robustness at the call site
and only looks wrong in the delivered artifact. So the missing-value case asserts the
exception type, the code, the id and the language, and a separate test asserts that the
English value is *not* returned when the Indonesian one is absent — the specific wrong
answer, not merely "something raised".
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from reporting_agent.compile.messages import (
    Messages,
    MissingMessageError,
    load_messages,
    message_table,
)
from reporting_agent.errors import ErrorCode, RenderFailedError
from reporting_agent.messages import (
    DECLARED_LANGUAGES,
    DEFAULT_LANGUAGE,
    DEFAULT_MESSAGES_PATH,
    MESSAGE_ID_PATTERN,
)

ID_RE = re.compile(MESSAGE_ID_PATTERN)


def raw_catalog() -> dict:
    return json.loads(DEFAULT_MESSAGES_PATH.read_text(encoding="utf-8"))


def ids_for(language: str) -> frozenset[str]:
    """Every id declaring a non-empty value in `language`, read from the file itself.

    Read from the raw document rather than through `load_messages`, because the loader
    *raises* on a missing value — so going through it would make the id-set comparison
    below unreachable, and the test would assert the loader's behaviour a second time
    instead of the catalog's content.
    """
    return frozenset(
        string_id
        for string_id, values in raw_catalog()["messages"].items()
        if isinstance(values.get(language), str) and values[language].strip()
    )


# --- the catalog document ------------------------------------------------------------


def test_the_shipped_catalog_declares_a_schema_version_and_is_not_empty() -> None:
    document = raw_catalog()

    assert document["schema_version"].strip()
    assert len(document["messages"]) > 0, "an empty catalog would pass every test below"


def test_the_en_id_set_equals_the_id_id_set() -> None:
    """Req 15.4. Named both ways, because the two directions are two different mistakes:
    an id with no Indonesian value fails an Indonesian render, and an id with no English
    value fails an English one."""
    english = ids_for("en")
    indonesian = ids_for("id")

    assert english - indonesian == frozenset(), (
        "these ids declare an English value and no Indonesian one, so an Indonesian "
        f"render fails on them: {sorted(english - indonesian)}"
    )
    assert indonesian - english == frozenset(), (
        "these ids declare an Indonesian value and no English one, so an English render "
        f"fails on them: {sorted(indonesian - english)}"
    )


def test_every_id_is_in_the_declared_namespace() -> None:
    offenders = [
        string_id for string_id in raw_catalog()["messages"] if not ID_RE.match(string_id)
    ]

    assert offenders == [], (
        f"these ids are not of the form {MESSAGE_ID_PATTERN}; the prefix is what says "
        f"which half resolves an id: {offenders}"
    )


def test_every_declared_language_has_a_value_for_every_id() -> None:
    """The same fact as the set equality, asserted over the language list rather than over
    the two names, so adding a third language to `DECLARED_LANGUAGES` fails here until the
    catalog carries it — rather than silently rendering a document of missing strings."""
    missing: list[str] = []
    for string_id, values in raw_catalog()["messages"].items():
        for language in DECLARED_LANGUAGES:
            value = values.get(language)
            if not isinstance(value, str) or not value.strip():
                missing.append(f"{string_id}[{language}]")

    assert missing == [], missing


def test_the_two_languages_are_actually_different_copy() -> None:
    """A catalog whose Indonesian column was filled by copying the English one would pass
    every assertion above. It is not proof of translation quality, but it does catch the
    one mechanical shortcut: a wholesale copy.

    A handful of ids legitimately match — `baseline` and `enhanced` are the tier names the
    snapshot records, and a translated tier name would no longer name the tier; `UTC` is the
    timezone abbreviation, and Indonesian technical writing keeps it untranslated for the same
    reason; `Data` is a true cognate, spelled and meant identically in both languages, so
    changing one side to satisfy this assertion would be a mistranslation performed to please a
    test — so this asserts a proportion rather than universal difference, and names the
    exempt ids.
    """
    shared_by_design = {
        "doc.fidelity.baseline",
        "doc.fidelity.enhanced",
        # "SKU" is the initialism in Indonesian technical writing too, and the column
        # header is the initialism rather than the phrase behind it.
        "doc.table.attr.sku_name",
        "ui.fidelity.baseline",
        "ui.fidelity.enhanced",
        "ui.run_list.utc_suffix",
        # "Status" is the Indonesian word too. Translating it to something else
        # to satisfy this assertion would be a mistranslation performed to please
        # a test, which is the exact trade the docstring above warns against.
        "ui.run_table.status",
        "ui.scan.group_data",
    }
    messages = raw_catalog()["messages"]
    identical = {
        string_id
        for string_id, values in messages.items()
        if values["en"] == values["id"]
    }

    assert identical <= shared_by_design, (
        "these ids carry identical English and Indonesian copy and are not among the tier "
        f"names that legitimately do: {sorted(identical - shared_by_design)}"
    )


def test_every_declared_gap_type_has_an_explanation() -> None:
    """A gap the report cannot explain is a row of jargon in a delivered document. Asserted
    against `DECLARED_GAP_TYPES` rather than a literal list, so the four types this spec
    added — and any added later — are covered without this test being edited."""
    from reporting_agent.collect.log import DECLARED_GAP_TYPES

    declared = raw_catalog()["messages"]
    missing = [
        gap_type
        for gap_type in sorted(DECLARED_GAP_TYPES)
        if f"doc.gap.{gap_type}" not in declared
    ]

    assert missing == [], (
        f"these gap types have no `doc.gap.<type>` explanation in the catalog: {missing}"
    )


# --- the resolver -------------------------------------------------------------------


@pytest.mark.parametrize("language", DECLARED_LANGUAGES)
def test_the_shipped_catalog_loads_in_every_declared_language(language: str) -> None:
    messages = load_messages(language)

    assert messages.language == language
    assert messages.declared_ids == ids_for(language)
    assert messages.text("doc.notice.empty_scope").strip()


def test_both_languages_resolve_the_same_id_set() -> None:
    assert load_messages("en").declared_ids == load_messages("id").declared_ids


def test_the_two_languages_resolve_one_id_to_different_copy() -> None:
    english = load_messages("en").text("doc.notice.empty_scope")
    indonesian = load_messages("id").text("doc.notice.empty_scope")

    assert english != indonesian
    assert english == "No resources matched this scope"


def test_a_missing_id_raises_render_failed_naming_the_id_and_the_language() -> None:
    """Req 15.5. The id **and** the language, because "this string is missing" and "this
    string is missing in Indonesian" send a fixer to two different places."""
    messages = load_messages("id")

    with pytest.raises(MissingMessageError) as raised:
        messages.text("doc.absent.entirely")

    assert raised.value.string_id == "doc.absent.entirely"
    assert raised.value.language == "id"
    assert raised.value.code is ErrorCode.RENDER_FAILED
    assert raised.value.terminal is True
    assert "doc.absent.entirely" in str(raised.value)
    assert "'id'" in str(raised.value)


def test_a_missing_value_does_not_fall_back_to_the_other_language() -> None:
    """The specific wrong answer, asserted rather than "something raised".

    A resolver that returned the English value here would satisfy a test that only checked
    for an exception *or* a non-empty string. This asserts the failure is the outcome and
    the English copy is not, which is the whole of criterion 15.5.
    """
    indonesian = message_table("id", {"doc.table.resource": "Sumber daya"})

    with pytest.raises(MissingMessageError):
        indonesian.text("doc.notice.empty_scope")

    # And the English catalog does declare it, so a fallback was available and refused.
    assert load_messages("en").has("doc.notice.empty_scope")


def test_a_messages_instance_is_one_language_and_cannot_reach_the_other() -> None:
    """Structural rather than procedural: there is no argument `text` takes that would
    select a language, so a mixed-language document is not expressible."""
    messages = load_messages("id")

    assert messages.declared_ids
    assert not hasattr(messages.text, "language")
    assert messages.text("doc.notice.empty_scope") != load_messages("en").text(
        "doc.notice.empty_scope"
    )


def test_has_reports_membership_without_raising() -> None:
    messages = message_table("en", {"doc.table.resource": "Resource"})

    assert messages.has("doc.table.resource") is True
    assert messages.has("doc.table.absent") is False


def test_an_undeclared_language_is_refused() -> None:
    with pytest.raises(RenderFailedError, match="not one of the declared languages"):
        load_messages("fr")


# --- the loader's validation ---------------------------------------------------------


def write_catalog(tmp_path: Path, document: object) -> Path:
    path = tmp_path / "catalog.v1.json"
    path.write_text(json.dumps(document, ensure_ascii=False), encoding="utf-8")
    return path


@pytest.mark.parametrize(
    ("document", "fragment"),
    [
        ([], "not a JSON object"),
        ({"messages": {"doc.a.b": {"en": "A", "id": "A1"}}}, "no schema_version"),
        ({"schema_version": "1.0.0"}, "no messages map"),
        ({"schema_version": "1.0.0", "messages": {}}, "no messages map"),
        (
            {"schema_version": "1.0.0", "messages": {"nope": {"en": "A", "id": "A1"}}},
            "which is not of the form",
        ),
        (
            {"schema_version": "1.0.0", "messages": {"doc.a.b": "A"}},
            "no language map",
        ),
        (
            {"schema_version": "1.0.0", "messages": {"doc.a.b": {"en": "A"}}},
            "no non-empty 'id' value",
        ),
        (
            {"schema_version": "1.0.0", "messages": {"doc.a.b": {"en": "A", "id": "  "}}},
            "no non-empty 'id' value",
        ),
        (
            {"schema_version": "1.0.0", "messages": {"ui.a.b": {"en": "", "id": "A1"}}},
            "no non-empty 'en' value",
        ),
    ],
)
def test_a_malformed_catalog_is_refused_rather_than_degraded(
    document: object, fragment: str, tmp_path: Path
) -> None:
    """Unlike `catalog/loader.py`, which degrades a bad metric entry to a gap and continues.

    The asymmetry is deliberate and worth asserting: a skipped metric costs one figure, but
    a document that cannot state its own headings has no partial form worth delivering, and
    the catalog is code shipped in the image rather than customer data.
    """
    path = write_catalog(tmp_path, document)

    with pytest.raises(RenderFailedError, match=re.escape(fragment)):
        load_messages(DEFAULT_LANGUAGE, path=path)


def test_a_well_formed_temp_catalog_loads(tmp_path: Path) -> None:
    """Guard the guard: the rejections above must be about the defect, not about the
    harness writing something unloadable."""
    path = write_catalog(
        tmp_path,
        {
            "schema_version": "1.0.0",
            "messages": {"doc.table.resource": {"en": "Resource", "id": "Sumber daya"}},
        },
    )

    assert load_messages("id", path=path).text("doc.table.resource") == "Sumber daya"


def test_the_table_is_immutable() -> None:
    """`Messages` is frozen and its table is a mapping proxy, so a block compiler cannot
    mutate the copy another block will read."""
    messages = load_messages("en")

    with pytest.raises(TypeError):
        messages._table["doc.table.resource"] = "mutated"  # type: ignore[index]


def test_block_context_carries_a_messages_instance() -> None:
    """The wiring, so `BlockContext` gaining the field is asserted rather than assumed."""
    from reporting_agent.compile.blocks.base import BlockContext

    assert "messages" in BlockContext.__dataclass_fields__
    annotation = BlockContext.__dataclass_fields__["messages"].type
    assert annotation in (Messages, "Messages"), annotation


# --- interpolation ------------------------------------------------------------------


def test_text_with_no_parameters_returns_the_plain_string() -> None:
    """Backward compatibility: existing call sites pass no kwargs and get the same result."""
    messages = message_table("en", {"doc.chart.other_series": "Other ({count} series)"})

    result = messages.text("doc.chart.other_series")

    # With no kwargs, the raw template is returned — placeholders included.
    assert result == "Other ({count} series)"


def test_text_with_matching_parameters_interpolates() -> None:
    messages = message_table("en", {"doc.chart.other_series": "Other ({count} series)"})

    result = messages.text("doc.chart.other_series", count=3)

    assert result == "Other (3 series)"


def test_text_interpolation_works_with_indonesian() -> None:
    messages = message_table("id", {"doc.chart.other_series": "Lainnya ({count} seri)"})

    result = messages.text("doc.chart.other_series", count=7)

    assert result == "Lainnya (7 seri)"


def test_text_interpolation_rejects_extra_caller_parameter() -> None:
    from reporting_agent.compile.messages import MessageInterpolationError

    messages = message_table("en", {"doc.chart.other_series": "Other ({count} series)"})

    with pytest.raises(MessageInterpolationError) as raised:
        messages.text("doc.chart.other_series", count=3, extra="bad")

    assert raised.value.string_id == "doc.chart.other_series"
    assert raised.value.message_placeholders == frozenset({"count"})
    assert raised.value.caller_parameters == frozenset({"count", "extra"})


def test_text_interpolation_rejects_missing_caller_parameter() -> None:
    """When kwargs are passed but are missing a required placeholder, it raises."""
    from reporting_agent.compile.messages import MessageInterpolationError

    messages = message_table("en", {"doc.x.y": "Hello {a} and {b}"})

    with pytest.raises(MessageInterpolationError) as raised:
        messages.text("doc.x.y", a="1")

    assert raised.value.message_placeholders == frozenset({"a", "b"})
    assert raised.value.caller_parameters == frozenset({"a"})


def test_text_interpolation_rejects_wrong_parameter_name() -> None:
    from reporting_agent.compile.messages import MessageInterpolationError

    messages = message_table("en", {"doc.chart.other_series": "Other ({count} series)"})

    with pytest.raises(MessageInterpolationError) as raised:
        messages.text("doc.chart.other_series", name="wrong")

    assert raised.value.string_id == "doc.chart.other_series"
    assert raised.value.message_placeholders == frozenset({"count"})
    assert raised.value.caller_parameters == frozenset({"name"})


def test_text_interpolation_rejects_subset_of_required_parameters() -> None:
    """A message with two placeholders rejects a caller supplying only one — same as
    above but with a different message to verify generality."""
    from reporting_agent.compile.messages import MessageInterpolationError

    messages = message_table("en", {"doc.x.y": "Values: {a}, {b}, {c}"})

    with pytest.raises(MessageInterpolationError):
        messages.text("doc.x.y", a="1", b="2")


def test_text_interpolation_on_a_message_with_no_placeholders_rejects_any_param() -> None:
    from reporting_agent.compile.messages import MessageInterpolationError

    messages = message_table("en", {"doc.chart.empty": "This chart carries no plotted values"})

    with pytest.raises(MessageInterpolationError) as raised:
        messages.text("doc.chart.empty", count=5)

    assert raised.value.message_placeholders == frozenset()
    assert raised.value.caller_parameters == frozenset({"count"})


def test_interpolation_error_is_a_render_failed_error() -> None:
    from reporting_agent.compile.messages import MessageInterpolationError

    assert issubclass(MessageInterpolationError, RenderFailedError)


def test_the_shipped_catalog_other_series_interpolates_in_both_languages() -> None:
    """Integration: the real catalog's doc.chart.other_series works end-to-end."""
    en = load_messages("en")
    id_ = load_messages("id")

    assert en.text("doc.chart.other_series", count=5) == "Other (5 series)"
    assert id_.text("doc.chart.other_series", count=5) == "Lainnya (5 seri)"


def test_the_three_new_ids_are_declared_in_the_shipped_catalog() -> None:
    """The three ids this task adds are present and carry expected values."""
    en = load_messages("en")
    id_ = load_messages("id")

    assert en.text("doc.chart.empty") == "This chart carries no plotted values"
    assert en.text("doc.preview.notice") == (
        "Preview \u2014 rendered from a stored snapshot. Not a verified deliverable."
    )
    # doc.chart.other_series requires interpolation for its intended use,
    # but text() without params still returns the raw template
    assert "{count}" in en.text("doc.chart.other_series")
    assert "{count}" in id_.text("doc.chart.other_series")
