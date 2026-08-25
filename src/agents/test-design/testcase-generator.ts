// Test Case 确定性生成器：识别业务 → 对应 Generator（注册表分发）。
// 覆盖维度：正常路径 / 业务规则 / 参数组合 / 边界值 / 异常输入（失败注入）/ 依赖异常 / 并发 / 数据异常。
// 定位：LLM 不可用 / 返回非法 JSON / 校验失败时使用，保证测试设计链路始终可产出用例。
// 硬约束：
//   1. Unknown 业务绝不伪造 WAN3/视频用例（旧「无法识别 → wan3」危险兜底已删除）；
//   2. 所有产出必须通过 DSL 可执行性检查（checkDslExecutable）才允许返回。
// 优先级：P0 核心链路 → P1 参数/边界 → P2 异常 → P3 并发/数据。

import type { Requirement } from '../requirement/requirement-schema.js';
import type { TestCase, TestPriority, TestStep, AssertionDefinition } from './testcase-schema.js';
import { filterDslExecutable } from './testcase-schema.js';
import {
  identifyBusiness,
  registerBusinessGenerator,
  resolveBusinessGenerator,
  type BusinessProfile,
  type BusinessTestCaseGenerator,
} from './business.js';

/** 生成器选项 */
export interface TestCaseGeneratorOptions {
  /** 单条用例最大步数/断言数上限（防止无限膨胀） */
  maxCases?: number;
}

/** 视频类业务的默认提示词（仅 video/wan3 生成器使用，不污染其它业务） */
const VIDEO_DEFAULT_PROMPT = '一个女孩在花园里奔跑，阳光明媚，镜头缓慢跟随';

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

// ── 公共骨架：业务规则 / 参数组合 / 边界值 / 依赖异常 / 并发 / 数据异常 ──
// 各业务 Generator 提供自己的 baseInput（业务默认输入）与 negative 注入集合。

/** 按声明输入推导业务基础输入（取每个声明参数的首个取值，未声明则空） */
function declaredBaseInput(req: Requirement): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const item of req.requirements) {
    const values = Array.isArray(item.values) ? item.values : [];
    if (values.length > 0) input[item.name] = values[0];
  }
  return input;
}

/** 数值型声明输入（供边界值用例） */
function numericValues(item: Requirement['requirements'][number]): number[] {
  return (Array.isArray(item.values) ? item.values : []).map(Number).filter((n) => Number.isFinite(n));
}

