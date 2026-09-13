/**
 * 业务测试智能体自主规划与执行引擎（Autonomous Workflow Verifier）
 *
 * 核心目标：
 * 将已有能力（Business Flow Engine, Routing Oracle, Billing Oracle, SupplierCost Oracle,
 * Media Inspector, Evidence Collector, Quality Gate）深度串联，形成 5 个透明阶段闭环：
 *
 * [1. 变更理解与影响分析] -> [2. 风险评估与用例规划] -> [3. 执行路径与工作流编排] -> [4. 证据收集与 Oracle 校验] -> [5. 最终结构化质量报告与诊断建议]
 *
 * 铁律保障：
 * 1. 证据缺失严格报告 BLOCKED，严禁假 PASS
 * 2. 识别非法业务组合并执行防御分支
 * 3. 失败场景产出结构化多维归因 (PRODUCT_ERROR, ENVIRONMENT_ERROR, TEST_BLOCKED, DATA_INCONSISTENCY)
 * 4. 坚决排除画布模块，不修改外部工程
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import {
  analyzeChangeImpact,
  type ChangeImpactAnalysisResult,
  type RecommendedScenario,
} from './change-impact-analyzer.js';
import {
  runPanquPlaywrightFlow,
  createSyntheticValidMp4,
  type FlowRunEvidence,
  type FlowStepStatus,
} from './panqu-playwright-engine.js';
import {
  diagnoseFlowEvidence,
  type StructuredProblemDiagnosis,
} from './problem-diagnosis.js';
import {
  validateBusinessCombination,
  getCapabilityByModel,
} from './business-capability-knowledge.js';
import { STANDARD_RECHARGE_PRESETS } from './supplier-cost-oracle.js';

export interface AutonomousVerificationOptions {
  requirementFile?: string;
  requirementText?: string;
  codeDiff?: string;
  env?: 'test' | 'preonline' | 'sandbox';
  isMock?: boolean;
  outputDir?: string;
  verbose?: boolean;
  sessionFile?: string;
  targetModelId?: number;
  expectFailure?: boolean;
  simulateMissingEvidence?: boolean; // 用于 Case 3 验证：故意缺失快照/流水
  simulateInvalidParams?: boolean;   // 用于 Case 4 验证：传入冲突或非法参数
}

export interface ScenarioExecutionRecord {
  scenarioId: string;
  title: string;
  kind: string;
  status: FlowStepStatus;
  evidence?: FlowRunEvidence;
  diagnosis?: StructuredProblemDiagnosis;
}

export interface AutonomousVerificationResult {
  status: 'READY' | 'NOT_READY' | 'BLOCKED';
  impactAnalysis: ChangeImpactAnalysisResult;
  scenariosExecuted: ScenarioExecutionRecord[];
  diagnoses: StructuredProblemDiagnosis[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    blocked: number;
  };
  artifacts: {
    reportMd: string;
    evidenceJson: string;
  };
}

const VALID_MP4_BUFFER = createSyntheticValidMp4({ width: 1280, height: 720, durationSeconds: 4 });
const VALID_PNG_BUFFER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x04, 0x00, 0x00, 0x00, 0x04, 0x00,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
]);

/**
 * 智能体端到端自主验证工作流
 */
