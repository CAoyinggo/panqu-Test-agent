// 流水线编排：固定 10 步流程 + 生命周期钩子触发
// 通用骨架（登录态/素材/影响分析/计费/报告）与场景处理器（提交/详情/状态）解耦
import type { AppConfig, TaskDef, Session, SubmitResult, BillingData, RunContext } from './types.js';
import { HookRegistry } from './hooks.js';
import { SceneHandler } from './scene-handler.js';
import { Http } from '../integrations/http.js';
import { Billing } from '../integrations/billing.js';
import { Assets, collectAssetRefs } from '../integrations/assets.js';
import { buildImpactList } from '../assertions/impact.js';
import { runDefaultAssertions } from '../assertions/all.js';
import { logger } from '../utils/logger.js';

export interface PipelineOptions {
  cfg: AppConfig;
  session: Session;
  taskDef: TaskDef;
  handler: SceneHandler | null;
  func?: string;
}

export interface PipelineResult {
  submit: SubmitResult;
  billingData: BillingData;
  checks: any[];
  impact: any[];
  responses: any[];
  manual: Array<{ id: string; steps: string }>;
  issues: any[];
  passRate: number;
  assetInfo: any;
  semiAuto: boolean;
  taskId: number | null;
}

export class Pipeline {
  hooks: HookRegistry;
  private opts: PipelineOptions;

  constructor(opts: PipelineOptions, hooks: HookRegistry = new HookRegistry()) {
    this.opts = opts;
    this.hooks = hooks;
  }

  /** 组装执行上下文（供场景处理器与钩子） */
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

  /** 执行完整流水线，返回结果（供报告器使用） */
  async run(): Promise<PipelineResult> {
    const { cfg, session, taskDef, handler } = this.opts;
    const semiAuto = !handler;
    const env = session.env;
    const ctx = this.buildCtx();

    await this.hooks.run('beforeAll', ctx);
    logger.step(`========== 开始执行：${taskDef.name}（${env} 环境） ==========`);
    logger.info(`场景类型：${taskDef.scene} → ${handler ? `已接入（${handler.name}）` : '未接入（半自动执行）'}`);

    // ── 通用骨架 ──
    // 1. 登录态
    logger.step('[1/10] 数据需求清单检查...');
    const baseUrl = cfg.environments[env].base_url;
    const exp = new Date(session.token_exp * 1000);
    logger.info(`登录态：${session.account || session.nickname}（过期时间 ${exp.toLocaleString('zh-CN')}）`);
    if (exp < new Date()) logger.warn('登录态已过期，请重新提供');
    else logger.info('登录态有效');

    // 2. 素材库
    logger.step('[2/10] 素材库检查（Test-panqu）...');
    const assets = new Assets();
    const assetScan = assets.scan();
    if (assetScan.exists) {
      logger.info(`  image=${assetScan.byType.image.length} | audio=${assetScan.byType.audio.length} | video=${assetScan.byType.video.length} | text=${assetScan.byType.text.length}`);
    }
    ctx.assets = assets;

    // 3. 影响分析
    logger.step('[3/10] 数据隔离/影响分析...');
    const impact = buildImpactList(taskDef);
    ctx.impact = impact;

    // 4. HTTP + 计费
    const http = new Http(baseUrl, session.cookie_string);
    const billing = new Billing(http, cfg.environments[env].billing_url!);
    ctx.http = http;

    // 5. 素材引用解析
    logger.step('[4/10] 素材引用解析...');
    const resolvedAssets: any[] = [];
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

    // 提交任务
    if (!taskId) {
      if (handler) {
        await this.hooks.run('beforeStep', ctx);
        logger.step('[5/10] 提交任务...');
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

    // 详情 + 状态
    if (taskId && handler) {
      await this.hooks.run('beforeStep', ctx);
      logger.step('[6/10] 查询任务详情（落库核对）...');
      await handler.detail(ctx);
      await this.hooks.run('afterStep', ctx);

      await this.hooks.run('beforeStep', ctx);
      logger.step('[7/10] 查询任务状态...');
      await handler.status(ctx);
      await this.hooks.run('afterStep', ctx);
    }

    // 计费核验
    logger.step('[8/10] 计费核验...');
    let billingData: BillingData = {};
    try {
      const summary = await billing.summary();
      const trend = await billing.modelTrend();
      const top = await billing.modelTop();
      const records = await billing.records(50);
      billingData = handler
        ? handler.analyzeBilling({ summary, trend, top, records }, session)
        : { summary, trend, top, records, modelTrend: { found: false, modelName: taskDef.model_name || '' }, net: 0 };
      const mt = billingData.modelTrend;
      logger.info(`  summary: consumed_7d=${summary.consumed_7d}, available_points=${summary.available_points}`);
      logger.info(`  模型趋势: ${mt?.found ? mt.modelName + ' 最新值=' + mt.lastValue : '未找到对应模型系列'}`);
      logger.info(`  近50条明细净消耗=${billingData.net}`);
    } catch (e: any) {
      logger.warn(`计费核验异常：${e.message}`);
    }

    // 数据隔离核验
    logger.step('[9/10] 数据隔离核验...');
    const verifyDef = { ...taskDef, account: session.account || session.nickname, project_id: session.project_id };
    const checks = runDefaultAssertions(verifyDef, ctx.submit, billingData);
    checks.forEach((c: any) => logger.info(`  ${c.pass ? '✅' : '❌'} ${c.name}：${c.detail}`));

    await this.hooks.run('afterScene', ctx);

    // ── 汇总报告数据 ──
    const manual = (taskDef.manual_cases || []).map((m: any) => ({ id: m.id, steps: m.steps }));
    const issues: any[] = [];
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
      taskId,
    };
  }
}
