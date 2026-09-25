"""Reading a customer's AWS account through a role they created for us.

The customer deploys `ReportingAgentReader` (path `/reporting-agent/`) from the onboarding
template. It trusts this runtime's execution role and only with the connector's external
id, and it grants the read actions in `reader_policy.v1.json` and nothing else. The app's
onboarding artifacts are generated from the same file, so what the customer grants and what
the preflight checks cannot drift apart.

* `session.py` assumes the role once per invocation and refreshes it on long runs.
* `preflight.py` proves the grant: the account, then every required action, from IAM's own
  policy simulation rather than from an inventory that happened to succeed.
* `inventory.py` scans each enabled region for the connector's scan page.

No credential is stored anywhere for AWS: the role ARN and the external id are identifiers,
and the runtime's own role is what AWS authenticates.
"""
