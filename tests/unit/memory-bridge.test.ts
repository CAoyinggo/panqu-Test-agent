// 单元测试：Memory Bridge（写入记忆 / 历史风险 / 证据检索）
import { describe, it, expect } from 'vitest';
import {
  JsonMemoryStore,
  storeAnalysisToMemory,
  buildHistoricalRiskItems,
  getHistoricalEvidence,
  storeFailure,
  computeOutcome,
  analyzeExecution,
  parseRequirement,
  generateTestCases,
} from '../../src/agents/index.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEMO_REQ =
  '测试文生视频功能，支持 720P、1080P 分辨率，提示词长度 5 到 100 字，支持 5 秒和 10 秒视频，' +
  '验证模型服务与积分服务，确认任务提交成功、状态成功及积分正确扣除，并验证并发执行正常。';
const req = parseRequirement(DEMO_REQ);
const cases = generateTestCases(req);

function makeOutcome() {
  return computeOutcome('wan3', [
    { caseId: 'tc-01', name: '正常提交', pass: true, passRate: 100 },
    { caseId: 'tc-02', name: '计费规则', pass: false, passRate: 0, error: '积分扣减异常', tags: ['wan3', 'P0'], checks: [{ name: 'billing', pass: false, detail: 'expected 10 actual 5', level: 'P0' }] },
  ], { executed: true });
}

function tempMemory(): JsonMemoryStore {
  const file = path.join(os.tmpdir(), `agent-mem-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  return new JsonMemoryStore(file);
}

describe('memory-bridge - 写入记忆', () => {
  it('storeAnalysisToMemory 写入执行摘要与失败记录', async () => {
    const memory = tempMemory();
    const outcome = makeOutcome();
    const report = analyzeExecution({ requirement: req, testCases: cases, outcome });
    const stats = await storeAnalysisToMemory(memory, report, outcome);

    expect(stats.saved).toBe(1 + report.memoryWorthy.length); // 1 摘要 + N 失败
    expect(stats.types).toContain('execution');
    expect(stats.types).toContain('failure');

    const all = await memory.query({ limit: 50 });
    expect(all.filter((r) => r.type === 'execution')).toHaveLength(1);
    const failures = all.filter((r) => r.type === 'failure');
    expect(failures).toHaveLength(1);
    expect(failures[0].data?.caseId).toBe('tc-02');
    expect(failures[0].data?.evidence).toEqual(['billing: expected 10 actual 5']);
  });

  it('storeFailure 直接写入失败记录', async () => {
    const memory = tempMemory();
    await storeFailure(memory, { caseId: 'tc-99', category: 'timeout', message: '超时', tags: ['wan3'] });
    const records = await memory.query({ type: 'failure', tags: ['wan3'] });
    expect(records).toHaveLength(1);
    expect(records[0].data?.caseId).toBe('tc-99');
  });
});

describe('memory-bridge - 历史风险构建', () => {
  it('同一用例历史失败 ≥2 次 → flaky/已知问题风险', async () => {
    const memory = tempMemory();
    for (let i = 0; i < 3; i++) {
      await storeFailure(memory, { caseId: 'tc-05', category: 'assertion', message: `第 ${i} 次失败`, tags: ['wan3'] });
    }
    const items = await buildHistoricalRiskItems(memory, 'wan3');
    expect(items).toHaveLength(1);
    expect(items[0].level).toBe('high'); // ≥3 次
    expect(items[0].category).toBe('compatibility');
    expect(items[0].affectedCases).toEqual(['tc-05']);
  });

  it('单次失败不构成风险', async () => {
    const memory = tempMemory();
    await storeFailure(memory, { caseId: 'tc-06', category: 'error', message: '一次', tags: ['wan3'] });
    const items = await buildHistoricalRiskItems(memory, 'wan3');
    expect(items).toHaveLength(0);
  });

  it('无匹配 feature 记忆返回空', async () => {
    const memory = tempMemory();
    await storeFailure(memory, { caseId: 'tc-07', category: 'error', message: 'x', tags: ['other'] });
    const items = await buildHistoricalRiskItems(memory, 'wan3');
    expect(items).toHaveLength(0);
  });
});

describe('memory-bridge - 证据检索', () => {
  it('getHistoricalEvidence 返回指定用例历史失败信息', async () => {
    const memory = tempMemory();
    await storeFailure(memory, { caseId: 'tc-08', category: 'error', message: '网络中断', tags: ['wan3'] });
    await storeFailure(memory, { caseId: 'tc-09', category: 'error', message: '其他', tags: ['wan3'] });
    const evidence = await getHistoricalEvidence(memory, 'tc-08');
    expect(evidence).toEqual(['网络中断']);
  });

  it('无历史返回空数组', async () => {
    const memory = tempMemory();
    expect(await getHistoricalEvidence(memory, 'nope')).toEqual([]);
  });
});

describe('memory-bridge - 持久化', () => {
  it('JsonMemoryStore 文件持久化后可重新加载', async () => {
    const file = path.join(os.tmpdir(), `agent-mem-persist-${Date.now()}.json`);
    const m1 = new JsonMemoryStore(file);
    await storeFailure(m1, { caseId: 'tc-10', category: 'error', message: '持久化', tags: ['wan3'] });

    const m2 = new JsonMemoryStore(file);
    const records = await m2.query({ type: 'failure' });
    expect(records).toHaveLength(1);
    expect(records[0].data?.caseId).toBe('tc-10');
    fs.rmSync(file, { force: true });
  });
});
