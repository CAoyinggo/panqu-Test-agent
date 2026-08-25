#!/usr/bin/env node
// CLI Agent 模式：输入自然语言测试需求，一键运行 AI 测试流程并输出测试报告
// 用法：node bin/run-agent.ts "<测试需求文本>" [选项]
// 示例：node bin/run-agent.ts "测试 WAN3 文生视频，覆盖 720P、1080P 分辨率，验证任务提交成功与积分正确扣除"
// Phase 10-18 增强：支持智能选择 / 覆盖分析 / RCA / 缺陷草稿 / 自愈建议 / 分级审批 / 观测 Trace / 预算控制。
// 说明：默认使用 MockLLM（离线确定性）；配置 LLM_* 环境变量后走真实 LLM。
//       执行引擎需项目配置（config/ + session），否则可用 --skip-execution 仅产出测试设计+计划。

import {
  createAgentContext,
  createDataPrepareTool,
  createExecutionRunTool,
  createPersistentMemory,
  NoopMemory,
  ToolRegistry,
  runAgentPipeline,
} from '../src/agents/index.js';
import { createRuntimeLLM, describeLLMConfig } from '../src/config/llm.js';
import { parseAgentCliArgs, type AgentCliArgs as CliArgs } from '../src/cli/agent-args.js';
import {
  normalizeExecutionOutcome,
  analyzeFailures,
  resumeTask,
  saveTaskRecord,
  loadTaskRecord,
} from '../src/qa/workflows.js';
import type { AnalyzeFailuresOutput, ResumeTaskOutput } from '../src/qa/workflows.js';
import { computeCiResult } from '../src/qa/ci-result.js';
import { saveAgentDashboard } from '../src/qa/dashboard.js';
import fs from 'node:fs';

