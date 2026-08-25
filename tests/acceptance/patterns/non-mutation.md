# Pattern: Non-Mutation

> Asset type: `PROOF_OBLIGATION`. Use for rejected or prohibited writes; an error status is only the first assertion.

## Intent

Prove that a rejected operation did not change protected state and did not trigger prohibited downstream side effects.

## Applicable When

- A write is expected to return `400`, `401`, `403`, `409`, `422` or another rejection.
- Authentication, authorization, validation, ownership or conflict handling denies an operation.
- Failure must not create a task, charge an account, call a Provider or publish a message.

## Required Context

- Exact rejected operation Method and Path.
- Explicit source Actor and target resource owner.
- Tenant and Project boundaries.
- Authoritative before/after state probes.
- Applicable side-effect observation channels and expected audit policy.
- Correlation key that can prove absence without mixing unrelated traffic.

## Execution Steps

1. Prepare a uniquely identifiable protected resource.
2. Capture its full relevant before state and downstream counters.
3. Execute the prohibited or invalid write once.
4. Assert the rejection response.
5. Query authoritative resource state after the action.
6. Query task, billing, Provider, event and audit channels required by the risk model.
7. Compare before and after evidence, then clean up owned data.

## Mandatory Assertions

- The response uses the explicitly required rejection status and safe error contract.
- The protected resource is byte-for-byte or field-for-field unchanged where applicable.
- Owner, Tenant, Project, role and permission fields are unchanged.
- No prohibited task/entity was created.
- Billing delta is zero when the action must not charge.
- Provider and message/event call counts are zero when prohibited.
- Audit presence or absence matches the explicit audit Requirement.

## Mandatory Evidence

- Rejected request and response.
- Before and after authoritative resource snapshots.
- Correlation-scoped entity/task count.
- Correlation-scoped billing ledger delta.
- Provider/event/queue call-count evidence when applicable.
- Audit evidence or an explicit contract that no audit record is expected.

## Blocking Conditions

- Only the HTTP rejection status can be observed.
- The target resource or owner is not explicit.
- Before and after snapshots cannot be correlated to the same resource.
- Downstream call counts cannot be isolated from unrelated traffic.
- Expected audit behavior is unspecified where audit is material.

## Fail-Closed Rule

`403` does not prove safety. If the system cannot prove unchanged state and absence of prohibited side effects, the Scenario is not executable and cannot PASS.
