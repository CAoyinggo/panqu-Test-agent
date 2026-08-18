// Test Case 确定性生成器：根据结构化 Requirement 生成 TestCase 列表
// 覆盖维度：正常路径 / 业务规则 / 参数组合 / 边界值 / 异常输入 / 依赖异常 / 并发 / 数据异常
// 定位：LLM 不可用 / 返回非法 JSON / 校验失败时使用，保证测试设计链路始终可产出用例。
// 优先级：P0 核心链路 → P1 参数/边界 → P2 异常 → P3 并发/数据。

import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase, TestPriority, TestStep, AssertionDefinition } from './testcase-schema.js';

/** 生成器选项 */
export interface TestCaseGeneratorOptions {
  /** 单条用例最大步数/断言数上限（防止无限膨胀） */
  maxCases?: number;
}

/** 场景默认输入（video 场景） */
function defaultStepInput(feature: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  const f = feature.toLowerCase();
  if (f === 'wan3' || f.includes('video')) {
    input.prompt = '一个女孩在花园里奔跑，阳光明媚，镜头缓慢跟随';
  }
  return input;
}

/** 构造一个基础 TestCase 骨架 */
function baseCase(
  req: Requirement,
  id: string,
  name: string,
  priority: TestPriority,
  tags: string[],
  steps: TestStep[],
  assertions: AssertionDefinition[],
  data: Record<string, unknown> = {},
  expected?: { status?: string; fields?: Record<string, unknown> },
): TestCase {
  return {
    id,
    feature: req.feature,
    name,
    priority,
    tags: ['agent-generated', ...tags],
    data,
    steps,
    assertions,
    expected,
    metadata: {
      source: 'deterministic-generator',
      confidence: req.confidence ?? 0.8,
    },
  };
}

