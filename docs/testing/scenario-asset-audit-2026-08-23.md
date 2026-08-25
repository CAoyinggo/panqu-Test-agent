# Test Scenario Asset Audit — 2026-08-23

## 1. Purpose and scope

This document records the read-only baseline taken before introducing the standardized Markdown scenario asset system. It distinguishes a file that merely exists from an asset that is actually consumed by:

```text
Requirement
  -> Parser
  -> Canonical Case
  -> Processor
  -> Execution
  -> Assertion
  -> Evidence
  -> Report
```

The scan covered `tests/`, `docs/`, `tasks/`, `src/cases/`, `src/acceptance/`, processors, runners and report code. Dependency directories were excluded. Ignored Playwright report data was counted separately because it appears in the working tree but is generated output.

## 2. Asset inventory

### 2.1 Markdown inventory

The baseline contains 173 non-dependency Markdown files.

| Classification | Count | Location / rule | Main-chain input |
| --- | ---: | --- | --- |
| Executable-scenario candidate | 1 | `tests/acceptance/fixtures/user-profile.md` | Partially |
| Named templates | 5 | Top-level `docs/*模板*.md` | No |
| Reports, summaries and readiness records | 107 | Filename contains `report`, `summary` or `readiness` | No; output/history |
| Other design and operations documentation | 41 | Remaining files under `docs/` | No |
| Generated Playwright attachments | 18 | `tests/e2e/web/playwright-report/data/*.md` | No; generated failure prompts |
| Root project README | 1 | `README.md` | No |

The five named templates are:

- `docs/02-模板合集.md`
- `docs/02-测试用例模板.md`
- `docs/03-数据需求清单模板.md`
- `docs/04-新任务启动检查清单模板.md`
- `docs/05-项目说明模板.md`

Only `tests/acceptance/fixtures/user-profile.md` is a persisted Markdown requirement fixture currently exercised through the Acceptance pipeline. It is not yet a complete scenario package: it does not carry a scenario manifest, expected artifact, scenario-local execution configuration or explicit proof plan.

### 2.2 TypeScript and JSON scenario inventory

| Asset | Count | Meaning |
| --- | ---: | --- |
| Formal TypeScript ground-truth Markdown scenarios | 21 | 9 in `design-ground-truth.ts`; 12 in `test-design-quality-ground-truth.ts` |
| Markdown-like static fragments in Acceptance tests | 124 | Static literals beginning with a level-one heading across 17 files; mainly transient test inputs |
| JSON task definitions | 5 | Four active Wan3 tasks plus `_template.json` |
| TypeScript `TaskDef` cases | 9 | Four migrated Wan3 duplicates plus five idempotency/negative cases |

The 124 fragments are a source-code metric, not an asset count. Some are assembled inside a test and some are deliberately incomplete adversarial inputs. They are not discoverable scenario packages and cannot be run independently through the CLI without extracting them from their tests.

Four JSON tasks and four TypeScript cases describe the same Wan3 scenarios. There is no enforced single source of truth, so these copies can drift.

## 3. Main-chain connectivity

| Asset type | Requirement Parser | Canonical Case | Processor / Execution | Assertion | Evidence | Report | Assessment |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `user-profile.md` | Yes | Yes | API-executable subset only | Yes | HTTP evidence for executed subset | Yes | Partially wired |
| Embedded Acceptance Markdown | Usually inside tests | Some | Some use a fake HTTP server | Some | Some | Some | Test fixture, not reusable asset |
| `tasks/*.json` | No | No; loaded directly as `TaskDef` | Generic Engine / Video Processor | Implicit default assertions | Generic response/check data | Yes | Alternate legacy chain |
| `src/cases/**/*.ts` | No | No; loaded directly as `TaskDef` | Generic Engine / Video Processor | Implicit default assertions | Generic response/check data | Yes | Alternate legacy chain |
| Templates and SOP | No | No | No | No | No | No | Documentation only |
| Historical reports | No | No | No | No | Existing output only | Already output | Historical record |
| Playwright Markdown attachments | No | No | No | No | Failure attachment only | Playwright report data | Generated artifact |

