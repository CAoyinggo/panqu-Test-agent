---
name: devtest
description: Run requirement-driven developer tests through the installed DevTest MCP and interpret its evidence-backed report. Use for feature self-tests, test planning, and investigating test failures in the current repository.
---

# DevTest

Use the `devtest` MCP tool as the testing entry point. It invokes the same Requirement Model → Business Model → Test Strategy → TEST_CASE_V2 → Quality Gate → Runner → Evidence → Oracle pipeline as the npm CLI.

Identify the requirement document in the current repository. Understand the actor, resource, ownership, tenant, state, rule, result and side effects before explaining the scope. Keep absent or conflicting information UNKNOWN / NEED_CONFIRMATION; ask only for information needed to proceed. Code describes implementation, not an authoritative replacement for missing product requirements.

Call `doctor` to inspect setup and `plan` with the repository-relative `requirement` path. The kernel selects risk-driven dimensions and generates cases; do not create another case format or fill missing expected results. Show the returned plan ID, hash, selected scope, blocked capabilities and unknowns. A successful tool call or plan is not a passing test.

After the user authorizes execution of that plan, call `execute` with its `plan_id`, `expected_plan_hash` and an `idempotency_key`. Reuse that key for retries. If the plan is stale, generate a new preview and obtain authorization for the changed scope. Use `status` with `plan_id` to recover a result; do not resubmit uncertain business operations.

Local MCP execution uses SAFE read-only policy. Approved test/sandbox writes use the repository's DevTest GitHub workflow and its environment configuration. Keep credentials out of chat, tool arguments and tracked files. Do not bypass missing runtime capabilities with ad hoc HTTP, DB or browser operations.

Explain the returned GENERATED / EXECUTABLE / EXECUTED / VERIFIED counts, failures, missing evidence and cleanup outcome. Link the returned report and evidence artifacts. PASS requires recorded execution and a satisfied deterministic Oracle; BLOCKED, DESIGNED_ONLY and NOT_EXECUTED remain visible. For a negative write, verify Response + State + Non-Mutation + Side Effect; incomplete evidence is NOT_VERIFIED.

When reporting possible defects, separate observed failures from hypotheses and cite the case and evidence. Recommend the smallest next action that resolves the reported gap. This skill does not authorize changing application code, posting issues or merging pull requests.
