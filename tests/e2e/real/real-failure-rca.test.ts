// 真实失败 RCA 验证（Phase 20.3）：
// 对任务书要求的 14 种真实失败（HTTP 400/401/403/404/429/500/502/503、超时、依赖、
// 模型、计费、数据、环境）逐一执行完整 RCA（证据链 + 确定性分类 + RootCauseAgent）。
// 铁律验证：每条 RCA 必须包含事实/证据/置信度，禁止「无证据结论」；
// 使用 MockLLM（非 RootCause 输出）强制走确定性回退，确保结论全部来自证据链而非 LLM 猜测。
// 本文件为合成失败场景（无真实副作用），offline 常驻运行。
import { describe, it, expect } from 'vitest';
import {
  createAgentContext,
  createRootCauseAgent,
  NoopMemory,
  ToolRegistry,
  classifyFailure,
  collectEvidence,
} from '../../../src/agents/index.js';
import type { CaseExecutionResult } from '../../../src/agents/execution/execution-schema.js';
import { MockLLMProvider } from '../../../src/llm/index.js';

/** 14 种真实失败场景 */
interface FailureScenario {
  id: string;
  name: string;
  error?: string;
  timedOut?: boolean;
  checks?: CaseExecutionResult['checks'];
  expected: string;
  /** 是否允许排除项验证 */
  withExclusion?: boolean;
}

const SCENARIOS: FailureScenario[] = [
  { id: 'http-400', name: '请求参数错误', error: 'LLM 请求失败（HTTP 400）：row[extra][duration] 取值非法', expected: 'TEST_CODE_ERROR' },
  { id: 'http-401', name: '未授权', error: 'LLM 请求失败（HTTP 401）：invalid token', expected: 'AUTH_ERROR' },
  { id: 'http-403', name: '无权限', error: '提交失败（HTTP 403）：权限不足', expected: 'AUTH_ERROR' },
  { id: 'http-404', name: '路径不存在', error: 'LLM 请求失败（HTTP 404）：接口路径不存在', expected: 'TEST_CODE_ERROR' },
  { id: 'http-429', name: '限流', error: 'LLM 请求失败（HTTP 429）：rate limit exceeded', expected: 'RATE_LIMIT_ERROR' },
  { id: 'http-500', name: '服务端错误', error: '提交失败（HTTP 500）：internal server error', expected: 'MODEL_ERROR' },
  { id: 'http-502', name: '网关错误', error: 'LLM 请求失败（HTTP 502）：bad gateway', expected: 'MODEL_ERROR' },
  { id: 'http-503', name: '服务不可用', error: 'LLM 请求失败（HTTP 503）：service unavailable', expected: 'MODEL_ERROR' },
  { id: 'timeout', name: '执行超时', error: '提交任务超时（30000ms）', timedOut: true, expected: 'TIMEOUT' },
  { id: 'dependency', name: '依赖服务故障', error: '依赖服务不可用：上游计费服务 503，dependency unavailable', expected: 'DEPENDENCY_ERROR' },
  { id: 'model', name: '模型服务异常', error: '模型健康检查失败：模型服务超时（model service unavailable）', expected: 'MODEL_ERROR' },
  { id: 'billing', name: '计费失败', error: '积分扣费失败：账户余额不足（insufficient credits）', expected: 'BILLING_ERROR' },
  { id: 'data', name: '测试数据缺失', error: '测试数据缺失：用户档案不存在（data not found）', expected: 'DATA_ERROR' },
  { id: 'environment', name: '环境未就绪', error: '环境未就绪：test 环境数据库未启动', expected: 'ENVIRONMENT_ERROR' },
];

function buildResult(s: FailureScenario): CaseExecutionResult {
  return {
    caseId: s.id,
    name: s.name,
    feature: 'wan3',
    pass: false,
    passRate: 0,
    error: s.error,
    timedOut: s.timedOut ?? false,
    durationMs: s.timedOut ? 31000 : 1200,
    checks: s.checks ?? (s.timedOut ? [] : [{ name: 'real-api', pass: false, detail: s.error ?? '失败' }]),
  };
}

