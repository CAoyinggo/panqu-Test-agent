# Pattern: Provider Failure

> Asset type: `PROOF_OBLIGATION`. Provider transport failure and business failure must remain distinguishable.

## Intent

Prove that upstream 4xx/5xx responses, timeouts and ambiguous commits are handled without duplicate calls, duplicate charges, lost reconciliation or false success.

## Applicable When

- A business operation invokes an external Provider or model service.
- The Provider can throttle, fail, time out or return an invalid payload.
- Local retry and compensation can create repeated side effects.

## Required Context

- Exact Provider operation and correlation mapping.
- Controllable Provider stub/proxy or trusted Provider call telemetry.
- Declared retry policy, backoff, maximum attempts and idempotency behavior.
- Local task/state, billing and event observation channels.
- Distinction between “request not sent”, “sent but result unknown” and “confirmed response”.

## Execution Steps

1. Record local, billing and Provider-call baselines for a unique correlation ID.
2. Execute a confirmed Provider success as the control path.
3. Inject each required failure class: 4xx, 429, 5xx, malformed response and connection failure.
4. Inject a timeout before dispatch and, separately, after dispatch when supported.
5. Observe retry attempts and final local task state.
6. Deliver a late Provider result after local timeout when this risk applies.
7. Reconcile Provider calls, local state, events and billing.

## Mandatory Assertions

- Local status never reports success without confirmed Provider success evidence.
- Retry count, delay class and terminal behavior match the declared policy.
- Non-retryable Provider errors are not retried.
- One logical request does not create duplicate Provider effects.
- Timeout after dispatch is classified as execution unknown until reconciled.
- Billing and refund behavior matches the confirmed Provider/business outcome.
- Late results cannot regress or duplicate an already terminal local state.

## Mandatory Evidence

- Provider request/response/error record per attempt.
- Dispatch state, attempt number and timestamps.
- Provider and local correlation/idempotency IDs.
- Local task state history.
- Billing ledger entries and compensation/refund evidence.
- Retry scheduler/trace evidence and late-result handling record.

## Blocking Conditions

- Provider calls cannot be observed or controlled.
- Retry policy or idempotency contract is unspecified.
- Timeout location relative to dispatch cannot be determined.
- Local and Provider records cannot be correlated.
- Billing or final task state cannot be reconciled.

## Fail-Closed Rule

A client timeout must not be translated to “not executed” or PASS when a Provider call may have committed. Keep the result `TIMEOUT`/`BLOCKED` until reconciliation evidence resolves it.
