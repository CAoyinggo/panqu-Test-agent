// Requirement-driven deterministic fallback for the existing TestCase DSL.
// It deliberately has one generic registry entry: business names remain data and
// never select a feature, product, endpoint, field, account or fixed flow template.

import type { Requirement, RequirementItem } from '../requirement/requirement-schema.js';
import type { AssertionDefinition, TestCase, TestPriority, TestStep } from './testcase-schema.js';
import { filterDslExecutable } from './testcase-schema.js';
import {
  identifyBusiness,
  registerBusinessGenerator,
  resolveBusinessGenerator,
  type BusinessProfile,
  type BusinessTestCaseGenerator,
} from './business.js';

export interface TestCaseGeneratorOptions {
  maxCases?: number;
}

type Dimension =
  | 'functional'
  | 'parameter-validation'
  | 'boundary'
  | 'permission'
  | 'data-isolation'
  | 'state-transition'
  | 'data-consistency'
  | 'idempotency'
  | 'concurrency'
  | 'side-effect'
  | 'failure-recovery';

function baseCase(
  req: Requirement,
  id: string,
  name: string,
  priority: TestPriority,
  tags: string[],
  input: Record<string, unknown>,
  assertion: AssertionDefinition,
  data: Record<string, unknown> = {},
): TestCase {
  const step: TestStep = { action: 'submit', input };
  return {
    id,
    feature: req.feature,
    name,
    priority,
    tags: ['agent-generated', ...tags],
    data,
    steps: [step],
    assertions: [assertion],
    metadata: {
      source: 'deterministic-generator',
      confidence: req.confidence ?? 0.8,
      standard: 'requirement-driven-generic',
    },
  };
}

function resultExists(message: string, severity: 'P0' | 'P1' | 'P2' = 'P1'): AssertionDefinition {
  return { target: 'response', path: 'result', operator: 'exists', severity, message };
}

function declaredInput(req: Requirement): Record<string, unknown> {
  return Object.fromEntries(req.requirements.flatMap((item) =>
    item.values.length > 0 ? [[item.name, item.values[0]]] : []));
}

function numericValues(item: RequirementItem): number[] {
  return item.values.map(Number).filter(Number.isFinite);
}

function selectDimensions(req: Requirement): Set<Dimension> {
  const text = [
    req.goal,
    ...req.capabilities,
    ...req.businessRules,
    ...req.dependencies,
    ...(req.constraints ?? []),
    ...(req.risks ?? []),
  ].filter(Boolean).join(' ');
  const dimensions = new Set<Dimension>(['functional']);
  if (req.requirements.length > 0 || req.inputs.length > 0) dimensions.add('parameter-validation');
  if (req.requirements.some((item) => numericValues(item).length > 0)) dimensions.add('boundary');
  if (/权限|角色|授权|permission|role/i.test(text)) dimensions.add('permission');
  if (/租户|隔离|tenant|isolation/i.test(text)) dimensions.add('data-isolation');
  if (/状态|流转|transition|state/i.test(text)) dimensions.add('state-transition');
  if (/一致|consisten/i.test(text)) dimensions.add('data-consistency');
  if (/幂等|重复|idempoten/i.test(text)) dimensions.add('idempotency');
  if (/并发|concurren/i.test(text)) dimensions.add('concurrency');
  if (/副作用|消息|通知|审计|side.?effect/i.test(text)) dimensions.add('side-effect');
  if (/恢复|回滚|重试|recover|rollback|retry/i.test(text)) dimensions.add('failure-recovery');
  return dimensions;
}

function dimensionPriority(dimension: Dimension): TestPriority {
  if (['functional', 'permission', 'data-isolation', 'state-transition'].includes(dimension)) return 'P0';
  if (['parameter-validation', 'boundary', 'data-consistency', 'idempotency', 'side-effect'].includes(dimension)) return 'P1';
  return 'P2';
}

class GenericBusinessGenerator implements BusinessTestCaseGenerator {
  readonly kind = 'generic';

