// 端到端验收：通用 Requirement → TEST_CASE_V2 → Scenario Runtime 15 步闭环
// 15 步闭环：
//   1 需求解析 → 2 测试设计 → 3 风险评估 → 4 智能选择 → 5 覆盖分析 →
//   6 数据准备 → 7 执行 → 8 结果分析 → 9 根因分析(RCA) → 10 缺陷草稿(Defect) →
//   11 自愈建议(Healing) → 12 分级审批(Approval) → 13 记忆写入(Memory) →
//   14 观测(Trace) → 15 预算控制(Budget)
// 使用 MockLLM + Scenario Processor，Generator 产物不经过手工任务编译。
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createAgentContext,
  createDataPrepareTool,
  createExecutionRunTool,
  JsonMemoryStore,
  ToolRegistry,
  runAgentPipeline,
} from '../../src/agents/index.js';
import type { AgentTool } from '../../src/agents/tools/tool.js';
import type { EvidenceEnvelope } from '../../src/acceptance/scenario-contract.js';
import type { ScenarioProcessor } from '../../src/acceptance/scenario-runner.js';
import { MockLLMProvider } from '../../src/llm/index.js';

const DEMO = `# 通用资源创建
## Actors
| actorId | userId | role | tenantId | projectId | tokenRef |
| --- | --- | --- | --- | --- | --- |
| user-a | user-a | USER | tenant-a | project-a | token-user-a |
## Authentication
Bearer Token 认证。
## API
POST /resources
## Acceptance Criteria
AC-1 user-a 创建自己拥有的 Resource resourceId=resource-a，返回 HTTP 201。`;

function setPath(target: Record<string, unknown>, pathValue: string, value: unknown): void {
  const parts = pathValue.replace(/^\$\.?/, '').split('.').filter(Boolean);
  let cursor = target;
  for (const [index, part] of parts.entries()) {
    if (index === parts.length - 1) cursor[part] = value;
    else cursor = (cursor[part] ??= {}) as Record<string, unknown>;
  }
}

const runtimeProcessor: ScenarioProcessor = {
  name: 'e2e-scenario-runtime', supportsAbort: true,
  supportedEvidenceKinds: ['REQUEST', 'RESPONSE', 'STATE_BEFORE', 'STATE_AFTER', 'DATABASE', 'RESOURCE', 'AUDIT_RECORD', 'OTHER'],
  supports: () => true, supportsEvidence: () => true,
  execute: async (operation, context) => ({
    status: 'PASS', executed: true,
    evidence: context.scenario.evidenceRequirements.filter((item) => item.operationId === operation.id).map((requirement): EvidenceEnvelope => {
      const data: Record<string, unknown> = {};
      for (const assertionId of requirement.assertionIds) {
        const assertion = context.scenario.assertions.find((item) => item.id === assertionId);
        if (assertion) setPath(data, assertion.target, assertion.operator === 'EXISTS' ? 'observed'
          : assertion.operator === 'NOT_EXISTS' ? undefined : assertion.expectedFrom ? 'observed' : assertion.expected);
      }
      return {
        id: requirement.id, requirementId: requirement.id, scenarioId: context.scenario.id,
        operationId: operation.id, acceptanceCriteriaIds: context.scenario.acceptanceCriteriaIds,
        kind: requirement.kind, channel: requirement.channel, source: 'e2e-scenario-runtime',
        observedAt: new Date().toISOString(), data, verified: true,
      };
    }),
  }),
};

