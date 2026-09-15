#!/usr/bin/env node

/**
 * Panqu AI DevTest 本地命令行工具 (Unified DevTest CLI)
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
} from '../src/devtest/core-kernel.js';
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
  devtest plan --model 84 --media video [--flow diversion|direct] [--resolution 720p] [--json]

  ${c.yellow}# 3. 任务执行${c.reset}
  devtest execute --model 84 --media video [--mode mock|real] [--prompt "..."] [--json]

  ${c.yellow}# 4. 产物验真与对账${c.reset}
  devtest verify --task 12345 --model 84 --media video [--expected-points 28] [--json]

${c.bold}通用参数:${c.reset}
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

export async function runDevTestCli(args: string[]): Promise<number> {
  const { command, options } = parseCliArgs(args);
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
        const modelId = Number(options.model ?? options['model-id'] ?? options.modelId ?? 84);
        const mediaType = ((options.media ?? options['media-type'] ?? options.mediaType ?? 'video') as string).toLowerCase() as 'video' | 'image';
        const flowType = (options.flow ?? options['flow-type'] ?? options.flowType ?? 'diversion') as 'direct' | 'diversion';
        const resolution = options.resolution as string | undefined;
        const duration = typeof options.duration === 'number' ? options.duration : undefined;
        const requirement = (options.requirement as string) || (options.req as string);

        const planOptions: PlanKernelOptions = {
          modelId,
          mediaType,
          flowType,
          requirement,
          resolution,
          duration,
        };

        const result = await plan(planOptions);

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\n${c.bold}${c.cyan}======================================================${c.reset}`);
          console.log(`${c.bold}📋 DevTest 分流推导与测试规划${c.reset}`);
          console.log(`${c.bold}模型规格:${c.reset} 模型 #${result.modelId} (${result.mediaType}) | 模式: ${result.flowType}`);
          console.log(`${c.bold}分流决策:${c.reset} ${result.willDivert ? `${c.green}NEWAPI 切流 (线路 ${result.routeLine})${c.reset}` : `${c.yellow}DIRECT 直连 (线路 ${result.routeLine})${c.reset}`} [${result.decision}]`);
          console.log(`${c.bold}推导原因:${c.reset} ${result.reason}`);
          console.log(`${c.bold}基准计费:${c.reset} ${c.yellow}${result.expectedPoints} 积分${c.reset} ${c.dim}(约 ¥${(result.expectedPoints * 0.1).toFixed(2)})${c.reset}`);
          if (result.expectedSnapshot) {
            console.log(`${c.bold}切流快照:${c.reset} 模型别名=${c.cyan}${result.expectedSnapshot.newapiModel}${c.reset} | 分组=${result.expectedSnapshot.newapiGroup || 'default'}`);
          }
          console.log(`${c.bold}候选渠道:${c.reset} ${result.candidateChannels.join(', ') || '无可用渠道'}`);
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

        const execOptions: ExecuteKernelOptions = {
          modelId,
          mediaType,
          resolution,
          duration,
          mode,
          prompt,
          sessionFile,
          env,
        };

        const result = await execute(execOptions);

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

      case 'verify': {
        const taskId = Number(options.task ?? options['task-id'] ?? options.taskId ?? 0);
        if (!taskId) {
          console.error(`${c.red}错误: 必须通过 --task <id> 指定任务编号${c.reset}`);
          return 1;
        }
        const modelId = Number(options.model ?? options['model-id'] ?? options.modelId ?? 84);
        const mediaType = ((options.media ?? options['media-type'] ?? options.mediaType ?? 'video') as string).toLowerCase() as 'video' | 'image';
        const expectedPoints = typeof options['expected-points'] === 'number' ? options['expected-points'] as number : undefined;
        const terminalStatus = (options['terminal-status'] as 'SUCCESS' | 'FAILED') || 'SUCCESS';
        const resolution = options.resolution as string | undefined;
        const duration = typeof options.duration === 'number' ? options.duration : undefined;
        const sessionFile = (options['session-file'] as string) || (options.session as string) || (options.sessionFile as string);
        const env = (options.env as 'test' | 'preonline') || 'test';
        const videoUrl = options['video-url'] as string | undefined;
        const imageUrl = options['image-url'] as string | undefined;

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
        };

        const result = await verify(verifyOptions);

        if (isJson) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(`\n${c.bold}${c.cyan}======================================================${c.reset}`);
          console.log(`${c.bold}🔬 DevTest 物理验真与防资损对账${c.reset} [任务 #${result.taskId}]`);

          if (!result.artifact && result.billingAudit === 'SKIPPED_NO_LOGS') {
            console.log(`\n${c.yellow}⚠️ 提示: 当前未连接真实主站获取产物 URL / 账单流水，仅执行脱机静态演算，非线上真实验收结果。${c.reset}`);
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
          console.log(`${c.bold}最终裁决:${c.reset} ${verdictLabel}`);

          console.log(`\n${c.bold}1. 产物物理结构验真 (Media Inspection):${c.reset}`);
          if (result.artifact) {
            if (result.probeDurationMs !== undefined) {
              console.log(`   流式探测耗时: ${result.probeDurationMs} ms (Range: bytes=0-65535)`);
            }
            console.log(`   容器标识: ${result.artifact.containerIdentified ? `${c.green}✔ 完整${c.reset}` : `${c.red}✖ 缺失${c.reset}`} | 格式: ${result.artifact.format || 'unknown'}`);
            console.log(`   物理尺寸: ${result.artifact.dimensions ? `${result.artifact.dimensions.width}x${result.artifact.dimensions.height}` : 'N/A'}`);
            if (result.artifact.durationSeconds !== undefined) {
              console.log(`   视频时长: ${result.artifact.durationSeconds} 秒`);
            }
            console.log(`   数据块校验: ${result.artifact.hasMdat !== false ? `${c.green}✔ 音视频裸流有效${c.reset}` : `${c.red}✖ 缺少 mdat 数据块${c.reset}`}`);
            console.log(`   可解码状态: ${result.artifact.decodable ? `${c.green}✔ 完全符合规范${c.reset}` : `${c.red}✖ 结构异常${c.reset}`}`);
          } else {
            console.log(`   ${c.yellow}未获取产物二进制 Buffer (未提供 assetBuffer 且未连接主站获取产物 URL)${c.reset}`);
          }

          console.log(`\n${c.bold}2. 防资损账务对账 (Billing & Invariants):${c.reset}`);
          if (result.billing) {
            console.log(`   对账结果: ${result.billing.passed ? `${c.green}✔ PASS${c.reset}` : `${c.red}✖ MISMATCH${c.reset}`}`);
            console.log(`   基准扣费: 预扣 ${result.billing.preDeductedPoints} pt | 实扣 ${result.billing.netDeductedPoints} pt | 结算 ${result.billing.settledPoints} pt | 退款 ${result.billing.refundedPoints} pt`);
            if (result.invariants) {
              console.log(`   核心不变量核验:`);
              console.log(`     - [防重复扣费] antiDoubleBilling:   ${result.invariants.antiDoubleBilling ? `${c.green}✔ 符合${c.reset}` : `${c.red}✖ 存在多重扣费${c.reset}`}`);
              console.log(`     - [失败净扣归零] netChargeZero:       ${result.invariants.netChargeZero ? `${c.green}✔ 符合${c.reset}` : `${c.red}✖ 失败未完全退款${c.reset}`}`);
              console.log(`     - [退款幂等核销] refundIdempotency:   ${result.invariants.refundIdempotency ? `${c.green}✔ 符合${c.reset}` : `${c.red}✖ 重复退款${c.reset}`}`);
            }
          } else {
            console.log(`   ${c.yellow}未提供账单流水 (scoreLogs 缺失)，跳过账务对账 [SKIPPED_NO_LOGS]${c.reset}`);
          }

          if (result.reasons.length > 0) {
            console.log(`\n${c.bold}核验明细 / 告警:${c.reset}`);
            for (const r of result.reasons) console.log(`  ${result.passed ? c.green : c.yellow}👉 ${r}${c.reset}`);
          }
          console.log(`${c.bold}${c.cyan}======================================================${c.reset}\n`);
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
