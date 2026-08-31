/**
 * CLI 参数解析与命令分发。
 *
 * 唯一命令：panqu-test-agent
 * 子命令：panqu-test-agent validate
 *
 * 本文件只做「参数解析 + 校验 + 分发」，不执行任何检查/模型/API 逻辑。
 * 执行流水线见 ./validate.mjs。
 */
import { resolve, isAbsolute } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

/** 允许的 check 名称（精确白名单，禁止自由格式 shell）。 */
export const ALLOWED_CHECKS = ['typecheck', 'lint', 'test', 'build'];

export const CLI_NAME = 'panqu-test-agent';

const USAGE = `panqu-test-agent —— 单命令本地代码验证 CLI

用法:
  ${CLI_NAME} --version
  ${CLI_NAME} --help
  ${CLI_NAME} validate [选项]

子命令:
  validate    对本地 Git 项目做隔离快照 + 确定性检查(typecheck/lint/test/build)
              + Trae 内置模型只读分析，并输出 Markdown + JSON 测试报告。

选项:
  --workspace <path>     被测项目绝对/相对路径（默认当前目录，必须是 Git 工作区）
  --checks <list>        逗号分隔的检查名，白名单: ${ALLOWED_CHECKS.join(',')}
  --report-dir <path>    报告输出目录（默认 ~/.panqu-test-agent/reports/<ws-hash>/<run-id>/）
  --timeout-ms <int>     每项检查超时（正整数，默认 120000）
  --api-origin <origin>  候选 API 黑盒测试 origin（http/https，且必须在允许列表内）
  --execute-api          显式请求 API 黑盒测试（默认关闭；即使开启，MVP 也只做 plan-only，不发起 HTTP）
  --dry-run              只做 preflight + 快照规划 + 脚本发现，不执行检查/模型/API
  --json                 额外把 report.json 打印到 stdout
  --help                 显示帮助
  --version              显示版本

示例:
  ${CLI_NAME} validate --workspace "$PWD" --checks typecheck,lint,test,build
  ${CLI_NAME} validate --workspace ./my-app --checks typecheck --timeout-ms 30000
`;

export function readVersion() {
  const pkgPath = resolve(__dirname, '..', 'package.json');
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export function parseArgs(argv) {
  const opts = {
    workspace: null,
    checks: null, // null = 未指定（默认全部：typecheck,lint,test,build）
    reportDir: null,
    timeoutMs: 120000,
    apiOrigin: null,
    executeApi: false,
    dryRun: false,
    json: false,
    help: false,
    version: false,
    command: null,
    unknown: [],
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') { opts.help = true; continue; }
    if (arg === '--version' || arg === '-v') { opts.version = true; continue; }
    if (arg === '--json') { opts.json = true; continue; }
    if (arg === '--execute-api') { opts.executeApi = true; continue; }
    if (arg === '--dry-run') { opts.dryRun = true; continue; }
    if (arg === 'validate') { opts.command = 'validate'; continue; }
    if (arg.startsWith('--workspace')) {
      const value = takeValue(argv, i, '--workspace');
      i = value.index;
      opts.workspace = value.value;
      continue;
    }
    if (arg.startsWith('--checks')) {
      const value = takeValue(argv, i, '--checks');
      i = value.index;
      opts.checks = value.value;
      continue;
    }
    if (arg.startsWith('--report-dir')) {
      const value = takeValue(argv, i, '--report-dir');
      i = value.index;
      opts.reportDir = value.value;
      continue;
    }
    if (arg.startsWith('--timeout-ms')) {
      const value = takeValue(argv, i, '--timeout-ms');
      i = value.index;
      opts.timeoutMs = value.value;
      continue;
    }
    if (arg.startsWith('--api-origin')) {
      const value = takeValue(argv, i, '--api-origin');
      i = value.index;
      opts.apiOrigin = value.value;
      continue;
    }
    opts.unknown.push(arg);
  }

  if (opts.command === null && !opts.help && !opts.version) {
    opts.command = 'validate'; // 默认子命令
  }
  return opts;
}

function takeValue(argv, index, flag) {
  const current = argv[index];
  if (current.includes('=')) {
    return { value: current.slice(current.indexOf('=') + 1), index };
  }
  const next = argv[index + 1];
  if (next === undefined) {
    return { value: '', index };
  }
  return { value: next, index: index + 1 };
}

/**
 * 解析 --checks 字符串为数组。返回 { ok, checks, errors }。
 * 未知 check / 空值 / 非法字符一律拒绝（fail closed）。
 */
export function parseChecks(raw) {
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: true, checks: ALLOWED_CHECKS.slice() };
  const tokens = raw.split(',').map((t) => t.trim()).filter((t) => t.length > 0);
  const errors = [];
  for (const token of tokens) {
    // 只允许白名单精确名；含 shell 元字符/空白/路径分隔符一律拒绝。
    if (!ALLOWED_CHECKS.includes(token)) {
      errors.push(`未知 check: "${token}"（允许: ${ALLOWED_CHECKS.join(',')}）`);
    }
  }
  if (errors.length > 0) return { ok: false, checks: [], errors };
  return { ok: true, checks: tokens };
}

/** 解析 --timeout-ms。正整数校验。 */
export function parseTimeout(raw) {
  if (typeof raw === 'number') return { ok: Number.isInteger(raw) && raw > 0, value: raw, error: 'timeout-ms 必须为正整数' };
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { ok: false, value: 0, error: '--timeout-ms 必须为正整数' };
  return { ok: true, value: n };
}

/** 解析并校验 --workspace。 */
export function parseWorkspace(raw, cwd = process.cwd()) {
  if (raw === null || raw === undefined || raw.trim() === '') {
    return { ok: true, path: resolve(cwd) };
  }
  const p = raw.trim();
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  if (!existsSync(abs)) return { ok: false, path: abs, error: `workspace 不存在: ${abs}` };
  return { ok: true, path: abs };
}

/** 解析 --report-dir。缺省返回 null（由调用方落到 ~/.panqu-test-agent/...）。 */
export function parseReportDir(raw) {
  if (raw === null || raw === undefined || raw.trim() === '') return null;
  return resolve(process.cwd(), raw.trim());
}

export function parseApiOrigin(raw) {
  if (raw === null || raw === undefined || raw.trim() === '') return { ok: true, value: null };
  const value = raw.trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, value, error: '--api-origin 不是合法 URL' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, value, error: '--api-origin 必须是 http/https origin' };
  }
  if (url.username || url.password) {
    return { ok: false, value, error: '--api-origin 不得内联用户名/密码' };
  }
  if (url.search || url.hash || url.pathname !== '/' && url.pathname !== '') {
    return { ok: false, value, error: '--api-origin 必须是 origin（协议+host[:port]），不含路径/查询/片段' };
  }
  return { ok: true, value: `${url.protocol}//${url.host}` };
}

export async function main(argv) {
  const opts = parseArgs(argv);

  if (opts.version) {
    process.stdout.write(`${CLI_NAME} ${readVersion()}\n`);
    return 0;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (opts.unknown.length > 0) {
    process.stderr.write(`[${CLI_NAME}] 未知参数: ${opts.unknown.join(' ')}\n`);
    process.stderr.write('用 --help 查看用法。\n');
    return 2;
  }
  if (opts.command !== 'validate') {
    process.stderr.write(`[${CLI_NAME}] 未知子命令: ${opts.command}\n`);
    return 2;
  }

  const { runValidate } = await import('./validate.mjs');
  return runValidate(opts);
}
