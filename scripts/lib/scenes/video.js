// 视频场景处理器：封装文生视频 / 图生视频 / 全能参考 / 首尾帧 的提交、详情、状态、计费分析
// 这是插件式架构的第一个场景处理器。新模块接入时：
//   1. 在本目录新建 <scene>.js，暴露相同的 match/submit/detail/status/analyzeBilling 接口
//   2. 在 run-test.js 的 SCENES 注册表注册即可，不碰主流程
const fs = require('fs');
const path = require('path');
const { resolveExtraValue } = require('../assets');

class VideoSceneHandler {
  constructor() {
    this.name = 'video';
    this.scenes = ['文生视频', '图生视频', '全能参考', '首尾帧'];
  }

  match(scene) {
    return this.scenes.some(s => (scene || '').includes(s));
  }

  // 提交任务（原 run-test.js 4.2 逻辑）
  async submit(ctx) {
    const { http, session, taskDef, assets, CFG, env, responses } = ctx;
    const token = await http.getCsrfToken(CFG.environments[env].csrf_page + '?project_id=' + session.project_id);
    console.log('  CSRF token: ' + token.slice(0, 16) + '...');

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
          console.log('  上传 ' + u.field + ': ' + path.basename(full));
        }
      }
    }

    const r = await http.api('提交任务', 'POST', CFG.environments[env].submit_url, { form: fd });
    const j = r.json;
    responses.push({ name: '提交任务', method: 'POST', status: r.status, code: j.code, summary: JSON.stringify(j.data || j).slice(0, 300) });
    let taskId = null;
    if (j.code === 1) {
      taskId = j.data && (j.data.id || j.data.task_id || j.data.extra && j.data.extra.id);
      console.log('  提交成功，任务 ID = ' + taskId);
    }
    return { taskId, submit: { status: j.code === 1 ? '已提交' : '提交失败', err: j.code === 1 ? undefined : (j.msg || JSON.stringify(j).slice(0, 300)) } };
  }

  // 查询任务详情（落库核对，原 4.3 逻辑）
  async detail(ctx) {
    const { http, session, CFG, env, responses, submit, taskId } = ctx;
    const detailRes = await http.api('任务详情', 'GET',
      `${CFG.environments[env].detail_url}?id=${taskId}&project_id=${session.project_id}&task_log_id=0`);
    const dj = detailRes.json;
    responses.push({ name: '任务详情', method: 'GET', status: detailRes.status, code: dj.code, summary: JSON.stringify(dj.data || dj).slice(0, 300) });
    if (dj.code === 1 && dj.data) {
      const d = dj.data;
      let extra = d.extra || {};
      if (typeof extra === 'string') { try { extra = JSON.parse(extra); } catch {} }
      submit.detail = { ...d, extra };
      console.log('  模型 model_id=' + d.model_id + '，任务类型 type=' + d.type + '，提示词=' + (d.cueword || '').slice(0, 30));
    } else {
      console.log('  详情查询返回异常：' + JSON.stringify(dj).slice(0, 200));
    }
  }

  // 查询任务状态（原 4.4 逻辑）
  async status(ctx) {
    const { http, session, CFG, env, responses, submit, taskId } = ctx;
    const stFd = new FormData();
    stFd.append('type', 'video');
    stFd.append('ids', String(taskId));
    const stRes = await http.api('任务状态', 'POST', CFG.environments[env].status_url, { form: stFd });
    const sj = stRes.json;
    responses.push({ name: '任务状态', method: 'POST', status: stRes.status, code: sj.code, summary: JSON.stringify(sj.data || sj).slice(0, 300) });
    const st = (sj.data && sj.data[0] && sj.data[0].status) || {};
    const stText = CFG.status_text[st.task_status] || ('未知(' + st.task_status + ')');
    submit.status = stText;
    submit.progress = st.progress;
    submit.videoUrl = st.video_url || '';
    submit.err = st.err || '';
    console.log('  任务状态=' + stText + '（' + st.task_status + '），progress=' + st.progress + (st.video_url ? '，video_url=' + st.video_url : ''));
    if (st.err) console.log('  错误信息：' + st.err);
  }

  // 计费分析（原 4.5 逻辑）：从通用 billingData 中提取本场景模型趋势与净消耗
  // 返回通用结构 { summary, trend, top, records, modelTrend:{found,lastValue,modelName}, net }
  analyzeBilling(billingData, session) {
    const trend = billingData.trend || { series: [] };
    const modelSeries = (trend.series || []).find(s => /wan/i.test(s.name || ''));
    const values = modelSeries ? modelSeries.values || [] : [];
    const lastValue = values.length ? values[values.length - 1] : null;

    let net = 0;
    const taskRecords = (billingData.records || []).filter(r => r.project_id === session.project_id);
    for (const r of taskRecords) net += Number(r.points || 0);

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

module.exports = { VideoSceneHandler };