describe('真实失败 RCA（14 种，证据驱动）', () => {
  const rcaAgent = createRootCauseAgent();
  const context = createAgentContext({
    taskId: 'real-failure-rca',
    feature: 'wan3',
    environment: 'test',
    llm: new MockLLMProvider(), // 非 RootCause 输出 → 强制确定性回退，杜绝 LLM 猜测
    memory: new NoopMemory(),
    tools: new ToolRegistry(),
  });

  it('覆盖全部 14 种真实失败分类', () => {
    expect(SCENARIOS.length).toBe(14);
  });

  for (const s of SCENARIOS) {
    it(`${s.id}（${s.name}）→ ${s.expected}，且证据完整（事实/置信度/排除项/建议）`, async () => {
      const result = buildResult(s);

      // 1. 确定性分类
      const cls = classifyFailure(result);
      expect(cls.category).toBe(s.expected);
      expect(cls.confidence).toBeGreaterThanOrEqual(0.85);

      // 2. 证据链：必须有确定事实（禁止无证据结论）
      const evidence = collectEvidence({
        executionResult: result,
        environment: 'test',
        feature: 'wan3',
        outcome: {
          feature: 'wan3', total: 1, passed: 0, failed: 1, timedOut: s.timedOut ? 1 : 0,
          passRate: 0, results: [result], reports: [], executed: true,
        },
      });
      expect(evidence.items.length).toBeGreaterThan(0);
      expect(evidence.facts.length).toBeGreaterThan(0);
      expect(evidence.items.every((e) => e.certainty === 'fact')).toBe(true);

      // 3. 完整 RCA（确定性回退，source=rules）
      const rca = await rcaAgent.execute({ executionResult: result, environment: 'test' }, context);
      expect(rca.caseId).toBe(s.id);
      expect(rca.category).toBe(s.expected);
      expect(rca.confidence).toBeGreaterThanOrEqual(0.85);
      expect(rca.source).toBe('rules');
      // 事实 / 证据非空
      expect(rca.facts.length).toBeGreaterThan(0);
      expect(rca.evidence.length).toBeGreaterThan(0);
      // 结构化证据全部为确定事实
      expect(rca.evidenceItems.length).toBeGreaterThan(0);
      expect(rca.evidenceItems.every((e) => e.certainty === 'fact')).toBe(true);
      // 排除项与建议字段存在（可填空，但字段必须输出）
      expect(Array.isArray(rca.excludedCauses)).toBe(true);
      expect(typeof rca.recommendedAction).toBe('string');
      expect(rca.recommendedAction.length).toBeGreaterThan(0);
    });
  }

  it('LLM 输出合法分类时保留证据链事实（分类映射完整）', async () => {
    // 用脚本化 LLM 输出一个合法的 RootCause（含新分类 RATE_LIMIT_ERROR），
    // 验证 schema 校验接受新分类且证据链事实被保留
    const llm = new MockLLMProvider({
      defaultResponse: JSON.stringify({
        caseId: 'http-429',
        category: 'RATE_LIMIT_ERROR',
        confidence: 0.92,
        rootCause: 'HTTP 429 限流导致失败',
        evidence: ['HTTP 429'],
        excludedCauses: ['Test Data', 'Assertion'],
        recommendedAction: '降低并发或等待限流窗口',
      }),
    });
    const ctx = createAgentContext({
      taskId: 'x', feature: 'wan3', environment: 'test',
      llm, memory: new NoopMemory(), tools: new ToolRegistry(),
    });
    const rca = await rcaAgent.execute(
      { executionResult: buildResult(SCENARIOS.find((s) => s.id === 'http-429')!), environment: 'test' },
      ctx,
    );
    expect(rca.category).toBe('RATE_LIMIT_ERROR');
    expect(rca.excludedCauses).toContain('Test Data');
    expect(rca.facts.length).toBeGreaterThan(0);
    expect(rca.source).toBe('llm');
  });
});