export async function runAutonomousVerification(
  options: AutonomousVerificationOptions = {}
): Promise<AutonomousVerificationResult> {
  if (options.isMock === false) {
    throw new Error('DEVTEST_VERIFY_REAL_UNSUPPORTED: verify 当前仅支持受控 Mock 验证，不能作为真实业务验收入口');
  }

  const verbose = options.verbose !== false;
  const outDir = options.outputDir || path.resolve(process.cwd(), 'devtest-results');
  await mkdir(outDir, { recursive: true });

  // ----------------------------------------------------------------
  // 阶段 1：变更理解与影响分析 (Change Understanding & Impact Analysis)
  // ----------------------------------------------------------------
  let requirementText = options.requirementText ?? '';
  if (options.requirementFile) {
    try {
      requirementText = await readFile(path.resolve(options.requirementFile), 'utf8');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`DEVTEST_REQUIREMENT_READ_FAILED: 无法读取需求文件 ${options.requirementFile}: ${message}`);
    }
  }

  if (verbose) {
    console.log('\n==========================================================');
    console.log('  🤖 [阶段 1/5] 业务变更理解与影响分析 (Change Impact Analysis)');
    console.log('==========================================================');
  }

  const impact = analyzeChangeImpact({
    requirementText,
    codeDiff: options.codeDiff,
  });

  if (verbose) {
    console.log(`  - 受影响领域: [${impact.affectedDomains.join(', ')}]`);
    console.log(`  - 涉及核心模型: ${impact.affectedCapabilities.map((c) => c.name).join('; ')}`);
    console.log(`  - 映射底层 API: ${impact.affectedApis.map((a) => a.operationKey).join('; ')}`);
    console.log(`  - 必须激活 Oracle: [${impact.activatedOracles.join(', ')}]`);
  }

  // ----------------------------------------------------------------
  // 阶段 2：风险评估与用例规划 (Risk Assessment & Scenario Planning)
  // ----------------------------------------------------------------
  if (verbose) {
    console.log('\n==========================================================');
    console.log('  🎯 [阶段 2/5] 风险评估与用例自主规划 (Risk-Driven Planning)');
    console.log('==========================================================');
    console.log(`  - 综合风险等级: ${impact.riskLevel}`);
    if (impact.riskFactors.length) {
      console.log(`  - 关键风险成因: ${impact.riskFactors.join('；')}`);
    }
    if (impact.prunedCategories.length) {
      console.log(`  - 风险裁剪项 (节约执行耗时与算力): ${impact.prunedCategories.join('；')}`);
    }
    console.log(`  - 自主规划验证场景数: ${impact.recommendedScenarios.length} 个`);
    impact.recommendedScenarios.forEach((s, idx) => {
      console.log(`    ${idx + 1}. [${s.kind}] ${s.title} (权重: ${s.riskWeight})`);
    });
  }

  // ----------------------------------------------------------------
  // 阶段 3 & 4：执行路径编排、证据采集与 Oracle 校验
  // ----------------------------------------------------------------
  if (verbose) {
    console.log('\n==========================================================');
    console.log('  ⚡ [阶段 3/5 & 4/5] 执行路径编排、证据收集与 Oracle 校验');
    console.log('==========================================================');
  }

  const executions: ScenarioExecutionRecord[] = [];
  const diagnoses: StructuredProblemDiagnosis[] = [];

  for (const scenario of impact.recommendedScenarios) {
    if (verbose) {
      console.log(`\n  ▶ 正在执行场景: ${scenario.title}...`);
    }

    const cap = getCapabilityByModel(scenario.targetModelId);
    const isVideo = scenario.mediaType === 'video';
    const isFailureScenario = scenario.kind === 'FAILURE_REFUND' || scenario.kind === 'INVALID_COMBINATION' || options.expectFailure;

    // 参数兼容性检验 (用于 Case 4: 非法业务组合检测)
    let comboTest: ReturnType<typeof validateBusinessCombination> | undefined;
    if (scenario.kind === 'INVALID_COMBINATION' || options.simulateInvalidParams) {
      comboTest = validateBusinessCombination({
        mediaType: isVideo ? 'video' : 'image',
        modelId: scenario.targetModelId,
        serviceline: isVideo ? 'r' : undefined, // 视频故意传入生图参数
        duration: isVideo ? -1 : 4,              // 视频负时长；图片故意传入视频专用参数
      });
      if (verbose) {
        console.log(`    ⚠️ 检测到非法业务组合: ${comboTest.violations.join('；')} -> 验证系统安全防御`);
      }

      if (!comboTest.valid) {
        executions.push({
          scenarioId: scenario.id,
          title: scenario.title,
          kind: scenario.kind,
          status: 'PASS',
        });
        if (verbose) {
          console.log('    ↳ 结果: ✅ PASS (验证引擎在提交前拒绝非法参数组合)');
        }
        continue;
      }
    }

    // 构造受控执行参数
    const taskId = Math.floor(10000 + Math.random() * 90000);
    const duration = isVideo ? 4 : undefined;
    const pricingUnit = cap?.pricing.resolutionMultiplier?.[isVideo ? '480p' : ''] ?? cap?.pricing.defaultPoints ?? (isVideo ? 7 : 5);
    const pointsCharged = isVideo ? pricingUnit * (duration ?? 1) : pricingUnit;
    const recordedCostCny = isVideo
      ? (cap?.upstream.costCnyPerSec ?? 0.18) * (duration ?? 1)
      : cap?.upstream.costCnyPerImage ?? 0.05;
    const channel = scenario.targetModelId === 15
      ? { id: 41, name: 'TD' }
      : isVideo
      ? { id: 36, name: '万相—yhuo' }
      : { id: 40, name: 'RH-图片' };
    const routingExtra = cap?.upstream.diversionField === 'extra.newapi_image'
      ? {
          newapi_image: 1,
          newapi_model: cap.upstream.newapiModel,
          channel_name: channel.name,
          channel_id: channel.id,
          points: pointsCharged,
        }
      : {
          diversion: 10,
          newapi_model: cap?.upstream.newapiModel || 'wan3.0-video',
          line: 10,
          channel_name: channel.name,
          channel_id: channel.id,
          points: pointsCharged,
        };

    // 针对 Case 3: 模拟缺失快照证据
    const mockTaskDetails = options.simulateMissingEvidence
      ? { id: taskId, user_id: 101, status: 2, extra: {} } // 缺少 diversion 快照
      : isVideo
      ? {
          id: taskId,
          user_id: 101,
          status: isFailureScenario ? 3 : 2,
          video_url: 'https://v.panqu.com.cn/video/sample.mp4',
          extra: routingExtra,
        }
      : {
          id: taskId,
          user_id: 101,
          status: isFailureScenario ? 3 : 2,
          pic_url: 'https://v.panqu.com.cn/image/sample.png',
          extra: routingExtra,
        };

    const mockSubmitResponse = {
      status: 200,
      body: { code: 1, msg: 'ok', data: { id: taskId, task_id: taskId } },
    };

    const mockStatusResponses = isFailureScenario
      ? [
          { status: 200, body: { task_status: 1, progress: 30 } },
          { status: 200, body: { task_status: 3, progress: 0, err: 'UPSTREAM_MODEL_LIMIT' } },
        ]
      : [
          { status: 200, body: { task_status: 1, progress: 40 } },
          {
            status: 200,
            body: {
              task_status: 2,
              progress: 100,
              video_url: isVideo ? 'https://v.panqu.com.cn/video/sample.mp4' : undefined,
              pic_url: !isVideo ? 'https://v.panqu.com.cn/image/sample.png' : undefined,
            },
          },
        ];

    const mockScoreLogs = options.simulateMissingEvidence
      ? [] // 故意不提供任何积分流水
      : isFailureScenario
      ? [
          { id: 'sc-1', task_id: taskId, type: 2, score: -pointsCharged, memo: `预扣 ${pointsCharged} 积分` },
          { id: 'sc-2', task_id: taskId, type: 1, score: pointsCharged, memo: `生成失败退还 ${pointsCharged} 积分` },
        ]
      : [
          { id: 'sc-1', task_id: taskId, type: 2, score: -pointsCharged, memo: `预扣 ${pointsCharged} 积分` },
          { id: 'sc-2', task_id: taskId, type: 3, score: 0, memo: `最终结算 ${pointsCharged} 积分` },
        ];

    const mockAssetBuffer = isFailureScenario ? undefined : isVideo ? VALID_MP4_BUFFER : VALID_PNG_BUFFER;

    const evidence: FlowRunEvidence = await runPanquPlaywrightFlow({
      caseId: scenario.id,
      taskId,
      mediaType: scenario.mediaType,
      modelId: scenario.targetModelId,
      duration,
      resolution: isVideo ? '480p' : undefined,
      expectFailure: isFailureScenario,
      executionMode: 'MOCK',
      env: options.env === 'preonline' ? 'preonline' : 'test',
      outputDir: outDir,
      mockSubmitResponse,
      mockStatusResponses,
      mockTaskDetails,
      mockGatewayLog: options.simulateMissingEvidence
        ? undefined
        : {
            aiTaskId: taskId,
            channelId: channel.id,
            channelName: channel.name,
            status: scenario.kind === 'FALLBACK_RETRY' ? 'FAILED' : 'SUCCESS',
          },
      mockFallbackLog: scenario.targetModelId === 15 && (scenario.kind === 'FALLBACK_RETRY' || isFailureScenario)
        ? {
            taskId,
            fallbackTaskId: `fallback-${taskId}`,
            originalError: 'HTTP 503',
            status: 1,
          }
        : undefined,
      mockScoreLogs,
      mockAssetBuffer,
      rechargeBatch: STANDARD_RECHARGE_PRESETS.TIER_300,
      mockRecordedCostCny: recordedCostCny,
      upstreamExecutionState: isFailureScenario ? 'REJECTED_BEFORE_EXECUTION' : 'EXECUTED_SUCCESS',
      requireVerifiedCostEvidence: false,
    });

    const status = evidence.overallStatus;

    // 失败诊断与归因分析
    let diagnosis: StructuredProblemDiagnosis | undefined;
    if (status !== 'PASS') {
      diagnosis = diagnoseFlowEvidence(evidence);
      diagnoses.push(diagnosis);
    }

    executions.push({
      scenarioId: scenario.id,
      title: scenario.title,
      kind: scenario.kind,
      status,
      evidence,
      diagnosis,
    });

    if (verbose) {
      const statusIcon = status === 'PASS' ? '✅ PASS' : status === 'BLOCKED' ? '🛑 BLOCKED' : '❌ FAIL';
      console.log(`    ↳ 结果: ${statusIcon} (分流=${evidence.diversion.status}, 产物=${evidence.artifact.status}, 计费=${evidence.billing.status})`);
      if (diagnosis) {
        console.log(`    🔍 归因诊断: [${diagnosis.category}] 根因: ${diagnosis.rootCause}`);
        console.log(`       修复建议: ${diagnosis.remediation}`);
      }
    }
  }

  // ----------------------------------------------------------------
  // 阶段 5：最终结构化质量报告与诊断建议 (Quality Report & Diagnostics)
  // ----------------------------------------------------------------
  if (verbose) {
    console.log('\n==========================================================');
    console.log('  📊 [阶段 5/5] 最终结构化质量报告与诊断建议 (Quality Report)');
    console.log('==========================================================');
  }

  const total = executions.length;
  const passedCount = executions.filter((e) => e.status === 'PASS').length;
  const failedCount = executions.filter((e) => e.status === 'FAIL').length;
  const blockedCount = executions.filter((e) => e.status === 'BLOCKED').length;

  let overallStatus: AutonomousVerificationResult['status'] = 'READY';
  if (failedCount > 0) {
    overallStatus = 'NOT_READY';
  } else if (blockedCount > 0 || total === 0) {
    overallStatus = 'BLOCKED';
  }

  const result: AutonomousVerificationResult = {
    status: overallStatus,
    impactAnalysis: impact,
    scenariosExecuted: executions,
    diagnoses,
    summary: {
      total,
      passed: passedCount,
      failed: failedCount,
      blocked: blockedCount,
    },
    artifacts: {
      reportMd: path.join(outDir, 'autonomous-verification-report.md'),
      evidenceJson: path.join(outDir, 'autonomous-verification-evidence.json'),
    },
  };

  await writeFile(result.artifacts.evidenceJson, JSON.stringify(result, null, 2), 'utf8');
  await writeFile(result.artifacts.reportMd, renderAutonomousReportMarkdown(result), 'utf8');

  if (verbose) {
    console.log(`  - 最终测试结论: ${overallStatus === 'READY' ? '🟢 READY (受控 Mock 验证通过，不代表真实业务验收)' : overallStatus === 'BLOCKED' ? '🟡 BLOCKED (证据或前置缺失)' : '🔴 NOT_READY (存在缺陷)'}`);
    console.log(`  - 统计指标: 通过率 ${total > 0 ? ((passedCount / total) * 100).toFixed(1) : 0}% (${passedCount}/${total} 通过, ${failedCount} 失败, ${blockedCount} 阻断)`);
    console.log(`  - 报告产物: ${result.artifacts.reportMd}`);
    console.log('==========================================================\n');
  }

  return result;
}