let dir: string;
let file: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-'));
  file = path.join(dir, 'memory.json');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('端到端验收 - 通用 V2 Case 15 步闭环', () => {
  it('走通全链路并产出全部阶段产物', async () => {
    const memory = new JsonMemoryStore(file);
    const tools = new ToolRegistry();
    tools.register(createDataPrepareTool(() => ({
      async setup() { return {}; },
      async teardown() { /* fixture has no external resources */ },
      async generate() {
        return {
          account: { id: 'e2e-account', nickname: 'qa', project_id: 1 },
          assets: [{ id: 'e2e-asset', type: 'video', url: 'mock://video' }],
        };
      },
    })));
    tools.register(createExecutionRunTool());
    const context = createAgentContext({
      taskId: 'e2e-demo',
      feature: 'resource',
      environment: 'test',
      tools,
      memory,
      llm: new MockLLMProvider(),
      metadata: {
        scenarioRunnerOptions: {
          processors: [runtimeProcessor], environmentAvailable: true, policyAllowed: true,
          availableDependencies: new Set(['runtime.caseCleanup']),
          cleanupHooks: new Map([['runtime.caseCleanup', async () => ({})]]),
        },
      },
    });

    const r = await runAgentPipeline(
      {
        requirementText: DEMO,
        environment: 'test',
        options: {
          budget: { maxTokens: 100000000 },
          executionApproval: { id: 'e2e-human-approval', status: 'APPROVED', approvedBy: 'e2e-reviewer' },
        },
      },
      context,
    );

    // 1 需求解析 / 2 测试设计 / 3 风险评估
    expect(r.stages.requirement).toBe(true);
    expect(r.requirement.feature).toBeTruthy();
    expect(r.testCases.length).toBeGreaterThan(0);
    expect(r.risk.risks.length).toBeGreaterThan(0);

    // 4 智能选择 / 5 覆盖分析
    expect(r.stages.selection).toBe(true);
    expect(r.selection!.selectedCases.length).toBeGreaterThan(0);
    expect(r.stages.coverage).toBe(true);
    expect(r.coverage!.dimensions.length).toBeGreaterThan(0);

    // 6 数据准备 / 7 执行
    expect(r.dataPlan).toBeDefined();
    // Contract-only 设计项仍保持未执行，严格区分“部分已执行”与“全部已执行”。
    expect(r.outcome.executed).toBe(false);
    expect(r.outcome.results.some((item) => item.status === 'PASS' && item.executed
      && item.processor === 'e2e-scenario-runtime' && item.processorInvoked
      && item.checks?.some((check) => check.kind === 'BUSINESS'))).toBe(true);
    expect(r.outcome.timedOut).toBe(0);

    // 8 结果分析
    expect(r.report.findings.length).toBeGreaterThan(0);

    // 9 根因分析（覆盖全部失败用例，evidence 链完整）
    expect(r.rcas!.length).toBeGreaterThanOrEqual(1);
    expect(r.rcas!.every((x) => x.confidence > 0)).toBe(true);

    // 10 缺陷草稿（仅 DRAFT，未提交）
    expect(r.defects!.length).toBeGreaterThanOrEqual(1);
    expect(r.defects!.every((d) => d.status === 'DRAFT')).toBe(true);

    // 11 自愈建议保持建议态；没有路径失败时允许为空。
    expect(r.healing!.suggestions.every((s) => s.status === 'SUGGESTED')).toBe(true);

    // 12 分级审批 + 审计日志（缺陷草稿 + 自愈建议全部产生审批请求）
    expect(r.approvals!.length).toBeGreaterThanOrEqual(1);
    expect(r.audit!.length).toBe(r.approvals!.length);

    // 13 部分真实执行仍写入真实摘要；DESIGNED_ONLY 不会被伪造成 PASS。
    const all = await memory.query();
    expect(all.some((record) => record.type === 'execution')).toBe(true);

    // 14 观测 Trace（各阶段 span 齐全）
    expect(r.trace!.spans.length).toBeGreaterThanOrEqual(10);
    expect(r.trace!.spans.some((s) => s.agent === 'root-cause')).toBe(true);
    expect(r.trace!.spans.some((s) => s.agent === 'approval')).toBe(true);

    // 15 预算控制（未超限，流程完整）
    expect(r.budgetStatus!.exceededAny).toBe(false);

    expect(r.exitCode).toBe(1);
    expect(r.durationMs).toBeGreaterThan(0);
  });

  it('生产环境执行时拒绝危险操作（安全边界联动）', async () => {
    // 模拟真实执行工具被标记 dangerous 且无审批 → 生产环境直接拒绝
    const dangerousTool: AgentTool<{ cmd: string }, string> = {
      name: 'sys.exec',
      description: '执行系统命令',
      inputSchema: {},
      outputSchema: {},
      permission: 'dangerous',
      async execute(input) {
        return input.cmd;
      },
    };
    const tools = new ToolRegistry({ environment: 'prod' });
    tools.register(dangerousTool);
    const context = createAgentContext({
      taskId: 'e2e-safe',
      feature: 'resource',
      environment: 'prod',
      tools,
      memory: new JsonMemoryStore(file),
      llm: new MockLLMProvider(),
    });
    const res = await tools.call('sys.exec', { cmd: 'rm -rf /' }, context);
    expect(res.ok).toBe(false);
    expect(res.error).toContain('生产环境禁止');
  });
});
