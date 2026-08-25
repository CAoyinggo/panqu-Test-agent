# Pattern: Idempotency

> Asset type: `PROOF_OBLIGATION`. It defines how to prove repeated intent produces one business effect.

## Intent

Prove that duplicate, retried or concurrent representations of the same logical request do not create duplicate entities or duplicate side effects.

## Applicable When

- A client may retry after timeout or response loss.
- An idempotency key, unique business key or deduplication contract exists.
- Duplicate submission could create tasks, charge money, send messages or call a Provider twice.

## Required Context

- Exact operation Method and Path.
- Declared idempotency identity and its scope/expiry.
- Stable logical request body and Actor/Tenant/Project.
- Entity, billing, Provider and event observation channels.
- Concurrency plan and bounded final-state deadline.

## Execution Steps

1. Record baseline entity and side-effect counts for a unique correlation key.
2. Execute the first logical request and capture its response and identity.
3. Repeat the identical request sequentially with the same idempotency identity.
4. Execute a controlled concurrent duplicate attempt when the Requirement covers concurrency.
5. Simulate response loss before retry when this risk is in scope.
6. Observe final resource, ledger, Provider and event state.
7. Optionally send a materially different payload with the same key to verify the declared conflict policy.

## Mandatory Assertions

- All accepted duplicate responses resolve to the same business resource or declared replay result.
- Exactly one durable business entity/effect exists.
- Exactly one charge exists and no duplicate refund masks an incorrect duplicate charge.
- Provider and outbound event call counts meet the explicit exactly-once/at-most-once contract.
- Final state equals the state produced by one successful request.
- Reusing a key with a different payload follows the declared rejection/conflict behavior.

## Mandatory Evidence

- All request/response pairs with the idempotency identity redacted as needed.
- Resource IDs and final entity count.
- Before/after billing ledger entries.
- Provider/event call ledger with correlation IDs.
- Timing/concurrency trace showing overlap for the concurrent variant.
- Final authoritative state snapshot.

## Blocking Conditions

- The logical idempotency identity or its scope is unknown.
- Entity or side-effect counts cannot be correlated.
- Only aggregate account balance is available.
- Concurrent requests cannot be synchronized deterministically.
- A client timeout makes server commit state unknown and no reconciliation probe exists.

## Fail-Closed Rule

Equal HTTP responses do not prove idempotency. Without entity and side-effect cardinality evidence, the Scenario must be `BLOCKED` or `DESIGNED_ONLY`.
