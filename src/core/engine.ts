// 核心引擎：加载配置/会话/任务 → 匹配场景处理器 → 执行 pipeline → 生成报告
// 支持：退出码规范、CI 模式、整体超时、环境变量注入、trace-id、metrics、JSON 日志
// 并发：--parallel/--concurrency，按 feature 分组串行 + 组间并行
// DX 优化：--watch（文件监听自动重跑）、--dry-run（仅校验不执行）、--debug-level（增强调试）
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import pLimit from 'p-limit';
import type { AppConfig, TaskDef, ReportData, EnvDiff, DebugLevel } from './types.js';
import { HookRegistry } from './hooks.js';
import type { SceneHandler } from './scene-handler.js';
import { Pipeline, PipelineResult } from './pipeline.js';
import { Http } from '../integrations/http.js';
import { loadConfig, parseArgs, CliArgs } from '../config/config.js';
import { getReporters } from '../reports/factory.js';
import { outputDir, caseOutputDir, logsDir, debugDir, caseDebugDir, writeJson } from '../utils/fs-utils.js';
import { closeLogFile, logger, setCiMode, setLogLevel, setLogFile } from '../utils/logger.js';
import { loadCases, LoadedCase } from '../cases/loader.js';
import { filterCases } from '../cases/filter.js';
import { ResultTracker, EXIT_CODE, type ExecutionSummary } from '../utils/exit-code.js';
import { getEnvFromEnv, applyEnvSessionOverrides, getNotifierConfig } from '../config/env-loader.js';
import { generateTraceId, getTraceId } from '../utils/trace.js';
import { getMetricsCollector, MetricsCollector, metrics } from '../utils/metrics.js';
import { autoLoadScenes } from '../plugins/loader.js';
import { FeishuNotifier } from '../integrations/notifiers/feishu.js';
import { snapshot as envSnapshot, compare as envCompare, saveBaseline as saveEnvBaseline, loadBaseline as loadEnvBaseline } from './env-checker.js';
import { Billing } from '../integrations/billing.js';
import { runDryRun } from './dry-run.js';
import { Watcher, defaultWatchPaths, type WatchSummary } from './watcher.js';
import { uploadReports, getOssConfigFromEnv } from '../utils/oss-uploader.js';
import { generateJUnitXml } from '../utils/junit-reporter.js';
import { generateAllureResults } from '../utils/allure-reporter.js';
import { resolvePlaceholders } from '../utils/data-generator.js';
import { createRecordSession, createReplaySession, type RecordSession, type ReplaySession } from '../utils/mock-recorder.js';
import { DynamicConcurrencyController, createDefaultConcurrencyConfig } from '../utils/concurrency-controller.js';
import { toCanonicalSceneId } from './canonical-scene.js';
import type { CoreExecutionStatus } from './execution-status.js';
import { ExecutionAbortError, abortForTimeout, abortReasonOf, linkAbortSignal } from './abort.js';
import { isAbortedStatus } from './execution-status.js';
import type { DataSession } from './data-session.js';
import { getExecutionContext, withExecutionContext } from './execution-context.js';
import { redactSensitiveText } from './redact.js';
import { validateDependencies } from '../contracts/dependency-index.js';
import { createPhase1ContractResolver } from '../contracts/seed-contracts.js';
import type { ContractResolver } from '../contracts/resolver.js';

// 场景处理器注册表（自动扫描加载，无需手动 import）
export const SCENES: Record<string, SceneHandler> = {};

/** 用例超时 abort 后，等待底层收尾的硬宽限（防不合作代码悬挂调用方；正常远快于此值） */
const HARD_ABORT_GRACE_MS = 5_000;

export function registerScene(name: string, handler: SceneHandler): void {
  SCENES[name] = handler;
}

export function findHandler(scene: string): SceneHandler | null {
  const canonical = toCanonicalSceneId(scene);
  if (!canonical) return null;
  for (const h of Object.values(SCENES)) {
    if (h.supportedScenes.includes(canonical) && h.supports(canonical)) return h;
  }
  return null;
}

export interface EngineOptions {
  hooks?: HookRegistry;
  contractResolver?: ContractResolver;
}

/** 单任务执行结果 */
export interface RunTaskResult {
  files: string[];
  passRate: number;
  hasBlockingIssue: boolean;
  executed: boolean;
  status: CoreExecutionStatus;
  checks: PipelineResult['checks'];
  processor?: string;
  processorInvoked?: boolean;
  requestId?: string;
}

