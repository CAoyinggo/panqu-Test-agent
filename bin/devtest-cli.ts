#!/usr/bin/env node

/**
 * Panqu AI DevTest v6.0.0 本地命令行工具 (Unified DevTest CLI)
 *
 * 双模同源架构下的本地终端独立运行入口：
 * 提供 4 大核心业务命令：
 *   devtest probe [--env test] [--session-file <file>] [--json]
 *   devtest plan --model 84 --media video [--flow diversion] [--json]
 *   devtest execute --model 84 --media video [--mode real|mock] [--json]
 *   devtest verify --task 12345 --model 84 --media video [--json]
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  probe,
  plan,
  execute,
  verify,
  type ProbeKernelOptions,
  type PlanKernelOptions,
  type ExecuteKernelOptions,
  type VerifyKernelOptions,
  type VerifyKernelResult,
} from '../src/devtest/core-kernel.js';
import {
  PanquMediaExecutionAdapter,
  type ExecutionAdapter,
} from '../src/devtest/execution-ports.js';
import { DEVTEST_VERSION } from '../src/devtest/version.js';

// ANSI 颜色辅助
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

const HELP_TEXT = `
${c.bold}${c.cyan}Panqu AI DevTest 开发者测试工具${c.reset} ${c.dim}v${DEVTEST_VERSION}${c.reset}
轻量 · 纯净 · 双模同源（本地 CLI + TRAE MCP）

${c.bold}用法:${c.reset}
  devtest <command> [options]

${c.bold}核心业务命令:${c.reset}
  ${c.green}probe${c.reset}     环境探活（主站健康度、Cookie有效性、NewAPI网关可用渠道）
  ${c.green}plan${c.reset}      分流推导与测试规划（Direct直连 vs NewAPI切流决策、加权渠道与刊例基准）
  ${c.green}execute${c.reset}   任务执行（受控仿真派发或真实请求，返回 Task ID 及初始凭据）
  ${c.green}verify${c.reset}    物理验真与防资损对账（MP4 Box/PNG IHDR 结构校验 + 账务三大不变量对账）

${c.bold}命令参数与示例:${c.reset}
  ${c.yellow}# 1. 环境探活${c.reset}
  devtest probe [--env test|preonline] [--session-file <path>] [--json]

  ${c.yellow}# 2. 分流推导与规划${c.reset}
  devtest plan --model 84 --media video [--channel 54] [--flow diversion|direct] [--change-type new_model|diversion_change] [--custom-points 5] [--alias <name>] [--is-global] [--json]

  ${c.yellow}# 3. 任务执行${c.reset}
  devtest execute --model 84 --media video [--channel 54] [--mode mock|real] [--alias <name>] [--prompt "..."] [--wait] [--poll-timeout <sec>] [--json]

  ${c.yellow}# 4. 产物验真与对账${c.reset}
  devtest verify --task 12345 --model 84 --media video [--channel 54] [--alias <name>] [--expected-points 28] [--json]

${c.bold}通用参数:${c.reset}
  --channel <id>  指定网关渠道 ID (如 54 为 TD_国际)，执行前进行对象消歧与承接关系校验
  --json          以 JSON 格式输出纯结构化数据（便于脚本和智能体解析）
  --help, -h      显示帮助信息
  --version, -v   显示当前版本
`;

interface ParsedArgs {
  command?: string;
  options: Record<string, string | boolean | number>;
  positionals: string[];
}

function parseCliArgs(argv: string[]): ParsedArgs {
  const options: Record<string, string | boolean | number> = {};
  const positionals: string[] = [];
  let command: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      options.version = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }

    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        const num = Number(next);
        options[key] = !isNaN(num) && next.trim() !== '' ? num : next;
        i++;
      } else {
        options[key] = true;
      }
      continue;
    }

    if (!command) {
      command = arg;
    } else {
      positionals.push(arg);
    }
  }

  return { command, options, positionals };
}

function printVerifyResult(result: VerifyKernelResult): void {
  const taskStatusText = result.evidence.task.status;
  const ownershipText = result.evidence.media.ownership;
  const mediaStatusText = result.evidence.media.status;
  const billingStatusText = result.evidence.billing.status;
  const antiDoubleText = result.evidence.invariants.details?.antiDoubleBilling.status ?? (result.invariants?.antiDoubleBilling ? 'PASS' : 'UNVERIFIED');
  const netZeroText = result.evidence.invariants.details?.netChargeZero.status ?? (result.invariants?.netChargeZero ? 'PASS' : 'UNVERIFIED');
  const refundIdemText = result.evidence.invariants.details?.refundIdempotency.status ?? (result.invariants?.refundIdempotency ? 'PASS' : 'UNVERIFIED');
  const finalVerdictText = result.verdict;

  console.log(`\n🎯 概况：Task #${result.taskId} · [${result.executionMode.toUpperCase()}] · ${result.status}`);
  console.log(`\n🔍 验真：`);
  console.log(`Task <${taskStatusText}>`);
  console.log(`Artifact ownership <${ownershipText}>`);
  console.log(`Media <${mediaStatusText}>`);
  console.log(`Billing <${billingStatusText}>`);
  console.log(`antiDoubleBilling <${antiDoubleText}>`);
  console.log(`netChargeZero <${netZeroText}>`);
  console.log(`refundIdempotency <${refundIdemText}>`);
  console.log(`生产验收裁决 <${result.acceptance}>`);
  console.log(`最终技术判定 <${finalVerdictText}>`);
  console.log(`\n💻 复现：`);
  console.log(`npm run devtest -- verify --task ${result.taskId}`);

  if (!result.passed && result.reasons.length > 0) {
    console.log(`\n⚠️ 缺陷：`);
    for (const r of result.reasons) {
      console.log(`- ${r}`);
    }
  }

  console.log(`\n${c.bold}${c.cyan}======================================================${c.reset}`);
  console.log(`${c.bold}🔬 DevTest 物理验真与防资损对账明细${c.reset} [任务 #${result.taskId}] [${result.executionMode.toUpperCase()}]`);

  if (!result.artifact && result.billingAudit === 'SKIPPED_NO_LOGS') {
    console.log(`\n${c.yellow}⚠️ 提示: 当前未连接真实主站获取产物 URL / 账单流水，仅执行脱机静态演算，非线上真实验收结果。${c.reset}`);
  }

  let acceptanceLabel: string;
  if (result.acceptance === 'ACCEPTED') {
    acceptanceLabel = `${c.green}● ACCEPTED (生产级四态验收通过)${c.reset}`;
  } else if (result.acceptance === 'REJECTED') {
    acceptanceLabel = `${c.red}● REJECTED (验收驳回: 存在缺陷或非预期回归)${c.reset}`;
  } else if (result.acceptance === 'BLOCKED') {
    if (result.status === 'PROCESSING') {
      acceptanceLabel = `${c.yellow}● BLOCKED / IN_FLIGHT (轮询窗口耗尽: 任务仍在排队处理中)${c.reset}`;
    } else {
      acceptanceLabel = `${c.yellow}● BLOCKED (验收阻断: 缺失核心凭据或刊例单价)${c.reset}`;
    }
  } else {
    acceptanceLabel = `${c.yellow}● UNVERIFIED (验收待确认: 测试通过但关键证据未闭环)${c.reset}`;
  }
  console.log(`${c.bold}生产验收裁决:${c.reset} ${acceptanceLabel}`);
  console.log(`${c.bold}证据完整度:${c.reset} ${result.evidenceCompleteness.isComplete ? `${c.green}✔ COMPLETE (${result.evidenceCompleteness.availableEvidence.length}/${result.evidenceCompleteness.requiredEvidence.length})${c.reset}` : `${c.yellow}○ INCOMPLETE (${result.evidenceCompleteness.availableEvidence.length}/${result.evidenceCompleteness.requiredEvidence.length})${c.reset}`}`);
  if (result.evidenceCompleteness.missingEvidence.length > 0) {
    console.log(`  ${c.yellow}待补证据: ${result.evidenceCompleteness.missingEvidence.join(', ')}${c.reset}`);
  }

  let verdictLabel: string;
  if (result.passed) {
    verdictLabel = `${c.green}● ALL PASS (验真与账务全部通过)${c.reset}`;
  } else if (result.status === 'PROCESSING') {
    verdictLabel = `${c.yellow}● PROCESSING (排队处理中: ${result.progress ?? 0}%)${c.reset}`;
  } else if (result.status === 'UNVERIFIED') {
    verdictLabel = `${c.yellow}● UNVERIFIED (凭据缺失，未通过线上验收)${c.reset}`;
  } else {
    verdictLabel = `${c.red}● FAILED (存在违背或缺陷)${c.reset}`;
  }
  console.log(`${c.bold}技术裁决:${c.reset} ${verdictLabel}`);

  console.log(`\n${c.bold}1. 任务状态与执行 (Task Execution):${c.reset} ${result.evidence.task.status === 'PASS' ? `${c.green}✔ PASS${c.reset}` : result.evidence.task.status === 'PROCESSING' ? `${c.yellow}● PROCESSING${c.reset}` : result.evidence.task.status === 'UNVERIFIED' ? `${c.yellow}● UNVERIFIED${c.reset}` : `${c.red}✖ FAIL${c.reset}`} [${result.evidence.task.source}]`);
  if (result.evidence.task.error) {
    console.log(`   错误信息: ${result.evidence.task.error}`);
  }

  console.log(`\n${c.bold}2. 产物物理结构验真 (Media Inspection):${c.reset} ${result.evidence.media.status === 'PASS' ? `${c.green}✔ PASS${c.reset}` : result.evidence.media.status === 'UNVERIFIED' ? `${c.yellow}● UNVERIFIED${c.reset}` : `${c.red}✖ FAIL${c.reset}`} [${result.evidence.media.source}]`);
  if (result.artifact) {
    if (result.probeDurationMs !== undefined) {
      console.log(`   流式探测耗时: ${result.probeDurationMs} ms (Range: bytes=0-65535)`);
    }
    console.log(`   容器标识: ${result.artifact.containerIdentified ? `${c.green}✔ 规范合法 (${(result.artifact.format || 'mp4').toUpperCase()} container structure PASS)${c.reset}` : `${c.red}✖ 缺失${c.reset}`} | 格式: ${result.artifact.format || 'unknown'} | 结构有效: ${result.artifact.decodable ? `${c.green}✔ YES${c.reset}` : `${c.red}✖ NO${c.reset}`} | 归属确认: ${result.evidence.media.ownership === 'VERIFIED' ? `${c.green}✔ 绑定成功${c.reset}` : `${c.yellow}○ 未绑定${c.reset}`}`);
    if (result.artifact.dimensions) {
      console.log(`   分辨率: ${result.artifact.dimensions.width}x${result.artifact.dimensions.height}`);
    }
    if (result.artifact.durationSeconds !== undefined) {
      console.log(`   时长: ${result.artifact.durationSeconds} 秒`);
    }
    if (result.artifact.hasMdat !== undefined) {
      console.log(`   数据块校验: ${result.artifact.hasMdat !== false ? `${c.green}✔ 音视频裸流有效${c.reset}` : `${c.red}✖ 缺少 mdat 数据块${c.reset}`}`);
    }
    if (result.artifact.reasons.length > 0) {
      for (const r of result.artifact.reasons) console.log(`   ${c.yellow}⚠ ${r}${c.reset}`);
    }
  } else {
    console.log(`   ${c.yellow}${result.evidence.media.reason || '未获取产物二进制 Buffer (未提供 assetBuffer 且未连接主站获取产物 URL)'}${c.reset}`);
  }

  console.log(`\n${c.bold}3. 防资损账务对账 (Billing & Invariants):${c.reset} ${result.evidence.billing.status === 'PASS' ? `${c.green}✔ PASS${c.reset}` : result.evidence.billing.status === 'UNVERIFIED' ? `${c.yellow}● UNVERIFIED${c.reset}` : `${c.red}✖ FAIL${c.reset}`} [${result.evidence.billing.source}]`);
  if (result.billing) {
    console.log(`   对账结果: ${result.billing.passed ? `${c.green}✔ PASS${c.reset}` : `${c.red}✖ MISMATCH${c.reset}`}`);
    console.log(`   基准扣费: 预扣 ${result.billing.preDeductedPoints} pt | 实扣 ${result.billing.netDeductedPoints} pt | 结算 ${result.billing.settledPoints} pt | 退款 ${result.billing.refundedPoints} pt`);
    if (result.invariants) {
      console.log(`   核心不变量核验 (Invariants: ${result.evidence.invariants.status}):`);
      console.log(`     - [防重复扣费] antiDoubleBilling:   ${result.invariants.antiDoubleBilling ? `${c.green}✔ 符合${c.reset}` : `${c.red}✖ 存在多重扣费${c.reset}`}`);
      console.log(`     - [失败净扣归零] netChargeZero:       ${result.invariants.netChargeZero ? `${c.green}✔ 符合${c.reset}` : `${c.red}✖ 失败未完全退款${c.reset}`}`);
      console.log(`     - [退款幂等核销] refundIdempotency:   ${result.invariants.refundIdempotency ? `${c.green}✔ 符合${c.reset}` : `${c.red}✖ 重复退款${c.reset}`}`);
    }
  } else {
    console.log(`   ${c.yellow}未提供账单流水 (scoreLogs 缺失)，跳过账务对账 [SKIPPED_NO_LOGS]${c.reset}`);
  }

  if (result.expectedVsActual) {
    console.log(`\n${c.bold}4. 预期与实际对比 (Expected vs Actual Matrix):${c.reset}`);
    const diffItems = result.expectedVsActual.items || result.expectedVsActual.diffs || [];
    for (const item of diffItems) {
      const statusTag = item.status === 'PASS'
        ? `${c.green}[PASS]${c.reset}`
        : item.status === 'FAIL'
        ? `${c.red}[FAIL]${c.reset}`
        : item.status === 'BLOCKED'
        ? `${c.yellow}[BLOCKED]${c.reset}`
        : `${c.cyan}[MANUAL_REQUIRED]${c.reset}`;
      const matchIcon = item.matched ? `${c.green}✔ MATCH${c.reset}` : `${c.red}✖ DIFF${c.reset}`;
      console.log(`   - [${item.layer.padEnd(10)}] ${item.field}: ${statusTag} ${matchIcon} (预期: ${JSON.stringify(item.expected)} | 实际: ${JSON.stringify(item.actual)}) [证据: ${item.evidence || 'N/A'}]`);
      if (item.diff && item.diff !== 'MATCH') {
        console.log(`     ${c.dim}差异说明: ${item.diff}${c.reset}`);
      }
    }
    if (result.expectedVsActual.regressionDiff) {
      const reg = result.expectedVsActual.regressionDiff;
      const regStatusStr = reg.regressionStatus === 'CLEAN'
        ? `${c.green}✔ CLEAN (所有基线比对项通过且证据齐备)${c.reset}`
        : reg.regressionStatus === 'REGRESSION'
        ? `${c.red}✖ REGRESSION DETECTED (存在非预期变化阻断)${c.reset}`
        : `${c.yellow}○ UNKNOWN (基线比对关键证据不全，无法判定CLEAN)${c.reset}`;
      console.log(`   回归状态: ${regStatusStr}`);
      if (reg.expectedChanges.length > 0) {
        console.log(`   预期变更:`);
        for (const ec of reg.expectedChanges) {
          console.log(`     - [${ec.field}] ${JSON.stringify(ec.before)} -> ${JSON.stringify(ec.after)} (${ec.reason})`);
        }
      }
      if (reg.unexpectedChanges.length > 0) {
        console.log(`   ${c.red}⚠️ 非预期变更 (回归缺陷阻断):${c.reset}`);
        for (const uc of reg.unexpectedChanges) {
          console.log(`     - [${uc.field}] ${JSON.stringify(uc.before)} -> ${JSON.stringify(uc.after)} (${c.red}${uc.reason}${c.reset})`);
        }
      }
    }
    if (result.expectedVsActual.evidenceStatus?.extraSnapshot === 'MANUAL_DB_EVIDENCE_REQUIRED') {
      console.log(`\n${c.yellow}📌 关键证据提醒: [MANUAL_DB_EVIDENCE_REQUIRED]${c.reset}`);
      console.log(`   ${result.expectedVsActual.manualVerificationGuide?.notice}`);
      console.log(`   SQL 指引: ${c.cyan}${result.expectedVsActual.manualVerificationGuide?.extraQuerySql}${c.reset}`);
    }
  }

  if (result.reasons.length > 0) {
    console.log(`\n${c.bold}核验明细 / 告警:${c.reset}`);
    for (const r of result.reasons) console.log(`  ${result.passed ? c.green : c.yellow}👉 ${r}${c.reset}`);
  }

  console.log(`\n${c.bold}🚀 下一步行动:${c.reset}`);
  if (result.acceptance === 'ACCEPTED') {
    console.log(`  ${c.green}✔ 验收全部通过！测试证据闭环，可合流上线 / 交付生产。${c.reset}`);
  } else if (result.acceptance === 'BLOCKED') {
    if (result.status === 'PROCESSING') {
      console.log(`  ${c.yellow}⏳ 任务仍处于 PROCESSING/QUEUED 状态，本次 polling window 已耗尽。这并非业务失败，请继续执行 npm run devtest -- verify --task ${result.taskId} 追踪终态闭环。${c.reset}`);
    } else {
      console.log(`  ${c.yellow}⚠️ 验收阻断：请先补充缺失的刊例定价或环境会话凭据。${c.reset}`);
    }
  } else if (result.acceptance === 'REJECTED') {
    console.log(`  ${c.red}✖ 验收驳回：发现明确业务缺陷或非预期回归，请联系研发排查。${c.reset}`);
  } else {
    console.log(`  ${c.yellow}○ 待闭环确认：执行 SQL 查询任务 extra 确认分流落库后，追加 --db-extra-confirmed 重新验真。${c.reset}`);
  }

  console.log(`${c.bold}${c.cyan}======================================================${c.reset}\n`);
}

export async function runDevTestCli(
  args: string[],
  dependencies?: { executionAdapter?: ExecutionAdapter }
): Promise<number> {
  const { command, options, positionals } = parseCliArgs(args);
  const isJson = Boolean(options.json);

  if (options.version) {
    if (isJson) {
      console.log(JSON.stringify({ version: DEVTEST_VERSION }));
    } else {
      console.log(`devtest v${DEVTEST_VERSION}`);
    }
    return 0;
  }

  if (options.help || !command) {
    console.log(HELP_TEXT.trim());
    return 0;
  }

  try {
    switch (command) {
      case 'probe': {
        const env = (options.env as 'test' | 'preonline') || 'test';
        const sessionFile = (options['session-file'] as string) || (options.session as string) || (options.sessionFile as string);
        const baseUrl = (options['base-url'] as string) || (options.baseUrl as string);
        const timeoutMs = typeof options.timeout === 'number' ? options.timeout : undefined;

        const isMock = Boolean(options.mock);
        const probeOptions: ProbeKernelOptions = {
          env,
          baseUrl,
          sessionFile,
          timeoutMs,
          mock: isMock,
        };

        const result = await probe(probeOptions);

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\n${c.bold}${c.cyan}======================================================${c.reset}`);
          console.log(`${c.bold}📡 DevTest 环境探活报告${c.reset} [${c.yellow}${result.env}${c.reset}]`);
          console.log(`${c.bold}总体状态:${c.reset} ${result.status === 'HEALTHY' ? `${c.green}● HEALTHY (健康)${c.reset}` : result.status === 'DEGRADED' ? `${c.yellow}● DEGRADED (部分降级)${c.reset}` : `${c.red}● BLOCKED (阻断)${c.reset}`}`);
          console.log(`${c.bold}主站端点:${c.reset} ${result.baseUrl}`);
          console.log(`${c.bold}网关端点:${c.reset} ${result.gatewayUrl}`);
          console.log(`${c.bold}鉴权凭据:${c.reset} ${result.auth.status === 'VALID' ? `${c.green}VALID (有效)${c.reset}` : `${c.yellow}${result.auth.status}${c.reset}`} ${c.dim}(${result.auth.details})${c.reset}`);
          console.log(`${c.bold}可用渠道:${c.reset} ${c.green}${result.candidateChannelCount} 个可用渠道${c.reset}`);
          console.log(`\n${c.bold}端点探测明细:${c.reset}`);
          for (const ep of result.endpoints) {
            const icon = ep.reachable ? `${c.green}✔${c.reset}` : `${c.red}✖${c.reset}`;
            const latency = ep.latencyMs !== undefined ? `${c.dim}${ep.latencyMs}ms${c.reset}` : '';
            console.log(`  ${icon} ${ep.name.padEnd(16)} [${ep.statusCode ?? 'ERR'}] ${ep.message} ${latency}`);
          }
          if (result.recommendations.length > 0) {
            console.log(`\n${c.bold}建议与指引:${c.reset}`);
            for (const r of result.recommendations) console.log(`  👉 ${r}`);
          }
          console.log(`${c.bold}${c.cyan}======================================================${c.reset}\n`);
        }
        return result.ok ? 0 : 1;
      }

      case 'plan': {
        const rawRequirement = (options.requirement as string) || (options.req as string) || (positionals.length > 0 ? positionals.join(' ') : undefined);
        const price = typeof options.price === 'number' ? options.price as number : undefined;
        const modelId = options.model ?? options['model-id'] ?? options.modelId ? Number(options.model ?? options['model-id'] ?? options.modelId) : undefined;
        const mediaType = options.media ?? options['media-type'] ?? options.mediaType ? (((options.media ?? options['media-type'] ?? options.mediaType) as string).toLowerCase() as 'video' | 'image') : undefined;
        const flowType = (options.flow ?? options['flow-type'] ?? options.flowType) as 'direct' | 'diversion' | undefined;
        const resolution = options.resolution as string | undefined;
        const duration = typeof options.duration === 'number' ? options.duration : undefined;
        const changeType = (options['change-type'] || options.changeType) as 'new_model' | 'diversion_change' | undefined;
        const customPoints = typeof options['custom-points'] === 'number' ? options['custom-points'] as number : typeof options.customPoints === 'number' ? options.customPoints as number : undefined;
        const pointsPerSecond = typeof options['points-per-second'] === 'number' ? options['points-per-second'] as number : typeof options.pointsPerSecond === 'number' ? options.pointsPerSecond as number : undefined;
        const isGlobal = typeof options['is-global'] === 'boolean' ? options['is-global'] as boolean : typeof options.isGlobal === 'boolean' ? options.isGlobal as boolean : undefined;
        const alias = (options.alias as string) || undefined;
        const channelId = options.channel !== undefined ? Number(options.channel) : (options['channel-id'] !== undefined ? Number(options['channel-id']) : undefined);
        const channelName = options['channel-name'] as string | undefined;
        const targetKind = options['target-kind'] as 'channel' | 'model' | undefined;
        const projectId = options['project-id'] !== undefined ? Number(options['project-id']) : undefined;
        const rawTarget = options['raw-target'] as string | undefined;

        const planOptions: PlanKernelOptions = {
          modelId,
          mediaType,
          flowType,
          changeType,
          requirement: rawRequirement,
          resolution,
          duration,
          customPoints,
          pointsPerSecond,
          price,
          isGlobal,
          alias,
          channelId,
          channelName,
          targetKind,
          projectId,
          rawTarget,
        };

        const result = await plan(planOptions);

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\n${c.bold}${c.cyan}======================================================${c.reset}`);
          console.log(`${c.bold}📋 DevTest 分流推导与动态测试规划 [${result.scenarioName || result.scenario}]${c.reset}`);
          console.log(`${c.bold}模型规格:${c.reset} 模型 #${result.modelId} (${result.mediaType}) | 别名: ${result.contract?.alias.value || '未知'} [${result.contract?.alias.source || 'default'}] | 模式: ${result.flowType}`);
          console.log(`${c.bold}分流决策:${c.reset} ${result.willDivert ? `${c.green}NEWAPI 切流 (线路 ${result.routeLine})${c.reset}` : `${c.yellow}DIRECT 直连 (线路 ${result.routeLine})${c.reset}`} [${result.decision}]`);
          console.log(`${c.bold}推导原因:${c.reset} ${result.reason}`);
          console.log(`${c.bold}刊例计费:${c.reset} ${c.yellow}${result.expectedPoints} 积分${c.reset} [${result.pricingStatus}] ${c.dim}(约 ¥${(result.expectedPoints * 0.1).toFixed(2)})${c.reset}`);
          if (result.expectedSnapshot) {
            console.log(`${c.bold}切流快照:${c.reset} 模型别名=${c.cyan}${result.expectedSnapshot.newapiModel}${c.reset} | 分组=${result.expectedSnapshot.newapiGroup || 'default'}`);
          }
          console.log(`${c.bold}候选渠道:${c.reset} ${result.candidateChannels.join(', ') || '无可用渠道'}`);

          if (result.testPlan) {
            console.log(`\n${c.bold}🤖 自动化覆盖用例 (${result.testPlan.tests.length} 项):${c.reset}`);
            for (const t of result.testPlan.tests) {
              const icon = t.status === 'READY' ? `${c.green}✔ READY${c.reset}` : t.status === 'BLOCKED' ? `${c.red}✖ BLOCKED${c.reset}` : `${c.yellow}○ SKIPPED${c.reset}`;
              console.log(`  [${t.layer.padEnd(9)}] ${t.id}: ${icon} - ${t.purpose}`);
              if (t.rationale) {
                console.log(`               ${c.dim}目的: ${t.rationale.whyIncluded} (防范: ${t.rationale.riskAddressed})${c.reset}`);
              }
            }
          }

          if (result.testPlan?.skippedTests && result.testPlan.skippedTests.length > 0) {
            console.log(`\n${c.bold}🛡️ 安全裁剪跳过用例 (${result.testPlan.skippedTests.length} 项):${c.reset}`);
            for (const s of result.testPlan.skippedTests) {
              console.log(`  ○ [${s.id}] ${s.name}: ${s.whySkipped} ${c.dim}(规则: ${s.rule})${c.reset}`);
            }
          }

          if (result.blocked && result.blocked.length > 0) {
            console.log(`\n${c.yellow}⚠️ 阻断待提供事实 (${result.blocked.length} 项):${c.reset}`);
            for (const b of result.blocked) {
              const fieldName = b.missingField || b.field;
              const impact = b.impact || b.reason;
              const action = b.suggestedAction || b.requiredAction;
              console.log(`  - 缺失字段: ${c.bold}${fieldName}${c.reset} (影响: ${impact})`);
              console.log(`    指引: ${action}`);
            }
          }

          if (result.testerActionSummary?.manualRequiredSummary && result.testerActionSummary.manualRequiredSummary.length > 0) {
            console.log(`\n${c.bold}📌 需人工确认/查库证据:${c.reset}`);
            for (const item of result.testerActionSummary.manualRequiredSummary) {
              console.log(`  👉 ${item}`);
            }
          }

          if (result.testerActionSummary?.nextStep) {
            console.log(`\n${c.bold}🚀 下一步行动:${c.reset}`);
            console.log(`  ${c.cyan}${result.testerActionSummary.nextStep}${c.reset}`);
          }

          if (result.acceptanceForecast) {
            const forecastColor = result.acceptanceForecast === 'BLOCKED' ? c.red : c.yellow;
            console.log(`\n${c.bold}验收预判:${c.reset} ${forecastColor}[${result.acceptanceForecast}]${c.reset}`);
          }
          if (result.missingInputs && result.missingInputs.length > 0) {
            console.log(`${c.bold}缺失必填项:${c.reset} ${c.yellow}${result.missingInputs.join(', ')}${c.reset}`);
          }

          console.log(`${c.bold}${c.cyan}======================================================${c.reset}\n`);
        }
        return result.ok ? 0 : 1;
      }

      case 'execute': {
        const modelId = Number(options.model ?? options['model-id'] ?? options.modelId ?? 84);
        const mediaType = ((options.media ?? options['media-type'] ?? options.mediaType ?? 'video') as string).toLowerCase() as 'video' | 'image';
        const mode = (options.mode as string) === 'real' ? 'real' : 'mock';
        const resolution = options.resolution as string | undefined;
        const duration = typeof options.duration === 'number' ? options.duration : undefined;
        const prompt = options.prompt as string | undefined;
        const sessionFile = (options['session-file'] as string) || (options.session as string);
        const env = (options.env as 'test' | 'preonline') || 'test';
        const price = typeof options.price === 'number' ? options.price as number : undefined;
        const customPoints = typeof options['custom-points'] === 'number' ? options['custom-points'] as number : typeof options.customPoints === 'number' ? options.customPoints as number : undefined;
        const pointsPerSecond = typeof options['points-per-second'] === 'number' ? options['points-per-second'] as number : typeof options.pointsPerSecond === 'number' ? options.pointsPerSecond as number : undefined;
        const alias = (options.alias as string) || undefined;
        const channelId = options.channel !== undefined ? Number(options.channel) : (options['channel-id'] !== undefined ? Number(options['channel-id']) : undefined);
        const channelName = options['channel-name'] as string | undefined;
        const targetKind = options['target-kind'] as 'channel' | 'model' | undefined;
        const projectId = options['project-id'] !== undefined ? Number(options['project-id']) : undefined;
        const rawTarget = options['raw-target'] as string | undefined;
        const wait = Boolean(options.wait);
        const rawDbExtra = options['db-extra-confirmed'] ?? options.dbExtraConfirmed;
        const dbExtraConfirmed = rawDbExtra !== undefined ? Boolean(rawDbExtra) : undefined;
        const rawGwChannel = options['gateway-channel-confirmed'] ?? options.gatewayChannelConfirmed;
        const gatewayChannelConfirmed = rawGwChannel !== undefined ? Boolean(rawGwChannel) : undefined;
        const pollTimeoutSec = typeof options['poll-timeout'] === 'number'
          ? options['poll-timeout'] as number
          : typeof options['poll-timeout-sec'] === 'number'
          ? options['poll-timeout-sec'] as number
          : undefined;

        const sideEffectPolicy = (options['side-effect-policy'] || options.sideEffectPolicy) as any;
        const allowSubmit = Boolean(options['allow-submit'] || options.allowSubmit);
        const allowPaid = Boolean(options['allow-paid'] || options.allowPaid);
        const maxCostPoints = typeof options['max-cost-points'] === 'number'
          ? options['max-cost-points']
          : typeof options.maxCostPoints === 'number'
          ? options.maxCostPoints
          : undefined;
        const costLimit = maxCostPoints !== undefined
          ? { maxCostPoints, allowZeroCostOnly: false }
          : undefined;
        const requirement = options.requirement as string | undefined;

        const executionAdapter = dependencies?.executionAdapter
          || (options as any).executionAdapter
          || new PanquMediaExecutionAdapter({
            sessionFile,
            env,
            enableLiveSubmit: mode === 'real',
          });

        const execOptions: ExecuteKernelOptions = {
          modelId,
          mediaType,
          resolution,
          duration,
          mode,
          prompt,
          sessionFile,
          env,
          price,
          customPoints,
          pointsPerSecond,
          alias,
          channelId,
          channelName,
          targetKind,
          projectId,
          rawTarget,
          requirement,
          sideEffectPolicy,
          costLimit,
          allowSubmit,
          allowPaid,
          maxCostPoints,
          executionAdapter,
        };

        const result = await execute(execOptions);

        if (!wait) {
          if (isJson) {
            console.log(JSON.stringify(result, null, 2));
          } else {
            console.log(`\n${c.bold}${c.cyan}======================================================${c.reset}`);
            console.log(`${c.bold}🚀 DevTest 任务执行结果${c.reset} [${result.mode === 'real' ? `${c.red}REAL 真实执行${c.reset}` : `${c.green}MOCK 受控仿真${c.reset}`}]`);
            console.log(`${c.bold}任务编号:${c.reset} #${c.bold}${result.taskId}${c.reset}`);
            console.log(`${c.bold}模型规格:${c.reset} 模型 #${result.modelId} (${result.mediaType})`);
            console.log(`${c.bold}执行状态:${c.reset} ${result.status === 'SUBMITTED' || result.status === 'SUCCESS' ? `${c.green}● ${result.status}${c.reset}` : `${c.red}● ${result.status}${c.reset}`}`);
            console.log(`${c.bold}预扣积分:${c.reset} ${c.yellow}${result.points} pt${c.reset}`);
            console.log(`${c.bold}回执信息:${c.reset} ${result.message}`);
            if (result.credentialsMasked) {
              console.log(`${c.bold}安全凭据:${c.reset} ${c.dim}${result.credentialsMasked}${c.reset}`);
            }
            console.log(`${c.bold}${c.cyan}======================================================${c.reset}\n`);
          }
          return result.ok ? 0 : 1;
        }

        // --wait enabled: automatically pipe taskId into verify
        if (!result.ok || !result.taskId || result.taskId <= 0) {
          if (isJson) {
            console.log(JSON.stringify({ ok: false, error: result.message || 'Task submission failed', executeResult: result }, null, 2));
          } else {
            console.error(`${c.red}任务提交失败，无法进入轮询验真:${c.reset} ${result.message}`);
          }
          return 1;
        }

        if (!isJson) {
          console.log(`\n${c.cyan}⏳ 任务 #${result.taskId} 提交成功 (${result.points} pt)，开始等待终态轮询与闭环验真 (--wait)...${c.reset}`);
        }

        const verifyRes = await verify({
          taskId: result.taskId,
          modelId,
          mediaType,
          resolution,
          duration,
          sessionFile,
          env,
          price,
          customPoints,
          pointsPerSecond,
          alias,
          channelId,
          channelName,
          targetKind,
          projectId,
          pollTimeoutSec,
          isSimulated: result.isSimulated,
          dbExtraConfirmed,
          gatewayChannelConfirmed,
          onProgress: isJson ? undefined : (snapshot) => {
            process.stdout.write(`\r⏳ 轮询中... 任务 #${snapshot.taskId} 状态: ${snapshot.taskStatus} (进度: ${snapshot.progress ?? 0}%)   `);
          },
        });

        if (!isJson) {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          printVerifyResult(verifyRes);
        } else {
          console.log(JSON.stringify(verifyRes, null, 2));
        }

        return verifyRes.passed ? 0 : 1;
      }

      case 'verify': {
        const taskId = Number(options.task ?? options['task-id'] ?? options.taskId ?? 0);
        if (!taskId) {
          console.error(`${c.red}错误: 必须通过 --task <id> 指定任务编号${c.reset}`);
          return 1;
        }
        const modelId = options.model || options['model-id'] || options.modelId ? Number(options.model ?? options['model-id'] ?? options.modelId) : undefined;
        const mediaType = options.media || options['media-type'] || options.mediaType ? ((options.media ?? options['media-type'] ?? options.mediaType) as string).toLowerCase() as 'video' | 'image' : undefined;
        const expectedPoints = typeof options['expected-points'] === 'number' ? options['expected-points'] as number : undefined;
        const terminalStatus = (options['terminal-status'] as 'SUCCESS' | 'FAILED' | 'TIMEOUT') || undefined;
        const resolution = options.resolution as string | undefined;
        const duration = typeof options.duration === 'number' ? options.duration : undefined;
        const sessionFile = (options['session-file'] as string) || (options.session as string) || (options.sessionFile as string);
        const env = (options.env as 'test' | 'preonline') || 'test';
        const videoUrl = options['video-url'] as string | undefined;
        const imageUrl = options['image-url'] as string | undefined;
        const rawDbExtra = options['db-extra-confirmed'] ?? options.dbExtraConfirmed;
        const dbExtraConfirmed = rawDbExtra !== undefined ? Boolean(rawDbExtra) : undefined;
        const rawGwChannel = options['gateway-channel-confirmed'] ?? options.gatewayChannelConfirmed;
        const gatewayChannelConfirmed = rawGwChannel !== undefined ? Boolean(rawGwChannel) : undefined;
        const price = typeof options.price === 'number' ? options.price as number : undefined;
        const customPoints = typeof options['custom-points'] === 'number' ? options['custom-points'] as number : typeof options.customPoints === 'number' ? options.customPoints as number : undefined;
        const pointsPerSecond = typeof options['points-per-second'] === 'number' ? options['points-per-second'] as number : typeof options.pointsPerSecond === 'number' ? options.pointsPerSecond as number : undefined;
        const alias = (options.alias as string) || undefined;
        const channelId = options.channel !== undefined ? Number(options.channel) : (options['channel-id'] !== undefined ? Number(options['channel-id']) : undefined);
        const channelName = options['channel-name'] as string | undefined;
        const targetKind = options['target-kind'] as 'channel' | 'model' | undefined;
        const projectId = options['project-id'] !== undefined ? Number(options['project-id']) : undefined;
        const actualChannelId = options['actual-channel'] !== undefined ? Number(options['actual-channel']) : (options['actual-channel-id'] !== undefined ? Number(options['actual-channel-id']) : undefined);
        const actualChannelName = (options['actual-channel-name'] as string) || undefined;
        const fallbackChannel = (options['fallback-channel'] as string) || undefined;
        const retryProvider = (options['retry-provider'] as string) || undefined;
        const pollTimeoutSec = typeof options['poll-timeout'] === 'number'
          ? options['poll-timeout'] as number
          : typeof options['poll-timeout-sec'] === 'number'
          ? options['poll-timeout-sec'] as number
          : undefined;

        const verifyOptions: VerifyKernelOptions = {
          taskId,
          modelId,
          mediaType,
          expectedPoints,
          terminalStatus,
          resolution,
          duration,
          sessionFile,
          env,
          videoUrl,
          imageUrl,
          dbExtraConfirmed,
          gatewayChannelConfirmed,
          price,
          customPoints,
          pointsPerSecond,
          alias,
          channelId,
          channelName,
          targetKind,
          projectId,
          actualChannelId,
          actualChannelName,
          fallbackChannel,
          retryProvider,
          pollTimeoutSec,
          onProgress: isJson ? undefined : (snapshot) => {
            process.stdout.write(`\r⏳ 轮询中... 任务 #${snapshot.taskId} 状态: ${snapshot.taskStatus} (进度: ${snapshot.progress ?? 0}%)   `);
          },
        };

        const result = await verify(verifyOptions);

        if (!isJson) {
          process.stdout.write('\r' + ' '.repeat(60) + '\r');
          printVerifyResult(result);
        } else {
          console.log(JSON.stringify(result, null, 2));
        }

        return result.passed ? 0 : 1;
      }

      default: {
        console.error(`${c.red}未知命令: "${command}"${c.reset}\n`);
        console.log(HELP_TEXT.trim());
        return 1;
      }
    }
  } catch (err) {
    if (isJson) {
      console.log(JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }));
    } else {
      console.error(`${c.red}执行异常:${c.reset}`, err instanceof Error ? err.message : err);
    }
    return 1;
  }
}

// CLI 直调
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  runDevTestCli(args).then((code) => {
    process.exit(code);
  }).catch((err) => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
