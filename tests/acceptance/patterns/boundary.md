# Pattern: Boundary

> Asset type: `PROOF_OBLIGATION`. Boundary values must come from an explicit contract, never from guessed “reasonable” limits.

## Intent

Prove behavior at and immediately around declared type, range, length, count, size, format and time boundaries without causing mutation on rejected inputs.

## Applicable When

- A Requirement declares minimum, maximum, exact, enum, format, nullable or required constraints.
- Limits affect payloads, uploads, pagination, money, durations or collection sizes.
- Encoding, Unicode or unit conversion changes effective length/size.

## Required Context

- Exact parameter location, type, unit and authoritative constraint.
- Inclusivity/exclusivity and null/empty semantics.
- Expected success and rejection statuses.
- Valid baseline request and deterministic value generator.
- Non-Mutation probe for invalid writes.
- Encoding, normalization and size measurement rules where relevant.

## Execution Steps

1. Build a valid baseline request satisfying all unrelated constraints.
2. Vary exactly one constraint at a time.
3. Exercise applicable vectors: min-1, min, min+1, max-1, max, max+1, empty, null, wrong type, invalid format and extreme value.
4. Include Unicode/byte-length variants only when the contract distinguishes characters, bytes or graphemes.
5. Assert response behavior for each vector.
6. Prove Non-Mutation for every rejected mutating request.
7. Clean up successful resources.

## Mandatory Assertions

- Values exactly on inclusive boundaries are accepted; exclusive boundaries follow the explicit rule.
- Values immediately outside a boundary are rejected with the declared contract.
- Wrong type, null, empty and invalid format follow their independent explicit rules.
- One test vector does not accidentally violate a second constraint and invalidate the oracle.
- Rejected writes leave persistent state and side effects unchanged.
- Error responses do not leak internal implementation details.

## Mandatory Evidence

- Versioned source constraint and unit.
- Exact generated value plus measured character/byte/count/size.
- Request/response evidence for every vector.
- Vector-to-constraint trace.
- Before/after state for rejected writes.
- Created-resource cleanup evidence for accepted writes.

## Blocking Conditions

- Minimum/maximum, inclusivity, unit or expected rejection behavior conflicts.
- A value cannot satisfy the other declared constraints while isolating the target boundary.
- Measurement semantics are unknown.
- The invalid write lacks a Non-Mutation probe.
- Test data generation would exceed safe environment limits.

## Fail-Closed Rule

Do not choose one side of a conflicting boundary or reuse a value that violates multiple contracts. Ambiguous or unprovable vectors must be omitted with a blocking reason, never converted to PASS.
