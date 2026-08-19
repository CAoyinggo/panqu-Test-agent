// Phase 26.7 Observability / Alerting — E2E（真实飞书通道链路）
// 用本地 HTTP mock 飞书端点（真实 Node http server + 真实 fetch POST）验证：
// - 真实业务链路：BLOCK Run 真实发布 ReleaseBlock / P0Failure / RunFailed 告警并到达飞书
// - 真实业务链路：REVIEW Run 真实发布 ApprovalRequested（含 approvalId）
// - 事件层：WorkerOffline / ProductionDeny（真实事件总线 + 真实 HTTP 投递）
// - 6 类关键通知均含丰富上下文（run / env / timestamp），payload 为飞书 text 风格
//
// 若配置了真实 FEISHU_WEBHOOK_URL，同一链路真实投递飞书（本测试用本地 mock 保证离线可复现）。

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { createPlatformService } from '../../src/platform/service/index.js';
import type { PlatformBundle } from '../../src/platform/service/index.js';
import { makeRealRunExecutor } from '../../src/platform/ops/real-run.js';
import { runReleaseGateDrill } from '../../src/platform/ops/release-gate-drill.js';

const FIXED_ISO = '2026-08-18T00:00:00.000Z';

interface FeishuPayload {
  msg_type: string;
  content: { text: string };
}
interface MockFeishu {
  url: string;
  received: FeishuPayload[];
}

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closes.length) await (closes.pop()!)();
});

function startMockFeishu(): Promise<MockFeishu> {
  const received: FeishuPayload[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      try {
        received.push(JSON.parse(body));
      } catch {
        received.push({ msg_type: 'text', content: { text: body } });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 0 }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port;
      closes.push(() => new Promise((r) => server.close(() => r())));
      resolve({ url: `http://127.0.0.1:${port}/webhook`, received });
    });
  });
}

