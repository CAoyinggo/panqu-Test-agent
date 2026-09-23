/**
 * Panqu AI DevTest — Requirement Trace & Impact Analysis 测试套件 (wardenIQ 原生吸收)
 *
 * 核心架构边界验证 (docs/ARCHITECTURE_FREEZE.md):
 * 1. 最小数据模型：requirementId -> testIds -> sourceRefs；
 * 2. 纯函数影响分析：changedPaths -> affectedTests、coverageGaps、riskInputs；
 * 3. 零基础设施依赖：绝对不接数据库、UI或任务管理系统；
 * 4. 覆盖缺口与风险输入精确输出，输出对象深层冻结。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  analyzeImpact,
  buildRequirementTraceIndex,
  collectGitChangedPaths,
  findAuthoritativeRequirementTraces,
  resolveWardenMaturity,
  analyzeGitImpact,
  type RequirementTrace,
} from '../../../src/devtest/requirement-trace.js';
import type { CanonicalTestSpec } from '../../../src/devtest/canonical-protocol.js';

describe('Requirement Trace & Impact Analysis 测试套件 (wardenIQ 原生吸收)', () => {
  const sampleTraces: RequirementTrace[] = [
    {
      requirementId: 'REQ-BILLING-001',
      description: '账单幂等退款与反重复计费审计',
      testIds: ['test-billing-idempotent-001', 'test-billing-anti-double-002'],
      sourceRefs: ['src/devtest/billing.ts'],
    },
    {
      requirementId: 'REQ-ROUTING-001',
      description: '渠道消歧与 NewAPI 网关分流决策',
      testIds: ['test-routing-disambiguation-001'],
      sourceRefs: ['src/devtest/routing.ts'],
    },
    {
      requirementId: 'REQ-ORPHAN-001',
      description: '有源码但暂未编写测试用例的需求',
      testIds: [], // 空测试列表，测试覆盖缺口
      sourceRefs: ['src/devtest/orphan-module.ts'],
    },
  ];

  const sampleSpecs: CanonicalTestSpec[] = [
    {
      testId: 'test-billing-idempotent-001',
      requirementId: 'REQ-BILLING-001',
      scenario: 'BILLING_IDEMPOTENT_CHECK',
      environment: 'offline',
      executionMode: 'FIXTURE',
      target: { targetType: 'scenario' },
      inputs: {},
      deterministicAssertions: [
        {
          field: 'refundCount',
          operator: 'EQUALS',
          expectedValue: 1,
          critical: true,
        },
      ],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['BILLING_LEDGER:TASK_RECORDS'],
    },
    {
      testId: 'test-billing-anti-double-002',
      requirementId: 'REQ-BILLING-001',
      scenario: 'BILLING_ONLINE_SUBMIT',
      environment: 'real',
      executionMode: 'REAL', // 触发 UNSAFE_EXECUTION_MODE 风险
      target: { targetType: 'scenario' },
      inputs: {},
      deterministicAssertions: [
        {
          field: 'chargeCount',
          operator: 'EQUALS',
          expectedValue: 1,
          critical: true,
        },
      ],
      costLimit: { maxCostPoints: 20 }, // 触发 POSITIVE_COST_LIMIT 风险
      sideEffectPolicy: 'ALLOW_PAID', // 触发 PAID_OR_SUBMIT_SIDE_EFFECT 风险
      requiredEvidence: ['BILLING_LEDGER:TASK_RECORDS'],
    },
    {
      testId: 'test-routing-disambiguation-001',
      requirementId: 'REQ-ROUTING-001',
      scenario: 'ROUTING_DISAMBIGUATION',
      environment: 'offline',
      executionMode: 'FIXTURE',
      target: { targetType: 'scenario' },
      inputs: {},
      deterministicAssertions: [
        // 缺少 critical 断言，触发 MISSING_CRITICAL_ASSERTIONS 风险
        {
          field: 'channelName',
          operator: 'EQUALS',
          expectedValue: 'default',
          critical: false,
        },
      ],
      costLimit: { maxCostPoints: 0 },
      sideEffectPolicy: 'READ_ONLY',
      requiredEvidence: ['SERVER_API:ROUTING_FACT'],
    },
  ];

  // --------------------------------------------------------------------------
  // 1. 基础模型与索引表构建
  // --------------------------------------------------------------------------
  it('1. buildRequirementTraceIndex 正确构建以 requirementId 为键的不可变索引', () => {
    const index = buildRequirementTraceIndex(sampleTraces);
    expect(index.size).toBe(3);
    expect(index.has('REQ-BILLING-001')).toBe(true);
    expect(index.get('REQ-BILLING-001')?.sourceRefs).toContain('src/devtest/billing.ts');
  });

  // --------------------------------------------------------------------------
  // 2. 影响分析：精确输出受影响测试用例与关联需求
  // --------------------------------------------------------------------------
  it('2. 当变更 billing.ts 时，analyzeImpact 纯函数精确输出受影响需求与用例', () => {
    const result = analyzeImpact({
      changedPaths: ['src/devtest/billing.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(result.changedPaths).toEqual(['src/devtest/billing.ts']);
    expect(result.affectedRequirements).toEqual(['REQ-BILLING-001']);
    expect(result.affectedTests).toEqual(['test-billing-anti-double-002', 'test-billing-idempotent-001']);
    expect(result.coverageGaps).toHaveLength(0);
  });

  // --------------------------------------------------------------------------
  // 3. 覆盖缺口检测：未关联 trace 的变更文件
  // --------------------------------------------------------------------------
  it('3. 当变更未受追踪的文件时，analyzeImpact 精确报告覆盖缺口 (coverageGaps)', () => {
    const result = analyzeImpact({
      changedPaths: ['src/devtest/new-untracked-feature.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(result.affectedTests).toHaveLength(0);
    expect(result.coverageGaps).toHaveLength(1);
    expect(result.coverageGaps[0].changedPath).toBe('src/devtest/new-untracked-feature.ts');
    expect(result.coverageGaps[0].reason).toContain('缺少测试覆盖');
  });

  // --------------------------------------------------------------------------
  // 4. 覆盖缺口检测：需求存在但 testIds 为空
  // --------------------------------------------------------------------------
  it('4. 当变更命中了没有测试用例的需求时，精确报告用例缺失缺口', () => {
    const result = analyzeImpact({
      changedPaths: ['src/devtest/orphan-module.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(result.affectedRequirements).toContain('REQ-ORPHAN-001');
    expect(result.affectedTests).toHaveLength(0);
    expect(result.coverageGaps).toHaveLength(1);
    expect(result.coverageGaps[0].requirementId).toBe('REQ-ORPHAN-001');
    expect(result.coverageGaps[0].reason).toContain('未关联任何测试用例');
  });

  // --------------------------------------------------------------------------
  // 5. 风险输入分析：四类核心风险精确识别
  // --------------------------------------------------------------------------
  it('5. analyzeImpact 纯函数精确识别受影响测试中的四类风险输入', () => {
    const result = analyzeImpact({
      changedPaths: ['src/devtest/billing.ts', 'src/devtest/routing.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(result.affectedTests).toHaveLength(3);

    const riskTypes = result.riskInputs.map((r) => r.riskType);
    expect(riskTypes).toContain('PAID_OR_SUBMIT_SIDE_EFFECT');
    expect(riskTypes).toContain('POSITIVE_COST_LIMIT');
    expect(riskTypes).toContain('MISSING_CRITICAL_ASSERTIONS');
    expect(riskTypes).toContain('UNSAFE_EXECUTION_MODE');

    // 验证特定用例的具体风险
    const billingAntiDoubleRisks = result.riskInputs.filter((r) => r.testId === 'test-billing-anti-double-002');
    expect(billingAntiDoubleRisks.some((r) => r.riskType === 'PAID_OR_SUBMIT_SIDE_EFFECT')).toBe(true);
    expect(billingAntiDoubleRisks.some((r) => r.riskType === 'POSITIVE_COST_LIMIT')).toBe(true);
    expect(billingAntiDoubleRisks.some((r) => r.riskType === 'UNSAFE_EXECUTION_MODE')).toBe(true);

    const routingRisks = result.riskInputs.filter((r) => r.testId === 'test-routing-disambiguation-001');
    expect(routingRisks.some((r) => r.riskType === 'MISSING_CRITICAL_ASSERTIONS')).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 6. 确定性与纯函数保障：无副作用且输出冻结
  // --------------------------------------------------------------------------
  it('6. 影响分析为严格只读纯函数，不依赖外部系统，结果对象深层冻结', () => {
    const result = analyzeImpact({
      changedPaths: ['./src/devtest/billing.ts'],
      traces: sampleTraces,
      testSpecs: sampleSpecs,
    });

    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.changedPaths)).toBe(true);
    expect(Object.isFrozen(result.affectedRequirements)).toBe(true);
    expect(Object.isFrozen(result.affectedTests)).toBe(true);
    expect(Object.isFrozen(result.coverageGaps)).toBe(true);
    expect(Object.isFrozen(result.riskInputs)).toBe(true);
  });

  // --------------------------------------------------------------------------
  // 7. 真实 Git 变更收集测试：未暂存、已暂存与未跟踪文件全覆盖
  // --------------------------------------------------------------------------
  it('7. collectGitChangedPaths 在真实临时 Git 仓库中精准收集未暂存、已暂存和未跟踪文件', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-git-test-'));
    try {
      // 1. 初始化 git 仓库与身份配置
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });

      // 2. 初始提交 tracked-clean.txt
      fs.writeFileSync(path.join(tempDir, 'tracked-clean.txt'), 'version 1', 'utf-8');
      execFileSync('git', ['add', 'tracked-clean.txt'], { cwd: tempDir });
      execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: tempDir });

      // 3. 产生三种真实变更：
      // (a) 未暂存修改 (unstaged)
      fs.writeFileSync(path.join(tempDir, 'tracked-clean.txt'), 'version 2 (unstaged)', 'utf-8');

      // (b) 已暂存新增文件 (staged)
      fs.writeFileSync(path.join(tempDir, 'staged-feature.ts'), 'export const a = 1;', 'utf-8');
      execFileSync('git', ['add', 'staged-feature.ts'], { cwd: tempDir });

      // (c) 未跟踪新文件 (untracked)
      fs.writeFileSync(path.join(tempDir, 'untracked-doc.md'), '# Untracked', 'utf-8');

      // 4. 调用只读收集器
      const res = await collectGitChangedPaths({ cwd: tempDir });

      expect(res.ok).toBe(true);
      expect(res.error).toBeUndefined();
      // 必须精确包含全部三种真实变更，去重并排序
      expect(res.changedPaths).toEqual(['staged-feature.ts', 'tracked-clean.txt', 'untracked-doc.md']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 8. 非 Git 目录 fail-closed 阻断测试
  // --------------------------------------------------------------------------
  it('8. collectGitChangedPaths 在非 Git 目录严格 fail-closed 阻断，不返回空成功', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-nongit-'));
    try {
      const res = await collectGitChangedPaths({ cwd: tempDir });

      expect(res.ok).toBe(false);
      expect(res.changedPaths).toHaveLength(0);
      expect(res.error).toContain('fail-closed');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 9. 真实 Git 变更与权威需求映射闭环测试 (IMPLEMENTED)
  // --------------------------------------------------------------------------
  it('9. analyzeGitImpact 基于真实 Git 变更与权威需求映射执行影响分析，标记 IMPLEMENTED 并输出 affectedTests', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-git-impact-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });

      // 产生真实变更
      fs.writeFileSync(path.join(tempDir, 'media-service.ts'), 'export const media = 1;', 'utf-8');
      execFileSync('git', ['add', 'media-service.ts'], { cwd: tempDir });

      // 放置权威需求映射文件
      const authoritativeTraces: RequirementTrace[] = [
        {
          requirementId: 'REQ-MEDIA-001',
          sourceRefs: ['media-service.ts'],
          testIds: ['test-media-spec-01', 'test-media-spec-02'],
          description: '权威媒体流处理需求',
        },
      ];
      fs.writeFileSync(
        path.join(tempDir, 'devtest-requirements.json'),
        JSON.stringify(authoritativeTraces, null, 2),
        'utf-8',
      );

      const result = await analyzeGitImpact({ cwd: tempDir });

      expect(result.status).toBe('COMPLETED');
      expect(result.maturity).toBe('IMPLEMENTED');
      expect(result.changedPaths).toContain('devtest-requirements.json');
      expect(result.changedPaths).toContain('media-service.ts');
      expect(result.impactResult?.affectedRequirements).toContain('REQ-MEDIA-001');
      expect(result.impactResult?.affectedTests).toEqual(['test-media-spec-01', 'test-media-spec-02']);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 10. 缺失权威需求映射时阻断测试 (BLOCKED_DATA_MISSING)
  // --------------------------------------------------------------------------
  it('10. 仓库未提供权威需求映射文件时，analyzeGitImpact 严格返回 BLOCKED_DATA_MISSING，禁止伪造映射', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-no-traces-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });

      fs.writeFileSync(path.join(tempDir, 'some-file.ts'), 'const a = 1;', 'utf-8');

      // 故意不创建 devtest-requirements.json
      const result = await analyzeGitImpact({ cwd: tempDir });

      expect(result.status).toBe('BLOCKED_DATA_MISSING');
      expect(result.maturity).toBe('BLOCKED_DATA_MISSING');
      expect(result.traces).toHaveLength(0);
      expect(result.error).toContain('BLOCKED_DATA_MISSING');
      expect(result.error).toContain('devtest-requirements.json');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 10. 缺失权威需求映射时阻断测试 (BLOCKED_DATA_MISSING)
  // --------------------------------------------------------------------------
  it('10. 仓库未提供权威需求映射文件时，analyzeGitImpact 严格返回 BLOCKED_DATA_MISSING，且不存在 impactResult', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-no-traces-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });

      fs.writeFileSync(path.join(tempDir, 'some-file.ts'), 'const a = 1;', 'utf-8');

      // 故意不创建 devtest-requirements.json
      const result = await analyzeGitImpact({ cwd: tempDir });

      expect(result.status).toBe('BLOCKED_DATA_MISSING');
      expect(result.maturity).toBe('BLOCKED_DATA_MISSING');
      expect(result.traces).toHaveLength(0);
      expect(result.impactResult).toBeUndefined(); // 核心断言：BLOCKED 状态下不存在 impactResult
      expect(result.error).toContain('BLOCKED_DATA_MISSING');
      expect(result.error).toContain('devtest-requirements.json');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 11. 权威需求映射文件为空数组 [] 时阻断测试 (BLOCKED_DATA_MISSING)
  // --------------------------------------------------------------------------
  it('11. 权威需求映射文件内容为 [] 时，严格返回 BLOCKED_DATA_MISSING，且不存在 impactResult', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-empty-array-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });

      fs.writeFileSync(path.join(tempDir, 'some-file.ts'), 'const a = 1;', 'utf-8');

      // 写入空数组 []
      fs.writeFileSync(path.join(tempDir, 'devtest-requirements.json'), '[]', 'utf-8');

      const tracesRes = findAuthoritativeRequirementTraces({ cwd: tempDir });
      expect(tracesRes.status).toBe('BLOCKED_DATA_MISSING');
      expect(tracesRes.traces).toHaveLength(0);
      expect(tracesRes.error).toContain('权威映射文件为空');

      const result = await analyzeGitImpact({ cwd: tempDir });
      expect(result.status).toBe('BLOCKED_DATA_MISSING');
      expect(result.maturity).toBe('BLOCKED_DATA_MISSING');
      expect(result.traces).toHaveLength(0);
      expect(result.impactResult).toBeUndefined(); // 核心断言：BLOCKED 状态下不存在 impactResult
      expect(result.error).toContain('权威映射文件为空');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 12. 空白文件或无效 JSON 时返回 INVALID_REQUIREMENT_TRACE
  // --------------------------------------------------------------------------
  it('12. 需求映射文件为空白文件或无效 JSON 时，返回 INVALID_REQUIREMENT_TRACE 阻断', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-invalid-json-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });

      fs.writeFileSync(path.join(tempDir, 'some-file.ts'), 'const a = 1;', 'utf-8');

      // (a) 空白文件
      fs.writeFileSync(path.join(tempDir, 'devtest-requirements.json'), '', 'utf-8');
      const blankRes = await analyzeGitImpact({ cwd: tempDir });
      expect(blankRes.status).toBe('INVALID_REQUIREMENT_TRACE');
      expect(blankRes.impactResult).toBeUndefined();
      expect(blankRes.error).toContain('解析失败');

      // (b) 非法格式 JSON
      fs.writeFileSync(path.join(tempDir, 'devtest-requirements.json'), '{ invalid json }', 'utf-8');
      const badJsonRes = await analyzeGitImpact({ cwd: tempDir });
      expect(badJsonRes.status).toBe('INVALID_REQUIREMENT_TRACE');
      expect(badJsonRes.impactResult).toBeUndefined();
      expect(badJsonRes.error).toContain('解析失败');

      // (c) 根节点不是数组
      fs.writeFileSync(path.join(tempDir, 'devtest-requirements.json'), '{"not": "an array"}', 'utf-8');
      const notArrRes = await analyzeGitImpact({ cwd: tempDir });
      expect(notArrRes.status).toBe('INVALID_REQUIREMENT_TRACE');
      expect(notArrRes.impactResult).toBeUndefined();
      expect(notArrRes.error).toContain('根节点必须为数组');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 13. 映射数组全部无效时返回 INVALID_REQUIREMENT_TRACE
  // --------------------------------------------------------------------------
  it('13. 映射数组全部无效时，严格返回 INVALID_REQUIREMENT_TRACE 阻断', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-invalid-items-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });

      fs.writeFileSync(path.join(tempDir, 'app.ts'), 'const x = 1;', 'utf-8');

      // 写入包含非法 requirementId (含空格、特殊标点) 的映射
      const invalidTraces = [
        {
          requirementId: 'INVALID REQ ID WITH SPACES',
          sourceRefs: ['app.ts'],
          testIds: ['test-01'],
        },
      ];
      fs.writeFileSync(
        path.join(tempDir, 'devtest-requirements.json'),
        JSON.stringify(invalidTraces, null, 2),
        'utf-8',
      );

      const result = await analyzeGitImpact({ cwd: tempDir });

      expect(result.status).toBe('INVALID_REQUIREMENT_TRACE');
      expect(result.traces).toHaveLength(0);
      expect(result.impactResult).toBeUndefined();
      expect(result.error).toContain('不是合法的 stable requirementId');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 14. 至少一条合法映射时允许 COMPLETED
  // --------------------------------------------------------------------------
  it('14. 至少一条合法映射时允许 COMPLETED，且 impactResult 存在', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devtest-valid-trace-'));
    try {
      execFileSync('git', ['init'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: tempDir });
      execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: tempDir });

      fs.writeFileSync(path.join(tempDir, 'valid.ts'), 'export const v = 1;', 'utf-8');

      const validTraces = [
        {
          requirementId: 'REQ-VALID-001',
          sourceRefs: ['valid.ts'],
          testIds: ['test-valid-spec-01'],
        },
      ];
      fs.writeFileSync(path.join(tempDir, 'devtest-requirements.json'), JSON.stringify(validTraces, null, 2), 'utf-8');

      const result = await analyzeGitImpact({ cwd: tempDir });

      expect(result.status).toBe('COMPLETED');
      expect(result.maturity).toBe('IMPLEMENTED');
      expect(result.impactResult).toBeDefined();
      expect(result.impactResult?.affectedTests).toContain('test-valid-spec-01');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // --------------------------------------------------------------------------
  // 15. 成熟度解析器严格测试
  // --------------------------------------------------------------------------
  it('15. resolveWardenMaturity 严格根据收集器与映射状态解析成熟度', () => {
    expect(resolveWardenMaturity({ gitCollectorAvailable: true, hasAuthoritativeMapping: true })).toBe('IMPLEMENTED');

    expect(resolveWardenMaturity({ gitCollectorAvailable: true, hasAuthoritativeMapping: false })).toBe(
      'BLOCKED_DATA_MISSING',
    );

    expect(resolveWardenMaturity({ gitCollectorAvailable: false, hasAuthoritativeMapping: false })).toBe(
      'CONTRACT_ONLY',
    );
  });
});