The persisted fixture currently follows this path:

```text
tests/acceptance/fixtures/user-profile.md
  -> parseAcceptanceRequirement
  -> Requirement Fact / Objective / Test Point
  -> generateAcceptanceApiCases
  -> Test Case Quality Gate
  -> ApiProcessor
  -> HTTP response
  -> deterministic assertions
  -> request/response/assertion evidence
  -> Acceptance Report
```

Its executable subset proves single-operation HTTP contracts. Cases needing UI evidence, post-write non-mutation proof or unsupported error-data preparation remain `DESIGNED_ONLY`, `BLOCKED` or `NOT_EXECUTED`; they are not counted as PASS.

## 4. Existing foundations to preserve

The current Acceptance implementation already provides important fail-closed foundations:

- Requirement conflicts and unresolved contract hints can block execution.
- An executable API Case is bound to an exact HTTP Method and Path.
- `DESIGNED_ONLY` does not enter the PASS path.
- Dry-run, missing Processor and unexecuted Cases do not produce PASS.
- A real HTTP response and at least one effective deterministic assertion are required for PASS.
- Request, response, binding and assertion evidence are retained in the Acceptance report.
- A rejected mutation without post-condition evidence is downgraded rather than accepted on a 403 alone.

The scenario asset upgrade must extend these guarantees, not replace them with a second permissive path.

## 5. Structural gaps

### 5.1 No standardized scenario source tree

There is no current source layout equivalent to:

```text
tests/acceptance/scenarios/<domain>/<scenario-id>/
  requirement.md
  expected.json
  acceptance.config.example.json
  server-scenario.ts            # optional
```

There is also no scenario package discovery, manifest validation, schema version or classification index.

### 5.2 Single-operation execution cannot prove state

The Acceptance API Processor requires exactly one `HTTP_REQUEST` per Case. This is sufficient for a response contract but cannot prove multi-operation obligations such as:

- write then read-back persistence;
- rejected write then post-action non-mutation;
- first request then retry/concurrent idempotency;
- asynchronous polling to an allowed terminal state;
- charge/refund ledger consistency;
- Provider call count or absence;
- database, cache, queue and audit state;
- atomic rollback after an injected partial failure.

These obligations must remain fail-closed until an ordered operation plan and the necessary evidence connectors exist.

### 5.3 Evidence is HTTP-centric

Acceptance evidence currently records request, response, assertions, transport state and API binding. A common evidence contract is still needed for:

- before/after resource snapshots;
- database rows and transaction state;
- audit records;
- queue messages and domain events;
- Provider requests/callbacks and call counts;
- billing ledger entries;
- cache state;
- browser/UI state.

A response status is not a substitute for these channels.

### 5.4 The `TaskDef` chain bypasses requirement traceability

The JSON and TypeScript Wan3 tasks enter the generic Engine directly. They do not carry Requirement Fact, Acceptance Criterion, Objective, Scenario or assertion-provenance links. The current active tasks also declare no explicit `assert`, Data Factory, setup or teardown and rely on the default assertion registry.

Some legacy default checks return `pass=true` when data is unavailable or merely report configured account information. Unless marked informational or skipped, such checks can be interpreted as business assertions. These assets must not be treated as equivalent to evidence-backed Acceptance Scenarios.

### 5.5 Scenario Markdown fields are not structured

The current Requirement Parser recognizes API operations, parameter tables, actors, responses, ACs and selected permission/isolation/business prose. It does not yet compile the following scenario-level fields:

- Scenario ID, priority, risk and dependencies;
- Preconditions and owned test data;
- ordered execution steps;
- expected persistent state and side effects;
- evidence obligations and evidence source;
- prepare and cleanup plan;
- requested execution mode and structured blocked reason.