  generate(req: Requirement, profile: BusinessProfile, opts: TestCaseGeneratorOptions = {}): TestCase[] {
    const maxCases = Math.max(0, opts.maxCases ?? 50);
    const baseInput = declaredInput(req);
    const dimensions = selectDimensions(req);
    const out: TestCase[] = [];
    const add = (
      label: string,
      dimension: Dimension,
      input: Record<string, unknown>,
      message: string,
      data: Record<string, unknown> = {},
    ): void => {
      const id = `tc-${String(out.length + 1).padStart(2, '0')}`;
      out.push(baseCase(
        req,
        id,
        `${profile.feature} ${label}`,
        dimensionPriority(dimension),
        [dimension],
        input,
        resultExists(message, dimensionPriority(dimension) === 'P0' ? 'P0' : 'P1'),
        data,
      ));
    };

    add('需求声明的业务结果', 'functional', baseInput, req.goal || '返回 Requirement 声明的业务结果');

    for (const rule of req.businessRules) {
      add(`业务规则-${rule}`, 'functional', baseInput, `验证 Requirement 业务规则：${rule}`, { businessRule: rule });
    }

    if (dimensions.has('parameter-validation')) {
      for (const item of req.requirements) {
        for (const value of item.values.slice(0, 4)) {
          add(
            `声明输入-${item.name}`,
            'parameter-validation',
            { ...baseInput, [item.name]: value },
            `输入 ${item.name} 的声明取值应产生需求定义的结果`,
          );
        }
        add(
          `无效输入-${item.name}`,
          'parameter-validation',
          { ...baseInput, [item.name]: '' },
          `输入 ${item.name} 不满足 Requirement 时应按需求拒绝`,
          { negative: true },
        );
        out[out.length - 1].tags.push('negative');
      }
    }

    if (dimensions.has('boundary')) {
      for (const item of req.requirements) {
        const numbers = numericValues(item);
        if (numbers.length === 0) continue;
        for (const value of new Set([Math.min(...numbers), Math.max(...numbers)])) {
          add(
            `边界-${item.name}`,
            'boundary',
            { ...baseInput, [item.name]: value },
            `输入 ${item.name} 的 Requirement 边界值应产生确定结果`,
          );
        }
      }
    }

    for (const dimension of dimensions) {
      if (['functional', 'parameter-validation', 'boundary'].includes(dimension)) continue;
      add(
        `能力-${dimension}`,
        dimension,
        baseInput,
        `按 Requirement 验证 ${dimension} 能力`,
        { selectedDimension: dimension },
      );
    }

    for (const dependency of req.dependencies) {
      add(
        `依赖-${dependency}`,
        'failure-recovery',
        baseInput,
        `依赖 ${dependency} 异常时应符合 Requirement 定义的恢复结果`,
        { dependency },
      );
      out[out.length - 1].tags.push('dependency');
    }

    return out.slice(0, maxCases);
  }
}

class UnknownBusinessGenerator implements BusinessTestCaseGenerator {
  readonly kind = 'unknown';

  generate(_req: Requirement, profile: BusinessProfile): TestCase[] {
    return [{
      id: 'tc-unknown-00',
      feature: profile.feature,
      name: `业务域未声明（${profile.feature}）`,
      priority: 'P0',
      tags: ['unknown-business', 'not-executable'],
      steps: [],
      assertions: [],
      metadata: { source: 'deterministic-generator', business: 'unknown', executable: false },
    }];
  }
}

registerBusinessGenerator(new GenericBusinessGenerator());
registerBusinessGenerator(new UnknownBusinessGenerator());

export interface GeneratedTestSuites {
  business: BusinessProfile;
  generatorKind: string;
  cases: TestCase[];
  droppedInexecutable: number;
}

export function generateTestCasesWithBusiness(
  req: Requirement,
  opts: TestCaseGeneratorOptions = {},
): GeneratedTestSuites {
  const business = identifyBusiness(req.feature, req.capabilities);
  const generator = resolveBusinessGenerator(business);
  const raw = generator.generate(req, business, opts);
  if (business.kind === 'unknown') {
    return { business, generatorKind: generator.kind, cases: raw, droppedInexecutable: 0 };
  }
  let dropped = 0;
  const cases = filterDslExecutable(raw, () => { dropped += 1; });
  return { business, generatorKind: generator.kind, cases, droppedInexecutable: dropped };
}

export function generateTestCases(req: Requirement, opts: TestCaseGeneratorOptions = {}): TestCase[] {
  return generateTestCasesWithBusiness(req, opts).cases;
}
