/**
 * Panqu AI DevTest — Absorbed Capabilities Maturity Audit & Reality Verification Tests
 *
 * 验证目标:
 * 1. 纠正五项开源能力“已完成吸收”的失真表述，验证成熟度四级审计模型；
 * 2. 验证 ReportPortal 本地 NDJSON 单向导出（脱敏、确定性、可关闭、只写不读）；
 * 3. 验证 wardenIQ 真实变更路径影响分析与 UNRESOLVED 门禁；
 * 4. 验证 Promptfoo 真实样本导入契约与缺样本 BLOCKED_DATA_MISSING 门禁；
 * 5. 验证 Playwright / Midscene DEFERRED_EXTERNAL_RUNTIME 声明与无外部运行时阻断。
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ABSORBED_CAPABILITIES_AUDIT,
  getCapabilityAudit,
  CAPABILITY_MATURITY_LEVELS,
  type AbsorbedCapabilityAudit,
  type CapabilityMaturityLevel,
} from '../../../src/devtest/capability-maturity.js';
import {
  NdjsonResultSink,
  mapVerdictToExportRecord,
  type ExportableVerdictRecord,
} from '../../../src/devtest/result-sink.js';
import {
  analyzeImpact,
  resolveRequirementTraceForSpec,
  findAuthoritativeRequirementTraces,
  type RequirementTrace,
} from '../../../src/devtest/requirement-trace.js';
import {
  validateAgentSampleImport,
  evaluateAgentOutput,
  type AgentEvaluationInput,
} from '../../../src/devtest/agent-evaluation.js';
import {
  UIBrowserEvidenceProducer,
  UIVisualAiEvidenceProducer,
  type DeterministicProducerContext,
} from '../../../src/devtest/ui-adapters.js';
import type { CanonicalVerdictResult } from '../../../src/devtest/canonical-verdict-engine.js';
import type { CanonicalTestSpec } from '../../../src/devtest/canonical-protocol.js';

describe('Panqu AI DevTest — 五项能力真实成熟度与能力做实测试', () => {
  // ==========================================================================
  // 1. 五项开源能力成熟度审计表测试
  // ==========================================================================
  describe('1. 五项开源能力成熟度客观审计', () => {
    it('1.1 审计表完整包含五项能力，且成熟度定级客观无夸大', () => {
      // 断言成熟度枚举只有四种
      expect(CAPABILITY_MATURITY_LEVELS).toHaveLength(4);
      expect(CAPABILITY_MATURITY_LEVELS).toEqual([
        'IMPLEMENTED',
        'CONTRACT_ONLY',
        'BLOCKED_DATA_MISSING',
        'DEFERRED_EXTERNAL_RUNTIME',
      ]);

      expect(ABSORBED_CAPABILITIES_AUDIT).toHaveLength(5);

      const auditMap = new Map<string, AbsorbedCapabilityAudit>();
      for (const item of ABSORBED_CAPABILITIES_AUDIT) {
        auditMap.set(item.capabilityName, item);
        expect(CAPABILITY_MATURITY_LEVELS).toContain(item.maturity);
      }

      // Playwright: DEFERRED_EXTERNAL_RUNTIME + NOT_IN_ZERO_DEPENDENCY_SCOPE
      const pw = auditMap.get('Playwright');
      expect(pw).toBeDefined();
      expect(pw?.maturity).toBe('DEFERRED_EXTERNAL_RUNTIME');
      expect(pw?.scope).toBe('NOT_IN_ZERO_DEPENDENCY_SCOPE');
      expect(pw?.whatWeDoNotHave).toContain('不自制 CDP 框架');

      // Midscene: DEFERRED_EXTERNAL_RUNTIME + NOT_IN_ZERO_DEPENDENCY_SCOPE
      const midscene = auditMap.get('Midscene');
      expect(midscene).toBeDefined();
      expect(midscene?.maturity).toBe('DEFERRED_EXTERNAL_RUNTIME');
      expect(midscene?.scope).toBe('NOT_IN_ZERO_DEPENDENCY_SCOPE');
      expect(midscene?.whatWeDoNotHave).toContain('真实多模态视觉大模型');

      // Promptfoo: 核心纯函数就绪，但缺真实样本
      const promptfoo = auditMap.get('Promptfoo');
      expect(promptfoo).toBeDefined();
      expect(promptfoo?.maturity).toBe('BLOCKED_DATA_MISSING');
      expect(promptfoo?.scope).toBe('IN_ZERO_DEPENDENCY_SCOPE');
      expect(promptfoo?.whatWeDoNotHave).toContain('被测智能体真实回答样本库');

      // ReportPortal: 本地 NDJSON 导出已实现，远程对接未接入
      const reportportal = auditMap.get('ReportPortal');
      expect(reportportal).toBeDefined();
      expect(reportportal?.maturity).toBe('IMPLEMENTED');
      expect(reportportal?.scope).toBe('IN_ZERO_DEPENDENCY_SCOPE');
      expect(reportportal?.whatWeHave).toContain('本地 NDJSON');
      expect(reportportal?.whatWeDoNotHave).toContain('禁止回写');

      // wardenIQ: 真实 Git 变更收集器就绪，但缺仓库权威映射文件
      const warden = auditMap.get('wardenIQ');
      expect(warden).toBeDefined();
      expect(warden?.maturity).toBe('BLOCKED_DATA_MISSING');
      expect(warden?.scope).toBe('IN_ZERO_DEPENDENCY_SCOPE');
      expect(warden?.whatWeHave).toContain('真实 Git 变更收集器');
      expect(warden?.whatWeDoNotHave).toContain('devtest-requirements.json');
    });

    it('1.2 getCapabilityAudit 辅助函数正确检索，未知能力抛出异常', () => {
      const pw = getCapabilityAudit('Playwright');
      expect(pw.maturity).toBe('DEFERRED_EXTERNAL_RUNTIME');
      expect(pw.scope).toBe('NOT_IN_ZERO_DEPENDENCY_SCOPE');

      expect(() => getCapabilityAudit('UnknownTool' as any)).toThrow('未知能力: UnknownTool');
    });
  });

  // ==========================================================================
  // 2. ReportPortal 本地 NDJSON 单向导出反证测试
  // ==========================================================================
  describe('2. ReportPortal 本地 NDJSON 单向导出 (NdjsonResultSink)', () => {
    const mockVerdictResult: CanonicalVerdictResult = {
      verdict: 'PASS',
      testId: 'test-ndjson-export-001',
      reasons: ['全部必需证据通过'],
      warnings: [],
      blockers: [],
      assertionResults: [],
      evidenceIdsUsed: ['ev-001'],
      requiredEvidenceEvaluation: {
        satisfied: true,
        missingEvidenceKeys: [],
        failedEvidenceKeys: [],
        unverifiedEvidenceKeys: [],
        matchedEnvelopes: {},
        details: [],
      },
    };

    it('2.1 单向写入合法的单行 NDJSON，且输出严格脱敏', () => {
      const writtenLines: string[] = [];
      const sink = new NdjsonResultSink({
        enabled: true,
        redactSensitive: true,
        writeFn: (line) => writtenLines.push(line),
      });

      const record = mapVerdictToExportRecord(mockVerdictResult, {
        recordId: 'rec-001',
        exportedAt: '2026-09-22T10:00:00.000Z',
        extraAttributes: [
          { key: 'sessionToken', value: 'secret_token_12345' },
          { key: 'authToken', value: 'bearer_abcdef' },
          { key: 'env', value: 'preonline' },
        ],
      });

      sink.sink(record);

      expect(writtenLines).toHaveLength(1);
      const parsed = JSON.parse(writtenLines[0]);
      expect(parsed.recordId).toBe('rec-001');
      expect(parsed.testId).toBe('test-ndjson-export-001');
      expect(parsed.status).toBe('PASSED');

      // 验证脱敏：敏感 token 字段被 mask 为 ***REDACTED***
      const tokenAttr = parsed.attributes.find((a: any) => a.key === 'sessionToken');
      expect(tokenAttr.value).toBe('***REDACTED***');
      const authAttr = parsed.attributes.find((a: any) => a.key === 'authToken');
      expect(authAttr.value).toBe('***REDACTED***');
      const envAttr = parsed.attributes.find((a: any) => a.key === 'env');
      expect(envAttr.value).toBe('preonline');
    });

    it('2.2 当 enabled=false 时可关闭，不输出任何内容', () => {
      const writtenLines: string[] = [];
      const disabledSink = new NdjsonResultSink({
        enabled: false,
        writeFn: (line) => writtenLines.push(line),
      });

      const record = mapVerdictToExportRecord(mockVerdictResult);
      disabledSink.sink(record);

      expect(writtenLines).toHaveLength(0);
    });

    it('2.3 严格只写不读，绝无向 core-kernel 或裁决引擎回写的能力', () => {
      const sink = new NdjsonResultSink();
      expect(typeof sink.sink).toBe('function');
      // 验证没有读方法或修改源对象的能力
      expect((sink as any).read).toBeUndefined();
      expect((sink as any).query).toBeUndefined();
      expect((sink as any).update).toBeUndefined();
      expect((sink as any).rollback).toBeUndefined();
    });
  });

  // ==========================================================================
  // 3. wardenIQ 真实变更路径影响分析与 UNRESOLVED 反证测试
  // ==========================================================================
  describe('3. wardenIQ 真实变更路径影响分析与门禁 (analyzeImpact & resolveRequirementTraceForSpec)', () => {
    const traces: RequirementTrace[] = [
      {
        requirementId: 'REQ-MEDIA-SUBMIT',
        testIds: ['test-video-submit-01', 'test-video-submit-02'],
        sourceRefs: ['src/devtest/media-flow.ts', 'src/devtest/execution-ports.ts'],
        description: '视频任务真实提交与适配器调度',
      },
      {
        requirementId: 'REQ-BILLING-AUDIT',
        testIds: ['test-billing-calc-01'],
        sourceRefs: ['src/devtest/billing.ts'],
        description: '账务流水核算与退款归零',
      },
    ];

    it('3.1 真实变更文件精准匹配需求与受影响测试用例', () => {
      const result = analyzeImpact({
        changedPaths: ['src/devtest/media-flow.ts'],
        traces,
      });

      expect(result.affectedRequirements).toEqual(['REQ-MEDIA-SUBMIT']);
      expect(result.affectedTests).toEqual(['test-video-submit-01', 'test-video-submit-02']);
      expect(result.coverageGaps).toHaveLength(0);
    });

    it('3.2 变更未关联需求的文件时，精准输出 coverageGaps 并拒绝伪造覆盖', () => {
      const result = analyzeImpact({
        changedPaths: ['src/devtest/untracked-experimental-feature.ts'],
        traces,
      });

      expect(result.affectedRequirements).toHaveLength(0);
      expect(result.affectedTests).toHaveLength(0);
      expect(result.coverageGaps).toHaveLength(1);
      expect(result.coverageGaps[0].changedPath).toBe('src/devtest/untracked-experimental-feature.ts');
      expect(result.coverageGaps[0].reason).toContain('未关联任何需求追踪');
    });

    it('3.3 缺少 stable requirementId 时，严格标记 UNRESOLVED_REQUIREMENT，拒绝虚构影响分析', () => {
      const resolved = resolveRequirementTraceForSpec({
        requirementText: '一个模糊的自然语言需求描述，但没有稳定REQ编号',
        changedPaths: ['src/devtest/media-flow.ts'],
        traces,
      });

      expect(resolved.requirementId).toBe('UNRESOLVED_REQUIREMENT');
      expect(resolved.impactAnalysis.executed).toBe(false);
      if ('reason' in resolved.impactAnalysis) {
        expect(resolved.impactAnalysis.reason).toContain('未关联有效 stable requirementId，拒绝虚构影响分析');
      }
    });
  });

  // ==========================================================================
  // 4. Promptfoo 真实样本导入契约与缺样本阻断反证测试
  // ==========================================================================
  describe('4. Promptfoo 真实样本导入契约与缺样本门禁 (validateAgentSampleImport & evaluateAgentOutput)', () => {
    it('4.1 validateAgentSampleImport 严格校验导入结构', () => {
      // 非法：缺少必要字段
      const invalidRes1 = validateAgentSampleImport(null);
      expect(invalidRes1.valid).toBe(false);

      const invalidRes2 = validateAgentSampleImport({
        importSource: 'manual',
        sampleId: 's-01',
        // 缺少 isRealSample
        sample: { content: 'hello' },
      });
      expect(invalidRes2.valid).toBe(false);
      expect(invalidRes2.error).toContain('isRealSample 必须明确为布尔值');

      // 合法真实样本
      const validRes = validateAgentSampleImport({
        importSource: 'session_dump',
        sampleId: 's-valid-01',
        isRealSample: true,
        importedAt: '2026-09-22T10:00:00.000Z',
        sample: {
          agentName: 'coding-agent',
          content: '执行任务完成',
          structuredDecision: {
            verdictClaim: 'PASS',
            taskId: 9527,
          },
        },
      });
      expect(validRes.valid).toBe(true);
      expect(validRes.imported?.isRealSample).toBe(true);
    });

    it('4.2 isRealSample=false 或缺少样本时，evaluateAgentOutput 严格返回 BLOCKED_DATA_MISSING', () => {
      const input: AgentEvaluationInput = {
        testId: 'eval-test-no-sample',
        environment: 'test',
        capturedAt: '2026-09-22T10:00:00.000Z',
        evidenceId: 'ev-eval-01',
        isRealSample: false, // 声明不是真实样本！
        sample: null,
        goldenCriteria: {
          expectedVerdict: 'PASS',
        },
      };

      const report = evaluateAgentOutput(input);
      expect(report.status).toBe('BLOCKED_DATA_MISSING');
      expect(report.passed).toBe(false);
      expect(report.evidenceEnvelope.observationStatus).toBe('UNVERIFIED');
      expect(report.evidenceEnvelope.collectionStatus).toBe('BLOCKED');
      expect(report.evidenceEnvelope.error?.code).toBe('BLOCKED_DATA_MISSING');
    });
  });

  // ==========================================================================
  // 5. Playwright / Midscene DEFERRED_EXTERNAL_RUNTIME 声明与无外部运行时反证
  // ==========================================================================
  describe('5. Playwright / Midscene DEFERRED_EXTERNAL_RUNTIME 声明与阻断', () => {
    it('5.1 Producer 明确声明 maturity 为 DEFERRED_EXTERNAL_RUNTIME，scope 为 NOT_IN_ZERO_DEPENDENCY_SCOPE', () => {
      const browserProducer = new UIBrowserEvidenceProducer();
      expect(browserProducer.maturity).toBe('DEFERRED_EXTERNAL_RUNTIME');
      expect(browserProducer.scope).toBe('NOT_IN_ZERO_DEPENDENCY_SCOPE');

      const visualProducer = new UIVisualAiEvidenceProducer();
      expect(visualProducer.maturity).toBe('DEFERRED_EXTERNAL_RUNTIME');
      expect(visualProducer.scope).toBe('NOT_IN_ZERO_DEPENDENCY_SCOPE');
    });

    it('5.2 无外部运行时提供 raw 事实时，严格返回 COLLECTION_FAILED，绝不合成伪造成功', async () => {
      const browserProducer = new UIBrowserEvidenceProducer();
      const ctx: DeterministicProducerContext = {
        testId: 'test-ui-deferred-01',
        environment: 'offline',
        subjectType: 'task',
        subjectId: 9527,
        capturedAt: '2026-09-22T10:00:00.000Z',
        evidenceId: 'ev-dom-deferred',
      };

      // 缺少外部真实浏览器采集到的 rawBrowser
      const envelopes = await browserProducer.produce({}, ctx);
      const domEnv = envelopes.find((e) => e.evidenceKey === 'BROWSER:TASK_STATUS_DOM');

      expect(domEnv).toBeDefined();
      expect(domEnv?.collectionStatus).toBe('COLLECTION_FAILED');
      expect(domEnv?.observationStatus).toBe('UNVERIFIED');
      expect(domEnv?.error?.code).toBe('DOM_FACT_MISSING');
    });
  });

  // ==========================================================================
  // 6. 候选需求映射文件 (devtest-requirements.candidate.json) 物理存在与可验证性
  // ==========================================================================
  describe('6. 候选需求映射文件 (devtest-requirements.candidate.json) 物理存在与可验证性', () => {
    it('6.1 候选文件物理存在，且包含可证明的 5 条需求追踪映射', () => {
      const candidateFilePath = path.resolve(process.cwd(), 'devtest-requirements.candidate.json');
      expect(fs.existsSync(candidateFilePath)).toBe(true);

      const res = findAuthoritativeRequirementTraces({ filePath: candidateFilePath });
      expect(res.status).toBe('LOADED');
      expect(res.traces).toHaveLength(5);

      const reqIds = res.traces.map((t) => t.requirementId);
      expect(reqIds).toContain('REQ-BILLING-001');
      expect(reqIds).toContain('REQ-ROUTING-001');
      expect(reqIds).toContain('REQ-UI-AUDIT-001');
      expect(reqIds).toContain('REQ-EXPORT-001');
      expect(reqIds).toContain('REQ-AI-GUARD');

      // 验证每条候选映射的 sourceRefs 指向的物理文件全部真实存在
      for (const trace of res.traces) {
        expect(trace.sourceRefs.length).toBeGreaterThan(0);
        expect(trace.testIds.length).toBeGreaterThan(0);
        for (const ref of trace.sourceRefs) {
          const absRef = path.resolve(process.cwd(), ref);
          expect(fs.existsSync(absRef)).toBe(true);
        }
      }
    });

    it('6.2 默认路径查找依然返回 BLOCKED_DATA_MISSING（未经人工审核不得升级为权威映射）', () => {
      const defaultRes = findAuthoritativeRequirementTraces();
      expect(defaultRes.status).toBe('BLOCKED_DATA_MISSING');
      expect(defaultRes.error).toContain('未找到权威需求映射文件 (devtest-requirements.json)');
    });
  });
});