async function waitFor(received: unknown[], min: number, timeoutMs = 8000): Promise<void> {
  const start = Date.now();
  while (received.length < min) {
    if (Date.now() - start > timeoutMs) throw new Error(`超时：收到 ${received.length} 条，期望 ≥${min}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** 等待目标通知文本全部到达（按内容而非条数，避免并发下前置通知抢占等待窗口） */
async function waitForTexts(received: FeishuPayload[], keys: string[], timeoutMs = 12000): Promise<void> {
  const start = Date.now();
  const texts = () => received.map((r) => r.content.text);
  for (;;) {
    const all = texts();
    if (keys.every((k) => all.some((t) => t.includes(k)))) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`超时：${keys.join(' / ')} 未全部到达，当前收到 ${all.length} 条：${all.join('\n---\n')}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

function makeBundle(feishuUrl: string): PlatformBundle {
  const b = createPlatformService({ seedProject: true, feishuWebhookUrl: feishuUrl, now: () => FIXED_ISO });
  b.service.wireNotifications();
  return b;
}

async function runBlock(b: PlatformBundle): Promise<string> {
  const { runId } = await b.service.createRun({
    projectId: 'wan3', environment: 'test', trigger: 'manual', actor: 'qa', role: 'QA', feature: 'nt-block',
  });
  const exec = makeRealRunExecutor(b, 'sanity', {
    environment: 'test', now: () => FIXED_ISO,
    failCases: ['WAN3-CORE-001'], failReason: 'P0 核心链路回归（drill）',
  });
  await exec({ runId, projectId: 'wan3', environment: 'test', feature: 'nt-block' });
  return runId;
}

describe('26.7.1 真实业务链路：BLOCK Run → ReleaseBlock / P0Failure / RunFailed 告警', () => {
  it('发布阻塞、P0 失败、Run 失败三类告警真实到达飞书并含上下文', async () => {
    const m = await startMockFeishu();
    const b = makeBundle(m.url);
    await b.auth.ensureSeeded();
    await b.testAssets.importCatalog();
    const runId = await runBlock(b);
    await waitForTexts(m.received, ['发布阻塞', 'P0 失败', 'Run 失败']);
    const texts = m.received.map((r) => r.content.text);

    const block = texts.find((t) => t.includes('发布阻塞'));
    expect(block, '未收到 ReleaseBlock 通知').toBeTruthy();
    expect(block).toContain('[critical]');
    expect(block).toContain(runId);
    expect(block).toContain('P0 失败');
    expect(block).toContain('Release Gate 阻断');
    expect(block).toContain('env=test');
    expect(block).toContain(' t=');

    const p0 = texts.find((t) => t.includes('P0 失败'));
    expect(p0, '未收到 P0Failure 通知').toBeTruthy();
    expect(p0).toContain('WAN3-CORE-001');
    expect(p0).toContain('env=test');

    const failed = texts.find((t) => t.includes('Run 失败'));
    expect(failed, '未收到 RunFailed 通知').toBeTruthy();
    expect(failed).toContain(runId);
    expect(failed).toContain(' t=');
  });
});

describe('26.7.2 真实业务链路：REVIEW Run → ApprovalRequested 告警', () => {
  it('审批请求告警真实到达飞书，含 runId / env / approvalId', async () => {
    const m = await startMockFeishu();
    const b = makeBundle(m.url);
    await b.auth.ensureSeeded();
    const r = await runReleaseGateDrill(b, { environment: 'test', profile: 'regression' });
    expect(r.approvalStatus).toBe('PENDING');
    await waitForTexts(m.received, ['审批请求']);
    const texts = m.received.map((x) => x.content.text);
    const ar = texts.find((t) => t.includes('审批请求'));
    expect(ar, '未收到 ApprovalRequested 通知').toBeTruthy();
    expect(ar).toContain('env=test');
    expect(ar).toContain(r.approvalId!);
    expect(ar).toContain(' t=');
  });
});

describe('26.7.3 事件层：WorkerOffline / ProductionDeny 告警', () => {
  it('Worker 下线与生产访问拒绝告警经真实事件总线 + 真实 HTTP 到达飞书', async () => {
    const m = await startMockFeishu();
    const b = makeBundle(m.url);
    await b.auth.ensureSeeded();
    await b.bus.publish({ type: 'WorkerOffline', data: { workerId: 'w1', reason: 'simulated-crash', environment: 'test', projectId: 'wan3' } });
    await b.bus.publish({ type: 'ProductionDeny', data: { actor: 'autonomous-agent', action: 'deploy', environment: 'production', projectId: 'wan3' } });
    await waitForTexts(m.received, ['Worker 下线', '生产访问被拒']);
    const texts = m.received.map((x) => x.content.text);
    const wo = texts.find((t) => t.includes('Worker 下线'));
    expect(wo, '未收到 WorkerOffline 通知').toBeTruthy();
    expect(wo).toContain('w1');
    expect(wo).toContain('simulated-crash');
    expect(wo).toContain('env=test');
    const pd = texts.find((t) => t.includes('生产访问被拒'));
    expect(pd, '未收到 ProductionDeny 通知').toBeTruthy();
    expect(pd).toContain('autonomous-agent');
    expect(pd).toContain('deploy');
    expect(pd).toContain('env=production');
  });
});

describe('26.7.4 6 类通知均含丰富上下文 + 飞书 text payload 结构', () => {
  it('ReleaseBlock / P0Failure / RunFailed / ApprovalRequested / WorkerOffline / ProductionDeny 全部含 [run= env= t=] 上下文', async () => {
    const m = await startMockFeishu();
    const b = makeBundle(m.url);
    await b.auth.ensureSeeded();
    await b.testAssets.importCatalog();
    await runBlock(b);
    await runReleaseGateDrill(b, { environment: 'test', profile: 'regression' });
    await b.bus.publish({ type: 'WorkerOffline', data: { workerId: 'w1', reason: 'simulated-crash', environment: 'test', projectId: 'wan3' } });
    await b.bus.publish({ type: 'ProductionDeny', data: { actor: 'autonomous-agent', action: 'deploy', environment: 'production', projectId: 'wan3' } });

    const expected = ['发布阻塞', 'P0 失败', 'Run 失败', '审批请求', 'Worker 下线', '生产访问被拒'];
    await waitForTexts(m.received, expected);
    const texts = m.received.map((x) => x.content.text);
    for (const key of expected) {
      const t = texts.find((x) => x.includes(key));
      expect(t, `未收到通知：${key}`).toBeTruthy();
      expect(t, `${key} 缺少 [run= 上下文`).toContain('[run=');
      expect(t, `${key} 缺少 env= 上下文`).toContain('env=');
      expect(t, `${key} 缺少 t= 时间戳`).toContain(' t=');
    }
    // 每条飞书 payload 均为 text 风格（msg_type + content.text）
    for (const r of m.received) {
      expect(r.msg_type).toBe('text');
      expect(r.content.text.length).toBeGreaterThan(0);
    }
  });
});
