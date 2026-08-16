// 核心引擎：加载配置/会话/任务 → 匹配场景处理器 → 执行 pipeline → 生成报告
// 支持：退出码规范、CI 模式、整体超时、环境变量注入、trace-id、metrics、JSON 日志
// 并发：--parallel/--concurrency，按 feature 分组串行 + 组间并行
import path from 'node:path';
import os from 'node:os';
import pLimit from 'p-limit';
import type { AppConfig, TaskDef, ReportData } from './types.js';
import { HookRegistry } from './hooks.js';
import type { SceneHandler } from './scene-handler.js';
import { Pipeline, PipelineResult } from './pipeline.js';
import { Http } from '../integrations/http.js';
import { loadConfig, parseArgs, CliArgs } from '../config/config.js';
import { getReporters } from '../reports/factory.js';
import { outputDir, caseOutputDir, logsDir, debugDir, writeJson } from '../utils/fs-utils.js';
import { logger, setCiMode, setLogLevel, setLogFile, setLogContext, setCaseId } from '../utils/logger.js';
import { loadCases, LoadedCase } from '../cases/loader.js';
import { filterCases } from '../cases/filter.js';
import { ResultTracker, EXIT_CODE, type ExecutionSummary } from '../utils/exit-code.js';
import { getEnvFromEnv, applyEnvToConfig, applyEnvSessionOverrides, getNotifierConfig } from '../config/env.js';
import { generateTraceId, getTraceId } from '../utils/trace.js';
import { metrics } from '../utils/metrics.js';
import { autoLoadScenes } from '../plugins/loader.js';
import { FeishuNotifier } from '../integrations/notifiers/feishu.js';

// 场景处理器注册表（自动扫描加载，无需手动 import）
export const SCENES: Record<string, SceneHandler> = {};

export function registerScene(name: string, handler: SceneHandler): void {
  SCENES[name] = handler;
}

export function findHandler(scene: string): SceneHandler | null {
  for (const h of Object.values(SCENES)) {
    if (h.match(scene)) return h;
  }
  return null;
}

export interface EngineOptions {
  hooks?: HookRegistry;
}

/** 单任务执行结果 */
interface RunTaskResult {
  files: string[];
  passRate: number;
  hasBlockingIssue: boolean;
}

export class Engine {
  private hooks: HookRegistry;

  constructor(opts: EngineOptions = {}) {
    this.hooks = opts.hooks || new HookRegistry();
  }

  /** 加载任务定义（文件或目录，支持 JSON / TS 编译产物） */
  private async loadTask(taskArg: string): Promise<LoadedCase[]> {
    const cases = await loadCases(path.resolve(process.cwd(), taskArg));
    if (!cases.length) throw new Error(`未加载到任何任务定义：${taskArg}`);
    return cases;
  }

  /** 运行单个任务，返回报告文件路径列表与执行结果 */
  async runTask(cfg: AppConfig, taskDef: TaskDef, env: string, func?: string, reporter?: string | null, debug?: boolean, caseId?: string): Promise<RunTaskResult> {
    const handler = findHandler(taskDef.scene);
    const session = applyEnvSessionOverrides(Http.loadSession(cfg.session_cookies_path, env));
    session.env = env;

    // 设置日志上下文（并发模式下 caseId 前缀隔离）
    setLogContext({ task: taskDef.name, scene: taskDef.scene, trace: getTraceId() });
    if (caseId) {
      setCaseId(caseId);
    } else {
      setCaseId('');
      // 串行模式：每条用例独立日志文件（原始行为）
      const logFile = path.join(logsDir(func), 'run.log');
      setLogFile(logFile);
    }

    // debug 目录（仅 --debug 模式使用）
    const dbgDir = debug ? debugDir(func) : undefined;

    const pipeline = new Pipeline({ cfg, session, taskDef, handler, func, debugDir: dbgDir }, this.hooks);
    const result: PipelineResult = await pipeline.run();

    const hasBlockingIssue = result.issues.some((i) => i.level === '阻塞');

    // 设置 metrics 通过率
    metrics.setPassRate(result.passRate);

    // 组装报告数据
    const reportData: ReportData = {
      title: taskDef.name + ' 测试报告',
      env,
      taskDef: { ...taskDef, project_id: session.project_id, account: session.account || session.nickname },
      submit: result.submit,
      billingData: result.billingData,
      impact: result.impact,
      checks: result.checks,
      responses: result.responses,
      manual: result.manual,
      issues: result.issues,
      passRate: result.passRate,
      assetInfo: result.assetInfo,
      traceId: getTraceId(),
      metrics: metrics.toJSON(),
    };

    // 报告写入：并发模式用 caseId 子目录，串行模式用平铺目录
    const dir = caseId ? caseOutputDir(func, caseId) : outputDir(func);
    const reporters = getReporters(reporter);
    const files: string[] = [];
    for (const r of reporters) {
      files.push(...r.write(dir, taskDef.name, reportData));
    }
    return { files, passRate: result.passRate, hasBlockingIssue };
  }

