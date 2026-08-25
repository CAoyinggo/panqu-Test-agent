import { parseArgs as parseNodeArgs } from 'node:util';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { runDeveloperSelfTest } from './self-test-runner.js';
import type { DeveloperSelfTestInput, SelfTestExecutionMode } from './types.js';

export class SelfTestCliError extends Error {
  constructor(message: string) { super(message); this.name = 'SelfTestCliError'; }
}

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  requirement: { type: 'string' },
  changed: { type: 'string' },
  'changed-files': { type: 'string' },
  env: { type: 'string' },
  mode: { type: 'string' },
  module: { type: 'string' },
  branch: { type: 'string' },
  entrypoint: { type: 'string', multiple: true },
  'base-url': { type: 'string' },
  approval: { type: 'string' },
  budget: { type: 'string' },
  currency: { type: 'string' },
  output: { type: 'string' },
} as const;

export interface SelfTestCliArgs {
  help: boolean;
  input: DeveloperSelfTestInput;
  mode: SelfTestExecutionMode;
  baseUrl?: string;
  approvalId?: string;
  output?: string;
}

export const SELF_TEST_HELP = `Developer Self-Test

用法：
  npm run self-test -- --requirement requirements/new-feature.md --changed HEAD~1..HEAD --env test
  npm run self-test -- --changed HEAD~1..HEAD --env test

参数：
  --requirement     需求文档路径
  --changed         Git diff 范围（传给 git diff --name-only）
  --changed-files   显式变更文件，逗号分隔
  --env             目标环境（必填）
  --mode            dry-run / safe / live，默认 safe
  --module          模块/Contract subject，例如 wan3
  --entrypoint      显式只读入口，可重复
  --base-url        SAFE/LIVE HTTP 执行基址
  --approval        LIVE 人工审批 ID
  --budget          LIVE 最大成本
  --currency        成本币种
  --output          JSON 报告文件

安全边界：SAFE 为默认；LIVE 同时要求 --approval、--budget、Cleanup/Rollback 和完整 Evidence。`;

export function parseSelfTestCliArgs(argv: string[]): SelfTestCliArgs {
  let parsed;
  try { parsed = parseNodeArgs({ args: argv, options: OPTIONS, strict: true, allowPositionals: false, tokens: true }); }
  catch (error) { throw new SelfTestCliError(`参数解析失败：${(error as Error).message}`); }
  const seen = new Set<string>();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option' || token.name === 'entrypoint') continue;
    if (seen.has(token.name)) throw new SelfTestCliError(`参数重复：--${token.name}`);
    seen.add(token.name);
  }
  const string = (name: keyof typeof OPTIONS): string | undefined => {
    const value = parsed.values[name];
    if (value === undefined) return undefined;
    if (Array.isArray(value)) throw new SelfTestCliError(`参数 --${name} 格式无效`);
    if (typeof value !== 'string' || !value.trim()) throw new SelfTestCliError(`参数 --${name} 缺少有效值`);
    return value.trim();
  };
  const help = parsed.values.help === true;
  const environment = string('env');
  if (!help && !environment) throw new SelfTestCliError('参数 --env 必填');
  const rawMode = string('mode') ?? 'safe';
  if (!['dry-run', 'safe', 'live'].includes(rawMode)) throw new SelfTestCliError('--mode 仅支持 dry-run / safe / live');
  const mode = rawMode.replace('-', '_').toUpperCase() as SelfTestExecutionMode;
  const requirementPath = string('requirement');
  const commit = string('changed');
  const files = string('changed-files')?.split(',').map((item) => item.trim()).filter(Boolean);
  const entrypoints = (parsed.values.entrypoint ?? []) as string[];
  if (!help && !requirementPath && !commit && !files?.length && !entrypoints.length) {
    throw new SelfTestCliError('必须提供 --requirement、--changed、--changed-files 或 --entrypoint');
  }
  const budgetValue = string('budget');
  if (budgetValue && (!Number.isFinite(Number(budgetValue)) || Number(budgetValue) < 0)) throw new SelfTestCliError('--budget 必须是非负数字');
  const approvalId = string('approval');
  if (mode === 'LIVE' && (!approvalId || budgetValue === undefined)) throw new SelfTestCliError('LIVE 必须同时提供 --approval 和 --budget');
  return {
    help, mode, baseUrl: string('base-url'), approvalId, output: string('output'),
    input: {
      requirement: requirementPath ? { ref: path.resolve(requirementPath) } : undefined,
      changedFiles: files, commit, branch: string('branch'), module: string('module'),
      environment: environment ?? 'test', entrypoints,
      budget: budgetValue === undefined ? undefined : { maxCost: Number(budgetValue), currency: string('currency') },
    },
  };
}

export async function runSelfTestCli(argv: string[]): Promise<{ exitCode: number; report?: Awaited<ReturnType<typeof runDeveloperSelfTest>> }> {
  const args = parseSelfTestCliArgs(argv);
  if (args.help) return { exitCode: 0 };
  if (args.input.requirement?.ref) {
    try { args.input.requirement.text = await readFile(args.input.requirement.ref, 'utf8'); }
    catch (error) { throw new SelfTestCliError(`无法读取需求文档：${(error as Error).message}`); }
    args.input.requirement.id = path.basename(args.input.requirement.ref, path.extname(args.input.requirement.ref));
  }
  const report = await runDeveloperSelfTest(args.input, {
    mode: args.mode, baseUrl: args.baseUrl,
    approval: args.approvalId ? {
      id: args.approvalId, status: 'APPROVED', approvedBy: 'developer-self-test-cli', approvedAt: new Date().toISOString(),
    } : undefined,
  });
  if (args.output) {
    const target = path.resolve(args.output);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
  return { exitCode: report.result === 'FAILED' || report.result === 'BLOCKED' ? 1 : 0, report };
}