### 5.6 Prepare and cleanup are not scenario-local proof steps

Acceptance supports run-level lifecycle requests through configuration, but their responses are not scenario evidence and their outputs do not form a typed resource context for later operations. The generic Engine has a Data Session abstraction, but current task assets do not use a registered production Data Factory. Scenario-level ownership, cleanup verification and residual-data evidence remain incomplete.

### 5.7 Result contracts are split

Runtime status already distinguishes `PASS`, `FAIL`, `BLOCKED`, `NOT_EXECUTED`, `TIMEOUT` and `CANCELLED`, while design-time execution mode uses a different vocabulary. Block reasons and assertion counts are not represented consistently across the Acceptance and generic Engine paths. A unified result must preserve independent facts such as `executed`, `processor`, assertion counts, evidence and blocked reason; callers must not infer them from status alone.

### 5.8 Documentation contains legacy semantics

The existing test-case template uses `PASS / FAIL / 待人工` in a design-time result column. The SOP still describes half-automatic execution for an unavailable Processor and includes an obsolete Processor example. Design completion, report generation and execution completion must be documented as separate facts.

## 6. Asset classification policy

Every existing and new Markdown should be classified as exactly one of:

| Class | Definition |
| --- | --- |
| `EXECUTABLE_SCENARIO` | Source scenario with complete execution, assertion and evidence obligations; passing the executability gate does not mean it has executed |
| `DESIGN_DOCUMENT` | Architecture, specification or test-design guidance; never sent directly to a Runner |
| `ACCEPTANCE_REPORT` | Deterministic output from an execution or design run |
| `GENERATED_ARTIFACT` | Tool-generated attachment, debug product or transient report data |
| `TEMPLATE` | Copyable schema/example that contains no product-specific execution authority |
| `LEGACY` | Retained historical asset using an older task or result contract |

Classification is metadata, not a test outcome.

## 7. Migration principles

1. Preserve historical reports and generated attachments; do not rewrite them as source scenarios.
2. Establish the scenario schema, template, Pattern library and validator before migrating product examples.
3. Move only genuine source scenarios into `tests/acceptance/scenarios/`.
4. Start with the current persisted profile fixture and a small number of high-risk proof scenarios.
5. Extract formal TypeScript ground truths gradually; keep their oracle semantics and source attribution intact.
6. Select one source of truth for duplicated JSON/TypeScript tasks before removing either copy.
7. Keep unsupported proof obligations `DESIGNED_ONLY` or `BLOCKED`; never weaken an assertion to make a Case executable.
8. Never infer missing Method, Path, identity, ownership, pricing or business rules.
9. Require each AC to trace to Scenario, operation plan, assertions and evidence.
10. Require prepare and cleanup ownership, including evidence that cleanup actually completed when residual data is a risk.
11. Keep Pattern documents independent from product-specific fields and credentials.
12. Do not use scenario quality score as an execution result; `quality=100` with `NOT_EXECUTED` is valid.

## 8. Executability gate for migrated scenarios

A migrated scenario can be marked `EXECUTABLE` only when all applicable items are known and machine-checkable:

- exact operation Method and Path for every API action;
- explicit Actor, authentication reference, Tenant, Project and resource owner;
- deterministic test data and a typed prepare result;
- an available Processor/Executor for every step;
- response assertions;
- state and side-effect assertions required by the selected Patterns;
- a concrete evidence source for each assertion;
- cleanup behavior and ownership;
- a safe environment and execution policy decision.

If any required proof channel is absent, the scenario must stop before side effects and expose a structured reason such as `REQUIREMENT_CONFLICT`, `MISSING_API_CONTRACT`, `MISSING_PROCESSOR`, `MISSING_TEST_DATA`, `MISSING_ASSERTION`, `MISSING_EVIDENCE`, `MISSING_ENVIRONMENT` or `MISSING_DEPENDENCY`.
