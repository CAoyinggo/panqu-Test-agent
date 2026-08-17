// 流水线编排：固定 10 步流程 + 生命周期钩子触发 + teardown 核对
// 通用骨架（登录态/素材/影响分析/计费/报告）与场景处理器（提交/详情/状态）解耦
// 健壮性：try/catch 保证异常时仍出报告；计费等非关键接口失败降级不阻塞
import type { AppConfig, TaskDef, Session, SubmitResult, BillingData, RunContext, CheckResult, DataContext, EnvDiff, DebugLevel } from './types.js';
import { HookRegistry } from './hooks.js';
import { SceneHandler } from './scene-handler.js';
import { Http } from '../integrations/http.js';
import { Billing } from '../integrations/billing.js';
import { Assets, collectAssetRefs } from '../integrations/assets.js';
import { buildImpactList } from '../assertions/impact.js';
import { runDefaultAssertions } from '../assertions/all.js';
import { runTeardownCheck } from './teardown.js';
import { resolveDataFactory, isNoop } from './data-factory.js';
import { logger } from '../utils/logger.js';
import { metrics } from '../utils/metrics.js';
import { writeJson } from '../utils/fs-utils.js';
import path from 'node:path';

export interface PipelineOptions {
  cfg: AppConfig;
  session: Session;
  taskDef: TaskDef;
  handler: SceneHandler | null;
  func?: string;
  /** debug 目录路径（仅 --debug 模式传入，否则 undefined） */
  debugDir?: string;
  /** 是否启用数据工厂（--auto-setup） */
  autoSetup?: boolean;
  /** 环境差异检测结果（由 engine 传入） */
  envDiff?: EnvDiff;
  /** Debug 级别（--debug-level，basic/verbose/full） */
  debugLevel?: DebugLevel;
}

export interface PipelineResult {
  submit: SubmitResult;
  billingData: BillingData;
  checks: CheckResult[];
  impact: any[];
  responses: any[];
  manual: Array<{ id: string; steps: string }>;
  issues: any[];
  passRate: number;
  assetInfo: any;
  semiAuto: boolean;
  taskId: number | null;
  /** 数据上下文（--auto-setup 模式产出） */
  dataContext?: DataContext;
  /** debug 产物目录路径（供报告器生成链接） */
  debugProducts?: string;
}

export class Pipeline {
  hooks: HookRegistry;
  private opts: PipelineOptions;

  constructor(opts: PipelineOptions, hooks: HookRegistry = new HookRegistry()) {
    this.opts = opts;
    this.hooks = hooks;
  }

  /** 组装执行上下文（供场景处理器方法与钩子） */
  private buildCtx(extra: Partial<RunContext> = {}): RunContext {
    return {
      env: this.opts.session.env,
      session: this.opts.session,
      taskDef: this.opts.taskDef,
      http: null as any,
      assets: null as any,
      CFG: this.opts.cfg,
      responses: [],
      submit: {},
      taskId: this.opts.taskDef.task_id ?? null,
      ...extra,
    };
  }

  /** debug 模式下保存中间产物到 debug/ 目录 */
  private saveDebug(filename: string, data: unknown): void {
    if (this.opts.debugDir) {
      writeJson(path.join(this.opts.debugDir, filename), data);
    }
  }

  /** 是否启用 verbose/full 级别 debug */
  private isVerboseDebug(): boolean {
    return this.opts.debugLevel === 'verbose' || this.opts.debugLevel === 'full';
  }

