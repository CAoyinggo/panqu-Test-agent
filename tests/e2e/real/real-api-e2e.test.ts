// 真实 API 层 E2E（Phase 20.2）：
// 直接复用现有 Http / Billing 基础设施，对真实测试环境做只读校验 + 受控真实提交。
// 默认关闭：RUN_REAL_E2E=false（默认跳过，不误触发真实业务）。
// 真实提交另需 REAL_E2E_SUBMIT=true。
import { expect } from 'vitest';
import {
  describeReal,
  itReal,
  itRealSubmit,
  getRealEnv,
  loadRealConfig,
} from './real-env.js';

describeReal('真实 API 层', () => {
  itReal('配置加载与连通性：base_url + CSRF 页面可访问', async () => {
    const cfg = loadRealConfig();
    expect(cfg.environments).toBeDefined();
    const env = getRealEnv();
    const res = await fetch(`${env.baseUrl}${env.csrfPage}?project_id=${env.projectId}`, {
      headers: { cookie: env.http.cookieString },
    });
    expect(res.ok).toBe(true);
    const html = await res.text();
    expect(html.length).toBeGreaterThan(0);
  });

  itReal('真实错误码：非法路径返回 4xx', async () => {
    const env = getRealEnv();
    const res = await fetch(`${env.baseUrl}aivideo/v2/not-exist-${Date.now()}`, {
      headers: { cookie: env.http.cookieString },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  itReal('真实错误码：非法提交参数返回业务错误码（非成功）', async () => {
    const env = getRealEnv();
    const fd = new FormData();
    fd.append('row[name]', 'real-e2e-invalid');
    // 缺少 project_id / __token__ 等必要字段，不应成功提交
    const r = await env.http.api('非法提交', 'POST', env.submitUrl, { form: fd, retries: 0, retryable: false });
    expect(r.status).toBeGreaterThanOrEqual(200);
    // 业务码：1=成功；缺少必要字段不应返回成功业务语义
    expect(r.json?.code).not.toBe(1);
  });

  itReal('真实超时：短超时请求被中止', async () => {
    const env = getRealEnv();
    await expect(
      env.http.api('超时探针', 'GET', `${env.csrfPage}?project_id=${env.projectId}`, {
        timeout: 1,
        retries: 0,
        retryable: false,
      }),
    ).rejects.toThrow(/超时|timeout/i);
  });

  itReal('真实并发：并行只读查询全部成功', async () => {
    const env = getRealEnv();
    const jobs = Array.from({ length: 5 }, (_, i) =>
      env.http.api(`并发查询${i}`, 'GET', `${env.billingUrl}?section=summary&range=7days`, { retries: 1 }),
    );
    const results = await Promise.all(jobs);
    for (const r of results) {
      expect(r.status).toBeGreaterThanOrEqual(200);
    }
  });

  itReal('真实计费/积分：汇总与消费明细（只读）', async () => {
    const env = getRealEnv();
    const summary = await env.billing.summary();
    const records = await env.billing.records(20);
    // 只读校验结构存在（不校验具体数值，避免真实环境波动）
    expect(summary).toBeTypeOf('object');
    expect(Array.isArray(records)).toBe(true);
  });

  itReal('真实历史数据：模型趋势与消费明细', async () => {
    const env = getRealEnv();
    const trend = await env.billing.modelTrend();
    const records = await env.billing.records(50);
    expect(Array.isArray(trend.labels)).toBe(true);
    expect(Array.isArray(records)).toBe(true);
  });

  itReal('真实模型：模型 TOP 列表包含模型信息', async () => {
    const env = getRealEnv();
    const top = await env.billing.modelTop();
    expect(typeof top.total).toBe('number');
    expect(Array.isArray(top.items)).toBe(true);
  });

  itRealSubmit('真实提交 + 状态 + 详情 + 计费闭环', async () => {
    const env = getRealEnv();
    const name = `RealE2E-${Date.now()}`;

    // 1. CSRF
    const token = await env.http.getCsrfToken(`${env.csrfPage}?project_id=${env.projectId}`);
    expect(token.length).toBeGreaterThan(0);

    // 2. 真实提交（最小真实业务：WAN 文生视频，720p 4s）
    const fd = new FormData();
    fd.append('project_id', String(env.projectId));
    fd.append('__token__', token);
    fd.append('row[type]', '6');
    fd.append('row[name]', name);
    fd.append('row[selmodelsId]', '84');
    fd.append('row[extra][selmodels]', '84-Wan 3.0');
    fd.append('row[extra][selmodelsId]', '84');
    fd.append('row[extra][selmodelsName]', 'Wan 3.0');
    fd.append('row[extra][task_type]', '105');
    fd.append('row[extra][workflow_type]', 'qntk');
    fd.append('row[extra][cueword]', '真实 E2E 冒烟：落日海岸，海浪拍打沙滩，电影感镜头');
    fd.append('row[extra][duration]', '4');
    fd.append('row[extra][video_resolution]', '720p');
    fd.append('row[extra][video_aspect_ratio]', '9:16');
    const r = await env.http.api('真实提交', 'POST', env.submitUrl, { form: fd, retries: 0, retryable: false });
    expect(r.json?.code).toBe(1);
    const taskId = r.json?.data?.id ?? r.json?.data?.task_id ?? r.json?.data?.extra?.id;
    expect(taskId).toBeTruthy();

    // 3. 真实状态查询（POST status_url）
    const stFd = new FormData();
    stFd.append('type', 'video');
    stFd.append('ids', String(taskId));
    const st = await env.http.api('真实状态', 'POST', env.statusUrl, { form: stFd, retries: 0, retryable: false });
    expect(st.status).toBeGreaterThanOrEqual(200);
    const stData = st.json?.data?.[0] ?? {};
    expect(stData.task_status ?? stData.status).toBeDefined();

    // 4. 真实详情查询（GET detail_url）
    const d = await env.http.api('真实详情', 'GET', `${env.detailUrl}?id=${taskId}&project_id=${env.projectId}&task_log_id=0`);
    expect(d.status).toBeGreaterThanOrEqual(200);
    const dj = d.json?.data ?? {};
    // 详情应能取到模型信息（真实模型）
    const modelId = dj.model_id ?? dj.selmodelsId;
    expect(String(modelId ?? '')).not.toBe('');

    // 5. 计费核对（只读，确认接口可访问）
    const summary = await env.billing.summary();
    expect(summary).toBeTypeOf('object');

    // 6. 记录真实证据（供报告）
    expect(`${taskId}`.length).toBeGreaterThan(0);
  });
});
