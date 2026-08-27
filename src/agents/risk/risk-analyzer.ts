// Risk 确定性分析器：根据 Requirement + TestCase 列表 + 环境，产出结构化 RiskAssessment
// 覆盖维度：依赖可用性 / 数据异常 / 边界值 / 并发 / 计费 / 安全 / 环境 / 超时 / 重试
// 定位：LLM 不可用 / 返回非法 JSON / 校验失败时使用，保证风险评估链路始终可产出结构化结果。

import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase } from '../test-design/testcase-schema.js';
import {
  RiskAssessment,
  RiskItem,
  computeRiskSummary,
  toIssueItem,
} from './risk-schema.js';

/** 分析器输入 */
export interface RiskAnalyzerInput {
  requirement: Requirement;
  testCases?: TestCase[];
  /** 执行环境（test / preonline / prod） */
  environment?: string;
}

/** 序号生成 */
function seq(n: number): string {
  return `risk-${String(n).padStart(2, '0')}`;
}

/** 按标签汇总受影响用例 ID */
function collectCaseIds(testCases: TestCase[], predicate: (c: TestCase) => boolean): string[] {
  return (testCases ?? []).filter(predicate).map((c) => c.id);
}

/**
 * 确定性风险评估。
 * 规则优先级：阻塞性（计费/安全/并发/环境）> 数据性（边界/异常/依赖）> 提示性（低）。
 */
export function analyzeRisks(input: RiskAnalyzerInput): RiskAssessment {
  const { requirement, testCases = [], environment } = input;
  const declaredRisks = new Set(requirement.risks ?? []);
  const risks: RiskItem[] = [];
  let n = 0;
  const push = (item: Omit<RiskItem, 'id'>): void => {
    risks.push({ ...item, id: seq(++n) });
  };

  // ── 依赖可用性 ──
  for (const dep of requirement.dependencies) {
    const affected = collectCaseIds(testCases, (c) => c.tags.includes('dependency'));
    push({
      category: 'dependency',
      level: 'medium',
      title: `依赖服务「${dep}」可用性未验证`,
      desc: `依赖 ${dep} 未纳入本次验证范围，若服务异常可能批量失败`,
      affectedCases: affected.length ? affected : undefined,
      mitigation: `执行前确认 ${dep} 可用性，失败时按依赖降级策略处理`,
      confidence: 0.8,
    });
  }
  if (!requirement.dependencies.length) {
    push({
      category: 'dependency',
      level: 'low',
      title: '未声明依赖服务',
      desc: '需求未声明依赖，可能遗漏外部服务可用性检查',
      mitigation: '补充依赖清单或按默认链路执行',
      confidence: 0.5,
    });
  }

  // ── 数据异常（异常输入用例） ──
  const invalidIds = collectCaseIds(testCases, (c) => c.tags.includes('invalid-input') || c.tags.includes('negative'));
  if (invalidIds.length) {
    push({
      category: 'data',
      level: 'medium',
      title: '异常输入用例可能产生脏数据',
      desc: `${invalidIds.length} 条异常输入用例，若服务端校验不严可能污染数据`,
      affectedCases: invalidIds,
      mitigation: '执行后核对无残留脏数据，必要时 teardown 清理',
      confidence: 0.75,
    });
  }

  // ── 边界值 ──
  const boundaryIds = collectCaseIds(testCases, (c) => c.tags.includes('boundary'));
  if (boundaryIds.length) {
    push({
      category: 'boundary',
      level: 'medium',
      title: '边界值用例存在参数越界风险',
      desc: `${boundaryIds.length} 条边界值用例，参数临界值可能触发未预期行为`,
      affectedCases: boundaryIds,
      mitigation: '关注边界失败是否为产品缺陷而非测试问题',
      confidence: 0.7,
    });
  }

  // ── 并发 ──
  const concurrentIds = collectCaseIds(testCases, (c) => c.tags.includes('concurrency'));
  if (concurrentIds.length) {
    push({
      category: 'concurrency',
      level: 'high',
      title: '并发用例可能触发限流或资源竞争',
      desc: `${concurrentIds.length} 条并发用例，高并发下可能触发限流/超卖/状态覆盖`,
      affectedCases: concurrentIds,
      mitigation: '设置合理并发数，失败时降低并发重试',
      confidence: 0.85,
    });
  }

  // ── 计费 ──
  const billingIds = collectCaseIds(testCases, (c) => c.assertions.some((a) => a.target === 'billing'));
  if (billingIds.length
    || declaredRisks.has('billing')
    || requirement.dependencies.some((d) => /积分|计费|billing/i.test(d))) {
    push({
      category: 'billing',
      level: 'high',
      title: '积分/计费涉及资金账目，需人工复核',
      desc: `${billingIds.length} 条计费断言用例，扣减/余额准确性直接影响账目`,
      affectedCases: billingIds.length ? billingIds : undefined,
      mitigation: '计费类失败需人工复核账单，禁止自动跳过',
      confidence: 0.9,
    });
  }

  // ── 安全（越权/信息泄露） ──
  const securityIds = collectCaseIds(testCases, (c) => c.tags.includes('security'));
  if (securityIds.length) {
    push({
      category: 'security',
      level: 'high',
      title: '安全/越权用例存在数据泄露风险',
      desc: `${securityIds.length} 条安全相关用例，若越权防护失效可能泄露跨账号数据`,
      affectedCases: securityIds,
      mitigation: '安全失败视为阻塞，需立即上报',
      confidence: 0.85,
    });
  }

  // ── 环境 ──
  if (environment === 'prod') {
    push({
      category: 'environment',
      level: 'high',
      title: '生产环境执行风险',
      desc: '在生产环境执行测试可能影响真实用户数据与账目',
      mitigation: '优先 test/preonline 环境；确需 prod 时开启只读断言与最小影响模式',
      confidence: 0.95,
    });
  } else if (environment && environment !== 'test') {
    push({
      category: 'environment',
      level: 'low',
      title: `预发布环境（${environment}）数据隔离待确认`,
      desc: '预发布环境可能与生产共享部分数据源',
      mitigation: '执行前确认数据隔离，避免污染生产数据',
      confidence: 0.6,
    });
  }

  // ── 超时 / 重试（业务规则驱动） ──
  if (declaredRisks.has('timeout') || requirement.businessRules.some((r) => /超时/i.test(r))) {
    push({
      category: 'timeout',
      level: 'medium',
      title: '超时处理链路存在不确定性',
      desc: '需求包含超时场景，超时阈值与重试策略需与实现对齐',
      mitigation: '确认超时阈值与轮询间隔，避免用例误报',
      confidence: 0.7,
    });
  }
  if (declaredRisks.has('retry') || requirement.businessRules.some((r) => /重试/i.test(r))) {
    push({
      category: 'retry',
      level: 'low',
      title: '重试机制可能掩盖瞬时失败',
      desc: '需求包含重试场景，重试可能掩盖服务瞬时抖动',
      mitigation: '结合 Metrics 区分重试成功与真实失败',
      confidence: 0.65,
    });
  }

  // ── 汇总与 IssueItem 映射 ──
  const summary = computeRiskSummary(risks);
  return {
    feature: requirement.feature,
    risks,
    summary,
    issues: risks.map(toIssueItem),
    source: requirement.source,
    confidence: Math.min(0.95, 0.6 + risks.length * 0.03),
  };
}