export class Engine {
  private hooks: HookRegistry;
  private readonly contractResolver: ContractResolver;

  constructor(opts: EngineOptions = {}) {
    this.hooks = opts.hooks || new HookRegistry();
    this.contractResolver = opts.contractResolver ?? createPhase1ContractResolver();
  }

  /** 加载任务定义（文件或目录，支持 JSON / TS 编译产物） */
  private async loadTask(taskArg: string): Promise<LoadedCase[]> {
    const cases = await loadCases(path.resolve(process.cwd(), taskArg));
    if (!cases.length) throw new Error(`未加载到任何任务定义：${taskArg}`);
    return cases;
  }

  /** 运行单个任务，返回报告文件路径列表与执行结果 */
  async runTask(cfg: AppConfig, taskDef: TaskDef, env: string, func?: string, reporter?: string | null, debug?: boolean, caseId?: string, autoSetup?: boolean, envDiff?: EnvDiff, debugLevel?: DebugLevel, signal?: AbortSignal, dataSession?: DataSession): Promise<RunTaskResult> {
    const parent = getExecutionContext();
    const scopedMetrics = parent?.metrics ?? new MetricsCollector();
    if (!parent?.metrics) scopedMetrics.start();

    return withExecutionContext({
      log: {
        task: taskDef.name,
        scene: taskDef.scene,
        trace: parent?.log.trace || getTraceId(),
        caseId: caseId ?? parent?.log.caseId ?? '',
      },
      metrics: scopedMetrics,
    }, () => this.runTaskScoped(
      cfg, taskDef, env, func, reporter, debug, caseId, autoSetup, envDiff, debugLevel, signal, dataSession,
    ));
  }

  /** runTask 的已隔离实现；调用方必须先建立 execution scope。 */
  private async runTaskScoped(cfg: AppConfig, taskDef: TaskDef, env: string, func?: string, reporter?: string | null, debug?: boolean, caseId?: string, autoSetup?: boolean, envDiff?: EnvDiff, debugLevel?: DebugLevel, signal?: AbortSignal, dataSession?: DataSession): Promise<RunTaskResult> {
    // Loader 标记的 Legacy Asset 必须先通过 Migration + Contract Gate；此处位于
    // Session/HTTP/Data Prepare 之前，保证 stale/unknown TaskDef 没有真实副作用。
    const migrationAllowed = !taskDef.legacyContract || taskDef.legacyContract.status === 'ACTIVE';
    const validation = validateDependencies(taskDef.contractDependencies ?? [], this.contractResolver);
    if (!migrationAllowed || validation.status !== 'VALID') {
      const reason = !migrationAllowed
        ? `LEGACY_ASSET_${taskDef.legacyContract!.status}：${taskDef.legacyContract!.asset}；${taskDef.legacyContract!.reasons.join('；')}`
        : `CONTRACT_GATE_${validation.status}：${validation.reasons.join('；')}`;
      return {
        files: [], passRate: 0, hasBlockingIssue: true, executed: false, status: 'BLOCKED',
        checks: [{ name: 'Contract Gate', pass: false, detail: reason, kind: 'BUSINESS', level: 'P0' }],
        processorInvoked: false,
      };
    }
    const handler = findHandler(taskDef.scene);
    const session = applyEnvSessionOverrides(Http.loadSession(cfg.session_cookies_path, env));
    session.env = env;

    // debug 目录（仅 --debug 模式使用；verbose/full 级别按用例隔离到 caseId 子目录）
    const dbgDir = debug ? caseDebugDir(func, caseId) : undefined;

    const pipeline = new Pipeline({ cfg, session, taskDef, handler, func, debugDir: dbgDir, autoSetup, envDiff, debugLevel, signal, dataSession }, this.hooks);
    const result: PipelineResult = await pipeline.run();

    const hasBlockingIssue = result.status === 'BLOCKED' || result.status === 'NOT_EXECUTED' || isAbortedStatus(result.status)
      || result.issues.some((i) => i.level === '阻塞');
    const executionStatus: CoreExecutionStatus = hasBlockingIssue && result.status === 'PASS'
      ? 'BLOCKED'
      : result.status;

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
      executed: result.executed,
      executionStatus,
      assetInfo: result.assetInfo,
      traceId: getTraceId(),
      metrics: metrics.toJSON(),
      envDiff,
      dataContext: result.dataContext,
      debugProducts: result.debugProducts,
    };

