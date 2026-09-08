// plan-executor 单元测试：确定性 HTTP 执行器（无 LLM、无真实网络，传输层 stubbed）。
// 覆盖验收：HTTP API 用例确定性执行；POST/DELETE 等非只读方法不执行（DESIGNED_ONLY）；
//          DNS 解析到私网/loopback BLOCKED；跨域重定向 BLOCKED；大响应流式中止（RESPONSE_TOO_LARGE）；
//          budget_cases / budget_duration 生效；DESIGNED_ONLY 不进入通过率分母；
//          DNS rebinding：socket 绑定「已校验公开 IP」（pinned lookup），不二次解析 hostname。
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  executePlan,
  summarize,
  pinnedLookupFactory,
  resolveHostWithTimeout,
  type PinnedHttpResponse,
  type PinnedHttpTransport,
} from '../../src/agents/orchestration/plan-executor.js';
import type { PlanCaseExecutionResult } from '../../src/agents/orchestration/plan-executor.js';
import { validatePlan } from '../../src/agents/plan/plan-contract.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function apiCase(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `用例 ${id}`,
    priority: 'P1',
    type: 'API',
    steps: [{ type: 'HTTP_REQUEST', method: 'GET', url: `/x/${id}` }],
    assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 200 }],
    ...overrides,
  };
}

function validPlanInput(cases: Record<string, unknown>[] = [apiCase('C1')]): Record<string, unknown> {
  return {
    requirement_summary: 'x',
    target_url: 'https://api.example.com/',
    environment: 'test',
    test_scope: 'api',
    test_cases: cases,
    risks: [],
  };
}

const ALLOWED = new Set(['https://api.example.com']);
const PUBLIC_DNS = async (hostname: string): Promise<string[]> => (hostname === 'api.example.com' ? ['93.184.216.34'] : ['1.2.3.4']);

function okResponse(status = 200, body = '{"ok":true}', headers: Record<string, string> = {}): PinnedHttpResponse {
  return {
    status,
    statusText: String(status),
    headers: { 'content-type': 'application/json', ...headers },
    readText: async () => ({ ok: true, text: body }),
    drain: async () => {},
  };
}

function redirectResponse(location: string): PinnedHttpResponse {
  return { status: 302, statusText: 'Found', headers: { location }, readText: async () => ({ ok: true, text: '' }), drain: async () => {} };
}

function tooLargeResponse(): PinnedHttpResponse {
  return { status: 200, statusText: 'OK', headers: {}, readText: async () => ({ ok: false, error: 'RESPONSE_TOO_LARGE' }), drain: async () => {} };
}

const noopTransport: PinnedHttpTransport = async () => okResponse(200);

