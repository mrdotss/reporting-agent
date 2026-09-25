"""The message catalog: every fixed string a document or an interface presents, in both
declared languages (Req 15.2, 15.4, 15.5).

## Why a catalog and not a translation function

A report's language is a **template setting**, pinned on the template version a run
rendered, so an archived report presents the copy it was delivered with rather than the
copy that happens to be current. That rules out anything resolved at display time. It also
rules out a fallback: a document that silently prints one English heading in an Indonesian
report is the failure this exists to prevent, and it is worse than failing the render,
because nobody reviewing the artifact can tell whether that string was translated and
rejected or never translated at all.

So `Messages.text` raises `RENDER_FAILED` naming the id **and** the language, and there is
no code path that answers a missing Indonesian value with the English one.

## Why both halves declare every id

`doc.` and `chart.` ids are resolved by the agent when it compiles a document; `ui.` ids are
resolved by the web app when it presents a stored run. The two id **sets must be equal**
anyway — the app has to present an archived run's fixed copy in that run's pinned language,
so it needs the same declaration the agent rendered from. Splitting the catalog by consumer
would make the equality unassertable, which is the only property that keeps the two halves
from drifting into two vocabularies.

`app/lib/messages/catalog.v1.json` carries the same ids and the same values, and a mirror
guard asserts the two files agree.

## The id namespace

`^(doc|chart|ui)\\.[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)+$` — a **closed** prefix set,
lowercase ASCII, dotted, at least three segments. Closed rather than free-form because the
prefix is what says which half resolves an id, and a fourth prefix appearing in one half
and not the other is exactly the drift the equality assertion exists to catch.

## What is in here, and what is deliberately not

In: the notice rows a block emits instead of vanishing, table headers, the provenance and
methodology copy, the fidelity-tier meanings, one explanation per declared `gap_type`, the
front matter, the verification record, chart axis and legend copy, and the report page's
fixed labels.

Not in: Word **style names** (`Heading 1`, `Table Hairline`) and error-message text. A
style name is an identifier inside the theme document, not copy a reader sees — translating
one would fail to resolve the style. Error messages are diagnostics for an operator reading
a log or a finding, not part of the delivered artifact, and they are already required to
name paths and ids rather than read as prose.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

__all__ = [
    "CATALOG_SCHEMA_VERSION",
    "DECLARED_LANGUAGES",
    "DEFAULT_LANGUAGE",
    "DEFAULT_MESSAGES_PATH",
    "MESSAGE_ID_PATTERN",
]

DEFAULT_MESSAGES_PATH: Final[Path] = Path(__file__).resolve().parent / "catalog.v1.json"

CATALOG_SCHEMA_VERSION: Final[str] = "1.0.0"
"""The catalog document's own `schema_version`, distinct from a template's and from the
snapshot's. Three documents, three version fields; conflating them would tie a copy edit to
a template migration."""

DEFAULT_LANGUAGE: Final[str] = "en"

DECLARED_LANGUAGES: Final[tuple[str, ...]] = ("en", "id")
"""The two languages, in a fixed order so an iteration reports them the same way twice.

**Two, and adding a third is a decision with a cost**, not a configuration change: every id
in the catalog needs a value in it before the equality assertion can pass, and a partially
translated third language is precisely the state `Messages.text` refuses to paper over."""

MESSAGE_ID_PATTERN: Final[str] = r"^(doc|chart|ui)\.[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$"
"""The id namespace, as a pattern string so both halves can compile the identical source.

Declared here rather than in `compile/messages.py` because it is a fact about the
**catalog**, and the app's mirror guard needs it without importing the compiler."""
