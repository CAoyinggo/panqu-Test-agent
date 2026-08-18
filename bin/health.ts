#!/usr/bin/env node
// Agent Health（Phase 20.8）：运行时健康自检
// 检查项：
//   1. 配置可加载（test 环境）
//   2. LLM Provider 往返（默认 Mock 离线；配置真实 LLM 则探活）
//   3. 最小流水线（skipExecution：需求 → 用例生成）
//   4. 生产环境安全策略（production 默认关闭）
//   5. 持久化 output/health.json
// 用法：node dist/bin/health.js [--json]
// 退出码：0 健康 / 1 异常
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, getEnvironment } from '../src/config/config.js';
import { createRuntimeLLM } from '../src/config/llm.js';
import { createAgentContext, ToolRegistry, NoopMemory, runAgentPipeline, createDataPrepareTool } from '../src/agents/index.js';
import { describeEnvironmentPolicy, guardProductionAction } from '../src/config/environment-policy.js';
import { ensureDir } from '../src/utils/fs-utils.js';

interface HealthEntry {
  name: string;
  ok: boolean;
  detail: string;
}

async function checkConfig(): Promise<HealthEntry> {
  try {
    const cfg = loadConfig('test');
    const env = getEnvironment(cfg, 'test');
    return { name: '配置加载', ok: true, detail: `test 环境 base_url=${env.base_url} project_id=${env.project_id}` };
  } catch (e) {
    return { name: '配置加载', ok: false, detail: (e as Error).message };
  }
}

async function checkLLM(): Promise<HealthEntry> {
  try {
    const llm = createRuntimeLLM({});
    const res = await llm.generate({ messages: [{ role: 'user', content: 'health-check' }] });
    const ok = !!res && res.content !== undefined;
    return {
      name: 'LLM 往返',
      ok,
      detail: `${llm.name} 往返成功（provider=${llm.name}，返回 ${String(res.content).length} 字符）`,
    };
  } catch (e) {
    return { name: 'LLM 往返', ok: false, detail: `LLM 往返失败：${(e as Error).message}` };
  }
}

async function checkPipeline(): Promise<HealthEntry> {
  try {
    const llm = createRuntimeLLM({});
    const tools = new ToolRegistry();
    tools.register(createDataPrepareTool());
    const context = createAgentContext({
      taskId: 'health-check',
      feature: 'wan3',
      environment: 'test',
      tools,
      memory: new NoopMemory(),
      llm,
    });
    const result = await runAgentPipeline(
      {
        requirementText: '测试 WAN3 文生视频提交任务，验证 720P 与 1080P 分辨率、任务状态为 SUCCESS、积分正确扣除',
        environment: 'test',
        options: { skipExecution: true },
      },
      context,
    );
    const ok = result.testCases.length > 0 && !!result.requirement?.feature;
    return { name: '最小流水线', ok, detail: `生成用例 ${result.testCases.length} 条（feature=${result.requirement.feature}）` };
  } catch (e) {
    return { name: '最小流水线', ok: false, detail: `流水线异常：${(e as Error).message}` };
  }
}

function checkPolicy(): HealthEntry {
  const policy = describeEnvironmentPolicy();
  const prod = guardProductionAction('production', 'read-only');
  const ok = !policy.productionEnabled;
  return {
    name: '生产安全策略',
    ok,
    detail: ok
      ? `production 默认关闭（${policy.forbidden.length} 项危险动作被守卫）`
      : `TESTFLOW_ALLOW_PRODUCTION=true 已设置：${prod.reason}`,
  };
}

export async function runHealth(): Promise<{ ok: boolean; entries: HealthEntry[]; summary: string }> {
  const entries: HealthEntry[] = [];
  entries.push(await checkConfig());
  entries.push(await checkLLM());
  entries.push(await checkPipeline());
  entries.push(checkPolicy());
  const ok = entries.every((e) => e.ok);
  const summary = `${ok ? 'HEALTHY' : 'DEGRADED'}：${entries.filter((e) => e.ok).length}/${entries.length} 项通过`;
  return { ok, entries, summary };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const json = process.argv.includes('--json');
  runHealth()
    .then((h) => {
      if (json) {
        console.log(JSON.stringify(h, null, 2));
      } else {
        console.log('════════ Agent Health ════════');
        for (const e of h.entries) console.log(`  ${e.ok ? '✅' : '❌'} ${e.name}：${e.detail}`);
        console.log(`结果：${h.summary}`);
        console.log('════════════════════════════');
      }
      const dir = process.env.TESTFLOW_OUTPUT_DIR || path.join(process.cwd(), 'output');
      ensureDir(dir);
      fs.writeFileSync(path.join(dir, 'health.json'), JSON.stringify({ ...h, at: new Date().toISOString() }, null, 2));
      process.exit(h.ok ? 0 : 1);
    })
    .catch((e: Error) => {
      console.error('健康检查执行出错：', e.message);
      process.exit(1);
    });
}