describe('plan-executor：确定性执行', () => {
  it('HTTP GET 用例确定性评估断言（PASSED）', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn(async () => okResponse(200));

    const result = await executePlan(v.normalized, { allowedTargetOrigins: ALLOWED, resolveHost: PUBLIC_DNS, transport });
    expect(result.caseResults[0].status).toBe('PASSED');
    expect(result.summary.passed).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('POST/DELETE 非只读方法标记为 DESIGNED_ONLY，不发起网络请求', async () => {
    const input = validPlanInput([
      apiCase('C1', { steps: [{ type: 'HTTP_REQUEST', method: 'POST', url: '/create' }], assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 201 }] }),
      apiCase('C2', { steps: [{ type: 'HTTP_REQUEST', method: 'DELETE', url: '/remove' }], assertions: [{ type: 'STATUS_CODE', operator: 'equals', expected: 204 }] }),
    ]);
    const v = validatePlan(input);
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn();

    const result = await executePlan(v.normalized, { allowedTargetOrigins: ALLOWED, resolveHost: PUBLIC_DNS, transport });
    expect(result.caseResults.every((c) => c.status === 'DESIGNED_ONLY')).toBe(true);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('plan-executor：SSRF / allowlist / 重定向', () => {
  it('allowlist 未配置时 fail-closed（不请求网络）', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn();

    const result = await executePlan(v.normalized, { resolveHost: PUBLIC_DNS, transport });
    expect(result.caseResults[0].status).toBe('BLOCKED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('target origin 不在允许列表时 BLOCKED', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    v.normalized.targetUrl = 'https://evil.example.com/';
    const transport = vi.fn();

    const result = await executePlan(v.normalized, { allowedTargetOrigins: ALLOWED, resolveHost: PUBLIC_DNS, transport });
    expect(result.caseResults[0].status).toBe('BLOCKED');
    expect(transport).not.toHaveBeenCalled();
  });

  it('跨域重定向被 BLOCKED（不跟随）', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn(async () => redirectResponse('https://evil.example.com/next'));

    const result = await executePlan(v.normalized, { allowedTargetOrigins: ALLOWED, resolveHost: PUBLIC_DNS, transport });
    expect(result.caseResults[0].status).toBe('BLOCKED');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('同源重定向会 drain 重定向响应体并继续', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    let drained = false;
    const transport = vi.fn<PinnedHttpTransport>(async () => {
      if (transport.mock.calls.length === 1) {
        return { status: 302, statusText: 'Found', headers: { location: '/next' }, readText: async () => ({ ok: true as const, text: '' }), drain: async () => { drained = true; } };
      }
      return okResponse(200, '{"ok":true}');
    });

    const result = await executePlan(v.normalized, { allowedTargetOrigins: ALLOWED, resolveHost: PUBLIC_DNS, transport });
    expect(drained).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.caseResults[0].status).toBe('PASSED');
  });
});

describe('plan-executor：DNS SSRF（解析后逐 IP 复查）', () => {
  it.each(['127.0.0.1', '10.0.0.1', '::1', 'fd00::1'])('域名解析到 %s 时 BLOCKED', async (ip) => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    v.normalized.targetUrl = 'https://rebind.example.com/';
    const allowed = new Set(['https://rebind.example.com']);
    const transport = vi.fn();

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: allowed,
      resolveHost: async () => [ip],
      transport,
    });
    expect(result.caseResults[0].status).toBe('BLOCKED');
    expect(result.caseResults[0].reason).toContain('SSRF');
    expect(transport).not.toHaveBeenCalled();
  });

  it('DNS 解析失败时 fail-closed（BLOCKED）', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn();

    const result = await executePlan(v.normalized, { allowedTargetOrigins: ALLOWED, resolveHost: async () => { throw new Error('nxdomain'); }, transport });
    expect(result.caseResults[0].status).toBe('BLOCKED');
    expect(result.caseResults[0].reason).toContain('DNS');
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('plan-executor：响应体大小限制（流式读取）', () => {
  it('超过 maxResponseBytes 立即中止，返回 RESPONSE_TOO_LARGE，不执行断言', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    let readMax = 0;
    const transport = vi.fn(async () => ({ status: 200, statusText: 'OK', headers: {}, readText: async (max: number) => { readMax = max; return { ok: false, error: 'RESPONSE_TOO_LARGE' } as const; }, drain: async () => {} }));

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: ALLOWED,
      resolveHost: PUBLIC_DNS,
      transport,
      maxResponseBytes: 100,
    });
    expect(result.caseResults[0].status).toBe('RESPONSE_TOO_LARGE');
    expect(result.caseResults[0].assertions).toHaveLength(0);
    expect(result.summary.responseTooLarge).toBe(1);
    expect(transport).toHaveBeenCalledTimes(1);
    expect(readMax).toBe(100);
  });
});