  /** 保存 RunContext 快照（verbose/full 模式） */
  private snapshotCtx(step: string, ctx: RunContext): void {
    if (!this.isVerboseDebug()) return;
    const safe: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(ctx)) {
      // 跳过不可序列化的实例对象
      if (v instanceof Http || (v && typeof v === 'object' && 'baseUrl' in v)) continue;
      if (v && typeof v === 'object' && 'byType' in v) continue; // Assets 实例
      if (v && typeof v === 'object' && 'environments' in v) continue; // AppConfig
      try {
        JSON.stringify(v);
        safe[k] = v;
      } catch {
        safe[k] = `(不可序列化: ${typeof v})`;
      }
    }
    this.saveDebug(`ctx-snapshot-${step}.json`, safe);
  }

  /** 为 Http 实例设置请求记录器（verbose/full 模式） */
  private httpCounter = 0;
  private setupHttpRecorder(http: Http): void {
    if (!this.isVerboseDebug()) return;
    http.setRecorder((record) => {
      this.httpCounter++;
      const num = String(this.httpCounter).padStart(3, '0');
      this.saveDebug(`http-${num}-${record.name}.json`, record);
    });
  }

  /** 带计时的执行（记录到 metrics） */
  private async timed<T>(stepName: string, fn: () => Promise<T>): Promise<T> {
    const t0 = Date.now();
    try {
      return await fn();
    } finally {
      metrics.recordStep(stepName, Date.now() - t0);
    }
  }

  /** 执行完整流水线，返回结果（供报告器使用） */
  async run(): Promise<PipelineResult> {
    const { cfg, session, taskDef, handler } = this.opts;
    const semiAuto = !handler;
    const env = session.env;
    const ctx = this.buildCtx();

    // 初始化默认值（异常时也能出报告）
    let billingData: BillingData = {};
    let checks: CheckResult[] = [];
    let impact: any[] = [];
    let assetScan: any = { exists: false, byType: { image: [], audio: [], video: [], text: [] }, bySubdir: {} };
    let resolvedAssets: any[] = [];
    let mainError: Error | null = null;

    await this.hooks.run('beforeAll', ctx);
    logger.step(`========== 开始执行：${taskDef.name}（${env} 环境） ==========`);
    logger.info(`场景类型：${taskDef.scene} → ${handler ? `已接入（${handler.name}）` : '未接入（半自动执行）'}`);

    // ── 数据工厂 setup（--auto-setup 模式） ──
    let dataContext: DataContext | undefined;
    if (this.opts.autoSetup) {
      const { factory, name } = resolveDataFactory(taskDef);
      if (!isNoop(factory)) {
        logger.info(`数据工厂 setup（${name}）...`);
        try {
          dataContext = await factory.setup(ctx);
          ctx.data = dataContext;
          logger.info(`  数据准备完成：${dataContext.taskIds?.length ?? 0} 个任务，${dataContext.assets?.length ?? 0} 个素材`);
        } catch (e: any) {
          logger.warn(`数据工厂 setup 失败（已降级继续执行）：${e.message}`);
        }
      }
    }

    // ── 环境一致性断言（若有 envDiff） ──
    if (this.opts.envDiff && this.opts.envDiff.changed) {
      const { assertEnvConsistency } = await import('./env-checker.js');
      const envChecks = assertEnvConsistency(this.opts.envDiff);
      checks.push(...envChecks);
    }

    try {
      // ── 通用骨架 ──
      // 1. 登录态
      logger.step('[1/10] 数据需求清单检查...');
      const baseUrl = cfg.environments[env].base_url;
      const exp = new Date(session.token_exp * 1000);
      logger.info(`登录态：${session.account || session.nickname}（过期时间 ${exp.toLocaleString('zh-CN')}）`);
      if (exp < new Date()) logger.warn('登录态已过期，请重新提供');
      else logger.info('登录态有效');
      this.saveDebug('01-session.json', { account: session.account, nickname: session.nickname, project_id: session.project_id, token_exp: exp.toISOString(), env });
      this.snapshotCtx('01-session', ctx);

      // 2. 素材库
      logger.step('[2/10] 素材库检查（Test-panqu）...');
      const assets = new Assets();
      assetScan = assets.scan();
      if (assetScan.exists) {
        logger.info(`  image=${assetScan.byType.image.length} | audio=${assetScan.byType.audio.length} | video=${assetScan.byType.video.length} | text=${assetScan.byType.text.length}`);
      }
      ctx.assets = assets;
      this.saveDebug('02-assets.json', { exists: assetScan.exists, byType: assetScan.exists ? { image: assetScan.byType.image.length, audio: assetScan.byType.audio.length, video: assetScan.byType.video.length, text: assetScan.byType.text.length } : null });
      this.snapshotCtx('02-assets', ctx);

      // 3. 影响分析
      logger.step('[3/10] 数据隔离/影响分析...');
      impact = buildImpactList(taskDef);
      ctx.impact = impact;
      this.saveDebug('03-impact.json', impact);

      // 4. HTTP + 计费
      const http = new Http(baseUrl, session.cookie_string);
      this.setupHttpRecorder(http);
      http.setStep('4-pre-submit');
      const billing = new Billing(http, cfg.environments[env].billing_url!);
      ctx.http = http;
      this.saveDebug('04-http-config.json', { baseUrl, billingUrl: cfg.environments[env].billing_url, env });

      // 4.1 提交前积分快照（用于快照差值断言）
      let beforeBalance: { available_points: number; consumed_7d: number } | undefined;
      try {
        const bs = await billing.summary();
        beforeBalance = { available_points: Number(bs.available_points) || 0, consumed_7d: Number(bs.consumed_7d) || 0 };
        logger.info(`  提交前快照：available_points=${beforeBalance.available_points}，consumed_7d=${beforeBalance.consumed_7d}`);
      } catch (e: any) {
        logger.warn(`提交前积分快照失败（已降级）：${e.message}`);
      }
      this.saveDebug('041-before-balance.json', { beforeBalance });
      this.snapshotCtx('041-before-balance', ctx);

      // 5. 素材引用解析
      logger.step('[4/10] 素材引用解析...');
      for (const [k, v] of Object.entries(taskDef.extra || {})) {
        for (const rp of collectAssetRefs(v)) {
          const full = assets.resolve(rp);
          resolvedAssets.push({ field: k, path: rp, full: full || '(未找到)' });
          logger.info(`  ${k}: ${rp} -> ${full || '⚠ 未找到'}`);
        }
      }
      if (taskDef.uploads && Array.isArray(taskDef.uploads)) {
        for (const u of taskDef.uploads) {
          const full = assets.resolve(u.path);
          resolvedAssets.push({ field: u.field, path: u.path, full: full || '(未找到)' });
          logger.info(`  ${u.field}: ${u.path} -> ${full || '⚠ 未找到'}`);
        }
      }

      // ── 场景执行（钩子 beforeScene） ──
      await this.hooks.run('beforeScene', ctx);
      let taskId: number | null = ctx.taskId;
      this.snapshotCtx('05-before-submit', ctx);

      // 提交任务
      if (!taskId) {
        if (handler) {
          await this.hooks.run('beforeStep', ctx);
          logger.step('[5/10] 提交任务...');
          http.setStep('5-submit');
          const r = await handler.submit(ctx);
          taskId = r.taskId;
          Object.assign(ctx.submit, r.submit);
          ctx.taskId = taskId;
          if (r.submit.err) logger.warn('提交失败：' + r.submit.err);
          await this.hooks.run('afterStep', ctx);
        } else {
          logger.step('[5/10] 未接入处理器，跳过自动提交（半自动执行）...');
          ctx.submit.status = '半自动（待人工）';
          ctx.submit.err = '该场景未接入脚本处理器，需人工操作或后续接入';
        }
      } else {
        logger.step(`[5/10] 使用已有任务 ID：${taskId}（跳过提交）`);
        ctx.submit.taskId = taskId;
        ctx.submit.status = '使用已有任务';
      }
      this.saveDebug('05-submit.json', { taskId, submit: ctx.submit });
      this.snapshotCtx('05-submit', ctx);

      // 详情 + 状态
      if (taskId && handler) {
        await this.hooks.run('beforeStep', ctx);
        logger.step('[6/10] 查询任务详情（落库核对）...');
        http.setStep('6-detail');
        await handler.detail(ctx);
        await this.hooks.run('afterStep', ctx);
        this.saveDebug('06-detail.json', { taskId, submit: ctx.submit, detail: ctx.submit.detail });
        this.snapshotCtx('06-detail', ctx);

        await this.hooks.run('beforeStep', ctx);
        logger.step('[7/10] 查询任务状态...');
        http.setStep('7-status');
        await handler.status(ctx);
        await this.hooks.run('afterStep', ctx);
        this.saveDebug('07-status.json', { taskId, submit: ctx.submit, statusHistory: ctx.submit.statusHistory });
        this.snapshotCtx('07-status', ctx);
      }

      // 7.1 安全探针：跨账号只读越权检测（用错误 project_id 访问任务详情）
      let securityProbe: { attempted: boolean; rejected: boolean; detail: string } = { attempted: false, rejected: false, detail: '未执行' };
      if (taskId) {
        http.setStep('7.1-security-probe');
        try {
          const wrongPid = (session.project_id || 0) + 999999;
          const probeUrl = `${cfg.environments[env].detail_url}?id=${taskId}&project_id=${wrongPid}&task_log_id=0`;
          const probeRes = await http.api('安全探针(跨账号)', 'GET', probeUrl);
          const pj = probeRes.json;
          securityProbe.attempted = true;
          const rejected = pj.code !== 1 || !pj.data;
          securityProbe.rejected = rejected;
          securityProbe.detail = rejected
            ? `跨账号访问被拒绝（code=${pj.code}）`
            : `⚠ 跨账号访问未拒绝（code=${pj.code}，返回了数据），存在越权风险`;
          logger.info(`  安全探针：${securityProbe.detail}`);
        } catch (e: any) {
          securityProbe.attempted = true;
          securityProbe.rejected = true;
          securityProbe.detail = `跨账号访问抛出异常（视为拒绝）：${e.message}`;
          logger.info(`  安全探针：${securityProbe.detail}`);
        }
      }

      // 计费核验（非关键接口，失败降级为 warning 不阻塞）
      logger.step('[8/10] 计费核验...');
      http.setStep('8-billing');
      try {
        const summary = await billing.summary();
        const trend = await billing.modelTrend();
        const top = await billing.modelTop();
        const records = await billing.records(50);

        // 提交后积分快照 + 差值计算
        const afterBalance = { available_points: Number(summary.available_points) || 0, consumed_7d: Number(summary.consumed_7d) || 0 };
        let actualConsumed: number | undefined;
        if (beforeBalance) {
          actualConsumed = beforeBalance.available_points - afterBalance.available_points;
          logger.info(`  快照差值：before=${beforeBalance.available_points} → after=${afterBalance.available_points}，实际消耗=${actualConsumed}`);
        }

        billingData = handler
          ? handler.analyzeBilling({ summary, trend, top, records, beforeBalance, afterBalance, actualConsumed, securityProbe }, session)
          : { summary, trend, top, records, modelTrend: { found: false, modelName: taskDef.model_name || '' }, net: 0, beforeBalance, afterBalance, actualConsumed, securityProbe };
        const mt = billingData.modelTrend;
        logger.info(`  summary: consumed_7d=${summary.consumed_7d}, available_points=${summary.available_points}`);
        logger.info(`  模型趋势: ${mt?.found ? mt.modelName + ' 最新值=' + mt.lastValue : '未找到对应模型系列'}`);
        logger.info(`  近50条明细净消耗=${billingData.net}，快照差值净消耗=${actualConsumed ?? 'N/A'}`);
      } catch (e: any) {
        logger.warn(`计费核验异常（已降级跳过）：${e.message}`);
        billingData = { modelTrend: { found: false, modelName: taskDef.model_name || '' }, net: 0, beforeBalance, securityProbe };
      }
      this.saveDebug('08-billing.json', billingData);
      this.snapshotCtx('08-billing', ctx);

      // 数据隔离核验
      logger.step('[9/10] 数据隔离核验...');
      const verifyDef = { ...taskDef, account: session.account || session.nickname, project_id: session.project_id };
      // 断言中间值（verbose/full 模式保存）
      this.saveDebug('assertion-inputs.json', { verifyDef, submit: ctx.submit, billingData });
      checks = runDefaultAssertions(verifyDef, ctx.submit, billingData);
      this.saveDebug('09-checks.json', { checks, verifyDef });
      checks.forEach((c: any) => logger.info(`  ${c.pass ? '✅' : '❌'} ${c.name}：${c.detail}`));
      this.snapshotCtx('09-checks', ctx);

      await this.hooks.run('afterScene', ctx);
    } catch (e: any) {
      mainError = e;
      logger.error(`执行异常：${e.message}`);
      // full 模式：保存完整堆栈
      if (this.opts.debugLevel === 'full' && e.stack) {
        this.saveDebug('error-stacktrace.json', { message: e.message, stack: e.stack, name: e.name });
      }
    }

    // ── teardown（无论成功失败都执行） ──
    await this.hooks.run('teardown', ctx);
    const teardownChecks = runTeardownCheck(ctx, billingData);
    checks.push(...teardownChecks);
    teardownChecks.forEach((c) => logger.info(`  ${c.pass ? '✅' : '❌'} ${c.name}：${c.detail}`));
    this.saveDebug('10-teardown.json', { teardownChecks, submit: ctx.submit, billingData });
    this.snapshotCtx('10-teardown', ctx);

    // ── 数据工厂 teardown（--auto-setup 模式，无论成功失败都执行） ──
    if (this.opts.autoSetup && dataContext) {
      const { factory, name } = resolveDataFactory(taskDef);
      if (!isNoop(factory)) {
        logger.info(`数据工厂 teardown（${name}）...`);
        try {
          await factory.teardown(ctx, dataContext);
          logger.info('  数据清理完成');
        } catch (e: any) {
          logger.warn(`数据工厂 teardown 失败（不影响报告）：${e.message}`);
        }
      }
    }

    // ── 汇总报告数据 ──
    const manual = (taskDef.manual_cases || []).map((m: any) => ({ id: m.id, steps: m.steps }));
    const issues: any[] = [];

    // 执行异常 → 阻塞问题
    if (mainError) {
      issues.push({ level: '阻塞', title: '执行异常中断', desc: mainError.message });
    }
    if (ctx.submit.status === '失败') {
      issues.push({ level: '阻塞', title: '任务生成失败', desc: ctx.submit.err || '模型接入点或账号权限问题' });
    }
    if (semiAuto) {
      issues.push({ level: '待接入', title: '场景未接入脚本处理器', desc: '半自动执行：需人工完成主链路，后续在 plugins/scenes/ 新增处理器接入' });
    }
    if (billingData.modelTrend && !billingData.modelTrend.found) {
      issues.push({ level: '数据异常', title: '模型趋势中未统计到本次模型', desc: '需确认计费统计是否覆盖当前模型' });
    }
    checks.filter((c: any) => !c.pass).forEach((c: any) => issues.push({ level: '数据异常', title: c.name, desc: c.detail }));

    const passCount = checks.filter((c: any) => c.pass).length;
    const passRate = checks.length ? Math.round((passCount / checks.length) * 100) : 100;

    const assetInfo = {
      exists: assetScan.exists,
      counts: assetScan.exists ? { image: assetScan.byType.image.length, audio: assetScan.byType.audio.length, video: assetScan.byType.video.length, text: assetScan.byType.text.length } : null,
      resolved: resolvedAssets,
    };

    ctx.assetInfo = assetInfo;
    await this.hooks.run('afterAll', ctx);
    await this.hooks.run('beforeReport', ctx);

    return {
      submit: ctx.submit,
      billingData,
      checks,
      impact,
      responses: ctx.responses,
      manual,
      issues,
      passRate,
      assetInfo,
      semiAuto,
      taskId: ctx.taskId,
      dataContext,
      debugProducts: this.opts.debugDir,
    };
  }
}