/** 输出人类可读报告（含 Phase 10-18 增强产物摘要） */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function printReport(args: CliArgs, result: any): void {
  const llmInfo = describeLLMConfig(args.llm);
  console.log('\n════════ AI 测试报告 ════════');
  console.log(`需求：${args.requirement}`);
  console.log(`功能模块：${result.requirement.feature}`);
  console.log(`LLM：${llmInfo.provider} / ${llmInfo.model}${llmInfo.fallbackModel ? `（备 ${llmInfo.fallbackModel}）` : ''}`);
  console.log(`生成用例：${result.testCases.length} 条`);
  console.log(`整体风险：${result.risk.summary.overall}（${result.risk.risks.length} 项${result.risk.summary.recommendedSkip ? '，建议人工介入' : ''}）`);
  console.log(`执行门禁：${result.policyGate.verdict}${result.policyGate.reasons.length ? `（${result.policyGate.reasons.join('；')}）` : ''}`);
  console.log(`数据计划：needsSetup=${result.dataPlan.needsSetup}，工厂=${result.dataPlan.factoryName}，动作 ${result.dataPlan.setupActions.length + result.dataPlan.teardownActions.length} 项`);

  if (result.outcome.executed) {
    console.log(`执行结果：${result.outcome.summary}`);
  } else {
    console.log('执行结果：未执行（execution.run Tool 未注册或 skipExecution）');
  }

  console.log(`\n【分析结论】overall=${result.report.summary.overall}（exitCode=${result.exitCode}）`);
  console.log(`AI 摘要：${result.report.aiSummary ?? '（无）'}`);
  for (const f of result.report.findings.slice(0, 10)) {
    console.log(`  [${f.severity}/${f.type}] ${f.title}`);
    if (f.suggestion) console.log(`    → ${f.suggestion}`);
  }
  if (result.report.recommendations.length) {
    console.log('\n【改进建议】');
    result.report.recommendations.slice(0, 8).forEach((r: string) => console.log(`  - ${r}`));
  }

  // —— Phase 10-18 增强产物 ——
  if (result.selection) {
    console.log(
      `\n【测试选择】选中 ${result.selection.statistics?.selected ?? result.selection.selectedCases.length} 条，跳过 ${result.selection.skippedCases.length} 条` +
      (result.selection.budget ? `（预算 ${result.selection.budget.maxCases ?? '无'} 用例）` : ''),
    );
    const skipped = result.selection.skippedCases.slice(0, 5);
    if (skipped.length) console.log(`  跳过示例：${skipped.join('、')}`);
  }
  if (result.coverage) {
    console.log('\n【覆盖分析】');
    result.coverage.dimensions.forEach((d: { name: string; rate: number }) => console.log(`  ${d.name}: ${d.rate}%`));
    result.coverage.gaps.slice(0, 5).forEach((g: string) => console.log(`  缺口：${g}`));
  }
  if (result.rcas?.length) {
    console.log('\n【根因分析】');
    result.rcas.slice(0, 5).forEach((r: { caseId: string; category: string; rootCause: string; confidence: number }) =>
      console.log(`  ${r.caseId}: ${r.category} / ${r.rootCause}（confidence=${r.confidence}）`),
    );
  }
  if (result.defects?.length) {
    console.log('\n【缺陷草稿】（DRAFT，未提交）');
    result.defects.slice(0, 5).forEach((d: { severity: string; title: string }) => console.log(`  [${d.severity}] ${d.title}`));
  }
  if (result.healing?.suggestions?.length) {
    console.log('\n【自愈建议】（SUGGESTED，未应用）');
    result.healing.suggestions.slice(0, 5).forEach((s: { oldPath: string; newPath?: string; confidence: number }) =>
      console.log(`  ${s.oldPath} → ${s.newPath ?? '…'}（confidence=${s.confidence}）`),
    );
  }
  if (result.approvals?.length) {
    console.log('\n【审批】');
    result.approvals.forEach((a: { id: string; decision: string; operation: string; target: string }) => {
      const res = result.approvalResults?.find((x: { requestId: string }) => x.requestId === a.id);
      console.log(`  [${a.decision}/${res?.verdict ?? 'pending'}] ${a.operation}: ${a.target}`);
    });
  }
  if (result.trace) {
    console.log(`\n【观测】${result.trace.summary}`);
  }
  if (result.budgetStatus) {
    console.log(
      `【预算】${result.budgetStatus.exceededAny ? `已超限：${result.budgetStatus.exceeded.join('、')}` : '未超限'}` +
      `（Agent ${result.budgetStatus.agentCalls} / LLM ${result.budgetStatus.llmCalls} / Tool ${result.budgetStatus.toolCalls} / Token ${result.budgetStatus.tokensUsed}）`,
    );
  }

  console.log(`\n耗时：${result.durationMs}ms`);
  console.log('════════════════════════════');
}

/** 输出失败分析报告（Mode C） */
function printAnalyzeReport(out: AnalyzeFailuresOutput): void {
  console.log('\n════════ 失败分析报告 ════════');
  console.log(`功能模块：${out.feature} / 失败用例：${out.failedCount} 条`);
  console.log(`\n【根因分析】RCA ${out.rcas.length} 条`);
  out.rcas.slice(0, 10).forEach((r) =>
    console.log(`  ${r.caseId}: ${r.category} / ${r.rootCause}（confidence=${r.confidence}，source=${r.source}）`),
  );
  console.log(`\n【缺陷草稿】${out.defects.length} 条（DRAFT，未提交）`);
  out.defects.slice(0, 10).forEach((d) => console.log(`  [${d.severity}] ${d.title}（关联 ${d.relatedCases[0] ?? '-'}）`));
  console.log(`\n【自愈建议】${out.healing?.suggestions.length ?? 0} 条（SUGGESTED，未应用）`);
  (out.healing?.suggestions ?? []).slice(0, 10).forEach((s) =>
    console.log(`  [${s.type}/${s.risk}] ${s.oldPath} → ${s.newPath ?? '…'}（confidence=${s.confidence}）`),
  );
  console.log(`\n【审批】${out.approvals.length} 条`);
  out.approvals.forEach((a) => {
    const res = out.approvalResults?.find((x) => x.requestId === a.id);
    console.log(`  [${a.decision}/${res?.verdict ?? 'pending'}] ${a.operation}: ${a.target}`);
  });
  console.log(`\n${out.summary}`);
  console.log('════════════════════════════');
}

