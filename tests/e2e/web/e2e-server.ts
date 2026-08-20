// Phase 41：Web E2E 测试服务器（Playwright webServer 用）
// 职责：
//   1. 装配内存态 Platform Bundle（seedUsers + wan3 项目）
//   2. 种子确定性测试数据：Runs（COMPLETED / FAILED / RUNNING / P0-BLOCK）、
//      Suite / Plan / Template、Defect、Approval（PENDING / APPROVED / REJECTED）、Share token
//   3. 启动 Platform API + Web Dashboard（web/dist），监听固定端口
//   4. 把种子清单（ID / token / 账号）写入临时文件，供 Playwright 用例读取
// 每条用例独立可重复：内存态 + 每次 webServer 重启全量重建，无残留、无人工登录态。
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { createPlatformService } from '../../../src/platform/service/index.js';
import type { PlatformBundle } from '../../../src/platform/service/index.js';
import { createPlatformServer } from '../../../src/platform/api/index.js';
import { standardEnvironments } from '../../../src/platform/projects/project-schema.js';
import { createAIQualityService } from '../../../src/ai-quality/service.js';
import type { AIQualityService } from '../../../src/ai-quality/service.js';

export const WEB_E2E_PORT = Number(process.env.WEB_E2E_PORT ?? 8799);
export const WEB_E2E_HOST = process.env.WEB_E2E_HOST ?? '127.0.0.1';
export const WEB_E2E_JWT_SECRET = 'web-e2e-secret-phase41';
export const SEED_FILE = path.join(os.tmpdir(), 'panqu-web-e2e-seed.json');

export interface WebE2eSeed {
  baseUrl: string;
  projectId: string;
  users: Record<string, { username: string; password: string; role: string }>;
  runs: {
    completed: string;
    failed: string;
    running: string;
    p0Block: string;
    reviewApprove: string;
  };
  approvals: { pendingOnFailed: string; approve: string; rejected: string; p0Block: string };
  defects: string[];
  suiteId: string;
  planId: string;
  templateId: string;
  share: { runId: string; token: string };
  cases: string[];
  /** 41.12：项目隔离（order 项目仅 qa-b 可访问） */
  orderProject: { projectId: string; runId: string; environment: string };
  /** 44.1：版本化资产（TestAssets / AssetVersions 页面数据源） */
  assetVersions: { assetId: string };
  /** 47.1：AI 质量闭环（AI 改进页数据源） */
  aiQuality: {
    feedbackUnverified: string;
    proposalApprovable: string;
    proposalApproved: string;
    promptKey: string;
    shadowExperiment: string;
    canaryExperiment: string;
    knowledgeCandidate: string;
    /** 48.1：Continuous Evaluation 运行（持续评测 Tab 数据源） */
    continuousEval: string;
  };
}