    // 报告写入：并发模式用 caseId 子目录，串行模式用平铺目录
    const dir = caseId ? caseOutputDir(func, caseId) : outputDir(func);
    const reporters = getReporters(reporter);
    const files: string[] = [];
    for (const r of reporters) {
      files.push(...r.write(dir, taskDef.name, reportData));
    }
    return {
      files,
      passRate: result.passRate,
      hasBlockingIssue,
      executed: result.executed,
      status: executionStatus,
      checks: result.checks,
      processor: result.processor,
      processorInvoked: result.processorInvoked,
      requestId: result.requestId,
    };
  }

  /**
   * 执行单个用例的完整链路（含超时中止、日志隔离、报告生成）。
   * 并发模式下由 p-limit 调度调用，串行模式下直接调用。
   * 支持：per-case timeout（真实中止底层 HTTP）、case-level retry、数据生成器占位符解析。
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
    envDiff?: EnvDiff,
    debugLevel?: DebugLevel,
    globalSignal?: AbortSignal,
  ): Promise<void> {
    const parentMetrics = getMetricsCollector();
    const caseMetrics = new MetricsCollector();
    caseMetrics.start();

    // 即使串行时不展示 caseId，每条用例也拥有独立的日志/metrics scope。
    const concurrencyOn = concurrency > 1;
    const caseId = concurrencyOn
      ? `${c.feature || 'default'}-${Date.now()}-${c.name.replace(/[\s\\/:*?"<>|]/g, '_').slice(0, 30)}`
      : '';

    return withExecutionContext({
      log: { task: c.name, scene: c.def.scene, caseId },
      metrics: caseMetrics,
    }, async () => {
    // 超时检查（全局超时；未启动的用例直接标记，不再进入流水线）
    if (Date.now() - startTime > timeoutMs) {
      logger.warn(`执行超时（${args.timeout ?? 600}s），用例 ${c.name} 标记为超时中断`);
      tracker.addTimeout(c.name, c.feature, `整体超时 ${args.timeout ?? 600}s`);
      return;
    }

    const tag = c.feature ? `[${c.feature}]` : '';
    logger.step(`---- ${tag}加载用例：${c.name}（${path.basename(c.file)}） ----`);

    // 数据生成器：解析用例定义中的占位符（{{gen.email}} 等）
    let resolvedDef = c.def;
    try {
      const hasPlaceholder = JSON.stringify(c.def).includes('{{gen.');
      if (hasPlaceholder) {
        resolvedDef = resolvePlaceholders(c.def, { seed: args.caseTimeout ? undefined : Date.now() }) as TaskDef;
        logger.debug(`  数据生成器已解析占位符`);
      }
    } catch (e: any) {
      logger.warn(`数据生成器解析失败（已降级使用原始数据）：${e.message}`);
    }

    // 用例级超时（覆盖全局超时）：超时触发 AbortController，信号贯穿
    // runTask → Pipeline → Http → fetch，底层请求真正停止（而非仅上层放弃等待）
    const caseTimeoutMs = args.caseTimeout ? args.caseTimeout * 1000 : null;

    // 用例级重试配置（从用例定义中读取，--no-retry 可全局禁用）
    const caseRetries = args.noRetry ? 0 : (typeof c.def.extra === 'object' && c.def.extra !== null ? (c.def.extra as Record<string, unknown>).retries as number : undefined);
    const maxRetries = caseRetries ?? 0;

    const caseStart = Date.now();

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        logger.info(`  🔄 用例重试 ${attempt}/${maxRetries}：${c.name}`);
        metrics.recordCaseRetry();
        // 指数退避
        await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt - 1)));
      }

      // 每次尝试独立信号：用例超时 + 全局超时/取消 级联中止
      const caseAbort = new AbortController();
      const unlinkGlobal = linkAbortSignal(caseAbort, globalSignal);
      let caseTimer: NodeJS.Timeout | undefined;
      if (caseTimeoutMs) {
        caseTimer = setTimeout(
          () => abortForTimeout(caseAbort, `用例超时（${caseTimeoutMs / 1000}s）：${c.name}`),
          caseTimeoutMs,
        );
      }

      try {
        const execPromise = this.runTask(
          cfg, resolvedDef, env, args.func || c.feature || undefined, args.reporter, args.debug, caseId || undefined, args.autoSetup, envDiff, debugLevel, caseAbort.signal,
        );

        // 超时已触发 abort：正常情况下流水线会在信号中止后很快返回 TIMEOUT/CANCELLED 结果；
        // 硬截止只是最后防线（防止不合作的自定义钩子/处理器悬挂调用方）。
        const result = caseTimeoutMs
          ? await this.awaitSettle(execPromise, caseTimeoutMs + HARD_ABORT_GRACE_MS, c.name)
          : await execPromise;

        // 中止终态：底层已停止，按 TIMEOUT/CANCELLED 记账（CANCELLED 不重试；
        // 仅 TIMEOUT 在策略允许时进入下一次尝试）
        if (isAbortedStatus(result.status)) {
          tracker.reports.push(...result.files);
          const abortStatus = result.status === 'TIMEOUT' ? 'TIMEOUT' as const : 'CANCELLED' as const;
          const abortError = new ExecutionAbortError(
            abortStatus,
            `${abortStatus}：${c.name}（执行被中止，底层任务已停止）`,
          );
          const canRetryOnTimeout = abortStatus === 'TIMEOUT' && attempt < maxRetries && this.shouldRetry(abortError, c.def);
          if (!canRetryOnTimeout) {
            this.recordAborted(tracker, c, abortStatus, abortError.message, Date.now() - caseStart);
            return;
          }
          continue; // 超时且策略允许 → 进入下一次重试
        }

        const { files, passRate, hasBlockingIssue } = result;
        const durationMs = Date.now() - caseStart;
        tracker.addResult({
          name: c.name,
          feature: c.feature,
          pass: passRate === 100 && !hasBlockingIssue,
          pending: false,
          passRate,
          durationMs,
          scene: c.def.scene,
          tags: c.def.tags,
        });
        tracker.reports.push(...files);
        return; // 成功，退出重试循环
      } catch (e: any) {
        const durationMs = Date.now() - caseStart;
        const reason = abortReasonOf(e);

        // CANCELLED（外部取消）：不重试，直接落账
        if (reason === 'CANCELLED') {
          this.recordAborted(tracker, c, 'CANCELLED', `CANCELLED：${e.message}`, durationMs);
          return;
        }
        // TIMEOUT（abort 后 runTask 仍以异常冒泡，如报告写入前失败）：可按策略重试
        const shouldRetry = attempt < maxRetries && this.shouldRetry(e, c.def);

        if (!shouldRetry) {
          if (reason === 'TIMEOUT') {
            this.recordAborted(tracker, c, 'TIMEOUT', `TIMEOUT：${e.message}`, durationMs);
          } else {
            logger.error(`用例执行失败：${c.name} - ${e.message}`);
            tracker.addResult({
              name: c.name,
              feature: c.feature,
              pass: false,
              pending: false,
              passRate: 0,
              error: e.message,
              stack: e.stack,
              durationMs,
              scene: c.def.scene,
              tags: c.def.tags,
            });
          }
          return; // 不重试，退出循环
        }

        // 记录最后一次重试的失败信息（用于后续报告）
        if (attempt === maxRetries) {
          if (reason === 'TIMEOUT') {
            this.recordAborted(tracker, c, 'TIMEOUT', `TIMEOUT：${e.message}`, durationMs);
          } else {
            tracker.addResult({
              name: c.name,
              feature: c.feature,
              pass: false,
              pending: false,
              passRate: 0,
              error: e.message,
              stack: e.stack,
              durationMs,
              scene: c.def.scene,
              tags: c.def.tags,
            });
          }
          return;
        }
      } finally {
        if (caseTimer) clearTimeout(caseTimer);
        unlinkGlobal();
      }
    }

    }, () => {
      // finally cleanup：任何返回/异常/超时路径都执行一次，且只合并本用例指标。
      parentMetrics.merge(caseMetrics);
    });
  }

  /** 中止终态落账：TIMEOUT 计入超时统计（退出码 3），CANCELLED 计为失败且不重试 */
  private recordAborted(tracker: ResultTracker, c: LoadedCase, status: 'TIMEOUT' | 'CANCELLED', message: string, durationMs: number): void {
    if (status === 'TIMEOUT') {
      tracker.addTimeout(c.name, c.feature, message);
      return;
    }
    tracker.addResult({
      name: c.name,
      feature: c.feature,
      pass: false,
      pending: false,
      passRate: 0,
      error: message,
      durationMs,
      scene: c.def.scene,
      tags: c.def.tags,
    });
  }

  /**
   * 等待已中止的执行收尾：信号已 abort，正常会立刻结算；硬截止仅防不合作代码悬挂调用方。
   * （区别于旧 Promise.race：底层任务已通过 AbortSignal 真实停止，这里只是等它善后。）
   */
  private async awaitSettle<T>(promise: Promise<T>, hardDeadlineMs: number, caseName: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const hardPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ExecutionAbortError('TIMEOUT', `用例 ${caseName} 中止后未在宽限期内收尾（${hardDeadlineMs}ms），放弃等待（底层信号已中止）`)), hardDeadlineMs);
    });
    try {
      return await Promise.race([promise, hardPromise]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** 判断是否应该重试 */
  private shouldRetry(error: Error, taskDef: TaskDef): boolean {
    // 从用例定义中读取 retryWhen 配置
    const extra = taskDef.extra as Record<string, unknown> | undefined;
    const retryWhen = extra?.retryWhen as string | undefined;

    if (!retryWhen || retryWhen === 'always') return true;

    if (retryWhen === 'timeout' && (error.message?.includes('超时') || error.message?.includes('timeout'))) return true;
    if (retryWhen === 'network' && (error.message?.includes('ECONNREFUSED') || error.message?.includes('fetch'))) return true;
    if (retryWhen === '5xx') {
      const failureStatus = (error as Error & { failure?: { status?: unknown } }).failure?.status;
      const directStatus = (error as Error & { status?: unknown }).status;
      const status = typeof failureStatus === 'number'
        ? failureStatus
        : typeof directStatus === 'number'
          ? directStatus
          : undefined;
      if (status !== undefined && status >= 500 && status <= 599) return true;
    }

    return false;
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
  --debug-level <level>  调试级别：basic（默认）/ verbose（HTTP+上下文快照）/ full（全部+堆栈）
  --grep      按标签筛选用例（如 P0），支持与 --filter/--scene 组合（AND）
  --filter    按名称子串筛选用例
  --scene     按场景类型筛选用例
  --concurrency <N>  并发数（默认 1 = 串行）。同一 feature 内用例串行，不同 feature 间并行
  --parallel         自动并发，并发数取 CPU 核心数（上限 4）。优先于 --concurrency
  --dynamic-concurrency  动态并发：根据成功率自动调整并发数（失败率高时降低，稳定后恢复）
  --concurrency-min <N>  动态并发最小值（默认 1）
  --concurrency-max <N>  动态并发最大值（默认等于 --concurrency 的 2 倍）
  --case-timeout <s>  用例级超时（秒），覆盖全局 --timeout
  --no-retry          禁用用例级失败重试
  --record            Mock 录制模式：拦截 HTTP 请求并保存为 fixtures
  --replay           Mock 回放模式：从 fixtures 返回录制响应，不发起真实请求
  --auto-setup       启用数据工厂（执行 setup/teardown，默认关闭）
  --watch            Watch 模式：监听 src/ 文件变更，自动重新编译并执行匹配用例
  --watch-delay <ms> 文件变更后防抖延迟（默认 300ms）
  --dry-run          Dry-run 模式：仅解析校验用例定义，不执行任何 HTTP 请求
  --upload-reports   上传报告到 OSS（需配置 TESTFLOW_OSS_* 环境变量），飞书通知附带可分享链接
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

    // 环境优先级：CLI --env > TESTFLOW_ENV > 配置 default_env
    const envName = args.env || getEnvFromEnv() || undefined;

    let cfg: AppConfig;
    try {
      // 28.2：loadConfig 已合并 TESTFLOW_* 环境变量覆盖（loadConfigFromEnv），无需再次 applyEnvToConfig
      cfg = loadConfig(envName);
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

    // ── Dry-run 模式：仅解析校验，不执行任何 HTTP 请求 ──
    if (args.dryRun) {
      const result = runDryRun(cases);
      return result.failed > 0 ? EXIT_CODE.CONFIG_ERROR : EXIT_CODE.SUCCESS;
    }

    // ── --record 与 --replay 互斥检查 ──
    if (args.record && args.replay) {
      logger.error('--record 与 --replay 互斥，不能同时使用');
      return EXIT_CODE.CONFIG_ERROR;
    }

    // 自动扫描加载场景处理器
    const loadedScenes = await autoLoadScenes();
    Object.assign(SCENES, loadedScenes);
    if (Object.keys(SCENES).length === 0) {
      logger.warn('未加载到任何场景处理器，所有任务将以半自动模式执行');
    }

    const env = envName || cfg.default_env;

    // ── Watch 模式：监听文件变更自动重跑 ──
    if (args.watch) {
      if (args.ci) {
        logger.warn('--watch 与 --ci 不兼容，已忽略 --watch（CI 模式不支持 watch）');
      } else {
        return await this.startWatch(args, cfg, env);
      }
    }

    // ── 正常执行 ──
    const summary = await this.executeCases(args, cfg, env, cases);

    if (args.ci) {
      // CI 模式：打印一行摘要
      // eslint-disable-next-line no-console
      console.log(redactSensitiveText(ResultTracker.formatSummary(summary)));
    } else {
      logger.step('========== 执行完成 ==========');
      for (const f of summary.reports) logger.info('报告已生成：' + f);
    }

    return summary.exitCode;
  }

  /**
   * 执行用例（串行/并发），返回执行汇总。
   * 可被 main()（正常执行）和 Watcher（watch 重跑）复用。
   */
  private async executeCases(args: CliArgs, cfg: AppConfig, env: string, cases: LoadedCase[]): Promise<ExecutionSummary> {
    const traceId = generateTraceId();
    const runMetrics = new MetricsCollector();
    runMetrics.start();

    return withExecutionContext({
      log: { trace: traceId },
      metrics: runMetrics,
    }, () => this.executeCasesScoped(args, cfg, env, cases, traceId, runMetrics), () => {
      // finally cleanup：异常路径也关闭当前 run 独占的文件 sink。
      closeLogFile();
    });
  }

  /** executeCases 的 run 级隔离实现。 */
  private async executeCasesScoped(args: CliArgs, cfg: AppConfig, env: string, cases: LoadedCase[], traceId: string, runMetrics: MetricsCollector): Promise<ExecutionSummary> {
    logger.info(`Trace ID: ${traceId}`);

    const tracker = new ResultTracker();
    const startTime = Date.now();
    const timeoutMs = (args.timeout ?? 600) * 1000;

    // ── 全局超时：真实中止所有在途用例（信号级联到每个 case → Pipeline → Http → fetch）──
    // 旧实现仅「标记超时并停止调度」，在途请求会继续执行；现在到点即 abort，底层全部停止。
    const globalAbort = new AbortController();
    const globalTimer = setTimeout(
      () => abortForTimeout(globalAbort, `整体执行超时（${args.timeout ?? 600}s）：中止全部在途用例`),
      timeoutMs,
    );

    // 计算并发数：--parallel 优先于 --concurrency
    let concurrency = args.parallel
      ? Math.min(4, os.cpus().length)
      : (args.concurrency ?? 1);

    // 动态并发控制器
    let dynConcurrency: DynamicConcurrencyController | null = null;
    if (args.dynamicConcurrency && concurrency > 1) {
      const cMin = args.concurrencyMin ?? 1;
      const cMax = args.concurrencyMax ?? Math.min(8, concurrency * 2);
      const config = createDefaultConcurrencyConfig(concurrency, cMax);
      config.min = cMin;
      dynConcurrency = new DynamicConcurrencyController(config);
    }

    // ── Mock 录制/回放 ──
    let mockRecordSession: RecordSession | null = null;
    let mockReplaySession: ReplaySession | null = null;
    if (args.record || args.replay) {
      const funcName = args.func || cases[0]?.feature || 'default';
      const fixturesDir = path.join(outputDir(funcName), 'fixtures');
      if (args.record) {
        mockRecordSession = createRecordSession(fixturesDir, {
          urlFilter: new RegExp(cfg.environments[env]?.base_url || '.*'),
        });
        mockRecordSession.start();
      }
      if (args.replay) {
        // 也尝试从 src/cases/<func>/fixtures/ 加载
        const srcFixturesDir = path.join('src', 'cases', funcName, 'fixtures');
        mockReplaySession = createReplaySession(fixturesDir, {
          matchStrategy: 'loose',
          onMissing: 'passthrough',
        });
        mockReplaySession.start();
        // 尝试加载 src 目录的 fixtures
        try {
          if (fs.existsSync(srcFixturesDir)) {
            mockReplaySession = createReplaySession(srcFixturesDir, {
              matchStrategy: 'loose',
              onMissing: 'passthrough',
            });
            mockReplaySession.start();
          }
        } catch { /* 降级 */ }
      }
    }

    // Debug 级别（--debug-level）
    const debugLevel = (args.debugLevel as DebugLevel) || 'basic';
    if (args.debug && debugLevel !== 'basic') {
      logger.info(`Debug 级别：${debugLevel}（${debugLevel === 'verbose' ? '保存 HTTP 请求/响应 + 上下文快照' : '保存全部数据 + 堆栈追踪'}）`);
    }

    if (concurrency > 1) {
      logger.info(`并发模式：concurrency=${concurrency}${dynConcurrency ? ' (动态)' : ''}（同一 feature 串行，不同 feature 并行）`);
    }
    // 整个 run 共用一个 sink；task/scene/caseId/step 由各自 ALS scope 隔离。
    const logFunc = args.func || cases[0]?.feature;
    if (logFunc) {
      setLogFile(path.join(logsDir(logFunc), 'run.log'));
    }

    // ── 环境一致性检测 ──
    let envDiff: EnvDiff | undefined;
    try {
      const session = applyEnvSessionOverrides(Http.loadSession(cfg.session_cookies_path, env));
      const http = new Http(cfg.environments[env].base_url, session.cookie_string);
      const billing = new Billing(http, cfg.environments[env].billing_url!);
      const func = args.func || cases[0]?.feature || undefined;
      const current = await envSnapshot(env, cfg, billing);
      const baseline = loadEnvBaseline(func);
      if (baseline) {
        envDiff = envCompare(baseline, current);
        if (envDiff.changed) {
          logger.warn(`环境变更检测：${envDiff.changes.length} 项差异`);
          envDiff.changes.forEach((c) => logger.warn(`  ${c.severity === 'error' ? '⚠' : 'ℹ'} ${c.field}: ${c.before} → ${c.after}`));
        } else {
          logger.info('环境一致性检测：与基线一致');
        }
        // 更新基线（每次执行后刷新）
        saveEnvBaseline(current, func);
      } else {
        logger.info('环境基线不存在，首次执行将保存为基线');
        saveEnvBaseline(current, func);
      }
    } catch (e: any) {
      logger.warn(`环境一致性检测失败（已降级跳过）：${e.message}`);
    }

    if (concurrency === 1 || dynConcurrency) {
      // ── 串行模式或动态并发模式 ──
      // 动态并发模式下，初始为串行，根据成功率逐步提升
      if (dynConcurrency) {
        logger.info(`动态并发模式：初始 concurrency=${dynConcurrency.getConcurrency()}`);
      }
      for (const c of cases) {
        const currentConcurrency = dynConcurrency?.getConcurrency() || concurrency;
        await this.runOneCase(c, cfg, env, args, tracker, startTime, timeoutMs, currentConcurrency, envDiff, debugLevel, globalAbort.signal);
        // 动态并发：记录结果并调整
        if (dynConcurrency) {
          const lastResult = tracker.getResults().at(-1);
          if (lastResult) {
            dynConcurrency.recordResult(lastResult.pass);
          }
        }
      }
    } else if (concurrency > 1) {
      // ── 固定并发模式：按 feature 分组，组内串行 + 组间并行 ──
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
            await this.runOneCase(c, cfg, env, args, tracker, startTime, timeoutMs, concurrency, envDiff, debugLevel, globalAbort.signal);
          }
          logger.info(`✔ feature=${feature} 执行完毕`);
        }),
      );

      await Promise.all(groupTasks);
    }

    // 全局执行结束：解除全局超时计时（未触发则不误伤后续上传/通知等收尾动作）
    clearTimeout(globalTimer);

    // ── 停止 Mock 录制/回放 ──
    if (mockRecordSession) {
      const fixtures = mockRecordSession.stop();
      logger.info(`Mock 录制完成：${fixtures.length} 条 fixtures`);
    }
    if (mockReplaySession) {
      const stats = mockReplaySession.stop();
      logger.info(`Mock 回放完成：命中 ${stats.matched}，未命中 ${stats.missed}`);
    }

    const summary = tracker.getSummary();
    runMetrics.setPassRate(summary.total > 0 ? (summary.passed / summary.total) * 100 : 0);

    // 写 metrics.json 到输出目录
    const funcName = args.func || cases[0]?.feature;
    if (funcName) {
      const metricsPath = path.join(outputDir(funcName), 'metrics.json');
      writeJson(metricsPath, metrics.toJSON());
      logger.info(`度量数据已写入：${metricsPath}`);
    }

    // ── 生成 JUnit XML 报告（跨用例级，供 CI 平台解析） ──
    if (funcName) {
      const junitDir = outputDir(funcName);
      const junitFile = generateJUnitXml(summary, summary.results, {
        outputDir: junitDir,
        suiteName: 'test-flow',
      });
      if (junitFile) {
        summary.reports.push(junitFile);
      }

      // ── 生成 Allure 结果 JSON ──
      const allureFiles = generateAllureResults(summary, summary.results, {
        outputDir: junitDir,
        env,
      });
      summary.reports.push(...allureFiles);
    }

    // ── 上传报告到 OSS（--upload-reports 启用时） ──
    let reportUrls: string[] | undefined;
    if (args.uploadReports) {
      const ossConfig = getOssConfigFromEnv();
      if (ossConfig) {
        try {
          // output 根目录：outputDir 返回 .../output/<日期>/<功能>，上溯两级即 output 根
          const outputBase = path.resolve(outputDir(funcName), '../..');
          const uploadResult = await uploadReports(outputBase, ossConfig);
          if (uploadResult.urls.length > 0) {
            reportUrls = uploadResult.urls;
            logger.info(`报告已上传 OSS（${uploadResult.uploaded.length} 个文件），可分享链接：`);
            uploadResult.urls.forEach((u) => logger.info(`  ${u}`));
          }
          if (uploadResult.errors.length > 0) {
            logger.warn(`部分报告上传失败（${uploadResult.errors.length} 个）：`);
            uploadResult.errors.forEach((e) => logger.warn(`  ${e}`));
          }
        } catch (e: any) {
          logger.warn(`报告上传 OSS 失败：${e.message}`);
        }
      } else {
        logger.warn('--upload-reports 已启用但 OSS 配置不完整（需设置 TESTFLOW_OSS_ENDPOINT/BUCKET/ACCESS_KEY_ID/ACCESS_KEY_SECRET 环境变量）');
      }
    }

    // 通知器推送（飞书等，若配置开启）
    const notifierConfig = getNotifierConfig();
    if (notifierConfig.enabled && notifierConfig.webhook) {
      const notifier = new FeishuNotifier(notifierConfig.webhook, notifierConfig.mentionMobiles);
      await notifier.notify(summary, reportUrls);
    }

    return summary;
  }

  /**
   * 启动 Watch 模式：监听源码变更，自动重新编译并执行匹配用例。
   * 首次执行后进入 watch 循环，按 Ctrl+C 退出。
   */
  private async startWatch(args: CliArgs, cfg: AppConfig, env: string): Promise<number> {
    const delay = args.watchDelay ?? 300;

    const executeFn = async (): Promise<WatchSummary> => {
      // 重新加载用例（拾取文件修改）
      let cases: LoadedCase[];
      try {
        cases = await this.loadTask(args.task!);
      } catch (e: any) {
        logger.error(`用例加载失败：${e.message}`);
        return { exitCode: 2, passed: 0, failed: 0, pending: 0, reports: [] };
      }
      cases = filterCases(cases, { grep: args.grep, filter: args.filter, scene: args.scene });
      if (cases.length === 0) {
        logger.warn('筛选后无匹配用例');
        return { exitCode: 2, passed: 0, failed: 0, pending: 0, reports: [] };
      }

      // 重新加载场景处理器（拾取 handler 修改）
      const loadedScenes = await autoLoadScenes();
      Object.assign(SCENES, loadedScenes);

      const summary = await this.executeCases(args, cfg, env, cases);
      return {
        exitCode: summary.exitCode,
        passed: summary.passed,
        failed: summary.failed,
        pending: summary.pending,
        reports: summary.reports,
      };
    };

    const watcher = new Watcher(executeFn, {
      watchPaths: defaultWatchPaths(),
      delay,
      ci: args.ci ?? false,
    });

    return watcher.start();
  }
}

/** 便捷单例入口 */
export const engine = new Engine();
