# Pattern: Audit

> Asset type: `PROOF_OBLIGATION`. Application response and audit recording are separate outcomes and require separate evidence.

## Intent

Prove that security- and business-relevant actions create the required immutable, correctly attributed and safely redacted audit record exactly once.

## Applicable When

- A Requirement mandates audit, compliance, traceability or accountability.
- Administrative, permission, billing, data export or sensitive mutation actions occur.
- Rejected attempts must be recorded according to policy.

## Required Context

- Explicit events that must or must not be audited.
- Required audit schema: Actor, action, resource, outcome, time and correlation.
- Tenant/Project ownership and audit-reader authorization.
- Authoritative audit query or event sink.
- Retention, immutability and redaction expectations relevant to the test.

## Execution Steps

1. Record baseline audit entries for a unique correlation ID.
2. Execute the allowed business action and capture its business result.
3. Query the authoritative audit channel after the declared propagation window.
4. Execute the required rejected/failed variant and query again.
5. Attempt duplicate/retry behavior when audit cardinality matters.
6. Verify reader authorization and cross-domain isolation for audit access.
7. Clean up business data without altering retained audit evidence unless policy explicitly permits it.

## Mandatory Assertions

- Required allowed and rejected actions produce the declared audit outcome.
- Each record attributes the correct Actor, role, Tenant, Project, action and resource.
- Audit outcome agrees with the actual business execution result.
- Correlation and timestamp/order are sufficient to reconstruct the action.
- Sensitive credentials, secrets and prohibited PII are redacted.
- Duplicate logical actions do not create misleading duplicate audit records beyond policy.
- Unauthorized Actors cannot read another domain's audit data.
- The record cannot be modified or deleted through ordinary business operations.

## Mandatory Evidence

- Business request/response and execution result.
- Correlation-scoped authoritative audit record.
- Audit schema validation results.
- Identity and domain attribution evidence.
- Redaction checks.
- Audit access-control request/response.
- Cardinality and immutability/retention evidence where supported.

## Blocking Conditions

- Required audit events or schema fields are unspecified.
- No authoritative audit query/sink is available.
- Propagation deadline is unknown.
- Business and audit records cannot be correlated.
- Expected behavior for denied/failed attempts is ambiguous.
- Audit-reader identity or Tenant scope cannot be prepared.

## Fail-Closed Rule

A successful business response does not prove audit compliance. Missing, uncorrelated or unreadable audit evidence must prevent the audit AC from passing.
