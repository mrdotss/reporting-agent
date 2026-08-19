"""`Config` — one frozen read of the environment at process start (Req 14.12, 14.16)."""

from __future__ import annotations

import dataclasses
import inspect
from pathlib import Path

import pytest

from reporting_agent.config import (
    OPTIONAL_ENV_VARS,
    REQUIRED_ENV_VARS,
    Config,
    MissingConfigError,
    _require,
)

FULL_ENV = {
    "AWS_REGION": "us-east-1",
    "RPT_ARTIFACT_BUCKET": "rpt-artifacts-prod",
    "RPT_PROSE_MODEL_ID": "anthropic.claude-sonnet-4-5-20250929-v1:0",
}

# Whitespace only, but built from characters distinctive enough to search a message
# for. `\u00a0` is whitespace to `str.strip()`, which is what makes it a valid
# whitespace-only case rather than a usable value.
BLANK_BUT_FINDABLE = "\u00a0\t \u2003"

BLANK_VALUES = ["", " ", "\t", "\n", "   \t\n ", BLANK_BUT_FINDABLE]

AGENT_ROOT = Path(__file__).resolve().parent.parent
ENV_EXAMPLE = AGENT_ROOT / ".env.example"


def test_required_env_vars_is_the_declared_set_in_order() -> None:
    # Order is load-bearing: `from_env` resolves in this order, so a container missing
    # all three variables is told about the first one here.
    assert REQUIRED_ENV_VARS == (
        "AWS_REGION",
        "RPT_ARTIFACT_BUCKET",
        "RPT_PROSE_MODEL_ID",
    )


def test_full_env_covers_exactly_the_required_set() -> None:
    # Every other test in this file builds on FULL_ENV, so a variable added to
    # REQUIRED_ENV_VARS without a value here would make the blank-value cases below pass
    # for the wrong reason — they would all be raising on the *new* variable.
    assert tuple(FULL_ENV) == REQUIRED_ENV_VARS


def test_env_example_declares_exactly_the_required_set_with_placeholders() -> None:
    # `agent/.env.example` is the deployment-facing copy of REQUIRED_ENV_VARS, and it is
    # the agent's own file: RPT_PROSE_MODEL_ID is agent-side, so it must not appear in
    # `app/.env.example`, where a guard asserts that file's keys equal the *app's*
    # required set.
    declared = {}

    for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()

        if stripped == "" or stripped.startswith("#"):
            continue

        name, _, value = stripped.partition("=")
        declared[name] = value

    # Required **and** optional: the file is the deployment-facing declaration, so a
    # variable the runtime reads and the file omits is one an operator cannot discover,
    # and a variable the file declares and the runtime ignores is a lie. Equality in both
    # directions is what keeps it honest — an optional variable is still pinned to a
    # declaration rather than being a licence to read arbitrary environment.
    assert tuple(declared) == REQUIRED_ENV_VARS + OPTIONAL_ENV_VARS

    # A placeholder that is itself blank would be a `.env` line with nothing after the
    # `=` once copied — exactly the deployment mistake `_require` exists to reject.
    for name, value in declared.items():
        assert value.strip() != "", name


def test_from_env_returns_every_value_verbatim() -> None:
    config = Config.from_env(FULL_ENV)

    assert config.aws_region == "us-east-1"
    assert config.artifact_bucket == "rpt-artifacts-prod"
    assert config.prose_model_id == FULL_ENV["RPT_PROSE_MODEL_ID"]


def test_from_env_does_not_trim_a_usable_value() -> None:
    # Rejecting blank input is a validity gate, not a normalization step. A bucket name
    # that arrives padded is the caller's problem to see, not this module's to hide.
    config = Config.from_env({**FULL_ENV, "RPT_ARTIFACT_BUCKET": " padded "})

    assert config.artifact_bucket == " padded "


@pytest.mark.parametrize("name", REQUIRED_ENV_VARS)
def test_absent_variable_raises_naming_it(name: str) -> None:
    env = {key: value for key, value in FULL_ENV.items() if key != name}

    with pytest.raises(MissingConfigError) as raised:
        Config.from_env(env)

    assert raised.value.variable_name == name
    assert name in str(raised.value)


@pytest.mark.parametrize("name", REQUIRED_ENV_VARS)
@pytest.mark.parametrize("blank", BLANK_VALUES)
def test_empty_or_whitespace_only_variable_raises_naming_it(
    name: str, blank: str
) -> None:
    # An unset export, a `.env` line with nothing after the `=`, and a stray space are
    # one deployment mistake with three spellings.
    with pytest.raises(MissingConfigError) as raised:
        Config.from_env({**FULL_ENV, name: blank})

    assert raised.value.variable_name == name
    assert name in str(raised.value)


