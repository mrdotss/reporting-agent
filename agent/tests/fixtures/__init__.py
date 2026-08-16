"""Recorded Azure responses, and the loader that replays them.

**The convention, established here because tasks 11.1–11.10 reuse it.** A recorded
response is one JSON file holding the *whole* HTTP answer, not just its body:

```jsonc
{
  "comment": "why this fixture exists, and what it must keep proving",
  "status": 200,
  "headers": {"content-type": "application/json", "x-ms-user-quota-remaining": "14"},
  "body": { ... exactly what Azure returned ... }
}
```

`status` and `headers` are part of the recording rather than arguments a test passes in,
because several of the behaviours these fixtures exist to pin down live **in the envelope
and not in the body**: a `403` on the subscription-scope permissions call,
`x-ms-user-quota-remaining` at `0` with its `x-ms-user-quota-resets-after` partner,
`Retry-After` on a 429 as seconds and as an HTTP-date. A fixture format that recorded only
bodies would push those facts back into test code, where they stop being *recorded* and
become *asserted from memory* — which is the failure mode the whole recording idea exists
to avoid.

`comment` is required and travels with the data. A fixture nobody can explain is a fixture
the next person edits until their test passes.

`body` may be `null`, which is how a non-JSON or truncated body is recorded — a distinct
fact from `{}`, and one the preflight decision deliberately treats as "no proven read".

Fixtures are grouped by area (`azure/…`), and `load_response` appends `.json` for you, so a
call site reads as `load_response("azure", "permissions_subscription_reader")`.

Nothing here reaches a network, a tenant or an Azure SDK. These are files on disk.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

__all__ = [
    "FIXTURE_ROOT",
    "RecordedResponse",
    "available",
    "fixture_path",
    "load_json",
    "load_response",
]

FIXTURE_ROOT: Final[Path] = Path(__file__).resolve().parent
"""Anchored to this file, not to the working directory, so the fixtures load the same way
however pytest was invoked — the same reasoning as the hypothesis database in
`tests/conftest.py`."""

_SUFFIX: Final[str] = ".json"


@dataclass(frozen=True, slots=True)
class RecordedResponse:
    """One recorded HTTP answer: status, headers, body — plus where it came from.

    Frozen, because a test that mutates a shared recording changes what a later test
    replays. `name` is carried so an assertion failure names the file rather than leaving
    the reader to guess which of nine fixtures produced the value.
    """

    name: str
    comment: str
    status: int
    headers: Mapping[str, str]
    body: object

    def header(self, name: str) -> str | None:
        """A header by name, case-insensitively.

        HTTP header names are case-insensitive and the recordings preserve whatever casing
        Azure sent, so a lookup that respected case would miss `Retry-After` recorded as
        `retry-after`.
        """
        lowered = name.lower()
        for key, value in self.headers.items():
            if key.lower() == lowered:
                return value
        return None

    @property
    def ok(self) -> bool:
        return 200 <= self.status < 300


def fixture_path(*parts: str) -> Path:
    """The path to a fixture, with `.json` appended if it was left off.

    Refuses to leave `FIXTURE_ROOT`: a fixture name is a path segment, and a test that can
    reach `../../src` through this helper is reading the code it is meant to be checking.
    """
    if not parts:
        raise ValueError("a fixture needs at least one path segment")

    segments = list(parts)
    if not segments[-1].endswith(_SUFFIX):
        segments[-1] = f"{segments[-1]}{_SUFFIX}"

    candidate = FIXTURE_ROOT.joinpath(*segments)
    resolved = candidate.resolve()
    if not resolved.is_relative_to(FIXTURE_ROOT):
        raise ValueError(f"a fixture path must stay under {FIXTURE_ROOT}: {candidate}")

    if not resolved.is_file():
        raise FileNotFoundError(
            f"no recorded fixture at {resolved.relative_to(FIXTURE_ROOT).as_posix()!r}. "
            f"Available in that directory: {available(*segments[:-1]) or '(none)'}"
        )
    return resolved


def available(*parts: str) -> tuple[str, ...]:
    """The fixture names in one directory, sorted. Used in the not-found message above."""
    directory = FIXTURE_ROOT.joinpath(*parts)
    if not directory.is_dir():
        return ()
    return tuple(sorted(path.stem for path in directory.glob(f"*{_SUFFIX}")))


def load_json(*parts: str) -> Any:
    """The parsed JSON of a fixture file, whatever its shape.

    For a recorded HTTP response prefer :func:`load_response`, which validates the
    envelope. This is the escape hatch for a fixture that is not a response at all.
    """
    path = fixture_path(*parts)
    with path.open(encoding="utf-8") as handle:
        return json.load(handle)


def load_response(*parts: str) -> RecordedResponse:
    """A recorded HTTP response, validated against the convention above.

    The validation is deliberately strict and runs at load time. A recording missing its
    `status` or its `comment` would otherwise surface as a confusing failure inside
    whichever test replayed it, several layers from the file that is actually wrong.
    """
    path = fixture_path(*parts)
    name = path.relative_to(FIXTURE_ROOT).as_posix()
    raw = load_json(*parts)

    if not isinstance(raw, dict):
        raise ValueError(f"{name}: a recorded response must be a JSON object")

    missing = [key for key in ("comment", "status", "body") if key not in raw]
    if missing:
        raise ValueError(
            f"{name}: a recorded response needs {missing} — `comment` explains why the "
            f"fixture exists, `status` and `body` are what Azure answered (`body` may be "
            f"null, which records a non-JSON or truncated body)"
        )

    comment = raw["comment"]
    if not isinstance(comment, str) or not comment.strip():
        raise ValueError(f"{name}: `comment` must be a non-empty string")

    status = raw["status"]
    if not isinstance(status, int) or isinstance(status, bool):
        raise ValueError(f"{name}: `status` must be an integer, got {status!r}")

    headers = raw.get("headers", {})
    if not isinstance(headers, dict) or not all(
        isinstance(key, str) and isinstance(value, str) for key, value in headers.items()
    ):
        raise ValueError(f"{name}: `headers` must be a string-to-string object")

    return RecordedResponse(
        name=name,
        comment=comment,
        status=status,
        headers=dict(headers),
        body=raw["body"],
    )
