"""Shared Messages instances for the test suite.

A call site that needs Messages for ``render_document`` or ``plotted_series`` imports one of
the pre-loaded instances rather than repeating ``load_messages("en")`` everywhere. This keeps
a single point of construction and makes adding a third language trivial.
"""

from __future__ import annotations

from reporting_agent.compile.messages import Messages, load_messages

EN: Messages = load_messages("en")
"""English messages — the default for most tests."""

ID: Messages = load_messages("id")
"""Indonesian messages — for tests asserting language-specific rendering."""
