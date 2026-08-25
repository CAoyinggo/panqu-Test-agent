/**
 * bin/run-devtest.ts — 需求驱动 · 开发者自助测试入口。
 *
 * 用法：
 *   npm run devtest -- --doc requirements/new-feature.md --base-url http://127.0.0.1:3000 --env test
 *
 * SAFE 默认：写路径挂起待确认；--confirm-mutations 显式放行；--dry-run 零 HTTP 调用。
 */

import { pathToFileURL } from 'node:url';

import { redactSensitiveText } from '../src/core/redact.js';
import { runDevTest } from '../src/devtest/index.js';

export const DEVTEST_HELP = `DevTest — 需求驱动 · 开发者自助测试

用法:
  npm run devtest -- --doc <需求文档.md> --base-url <http://127.0.0.1:3000> --env <local|test|integration>

参数:
  --doc <路径>               本地 Markdown 需求文档（与 --feishu 二选一）
  --feishu <链接>            飞书 wiki/docx 文档链接
  --feishu-credentials <路径> 飞书凭证 JSON（app_id/app_secret）；缺省读环境变量 FEISHU_APP_ID/FEISHU_APP_SECRET
  --base-url <origin>        被测服务纯 Origin（禁止 Path/Query/凭据）
  --env <名称>               local | test | integration（prod 被安全策略禁止）
  --project <名称>           项目标识（默认 devtest）
  --out <目录>               产物输出根目录（默认 output/devtest）
  --confirm-mutations        确认放行写路径（POST/PUT/PATCH/DELETE）真实执行
  --dry-run                  只生成用例与资产，不发起任何 HTTP 请求
  --max-cases <n>            可执行用例上限（默认沿用管线 500）
  --help                     显示本帮助

产物（写入 <out>/<runId>/）:
  report.html   固定七章节报告（结论/统计/明细/问题/未知项/RTM/证据）
  report.json   同构机读信封（含完整 acceptance 报告）
  cases.csv     五维用例清单（UTF-8 BOM）
  problems.md   四级问题清单（critical/major/minor/trivial）

示例:
  # SAFE 模式：只真实执行只读路径，写路径列入待确认
  npm run devtest -- --doc requirements/new-feature.md --base-url http://127.0.0.1:3000 --env local

  # DRY_RUN：只生成五维用例与报告，零 HTTP 调用
  npm run devtest -- --doc requirements/new-feature.md --base-url http://127.0.0.1:3000 --env test --dry-run
`;

interface ParsedArgs {
  doc?: string;
  feishu?: string;
  feishuCredentials?: string;
  baseUrl?: string;
  env?: string;
  project?: string;
  out?: string;
  confirmMutations: boolean;
  dryRun: boolean;
  maxCases?: number;
}

export function parseDevTestArgs(argv: readonly string[]): ParsedArgs {
  const args: ParsedArgs = { confirmMutations: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    switch (flag) {
      case '--doc': args.doc = value; i++; break;
      case '--feishu': args.feishu = value; i++; break;
      case '--feishu-credentials': args.feishuCredentials = value; i++; break;
      case '--base-url': args.baseUrl = value; i++; break;
      case '--env': args.env = value; i++; break;
      case '--project': args.project = value; i++; break;
      case '--out': args.out = value; i++; break;
      case '--max-cases': args.maxCases = Number(value); i++; break;
      case '--confirm-mutations': args.confirmMutations = true; break;
      case '--dry-run': args.dryRun = true; break;
      default: throw new Error(`DEVTEST_ARG_UNKNOWN：未知参数 ${flag}，使用 --help 查看帮助`);
    }
  }
  if (!args.doc && !args.feishu) throw new Error('DEVTEST_ARG_MISSING：必须提供 --doc 或 --feishu');
  if (!args.baseUrl) throw new Error('DEVTEST_ARG_MISSING：必须提供 --base-url');
  if (!args.env) throw new Error('DEVTEST_ARG_MISSING：必须提供 --env（local/test/integration）');
  return args;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(DEVTEST_HELP);
    return 0;
  }
  let args: ParsedArgs;
  try {
    args = parseDevTestArgs(argv);
  } catch (error) {
    console.error(`CONFIG_ERROR: ${redactSensitiveText((error as Error).message)}`);
    return 2;
  }
  try {
    const result = await runDevTest({
      docPath: args.doc,
      feishuUrl: args.feishu,
      feishuCredentialsPath: args.feishuCredentials,
      baseUrl: args.baseUrl!,
      environment: args.env!,
      project: args.project,
      outDir: args.out,
      confirmMutations: args.confirmMutations,
      dryRun: args.dryRun,
      maxCases: args.maxCases,
    });
    const { summary } = result.pipeline;
    console.log(`\n🧪 DevTest 完成：${result.runId}`);
    console.log(`   结论: ${result.conclusion}　设计 ${summary.designed}｜执行 ${summary.executed}｜PASS ${summary.passed}｜FAIL ${summary.failed}｜BLOCKED ${summary.blocked}｜未执行 ${summary.notExecuted}`);
    for (const stat of result.dimensionStats) {
      console.log(`   [${stat.dimension}] 共 ${stat.total}：PASS ${stat.passed} / FAIL ${stat.failed} / BLOCKED ${stat.blocked} / 未执行 ${stat.notExecuted}`);
    }
    const blocking = result.problems
      .filter((problem) => problem.severity === 'critical' || problem.severity === 'major');
    for (const problem of blocking.slice(0, 10)) {
      console.log(`   ⚠️ [${problem.severity}] ${problem.title}`);
    }
    if (result.pendingMutationCaseIds.length && !args.confirmMutations) {
      console.log(`   ⏸ 待确认写路径 ${result.pendingMutationCaseIds.length} 条：${result.pendingMutationCaseIds.join(', ')}`);
      console.log('      确认风险后加 --confirm-mutations 重跑放行。');
    }
    console.log(`   📄 产物目录: ${result.artifacts.dir}`);
    return result.conclusion === 'FAIL' ? 1 : 0;
  } catch (error) {
    console.error(`DEVTEST_ERROR: ${redactSensitiveText((error as Error).message)}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
