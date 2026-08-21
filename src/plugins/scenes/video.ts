// 视频场景处理器：文生视频 / 图生视频 / 全能参考 / 首尾帧
// 实现 SceneHandler 接口，封装提交/详情/状态/计费分析
import type { RunContext, SubmitResult, BillingData } from '../../core/types.js';
import type { SceneHandler } from '../../core/scene-handler.js';
import type { CanonicalSceneId } from '../../core/canonical-scene.js';
import { resolveExtraValue } from '../../integrations/assets.js';
import { logger } from '../../utils/logger.js';
import fs from 'node:fs';
import path from 'node:path';

export class VideoSceneHandler implements SceneHandler {
  name = 'video';
  supportedScenes = ['video'] as const satisfies readonly CanonicalSceneId[];

  supports(scene: CanonicalSceneId): boolean {
    return this.supportedScenes.includes(scene);
  }

  async submit(ctx: RunContext): Promise<{ taskId: number | null; submit: Partial<SubmitResult> }> {
    const { http, session, taskDef, assets, CFG, env } = ctx;
    const token = await http.getCsrfToken(CFG.environments[env].csrf_page + '?project_id=' + session.project_id);
    logger.info('  CSRF token: ' + token.slice(0, 16) + '...');

    const fd = new FormData();
    fd.append('project_id', String(session.project_id));
    fd.append('__token__', token);
    fd.append('row[type]', String(taskDef.type || 6));
    fd.append('row[name]', taskDef.name);
    if (taskDef.selmodelsId) fd.append('row[selmodelsId]', String(taskDef.selmodelsId));
    const ex = taskDef.extra || {};
    for (const [k, v] of Object.entries(ex)) {
      if (v === undefined || v === null) continue;
      const val = await resolveExtraValue(http, assets, v);
      fd.append('row[extra][' + k + ']', val);
    }
    if (taskDef.uploads && Array.isArray(taskDef.uploads)) {
      for (const u of taskDef.uploads) {
        const full = assets.resolve(u.path);
        if (full && fs.existsSync(full)) {
          fd.append(u.field, new Blob([fs.readFileSync(full)], { type: 'application/octet-stream' }), path.basename(full));
          logger.info('  上传 ' + u.field + ': ' + path.basename(full));
        }
      }
    }

    const r = await http.api('提交任务', 'POST', CFG.environments[env].submit_url, { form: fd });
    const j = r.json;
    ctx.responses.push({ name: '提交任务', method: 'POST', status: r.status, code: j.code, summary: JSON.stringify(j.data || j).slice(0, 300) });
    let taskId: number | null = null;
    if (j.code === 1) {
      taskId = j.data && (j.data.id || j.data.task_id || (j.data.extra && j.data.extra.id)) || null;
      logger.info('  提交成功，任务 ID = ' + taskId);
    }
    return {
      taskId,
      submit: {
        status: j.code === 1 ? '已提交' : '提交失败',
        err: j.code === 1 ? undefined : j.msg || JSON.stringify(j).slice(0, 300),
      },
    };
  }

  async detail(ctx: RunContext): Promise<void> {
    const { http, session, CFG, env, submit, taskId } = ctx;
    const detailRes = await http.api(
      '任务详情',
      'GET',
      `${CFG.environments[env].detail_url}?id=${taskId}&project_id=${session.project_id}&task_log_id=0`,
    );
    const dj = detailRes.json;
    ctx.responses.push({ name: '任务详情', method: 'GET', status: detailRes.status, code: dj.code, summary: JSON.stringify(dj.data || dj).slice(0, 300) });
    if (dj.code === 1 && dj.data) {
      const d = dj.data;
      let extra = d.extra || {};
      if (typeof extra === 'string') {
        try {
          extra = JSON.parse(extra);
        } catch {
          /* ignore */
        }
      }
      submit.detail = { ...d, extra };
      logger.info(`  模型 model_id=${d.model_id}，任务类型 type=${d.type}，提示词=${(d.cueword || '').slice(0, 30)}`);
    } else {
      logger.warn('  详情查询返回异常：' + JSON.stringify(dj).slice(0, 200));
    }
  }

  async status(ctx: RunContext): Promise<void> {
    const { http, session, CFG, env, submit, taskId, taskDef } = ctx;
    const maxWaitMs = ((taskDef.max_wait_seconds as number) || 120) * 1000;
    const pollIntervalMs = 3000;
    const startedAt = Date.now();
    const history: string[] = [];

    while (true) {
      const stFd = new FormData();
      stFd.append('type', 'video');
      stFd.append('ids', String(taskId));
      const stRes = await http.api('任务状态', 'POST', CFG.environments[env].status_url, { form: stFd });
      const sj = stRes.json;
      // 仅首次轮询记录到 responses（避免刷屏）
      if (history.length === 0) {
        ctx.responses.push({ name: '任务状态', method: 'POST', status: stRes.status, code: sj.code, summary: JSON.stringify(sj.data || sj).slice(0, 300) });
      }
      const st = (sj.data && sj.data[0] && sj.data[0].status) || {};
      const stText = CFG.status_text[st.task_status] || ('未知(' + st.task_status + ')');
      submit.status = stText;
      submit.progress = st.progress;
      submit.videoUrl = st.video_url || '';
      submit.err = st.err || '';
      history.push(stText);
      submit.statusHistory = history;

      logger.info(
        `  任务状态=${stText}（${st.task_status}），progress=${st.progress}` + (st.video_url ? '，video_url=' + st.video_url : ''),
      );
      if (st.err) logger.warn('  错误信息：' + st.err);

      // 终态判断：完成 / 失败
      const isTerminal = stText.includes('完成') || stText.includes('失败');
      if (isTerminal) {
        logger.info(`  任务到达终态：${stText}（轮询 ${history.length} 次，耗时 ${Date.now() - startedAt}ms）`);
        break;
      }

      // 超时判断
      if (Date.now() - startedAt >= maxWaitMs) {
        logger.warn(`  任务未在 ${maxWaitMs / 1000}s 内到达终态（当前状态=${stText}），继续出报告`);
        break;
      }

      await new Promise((r) => setTimeout(r, pollIntervalMs));
    }
  }

  analyzeBilling(billingData: BillingData, _session: any): BillingData {
    const trend = billingData.trend || { series: [] };
    const modelSeries = (trend.series || []).find((s) => /wan/i.test(s.name || ''));
    const values = modelSeries ? modelSeries.values || [] : [];
    const lastValue = values.length ? values[values.length - 1] : null;

    let net = 0;
    const records = billingData.records || [];
    for (const r of records) net += Number(r.points || 0);

    return {
      ...billingData,
      modelTrend: {
        found: !!modelSeries,
        lastValue,
        modelName: modelSeries ? modelSeries.name : 'Wan 3.0',
      },
      net,
    };
  }
}
