"""Property 5 — registered secrets cannot reach an event, a log record or an error.

**Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.5, 15.9, 15.10, 42.2**
(Requirements 15.6 and 42.1 are the web half of this property, in
`app/lib/aws/redact.property.test.ts`.)

The input space here is adversarial rather than large, which is why this claim is
generated rather than exemplified. Three classes of input break a plausible
implementation and an example test picks none of them by accident:

* **Regex metacharacters.** An Azure client secret routinely contains
  ``. * + ? ( ) [ ] { } | ^ $ \\``. A secret containing ``.*`` interpolated into
  ``re.compile(secret)`` unescaped compiles into a pattern that eats the whole line —
  the secret is replaced, so a naive test passes, while every neighbouring value on
  that line is destroyed. A secret containing an unbalanced ``(`` or ``[`` does not
  compile at all. :data:`SECRET_ALPHABET` draws from exactly that set.
* **Nesting depth.** A scrub that walks only the top level of an event passes a
  hand-written test against a flat error payload and leaks
  ``{"detail": {"request": {"headers": {...}}}}``. Shapes here nest objects and arrays
  1–4 deep and put a secret at every level, in values and in mapping keys.
* **Lengths 0–7.** A registry with no minimum compiles an empty pattern from ``""``,
  and ``re.sub("", "[redacted]", text)`` lands the placeholder between every character
  of the output. A one-character pattern shreds ordinary prose. Neither failure is
  detectable downstream, so the floor is asserted at registration.

**The oracle is `str.replace`, not a second regex.** Every scrub assertion compares
the guard's output against :func:`model_scrub_deep`, which performs the same
longest-first substitution with plain string replacement. A test that only asserted
"the secret is absent" would agree with an over-broad pattern that removed the secret
by removing the line it sat on; comparing against literal replacement is what makes
the escaping load-bearing.
"""

from __future__ import annotations

import logging
import string
from collections.abc import Iterable, Iterator, Sequence
from contextlib import contextmanager
from typing import Any

from hypothesis import assume, example, given
from hypothesis import strategies as st

from reporting_agent.redaction import (
    MIN_SECRET_LENGTH,
    SECRET_PLACEHOLDER,
    RedactionFilter,
    discard_secrets,
    install_log_redaction,
    presence_marker,
    register_secrets,
    registered_secret_count,
    scrub,
    scrub_deep,
    scrub_exception,
)

# --- generators --------------------------------------------------------------------

# Req 15.8 / Property 5.8 names every one of these. `\` is doubled for the Python
# literal and is one character in the alphabet.
REGEX_METACHARACTERS = ".*+?()[]{}|^$\\"

# Alphanumerics and the base64url extras are what a real secret is mostly made of;
# the metacharacters are what break an unescaped pattern. `%` is deliberately absent:
# a `%` inside a `logging` argument is harmless, but one inside a pre-formatted
# message would make the record's own formatting the variable under test rather than
# the redaction.
SECRET_ALPHABET = string.ascii_letters + string.digits + REGEX_METACHARACTERS + "-_~=/"

# Req 15.8's inclusive length range, restated as literals rather than imported from
# the module under test. Generators that read `MIN_SECRET_LENGTH` would retune
# themselves to whatever the implementation currently believes — lower the floor to 0
# and `short_values` becomes an empty range that errors during generation instead of
# failing the property. `test_the_declared_secret_shapes_are_what_they_claim_to_be`
# ties the literal back to the constant, so a changed floor fails one assertion loudly.
SECRET_FLOOR = 8
MAX_SECRET_LENGTH = 128

# Req 15.8 — the inclusive length range 8 to 128.
secret_values = st.text(alphabet=SECRET_ALPHABET, min_size=SECRET_FLOOR, max_size=MAX_SECRET_LENGTH)

# Req 15.9 / Property 5.9 — the inclusive length range 0 to 7.
short_values = st.text(alphabet=SECRET_ALPHABET, min_size=0, max_size=SECRET_FLOOR - 1)

# Ordinary surrounding prose. Unrestricted text, because the claim that clean output
# is untouched is about every string, not only about ASCII ones.
ordinary_text = st.text(max_size=64)

# Req 15.3 / Property 5.3 — depth 1 to 4, in objects and in arrays.
container_shapes = st.lists(st.sampled_from(("object", "array")), min_size=1, max_size=4)


