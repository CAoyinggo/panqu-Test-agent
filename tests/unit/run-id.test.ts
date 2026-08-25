// 验收测试：Task ID / Run ID 修复（并发、存储稳定性）
// 旧问题：taskId = 需求文本前 20 字符 → 同需求并发运行同 ID →
//   任务记录互相覆盖（output/tasks/<taskId>.json 单文件）、Trace 混流、Memory 历史污染。
// 新契约：
//   runId = ULID（每次运行唯一，文件名/Trace 键）
//   taskId = 需求哈希派生（同需求跨运行稳定，聚合/检索）
//   requirementsHash = SHA-256（归一化）；createdAt = ISO
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  generateRunId,
  isUlid,
  hashRequirement,
  deriveTaskId,
  createRunIdentity,
} from '../../src/utils/run-id.js';
import { saveTaskRecord, loadTaskRecord, listTaskRecords } from '../../src/qa/workflows.js';
import { runAgentPipeline } from '../../src/agents/orchestration/agent-pipeline.js';
import { createAgentContext, NoopMemory, ToolRegistry, computeOutcome } from '../../src/agents/index.js';
import { MockLLMProvider } from '../../src/llm/index.js';

const DEMO = '测试文生视频功能，支持 720P、1080P 分辨率，确认任务提交成功。';

describe('runId：ULID 生成', () => {
  it('26 字符 Crockford Base32（时间有序 + 随机尾缀）', () => {
    const id = generateRunId();
    expect(isUlid(id)).toBe(true);
    expect(id).toHaveLength(26);
    expect(id).not.toMatch(/[ILOU]/); // 防误读字母表
  });

  it('同毫秒大量生成互不冲突（并发安全）', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 5_000; i++) ids.add(generateRunId(Date.now()));
    expect(ids.size).toBe(5_000);
  });

  it('时间有序：后生成的字典序更大（目录扫描即创建序）', () => {
    const a = generateRunId(Date.now() - 1_000);
    const b = generateRunId(Date.now());
    expect(b.localeCompare(a)).toBeGreaterThan(0);
  });
});

describe('taskId / requirementsHash：稳定任务标识', () => {
  it('同一需求 → 同一 hash 与 taskId；空白归一化不产生新任务', () => {
    const a = createRunIdentity(DEMO);
    const b = createRunIdentity(`\n${DEMO}  \r\n`); // 行尾/首尾空白差异
    expect(b.requirementsHash).toBe(a.requirementsHash);
    expect(b.taskId).toBe(a.taskId);
    expect(a.taskId).toMatch(/^task-[0-9a-f]{12}$/);
  });

  it('需求内容变化 → 新 hash / 新 taskId；runId 每次都不同', () => {
    const a = createRunIdentity(DEMO, Date.now() - 1);
    const b = createRunIdentity(`${DEMO} 支持时长 5 秒。`, Date.now());
    expect(b.requirementsHash).not.toBe(a.requirementsHash);
    expect(b.taskId).not.toBe(a.taskId);
    expect(b.runId).not.toBe(a.runId);
    expect(a.createdAt).not.toBe(b.createdAt);
  });

  it('hashRequirement / deriveTaskId 独立可用', () => {
    const h = hashRequirement('x');
    expect(h).toHaveLength(64); // sha256 hex
    expect(deriveTaskId(h)).toBe(`task-${h.slice(0, 12)}`);
  });
});

