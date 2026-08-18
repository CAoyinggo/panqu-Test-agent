// 单元测试：Real Telemetry（Phase 25.4）
// 覆盖：CostLedger 真实记账（token × 单价）/ RCA Accuracy（Ground Truth）/
//       Flaky Rate（真实运行波动）/ Healing 指标（含 rolledBack）/ 时间窗口过滤 /
//       LLM 装饰器（透明透传 + runContext 归属）/ Release 记录 / 无数据 tracked=false。

import { describe, it, expect } from 'vitest';
import { TelemetryService } from '../../src/platform/telemetry/index.js';
import { TelemetryRunContext, TelemetryLLMProvider, withLLMTelemetry } from '../../src/platform/telemetry/index.js';
import { MockLLMProvider } from '../../src/llm/mock-llm.js';
import { periodStartMs } from '../../src/platform/telemetry/index.js';

/** 固定时钟：T0 为 7 天窗口内，T_OLD 为 8 天前（超窗） */
const NOW = '2026-08-18T12:00:00.000Z';
const NOW_MS = Date.parse(NOW);
const T0 = '2026-08-18T10:00:00.000Z';
const T_OLD = '2026-08-10T10:00:00.000Z'; // 距 NOW 8 天，超 7d 窗口

function makeService() {
  const telemetry = new TelemetryService({ now: () => NOW });
  return telemetry;
}

