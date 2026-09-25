"""Resolving a string id to the copy a document presents, in the run's pinned language
(Req 15.2, 15.4, 15.5).

One narrow object, for the same reason `compile/format.py` is the only place a figure
becomes a display string: a second resolution path is a second chance for a document to
present a string the verifier does not know about.

## The one behaviour worth stating twice

**There is no fallback to the other language.** A missing Indonesian value raises
`RENDER_FAILED` naming the id and the language. It does not return the English value, and it
does not return the id.

Both alternatives look kinder and are worse. Returning the English value ships an
Indonesian report with an English heading in it, which no reviewer of the artifact can
distinguish from a deliberate choice — and criterion 15.5's whole content is that no English
string reaches an Indonesian document. Returning the id ships `doc.table.resource` as a
column header. Failing the render is the only outcome that surfaces the omission to somebody
who can fix it, and it costs one run rather than one delivered document.

## Why the table is frozen and pre-narrowed to one language

`Messages` holds `{string_id: text}` for **one** language, resolved at construction. The
alternative — holding both languages and selecting per call — would put the language on
every call site and make a mixed-language document expressible. Here it is not: an instance
*is* a language, so a block compiler that has one cannot accidentally read the other.
"""

from __future__ import annotations

import json
import re
import string
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from types import MappingProxyType
from typing import Final

from reporting_agent.errors import RenderFailedError
from reporting_agent.messages import (
    DECLARED_LANGUAGES,
    DEFAULT_LANGUAGE,
    DEFAULT_MESSAGES_PATH,
    MESSAGE_ID_PATTERN,
)

__all__ = [
    "MessageInterpolationError",
    "Messages",
    "MissingMessageError",
    "load_messages",
    "message_table",
]

_ID_RE: Final[re.Pattern[str]] = re.compile(MESSAGE_ID_PATTERN)
_FORMATTER: Final[string.Formatter] = string.Formatter()


def _placeholder_names(template: str) -> frozenset[str]:
    """The set of named placeholders in `template`, extracted structurally via
    `string.Formatter().parse` rather than a regex.

    Positional placeholders (unnamed or numeric) are not supported — every
    placeholder must be a named keyword, because the parameter set must be
    enumerable for the exact-match assertion.
    """
    return frozenset(
        field_name
        for _, field_name, _, _ in _FORMATTER.parse(template)
        if field_name is not None
    )


class MessageInterpolationError(RenderFailedError):
    """The caller's keyword parameters do not exactly match the message's placeholders.

    A `RenderFailedError` subclass, same reasoning as `MissingMessageError` — a
    partially interpolated string in a delivered document is a wrong artifact, not
    a degraded one.
    """

    def __init__(
        self,
        string_id: str,
        *,
        message_placeholders: frozenset[str],
        caller_parameters: frozenset[str],
    ) -> None:
        super().__init__(
            f"interpolation mismatch for {string_id!r}: "
            f"the message carries placeholders {sorted(message_placeholders)} "
            f"but the caller supplied parameters {sorted(caller_parameters)}. "
            f"The two sets must be exactly equal."
        )
        self.string_id = string_id
        self.message_placeholders = message_placeholders
        self.caller_parameters = caller_parameters


class MissingMessageError(RenderFailedError):
    """A string id has no declared value in the language being rendered (Req 15.5).

    A `RenderFailedError` subclass, so it carries `RENDER_FAILED` and is terminal without
    this module restating either. Carries `string_id` and `language` as attributes so a
    caller building an event does not have to re-parse the message.

    Terminal is the right severity and not a harsh reading of the requirement: the
    alternative outcomes are a document with the wrong language in it or a document with an
    id in it, and both are delivered artifacts that are wrong in a way a reader cannot see.
    """

    def __init__(self, string_id: str, language: str) -> None:
        super().__init__(
            f"the message catalog declares no {language!r} value for the string id "
            f"{string_id!r}. The render fails rather than falling back to another "
            f"language: an English string in an Indonesian report is indistinguishable "
            f"from a deliberate choice once the document is delivered (Req 15.5)."
        )
        self.string_id = string_id
        self.language = language