describe('plan-executor：预算真正生效', () => {
  it('budget_cases 限制可执行用例数，超出标 BLOCKED_BY_BUDGET', async () => {
    const input = validPlanInput([apiCase('C1'), apiCase('C2'), apiCase('C3')]);
    const v = validatePlan(input);
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn(async () => okResponse(200));

    const result = await executePlan(v.normalized, { allowedTargetOrigins: ALLOWED, resolveHost: PUBLIC_DNS, budgetCases: 2, transport });
    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.caseResults[2].status).toBe('BLOCKED_BY_BUDGET');
    expect(result.summary.blockedByBudget).toBe(1);
    expect(result.summary.executedTotal).toBe(2);
  });

  it('budget_duration 耗尽后停止后续用例，进行中请求 Abort', async () => {
    const input = validPlanInput([apiCase('C1'), apiCase('C2')]);
    const v = validatePlan(input);
    if (!v.ok) throw new Error('plan 应合法');
    let clock = 0;
    const transport = vi.fn(async () => {
      clock = 100; // 模拟首个请求耗时，使第二用例开始前 budget 已耗尽
      return okResponse(200);
    });

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: ALLOWED,
      resolveHost: PUBLIC_DNS,
      budgetDurationMs: 50,
      now: () => clock,
      transport,
    });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(result.caseResults[1].status).toBe('BLOCKED_BY_BUDGET');
  });
});

describe('plan-executor：DNS rebinding（socket 绑定已校验公开 IP）', () => {
  it('传输层收到已校验公开 IP（不二次解析 hostname）', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn<PinnedHttpTransport>(async () => okResponse(200));

    const result = await executePlan(v.normalized, { allowedTargetOrigins: ALLOWED, resolveHost: async () => ['1.2.3.4'], transport });
    expect(result.caseResults[0].status).toBe('PASSED');
    expect(transport).toHaveBeenCalledTimes(1);
    const req = transport.mock.calls[0][0];
    expect(req.addresses).toEqual(['1.2.3.4']);
    expect(req.url.hostname).toBe('api.example.com');
  });

  it('pinnedLookupFactory 返回仅指向已校验 IP 的 lookup 回调', () => {
    const lookup = pinnedLookupFactory(['1.2.3.4', '2001:db8::1']);
    const cb = vi.fn();
    lookup('api.example.com', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '1.2.3.4', 4);
  });

  it('pinnedLookupFactory 无可用地址时 fail-closed（返回 EAI_AGAIN）', () => {
    const lookup = pinnedLookupFactory([]);
    const cb = vi.fn();
    lookup('api.example.com', {}, cb);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(cb.mock.calls[0][0].code).toBe('EAI_AGAIN');
  });
});