def equal_length_secret_pairs() -> st.SearchStrategy[tuple[str, str]]:
    """Two independently drawn secrets of the *same* length.

    The pair is what makes Property 5.5 a property rather than a restatement of the
    format string: if two different secrets of one length produce one marker, the
    marker cannot be carrying any character of either.
    """
    return st.integers(min_value=SECRET_FLOOR, max_value=MAX_SECRET_LENGTH).flatmap(
        lambda size: st.tuples(
            st.text(alphabet=SECRET_ALPHABET, min_size=size, max_size=size),
            st.text(alphabet=SECRET_ALPHABET, min_size=size, max_size=size),
        )
    )


# Req 15.8 — the two declared values. Their lengths are asserted below rather than
# trusted, because a mistyped literal would silently weaken both declared examples.
AZURE_SHAPED_SECRET = "aB3~.q7-Zx*Kp1_Ld9+Rt5?Nv2(Hj8)Gm4[Wc6]\\"
BASE64URL_SECRET = "7Qw-9xR_3bTsLm2Kd8Yz1Nv5Hj0GpAe4CfIu6Xo-Wq_"

# Two more declared values, each at or above the 8-character floor, each chosen for
# what it does to an unescaped `re.compile(secret)`:
#
# `GREEDY_SECRET` is a pattern whose `.*` spans from the first occurrence to the last,
# so a string carrying the secret twice comes back with **one** placeholder and the
# text between the two occurrences deleted. That is the failure an absence-only
# assertion cannot see: the secret is gone, and so is a neighbouring resource id.
GREEDY_SECRET = "aaa.*aaa"
# `UNCOMPILABLE_SECRET` does not compile at all — an unbalanced group and character
# class — so an unescaped registry raises at registration rather than mis-matching.
UNCOMPILABLE_SECRET = "([{unclosed"


def test_the_declared_secret_shapes_are_what_they_claim_to_be():
    """A guard on the declared `@example` values, not a property.

    40 characters shaped like an Azure client secret and 43 characters of base64url,
    being the unpadded encoding of 32 bytes. Both are obviously not credentials.
    """
    assert len(AZURE_SHAPED_SECRET) == 40
    assert len(BASE64URL_SECRET) == 43
    assert set(BASE64URL_SECRET) <= set(string.ascii_letters + string.digits + "-_")

    # Req 15.8 — the generated alphabet covers every metacharacter named there.
    assert set(REGEX_METACHARACTERS) <= set(SECRET_ALPHABET)
    # The Azure-shaped value carries the subset that an Azure secret actually produces.
    assert set(".*+?()[]\\") <= set(AZURE_SHAPED_SECRET)

    # The generators' literal floor is the implementation's floor. If this fails, the
    # length ranges above no longer straddle the boundary they were written for.
    assert SECRET_FLOOR == MIN_SECRET_LENGTH

    # Every declared value clears the registration floor, or it would be exercising
    # Req 15.9 while claiming to exercise Req 15.3.
    for declared in (AZURE_SHAPED_SECRET, BASE64URL_SECRET, GREEDY_SECRET, UNCOMPILABLE_SECRET):
        assert len(declared) >= SECRET_FLOOR

    # A generated secret cannot be a substring of a presence marker: the marker's only
    # non-digit characters are `<set:chars>`, `<`, `:` and `>` are outside the secret
    # alphabet, and the longest reachable run of marker characters a secret could
    # match — `128chars` — is 8 long, which would require an 8-character secret to
    # report a length of 128. That is what makes the containment assertion in the
    # presence-marker property meaningful rather than coincidental.
    assert not {"<", ":", ">"} & set(SECRET_ALPHABET)


# --- the oracle --------------------------------------------------------------------


def model_scrub(text: str, secrets: Sequence[str]) -> str:
    """Longest-first literal replacement — the model :func:`scrub` must agree with.

    Longest-first for the same reason the implementation sorts that way: when one
    registered secret contains another, replacing the shorter first leaves the
    remainder of the longer one in the output, which is a partial disclosure.
    `sorted` is stable, so equal-length secrets keep registration order in both the
    model and the implementation.
    """
    for secret in sorted(secrets, key=len, reverse=True):
        text = text.replace(secret, SECRET_PLACEHOLDER)
    return text


