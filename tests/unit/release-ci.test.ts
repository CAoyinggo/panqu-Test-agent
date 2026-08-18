// Phase 23.4：Autonomous Release → CI/CD 单元测试
// 覆盖：统一 Release Contract、CI Exit Code（0/1/2/3）、REVIEW 绝不返回 0、
// Scenario 5（REVIEW → exitCode=2）、Scenario 6（BLOCK → exitCode=1）、
// PASS → exitCode=0、SYSTEM_ERROR → exitCode=3、JSON 输出 output/<date>/<feature>/release-decision.json、
// 按 runId 加载、契约字段完整、checks 明细。

import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildReleaseDecision,
  releaseExitCode,
  writeReleaseDecision,
  loadReleaseDecision,
  type ReleaseDecisionInput,
} from '../../src/release-ci/index.js';

const BASE: ReleaseDecisionInput = {
  p0: { passed: 3, total: 3 },
  p1: { passed: 99, total: 100 },
  coverage: 0.95,
  criticalDefects: 0,
  riskLevel: 'LOW',
  failurePrediction: 0.2,
  historicalFailureRate: 0.1,
  modelChange: false,
  environmentAbnormal: false,
  flakyCount: 0,
  knownIssues: 0,
};

describe('CI Exit Code（任务书九 / 23.4）', () => {
  it('统一规范：0=PASS、1=BLOCK、2=REVIEW、3=SYSTEM_ERROR', () => {
    expect(releaseExitCode('PASS')).toBe(0);
    expect(releaseExitCode('BLOCK')).toBe(1);
    expect(releaseExitCode('REVIEW')).toBe(2);
    expect(releaseExitCode('SYSTEM_ERROR')).toBe(3);
  });

  it('REVIEW 绝不返回 0（关键约束）', () => {
    expect(releaseExitCode('REVIEW')).not.toBe(0);
    expect(releaseExitCode('REVIEW')).toBe(2);
  });
});

describe('Release Contract（任务书八 / 23.4）', () => {
  it('契约字段完整：releaseId/runId/decision/confidence/checks/evidence/blockReasons/recommendations/traceId/createdAt', () => {
    const d = buildReleaseDecision({ runId: 'run-001', feature: 'wan3', decisionInput: BASE });
    expect(d.releaseId).toBe('release-run-001');
    expect(d.runId).toBe('run-001');
    expect(d.feature).toBe('wan3');
    expect(d.decision).toBe('PASS');
    expect(d.confidence).toBe(0.85);
    expect(d.checks.length).toBeGreaterThan(0);
    expect(d.evidence.length).toBeGreaterThan(0);
    expect(d.recommendations).toContain('允许发布');
    expect(d.traceId).toContain('run-001');
    expect(d.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('checks 明细：P0 fail → status=fail', () => {
    const d = buildReleaseDecision({
      runId: 'run-002',
      decisionInput: { ...BASE, p0: { passed: 2, total: 3 } },
    });
    const p0 = d.checks.find((c) => c.name === 'P0');
    expect(p0?.status).toBe('fail');
    expect(p0?.value).toBe('2/3 passed');
  });
});

describe('Release 验收场景（任务书十五 / 23.4）', () => {
  it('Scenario 5：P0 PASS、P1 99%、Coverage 93%、Flaky 2、Known Issue 1 → REVIEW，exitCode=2', () => {
    const input: ReleaseDecisionInput = {
      ...BASE,
      p1: { passed: 99, total: 100 },
      coverage: 0.93,
      flakyCount: 2,
      knownIssues: 1,
    };
    const d = buildReleaseDecision({ runId: 'run-scenario5', decisionInput: input });
    expect(d.decision).toBe('REVIEW');
    expect(releaseExitCode(d.decision)).toBe(2);
    // 软信号失败被记录为 blockReasons
    expect(d.blockReasons.some((r) => r.includes('不稳定用例'))).toBe(true);
    expect(d.blockReasons.some((r) => r.includes('已知问题'))).toBe(true);
  });

  it('Scenario 6：P0 Fail = 1 → BLOCK，exitCode=1', () => {
    const input: ReleaseDecisionInput = {
      ...BASE,
      p0: { passed: 2, total: 3 },
    };
    const d = buildReleaseDecision({ runId: 'run-scenario6', decisionInput: input });
    expect(d.decision).toBe('BLOCK');
    expect(releaseExitCode(d.decision)).toBe(1);
    expect(d.blockReasons.some((r) => r.includes('P0'))).toBe(true);
  });

  it('PASS 场景：全部门禁与风险信号达标 → PASS，exitCode=0', () => {
    const d = buildReleaseDecision({ runId: 'run-pass', decisionInput: BASE });
    expect(d.decision).toBe('PASS');
    expect(releaseExitCode(d.decision)).toBe(0);
    expect(d.blockReasons.every((r) => !r.includes('未满足'))).toBe(true);
  });

  it('SYSTEM_ERROR → exitCode=3（CI 系统故障不伪装成 PASS/BLOCK/REVIEW）', () => {
    const d = buildReleaseDecision({
      runId: 'run-syserr',
      decisionInput: BASE,
      systemError: '无法加载 run 的决策文件',
    });
    expect(d.decision).toBe('SYSTEM_ERROR');
    expect(releaseExitCode(d.decision)).toBe(3);
    expect(d.blockReasons).toContain('无法加载 run 的决策文件');
  });
});

describe('Release JSON 输出（任务书八 / 23.4）', () => {
  it('写入 output/<date>/<feature>/release-decision.json 并可按 runId 加载', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-ci-'));
    try {
      const d = buildReleaseDecision({ runId: 'run-json1', feature: 'wan3', decisionInput: BASE });
      const file = writeReleaseDecision(d, { baseDir: dir });
      const date = d.createdAt.slice(0, 10);
      expect(file).toBe(join(dir, date, 'wan3', 'release-decision.json'));

      const loaded = loadReleaseDecision('run-json1', { baseDir: dir });
      expect(loaded).not.toBeNull();
      expect(loaded?.runId).toBe('run-json1');
      expect(loaded?.decision).toBe('PASS');
      expect(loaded?.feature).toBe('wan3');
      expect(loaded?.releaseId).toBe('release-run-json1');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loadReleaseDecision：不存在的 runId → null（CLI 将走 SYSTEM_ERROR）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-ci-'));
    try {
      const loaded = loadReleaseDecision('run-ghost', { baseDir: dir });
      expect(loaded).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('确定性：相同输入产生相同 Contract（createdAt 除外）', () => {
    const a = buildReleaseDecision({ runId: 'run-det', decisionInput: BASE });
    const b = buildReleaseDecision({ runId: 'run-det', decisionInput: BASE });
    expect(a.decision).toBe(b.decision);
    expect(a.checks).toEqual(b.checks);
    expect(a.evidence).toEqual(b.evidence);
    expect(a.blockReasons).toEqual(b.blockReasons);
    expect(a.recommendations).toEqual(b.recommendations);
  });
});