  /**
   * 执行单个用例的完整链路（含超时检查、日志隔离、报告生成）。
   * 并发模式下由 p-limit 调度调用，串行模式下直接调用。
   */
  private async runOneCase(
    c: LoadedCase,
    cfg: AppConfig,
    env: string,
    args: CliArgs,
    tracker: ResultTracker,
    startTime: number,
    timeoutMs: number,
    concurrency: number,
  ): Promise<void> {
    // 超时检查
    if (Date.now() - startTime > timeoutMs) {
      logger.warn(`执行超时（${args.timeout ?? 600}s），用例 ${c.name} 标记为超时中断`);
      tracker.addTimeout(c.name, c.feature);
      return;
    }

    // 生成 caseId（并发模式下用于日志前缀和报告隔离）
    const concurrencyOn = concurrency > 1;
    const caseId = concurrencyOn
      ? `${c.feature || 'default'}-${Date.now()}-${c.name.replace(/[\s\\/:*?"<>|]/g, '_').slice(0, 30)}`
      : '';

    const tag = c.feature ? `[${c.feature}]` : '';
    logger.step(`---- ${tag}加载用例：${c.name}（${path.basename(c.file)}） ----`);

    try {
      const func = args.func || c.feature || undefined;
      const { files, passRate, hasBlockingIssue } = await this.runTask(
        cfg, c.def, env, func, args.reporter, args.debug, caseId || undefined,
      );
      tracker.addResult({
        name: c.name,
        feature: c.feature,
        pass: passRate === 100 && !hasBlockingIssue,
        pending: false,
        passRate,
      });
      tracker.reports.push(...files);
    } catch (e: any) {
      logger.error(`用例执行失败：${c.name} - ${e.message}`);
      tracker.addResult({ name: c.name, feature: c.feature, pass: false, pending: false, passRate: 0 });
    }

    // 清除 caseId 前缀（避免影响后续用例日志）
    if (concurrencyOn) setCaseId('');
  }