def model_scrub_deep(value: Any, secrets: Sequence[str]) -> Any:
    """The same replacement over mapping keys, mapping values and sequence items."""
    if isinstance(value, str):
        return model_scrub(value, secrets)
    if isinstance(value, dict):
        return {
            model_scrub_deep(key, secrets): model_scrub_deep(item, secrets)
            for key, item in value.items()
        }
    if isinstance(value, tuple):
        return tuple(model_scrub_deep(item, secrets) for item in value)
    if isinstance(value, list):
        return [model_scrub_deep(item, secrets) for item in value]
    return value


def iter_strings(value: Any) -> Iterator[str]:
    """Every string anywhere in `value`, keys included."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield from iter_strings(key)
            yield from iter_strings(item)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from iter_strings(item)


def build_event(secret: str, token: str, shape: Sequence[str], filler: str) -> dict[str, Any]:
    """An event with a secret at every level of a 1–4 deep object/array nest.

    Both registered values appear at every level, and one of them appears in a
    mapping **key** — an Azure error quoted as a key is still a disclosure. Each level
    also carries a `filler` string that must come back untouched, and the top level
    carries non-string scalars so shape preservation is asserted alongside redaction.
    """
    # The secret appears **twice in one string**, with text between the two
    # occurrences. That is what makes a greedy unescaped pattern visible: `a.*b` spans
    # from the first occurrence to the last, so the guard would emit one placeholder
    # where the model emits two and would delete the words in between.
    node: Any = {
        "message": f"azure rejected {secret} then rejected {secret} again",
        "note": filler,
    }

    for level, kind in enumerate(reversed(tuple(shape))):
        if kind == "object":
            node = {
                f"level_{level}": node,
                f"authorization-{secret}": f"Bearer {token}",
                "note": filler,
            }
        else:
            node = [filler, {"header": f"Bearer {token}"}, node, [f"nested {secret}"]]

    return {
        "type": "error",
        "detail": node,
        "depth": len(tuple(shape)),
        "terminal": False,
        "retry_after": None,
    }


# --- fixtures written as context managers ------------------------------------------
#
# Deliberately not pytest fixtures. A function-scoped fixture is created once per
# test *function*, not once per generated example, so hypothesis raises
# `function_scoped_fixture` — and the profile in `tests/conftest.py` forbids
# suppressing health checks (Req 42.6). These run per example instead.


@contextmanager
def registered(values: Iterable[object]) -> Iterator[None]:
    """Register `values` for the body and tear the registry back down after it.

    The teardown is what keeps one generated example's secrets from scrubbing the
    next one's ordinary output — which is the very failure Req 15.10 describes, so
    building the property on it would be perverse.
    """
    token = register_secrets(values)
    try:
        yield
    finally:
        discard_secrets(token)


class _CapturingHandler(logging.Handler):
    """Collects fully formatted output, so what is asserted is what a handler emits."""

    def __init__(self) -> None:
        super().__init__()
        self.setFormatter(logging.Formatter("%(message)s"))
        self.formatted: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.formatted.append(self.format(record))


@contextmanager
def capturing_root_handler() -> Iterator[_CapturingHandler]:
    """A root handler installed *before* `install_log_redaction`, then restored.

    Order matters and is the point of Req 15.2: the handler is added first and
    `install_log_redaction` runs after, which is what the second installation — the
    one that follows the invocation context parse — exists to cover. A record logged
    on a child logger never meets an *ancestor logger's* filters, only its handlers',
    so a filter attached to the root logger alone would let this record through
    unscrubbed.
    """
    root = logging.getLogger()
    handler = _CapturingHandler()
    previous_filters = list(root.filters)
    previous_level = root.level

    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    install_log_redaction()
    try:
        yield handler
    finally:
        root.removeHandler(handler)
        root.setLevel(previous_level)
        root.filters = previous_filters
        for existing in root.handlers:
            existing.filters = [f for f in existing.filters if not isinstance(f, RedactionFilter)]


def _unentangled_with_the_placeholder(*values: str) -> None:
    """Precondition: no generated value is entangled with the placeholder itself.

    A value that *is* a substring of ``[redacted]`` would make "the secret is absent
    from the scrubbed output" false for a reason that is not a leak — the placeholder
    would be carrying it. A value that *contains* ``[redacted]`` would put the model
    and the implementation on a second replacement pass rather than on escaping.
    Neither is a claim worth testing, and both are rejected at well under 1 percent of
    generated inputs, which keeps this inside the 20 percent ceiling of Req 42.6.

    What this deliberately does **not** reject is two equal draws. Hypothesis reuses a
    previously drawn value on purpose, so `assume(secret != token)` discards better
    than 60 percent of generated inputs — a property reporting green while testing
    almost nothing, which is exactly what Req 42.6 exists to catch. The properties
    below account for the equal case instead of filtering it out.
    """
    for value in values:
        assume(SECRET_PLACEHOLDER not in value)
        assume(value not in SECRET_PLACEHOLDER)


# --- Property 5.1, 5.2, 5.3 --------------------------------------------------------


@given(
    secret=secret_values,
    token=secret_values,
    shape=container_shapes,
    filler=ordinary_text,
)
@example(
    secret=AZURE_SHAPED_SECRET,
    token=BASE64URL_SECRET,
    shape=["object", "object", "object", "object"],
    filler="ordinary prose that must survive",
)
@example(
    secret=AZURE_SHAPED_SECRET,
    token=BASE64URL_SECRET,
    shape=["array", "array", "array", "array"],
    filler="ordinary prose that must survive",
)
@example(
    secret=BASE64URL_SECRET,
    token=AZURE_SHAPED_SECRET,
    shape=["object", "array", "object", "array"],
    filler="",
)
@example(
    secret=GREEDY_SECRET,
    token=BASE64URL_SECRET,
    shape=["object"],
    filler="resource prod-sql-01 in southeastasia",
)
@example(
    secret=UNCOMPILABLE_SECRET,
    token=AZURE_SHAPED_SECRET,
    shape=["array"],
    filler="resource prod-sql-01 in southeastasia",
)
@example(
    # `^` and `$` anchor rather than match a character: unescaped, this pattern finds
    # nothing and the secret is emitted verbatim.
    secret="^anchored$",
    token=BASE64URL_SECRET,
    shape=["object", "array"],
    filler="",
)
@example(
    # One registered secret containing the other, which independent generation never
    # produces. Replacing the shorter first leaves the tail of the longer one in the
    # output — a partial disclosure of a credential, and the reason the registry
    # replaces longest-first.
    secret=BASE64URL_SECRET,
    token=BASE64URL_SECRET + AZURE_SHAPED_SECRET,
    shape=["object", "array", "object"],
    filler="resource prod-sql-01 in southeastasia",
)
def test_both_registered_secrets_are_replaced_at_every_depth(
    secret: str, token: str, shape: list[str], filler: str
) -> None:
    """Req 15.1, 15.3 / Property 5.1, 5.2, 5.3.

    `client_secret` and `token` stand for the two values Req 15.1 requires to carry
    identical sensitivity. Both are replaced by the same placeholder, at every depth
    of objects and arrays, in values and in keys, and the surrounding structure comes
    back exactly as the literal-replacement model says it should.
    """
    _unentangled_with_the_placeholder(secret, token)

    with registered([secret, token]):
        # Two patterns for two distinct values, and one for two equal ones: repeated
        # registration of the same value must not grow the registry (Req 15.10).
        assert registered_secret_count() == (1 if secret == token else 2)

        # Req 15.1 — identical sensitivity, stated as identical output.
        assert scrub(secret) == SECRET_PLACEHOLDER
        assert scrub(token) == SECRET_PLACEHOLDER

        event = build_event(secret, token, shape, filler)
        scrubbed = scrub_deep(event)

        # The whole claim: the guard agrees with literal longest-first replacement.
        # An over-broad pattern removes the secret *and* its neighbours and fails here.
        assert scrubbed == model_scrub_deep(event, [secret, token])

        for text in iter_strings(scrubbed):
            assert secret not in text
            assert token not in text

        # And something was actually replaced, so the assertion above is not passing
        # because the walk found nothing.
        assert any(SECRET_PLACEHOLDER in text for text in iter_strings(scrubbed))

        # The caller's event is rebuilt, never mutated: the unredacted object is
        # still needed for the server-side paths that scrub their own output.
        assert event == build_event(secret, token, shape, filler)


# --- Property 5.4 ------------------------------------------------------------------


@given(secret=secret_values, token=secret_values)
@example(secret=AZURE_SHAPED_SECRET, token=BASE64URL_SECRET)
@example(secret=BASE64URL_SECRET, token=AZURE_SHAPED_SECRET)
def test_exception_text_reaching_an_error_event_carries_the_placeholder(
    secret: str, token: str
) -> None:
    """Req 15.5 / Property 5.4 — the chained cause and the suppressed context both.

    `ValueError` and `RuntimeError` are used rather than, say, `KeyError`, because
    `KeyError.__str__` is the `repr` of its argument: a secret containing a backslash
    would come back escaped, and the property would then be asserting the absence of
    a string the traceback never contained.
    """
    _unentangled_with_the_placeholder(secret, token)

    with registered([secret, token]):
        try:
            try:
                try:
                    raise ValueError(f"context carried {token}")
                except ValueError:
                    # `from None` suppresses the context for `traceback`, not for the
                    # guard — the suppressed link's message still holds a secret.
                    raise RuntimeError(f"cause carried {secret}") from None
            except RuntimeError as cause:
                raise RuntimeError("collection failed") from cause
        except RuntimeError as exc:
            text = scrub_exception(exc)

    assert secret not in text
    assert token not in text
    assert "collection failed" in text
    # One placeholder for the cause's message and one for the suppressed context's.
    assert text.count(SECRET_PLACEHOLDER) >= 2


# --- Property 5.5 ------------------------------------------------------------------

# `<set:` + the decimal length + `chars>` and nothing else.
MARKER_CHARACTERS = frozenset("<set:chars>" + string.digits)


@given(pair=equal_length_secret_pairs())
@example(pair=(AZURE_SHAPED_SECRET, "0" * 40))
@example(pair=(BASE64URL_SECRET, "z" * 43))
@example(pair=(GREEDY_SECRET, "8chars12"))
def test_the_logging_representation_reveals_no_character_of_the_secret(
    pair: tuple[str, str],
) -> None:
    """Req 15.4 / Property 5.5 — presence and length only.

    Two different secrets of one length must produce one marker. That is the
    statement: a marker that varies with content is carrying content.
    """
    first, second = pair
    assert len(first) == len(second)

    first_marker = presence_marker(first)
    second_marker = presence_marker(second)

    assert first_marker == second_marker
    assert first_marker == f"<set:{len(first)}chars>"
    assert first_marker is not None
    assert first not in first_marker
    assert second not in first_marker
    # Every character of the marker comes from the fixed template or the length.
    assert set(first_marker) <= MARKER_CHARACTERS


# --- Property 5.6 ------------------------------------------------------------------


@given(secret=secret_values, token=secret_values)
@example(secret=AZURE_SHAPED_SECRET, token=BASE64URL_SECRET)
@example(secret=GREEDY_SECRET, token=UNCOMPILABLE_SECRET)
def test_a_log_record_reaches_its_handler_carrying_the_placeholder(
    secret: str, token: str
) -> None:
    """Req 15.2, 15.5 / Property 5.6 — through the installed filter, as formatted.

    Three shapes of record, because they fail differently: a pre-formatted message, a
    lazy `%s` argument that only becomes a secret when the record is formatted, and
    exception text attached by `logger.exception`.
    """
    _unentangled_with_the_placeholder(secret, token)

    logger = logging.getLogger("reporting_agent.property.redaction")

    with registered([secret, token]), capturing_root_handler() as handler:
        logger.info("invoking with " + secret)
        logger.info("callback authorized by %s", token)
        try:
            raise ValueError(f"azure rejected {secret}")
        except ValueError:
            logger.exception("collection failed for %s", token)

    both = [secret, token]

    assert len(handler.formatted) == 3
    for line in handler.formatted:
        assert secret not in line
        assert token not in line
        assert SECRET_PLACEHOLDER in line

    # Compared against literal replacement, not against a hand-written expectation,
    # for the same reason the deep scrub is: an over-broad pattern would also remove
    # the secret, and would take "invoking with" along with it.
    assert handler.formatted[0] == model_scrub("invoking with " + secret, both)
    assert handler.formatted[1] == model_scrub("callback authorized by " + token, both)
    # The traceback text, not only the message, is scrubbed.
    assert "ValueError" in handler.formatted[2]
    assert model_scrub(f"azure rejected {secret}", both) in handler.formatted[2]


# --- Property 5.7 ------------------------------------------------------------------


@given(secret=secret_values, text=ordinary_text)
@example(secret=AZURE_SHAPED_SECRET, text="collected 200 resources")
@example(secret=BASE64URL_SECRET, text="")
@example(secret=GREEDY_SECRET, text="aaa bbb aaa")
def test_text_carrying_no_registered_secret_is_returned_unchanged(
    secret: str, text: str
) -> None:
    """Req 15.7 first half / Property 5.7 — registration does not perturb clean output.

    The clean text is **constructed** rather than filtered for. `assume(secret not in
    text)` discards better than 20 percent of generated inputs, because hypothesis
    reuses a previously drawn value on purpose — and a property rejecting that much is
    a suite failure under Req 42.6. Removing the occurrences instead keeps every
    generated input, and removing them repeatedly matters: deleting one occurrence can
    join its neighbours into a new one.
    """
    clean = text
    while secret in clean:
        clean = clean.replace(secret, "")

    with registered([secret]):
        assert secret not in clean
        assert scrub(clean) == clean
        assert scrub(clean).count(SECRET_PLACEHOLDER) == clean.count(SECRET_PLACEHOLDER)
        assert scrub_deep({"note": clean, "trail": [clean]}) == {
            "note": clean,
            "trail": [clean],
        }


@given(secret=secret_values, text=ordinary_text)
@example(secret=AZURE_SHAPED_SECRET, text="a later customer's own prose mentioning ")
@example(secret=BASE64URL_SECRET, text="")
def test_a_terminated_invocations_secret_does_not_scrub_a_later_invocation(
    secret: str, text: str
) -> None:
    """Req 15.10 / Property 5.7 second half — the registry is discarded at the terminal event.

    A module-level set would pass every other property in this file and fail this
    one: the pattern outlives the invocation that registered it and keeps rewriting a
    later invocation's ordinary output, which by then may legitimately contain that
    string.
    """
    assume(SECRET_PLACEHOLDER not in secret)
    assume(secret not in SECRET_PLACEHOLDER)

    token = register_secrets([secret])
    try:
        assert registered_secret_count() == 1
        assert scrub(f"x={secret}") == f"x={SECRET_PLACEHOLDER}"
    finally:
        discard_secrets(token)

    assert registered_secret_count() == 0

    later = f"{text}{secret}{text}"
    assert scrub(later) == later
    assert scrub_deep({"note": [later, {"deeper": later}]}) == {
        "note": [later, {"deeper": later}]
    }


# --- Property 5.9 ------------------------------------------------------------------


@given(
    short=short_values,
    text=ordinary_text,
    shape=container_shapes,
    filler=ordinary_text,
)
@example(short="", text="collected 200 resources", shape=["object"], filler="")
@example(short="a", text="aaaaaaa", shape=["array"], filler="a")
@example(short="1234567", text="run 1234567 finished", shape=["object", "array"], filler="1234567")
@example(short=".*", text="99.5% of 200 resources", shape=["object"], filler=".*")
@example(short="\\", text="C:\\path\\to\\file", shape=["array"], filler="\\")
def test_a_value_shorter_than_eight_characters_registers_nothing(
    short: str, text: str, shape: list[str], filler: str
) -> None:
    """Req 15.9 / Property 5.9 — no pattern, no placeholder, no mangled prose.

    The empty string is the case that matters: `re.sub("", "[redacted]", text)` puts
    the placeholder between every character of the output, so a registry with no
    minimum destroys every event it touches while still passing any test that only
    checks the secret is gone.
    """
    with registered([short]):
        assert registered_secret_count() == 0

        assert scrub(text) == text
        assert scrub(text).count(SECRET_PLACEHOLDER) == text.count(SECRET_PLACEHOLDER)

        event = build_event(short, short, shape, filler)
        assert scrub_deep(event) == event

        # And the same through the logging filter, which is the other egress.
        logger = logging.getLogger("reporting_agent.property.redaction")
        with capturing_root_handler() as handler:
            logger.info("phase %s", text)

        assert handler.formatted == [f"phase {text}"]


@given(shorts=st.lists(short_values, max_size=8))
@example(shorts=[""])
@example(shorts=["", "a", "ab", "abc", "abcd", "abcde", "abcdef", "1234567"])
def test_no_number_of_short_values_ever_registers_a_pattern(shorts: list[str]) -> None:
    """Req 15.9 — the floor is not a first-value special case."""
    with registered(shorts):
        assert registered_secret_count() == 0
