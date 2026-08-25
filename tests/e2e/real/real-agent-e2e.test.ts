// 真实 Agent 全链路 E2E（Phase 20.2）：
// 需求 → 测试设计 → 风险 → 选择 → 覆盖 → 数据 → 真实 API（提交/状态/计费）→ 断言 →
// 分析 → RCA → 缺陷草稿 → 记忆写入，全链路跑通且包含真实 API 证据。
// 默认关闭：需 RUN_REAL_E2E=true 且 REAL_E2E_SUBMIT=true（真实提交业务副作用门槛）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  createAgentContext,
  createDataPrepareTool,
  createExecutionRunTool,
  JsonMemoryStore,
  ToolRegistry,
  runAgentPipeline,
} from '../../../src/agents/index.js';
import { computeOutcome } from '../../../src/agents/execution/execution-schema.js';
import type { ExecutionOutcome, CaseExecutionResult } from '../../../src/agents/execution/execution-schema.js';
import type { LoadedCase } from '../../../src/cases/loader.js';
import { MockLLMProvider } from '../../../src/llm/index.js';
import { REAL_ENABLED, REAL_SUBMIT, getRealEnv } from './real-env.js';

/** 真实冒烟执行器：每个用例提交一个最小真实 WAN 任务并查询状态（受上限约束） */
export async function realSmokeRunner(
  cases: LoadedCase[],
  options: { env?: string } = {},
): Promise<ExecutionOutcome> {
  const env = getRealEnv(options.env ?? 'test');
  const MAX = Math.max(1, Number(process.env.REAL_E2E_MAX_CASES ?? 2));
  const results: CaseExecutionResult[] = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const caseId = String(c.def?.extra?.agentTestCaseId ?? c.def?.name ?? c.name);

    // 超过真实提交上限的用例标记为未执行（不误触发真实业务）
    if (i >= MAX) {
      results.push({
        caseId,
        name: c.name ?? caseId,
        feature: c.feature ?? 'real',
        executed: false,
        status: 'NOT_EXECUTED',
        pass: false,
        passRate: 0,
        error: `REAL_E2E_MAX_CASES=${MAX}：达到真实提交上限，未执行`,
        durationMs: 0,
        checks: [{ name: 'real-smoke-skip', pass: false, detail: `未在真实冒烟中执行（上限 ${MAX}）`, kind: 'SKIPPED' }],
      });
      continue;
    }

    const t0 = Date.now();
    try {
      const token = await env.http.getCsrfToken(`${env.csrfPage}?project_id=${env.projectId}`);
      const fd = new FormData();
      fd.append('project_id', String(env.projectId));
      fd.append('__token__', token);
      fd.append('row[type]', '6');
      fd.append('row[name]', `${c.name ?? caseId}-${Date.now()}`);
      fd.append('row[selmodelsId]', '84');
      fd.append('row[extra][selmodels]', '84-Wan 3.0');
      fd.append('row[extra][selmodelsId]', '84');
      fd.append('row[extra][selmodelsName]', 'Wan 3.0');
      fd.append('row[extra][task_type]', '105');
      fd.append('row[extra][workflow_type]', 'qntk');
      fd.append('row[extra][cueword]', '真实 Agent 冒烟：落日海岸，海浪拍打沙滩，电影感镜头');
      fd.append('row[extra][duration]', '4');
      fd.append('row[extra][video_resolution]', '720p');
      fd.append('row[extra][video_aspect_ratio]', '9:16');

      const r = await env.http.api('真实提交', 'POST', env.submitUrl, { form: fd, retries: 0, retryable: false });
      const j = r.json;
      const ok = j.code === 1;
      const taskId = ok ? (j.data?.id ?? j.data?.task_id ?? j.data?.extra?.id) : null;

      // 真实状态查询（1 轮）
      let statusDetail = '';
      if (taskId != null) {
        const stFd = new FormData();
        stFd.append('type', 'video');
        stFd.append('ids', String(taskId));
        const st = await env.http.api('真实状态', 'POST', env.statusUrl, { form: stFd, retries: 0, retryable: false });
        const s0 = st.json?.data?.[0] ?? {};
        statusDetail = `status=${s0.task_status ?? s0.status} progress=${s0.progress}`;
      }

      // 真实计费只读快照（确认积分接口可达）
      const billingOk = typeof (await env.billing.summary()) === 'object';

      results.push({
        caseId,
        name: c.name ?? caseId,
        feature: c.feature ?? 'real',
        processor: 'real-wan3-api',
        processorInvoked: true,
        executed: true,
        status: ok ? 'PASS' : 'FAIL',
        pass: ok,
        passRate: ok ? 100 : 0,
        error: ok ? undefined : (j.msg ?? JSON.stringify(j).slice(0, 300)),
        durationMs: Date.now() - t0,
        checks: [
          {
            name: 'real-submit',
            pass: ok,
            detail: `code=${j.code} taskId=${taskId ?? 'none'} ${statusDetail} billing=${billingOk}`,
            kind: 'BUSINESS',
          },
        ],
      });
    } catch (e) {
      results.push({
        caseId,
        name: c.name ?? caseId,
        feature: c.feature ?? 'real',
        processor: 'real-wan3-api',
        processorInvoked: true,
        executed: true,
        status: 'FAIL',
        pass: false,
        passRate: 0,
        error: (e as Error).message,
        durationMs: Date.now() - t0,
        checks: [{
          name: 'real-submit',
          pass: false,
          detail: `真实提交失败：${(e as Error).message}`,
          kind: 'BUSINESS',
        }],
      });
    }
  }

  return computeOutcome('real', results, {
    summary: `真实冒烟完成：提交 ${Math.min(cases.length, MAX)}/${cases.length} 条`,
  });
}