  /** CLI 主入口：解析参数 → 加载配置/任务 → 执行 → 返回退出码 */
  async main(argv: string[]): Promise<number> {
    const args: CliArgs = parseArgs(argv);

    if (args.help) {
      console.log(`用法：
  node dist/bin/run-test.js --task <任务定义> [--env=test|preonline] [--func=<功能名>] [--reporter=html,json,junit] [选项]

参数：
  --task      任务定义路径（必填）。支持：
              · 功能子目录：src/cases/wan3（执行该功能全部用例）
              · 根目录：src/cases（递归全量执行所有功能模块）
              · 单个文件：tasks/xxx.json 或 src/cases/wan3/xxx.ts（向后兼容）
  --env       执行环境，默认 test，可选 preonline（或 TESTFLOW_ENV 环境变量）
  --func      功能名称（归档目录 output/<日期>/<功能名>/，强制约定）
  --reporter  报告格式，默认 html，可选 html,json,junit（逗号分隔多份）

选项：
  --ci        CI 模式：关闭彩色输出、抑制分隔线、末尾打印摘要、严格退出码
  --timeout   整体执行超时（秒），默认 600。超时后未完成用例标记「超时中断」，退出码 3
  --debug     调试模式：日志降到 debug 级别，中间产物落盘到 debug/ 目录
  --grep      按标签筛选用例（如 P0），支持与 --filter/--scene 组合（AND）
  --filter    按名称子串筛选用例
  --scene     按场景类型筛选用例
  --concurrency <N>  并发数（默认 1 = 串行）。同一 feature 内用例串行，不同 feature 间并行
  --parallel         自动并发，并发数取 CPU 核心数（上限 4）。优先于 --concurrency
  --help      显示帮助

退出码：
  0 = 全部通过  1 = 有用例失败  2 = 配置/环境错误  3 = 超时中断`);
      return EXIT_CODE.SUCCESS;
    }

    if (!args.task) {
      logger.error('缺少 --task 参数（任务定义路径）');
      return EXIT_CODE.CONFIG_ERROR;
    }

    // CI 模式：关闭彩色 + 抑制分隔线
    if (args.ci) setCiMode(true);
    // Debug 模式：日志降到 debug 级别
    if (args.debug) setLogLevel('debug');

    // 生成 trace-id，初始化 metrics
    const traceId = generateTraceId();
    metrics.reset();
    metrics.start();
    logger.info(`Trace ID: ${traceId}`);

    // 环境优先级：CLI --env > TESTFLOW_ENV > 配置 default_env
    const envName = args.env || getEnvFromEnv() || undefined;

    let cfg: AppConfig;
    try {
      cfg = loadConfig(envName);
      cfg = applyEnvToConfig(cfg, envName || cfg.default_env);
    } catch (e: any) {
      logger.error(`配置加载失败：${e.message}`);
      return EXIT_CODE.CONFIG_ERROR;
    }

    let cases: LoadedCase[];
    try {
      cases = await this.loadTask(args.task!);
    } catch (e: any) {
      logger.error(`用例加载失败：${e.message}`);
      return EXIT_CODE.CONFIG_ERROR;
    }

    // 用例筛选（--grep/--filter/--scene，AND 组合）
    cases = filterCases(cases, { grep: args.grep, filter: args.filter, scene: args.scene });
    if (cases.length === 0) {
      logger.error('筛选后无匹配用例，退出（不空跑）');
      return EXIT_CODE.CONFIG_ERROR;
    }

    const env = envName || cfg.default_env;
    const tracker = new ResultTracker();
    const startTime = Date.now();
    const timeoutMs = (args.timeout ?? 600) * 1000;

    // 计算并发数：--parallel 优先于 --concurrency
    const concurrency = args.parallel
      ? Math.min(4, os.cpus().length)
      : (args.concurrency ?? 1);

    if (concurrency > 1) {
      logger.info(`并发模式：concurrency=${concurrency}（同一 feature 串行，不同 feature 并行）`);
      // 并发模式：设置共享日志文件
      const logFunc = args.func || cases[0]?.feature;
      if (logFunc) {
        setLogFile(path.join(logsDir(logFunc), 'run.log'));
      }
    }

    // 自动扫描加载场景处理器
    const loadedScenes = await autoLoadScenes();
    Object.assign(SCENES, loadedScenes);
    if (Object.keys(SCENES).length === 0) {
      logger.warn('未加载到任何场景处理器，所有任务将以半自动模式执行');
    }

    if (concurrency === 1) {
      // ── 串行模式（向后兼容，行为与改造前完全一致） ──
      for (const c of cases) {
        await this.runOneCase(c, cfg, env, args, tracker, startTime, timeoutMs, concurrency);
      }
    } else {
      // ── 并发模式：按 feature 分组，组内串行 + 组间并行 ──
      const groups = new Map<string, LoadedCase[]>();
      for (const c of cases) {
        const key = c.feature || 'default';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key)!.push(c);
      }

      logger.info(`用例分组：${groups.size} 个 feature 组（${Array.from(groups.keys()).join(', ')}）`);

      const limit = pLimit(concurrency);
      const groupTasks = Array.from(groups.entries()).map(([feature, groupCases]) =>
        limit(async () => {
          logger.info(`▶ 开始执行 feature=${feature}（${groupCases.length} 个用例，串行）`);
          for (const c of groupCases) {
            await this.runOneCase(c, cfg, env, args, tracker, startTime, timeoutMs, concurrency);
          }
          logger.info(`✔ feature=${feature} 执行完毕`);
        }),
      );

      await Promise.all(groupTasks);
    }

    const summary = tracker.getSummary();

    // 写 metrics.json 到输出目录
    const funcName = args.func || cases[0]?.feature;
    if (funcName) {
      const metricsPath = path.join(outputDir(funcName), 'metrics.json');
      writeJson(metricsPath, metrics.toJSON());
      logger.info(`度量数据已写入：${metricsPath}`);
    }

    // 通知器推送（飞书等，若配置开启）
    const notifierConfig = getNotifierConfig();
    if (notifierConfig.enabled && notifierConfig.webhook) {
      const notifier = new FeishuNotifier(notifierConfig.webhook, notifierConfig.mentionMobiles);
      await notifier.notify(summary);
    }

    if (args.ci) {
      // CI 模式：打印一行摘要
      // eslint-disable-next-line no-console
      console.log(ResultTracker.formatSummary(summary));
    } else {
      logger.step('========== 执行完成 ==========');
      for (const f of summary.reports) logger.info('报告已生成：' + f);
    }

    return summary.exitCode;
  }
}

/** 便捷单例入口 */
export const engine = new Engine();
