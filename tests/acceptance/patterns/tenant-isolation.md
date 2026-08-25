# Pattern: Tenant Isolation

> Asset type: `PROOF_OBLIGATION`. This Pattern applies to Tenant, organization, workspace and Project isolation boundaries.

## Intent

Prove that an Actor can observe and mutate only resources belonging to the authorized data boundary, without leaking existence, content or side effects across boundaries.

## Applicable When

- Resources are partitioned by Tenant, organization, workspace, Project or account.
- IDs may be guessed, reused or supplied by a client.
- Lists, searches, exports, downloads or billing views aggregate scoped data.

## Required Context

- At least two explicit isolation domains and one Actor per required role/domain.
- Distinct resources owned by each domain.
- Exact Actor, Tenant, Project and resource ownership mapping.
- Exact read/write/list/download operations.
- Authoritative state and access-decision evidence channels.

## Execution Steps

1. Prepare uniquely marked resources in domain A and domain B.
2. Prove each owner can access its own resource under the declared policy.
3. Attempt direct cross-domain access by resource ID.
4. Attempt list/search/filter/export access that could reveal the other domain.
5. Attempt a cross-domain write when the operation is in scope.
6. Verify Non-Mutation for denied writes and absence of cross-domain side effects.
7. Verify audit scoping and clean up resources in both domains.

## Mandatory Assertions

- Same-domain behavior matches the explicit allow contract.
- Cross-domain direct reads reveal no protected data.
- List, count, search, export and download results contain no foreign resource.
- Error behavior does not leak resource existence beyond the declared policy.
- Cross-domain writes do not change the target resource.
- No task, charge, Provider call or event is attributed to the wrong domain.
- Audit records and report artifacts retain the correct Tenant/Project attribution.

## Mandatory Evidence

- Actor-to-domain and resource-to-domain ownership records.
- Requests/responses for same-domain and cross-domain variants.
- Scoped list/export contents and counts.
- Before/after state for cross-domain writes.
- Correlation-scoped billing, Provider, event and audit evidence when applicable.
- Cleanup evidence for both domains.

## Blocking Conditions

- Tenant/Project identifiers or resource ownership are ambiguous.
- Only one isolation domain can be prepared.
- The test uses synthetic headers that are not trusted by the real authorization layer.
- Cross-domain state or list contents cannot be observed.
- Denied writes lack a Non-Mutation probe.

## Fail-Closed Rule

A `403` from one direct request does not prove isolation. Missing ownership, list leakage or post-write evidence requires `BLOCKED` or `DESIGNED_ONLY`.