/** 种子全部测试数据，返回清单 */
async function seed(bundle: PlatformBundle): Promise<Omit<WebE2eSeed, 'baseUrl' | 'aiQuality'>> {
  const S = bundle.service;
  const now = (): string => new Date().toISOString();
  const QA_ACTOR = 'qa-a';

  // 1) Suite / Plan / Template
  const suite = await bundle.workflow.suites.create({
    projectId: 'wan3', name: 'E2E 回归套件', caseIds: ['wan3-1080p-10s', 'wan3-1080p-5s'],
    tags: ['e2e', 'p0'], createdBy: QA_ACTOR, now,
  });
  const plan = await bundle.workflow.plans.create({
    projectId: 'wan3', name: 'E2E 回归计划', suiteIds: [suite.id], environment: 'staging',
    mode: 'REGRESSION', createdBy: QA_ACTOR, now,
  });
  const template = await bundle.workflow.templates.create({
    projectId: 'wan3', name: 'E2E 发布模板', environment: 'staging', suiteIds: [suite.id],
    mode: 'REGRESSION', budget: 10, releaseGate: true, createdBy: QA_ACTOR, now,
  });

  // 2) COMPLETED + PASS（报告 / 分享 / 导出）
  const r1 = await S.createRun({ projectId: 'wan3', environment: 'staging', trigger: 'autonomous', mode: 'AUTONOMOUS', budget: 10, releaseGate: true, actor: QA_ACTOR, role: 'QA' });
  await S.startRun(r1.runId);
  await S.saveCheckpoint({
    runId: r1.runId, stage: 'execution', completedCases: ['wan3-1080p-10s', 'wan3-1080p-5s'], remainingCases: [],
    decisionState: { decision: 'PASS', result: 'success', reason: '全部用例通过', timestamp: now() },
    budgetState: { spent: 0.5, budget: 10 }, traceId: r1.runId,
  });
  await bundle.telemetry.recordLLM({ runId: r1.runId, projectId: 'wan3', model: 'gpt-4o', inputTokens: 1000, outputTokens: 200, latencyMs: 800 });
  await S.completeRun(r1.runId);
  const run1 = await S.getRun(r1.runId);
  const share = await bundle.workflow.reports.share(run1!, QA_ACTOR);

  // 3) FAILED + REVIEW + 失败明细/RCA + 关联审批 + 关联 Defect
  const r2 = await S.createRun({ projectId: 'wan3', environment: 'test', trigger: 'pr', mode: 'REGRESSION', budget: 8, releaseGate: true, actor: QA_ACTOR, role: 'QA' });
  await S.startRun(r2.runId);
  await bundle.telemetry.recordExecution({ runId: r2.runId, projectId: 'wan3', phase: 'case:wan3-1080p-10s', result: 'failed', durationMs: 1200 });
  await bundle.telemetry.recordExecution({ runId: r2.runId, projectId: 'wan3', phase: 'case:wan3-1080p-5s', result: 'success', durationMs: 800 });
  await bundle.telemetry.recordRca({ runId: r2.runId, projectId: 'wan3', rcaId: 'rca-e2e-1', caseId: 'wan3-1080p-10s', predictedCategory: 'ASSERTION', confidence: 0.92 });
  // 创建 RCA 验证记录 → 报告摘要的 RCA 分类表有真实数据（category 使用合法 FailureCategory）
  await bundle.telemetry.verifyRca({ runId: r2.runId, rcaId: 'rca-e2e-1', predictedCategory: 'ASSERTION', actualCategory: 'ASSERTION', verifiedBy: QA_ACTOR });
  await S.saveCheckpoint({
    runId: r2.runId, stage: 'execution', completedCases: ['wan3-1080p-5s'], remainingCases: ['wan3-1080p-10s'],
    decisionState: { decision: 'REVIEW', result: 'review', reason: '存在失败用例，需人工确认', timestamp: now() },
    budgetState: { spent: 2.1, budget: 8 }, traceId: r2.runId,
  });
  await S.failRun(r2.runId);
  const approvalOnFailed = await bundle.approvals.request({ runId: r2.runId, action: 'release', riskLevel: 'risky', environment: 'test', requester: QA_ACTOR, reason: 'PR 失败需评估是否阻断发布' });
  const defect1 = await bundle.workflow.defects.create({
    projectId: 'wan3', title: '1080p 转码偶发花屏', severity: 'high', environment: 'test',
    runId: r2.runId, caseId: 'wan3-1080p-10s', description: 'PR 回归发现 1080p 转码出现花屏，需排查模型服务', createdBy: QA_ACTOR, now,
  });
  const defect2 = await bundle.workflow.defects.create({
    projectId: 'wan3', title: '视频编辑器导出卡顿', severity: 'medium', environment: 'staging', createdBy: QA_ACTOR, now,
  });

  // 4) RUNNING（Run Detail 实时刷新）
  const r3 = await S.createRun({ projectId: 'wan3', environment: 'staging', trigger: 'autonomous', mode: 'AUTONOMOUS', budget: 10, actor: QA_ACTOR, role: 'QA' });
  await S.startRun(r3.runId);
  await bundle.runs.updateProgress(r3.runId, 45);

  // 5) P0-BLOCK（Release 阻断）
  // 41.14 修复：run 环境从 production 改为 staging——E2E 用 qa（作用域 test/staging）查看 BLOCK 决策，
  //       production 环境会让 Run Detail API 403（环境作用域隔离），导致 BLOCK 报告用例失败。
  const r4 = await S.createRun({ projectId: 'wan3', environment: 'staging', trigger: 'release', mode: 'REGRESSION', budget: 5, releaseGate: true, actor: 'release-mgr', role: 'RELEASE_MANAGER' });
  await S.startRun(r4.runId);
  await bundle.telemetry.recordExecution({ runId: r4.runId, projectId: 'wan3', phase: 'case:wan3-1080p-10s', result: 'failed', durationMs: 900 });
  await S.saveCheckpoint({
    runId: r4.runId, stage: 'execution', completedCases: [], remainingCases: ['wan3-1080p-10s'],
    decisionState: { decision: 'BLOCK', result: 'blocked', reason: 'P0 失败，禁止发布', timestamp: now() },
    budgetState: {}, traceId: r4.runId,
  });
  await S.failRun(r4.runId);
  // 41.14 修复：requester 从 release-mgr 改为 qa-a——审批职责分离（27.3）禁止审批人审批自己发起的申请，
  //       否则 release-mgr 登录后点「驳回」会 403；改由 qa-a 发起、release-mgr 决策。
  const approvalP0 = await bundle.approvals.request({ runId: r4.runId, action: 'release', riskLevel: 'dangerous', environment: 'staging', requester: QA_ACTOR, reason: 'P0 失败，需审批是否强行发布' });

  // 6) REVIEW + 待审批（批准场景）
  const r5 = await S.createRun({ projectId: 'wan3', environment: 'staging', trigger: 'release', mode: 'REGRESSION', budget: 5, releaseGate: true, actor: QA_ACTOR, role: 'QA' });
  await S.startRun(r5.runId);
  await S.saveCheckpoint({
    runId: r5.runId, stage: 'execution', completedCases: ['wan3-1080p-10s', 'wan3-1080p-5s'], remainingCases: [],
    decisionState: { decision: 'REVIEW', result: 'review', reason: '等待发布审批', timestamp: now() },
    budgetState: {}, traceId: r5.runId,
  });
  await S.completeRun(r5.runId);
  const approvalApprove = await bundle.approvals.request({ runId: r5.runId, action: 'release', riskLevel: 'risky', environment: 'staging', requester: QA_ACTOR, reason: '发布审批（批准场景）' });

  // 7) REVIEW + REJECTED 历史
  const r6 = await S.createRun({ projectId: 'wan3', environment: 'test', trigger: 'pr', mode: 'REGRESSION', actor: QA_ACTOR, role: 'QA' });
  await S.startRun(r6.runId);
  await S.saveCheckpoint({
    runId: r6.runId, stage: 'execution', completedCases: [], remainingCases: [],
    decisionState: { decision: 'REVIEW', result: 'review', reason: '待审批', timestamp: now() },
    budgetState: {}, traceId: r6.runId,
  });
  await S.completeRun(r6.runId);
  const approvalRejected = await bundle.approvals.request({ runId: r6.runId, action: 'release', riskLevel: 'risky', environment: 'test', requester: QA_ACTOR, reason: '历史驳回审批' });
  await bundle.gate.reject(approvalRejected.approval.approvalId, 'release-mgr', 'RELEASE_MANAGER');

  // 8) 41.12 项目隔离：第二个项目 order（仅 qa-b 可访问）
  if (!bundle.projects.getProject('order')) {
    bundle.projects.createProject({
      id: 'order', name: 'ORDER 订单系统', businesses: ['e-commerce'], environments: standardEnvironments(),
    });
  }
  const rOrder = await S.createRun({ projectId: 'order', environment: 'test', trigger: 'pr', mode: 'REGRESSION', actor: 'qa-b', role: 'QA' });
  await S.startRun(rOrder.runId);
  await S.completeRun(rOrder.runId);

  // 9) 43.3 测试资产 + 版本历史（TestAssets / AssetVersions 页面数据源）
  //    导入 WAN3 真实 Test Case 目录（幂等），并对 WAN3-CORE-001 记录 v1/v2 两个版本供版本追溯/对比。
  await bundle.testAssets.importCatalog(undefined, { projectId: 'wan3', now });
  await bundle.workflow.versions.recordVersion({
    assetType: 'test-case', assetId: 'WAN3-CORE-001', changeReason: '初版', createdBy: QA_ACTOR, now,
    snapshot: { title: '文生视频-落日海岸', steps: ['打开视频制作页', '输入提示词并生成'], expected: '生成成功' },
  });
  await bundle.workflow.versions.recordVersion({
    assetType: 'test-case', assetId: 'WAN3-CORE-001', changeReason: '补充校验步骤', createdBy: 'qa-b', now,
    snapshot: { title: '文生视频-落日海岸', steps: ['打开视频制作页', '输入提示词并生成', '核对落库与播放'], expected: '生成成功；结果可播放' },
  });

  return {
    projectId: 'wan3',
    users: {
      admin: { username: 'admin', password: 'admin123', role: 'ADMIN' },
      qa: { username: 'qa-a', password: 'qa123456', role: 'QA' },
      qaB: { username: 'qa-b', password: 'qa123456', role: 'QA' },
      developer: { username: 'developer', password: 'dev123456', role: 'DEVELOPER' },
      release: { username: 'release-mgr', password: 'release123', role: 'RELEASE_MANAGER' },
      viewer: { username: 'viewer', password: 'view123456', role: 'VIEWER' },
    },
    runs: {
      completed: r1.runId,
      failed: r2.runId,
      running: r3.runId,
      p0Block: r4.runId,
      reviewApprove: r5.runId,
    },
    approvals: {
      pendingOnFailed: approvalOnFailed.approval.approvalId,
      approve: approvalApprove.approval.approvalId,
      rejected: approvalRejected.approval.approvalId,
      p0Block: approvalP0.approval.approvalId,
    },
    defects: [defect1.defectId, defect2.defectId],
    suiteId: suite.id,
    planId: plan.id,
    templateId: template.id,
    share: { runId: r1.runId, token: share.token },
    cases: ['wan3-1080p-10s', 'wan3-1080p-5s'],
    orderProject: { projectId: 'order', runId: rOrder.runId, environment: 'test' },
    // 44.1：版本化资产（AssetVersions 页面数据源）
    assetVersions: { assetId: 'WAN3-CORE-001' },
  };
}

