"""The AWS preflight: prove the grant, list the regions, probe fidelity.

The Azure preflight answers "is there read at subscription scope?" from Azure's own
permissions response and never from an inventory, because an inventory that succeeds says
nothing about what it could not see. The AWS answer follows the same rule:

1. **The account.** `sts:GetCallerIdentity` must name the account the consultant entered —
   a role in some other account is refused even if it can be assumed.
2. **The actions.** `iam:SimulatePrincipalPolicy` evaluates every action the reader policy
   lists against the role's own policies, **including** an AWS Organizations SCP, which is
   the case an inventory would hide: an SCP that blocks CloudWatch lets every describe call
   succeed and every metric fail. `scope_verified` is true only when every action is
   `allowed`; otherwise `SCOPE_UNVERIFIED` names the missing ones.

Then two answers that cannot fail the preflight: the enabled regions (the preset form's
choices) and the fidelity tier — `enhanced` when the CloudWatch agent publishes
`mem_used_percent` in any enabled region, `baseline` otherwise, the AWS counterpart of the
Azure guest-counter probe.
"""

from __future__ import annotations

import asyncio
from collections.abc import Sequence
from typing import Any, Final

from reporting_agent.aws.session import ClientFactory, required_actions
from reporting_agent.errors import AuthFailedError, ScopeUnverifiedError

__all__ = [
    "FIDELITY_BASELINE",
    "FIDELITY_ENHANCED",
    "AwsPreflight",
    "denied_actions",
]

FIDELITY_BASELINE: Final[str] = "baseline"
FIDELITY_ENHANCED: Final[str] = "enhanced"

AGENT_NAMESPACE: Final[str] = "CWAgent"
AGENT_MEMORY_METRIC: Final[str] = "mem_used_percent"
_SIMULATION_BATCH: Final[int] = 50


def denied_actions(results: Sequence[dict[str, Any]]) -> list[str]:
    """The actions a simulation did not allow. **Pure.**

    `allowed` is the only passing decision. An SCP that denies an action already makes the
    decision `explicitDeny` or `implicitDeny`, and `AllowedByOrganizations: false` is checked
    as well so a response that reports the organization decision separately still counts.
    """
    denied: list[str] = []
    for result in results:
        action = str(result.get("EvalActionName", ""))
        organizations = result.get("OrganizationsDecisionDetail") or {}
        if result.get("EvalDecision") != "allowed" or organizations.get("AllowedByOrganizations") is False:
            denied.append(action)
    return denied


class AwsPreflight:
    """The preflight's AWS calls, behind a client factory so tests use stubbed clients."""

    def __init__(self, *, clients: ClientFactory, account_id: str, role_arn: str, home_region: str) -> None:
        self._clients = clients
        self._account_id = account_id
        self._role_arn = role_arn
        self._home = home_region

    async def assert_account_read(self) -> bool:
        """True, or `AuthFailedError` / `ScopeUnverifiedError` naming what is wrong."""
        sts = self._clients("sts", self._home)
        identity = await asyncio.to_thread(sts.get_caller_identity)
        if identity.get("Account") != self._account_id:
            raise AuthFailedError(
                f"The role belongs to account {identity.get('Account')}, not {self._account_id}."
            )

        from botocore.exceptions import ClientError

        iam = self._clients("iam", self._home)
        actions = list(required_actions())
        # Account-wide actions are evaluated against `*`; the self-only ones against the
        # role's own ARN, which is the only resource their statement names.
        requests: list[tuple[list[str], list[str] | None]] = [
            (list(required_actions(self_only=False)), None),
            (list(required_actions(self_only=True)), [self._role_arn]),
        ]
        results: list[dict[str, Any]] = []
        try:
            for names, resources in requests:
                for start in range(0, len(names), _SIMULATION_BATCH):
                    arguments: dict[str, Any] = {
                        "PolicySourceArn": self._role_arn,
                        "ActionNames": names[start : start + _SIMULATION_BATCH],
                    }
                    if resources:
                        arguments["ResourceArns"] = resources
                    answer = await asyncio.to_thread(iam.simulate_principal_policy, **arguments)
                    results.extend(answer.get("EvaluationResults", []))
        except ClientError as exc:
            code = exc.response.get("Error", {}).get("Code", "")
            raise ScopeUnverifiedError(
                f"The role could not check its own permissions ({code}). Redeploy the setup "
                "template: its CheckOwnPermissions statement allows iam:SimulatePrincipalPolicy "
                "on the role itself, and the preflight needs it to prove the grant."
            ) from None

        missing = denied_actions(results)
        evaluated = {str(result.get("EvalActionName", "")) for result in results}
        missing.extend(action for action in actions if action not in evaluated)
        if missing:
            raise ScopeUnverifiedError(
                "The role does not allow every action the report needs, so the connection was "
                "not accepted. Missing: " + ", ".join(sorted(set(missing))) + ". Redeploy the "
                "setup template, or ask whoever manages the organization's SCPs to allow them."
            )
        return True

    async def enabled_regions(self) -> list[str]:
        """The account's enabled regions, sorted. Opt-in regions appear only when opted in."""
        ec2 = self._clients("ec2", self._home)
        answer = await asyncio.to_thread(ec2.describe_regions, AllRegions=False)
        return sorted(region["RegionName"] for region in answer.get("Regions", []))

    async def probe_fidelity(self, regions: Sequence[str]) -> str:
        """`enhanced` when any region has the CloudWatch agent's memory metric. Never raises."""

        async def has_agent(region: str) -> bool:
            try:
                cloudwatch = self._clients("cloudwatch", region)
                answer = await asyncio.to_thread(
                    cloudwatch.list_metrics,
                    Namespace=AGENT_NAMESPACE,
                    MetricName=AGENT_MEMORY_METRIC,
                    RecentlyActive="PT3H",
                )
            except Exception:
                return False
            return bool(answer.get("Metrics"))

        found = await asyncio.gather(*(has_agent(region) for region in regions))
        return FIDELITY_ENHANCED if any(found) else FIDELITY_BASELINE
