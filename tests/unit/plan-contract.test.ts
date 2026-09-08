// plan-contract 单元测试：结构化测试计划的确定性校验 / 归一化 / 哈希 / 分类 / SSRF。
// 覆盖验收：合法 plan 校验持久化、重复 case id 拒绝、敏感字段拒绝、
//          跨域与 SSRF 拒绝、assertion expected 确定性校验、哈希确定性。
import { describe, it, expect } from 'vitest';
import {
  validatePlan,
  planHash,
  generatePlanId,
  classifyPlanCase,
  isBlockedHost,
} from '../../src/agents/plan/plan-contract.js';

function apiCase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'C1',
    name: '健康检查',
    priority: 'P1',
    type: 'API',
    steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/health' }],
    assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
    ...overrides,
  };
}

function basePlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    requirement_summary: '测试需求',
    target_url: 'https://api.example.com/',
    environment: 'test',
    test_scope: 'api',
    test_cases: [apiCase()],
    risks: [{ id: 'R1', level: 'MEDIUM', category: '稳定性', description: '风险', affected_cases: ['C1'] }],
    ...overrides,
  };
}

describe('plan-contract：合法 plan 校验与哈希', () => {
  it('合法 plan 通过校验并返回归一化结果', () => {
    const v = validatePlan(basePlan());
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.normalized.schemaVersion).toBe('PANQU_TEST_PLAN_V1');
    expect(v.normalized.testCases).toHaveLength(1);
    expect(v.normalized.testCases[0].id).toBe('C1');
  });

  it('plan_hash 为 64 位十六进制且具备确定性', () => {
    const v1 = validatePlan(basePlan());
    const v2 = validatePlan(basePlan());
    expect(v1.ok && v2.ok).toBe(true);
    if (!v1.ok || !v2.ok) return;
    expect(planHash(v1.normalized)).toBe(planHash(v2.normalized));

    const changed = validatePlan(basePlan({ requirement_summary: '另一需求' }));
    if (!changed.ok) return;
    expect(planHash(changed.normalized)).not.toBe(planHash(v1.normalized));
  });

  it('generatePlanId 返回安全格式', () => {
    const id = generatePlanId('plan');
    expect(id).toMatch(/^plan-[a-z0-9]+-[a-f0-9]{12}$/);
  });
});