/** 47.1：种子 AI 质量闭环数据（AI 改进页数据源，确定性可重复） */
function seedAiQuality(): { service: AIQualityService; refs: WebE2eSeed['aiQuality'] } {
  const svc = createAIQualityService();

  // 1) 未核验反馈（待核验 Tab：INCORRECT + UNDER_PREDICTION / WRONG 聚类）
  const fbRisk = svc.ingest({
    domain: 'RISK', prediction: 'P2', actual: 'P0',
    feedbackType: 'INCORRECT', source: 'HUMAN', channel: 'HUMAN_CORRECTION',
    note: 'E2E：P2 实为 P0', verified: false,
  });
  svc.ingest({
    domain: 'RCA', prediction: 'NETWORK', actual: 'MODEL',
    feedbackType: 'INCORRECT', source: 'HUMAN', channel: 'RCA_VERIFICATION',
    note: 'E2E：根因判错', verified: false,
  });
  svc.ingest({
    domain: 'RELEASE', prediction: 'PASS', actual: 'BLOCK',
    feedbackType: 'INCORRECT', source: 'PRODUCTION', channel: 'PRODUCTION_INCIDENT',
    note: 'E2E：漏判发布阻断', verified: false,
  });
  // 2) 已核验正确反馈（不进入待核验列表）
  svc.ingest({
    domain: 'RISK', prediction: 'P1', actual: 'P1',
    feedbackType: 'CORRECT', source: 'HUMAN', channel: 'HUMAN_CORRECTION', verified: true,
  });

  // 3) 自动提案（从错误聚类生成）
  const created = svc.autoProposals();
  const approvable = created[0];

  // 4) 离线评测 → EVALUATING + Gate PASS（可审批提案，保持未审批供 E2E 人工审批）
  svc.proposals.recordEvaluation(approvable.id, {
    baselineScore: 0.9, candidateScore: 0.94,
    benchmark: 'RISK_BENCHMARK', benchmarkVersion: 'v1',
    critical: { falsePass: 0, unsafeHealing: 0, p0Miss: 0 },
    qualityDelta: 0.01, qualityScore: 0.92,
  });

  // 5) 离线评测另一提案 → EVALUATING + Gate PASS，再人工审批 → APPROVED（创建实验数据源；必须人工，禁止 AI 自批）
  svc.proposals.recordEvaluation(created[1].id, {
    baselineScore: 0.88, candidateScore: 0.9,
    benchmark: 'RCA_BENCHMARK', benchmarkVersion: 'v1',
    critical: { falsePass: 0, unsafeHealing: 0, p0Miss: 0 },
    qualityDelta: 0.01, qualityScore: 0.9,
  });
  const approved = svc.proposals.approve(created[1].id, 'release-mgr');

  // 6) Prompt 版本：v1 ACTIVE + v2 DRAFT
  const pv1 = svc.prompts.add({ promptKey: 'risk', content: '风险评估 Prompt v1（E2E）', createdBy: 'release-mgr' });
  svc.prompts.recordScore(pv1.id, 0.9);
  const pv2 = svc.prompts.add({ promptKey: 'risk', content: '风险评估 Prompt v2（E2E）', createdBy: 'release-mgr' });
  svc.prompts.recordScore(pv2.id, 0.94);

  // 7) Model 版本：v3 ACTIVE + v4 DRAFT
  const mv3 = svc.models.add({ provider: 'deepseek', model: 'deepseek-chat', modelVersion: 'v3', configuration: { temperature: 0.2 }, createdBy: 'release-mgr' });
  svc.models.setActive(mv3.id);
  svc.models.add({ provider: 'deepseek', model: 'deepseek-chat', modelVersion: 'v4', configuration: { temperature: 0.1 }, createdBy: 'release-mgr' });

  // 8) 实验：Shadow COMPLETED + Canary RUNNING@5%
  const shadow = svc.experiments.createShadow({ proposalId: approved.id, candidateRef: 'risk-candidate' });
  svc.experiments.recordShadowObservation(shadow.id, {
    baseline: { accuracy: 0.9, latencyMs: 500, cost: 0.001, failureRate: 0.05, safety: 0 },
    candidate: { accuracy: 0.94, latencyMs: 480, cost: 0.0011, failureRate: 0.03, safety: 0 },
  });
  const canary = svc.experiments.createCanary({ proposalId: approved.id, candidateRef: 'risk-candidate' });

  // 9) 知识候选（PENDING_REVIEW，未经 Review 不进入生产）
  const kc = svc.knowledge.createCandidate({
    category: 'RISK', content: 'P0 级风险不应被降级为 P2（E2E 知识候选）',
    source: 'REAL_RUN', confidence: 0.85,
  });

  // 10) Continuous Evaluation 历史（Phase 48 / 43.20：真实 Benchmark 确定性运行，verdict PASS）
  svc.runContinuousEval({ schedule: 'NIGHTLY', triggeredBy: 'MANUAL', createdBy: 'release-mgr' });
  svc.runContinuousEval({ schedule: 'WEEKLY', triggeredBy: 'SCHEDULE', createdBy: 'SYSTEM' });
  const ceRelease = svc.runContinuousEval({ schedule: 'RELEASE', triggeredBy: 'RELEASE_GATE', createdBy: 'release-mgr' });

  return {
    service: svc,
    refs: {
      feedbackUnverified: fbRisk.id,
      proposalApprovable: approvable.id,
      proposalApproved: approved.id,
      promptKey: 'risk',
      shadowExperiment: shadow.id,
      canaryExperiment: canary.id,
      knowledgeCandidate: kc.id,
      continuousEval: ceRelease.id,
    },
  };
}