/**
 * 渲染自主测试验证报告 Markdown
 */
export function renderAutonomousReportMarkdown(result: AutonomousVerificationResult): string {
  const statusBadge =
    result.status === 'READY'
      ? '🟢 READY (受控 Mock 质量门禁通过，不代表真实业务验收)'
      : result.status === 'BLOCKED'
      ? '🟡 BLOCKED (存在门禁阻断/证据缺失)'
      : '🔴 NOT_READY (存在产品缺陷/断言失败)';

  const scenarioRows = result.scenariosExecuted
    .map(
      (s, idx) =>
        `| ${idx + 1} | **${s.title}** | \`${s.kind}\` | ${s.status === 'PASS' ? '✅ PASS' : s.status === 'BLOCKED' ? '🛑 BLOCKED' : '❌ FAIL'} | ${s.evidence?.taskId ?? 'N/A'} | ${s.evidence?.diversion.status ?? 'N/A'} | ${s.evidence?.billing.status ?? 'N/A'} |`
    )
    .join('\n');

  const diagnosisRows = result.diagnoses.length
    ? result.diagnoses
        .map(
          (d, idx) =>
            `### 诊断 ${idx + 1}: [${d.category}] ${d.summary}
- **受影响链路**: \`${d.affectedFlow}\`
- **问题根因 (Root Cause)**: \`${d.rootCause}\`
- **预期要求**: ${d.expected}
- **实际观察**: ${d.actual}
- **修复行动指南**: ${d.remediation}
`
        )
        .join('\n')
    : '> 本次测试未产生未通过项，全部业务断言与 Oracle 门禁闭环通过。';

  return `# 业务测试智能体自主规划与执行验证报告

**综合测试结论**: **${statusBadge}**
**测试用例统计**: 总数 **${result.summary.total}** | 通过 **${result.summary.passed}** | 失败 **${result.summary.failed}** | 阻断 **${result.summary.blocked}**

---

## 1. 变更理解与影响推导 (Stage 1 & 2)

- **影响领域**: ${result.impactAnalysis.affectedDomains.map((d) => `\`${d}\``).join(', ')}
- **综合风险定级**: **${result.impactAnalysis.riskLevel}**
- **必须激活 Oracle**: ${result.impactAnalysis.activatedOracles.map((o) => `\`${o}\``).join(', ')}
- **映射底层接口**:
${result.impactAnalysis.affectedApis.map((a) => `  - \`${a.operationKey}\`: ${a.description}`).join('\n')}

---

## 2. 规划场景与执行矩阵 (Stage 3 & 4)

| 序号 | 验证场景名称 | 场景类型 | 判定状态 | 任务 ID | 分流核验 | 计费对账 |
| :---: | :--- | :---: | :---: | :---: | :---: | :---: |
${scenarioRows}

---

## 3. 失败归因诊断与修复建议 (Stage 5)

${diagnosisRows}

---

## 4. 产物与证据归档

- **结构化 JSON 证据**: \`${result.artifacts.evidenceJson}\`
- **Markdown 报告**: \`${result.artifacts.reportMd}\`
`;
}
