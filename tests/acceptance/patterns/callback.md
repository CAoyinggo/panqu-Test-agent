# Pattern: Callback

> Asset type: `PROOF_OBLIGATION`. This Pattern covers inbound webhooks, Provider callbacks and asynchronous completion notifications.

## Intent

Prove that callbacks are authenticated, correlated, idempotent and order-safe, and that duplicates or late delivery do not repeat state changes or side effects.

## Applicable When

- External systems complete work through a callback or webhook.
- Delivery is at-least-once, delayed or out of order.
- Callback processing changes task state, emits events, unlocks resources or affects billing.

## Required Context

- Exact callback Method and Path.
- Signature/authentication algorithm, secret reference and replay window.
- Callback event ID, Provider task ID and local resource mapping.
- Allowed state transitions and duplicate/late-event policy.
- State, event, billing and audit observation channels.

## Execution Steps

1. Prepare a local resource awaiting callback and capture baseline state.
2. Send one valid authenticated callback and observe processing.
3. Replay the identical callback with the same event ID.
4. Send an invalid-signature callback and an unknown-resource callback.
5. Send out-of-order and late callbacks where applicable.
6. Observe final state, emitted events, Provider acknowledgements and billing.
7. Verify audit records and clean up the prepared resource.

## Mandatory Assertions

- A valid callback is accepted and correlated to exactly one local resource.
- Invalid authentication is rejected with no protected state mutation.
- Duplicate callback delivery produces no duplicate transition, event, charge or refund.
- Unknown resource behavior does not leak sensitive existence information.
- Out-of-order/late callbacks follow the declared ignore, reject or reconciliation policy.
- Terminal state cannot regress.
- Callback acknowledgement behavior does not cause an unbounded retry loop.

## Mandatory Evidence

- Redacted callback headers/body and authentication decision.
- Callback event ID and Provider/local correlation IDs.
- Before/after resource state and state history.
- Deduplication store or processed-event record.
- Emitted event and billing ledger cardinality.
- Audit record and acknowledgement response.

## Blocking Conditions

- Signature/authentication contract or replay window is unknown.
- Callback/event identity cannot be made stable.
- State transitions or late-event policy are unspecified.
- Duplicate side effects cannot be counted.
- Callback and local resource cannot be correlated.

## Fail-Closed Rule

Returning `2xx` to a callback does not prove correct processing. PASS requires state, deduplication and downstream side-effect evidence.
