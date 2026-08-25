import { parseArgs as parseNodeArgs } from 'node:util';
import type { BudgetLimits } from '../agents/observability/budget.js';
import type { LLMCliOverrides } from '../config/llm.js';

export interface AgentCliArgs {
  requirement: string;
  env?: string;
  skipExecution: boolean;
  json: boolean;
  memoryPath?: string;
  help: boolean;
  useSelection: boolean;
  autoApprove: boolean;
  executionApprovalId?: string;
  noSelection: boolean;
  noCoverage: boolean;
  noRca: boolean;
  noDefect: boolean;
  noHealing: boolean;
  noApproval: boolean;
  noTrace: boolean;
  maxRca?: number;
  maxDefects?: number;
  budget: BudgetLimits;
  llm: LLMCliOverrides;
  requirementFile?: string;
  planOnly: boolean;
  analyzeFile?: string;
  rca: boolean;
  resumeId?: string;
  taskDir?: string;
  ci: boolean;
  ciStatusFile?: string;
}

export class AgentCliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentCliArgumentError';
  }
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  'skip-execution': { type: 'boolean' },
  json: { type: 'boolean' },
  'plan-only': { type: 'boolean' },
  rca: { type: 'boolean' },
  ci: { type: 'boolean' },
  'use-selection': { type: 'boolean' },
  'auto-approve': { type: 'boolean' },
  'no-selection': { type: 'boolean' },
  'no-coverage': { type: 'boolean' },
  'no-rca': { type: 'boolean' },
  'no-defect': { type: 'boolean' },
  'no-healing': { type: 'boolean' },
  'no-approval': { type: 'boolean' },
  'no-trace': { type: 'boolean' },
  requirement: { type: 'string' },
  analyze: { type: 'string' },
  resume: { type: 'string' },
  'task-dir': { type: 'string' },
  'llm-provider': { type: 'string' },
  model: { type: 'string' },
  'fallback-model': { type: 'string' },
  'llm-timeout': { type: 'string' },
  'max-tokens': { type: 'string' },
  env: { type: 'string' },
  memory: { type: 'string' },
  'ci-status': { type: 'string' },
  'execution-approval': { type: 'string' },
  'max-rca': { type: 'string' },
  'max-defects': { type: 'string' },
  'budget-tokens': { type: 'string' },
  'budget-llm': { type: 'string' },
  'budget-agents': { type: 'string' },
  'budget-tools': { type: 'string' },
  'budget-cases': { type: 'string' },
  'budget-concurrency': { type: 'string' },
  'budget-duration': { type: 'string' },
} as const;

type OptionName = keyof typeof OPTIONS;
type ParsedValues = Partial<Record<OptionName, string | boolean>>;

/**
 * run-agent 的严格参数解析器。node:util.parseArgs 原生支持 `--key value` 与
 * `--key=value`；本层补充重复参数拒绝、空值拒绝及正整数校验。
 */
export function parseAgentCliArgs(argv: string[]): AgentCliArgs {
  const parsed = parseStandardArgs(argv);

  const seen = new Map<string, string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option') continue;
    const previous = seen.get(token.name);
    if (previous) {
      throw new AgentCliArgumentError(`参数重复：${previous} 与 ${token.rawName}`);
    }
    seen.set(token.name, token.rawName);
  }

  const values = parsed.values as ParsedValues;
  const stringValue = (name: OptionName): string | undefined => {
    const raw = values[name];
    if (raw === undefined) return undefined;
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new AgentCliArgumentError(`参数 --${name} 缺少有效值`);
    }
    return raw.trim();
  };
  const flag = (name: OptionName): boolean => values[name] === true;
  const positiveInteger = (name: OptionName): number | undefined => {
    const raw = stringValue(name);
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new AgentCliArgumentError(`参数 --${name} 必须是正整数，当前值：${raw}`);
    }
    return value;
  };

  const budget: BudgetLimits = {};
  const budgetOptions: Array<[OptionName, keyof BudgetLimits]> = [
    ['budget-tokens', 'maxTokens'],
    ['budget-llm', 'maxLLMCalls'],
    ['budget-agents', 'maxAgentCalls'],
    ['budget-tools', 'maxToolCalls'],
    ['budget-cases', 'maxCases'],
    ['budget-concurrency', 'maxConcurrency'],
    ['budget-duration', 'maxDurationMs'],
  ];
  for (const [option, key] of budgetOptions) {
    const value = positiveInteger(option);
    if (value !== undefined) budget[key] = value;
  }

  return {
    requirement: parsed.positionals.join(' ').trim(),
    env: stringValue('env'),
    skipExecution: flag('skip-execution'),
    json: flag('json'),
    memoryPath: stringValue('memory'),
    help: flag('help'),
    useSelection: flag('use-selection'),
    autoApprove: flag('auto-approve'),
    executionApprovalId: stringValue('execution-approval'),
    noSelection: flag('no-selection'),
    noCoverage: flag('no-coverage'),
    noRca: flag('no-rca'),
    noDefect: flag('no-defect'),
    noHealing: flag('no-healing'),
    noApproval: flag('no-approval'),
    noTrace: flag('no-trace'),
    maxRca: positiveInteger('max-rca'),
    maxDefects: positiveInteger('max-defects'),
    budget,
    llm: {
      provider: stringValue('llm-provider'),
      model: stringValue('model'),
      fallbackModel: stringValue('fallback-model'),
      timeoutMs: positiveInteger('llm-timeout'),
      maxTokens: positiveInteger('max-tokens'),
    },
    requirementFile: stringValue('requirement'),
    planOnly: flag('plan-only'),
    analyzeFile: stringValue('analyze'),
    rca: flag('rca'),
    resumeId: stringValue('resume'),
    taskDir: stringValue('task-dir'),
    ci: flag('ci'),
    ciStatusFile: stringValue('ci-status'),
  };
}

function parseStandardArgs(argv: string[]) {
  try {
    return parseNodeArgs({
      args: argv,
      options: OPTIONS,
      allowPositionals: true,
      strict: true,
      tokens: true,
    } as const);
  } catch (error) {
    throw normalizeParseError(error);
  }
}

function normalizeParseError(error: unknown): AgentCliArgumentError {
  const e = error as Error & { code?: string };
  if (e.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION') {
    const option = /Unknown option '([^']+)'/.exec(e.message)?.[1] ?? '未知选项';
    return new AgentCliArgumentError(`未知参数：${option}`);
  }
  if (e.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE') {
    const option = /Option '([^']+)'/.exec(e.message)?.[1] ?? '参数';
    return new AgentCliArgumentError(`参数缺少值：${option}`);
  }
  return new AgentCliArgumentError(`参数解析失败：${e.message}`);
}
