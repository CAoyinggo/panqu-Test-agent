# Pattern: State Machine

> Asset type: `PROOF_OBLIGATION`. Use for synchronous or asynchronous resources governed by allowed transitions.

## Intent

Prove valid transitions, reject invalid transitions, preserve terminal-state invariants and converge to the declared final state within a bounded observation window.

## Applicable When

- A resource moves through named states.
- Work is asynchronous, queued, retried or callback-driven.
- Duplicate, out-of-order or late events could regress a terminal state.

## Required Context

- Complete relevant state vocabulary and transition table.
- Initial state and exact action/event for each tested edge.
- Allowed terminal states and terminal immutability rules.
- Poll/event observation channel, interval and deadline.
- Retry, duplicate and out-of-order semantics.
- Stable resource and event correlation IDs.

## Execution Steps

1. Prepare a resource in an explicit initial state.
2. Execute each selected valid transition and record the observed sequence.
3. Wait only until the declared terminal/intermediate condition or deadline.
4. Attempt selected invalid transitions from controlled source states.
5. Send duplicate, out-of-order or late events when these risks apply.
6. Re-read final state after the settling window.
7. Clean up or archive the resource according to policy.

## Mandatory Assertions

- Every valid observed edge exists in the declared transition table.
- The resource reaches an allowed final state within the deadline.
- Invalid transitions are rejected and leave state unchanged.
- State does not regress after a terminal state.
- Duplicate events do not repeat the transition or side effects.
- Late/out-of-order events follow the explicit ignore, reject or reconciliation rule.
- State-dependent billing, events and audit records remain consistent.

## Mandatory Evidence

- Initial state snapshot.
- Timestamped state/event history with correlation IDs.
- Request, callback or event that triggered each transition.
- Final authoritative state snapshot after the settling window.
- Before/after evidence for invalid transitions.
- Related billing/event/audit evidence where state controls side effects.

## Blocking Conditions

- State names, allowed edges or terminal states conflict or are incomplete.
- No authoritative state history or final-state probe exists.
- Polling deadline or consistency window is unspecified.
- Events cannot be correlated to the target resource.
- A timeout leaves the final state unknown.

## Fail-Closed Rule

Seeing one successful response or one intermediate status is insufficient. Timeout is `TIMEOUT`, not PASS; unknown final state is `BLOCKED` or `NOT_EXECUTED` according to execution facts.
