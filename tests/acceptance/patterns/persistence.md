# Pattern: Persistence

> Asset type: `PROOF_OBLIGATION`. This document guides Scenario generation; it is not itself an executable test case.

## Intent

Prove that a successful create or update is durably observable through the authoritative read channel, while fields outside the requested mutation remain unchanged.

## Applicable When

- A Requirement creates or modifies a resource.
- The result must survive the request boundary, process boundary or transaction commit.
- A response echoes submitted data but that response alone cannot prove persistence.

## Required Context

- Exact write Method and Path.
- Authoritative read-back Method and Path, database probe or equivalent state connector.
- Explicit Actor, Tenant, Project and resource owner.
- Stable resource identity and correlation ID.
- Before-state values for every field that must remain untouched.
- Consistency model and bounded observation deadline.

## Execution Steps

1. Prepare an isolated resource and record its before-state evidence.
2. Execute the write operation once.
3. Assert the write response and capture the returned resource/correlation identity.
4. Read the resource from an authoritative state channel, retrying only according to the declared consistency policy.
5. Compare changed fields, untouched fields, ownership and version information.
6. Clean up the isolated resource and verify cleanup when required.

## Mandatory Assertions

- The write response matches the declared contract.
- The persisted resource exists under the expected identity.
- Every requested field has the expected persisted value.
- Every protected or untouched field retains its before value.
- Tenant, Project, owner and authorization fields have not drifted.
- The observed version/timestamp is compatible with exactly one committed mutation.

## Mandatory Evidence

- Redacted write request and response.
- Before-state snapshot.
- Authoritative after-state snapshot.
- Resource ID, correlation ID and version/commit marker where available.
- Assertion evidence linking each compared field to its source AC.
- Cleanup result when the Scenario owns the data.

## Blocking Conditions

- No authoritative read-back or state probe exists.
- The created/updated resource cannot be uniquely identified.
- Before-state is unavailable for untouched-field assertions.
- The observation deadline or consistency semantics are unknown.
- Identity, Tenant, Project or resource ownership is ambiguous.
- Cleanup responsibility is undefined for a mutating test.

## Fail-Closed Rule

`2xx` or an echoed response body alone is insufficient. Missing after-state evidence must produce `BLOCKED` or `DESIGNED_ONLY`, never PASS.