describe('CostLedger 真实记账', () => {
  it('recordLLM 按 token × 单价计算成本（deepseek-chat：1.0/2.0 元每百万 token）', async () => {
    const t = makeService();
    const entry = await t.recordLLM({
      runId: 'r1', projectId: 'wan3', feature: 'text-to-video',
      model: 'deepseek-chat', inputTokens: 1_000_000, outputTokens: 500_000, latencyMs: 300,
    });
    // input: 1e6/1e6 * 1.0 = 1.0；output: 5e5/1e6 * 2.0 = 1.0；合计 2.0 元
    expect(entry.cost).toBeCloseTo(2.0, 4);
    expect(entry.totalTokens).toBe(1_500_000);
    expect(entry.model).toBe('deepseek-chat');
    // 事件流：cost + llm 两条
    const events = await t.eventsByRun('r1');
    expect(events.filter((e) => e.type === 'cost')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'llm')).toHaveLength(1);
  });

  it('未知模型回退默认单价；costMetrics 汇总 total/perRun/perModel', async () => {
    const t = makeService();
    await t.recordLLM({ runId: 'r1', model: 'mock', inputTokens: 500_000, outputTokens: 500_000, latencyMs: 10 }); // 0.5+1.0=1.5
    await t.recordLLM({ runId: 'r1', model: 'mock', inputTokens: 0, outputTokens: 500_000, latencyMs: 10 });   // 0+1.0=1.0
    await t.recordLLM({ runId: 'r2', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 20 }); // 2.0
    const m = await t.costMetrics('7d');
    expect(m.total.tracked).toBe(true);
    expect(m.total.value).toBeCloseTo(4.5, 2);
    expect(m.perRun.value).toBeCloseTo(2.25, 2); // 4.5 / 2 runs
    expect(m.perRun.sampleCount).toBe(2);
    const mock = m.perModel.find((x) => x.model === 'mock');
    expect(mock?.cost).toBeCloseTo(2.5, 2);
    expect(mock?.tokens).toBe(1_500_000);
    expect(mock?.requests).toBe(2);
  });

  it('无成本数据时 tracked=false（禁止用 0 表示无数据）', async () => {
    const t = makeService();
    const m = await t.costMetrics('7d');
    expect(m.total.tracked).toBe(false);
    expect(m.total.value).toBeNull();
    expect(m.total.sampleCount).toBe(0);
  });

  it('costForFeature 回归成本：仅统计指定 feature', async () => {
    const t = makeService();
    await t.recordLLM({ runId: 'r1', feature: 'text-to-video', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    await t.recordLLM({ runId: 'r2', feature: 'video-editor', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    const c = await t.costForFeature('text-to-video');
    expect(c.value).toBeCloseTo(2.0, 2);
    expect(c.sampleCount).toBe(1);
  });
});

describe('时间窗口过滤', () => {
  it('periodStartMs：1h/7d 起点正确；release/version 返回 0', () => {
    expect(periodStartMs('1h', NOW_MS)).toBe(NOW_MS - 3600_000);
    expect(periodStartMs('7d', NOW_MS)).toBe(NOW_MS - 7 * 86400_000);
    expect(periodStartMs('release', NOW_MS)).toBe(0);
    expect(periodStartMs('version', NOW_MS)).toBe(0);
  });

  it('costMetrics 窗口过滤：超窗记录不计入（release 不过滤）', async () => {
    const t = makeService();
    // 超窗记录：直接写入 ledger（recordLLM 用服务时钟，无 timestamp 覆盖）
    await t.costs.record({ runId: 'r-old', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10, requestCount: 1, retryCount: 0, cost: 2.0, timestamp: T_OLD });
    await t.recordLLM({ runId: 'r-new', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    const m7 = await t.costMetrics('7d');
    expect(m7.total.sampleCount).toBe(1);
    expect(m7.perRun.sampleCount).toBe(1);
    const mAll = await t.costMetrics('release');
    expect(mAll.total.sampleCount).toBe(2);
  });
});

describe('RCA Ground Truth', () => {
  it('verifyRca 记录真值：correct 判定 + rcaAccuracy 计算', async () => {
    const t = makeService();
    await t.verifyRca({ runId: 'r1', rcaId: 'rca-1', predictedCategory: 'ASSERTION', actualCategory: 'ASSERTION' });
    await t.verifyRca({ runId: 'r1', rcaId: 'rca-2', predictedCategory: 'ASSERTION', actualCategory: 'TIMEOUT' });
    const a = await t.rcaAccuracy('7d');
    expect(a.tracked).toBe(true);
    expect(a.value).toBe(50); // 1/2 正确
    expect(a.sampleCount).toBe(2);
  });

  it('无真实验证时 rcaAccuracy tracked=false', async () => {
    const t = makeService();
    const a = await t.rcaAccuracy('7d');
    expect(a.tracked).toBe(false);
    expect(a.value).toBeNull();
  });
});

describe('Flaky Rate（真实运行波动）', () => {
  it('同一 case 既有 pass 又有 fail 记为 flaky', async () => {
    const t = makeService();
    // case A：波动（flaky）
    await t.recordFlaky({ caseId: 'c-a', runId: 'r1', pass: true, retry: false, environment: 'test', durationMs: 100 });
    await t.recordFlaky({ caseId: 'c-a', runId: 'r1', pass: false, retry: true, environment: 'test', durationMs: 90 });
    // case B：全 pass（不 flaky）
    await t.recordFlaky({ caseId: 'c-b', runId: 'r1', pass: true, retry: false, environment: 'test', durationMs: 100 });
    const f = await t.flakyRate('7d');
    expect(f.tracked).toBe(true);
    expect(f.value).toBe(50); // 1/2 case 波动
    expect(f.sampleCount).toBe(2);
  });

  it('无运行记录时 flakyRate tracked=false', async () => {
    const t = makeService();
    const f = await t.flakyRate('7d');
    expect(f.tracked).toBe(false);
    expect(f.value).toBeNull();
  });
});

describe('Healing 指标（含 rolledBack）', () => {
  it('successRate / falseHealingRate / recoveryRate 从真实决策计算', async () => {
    const t = makeService();
    await t.recordHealing({ healingId: 'h1', caseId: 'c1', runId: 'r1', suggested: true, approved: true, applied: true, recovered: true, rolledBack: false });
    await t.recordHealing({ healingId: 'h2', caseId: 'c2', runId: 'r1', suggested: true, approved: true, applied: true, recovered: false, rolledBack: true });
    await t.recordHealing({ healingId: 'h3', caseId: 'c3', runId: 'r1', suggested: true, approved: false, applied: false, recovered: false, rolledBack: false });
    const h = await t.healingMetrics('7d');
    expect(h.successRate.value).toBe(50);        // recovered 1 / applied 2
    expect(h.falseHealingRate.value).toBe(50);   // rolledBack 1 / applied 2
    expect(h.recoveryRate.value).toBeCloseTo(33.3, 1); // recovered 1 / suggested 3
  });

  it('无 applied 修复时 successRate tracked=false', async () => {
    const t = makeService();
    const h = await t.healingMetrics('7d');
    expect(h.successRate.tracked).toBe(false);
    expect(h.successRate.value).toBeNull();
    expect(h.recoveryRate.tracked).toBe(false);
  });
});

describe('Release 决策记录', () => {
  it('recordRelease 记录决策与结果，eventsByRun 可见', async () => {
    const t = makeService();
    const rel = await t.recordRelease({ runId: 'r1', decision: 'BLOCK', result: 'blocked', reason: '高风控用例失败' });
    expect(rel.decision).toBe('BLOCK');
    const events = await t.eventsByRun('r1');
    expect(events.some((e) => e.type === 'release' && e.value === 0)).toBe(true);
  });
});

describe('LLM 遥测装饰器', () => {
  it('透明透传：不改变 Provider 行为；真实 usage 记录到 CostLedger', async () => {
    const t = makeService();
    const inner = new MockLLMProvider({ defaultResponse: '{"ok":true}' });
    const ctx = new TelemetryRunContext();
    // 显式注入 ctx，演示依赖注入路径（默认装饰器使用全局 runContext）
    const wrapped = withLLMTelemetry(inner, t, ctx);
    const res = await ctx.run({ runId: 'r-llm', projectId: 'wan3', feature: 'text-to-video' }, () => wrapped.generate({ messages: [{ role: 'user', content: '你好世界' }] }));
    expect(res.content).toBe('{"ok":true}');
    expect(wrapped.name).toBe('telemetry:mock');
    // 成本账本按 run 归属
    const entries = await t.costs.list({ runId: 'r-llm' });
    expect(entries).toHaveLength(1);
    expect(entries[0].projectId).toBe('wan3');
    expect(entries[0].feature).toBe('text-to-video');
    // inputTokens = 消息 content 长度
    expect(entries[0].inputTokens).toBe('你好世界'.length);
  });

  it('无 runContext 时归属 unknown，遥测失败不影响 LLM 结果', async () => {
    const t = makeService();
    const inner = new MockLLMProvider({ defaultResponse: '{"ok":true}' });
    const wrapped = new TelemetryLLMProvider(inner, t);
    const res = await wrapped.generate({ messages: [{ role: 'user', content: 'x' }] });
    expect(res.content).toBe('{"ok":true}');
    const entries = await t.costs.list({ runId: 'unknown' });
    expect(entries).toHaveLength(1);
  });
});

describe('metricsSnapshot 汇总', () => {
  it('接入全部指标：cost / rca / flaky / healing', async () => {
    const t = makeService();
    await t.recordLLM({ runId: 'r1', model: 'deepseek-chat', inputTokens: 0, outputTokens: 1_000_000, latencyMs: 10 });
    await t.verifyRca({ runId: 'r1', rcaId: 'rca-1', predictedCategory: 'ASSERTION', actualCategory: 'ASSERTION' });
    await t.recordFlaky({ caseId: 'c-a', runId: 'r1', pass: true, retry: false });
    await t.recordFlaky({ caseId: 'c-a', runId: 'r1', pass: false, retry: true });
    await t.recordHealing({ healingId: 'h1', caseId: 'c1', runId: 'r1', suggested: true, approved: true, applied: true, recovered: true, rolledBack: false });
    const snap = await t.metricsSnapshot('7d');
    expect(snap.cost.total.tracked).toBe(true);
    expect(snap.rcaAccuracy.value).toBe(100);
    expect(snap.flakyRate.value).toBe(100);
    expect(snap.healing.successRate.value).toBe(100);
  });

  it('全空数据：所有指标 tracked=false（不虚构）', async () => {
    const t = makeService();
    const snap = await t.metricsSnapshot('7d');
    expect(snap.cost.total.tracked).toBe(false);
    expect(snap.rcaAccuracy.tracked).toBe(false);
    expect(snap.flakyRate.tracked).toBe(false);
    expect(snap.healing.successRate.tracked).toBe(false);
  });
});