@dataclass(frozen=True, slots=True)
class Messages:
    """One language's resolved copy.

    Built through :func:`load_messages` or :func:`message_table`, never by reading the
    catalog at a call site — there is one loader so there is one place the language is
    selected and one place a missing value is classified.
    """

    language: str
    _table: Mapping[str, str]

    def text(self, string_id: str, **kwargs: object) -> str:
        """The declared copy for `string_id`, optionally interpolated with `kwargs`.

        When no keyword arguments are supplied, behaves exactly as before: returns the
        resolved string or raises :class:`MissingMessageError`.

        When keyword arguments are supplied, the resolved string is interpolated with them
        via :meth:`str.format_map`. The placeholder set of the message must **exactly
        equal** the parameter set: a message carrying a placeholder no caller supplies, or
        a caller supplying a parameter the message does not carry, raises
        :class:`MessageInterpolationError` naming the id and both sets. Partial
        substitution is never performed.

        Raises rather than returning a default for any of the three ways this can go wrong,
        because all three produce a wrong document rather than a missing one: an id the
        catalog does not declare, an id the catalog declares with no value in this
        language, and an id that is not a well-formed id at all.
        """
        value = self._table.get(string_id)
        if value is None:
            raise MissingMessageError(string_id, self.language)
        if not kwargs:
            return value
        message_placeholders = _placeholder_names(value)
        caller_parameters = frozenset(kwargs)
        if message_placeholders != caller_parameters:
            raise MessageInterpolationError(
                string_id,
                message_placeholders=message_placeholders,
                caller_parameters=caller_parameters,
            )
        return value.format_map(kwargs)

    def has(self, string_id: str) -> bool:
        """Whether `string_id` resolves in this language, for a caller deciding whether to
        emit an optional line at all. Deliberately separate from :meth:`text`, so that
        "this section is absent" and "this string is missing" stay two different questions
        and the second one still fails."""
        return string_id in self._table

    @property
    def declared_ids(self) -> frozenset[str]:
        """Every id this instance can resolve — for the id-set equality assertion."""
        return frozenset(self._table)


def _validated_catalog(raw: object, *, path: Path) -> Mapping[str, Mapping[str, str]]:
    """The catalog's `messages` map, with every id and every value checked.

    Raises `MissingMessageError`'s parent rather than degrading, unlike
    `catalog/loader.py`, and the asymmetry is deliberate. A metric catalog entry that fails
    validation costs one metric and the run continues with a recorded gap; a malformed
    message catalog means the document cannot state its own headings, and there is no
    partial document worth delivering. The catalog is code shipped in the image, so a
    malformed one is a build defect to surface rather than a run to degrade.
    """
    if not isinstance(raw, Mapping):
        raise RenderFailedError(f"{path} is not a JSON object")

    declared_version = raw.get("schema_version")
    if not isinstance(declared_version, str) or not declared_version.strip():
        raise RenderFailedError(f"{path} declares no schema_version")

    messages = raw.get("messages")
    if not isinstance(messages, Mapping) or not messages:
        raise RenderFailedError(f"{path} declares no messages map")

    validated: dict[str, Mapping[str, str]] = {}
    for string_id, values in messages.items():
        if not isinstance(string_id, str) or not _ID_RE.match(string_id):
            raise RenderFailedError(
                f"{path} declares the string id {string_id!r}, which is not of the form "
                f"{MESSAGE_ID_PATTERN} — the prefix is what says which half resolves an id"
            )
        if not isinstance(values, Mapping):
            raise RenderFailedError(f"{path} declares no language map for {string_id!r}")
        per_language: dict[str, str] = {}
        for language in DECLARED_LANGUAGES:
            value = values.get(language)
            if not isinstance(value, str) or not value.strip():
                raise RenderFailedError(
                    f"{path} declares no non-empty {language!r} value for the string id "
                    f"{string_id!r}; every id carries a value in every declared language, "
                    f"so that no render can discover a hole in one of them (Req 15.4)"
                )
            per_language[language] = value
        validated[string_id] = MappingProxyType(per_language)
    return MappingProxyType(validated)


def load_messages(
    language: str = DEFAULT_LANGUAGE, *, path: Path | str | None = None
) -> Messages:
    """The catalog at `path` (default: the one shipped in the image), narrowed to
    `language`.

    Raises `RenderFailedError` for an undeclared language, so a template that somehow
    pinned a third one fails at the point of resolution rather than rendering a document
    in which every string is missing.
    """
    if language not in DECLARED_LANGUAGES:
        raise RenderFailedError(
            f"{language!r} is not one of the declared languages "
            f"{list(DECLARED_LANGUAGES)}; a language is a template setting drawn from a "
            f"closed set, not free text"
        )

    resolved = Path(path) if path is not None else DEFAULT_MESSAGES_PATH
    catalog = _validated_catalog(
        json.loads(resolved.read_text(encoding="utf-8")), path=resolved
    )
    return Messages(
        language=language,
        _table=MappingProxyType(
            {string_id: values[language] for string_id, values in catalog.items()}
        ),
    )


def message_table(
    language: str, table: Mapping[str, str] | None = None
) -> Messages:
    """A `Messages` over an explicit table — for a test asserting a resolution rule
    without a catalog file, and for nothing else.

    Named rather than achieved by constructing `Messages` directly so the shipped path and
    the test path are visibly different at every call site: a production caller uses
    :func:`load_messages`, and a reader can tell at a glance which one they are looking at.
    """
    if language not in DECLARED_LANGUAGES:
        raise RenderFailedError(f"{language!r} is not a declared language")
    return Messages(language=language, _table=MappingProxyType(dict(table or {})))
