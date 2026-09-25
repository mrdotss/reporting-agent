"""One assumed-role session per invocation, refreshed before it expires.

The runtime's own credentials are themselves a role session, so assuming the customer's role
from them is **role chaining**, which AWS caps at one hour however long the role's maximum
session is. A report run can outlast that, so the credentials are refreshable: botocore
re-assumes the role shortly before expiry, transparently to every client built from the
session.

Three properties matter.

**Only our role, in the customer's account.** The ARN must be exactly
`arn:aws:iam::<12 digits>:role/reporting-agent/ReportingAgentReader`. The runtime's own IAM
policy allows assuming nothing else, and checking here as well means a malformed or hostile
ARN is refused with a clear message before a request is made.

**Nothing is held across invocations.** A module-level cache keyed by account would be one
customer's session presented against another customer's account. Each call builds a new
session, and nothing here is stored at module scope.

**An unassumable role is `AUTH_FAILED`.** The two common causes — the role was not created
yet, or its trust names a different external id — both surface from STS as `AccessDenied`,
and the message says what to check rather than which of them it was, because STS does not
say either.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from functools import cache
from importlib import resources
from typing import Any, Final

from reporting_agent.errors import AuthFailedError

__all__ = [
    "ROLE_NAME",
    "ROLE_PATH",
    "assume_reader_role",
    "reader_policy",
    "reader_role_arn",
    "required_actions",
    "validate_role_arn",
]


@cache
def reader_policy() -> dict[str, Any]:
    """`reader_policy.v1.json`, the one statement of what the customer grants."""
    text = resources.files("reporting_agent.aws").joinpath("reader_policy.v1.json").read_text("utf-8")
    return json.loads(text)


ROLE_PATH: Final[str] = reader_policy()["role_path"]
ROLE_NAME: Final[str] = reader_policy()["role_name"]
SESSION_SECONDS: Final[int] = reader_policy()["max_session_seconds"]

_ACCOUNT_ID: Final[re.Pattern[str]] = re.compile(r"^\d{12}$")
_SESSION_NAME_UNSAFE: Final[re.Pattern[str]] = re.compile(r"[^\w+=,.@-]")


def required_actions(*, self_only: bool | None = None) -> tuple[str, ...]:
    """Every action the role must allow, in the policy file's order.

    `self_only=True` gives the actions granted on the role's own ARN only (the policy
    simulation must evaluate those against that ARN, not `*`); `False` gives the rest.
    """
    return tuple(
        action
        for statement in reader_policy()["statements"]
        if self_only is None or bool(statement.get("self_only")) == self_only
        for action in statement["actions"]
    )


def reader_role_arn(account_id: str) -> str:
    return f"arn:aws:iam::{account_id}:role{ROLE_PATH}{ROLE_NAME}"


def validate_role_arn(role_arn: object, account_id: object) -> str:
    """The role ARN, if it is our reader role in `account_id`; otherwise `AuthFailedError`."""
    if not isinstance(account_id, str) or not _ACCOUNT_ID.match(account_id):
        raise AuthFailedError("The AWS account id must be 12 digits.")
    if role_arn != reader_role_arn(account_id):
        raise AuthFailedError(
            f"The connector must use the {ROLE_NAME} role at path {ROLE_PATH} in account "
            f"{account_id}; any other role is refused."
        )
    return role_arn


def _session_name(actor_id: str) -> str:
    """Shown in the customer's CloudTrail, so it names us. At most 64 characters."""
    safe = _SESSION_NAME_UNSAFE.sub("-", actor_id)[:40]
    return f"reporting-agent-{safe}" if safe else "reporting-agent"


def assume_reader_role(
    *,
    role_arn: str,
    external_id: str,
    account_id: str,
    actor_id: str,
    region: str,
    sts_client: Any | None = None,
) -> Any:
    """A `boto3.Session` acting as the customer's reader role, with refreshable credentials.

    Assumes once immediately, so a role that cannot be assumed fails here with
    `AUTH_FAILED` instead of inside the first client call. `sts_client` is a test seam.
    """
    import boto3
    from botocore.credentials import RefreshableCredentials
    from botocore.exceptions import BotoCoreError, ClientError
    from botocore.session import get_session

    validate_role_arn(role_arn, account_id)
    if not isinstance(external_id, str) or not external_id.strip():
        raise AuthFailedError("The connector has no external id, so its role cannot be assumed.")

    sts = sts_client or boto3.client("sts", region_name=region)
    name = _session_name(actor_id)

    def fetch() -> dict[str, str]:
        answer = sts.assume_role(
            RoleArn=role_arn,
            RoleSessionName=name,
            ExternalId=external_id,
            DurationSeconds=SESSION_SECONDS,
        )
        credentials = answer["Credentials"]
        return {
            "access_key": credentials["AccessKeyId"],
            "secret_key": credentials["SecretAccessKey"],
            "token": credentials["SessionToken"],
            "expiry_time": credentials["Expiration"].isoformat(),
        }

    try:
        metadata = fetch()
    except ClientError as exc:
        code = exc.response.get("Error", {}).get("Code", "")
        raise AuthFailedError(
            f"AWS refused to let the reporting agent assume {role_arn} ({code}). Check that "
            "the role exists in that account, and that its trust policy names the reporting "
            "agent and this connector's external id exactly as the setup template wrote them."
        ) from None
    except BotoCoreError as exc:
        raise AuthFailedError(
            f"The reporting agent could not reach AWS STS to assume the role ({type(exc).__name__})."
        ) from None

    credentials = RefreshableCredentials.create_from_metadata(
        metadata=metadata, refresh_using=fetch, method="sts-assume-role"
    )
    core = get_session()
    core._credentials = credentials  # botocore's documented-by-use hook for injected credentials
    core.set_config_variable("region", region)
    return boto3.Session(botocore_session=core)


ClientFactory = Callable[[str, str], Any]
"""`(service, region) -> client`, the seam `preflight.py` and `inventory.py` take."""


def client_factory(session: Any) -> ClientFactory:
    """Clients from one session, with adaptive retries so a throttle backs off."""
    from botocore.config import Config

    config = Config(retries={"mode": "adaptive", "max_attempts": 6}, connect_timeout=5, read_timeout=20)

    def make(service: str, region: str) -> Any:
        return session.client(service, region_name=region, config=config)

    return make