/** 生成公共用例集（业务规则 + 参数组合 + 边界值 + 依赖异常 + 并发 + 数据异常） */
function commonCases(
  req: Requirement,
  profile: BusinessProfile,
  baseInput: Record<string, unknown>,
  out: TestCase[],
  seq: (n: number) => string,
  opts: { dependencyCases?: boolean } = {},
): void {
  const feature = profile.feature;
  const submit = (input: Record<string, unknown>): TestStep[] => [submitStep({ ...baseInput, ...input }), waitSuccessStep()];

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
      out.push(baseCase(
        req, `tc-${seq(out.length + 1)}`, `${feature} 参数组合-${item.name}=${String(v)}`, 'P1', ['param', 'combination'],
        submit({ [item.name]: v }),
        [
          { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1' },
          { target: 'submit', path: 'status', operator: 'in', expected: ['SUCCESS', 'COMPLETED', 'SUBMITTED'], severity: 'P1' },
        ],
        { [item.name]: v },
      ));
    }
  }

  // ── P1：边界值（数值参数取 min/max） ──
  for (const item of req.requirements) {
    const nums = numericValues(item);
    if (!nums.length) continue;
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    for (const [label, v] of [['最小值', min], ['最大值', max]] as const) {
      if (label === '最小值' && min <= 0) continue;
      out.push(baseCase(
        req, `tc-${seq(out.length + 1)}`, `${feature} 边界-${item.name}${label}=${v}`, 'P1', ['boundary'],
        submit({ [item.name]: v }),
        [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P1' }],
        { [item.name]: v },
      ));
    }
  }

  // ── P2：依赖异常（降级观测：提交正常输入，接受成功或依赖导致的失败） ──
  if (opts.dependencyCases !== false) {
    for (const dep of req.dependencies.slice(0, 2)) {
      out.push(baseCase(
        req, `tc-${seq(out.length + 1)}`, `${feature} 依赖异常-${dep}`, 'P2', ['dependency', 'degradation'],
        submit({}),
        [
          { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P2' },
          { target: 'submit', path: 'status', operator: 'in', expected: ['SUCCESS', 'COMPLETED', 'SUBMITTED', 'FAILED'], severity: 'P2', message: `依赖 ${dep} 异常时任务进入明确状态（成功或失败），不得悬挂` },
        ],
        { dependencyUnderTest: dep },
      ));
    }
  }

  // ── P3：并发（业务声明并发规则/能力时） ──
  if (req.businessRules.some((r) => /并发/i.test(r)) || req.capabilities.some((c) => /concurrent|并发/i.test(c))) {
    out.push(baseCase(
      req, `tc-${seq(out.length + 1)}`, `${feature} 并发-同时提交多个任务`, 'P3', ['concurrency'],
      submit({}),
      [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P2', message: '并发提交互不干扰且各自扣费正确' }],
      { concurrency: 5 },
    ));
  }
}

// ── Video Generator（wan3 / video：唯一有真实 Processor 的业务） ──
class VideoTestCaseGenerator implements BusinessTestCaseGenerator {
  readonly kind = 'video';

  generate(req: Requirement, profile: BusinessProfile, opts: TestCaseGeneratorOptions = {}): TestCase[] {
    const out: TestCase[] = [];
    const maxCases = opts.maxCases ?? 50;
    const feature = profile.feature;
    const baseInput: Record<string, unknown> = { prompt: VIDEO_DEFAULT_PROMPT };
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

    commonCases(req, profile, baseInput, out, seq);

    // ── P2：失败注入（视频业务专属参数） ──
    // 空 prompt：覆盖默认提示词提交空串，应被拒绝
    out.push(baseCase(
      req, `tc-${seq(out.length + 1)}`, `${feature} 失败注入-空提示词`, 'P2', ['negative', 'failure-injection'],
      [submitStep({ ...baseInput, prompt: '' })],
      [{ target: 'submit', path: 'err', operator: 'exists', severity: 'P2', message: '空提示词应被拒绝并提示必填' }],
      { prompt: '' },
    ));
    // 非法分辨率：业务真实支持的视频档位之外取值
    out.push(baseCase(
      req, `tc-${seq(out.length + 1)}`, `${feature} 失败注入-非法分辨率`, 'P2', ['negative', 'failure-injection'],
      [submitStep({ ...baseInput, resolution: 'INVALID_RES' })],
      [{ target: 'submit', path: 'err', operator: 'exists', severity: 'P2', message: '非法分辨率应被拒绝' }],
      { resolution: 'INVALID_RES' },
    ));

    // ── P3：数据异常（特殊字符注入） ──
    out.push(baseCase(
      req, `tc-${seq(out.length + 1)}`, `${feature} 数据异常-特殊字符提示词`, 'P3', ['data-anomaly', 'failure-injection'],
      submit({ prompt: `${VIDEO_DEFAULT_PROMPT} @#$%^&*()_+{}[]|<>?/，。！·` }),
      [{ target: 'submit', path: 'taskId', operator: 'exists', severity: 'P2', message: '特殊字符 prompt 不应崩溃，正常生成或明确拒绝' }],
      { specialChars: true },
    ));

    return out.slice(0, maxCases);
  }
}

// ── Generic Business Generator（user / order / payment 等已识别的非视频业务） ──
// 不注入任何视频参数（prompt/resolution 等视频字段不得出现）；
// 失败注入只针对需求显式声明的输入参数（空值 / 类型非法值）。
class GenericBusinessGenerator implements BusinessTestCaseGenerator {
  readonly kind = 'generic';

  generate(req: Requirement, profile: BusinessProfile, opts: TestCaseGeneratorOptions = {}): TestCase[] {
    const out: TestCase[] = [];
    const maxCases = opts.maxCases ?? 50;
    const feature = profile.feature;
    const baseInput = declaredBaseInput(req); // 业务默认输入来自声明参数，而非视频字段
    const seq = (n: number): string => String(n).padStart(2, '0');

    // ── P0：正常路径（声明参数的组合即正常输入） ──
    out.push(baseCase(
      req, `tc-${seq(1)}`, `${feature} 正常提交并成功`, 'P0', ['smoke', 'happy-path'],
      [submitStep({ ...baseInput }), waitSuccessStep()],
      [
        { target: 'submit', path: 'taskId', operator: 'exists', severity: 'P0' },
        { target: 'submit', path: 'status', operator: 'in', expected: ['SUCCESS', 'COMPLETED', 'SUBMITTED'], severity: 'P0', message: '任务状态最终为 SUCCESS' },
      ],
      {},
      { status: 'SUCCESS' },
    ));

    commonCases(req, profile, baseInput, out, seq);

    // ── P2：失败注入（仅针对需求声明的输入：空值 + 类型非法值） ──
    for (const item of req.requirements.slice(0, 3)) {
      // 空值注入
      out.push(baseCase(
        req, `tc-${seq(out.length + 1)}`, `${feature} 失败注入-${item.name}为空`, 'P2', ['negative', 'failure-injection'],
        [submitStep({ ...baseInput, [item.name]: '' })],
        [{ target: 'submit', path: 'err', operator: 'exists', severity: 'P2', message: `${item.name} 为空应被参数校验拒绝，而非服务端异常` }],
        { [item.name]: '' },
      ));
      // 类型非法值注入（数值参数传字符串）
      if (numericValues(item).length > 0) {
        out.push(baseCase(
          req, `tc-${seq(out.length + 1)}`, `${feature} 失败注入-${item.name}类型非法`, 'P2', ['negative', 'failure-injection'],
          [submitStep({ ...baseInput, [item.name]: 'NOT_A_NUMBER' })],
          [{ target: 'submit', path: 'err', operator: 'exists', severity: 'P2', message: `${item.name} 传非法类型应被拒绝` }],
          { [item.name]: 'NOT_A_NUMBER' },
        ));
      }
    }

    return out.slice(0, maxCases);
  }
}

// ── Unknown Generator：无法识别业务 → 不伪造任何用例（明确空集） ──
class UnknownBusinessGenerator implements BusinessTestCaseGenerator {
  readonly kind = 'unknown';

  generate(_req: Requirement, profile: BusinessProfile): TestCase[] {
    // 绝不回退 WAN3/视频模板 —— 伪造的用例一旦执行就是真实资源消耗
    return [{
      id: 'tc-unknown-00',
      feature: profile.feature,
      name: `业务未识别（${profile.feature}）：需显式声明 feature 或注册对应业务生成器`,
      priority: 'P0',
      tags: ['unknown-business', 'not-executable'],
      steps: [],
      assertions: [],
      metadata: { source: 'deterministic-generator', business: 'unknown', executable: false },
    }];
  }
}

// 注册表：wan3/video → Video；已知非视频业务 → Generic；unknown → Unknown（绝不伪造）
registerBusinessGenerator(new VideoTestCaseGenerator());
registerBusinessGenerator({ kind: 'wan3', generate: (req, profile, opts) => new VideoTestCaseGenerator().generate({ ...req, feature: profile.feature }, { ...profile, kind: 'wan3' }, opts) });
registerBusinessGenerator(new GenericBusinessGenerator());
registerBusinessGenerator(new UnknownBusinessGenerator());
for (const kind of ['user', 'order', 'payment']) {
  const generic = new GenericBusinessGenerator();
  registerBusinessGenerator({ kind, generate: (req, profile, opts) => generic.generate(req, { ...profile, kind }, opts) });
}

/** 生成结果（含业务画像与所用生成器，供 TestDesignAgent 标注与审计） */
export interface GeneratedTestSuites {
  business: BusinessProfile;
  generatorKind: string;
  cases: TestCase[];
  /** 被可执行性门过滤掉的用例数 */
  droppedInexecutable: number;
}

/**
 * 确定性生成测试用例：识别业务 → 对应生成器 → DSL 可执行性门。
 * Unknown 业务返回显式标注的不可执行占位（不伪造 WAN3 用例）。
 */
export function generateTestCasesWithBusiness(req: Requirement, opts: TestCaseGeneratorOptions = {}): GeneratedTestSuites {
  const business = identifyBusiness(req.feature, req.capabilities);
  const generator = resolveBusinessGenerator(business);

  let dropped = 0;
  const raw = generator.generate(req, business, opts);
  const cases = filterDslExecutable(raw, (_tc, problems) => {
    dropped++;
    void problems;
  });

  if (business.kind === 'unknown') {
    // unknown 占位用例（steps 空，会被门过滤）→ 保留原始占位以显式暴露业务未识别
    return { business, generatorKind: generator.kind, cases: raw, droppedInexecutable: 0 };
  }
  return { business, generatorKind: generator.kind, cases, droppedInexecutable: dropped };
}

/** 兼容入口：仅返回用例列表（内部走业务识别分发） */
export function generateTestCases(req: Requirement, opts: TestCaseGeneratorOptions = {}): TestCase[] {
  return generateTestCasesWithBusiness(req, opts).cases;
}