describe('任务记录存储：runId 文件名（同需求并发不覆盖）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-id-tasks-'));

  function recordFor(identity: { runId: string; taskId: string; requirementsHash: string; createdAt: string }, label: string) {
    return {
      ...identity,
      feature: 'wan3',
      requirement: DEMO,
      environment: 'test',
      testCases: [],
      outcome: computeOutcome('wan3', [{ caseId: 'tc-1', name: label, pass: true, passRate: 100 }]),
      failedCases: [],
      updatedAt: new Date().toISOString(),
    };
  }

  it('同一需求并发两次运行 → 两个独立记录文件（互不覆盖），taskId 相同便于聚合', () => {
    const runA = createRunIdentity(DEMO);
    const runB = createRunIdentity(DEMO);
    expect(runA.taskId).toBe(runB.taskId); // 同一任务
    expect(runA.runId).not.toBe(runB.runId); // 不同运行

    const f1 = saveTaskRecord(recordFor(runA, 'run-a'), dir);
    const f2 = saveTaskRecord(recordFor(runB, 'run-b'), dir);
    expect(f1).not.toBe(f2); // 不同文件（旧实现：同文件互相覆盖）
    expect(fs.existsSync(f1)).toBe(true);
    expect(fs.existsSync(f2)).toBe(true);

    // 各自可独立加载（按 runId）
    const a = loadTaskRecord(runA.runId, dir)!;
    const b = loadTaskRecord(runB.runId, dir)!;
    expect(a.outcome.results[0].name).toBe('run-a');
    expect(b.outcome.results[0].name).toBe('run-b');
    expect(a.taskId).toBe(b.taskId);
  });

  it('listTaskRecords：runId 时间序倒排（最新在前），供 --resume 选择', () => {
    const old = createRunIdentity(DEMO, Date.now() - 5_000);
    const recent = createRunIdentity(DEMO, Date.now());
    saveTaskRecord(recordFor(old, 'old'), dir);
    saveTaskRecord(recordFor(recent, 'recent'), dir);
    const list = listTaskRecords(dir);
    expect(list.length).toBeGreaterThanOrEqual(4);
    // 倒序：最近的 run 在最前
    const ids = list.map((r) => r.runId);
    const recentIdx = ids.indexOf(recent.runId);
    const oldIdx = ids.indexOf(old.runId);
    expect(recentIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(recentIdx);
  });

  it('兼容旧记录：无 runId 时按 taskId 命名读写', () => {
    const legacy = recordFor({ runId: '', taskId: 'task-legacy00000', requirementsHash: '', createdAt: '' } as never, 'legacy');
    delete (legacy as Record<string, unknown>).runId;
    const f = saveTaskRecord(legacy, dir);
    expect(path.basename(f)).toBe('task-legacy00000.json');
    expect(loadTaskRecord('task-legacy00000', dir)?.outcome.results[0].name).toBe('legacy');
  });
});

describe('runAgentPipeline：标识三件套贯穿', () => {
  function makeContext() {
    const tools = new ToolRegistry();
    return createAgentContext({
      taskId: 'ctx-1', feature: 'wan3', environment: 'test',
      tools, memory: new NoopMemory(), llm: new MockLLMProvider(),
      metadata: { executionApproval: { id: 'a', status: 'APPROVED', approvedBy: 't' } },
    });
  }

  it('同一需求两次运行：taskId 相同、runId/createdAt 不同，trace 以 runId 键控（不混流）', async () => {
    const r1 = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, makeContext());
    const r2 = await runAgentPipeline({ requirementText: DEMO, environment: 'test' }, makeContext());

    // 不再是需求前 20 字符
    expect(r1.taskId).not.toBe(DEMO.slice(0, 20));
    expect(r1.taskId).toMatch(/^task-[0-9a-f]{12}$/);
    // 稳定任务标识 + 唯一运行标识
    expect(r2.taskId).toBe(r1.taskId);
    expect(r2.requirementsHash).toBe(r1.requirementsHash);
    expect(r2.runId).not.toBe(r1.runId);
    expect(isUlid(r1.runId)).toBe(true);
    expect(isUlid(r2.runId)).toBe(true);
    expect(Number.isNaN(Date.parse(r1.createdAt))).toBe(false);
    // Trace 以 runId 键控：两次运行的 trace 不再混为同一 ID
    expect(r1.trace?.taskId).toBe(r1.runId);
    expect(r2.trace?.taskId).toBe(r2.runId);
  });
});