/** 根据业务规则关键词生成对应断言（具体规则优先，避免被通用规则误匹配） */
function ruleAssertions(rule: string): AssertionDefinition[] {
  // ── Phase 20.8 扩展规则（具体业务概念优先） ──
  if (/余额不足/i.test(rule)) {
    return [{ target: 'submit', path: 'err.code', operator: 'exists', severity: 'P1', message: '余额不足时提交被拒绝并返回明确错误码' }];
  }
  if (/未登录|未授权/i.test(rule)) {
    return [{ target: 'submit', path: 'err.code', operator: 'exists', severity: 'P0', message: '未登录用户提交任务应返回未授权错误' }];
  }
  if (/下载|url|链接/i.test(rule)) {
    return [{ target: 'response', path: 'downloadUrl', operator: 'exists', severity: 'P1', message: '生成完成后可查询视频下载 URL 且可访问' }];
  }
  if (/历史|列表|倒序/i.test(rule)) {
    return [{ target: 'response', path: 'history', operator: 'exists', severity: 'P1', message: '历史列表按时间倒序返回' }];
  }
  if (/取消/i.test(rule)) {
    return [{ target: 'submit', path: 'status', operator: 'in', expected: ['CANCELLED', 'CANCELED'], severity: 'P1', message: '取消后任务状态变为已取消' }];
  }
  if (/去重|重复/i.test(rule)) {
    return [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1', message: '重复提交同一 prompt 不产生重复任务' }];
  }
  if (/幂等|request\s?[-_]?id/i.test(rule)) {
    return [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1', message: '相同 requestId 重复提交返回同一任务且只扣一次费' }];
  }
  if (/鉴权分级|会员|分级/i.test(rule)) {
    return [{ target: 'submit', path: 'status', operator: 'in', expected: ['SUCCESS', 'FORBIDDEN'], severity: 'P0', message: '不同会员等级对 4K 生成的权限差异校验' }];
  }
  if (/阶梯|单价/i.test(rule)) {
    return [{ target: 'billing', path: 'actualConsumed', operator: 'gte', expected: 0, severity: 'P1', message: '不同分辨率对应不同积分单价，扣减准确' }];
  }
  if (/失败.*恢复|重新提交|重提/i.test(rule)) {
    return [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1', message: '模型失败后可重提任务且历史保留失败记录' }];
  }
  if (/一致|详情/i.test(rule)) {
    return [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1', message: '提交前后查询详情，积分扣减与任务 ID 保持一致' }];
  }
  if (/注入|泄露|系统提示/i.test(rule)) {
    return [{ target: 'response', path: 'behavior', operator: 'exists', severity: 'P0', message: '注入文本不改变生成行为且不泄露系统提示' }];
  }
  if (/内容安全|涉黄|暴力|仇恨|违规|敏感/i.test(rule)) {
    return [{ target: 'submit', path: 'err', operator: 'exists', severity: 'P0', message: '违规内容（涉黄/暴力/仇恨）prompt 应被安全拒绝' }];
  }
  if (/参数校验|校验错误|非法参数|无效参数/i.test(rule)) {
    return [{ target: 'submit', path: 'err.code', operator: 'exists', severity: 'P1', message: '无效参数返回明确校验错误而非 500' }];
  }
  if (/seed|temperature/i.test(rule)) {
    return [{ target: 'response', path: 'hash', operator: 'exists', severity: 'P1', message: 'seed 固定多次生成结果一致，temperature 变化结果不同' }];
  }
  if (/复现|hash/i.test(rule)) {
    return [{ target: 'response', path: 'hash', operator: 'exists', severity: 'P1', message: '同 prompt 同参数生成结果可复现（hash 一致）' }];
  }
  if (/错误码|4001|4003/i.test(rule)) {
    return [{ target: 'submit', path: 'err.code', operator: 'in', expected: [4001, 4003], severity: 'P0', message: '余额不足返回 4001、参数非法返回 4003，错误码与业务语义匹配' }];
  }
  if (/伪造|过期.*cookie|cookie/i.test(rule)) {
    return [{ target: 'submit', path: 'err', operator: 'exists', severity: 'P0', message: '伪造或过期 Cookie 请求均被拒绝且不返回业务数据' }];
  }
  if (/限流|429/i.test(rule)) {
    return [{ target: 'submit', path: 'err.status', operator: 'equals', expected: 429, severity: 'P1', message: '高频连续提交触发限流返回 429，且提示稍后重试' }];
  }
  if (/超长|413/i.test(rule)) {
    return [{ target: 'submit', path: 'err', operator: 'notExists', severity: 'P1', message: '极长 prompt 不导致超时或 413' }];
  }
  if (/多语言|中文|英文|混排/i.test(rule)) {
    return [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1', message: '中文、英文、中英混排 prompt 均正常生成' }];
  }
  if (/时长/i.test(rule)) {
    return [{ target: 'response', path: 'duration', operator: 'exists', severity: 'P1', message: '视频时长字段为 5s' }];
  }
  if (/长度|超长/i.test(rule)) {
    return [{ target: 'submit', path: 'err', operator: 'exists', severity: 'P2', message: '提示词长度超出限制应被拒绝' }];
  }

  // ── 原有规则 ──
  if (/积分|扣费|余额|billing|计费/i.test(rule)) {
    return [
      { target: 'billing', path: 'actualConsumed', operator: 'gte', expected: 0, severity: 'P1', message: '积分正确扣除' },
      { target: 'billing', path: 'afterBalance.available_points', operator: 'exists', severity: 'P1', message: '余额字段存在且正确' },
    ];
  }
  if (/状态.*成功|任务.*成功|最终.*成功/i.test(rule)) {
    return [
      { target: 'submit', path: 'status', operator: 'in', expected: ['SUCCESS', 'COMPLETED'], severity: 'P0', message: '任务状态最终成功' },
    ];
  }
  if (/任务.*提交|提交.*成功/i.test(rule)) {
    return [
      { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P0', message: '任务提交成功' },
    ];
  }
  if (/并发/i.test(rule)) {
    return [
      { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P0', message: '并发提交互不干扰且各自扣费正确' },
    ];
  }
  if (/超时/i.test(rule)) {
    return [
      { target: 'submit', path: 'err', operator: 'notExists', severity: 'P2', message: '超时后正常返回' },
    ];
  }
  if (/重试/i.test(rule)) {
    return [
      { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1', message: '重试后提交成功' },
    ];
  }
  return [];
}

/** 生成「任务提交成功」标准步骤 */
function submitStep(input: Record<string, unknown>): TestStep {
  return { action: 'submit', input };
}

function waitSuccessStep(): TestStep {
  return { action: 'wait', until: 'SUCCESS' };
}

/**
 * 确定性生成测试用例。
 * 覆盖策略：
 *  - P0：正常路径 + 每条业务规则
 *  - P1：参数取值组合 + 边界值
 *  - P2：异常输入 + 依赖异常
 *  - P3：并发 + 数据异常
 */
export function generateTestCases(req: Requirement, opts: TestCaseGeneratorOptions = {}): TestCase[] {
  const out: TestCase[] = [];
  const maxCases = opts.maxCases ?? 50;
  const feature = req.feature || 'wan3';
  const baseInput = defaultStepInput(feature);
  const submit = (input: Record<string, unknown>): TestStep[] => [submitStep({ ...baseInput, ...input }), waitSuccessStep()];
  const seq = (n: number): string => String(n).padStart(2, '0');

  // ── P0：正常路径 ──
  out.push(baseCase(
    req, `tc-${seq(1)}`, `${feature} 正常提交并成功`, 'P0', ['smoke', 'happy-path'],
    submit({}),
    [
      { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P0' },
      { target: 'submit', path: 'status', operator: 'in', expected: ['SUCCESS', 'COMPLETED', 'SUBMITTED'], severity: 'P0', message: '任务状态最终为 SUCCESS' },
    ],
    {},
    { status: 'SUCCESS' },
  ));

  // ── P0：业务规则 ──
  for (const rule of req.businessRules) {
    const ruleAs = ruleAssertions(rule);
    if (!ruleAs.length) continue;
    const ruleName = rule.length > 12 ? `${rule.slice(0, 12)}…` : rule;
    out.push(baseCase(
      req, `tc-${seq(out.length + 1)}`, `${feature} 业务规则-${ruleName}`, 'P0', ['business-rule'],
      submit({}),
      ruleAs,
      {},
      { status: 'SUCCESS' },
    ));
  }

  // ── P1：参数取值组合 ──
  for (const item of req.requirements) {
    const values = Array.isArray(item.values) ? item.values.slice(0, 4) : [];
    for (const v of values) {
      const input: Record<string, unknown> = {};
      input[item.name] = v;
      out.push(baseCase(
        req, `tc-${seq(out.length + 1)}`, `${feature} 参数组合-${item.name}=${String(v)}`, 'P1', ['param', 'combination'],
        submit(input),
        [
          { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1' },
          { target: 'submit', path: 'status', operator: 'in', expected: ['SUCCESS', 'COMPLETED', 'SUBMITTED'], severity: 'P1' },
        ],
        input,
      ));
    }
  }

  // ── P1：边界值（时长/分辨率等数值参数） ──
  for (const item of req.requirements) {
    const nums = (Array.isArray(item.values) ? item.values : []).map(Number).filter((n) => Number.isFinite(n));
    if (!nums.length) continue;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    if (min > 0) {
      const input: Record<string, unknown> = {};
      input[item.name] = min;
      out.push(baseCase(
        req, `tc-${seq(out.length + 1)}`, `${feature} 边界-${item.name}最小值=${min}`, 'P1', ['boundary'],
        submit(input),
        [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1' }],
        input,
      ));
    }
    {
      const input: Record<string, unknown> = {};
      input[item.name] = max;
      out.push(baseCase(
        req, `tc-${seq(out.length + 1)}`, `${feature} 边界-${item.name}最大值=${max}`, 'P1', ['boundary'],
        submit(input),
        [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1' }],
        input,
      ));
    }
  }

  // ── P2：异常输入 ──
  out.push(baseCase(
    req, `tc-${seq(out.length + 1)}`, `${feature} 异常-空提示词`, 'P2', ['negative', 'invalid-input'],
    [submitStep({ ...baseInput, prompt: '' })],
    [
      { target: 'submit', path: 'err', operator: 'exists', severity: 'P2', message: '空提示词应被拒绝并提示必填' },
    ],
    { prompt: '' },
  ));

  out.push(baseCase(
    req, `tc-${seq(out.length + 1)}`, `${feature} 异常-非法分辨率`, 'P2', ['negative', 'invalid-input'],
    [submitStep({ ...baseInput, resolution: 'INVALID_RES' })],
    [
      { target: 'submit', path: 'err', operator: 'exists', severity: 'P2', message: '非法分辨率应被拒绝' },
    ],
    { resolution: 'INVALID_RES' },
  ));

  // ── P2：依赖异常 ──
  for (const dep of req.dependencies.slice(0, 2)) {
    out.push(baseCase(
      req, `tc-${seq(out.length + 1)}`, `${feature} 依赖异常-${dep}`, 'P2', ['dependency', 'degradation'],
      submit({}),
      [
        { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P2' },
        { target: 'submit', path: 'status', operator: 'in', expected: ['SUCCESS', 'COMPLETED', 'SUBMITTED', 'FAILED'], severity: 'P2' },
      ],
    ));
  }

  // ── P3：并发 ──
  if (req.businessRules.some((r) => /并发/i.test(r)) || req.capabilities.some((c) => /concurrent|并发/i.test(c))) {
    out.push(baseCase(
      req, `tc-${seq(out.length + 1)}`, `${feature} 并发-同时提交多个任务`, 'P3', ['concurrency'],
      submit({}),
      [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P2' }],
      { concurrency: 5 },
    ));
  }

  // ── P3：数据异常 ──
  out.push(baseCase(
    req, `tc-${seq(out.length + 1)}`, `${feature} 数据异常-特殊字符提示词`, 'P3', ['data-anomaly'],
    submit({ ...baseInput, prompt: `${baseInput.prompt ?? 'prompt'} @#$%^&*()_+{}[]|<>?/，。！·` }),
    [
      { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P2' },
    ],
    { specialChars: true },
  ));

  return out.slice(0, maxCases);
}
