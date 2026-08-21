"""The one numeric-leaf reader: a raw JSON-decoded leaf as a `Decimal`, or `None`.

One function, moved here verbatim from `azure/metrics.py` — which re-exports it as
`_as_decimal = decimal_leaf`, so every existing caller and every existing test is
untouched by the move.

**Why it is its own module rather than a helper inside the collector that happens to
need it.** The same leaf is read on both sides of `collect/archive.py`: live collection
reads what the SDK deserialized, and `verify/replay.py` reads what `json.loads` gave
back from the archived object. Those are the *same* value in two type forms, so they
must be one reader — a second reader is a second opinion about what "absent" means, and
the digest replay compares is computed from that opinion. The month the archive was
write-only, recorded in :func:`decimal_leaf`'s own docstring, is what one reader
disagreeing with itself across the archive boundary actually costs.

Placing it under `collect/` rather than `azure/` is what lets the replay side reach it:
`verify/replay.py`'s transitive first-party import closure may reach no `azure.*`
module, and `tests/test_boundaries.py` asserts exactly that. A reader living in
`azure/metrics.py` could be called by replay only through a module replay is forbidden
to import.

**Pure.** No clock, no network, no object store, no logging.

`tests/test_boundaries.py`'s one-numeric-leaf-reader rule keeps this module the only
place under `collect/`, `azure/` or `verify/` that builds a `Decimal` out of a value
read from a response mapping. The rule is the static half; the behavioural half is a
counting wrapper over this function asserting a live pass and a replay both route every
numeric leaf through it, because a static assertion that a module imports the symbol
would pass against a module that imported it and then parsed inline anyway.
"""

from __future__ import annotations

from decimal import Decimal, InvalidOperation

__all__ = ["decimal_leaf"]


def decimal_leaf(value: object) -> Decimal | None:
    """A raw JSON-decoded numeric leaf (`int`, `float`, `str`, or already `Decimal`) as
    a `Decimal`, or `None` for anything else. **Pure.**

    `Decimal(str(value))` for a `float` rather than `Decimal(value)` — the same
    reasoning `collect/sketch.py`'s `_quantile_as_decimal` and the Azure SDK's own
    model deserializer (`azure/monitor/querymetrics/_utils/model_base.py`) both apply:
    it round-trips the digit string a JSON decoder produced rather than the value's
    nearest binary fraction. A concrete `MetricsPort` backed by the real SDK hands
    back `Decimal` already for these fields (the SDK deserializes them that way), so
    this function is the seam that also accepts the plain `int`/`float` a recorded
    JSON fixture parses to.

    ## A decimal **string** is accepted, and the archive is why

    This is the reader on both sides of `collect/archive.py`. The SDK hands live
    collection a `Decimal`; the archive serializes that Decimal to its exact digit
    string (`archive._json_default`, deliberately, so no precision is lost to a float);
    and `verify/replay.py` re-reads the archive with a plain `json.loads`, which yields
    that digit string back as a `str`.

    Refusing `str` here made the archive **write-only**. The value survived the round
    trip perfectly and its only reader then classified it as absent: every interval
    carrying a fractional total became an `interval_counts_missing` gap on replay, its
    samples vanished from the count, and the recomputed digest could not match. Observed
    on the first live run to reach verification — the three metrics whose totals are
    whole byte counts replayed exactly, and the five with fractional values did not,
    which is what a type-dependent fault looks like when it is mistaken for a positional
    one.

    A decimal string is also the canonical numeric form everywhere else in this system
    (Req 30 stores every snapshot value as one), so accepting it here is not a widening
    of what a numeric leaf may be — it is this function finally admitting the form the
    rest of the pipeline already agreed on.

    A `str` that does not parse is still `None`: a malformed body must classify as a
    gap, not raise mid-fold.
    """
    if isinstance(value, Decimal):
        return value
    if isinstance(value, bool):
        return None
    if isinstance(value, int | float):
        return Decimal(str(value))
    if isinstance(value, str):
        try:
            return Decimal(value)
        except InvalidOperation:
            return None
    return None
