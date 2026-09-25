import { describe, expect, test } from "vitest"

import readerPolicy from "../../../agent/src/reporting_agent/aws/reader_policy.v1.json"
import {
  AWS_REQUIRED_ACTIONS,
  AWS_ROLE_NAME,
  AWS_ROLE_PATH,
  awsCliScript,
  awsCloudFormationTemplate,
  awsOnboardingArtifacts,
  isAwsAccountId,
  isExternalId,
  readerRoleArn,
} from "@/lib/subscriptions/aws-artifacts"

// AWS's documentation placeholders: never a real account.
const ACCOUNT = "123456789012"
const PRINCIPAL = "arn:aws:iam::210987654321:role/ReportingAgentRuntimeRole"
const EXTERNAL_ID = "rpt-5c1e9b7a2f8d4c36a0e4b91d7f2a6c58"
const INPUT = { accountId: ACCOUNT, externalId: EXTERNAL_ID, principalArn: PRINCIPAL }

describe("the AWS onboarding artifacts", () => {
  test("the role is fixed by the shared policy file", () => {
    expect(AWS_ROLE_PATH).toBe("/reporting-agent/")
    expect(AWS_ROLE_NAME).toBe("ReportingAgentReader")
    expect(readerRoleArn(ACCOUNT)).toBe(
      `arn:aws:iam::${ACCOUNT}:role/reporting-agent/ReportingAgentReader`
    )
  })

  test("both artifacts grant exactly the actions the runtime's preflight checks", () => {
    const fromFile = readerPolicy.statements.flatMap((statement) => statement.actions)
    expect(AWS_REQUIRED_ACTIONS).toEqual(fromFile)

    const template = awsCloudFormationTemplate(INPUT)
    const script = awsCliScript(INPUT)
    for (const action of fromFile) {
      expect(template).toContain(`- ${action}`)
      expect(script).toContain(`"${action}"`)
    }
    // Nothing that writes: every verb is a read.
    for (const action of fromFile) {
      expect(action.split(":")[1]).toMatch(/^(Describe|Get|List|Simulate)/)
    }
  })

  test("the trust names our principal and demands this connection's external ID", () => {
    const template = awsCloudFormationTemplate(INPUT)
    expect(template).toContain(`AWS: ${PRINCIPAL}`)
    expect(template).toContain(`Default: ${EXTERNAL_ID}`)
    expect(template).toContain("sts:ExternalId: !Ref ExternalId")

    const script = awsCliScript(INPUT)
    expect(script).toContain(`"AWS": "${PRINCIPAL}"`)
    expect(script).toContain(`"sts:ExternalId": "${EXTERNAL_ID}"`)
  })

  test("the self-check is scoped to the role itself, never to every resource", () => {
    const template = awsCloudFormationTemplate(INPUT)
    const selfCheck = template.slice(template.indexOf("Sid: CheckOwnPermissions"))
    expect(selfCheck).toContain(
      "Resource: !Sub arn:aws:iam::${AWS::AccountId}:role/reporting-agent/ReportingAgentReader"
    )
    expect(selfCheck).not.toContain('Resource: "*"')

    const script = awsCliScript(INPUT)
    const document = script.slice(script.indexOf("cat > permissions.json"))
    expect(document).toContain(`"Resource": "${readerRoleArn(ACCOUNT)}"`)
  })

  test("the script checks the account first and updates an existing role in place", () => {
    const script = awsCliScript(INPUT)
    expect(script.indexOf("get-caller-identity")).toBeLessThan(script.indexOf("create-role"))
    expect(script).toContain("update-assume-role-policy")
    expect(script).toContain(`ACCOUNT_ID="${ACCOUNT}"`)
    // The heredocs are quoted, so nothing in the documents is expanded by the shell.
    expect(script).toContain("<<'EOF'")
  })

  test("the artifacts carry no secret and nothing but what they were given", () => {
    const artifacts = awsOnboardingArtifacts(INPUT)
    expect(artifacts.roleArn).toBe(readerRoleArn(ACCOUNT))
    expect(JSON.stringify(artifacts)).not.toMatch(/SecretAccessKey|aws_secret|password/i)
  })

  test.each([
    { accountId: "12345", externalId: EXTERNAL_ID, principalArn: PRINCIPAL },
    { accountId: ACCOUNT, externalId: "chosen-by-a-client", principalArn: PRINCIPAL },
    { accountId: ACCOUNT, externalId: EXTERNAL_ID, principalArn: "arn:aws:iam::1:user/me" },
  ])("a malformed input is refused rather than written into a template", (input) => {
    expect(() => awsCloudFormationTemplate(input)).toThrow()
    expect(() => awsCliScript(input)).toThrow()
  })

  test("the validators", () => {
    expect(isAwsAccountId(ACCOUNT)).toBe(true)
    expect(isAwsAccountId("12345678901")).toBe(false)
    expect(isExternalId(EXTERNAL_ID)).toBe(true)
    expect(isExternalId("rpt-XYZ")).toBe(false)
  })
})