describe('plan-contract：安全校验', () => {
  it('重复 case id 被拒绝', () => {
    const v = validatePlan(basePlan({ test_cases: [apiCase(), apiCase()] }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain('DUPLICATE_CASE_ID');
  });

  it('test_cases 为空数组被拒绝（minItems=1）', () => {
    const v = validatePlan(basePlan({ test_cases: [] }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain('TEST_CASES_MIN');
  });

  it('Authorization/Cookie/Token 等敏感 header 被拒绝', () => {
    const plan = basePlan({
      test_cases: [apiCase({ steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/health', headers: { Authorization: 'Bearer x' } }] })],
    });
    const v = validatePlan(plan);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain('SENSITIVE_HEADER');
  });

  it('body 内敏感字段（token/secret）被拒绝', () => {
    const plan = basePlan({
      test_cases: [apiCase({ steps: [{ type: 'HTTP_REQUEST', method: 'POST', url: '/x', body: { token: 'abc' } }] })],
    });
    const v = validatePlan(plan);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain('SENSITIVE_FIELD');
  });

  it.each(['host', 'Host', 'hOsT'])('Host 头（大小写不敏感 %s）被拒绝（FORBIDDEN_HEADER）', (headerKey) => {
    const plan = basePlan({
      test_cases: [apiCase({ steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/health', headers: { [headerKey]: 'evil.example' } }] })],
    });
    const v = validatePlan(plan);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain('FORBIDDEN_HEADER');
  });

  it.each(['connection', 'proxy-connection', 'transfer-encoding', 'content-length', 'upgrade', 'trailer', 'te'])(
    'hop-by-hop 头 %s 被拒绝（FORBIDDEN_HEADER）',
    (headerKey) => {
      const plan = basePlan({
        test_cases: [apiCase({ steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/health', headers: { [headerKey]: 'x' } }] })],
      });
      const v = validatePlan(plan);
      expect(v.ok).toBe(false);
      if (v.ok) return;
      expect(v.errors.map((e) => e.code)).toContain('FORBIDDEN_HEADER');
    },
  );

  it('跨域 step.url 被拒绝', () => {
    const plan = basePlan({
      test_cases: [apiCase({ steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: 'https://evil.example.com/steal' }] })],
    });
    const v = validatePlan(plan);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain('STEP_URL_CROSS_ORIGIN');
  });

  it('SSRF 目标（localhost / metadata / 内网）被拒绝', () => {
    for (const host of ['https://localhost/x', 'http://169.254.169.254/latest', 'http://127.0.0.1/x', 'http://10.0.0.1/x']) {
      const v = validatePlan(basePlan({ target_url: host }));
      expect(v.ok).toBe(false);
      if (!v.ok) expect(v.errors.map((e) => e.code)).toContain('URL_SSRF_BLOCKED');
    }
  });

  it('assertion expected 是否必填按 operator 确定性校验', () => {
    const missing = validatePlan(basePlan({
      test_cases: [apiCase({ assertions: [{ type: 'STATUS_CODE', operator: 'equals' }] })],
    }));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.errors.map((e) => e.code)).toContain('ASSERTION_EXPECTED_REQUIRED');

    const okExists = validatePlan(basePlan({
      test_cases: [apiCase({ assertions: [{ type: 'JSON_PATH', path: 'data.id', operator: 'exists' }] })],
    }));
    expect(okExists.ok).toBe(true);
  });

  it('risk affectedCases 引用不存在的 case id 被拒绝', () => {
    const v = validatePlan(basePlan({ risks: [{ id: 'R1', level: 'MEDIUM', category: 'x', description: 'x', affected_cases: ['NOPE'] }] }));
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.errors.map((e) => e.code)).toContain('RISK_AFFECTED_INVALID');
  });

  it('isBlockedHost 正确识别保留/内网地址', () => {
    expect(isBlockedHost('localhost')).toBe(true);
    expect(isBlockedHost('169.254.169.254')).toBe(true);
    expect(isBlockedHost('192.168.1.1')).toBe(true);
    expect(isBlockedHost('api.example.com')).toBe(false);
  });
});

describe('plan-contract：第一阶段用例分类', () => {
  it('API + 单一 HTTP step + 断言 → EXECUTABLE', () => {
    const v = validatePlan(basePlan());
    if (!v.ok) return;
    expect(classifyPlanCase(v.normalized.testCases[0]).classification).toBe('EXECUTABLE');
  });

  it('FUNCTIONAL / UI / BROWSER → DESIGNED_ONLY', () => {
    for (const type of ['FUNCTIONAL', 'UI', 'BROWSER']) {
      const v = validatePlan(basePlan({ test_cases: [apiCase({ type })] }));
      if (!v.ok) continue;
      const r = classifyPlanCase(v.normalized.testCases[0]);
      expect(r.classification).toBe('DESIGNED_ONLY');
    }
  });

  it('需要鉴权（credential_ref）→ DESIGNED_ONLY', () => {
    const v = validatePlan(basePlan({ test_cases: [apiCase({ credential_ref: 'svc-account' })] }));
    if (!v.ok) return;
    expect(classifyPlanCase(v.normalized.testCases[0]).classification).toBe('DESIGNED_ONLY');
  });
});

describe('plan-contract：设计态用例类型保留（不强迫 method/url）', () => {
  const designTypes = ['FUNCTIONAL', 'UI', 'BROWSER', 'DATA_ISOLATION', 'SECURITY', 'BUSINESS_RULE', 'STATE', 'ERROR', 'BOUNDARY', 'COMPATIBILITY'];

  it.each(designTypes)('type=%s 用 DESCRIPTION 步骤 + 前置/清理可正常保存', (type) => {
    const plan = basePlan({
      test_cases: [
        {
          id: 'D1',
          name: '设计态用例',
          priority: 'P1',
          type,
          preconditions: ['数据已就绪'],
          cleanup: ['清理脏数据'],
          steps: [{ type: 'DESCRIPTION', description: '设计态步骤，不执行' }],
          assertions: [],
        },
      ],
      risks: [],
    });
    const v = validatePlan(plan);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.normalized.testCases[0].preconditions).toEqual(['数据已就绪']);
    expect(v.normalized.testCases[0].cleanup).toEqual(['清理脏数据']);
    expect(classifyPlanCase(v.normalized.testCases[0]).classification).toBe('DESIGNED_ONLY');
  });
});

describe('plan-contract：运行时严格字段校验（拒绝未知/危险字段）', () => {
  it('顶层 execution_approval 被拒绝（FORBIDDEN_FIELD）', () => {
    const v = validatePlan(basePlan({ execution_approval: {} }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain('FORBIDDEN_FIELD');
  });

  it('顶层 unknown_field 被拒绝（UNKNOWN_FIELD）', () => {
    const v = validatePlan(basePlan({ unknown_field: 'x' }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain('UNKNOWN_FIELD');
  });

  it.each(['command', 'shell', 'file_path'])('case 层危险字段 %s 被拒绝（FORBIDDEN_FIELD）', (field) => {
    const v = validatePlan(basePlan({ test_cases: [apiCase({ [field]: 'x' })] }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain('FORBIDDEN_FIELD');
  });

  it('step 层 command 被拒绝（FORBIDDEN_FIELD）', () => {
    const v = validatePlan(basePlan({
      test_cases: [apiCase({ steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: '/x', command: 'x' }] })],
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain('FORBIDDEN_FIELD');
  });

  it('assertion 层 shell 被拒绝（FORBIDDEN_FIELD）', () => {
    const v = validatePlan(basePlan({
      test_cases: [apiCase({ assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200, shell: 'x' }] })],
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain('FORBIDDEN_FIELD');
  });

  it('risk 层 file_path 被拒绝（FORBIDDEN_FIELD）', () => {
    const v = validatePlan(basePlan({
      risks: [{ id: 'R1', level: 'MEDIUM', category: 'x', description: 'x', file_path: '/tmp/x' }],
    }));
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.errors.map((e) => e.code)).toContain('FORBIDDEN_FIELD');
  });
});