describe('plan-executor：统计（DESIGNED_ONLY 不进入通过率分母）', () => {
  it('passed / executed_total，designed_only 不计入分母', () => {
    const results: PlanCaseExecutionResult[] = [
      { caseId: 'C1', name: 'a', classification: 'EXECUTABLE', status: 'PASSED', assertions: [] },
      { caseId: 'C2', name: 'b', classification: 'EXECUTABLE', status: 'FAILED', assertions: [] },
      { caseId: 'C3', name: 'c', classification: 'DESIGNED_ONLY', status: 'DESIGNED_ONLY', assertions: [] },
    ];
    const s = summarize(results);
    expect(s.designedTotal).toBe(3);
    expect(s.executableTotal).toBe(2);
    expect(s.executedTotal).toBe(2);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.blocked).toBe(0);
    expect(s.designedOnly).toBe(1);
    expect(s.passRate).toBe(50);
  });

  it('executed_total 为 0 时通过率为 null', () => {
    const results: PlanCaseExecutionResult[] = [
      { caseId: 'C1', name: 'ui', classification: 'DESIGNED_ONLY', status: 'DESIGNED_ONLY', assertions: [] },
    ];
    const s = summarize(results);
    expect(s.executedTotal).toBe(0);
    expect(s.passRate).toBe(null);
  });

  it('FUNCTIONAL / UI / DATA_ISOLATION 设计态不执行、不进入通过率', async () => {
    const input = validPlanInput([]);
    input.test_cases = [
      { id: 'C1', name: 'f', priority: 'P1', type: 'FUNCTIONAL', steps: [], assertions: [] },
      { id: 'C2', name: 'u', priority: 'P1', type: 'UI', steps: [], assertions: [] },
      { id: 'C3', name: 'd', priority: 'P1', type: 'DATA_ISOLATION', steps: [{ type: 'DESCRIPTION', description: '校验数据隔离' }], assertions: [] },
    ];
    const v = validatePlan(input);
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn();

    const result = await executePlan(v.normalized, { allowedTargetOrigins: ALLOWED, resolveHost: PUBLIC_DNS, transport });
    expect(result.caseResults.every((c) => c.status === 'DESIGNED_ONLY')).toBe(true);
    expect(result.summary.executedTotal).toBe(0);
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('plan-executor：Node 24 pinned lookup（options.all）', () => {
  it('options.all=true 返回地址数组（家庭号正确），只含 pinned 地址', () => {
    const lookup = pinnedLookupFactory(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    const cb = vi.fn();
    lookup('api.example.com', { all: true, hints: 1024 }, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0][0]).toBeNull();
    const list = cb.mock.calls[0][1] as Array<{ address: string; family: number }>;
    expect(Array.isArray(list)).toBe(true);
    expect(list.map((x) => x.address)).toEqual(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    expect(list.map((x) => x.family)).toEqual([4, 6]);
  });

  it('options.all=true 且无可用地址时 fail-closed（返回 EAI_AGAIN 与空数组）', () => {
    const lookup = pinnedLookupFactory([]);
    const cb = vi.fn();
    lookup('api.example.com', { all: true }, cb);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((cb.mock.calls[0][0] as NodeJS.ErrnoException).code).toBe('EAI_AGAIN');
    expect(cb.mock.calls[0][1]).toEqual([]);
  });

  it('options.all 缺省时沿用旧式单地址回调（IPv4 优先）', () => {
    const lookup = pinnedLookupFactory(['2606:2800:220:1:248:1893:25c8:1946', '93.184.216.34']);
    const cb = vi.fn();
    lookup('api.example.com', {}, cb);
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('options.all=false family=4 只返回 IPv4（双栈下不回退 IPv6）', () => {
    const lookup = pinnedLookupFactory(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    const cb = vi.fn();
    lookup('api.example.com', { family: 4 }, cb);
    expect(cb).toHaveBeenCalledWith(null, '93.184.216.34', 4);
  });

  it('options.all=false family=6 只返回 IPv6', () => {
    const lookup = pinnedLookupFactory(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    const cb = vi.fn();
    lookup('api.example.com', { family: 6 }, cb);
    expect(cb).toHaveBeenCalledWith(null, '2606:2800:220:1:248:1893:25c8:1946', 6);
  });

  it('options.all=true family=6 只返回 IPv6 地址数组', () => {
    const lookup = pinnedLookupFactory(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    const cb = vi.fn();
    lookup('api.example.com', { all: true, family: 6 }, cb);
    const list = cb.mock.calls[0][1] as Array<{ address: string; family: number }>;
    expect(list.map((x) => x.address)).toEqual(['2606:2800:220:1:248:1893:25c8:1946']);
    expect(list.map((x) => x.family)).toEqual([6]);
  });

  it('options.all=true family=4 只返回 IPv4 地址数组', () => {
    const lookup = pinnedLookupFactory(['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946']);
    const cb = vi.fn();
    lookup('api.example.com', { all: true, family: 4 }, cb);
    const list = cb.mock.calls[0][1] as Array<{ address: string; family: number }>;
    expect(list.map((x) => x.address)).toEqual(['93.184.216.34']);
    expect(list.map((x) => x.family)).toEqual([4]);
  });

  it('指定 family=6 且仅有 IPv4 → fail-closed，不回退其它地址族', () => {
    const lookup = pinnedLookupFactory(['93.184.216.34']);
    const cb = vi.fn();
    lookup('api.example.com', { family: 6 }, cb);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    expect((cb.mock.calls[0][0] as NodeJS.ErrnoException).code).toBe('EAI_AGAIN');
    expect(cb.mock.calls[0][1]).toBe('');
  });

  it('指定 family=4 且仅有 IPv6 → all=true fail-closed（空数组）', () => {
    const lookup = pinnedLookupFactory(['2606:2800:220:1:248:1893:25c8:1946']);
    const cb = vi.fn();
    lookup('api.example.com', { all: true, family: 4 }, cb);
    expect(cb.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(cb.mock.calls[0][1]).toEqual([]);
  });
});

describe('plan-executor：DNS 解析受 timeout / budget 控制', () => {
  const neverDns = () => new Promise<string[]>(() => {});

  it('resolveHostWithTimeout：deadline 到期返回 aborted，迟到结果被忽略', async () => {
    const started = Date.now();
    const outcome = await resolveHostWithTimeout(
      (hostname) => new Promise<string[]>((resolve) => setTimeout(() => resolve(['1.2.3.4']), 60)),
      'api.example.com',
      { deadlineMs: started + 20 },
    );
    expect(outcome.kind).toBe('aborted');
    // 迟到结果不会改变已结算的 aborted。
    await new Promise((r) => setTimeout(r, 80));
    expect(outcome.kind).toBe('aborted');
  });

  it('resolveHostWithTimeout：deadline 已过期立即 aborted，不等待', async () => {
    const outcome = await resolveHostWithTimeout(neverDns, 'api.example.com', { deadlineMs: Date.now() - 1 });
    expect(outcome.kind).toBe('aborted');
  });

  it('永不 resolve 的 DNS + httpTimeoutMs=20 → ERROR/TIMEOUT，transport 调用 0 次', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn();

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: ALLOWED,
      resolveHost: neverDns,
      transport,
      httpTimeoutMs: 20,
    });
    expect(result.caseResults[0].status).toBe('ERROR');
    expect(result.caseResults[0].http?.statusText).toBe('TIMEOUT');
    expect(transport).not.toHaveBeenCalled();
  });

  it('永不 resolve 的 DNS + budget_duration=20 → BLOCKED_BY_BUDGET，transport 调用 0 次', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    const transport = vi.fn();

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: ALLOWED,
      resolveHost: neverDns,
      transport,
      budgetDurationMs: 20,
    });
    expect(result.caseResults[0].status).toBe('BLOCKED_BY_BUDGET');
    expect(transport).not.toHaveBeenCalled();
  });

  it('DNS 超时后迟到返回公网地址：transport 调用次数仍为 0', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    let lateResolve!: () => void;
    const lateDns = () => new Promise<string[]>((resolve) => { lateResolve = () => resolve(['93.184.216.34']); });
    const transport = vi.fn();

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: ALLOWED,
      resolveHost: lateDns,
      transport,
      httpTimeoutMs: 20,
    });
    expect(result.caseResults[0].status).toBe('ERROR');
    lateResolve();
    await new Promise((r) => setTimeout(r, 40));
    expect(transport).not.toHaveBeenCalled();
  });

  it('DNS 超时后迟到返回私网地址：transport 调用次数仍为 0', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    let lateResolve!: () => void;
    const lateDns = () => new Promise<string[]>((resolve) => { lateResolve = () => resolve(['10.0.0.1']); });
    const transport = vi.fn();

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: ALLOWED,
      resolveHost: lateDns,
      transport,
      httpTimeoutMs: 20,
    });
    expect(result.caseResults[0].status).toBe('ERROR');
    lateResolve();
    await new Promise((r) => setTimeout(r, 40));
    expect(transport).not.toHaveBeenCalled();
  });
});

describe('plan-executor：无限重定向封顶', () => {
  it('无限 302 循环在 maxRedirects 后 BLOCKED，每跳 drain 且不超限请求', async () => {
    const v = validatePlan(validPlanInput());
    if (!v.ok) throw new Error('plan 应合法');
    let drains = 0;
    const transport = vi.fn<PinnedHttpTransport>(async () => ({
      status: 302,
      statusText: 'Found',
      headers: { location: '/loop' },
      readText: async () => ({ ok: true as const, text: '' }),
      drain: async () => { drains += 1; },
    }));

    const result = await executePlan(v.normalized, {
      allowedTargetOrigins: ALLOWED,
      resolveHost: PUBLIC_DNS,
      transport,
      maxRedirects: 3,
    });
    // hop=0..3 共 4 次请求，然后 BLOCKED。
    expect(transport).toHaveBeenCalledTimes(4);
    expect(drains).toBe(4);
    expect(result.caseResults[0].status).toBe('BLOCKED');
    expect(result.caseResults[0].reason).toContain('重定向次数超过上限');
  });
});