const ENABLED = REAL_ENABLED && REAL_SUBMIT;

describe.skipIf(!ENABLED)('[real] Agent 全链路（真实 API）', () => {
  it('需求→设计→风险→选择→覆盖→数据→真实API→断言→分析→RCA→缺陷→记忆', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'real-agent-'));
    const file = path.join(dir, 'memory.json');
    try {
      const memory = new JsonMemoryStore(file);
      const tools = new ToolRegistry();
      tools.register(createDataPrepareTool());
      tools.register(createExecutionRunTool(realSmokeRunner));

      const context = createAgentContext({
        taskId: `real-agent-${Date.now()}`,
        feature: 'wan3',
        environment: 'test',
        tools,
        memory,
        llm: new MockLLMProvider(),
      });

      const r = await runAgentPipeline(
        {
          requirementText: '测试 WAN3 文生视频，验证任务提交、状态查询与积分扣费',
          environment: 'test',
          options: {
            maxRca: 5,
            maxDefects: 5,
            executionApproval: { id: 'real-e2e-opt-in', status: 'APPROVED', approvedBy: 'real-e2e-operator' },
          },
        },
        context,
      );

      // 需求 / 设计 / 风险
      expect(r.stages.requirement).toBe(true);
      expect(r.testCases.length).toBeGreaterThan(0);
      expect(r.stages.risk).toBe(true);

      // 选择 / 覆盖 / 数据
      expect(r.stages.selection).toBe(true);
      expect(r.stages.coverage).toBe(true);
      expect(r.dataPlan).toBeDefined();

      // 真实 API 执行 + 断言
      expect(r.outcome.executed).toBe(true);
      const realChecks = (r.outcome.results ?? []).flatMap((x) => x.checks ?? []).filter((c) => c.name === 'real-submit');
      expect(realChecks.length).toBeGreaterThan(0);

      // 分析
      expect(r.stages.analysis).toBe(true);
      expect(r.report).toBeDefined();

      // 记忆写入（真实执行证据已沉淀）
      expect(memory.count()).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
