// Data 确定性分析器：根据 Requirement + TestCase 列表分析测试数据需求，产出结构化 DataPlan
// 覆盖数据需求：账号 / 积分 / 素材 / 任务创建 / 清理
// 定位：LLM 不可用 / 返回非法 JSON / 校验失败时使用，保证数据准备链路始终可产出结构化计划。

import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import type { DataNeedType } from './data-schema.js';
import {
  DataPlan,
  DataAction,
  CaseDataAssignment,
} from './data-schema.js';

/** 分析器输入 */
export interface DataAnalyzerInput {
  requirement: Requirement;
  testCases?: TestCase[];
  /** 执行环境（test / preonline / prod） */
  environment?: string;
}

/** 按 feature 推断推荐数据工厂 */
function inferFactoryName(feature: string): string {
  const f = feature.toLowerCase();
  if (f === 'wan3' || f.includes('video')) return 'wan3';
  return f || 'default';
}

/** 去重并合并同类型动作的目标用例 */
function mergeActions(actions: DataAction[]): DataAction[] {
  const byType = new Map<DataNeedType, DataAction>();
  for (const a of actions) {
    const existing = byType.get(a.type);
    if (existing) {
      existing.targetCases = Array.from(new Set([...(existing.targetCases ?? []), ...(a.targetCases ?? [])]));
      if (existing.targetCases?.length) existing.desc = `${existing.desc.split('；')[0]}；影响 ${existing.targetCases.length} 条用例`;
    } else {
      byType.set(a.type, { ...a, targetCases: [...(a.targetCases ?? [])] });
    }
  }
  return Array.from(byType.values());
}

/**
 * 确定性数据需求分析。
 * 规则：
 *  - 计费断言用例 → balance（积分准备）动作
 *  - 并发用例 → tasks（多任务创建）动作
 *  - video 能力 / wan3 → assets（素材上传）动作
 *  - 异常/数据异常用例 → cleanup（执行后清理）动作
 *  - 推荐工厂 = feature 映射（wan3 → wan3，其余用 feature 名）
 */
export function analyzeDataPlan(input: DataAnalyzerInput): DataPlan {
  const { requirement, testCases = [], environment } = input;
  const feature = requirement.feature || 'wan3';
  const factoryName = inferFactoryName(feature);

  const setupActions: DataAction[] = [];
  const teardownActions: DataAction[] = [];

  const billingIds = testCases
    .filter((c) => c.assertions.some((a) => a.target === 'billing'))
    .map((c) => c.id);
  const billingDeclared = requirement.businessRules.some((rule) => /金额|余额|扣费|计费|billing/i.test(rule))
    || requirement.dependencies.some((dependency) => /金额|余额|扣费|计费|billing/i.test(dependency))
    || (requirement.risks ?? []).some((risk) => /billing|financial/i.test(risk));
  if (billingIds.length || billingDeclared) {
    setupActions.push({
      type: 'balance',
      desc: '准备 Requirement 声明的账目状态快照',
      targetCases: billingIds.length ? billingIds : testCases.map((testCase) => testCase.id),
    });
  }

  const concurrentIds = testCases.filter((c) => c.tags.includes('concurrency')).map((c) => c.id);
  if (concurrentIds.length) {
    setupActions.push({ type: 'tasks', desc: '并发场景准备多个待提交任务', targetCases: concurrentIds });
  }

  const isVideo = feature.toLowerCase() === 'wan3'
    || feature.toLowerCase().includes('video')
    || requirement.capabilities.some((c) => /video/i.test(c));
  if (isVideo) {
    const videoCases = testCases.filter((c) => c.feature === feature).map((c) => c.id);
    setupActions.push({ type: 'assets', desc: '上传视频生成所需素材（图片/音频/参考图）', targetCases: videoCases.length ? videoCases : undefined });
  }

  const dirtyIds = testCases
    .filter((c) => c.tags.includes('invalid-input') || c.tags.includes('data-anomaly') || c.tags.includes('negative'))
    .map((c) => c.id);
  if (dirtyIds.length) {
    teardownActions.push({ type: 'cleanup', desc: '清理异常输入用例可能产生的脏数据', targetCases: dirtyIds });
  }

  // 用例 → 工厂分配
  const caseAssignments: CaseDataAssignment[] = testCases.map((c) => ({
    caseId: c.id,
    factoryName,
    needsSetup: setupActions.some((a) => !a.targetCases || a.targetCases.includes(c.id)),
  }));

  // 参数化生成参数（供 DataFactory.generate()）
  const generateParams: Record<string, unknown> = {};
  for (const item of requirement.requirements) {
    if (item.values.length) generateParams[item.name] = item.values;
  }
  if (environment) generateParams.env = environment;

  const needsSetup = setupActions.length > 0;
  return {
    feature,
    needsSetup,
    factoryName,
    setupActions: mergeActions(setupActions),
    teardownActions: mergeActions(teardownActions),
    caseAssignments,
    generateParams,
    dataContext: {},
    source: requirement.source,
    confidence: Math.min(0.95, 0.55 + setupActions.length * 0.1),
  };
}