/** 启动 Web E2E 服务器（长驻）；供 Playwright webServer 调用 */
export async function startWebE2eServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const bundle = createPlatformService({
    seedProject: true,
    seedUsers: true,
    jwtSecret: WEB_E2E_JWT_SECRET,
    storage: 'memory',
    now: () => new Date().toISOString(),
  });
  await bundle.auth.ensureSeeded();

  const seeded = await seed(bundle);
  const aiQuality = seedAiQuality();
  const webDir = path.join(process.cwd(), 'web', 'dist');
  if (!fs.existsSync(path.join(webDir, 'index.html'))) {
    throw new Error(`Web Dashboard 未构建：${webDir}（先运行 npm run build:web）`);
  }

  const server = createPlatformServer({
    service: bundle.service,
    auth: bundle.auth,
    mode: 'test',
    port: WEB_E2E_PORT,
    host: WEB_E2E_HOST,
    now: () => new Date().toISOString(),
    webDir,
    // 47.1：注入种子 AI 质量闭环服务（AI 改进页有真实数据渲染）
    aiQuality: aiQuality.service,
    // 41.13：E2E 测试连跑时 QA Home 3s 轮询 + 登录 + 多页操作会在 60s 窗口内超过默认
    //       120 req/min/IP 配额 → 429 使页面数据加载失败。测试环境放开配额，避免误伤。
    rateLimitPerMinute: 100_000,
  });
  const { url } = await server.listen();
  const baseUrl = url.replace(/\/$/, '');
  const manifest: WebE2eSeed = { baseUrl, ...seeded, aiQuality: aiQuality.refs };
  fs.writeFileSync(SEED_FILE, JSON.stringify(manifest, null, 2));
  console.log(`WEB_E2E_SERVER=${baseUrl}`);
  console.log(`WEB_E2E_SEED=${SEED_FILE}`);
  return { url: baseUrl, close: () => server.close() };
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  startWebE2eServer().then(({ url }) => {
    console.log(`WEB_E2E_READY=${url}`);
    const timer = setInterval(() => undefined, 1000);
    const shutdown = async (): Promise<void> => {
      clearInterval(timer);
      process.exit(0);
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());
  }).catch((e: Error) => {
    console.error(`WEB_E2E_SERVER_FAIL: ${e.message}`);
    process.exit(1);
  });
}