def test_error_excludes_the_variables_value() -> None:
    with pytest.raises(MissingConfigError) as raised:
        Config.from_env({**FULL_ENV, "AWS_REGION": BLANK_BUT_FINDABLE})

    message = str(raised.value)

    assert "AWS_REGION" in message
    assert BLANK_BUT_FINDABLE not in message
    assert repr(BLANK_BUT_FINDABLE) not in message


def test_error_constructor_cannot_receive_a_value() -> None:
    # The strongest form of "excludes the value": the value is never in scope to be
    # interpolated. Half of the app's required set is a credential, and this is the
    # constructor shape that keeps a "malformed value: …" message from ever existing.
    parameters = list(inspect.signature(MissingConfigError.__init__).parameters)

    assert parameters == ["self", "variable_name"]


def test_resolution_follows_declared_order() -> None:
    # Everything missing at once: the error names the first declared variable, so the
    # message is stable across machines rather than following dict order.
    with pytest.raises(MissingConfigError) as raised:
        Config.from_env({})

    assert raised.value.variable_name == REQUIRED_ENV_VARS[0]


def test_missing_config_error_is_not_swallowed_by_an_except_exception_handler() -> None:
    assert issubclass(MissingConfigError, RuntimeError)


def test_from_env_reads_os_environ_by_default(monkeypatch: pytest.MonkeyPatch) -> None:
    for name, value in FULL_ENV.items():
        monkeypatch.setenv(name, value)

    config = Config.from_env()

    assert config.aws_region == FULL_ENV["AWS_REGION"]
    assert config.artifact_bucket == FULL_ENV["RPT_ARTIFACT_BUCKET"]
    assert config.prose_model_id == FULL_ENV["RPT_PROSE_MODEL_ID"]


def test_from_env_raises_when_os_environ_is_missing_a_variable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("AWS_REGION", "us-east-1")
    monkeypatch.delenv("RPT_ARTIFACT_BUCKET", raising=False)

    with pytest.raises(MissingConfigError) as raised:
        Config.from_env()

    assert raised.value.variable_name == "RPT_ARTIFACT_BUCKET"


def test_explicit_mapping_is_used_instead_of_the_process_environment(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in REQUIRED_ENV_VARS:
        monkeypatch.delenv(name, raising=False)

    config = Config.from_env(FULL_ENV)

    assert config.aws_region == "us-east-1"


def test_field_assignment_is_rejected() -> None:
    config = Config.from_env(FULL_ENV)

    with pytest.raises(dataclasses.FrozenInstanceError):
        config.artifact_bucket = "someone-elses-bucket"  # type: ignore[misc]

    assert config.artifact_bucket == "rpt-artifacts-prod"


def test_field_deletion_is_rejected() -> None:
    config = Config.from_env(FULL_ENV)

    with pytest.raises(dataclasses.FrozenInstanceError):
        del config.aws_region  # type: ignore[misc]

    assert config.aws_region == "us-east-1"


def test_a_new_attribute_cannot_be_attached() -> None:
    # A mistyped field name is a mutation attempt too, and it gets the same
    # FrozenInstanceError as a real field. This is the test that pins the hand-written
    # `__slots__`: under `@dataclass(slots=True)` this same line raises an inscrutable
    # `TypeError: super(type, obj): obj must be an instance or subtype of type`, because
    # the generated `__setattr__` closes over the class that `slots=True` replaced.
    config = Config.from_env(FULL_ENV)

    with pytest.raises(dataclasses.FrozenInstanceError) as raised:
        config.artifact_bucket_override = "elsewhere"  # type: ignore[attr-defined]

    assert "artifact_bucket_override" in str(raised.value)


def test_instances_carry_no_dict_to_write_into() -> None:
    config = Config.from_env(FULL_ENV)

    assert not hasattr(config, "__dict__")

    # The frozen `__setattr__` bypass still finds nowhere to put the value.
    with pytest.raises(AttributeError):
        object.__setattr__(config, "smuggled", "value")


def test_replace_produces_a_new_object_rather_than_mutating() -> None:
    config = Config.from_env(FULL_ENV)

    other = dataclasses.replace(config, aws_region="ap-southeast-3")

    assert config.aws_region == "us-east-1"
    assert other.aws_region == "ap-southeast-3"
    assert other is not config


def test_require_returns_the_value_and_rejects_blanks() -> None:
    assert _require({"X": "value"}, "X") == "value"

    for blank in BLANK_VALUES:
        with pytest.raises(MissingConfigError):
            _require({"X": blank}, "X")
