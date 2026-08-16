"""The redaction guard — a per-invocation secret registry and a logging filter.

A secret must be *structurally* unable to reach an event or a log line, so every
outbound event passes through one egress function that calls :func:`scrub_deep`
(Req 15.8) and every log record passes through the filter :func:`install_log_redaction`
attaches (Req 15.2). `client_secret` and `progress_token` are registered with
**identical sensitivity** (Req 15.1): the token authorizes writes to the run state
machine, so leaking it lets someone mark a run `completed`.

Three details are load-bearing and are not stylistic choices.

**A `ContextVar`, not a module-level set.** A process-wide set is never cleared, so
one invocation's secrets outlive it, keep scrubbing a *later* invocation's ordinary
output, and grow the registry for the life of the container. Req 15.10 forbids
exactly that. A `ContextVar` is scoped to the invocation's async context, so the
logging filter sees the current invocation's secrets and only those, and teardown at
the terminal event is a reset rather than a subtraction (:func:`discard_secrets`).

**Patterns are `re.escape`d before they are compiled.** An Azure client secret
routinely contains ``. * + ? [ ] ( ) { } | ^ $ \\``. Interpolating one into a pattern
unescaped either fails to compile or — worse — compiles into a pattern that matches
the wrong text and leaves the secret in place.

**A value shorter than 8 characters registers nothing** (Req 15.9). An empty pattern
inserts the placeholder between every character of the output, and a one-character
pattern shreds ordinary prose. Neither failure is detectable downstream, so the floor
is enforced at registration.
"""

from __future__ import annotations

import logging
import re
import traceback
from collections.abc import Iterable, Mapping, Sequence, Set
from contextvars import ContextVar, Token
from dataclasses import dataclass

__all__ = [
    "MIN_SECRET_LENGTH",
    "SECRET_PLACEHOLDER",
    "RedactionFilter",
    "discard_secrets",
    "install_log_redaction",
    "presence_marker",
    "register_secrets",
    "registered_secret_count",
    "scrub",
    "scrub_deep",
    "scrub_exception",
]

SECRET_PLACEHOLDER = "[redacted]"

# Req 15.9. Below this length a pattern does more damage than the secret it hides.
MIN_SECRET_LENGTH = 8


@dataclass(frozen=True, slots=True)
class _Secret:
    """One registered secret as its pre-escaped pattern plus its plaintext length.

    The length is retained *only* to order replacement longest-first. When one
    registered secret contains another — a `progress_token` that happens to start
    with the `client_secret`, say — replacing the shorter one first leaves the
    remainder of the longer one in the output, which is a partial disclosure of a
    credential. The plaintext itself is never stored: `pattern.pattern` holds the
    escaped form and nothing here reconstructs the original.
    """

    length: int
    pattern: re.Pattern[str]


# The registry. Default is an empty tuple, so a process that never parses a context
# scrubs nothing rather than failing.
_SECRETS: ContextVar[tuple[_Secret, ...]] = ContextVar("reporting_agent_secrets", default=())


def register_secrets(values: Iterable[object]) -> Token[tuple[_Secret, ...]]:
    """Register `values` as secrets for the current context.

    Skips anything that is not a `str` and anything shorter than
    :data:`MIN_SECRET_LENGTH` (Req 15.9), and skips a value already registered, so
    repeated registration cannot grow the registry.

    Returns the `ContextVar` token, which :func:`discard_secrets` accepts to restore
    the previous registry exactly. Callers that simply tear the whole registry down
    at the terminal event may ignore the return value.
    """
    current = _SECRETS.get()
    known = {secret.pattern.pattern for secret in current}

    additions: list[_Secret] = []
    for value in values:
        if not isinstance(value, str) or len(value) < MIN_SECRET_LENGTH:
            continue
        escaped = re.escape(value)
        if escaped in known:
            continue
        known.add(escaped)
        additions.append(_Secret(length=len(value), pattern=re.compile(escaped)))

    merged = sorted(current + tuple(additions), key=lambda secret: secret.length, reverse=True)
    return _SECRETS.set(tuple(merged))


def discard_secrets(token: Token[tuple[_Secret, ...]] | None = None) -> None:
    """Drop the secrets registered for this invocation (Req 15.10).

    Called when an invocation emits its terminal event. With a `token` the previous
    registry is restored; without one the registry is emptied. A token minted in a
    different context cannot be reset, so that case falls back to emptying — this
    runs on the terminal-event path and must never raise.
    """
    if token is None:
        _SECRETS.set(())
        return
    try:
        _SECRETS.reset(token)
    except ValueError:
        _SECRETS.set(())


