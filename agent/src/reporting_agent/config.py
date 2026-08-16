"""Process configuration, read from the environment exactly once (Req 14.12, 14.16).

`main.py` builds one `Config` at import:

    CONFIG = Config.from_env()

and nothing in the package reads `os.environ` afterwards. Two properties make that
worth enforcing rather than merely intending:

* **Frozen.** A run's behaviour must not depend on when a value was read. `Config` is
  a frozen, slotted dataclass, so assigning to a field, deleting a field, and
  inventing a new attribute all raise (Req 14.12). A collector that could rewrite its
  own bucket mid-run is a collector whose artifacts cannot be located afterwards.
* **Named, valueless failure.** An absent or blank variable raises
  `MissingConfigError` naming the variable and excluding its value (Req 14.16), at
  process start rather than three frames into boto3 with a `None`.

**What is deliberately not here.** The Azure `tenant_id`, `client_id` and
`client_secret` come from the invocation `context`, never from the environment
(Req 19.7) — a run must never authenticate as the container's own identity. So do
`progress_url`, `progress_token`, `run_id` and `actor_id`: they are per-invocation,
so an environment variable is the wrong lifetime for them. `PORT` belongs to
`BedrockAgentCoreApp`, which reads it itself.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

# Resolution order. `from_env` walks this tuple, so a container missing several
# variables is told about the first one here and the message is stable machine to
# machine. The first two are also in the web app's `REQUIRED_ENV_VARS` (Req 5.4) — the
# two halves read the same region and the same bucket, by name.
#
# `RPT_PROSE_MODEL_ID` is agent-only and stays out of `app/.env.example`: a foundation
# guard asserts that file's key set *equals* the app's own required set, so an
# agent-side variable there fails the guard. It is declared here, and in
# `agent/.env.example`, and nowhere else.
REQUIRED_ENV_VARS: Final[tuple[str, ...]] = (
    "AWS_REGION",
    "RPT_ARTIFACT_BUCKET",
    "RPT_PROSE_MODEL_ID",
)


class MissingConfigError(RuntimeError):
    """A required variable is absent, empty, or whitespace-only.

    The constructor takes the variable's **name and nothing else**, so the value is
    never in scope to be interpolated into a message (Req 14.16). `variable_name` is
    carried as a field so a caller can branch on which variable is missing without
    parsing English.
    """

    variable_name: str

    def __init__(self, variable_name: str) -> None:
        super().__init__(
            f"{variable_name} is not set, or is set to an empty or whitespace-only "
            f"value. Set it in the container environment; agent/README.md describes "
            f"the expected shape. Its value is excluded from this message."
        )
        self.variable_name = variable_name


def _require(source: Mapping[str, str], name: str) -> str:
    """Resolve one required variable, or raise `MissingConfigError`.

    Absent, the empty string and whitespace-only are one deployment mistake with
    three spellings — an unset shell export, a `.env` line with nothing after the
    `=`, and a stray space — and none of them is a usable region or bucket name.

    The value is returned **verbatim**. Rejecting blank input is a validity gate, not
    a normalization step, and this module has no basis for deciding a caller's value
    should be trimmed.
    """
    value = source.get(name)

    if value is None or value.strip() == "":
        raise MissingConfigError(name)

    return value


@dataclass(frozen=True)
class Config:
    """The runtime's configuration, built once and immutable thereafter.

    `__slots__` is declared by hand rather than through `@dataclass(slots=True)`, and
    the difference is observable. `slots=True` re-creates the class, which leaves the
    generated `__setattr__` closed over the *original* class; its `type(self) is cls`
    test then fails, and assigning an attribute that is not a field raises
    `TypeError: super(type, obj): obj must be an instance or subtype of type` instead of
    `FrozenInstanceError`. Declaring the slots directly keeps one class, so **every**
    mutation path — a field, a mistyped field, a deletion — raises `FrozenInstanceError`
    naming the attribute (Req 14.12), and instances still carry no `__dict__`.

    Adding a field means adding its slot. Forgetting raises `AttributeError` on the
    first construction, which is as loud as a failure gets.
    """

    __slots__ = ("artifact_bucket", "aws_region", "prose_model_id")

    aws_region: str
    """Region for the S3 artifact writes and for every other AWS client."""

    artifact_bucket: str
    """`RPT_ARTIFACT_BUCKET` — snapshots and the raw archive, under an `actor_id`
    prefix. The bucket name only; the key layout lives in `storage/`."""

    prose_model_id: str
    """`RPT_PROSE_MODEL_ID` — the Bedrock model that writes narrative prose, and only
    prose (Req 19.1, 19.2). Required rather than defaulted: a silently substituted model
    id changes the wording of a delivered document without appearing in any diff."""

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> Config:
        """Read every required variable and return a frozen `Config`.

        Call this **once**, at process start. `env` defaults to `os.environ` and
        exists so a test can supply a mapping without mutating the process
        environment; production passes nothing.
        """
        source = os.environ if env is None else env

        # Arguments evaluate left to right, so this order is the resolution order and
        # must match REQUIRED_ENV_VARS. `test_resolution_follows_declared_order` pins it.
        return cls(
            aws_region=_require(source, "AWS_REGION"),
            artifact_bucket=_require(source, "RPT_ARTIFACT_BUCKET"),
            prose_model_id=_require(source, "RPT_PROSE_MODEL_ID"),
        )
