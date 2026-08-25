# Pattern: Authorization

> Asset type: `PROOF_OBLIGATION`. Authentication success and authorization success are separate claims.

## Intent

Prove that an explicit Actor may perform only the actions permitted by role, scope, ownership and resource policy, and that denied actions do not mutate protected state.

## Applicable When

- A Requirement names roles, scopes, ownership or protected operations.
- The same authenticated identity has different permissions across resources or actions.
- Sensitive fields or administrative operations require stronger authorization.

## Required Context

- Explicit allow and deny Actors with credential references.
- Role, scope, Tenant, Project and resource ownership.
- Exact Method and Path for every protected operation.
- Authoritative policy expectation and rejection status.
- Non-mutation evidence channels for denied writes.

## Execution Steps

1. Prepare a resource with explicit ownership and scope.
2. Execute the operation as an allowed Actor.
3. Execute the same operation as each denied Actor/scope variant.
4. For denied reads, inspect response content and resource-enumeration behavior.
5. For denied writes, perform the Non-Mutation proof.
6. Verify audit behavior and clean up the prepared resource.

## Mandatory Assertions

- Allowed Actor receives the declared success and business outcome.
- Denied Actor receives the declared denial without sensitive content leakage.
- Authentication failure is not mislabeled as authorization proof.
- Denied reads reveal no protected fields and do not confirm resource existence beyond policy.
- Denied writes leave resource and downstream side effects unchanged.
- Sensitive fields cannot be changed by mass assignment or role spoofing.
- Audit subject, action, resource and decision match the attempted operation when required.

## Mandatory Evidence

- Redacted identity/role/scope resolution for every Actor.
- Request and response per authorization variant.
- Resource ownership and policy snapshot.
- Before/after state for denied writes.
- Audit record or explicit no-audit contract.
- Correlation IDs linking decision, request and state evidence.

## Blocking Conditions

- The Actor, role, scope or resource owner is inferred rather than explicit.
- Credentials for a required authorization variant cannot be prepared.
- The expected deny status/policy is ambiguous.
- Non-mutation cannot be observed for a denied write.
- Test environment authorization differs from the declared policy without a trusted mapping.

## Fail-Closed Rule

An allowed request does not prove denial paths, and a denial status does not prove non-mutation. Missing either side of the policy proof prevents PASS.