def registered_secret_count() -> int:
    """How many patterns the current context holds. For tests and bounded-registry checks."""
    return len(_SECRETS.get())


def scrub(text: str | None) -> str | None:
    """Replace every registered secret in `text` with :data:`SECRET_PLACEHOLDER`.

    `None` passes through as `None`, and text containing no registered secret is
    returned unchanged.
    """
    if text is None:
        return None
    for secret in _SECRETS.get():
        text = secret.pattern.sub(SECRET_PLACEHOLDER, text)
    return text


def scrub_deep(value: object) -> object:
    """Scrub every string inside `value` at every depth of nesting (Req 15.3).

    Walks mappings, sequences and sets, scrubbing mapping **keys** as well as values
    — an Azure error quoted as a key is still a disclosure. Containers are rebuilt
    rather than mutated, so the caller's object is untouched. Non-string scalars pass
    through by identity.
    """
    if isinstance(value, str):
        return scrub(value)
    if isinstance(value, Mapping):
        return {scrub_deep(key): scrub_deep(item) for key, item in value.items()}
    if isinstance(value, (bytes, bytearray)):
        return value
    if isinstance(value, tuple):
        return tuple(scrub_deep(item) for item in value)
    if isinstance(value, Sequence):
        return [scrub_deep(item) for item in value]
    if isinstance(value, frozenset):
        return frozenset(scrub_deep(item) for item in value)
    if isinstance(value, Set):
        return {scrub_deep(item) for item in value}
    return value


def scrub_exception(exc: BaseException) -> str:
    """Format `exc` with every chained cause and context, scrubbed (Req 15.5).

    The chain is walked explicitly through `__cause__` and `__context__` rather than
    left to `traceback`'s own chaining, because `__suppress_context__` would hide a
    link whose message may still carry the secret this function exists to remove.
    Each link is formatted with its own traceback and the whole text is scrubbed
    once.
    """
    parts: list[str] = []
    seen: set[int] = set()
    current: BaseException | None = exc

    while current is not None and id(current) not in seen:
        seen.add(id(current))
        parts.append("".join(traceback.format_exception(current, chain=False)).rstrip("\n"))
        following = current.__cause__ if current.__cause__ is not None else current.__context__
        if following is not None:
            parts.append("The above exception was raised from:")
        current = following

    return scrub("\n".join(parts)) or ""


def presence_marker(secret: str | None) -> str | None:
    """Render a secret for logging as presence and length only (Req 15.4).

    Returns `None` when nothing is set, otherwise a marker such as
    ``"<set:40chars>"``. No character of the secret appears in the result, so this is
    what a formatted runtime context carries in place of a credential.
    """
    if not secret:
        return None
    return f"<set:{len(secret)}chars>"


class RedactionFilter(logging.Filter):
    """A `logging.Filter` that scrubs the current context's secrets from a record.

    Never drops a record — it rewrites it and returns `True`. A record carrying no
    registered secret is left byte-identical, including its lazy `%`-style `args`,
    so ordinary logging is unaffected by installation.
    """

    def filter(self, record: logging.LogRecord) -> bool:  # logging's API
        if not _SECRETS.get():
            return True

        # Format once and compare, rather than scrubbing `msg` and `args`
        # separately: a secret split across the format string and an argument would
        # survive the per-part pass, and collapsing an untouched record's lazy args
        # would change formatting for no reason.
        formatted = record.getMessage()
        scrubbed = scrub(formatted)
        if scrubbed != formatted:
            record.msg = scrubbed
            record.args = None

        if record.exc_info is not None and not record.exc_text:
            record.exc_text = "".join(traceback.format_exception(*record.exc_info))
        if record.exc_text:
            record.exc_text = scrub(record.exc_text)
        if record.stack_info:
            record.stack_info = scrub(record.stack_info)

        return True


def _attach(target: logging.Logger | logging.Handler) -> None:
    if any(isinstance(existing, RedactionFilter) for existing in target.filters):
        return
    target.addFilter(RedactionFilter())


def install_log_redaction() -> None:
    """Attach the filter to the root logger and to every root handler (Req 15.2).

    Idempotent: however many times this runs, each of those targets carries at most
    one :class:`RedactionFilter`. It runs at process start and **again** after the
    invocation `context` is parsed, which is what filters a handler added between
    those two moments — a handler installed later would otherwise emit records that
    never met a filter.
    """
    root = logging.getLogger()
    _attach(root)
    for handler in root.handlers:
        _attach(handler)
