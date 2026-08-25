# Pattern: Atomicity

> Asset type: `PROOF_OBLIGATION`. Atomicity is a state invariant, not an HTTP status assertion.

## Intent

Prove that all participants in a declared business transaction commit together, or that every participant is rolled back when a controlled failure occurs.

## Applicable When

- One action updates multiple rows, resources, ledgers or services.
- A Requirement says “all or nothing”, “transactional”, “roll back” or equivalent.
- Partial failure could create inconsistent inventory, orders, balances, tasks or events.

## Required Context

- Explicit list of transaction participants and invariants.
- Exact initiating operation.
- Authoritative state probes for every participant.
- Deterministic fault-injection point after at least one participant has started.
- Transaction/correlation ID and bounded reconciliation deadline.
- Declared outbox/event semantics when external messaging participates.

## Execution Steps

1. Prepare isolated participants and capture all before states.
2. Execute the happy path and prove all declared participants commit consistently.
3. Restore a clean baseline.
4. Inject a controlled failure at the declared partial-progress point.
5. Execute the operation and capture response/transport state.
6. Observe every participant after rollback/reconciliation completes.
7. Inspect emitted events, ledger entries and compensations.
8. Remove the fault and clean up all owned data.

## Mandatory Assertions

- Happy-path participants all reach the declared committed state.
- Failure-path participants all equal the allowed rollback/compensated state.
- No participant remains committed while another remains uncommitted unless explicitly allowed by a saga contract.
- No orphan resource, duplicate event or unmatched ledger entry remains.
- Retry after a known rollback follows the declared idempotency policy.
- Any compensation occurs exactly once and reaches the declared final invariant.

## Mandatory Evidence

- Before and after snapshots for every participant.
- Fault-injection configuration and activation evidence.
- Transaction/correlation ID.
- Database transaction, outbox, event and compensation records as applicable.
- Response and transport evidence.
- Final invariant evaluation listing every participant.

## Blocking Conditions

- Participants or allowed final states are not enumerated.
- No deterministic failure point can be injected.
- A participant lacks an authoritative state probe.
- Transport timeout leaves commit state unknown without reconciliation.
- Eventual compensation has no declared deadline.

## Fail-Closed Rule

An error response does not prove rollback. If any transaction participant cannot be observed, atomicity remains unverified and cannot PASS.