/** 输出恢复任务报告（Mode D） */
function printResumeReport(out: ResumeTaskOutput): void {
  console.log('\n════════ 任务恢复报告 ════════');
  console.log(`任务：${out.taskId}`);
  console.log(`\n【根因分析】RCA ${out.rcas.length} 条`);
  out.rcas.slice(0, 10).forEach((r) =>
    console.log(`  ${r.caseId}: ${r.category} / ${r.rootCause}（confidence=${r.confidence}）`),
  );
  console.log(`\n【缺陷草稿】${out.defects.length} 条（DRAFT，未提交）`);
  console.log(`【自愈建议】${out.healing?.suggestions.length ?? 0} 条，获批并应用 ${out.applied.length} 条`);
  out.applied.forEach((a) => console.log(`  已应用 ${a.caseId}: ${a.diff.replace(/\n/g, '；')}`));
  console.log(`\n【重新执行】${out.reexecuted ? `${out.reexecuted.total} 条（恢复 ${out.recoveredCount} / 仍失败 ${out.stillFailed.length}）` : '未执行'}`);
  console.log(`\n${out.summary}`);
  console.log('════════════════════════════');
}

async function main(): Promise<number> {
  const args = parseAgentCliArgs(process.argv.slice(2));

  if (args.help || (!args.requirement && !args.requirementFile && !args.analyzeFile && !args.resumeId && !args.ciStatusFile)) {
    console.log(`用法：
  node dist/bin/run-agent.js "<测试需求文本>" [选项]      模式 A：从需求开始全流程
  node dist/bin/run-agent.js --requirement=<file> [选项] 模式 A：从需求文件开始全流程
  node dist/bin/run-agent.js --requirement=<file> --plan-only  模式 B：只生成测试（Requirement/TestDesign/Risk/Coverage）
  node dist/bin/run-agent.js --analyze=<result.json> --rca     模式 C：只分析失败（RCA/Defect/Healing/Approval）
  node dist/bin/run-agent.js --resume=<task-id>                模式 D：恢复任务（RCA→Healing→Approval→Execution）

选项：
  --env=<env>            执行环境（test/preonline/prod），默认 test
  --skip-execution       跳过实际执行，仅产出测试设计/风险/数据计划（离线）
  --plan-only            模式 B：只生成测试不执行（等价 skip-execution）
  --memory=<path>        Memory 路径；.sqlite/.db 使用 SQLite，其余使用并发安全 JSON
  --task-dir=<path>      任务记录目录（默认 output/tasks）
  --json                 输出 JSON 报告
  --help                 显示帮助

Phase 10-18 增强：
  --use-selection        用「智能选择」选中的用例集执行（默认全量执行）
  --auto-approve         自动批准 REVIEW 级审批（默认保持 pending 待人工）
  --execution-approval=<id> 提供人工审批 ID，允许 Policy Gate 放行需审批的真实执行
  --no-selection        关闭智能测试选择
  --no-coverage         关闭覆盖缺口分析
  --no-rca              关闭失败用例根因分析
  --no-defect           关闭缺陷草稿生成
  --no-healing          关闭自愈建议
  --no-approval         关闭分级审批
  --no-trace            关闭 Agent Trace 观测
  --max-rca=<n>         RCA 失败用例上限（默认 10）
  --max-defects=<n>     缺陷草稿上限（默认 10）
  --budget-tokens=<n>   Token 预算上限
  --budget-llm=<n>      LLM 调用次数上限
  --budget-agents=<n>   Agent 调用次数上限
  --budget-tools=<n>    Tool 调用次数上限
  --budget-cases=<n>    最大测试用例数
  --budget-concurrency=<n> 最大并发数
  --budget-duration=<ms> 最大执行时长（毫秒）

Phase 20.1 真实 LLM：
  --llm-provider=<p>    LLM Provider（mock/deepseek/glm/doubao/openai-compatible/anthropic-compatible）
  --model <name>        主模型名（也支持 --model=<name>；覆盖 LLM_MODEL）
  --fallback-model=<n>  回退模型名（覆盖 LLM_FALLBACK_MODEL）
  --llm-timeout=<ms>    LLM 超时毫秒（覆盖 LLM_TIMEOUT）
  --max-tokens=<n>      LLM 最大输出 token（覆盖 LLM_MAX_TOKENS）

参数规则：未知参数、重复参数、缺失参数值会直接报错并以退出码 2 结束。

示例：
  node dist/bin/run-agent.js "测试 WAN3 文生视频，覆盖 720P、1080P 分辨率，验证任务提交成功与积分正确扣除"
  node dist/bin/run-agent.js --requirement=requirement.md
  node dist/bin/run-agent.js --requirement=requirement.md --plan-only
  node dist/bin/run-agent.js --analyze=output/result.json --rca
  node dist/bin/run-agent.js --resume=wan3-文生视频
  node dist/bin/run-agent.js "测试 DeepSeek API 可用性" --llm-provider=deepseek --model=deepseek-chat --fallback-model=deepseek-reasoner --llm-timeout=30000`);
    return args.help ? 0 : 2;
  }

  // LLM（Phase 20.1）：未配置 provider 默认 Mock（离线确定性）；
  // 配置 LLM_* 环境变量或 --llm-provider 走真实 Provider（支持主 → 备 → 确定性兜底）。
  const llm = createRuntimeLLM(args.llm);

  // Memory：可指定持久化路径
  const memory = args.memoryPath
    ? await createPersistentMemory({ path: args.memoryPath })
    : new NoopMemory();

  // ===== 模式 CI-Status：读取结果文件计算 CI 六态（--ci-status=<file>）=====
  if (args.ciStatusFile) {
    if (!fs.existsSync(args.ciStatusFile)) {
      console.error(`结果文件不存在：${args.ciStatusFile}`);
      return 2;
    }
    let outcome;
    try {
      outcome = normalizeExecutionOutcome(JSON.parse(fs.readFileSync(args.ciStatusFile, 'utf8')));
    } catch (e) {
      console.error(`无法解析结果文件：${(e as Error).message}`);
      return 2;
    }
    const ci = computeCiResult(outcome, { environment: args.env ?? 'test' });
    console.log(JSON.stringify(ci, null, 2));
    return ci.verdict === 'BLOCKED' || ci.verdict === 'FAIL' ? 1 : 0;
  }

  // ===== 模式 C：只分析失败（--analyze result.json --rca）=====
  if (args.analyzeFile) {
    if (!fs.existsSync(args.analyzeFile)) {
      console.error(`分析文件不存在：${args.analyzeFile}`);
      return 2;
    }
    let outcome;
    try {
      outcome = normalizeExecutionOutcome(JSON.parse(fs.readFileSync(args.analyzeFile, 'utf8')));
    } catch (e) {
      console.error(`无法解析执行结果文件：${(e as Error).message}`);
      return 2;
    }
    const context = createAgentContext({
      taskId: `analyze-${Date.now()}`,
      feature: outcome.feature,
      environment: args.env ?? 'test',
      tools: new ToolRegistry(),
      memory,
      llm,
    });
    const out = await analyzeFailures(outcome, context, {
      maxRca: args.maxRca,
      maxDefects: args.maxDefects,
      autoApprove: args.autoApprove,
    });
    if (args.json) {
      console.log(JSON.stringify(out, null, 2));
      return 0;
    }
    printAnalyzeReport(out);
    return 0;
  }

  // ===== 模式 D：恢复任务（--resume task-id）=====
  if (args.resumeId) {
    const record = loadTaskRecord(args.resumeId, args.taskDir);
    if (!record) {
      console.error(`任务记录不存在：${args.resumeId}（检查 ${args.taskDir ?? 'output/tasks'}）`);
      return 2;
    }
    // 恢复任务的「修复后回归」需要执行引擎（项目配置就绪时执行获批自愈用例）
    const tools = new ToolRegistry();
    tools.register(createExecutionRunTool());
    const context = createAgentContext({
      taskId: record.taskId,
      feature: record.feature,
      environment: record.environment ?? 'test',
      tools,
      memory,
      llm,
    });
    const out = await resumeTask(record, context, undefined, {
      maxRca: args.maxRca,
      maxDefects: args.maxDefects,
      autoApprove: args.autoApprove,
      concurrency: args.budget.maxConcurrency,
    });
    const code = out.reexecuted && out.stillFailed.length ? 1 : 0;
    if (args.json) {
      console.log(JSON.stringify(out, null, 2));
      return code;
    }
    printResumeReport(out);
    return code;
  }

  // ===== 模式 A / B：从需求开始 =====
  // 需求文本：--requirement=<file> 读文件；否则用位置参数文本
  let requirementText = args.requirement;
  if (args.requirementFile) {
    if (!fs.existsSync(args.requirementFile)) {
      console.error(`需求文件不存在：${args.requirementFile}`);
      return 2;
    }
    requirementText = fs.readFileSync(args.requirementFile, 'utf8');
  }
  // 模式 B：--plan-only 只生成测试（Requirement/TestDesign/Risk/Coverage），不执行
  const skipExecution = args.skipExecution || args.planOnly;

  // Tools：数据准备 + 执行引擎（真实执行需项目配置，--plan-only/--skip-execution 不注册执行 Tool）
  const executionApproval = args.executionApprovalId
    ? {
        id: args.executionApprovalId,
        status: 'APPROVED' as const,
        approvedBy: process.env.USER ?? 'cli-user',
        approvedAt: new Date().toISOString(),
      }
    : undefined;
  const tools = new ToolRegistry({
    environment: args.env ?? 'test',
    onApproval: executionApproval ? async () => true : undefined,
  });
  tools.register(createDataPrepareTool());
  if (!skipExecution) {
    tools.register(createExecutionRunTool());
  }

  const context = createAgentContext({
    taskId: `agent-${Date.now()}`,
    feature: 'agent',
    environment: args.env ?? 'test',
    tools,
    memory,
    llm,
  });

  const result = await runAgentPipeline(
    {
      requirementText,
      environment: args.env ?? 'test',
      options: {
        skipExecution,
        runSelection: !args.noSelection,
        runCoverage: !args.noCoverage,
        runRca: !args.noRca,
        runDefect: !args.noDefect,
        runHealing: !args.noHealing,
        runApproval: !args.noApproval,
        runTrace: !args.noTrace,
        useSelection: args.useSelection,
        autoApprove: args.autoApprove,
        maxRca: args.maxRca,
        maxDefects: args.maxDefects,
        budget: Object.keys(args.budget).length ? args.budget : undefined,
        executionApproval,
      },
    },
    context,
  );

  // 保存任务记录（供 --resume 恢复）
  try {
    saveTaskRecord({
      runId: result.runId,
      taskId: result.taskId,
      requirementsHash: result.requirementsHash,
      createdAt: result.createdAt,
      feature: result.requirement.feature,
      requirement: requirementText,
      environment: args.env ?? 'test',
      testCases: result.testCases,
      outcome: result.outcome,
      failedCases: result.outcome.results.filter((r) => !r.pass && !r.timedOut),
      updatedAt: new Date().toISOString(),
    }, args.taskDir);
  } catch (e) {
    console.warn(`任务记录保存失败（不影响运行）：${(e as Error).message}`);
  }

  // Phase 20.8：Agent KPI Dashboard（output/<date>/agent-summary.json）
  try {
    saveAgentDashboard(result, { environment: args.env ?? 'test' });
  } catch (e) {
    console.warn(`KPI Dashboard 保存失败（不影响运行）：${(e as Error).message}`);
  }

  // Phase 20.7 CI：--ci 计算六态结论并输出 CI 专属退出码（BLOCKED/FAIL → 1）
  if (args.ci) {
    const priorities: Record<string, string> = {};
    for (const c of result.testCases) priorities[c.id] = c.priority;
    const ci = computeCiResult(result.outcome, { environment: args.env ?? 'test', priorities });
    if (args.json) {
      console.log(JSON.stringify(ci, null, 2));
    } else {
      printReport(args, result);
      console.log(`\n【CI 状态】${ci.summary}`);
      ci.blockReasons.forEach((r) => console.log(`  - ${r}`));
    }
    return ci.verdict === 'BLOCKED' || ci.verdict === 'FAIL' ? 1 : 0;
  }

  if (args.json) {
    console.log(JSON.stringify(result, null, 2));
    return result.exitCode;
  }

  printReport(args, result);

  return result.exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e: Error) => {
    console.error('Agent 执行出错：', e.message);
    process.exit(2);
  });
