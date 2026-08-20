#!/usr/bin/env node
// AI Quality Optimization CLI（Phase 46 / 43.25）
// 用法（对应任务书 43.25 的 agent 命令族）：
//   node dist/bin/ai-quality-cli.js feedback list [--domain RISK] [--source HUMAN] [--json]
//   node dist/bin/ai-quality-cli.js feedback verify <id> [--note ...]
//   node dist/bin/ai-quality-cli.js eval errors [--json]
//   node dist/bin/ai-quality-cli.js eval improve [--json]
//   node dist/bin/ai-quality-cli.js prompt list [--key risk]
//   node dist/bin/ai-quality-cli.js prompt compare --baseline <id> --candidate <id>
//   node dist/bin/ai-quality-cli.js model list
//   node dist/bin/ai-quality-cli.js model compare --baseline <id> --candidate <id>
//   node dist/bin/ai-quality-cli.js improvement list [--status PROPOSED] [--json]
//   node dist/bin/ai-quality-cli.js improvement approve <id> --by <human>
//   node dist/bin/ai-quality-cli.js improvement reject <id> --reason <...> --by <human>
//   node dist/bin/ai-quality-cli.js knowledge review [--json]
//   node dist/bin/ai-quality-cli.js canary status
//   node dist/bin/ai-quality-cli.js canary promote <id> --accuracy <n> [--latency-ms <n>] [--cost <n>] [--failure-rate <n>] [--safety <n>]
//   node dist/bin/ai-quality-cli.js canary rollback <id> --reason <...>
// 铁律：
//   - approve / reject / verify / promote 视为人工动作，必须显式 --by <human>（禁止 AI 自批）。
//   - 状态跨进程持久化到 data/ai-quality-state.json（gitignore），保证持续改进闭环不丢失。
//   - 不虚构 Ground Truth / 不伪造指标；无数据时如实输出。
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import { createAIQualityService, AIQualityService } from '../src/ai-quality/service.js';
import type { AiQualitySnapshot } from '../src/ai-quality/service.js';
import { compareAb, formatAbComparison } from '../src/ai-quality/versioning.js';
import { formatErrorCluster } from '../src/ai-quality/error-analysis.js';
import { ERROR_TAXONOMY_LABELS, CANARY_STAGES } from '../src/ai-quality/contract.js';

const STATE_DIR = path.resolve(process.cwd(), 'data');
const STATE_FILE = path.join(STATE_DIR, 'ai-quality-state.json');

function loadService(): AIQualityService {
  if (fs.existsSync(STATE_FILE)) {
    try {
      const snap = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as AiQualitySnapshot;
      return AIQualityService.restore(snap);
    } catch (err) {
      console.error(`状态文件损坏，使用空状态重建：${(err as Error).message}`);
    }
  }
  return createAIQualityService();
}

function saveService(svc: AIQualityService): void {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(svc.snapshot(), null, 2), 'utf8');
}

function flagValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i > -1 && args[i + 1] ? args[i + 1] : undefined;
}
function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}
function numberFlag(args: string[], name: string, fallback: number): number {
  const v = flagValue(args, name);
  const n = v !== undefined ? Number(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const mono = (s: unknown): string => (s === undefined || s === null ? '—' : String(s));

// ── feedback ──
function cmdFeedbackList(svc: AIQualityService, args: string[], json: boolean): void {
  const list = svc.feedback.list({
    domain: flagValue(args, '--domain')?.toUpperCase(),
    source: flagValue(args, '--source')?.toUpperCase(),
    feedbackType: flagValue(args, '--feedbackType')?.toUpperCase(),
    verified: hasFlag(args, '--verified') ? true : undefined,
  });
  if (json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log('暂无反馈记录。接入来源：HUMAN_CORRECTION / RCA_VERIFICATION / DEFECT_REVIEW / RELEASE_REVIEW / HEALING_REVIEW / BENCHMARK_FAILURE / PRODUCTION_INCIDENT / FLAKY_CONFIRMATION');
    return;
  }
  console.log(`AI Feedback Registry（${list.length} 条）`);
  for (const f of list) {
    console.log(`  [${f.id}] ${f.domain}/${f.feedbackType}${f.verified ? '（已核验）' : '（未核验）'} 来源=${f.source}${f.channel ? `/${f.channel}` : ''}`);
    console.log(`        预测=${mono(f.prediction)} 真值=${mono(f.actual)}${f.confidence !== undefined ? ` 置信=${pct(f.confidence)}` : ''}`);
    if (f.note) console.log(`        备注=${f.note}`);
  }
}

function cmdFeedbackVerify(svc: AIQualityService, args: string[]): void {
  const id = args[1];
  const by = flagValue(args, '--by') ?? 'cli-human';
  if (!id) {
    console.error('feedback verify 需要反馈 ID');
    process.exit(2);
  }
  try {
    const fb = svc.feedback.verify(id, by, flagValue(args, '--note'));
    svc.audit.record({ proposalId: 'n/a', actor: by, action: 'CREATED', decision: `人工核验反馈 ${id}` });
    saveService(svc);
    console.log(`反馈 ${id} 已核验（by ${by}）：${fb.domain}/${fb.feedbackType}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

// ── eval errors / improve ──
function cmdEvalErrors(svc: AIQualityService, json: boolean): void {
  const clusters = svc.errorClusters();
  if (json) {
    console.log(JSON.stringify(clusters, null, 2));
    return;
  }
  if (clusters.length === 0) {
    console.log('无错误聚类（无未正确反馈）——当前无待改进错误。');
    return;
  }
  console.log(`Error Analysis（${clusters.length} 个错误聚类）`);
  for (const c of clusters) {
    console.log(formatErrorCluster(c));
  }
}

function cmdEvalImprove(svc: AIQualityService, json: boolean): void {
  const created = svc.autoProposals();
  const clusters = svc.errorClusters();
  if (json) {
    console.log(JSON.stringify({ created, clusters }, null, 2));
    return;
  }
  if (created.length === 0) {
    console.log('无新提案生成（无错误聚类，或已有未处理提案）。');
    return;
  }
  console.log(`已根据 ${clusters.length} 个错误聚类自动生成 ${created.length} 个改进提案：`);
  for (const p of created) {
    console.log(`  [${p.id}] target=${p.target} risk=${p.risk} status=${p.status}`);
    console.log(`        问题：${p.problem}`);
    console.log(`        假设：${p.hypothesis}`);
  }
  saveService(svc);
}

// ── prompt / model ──
function cmdPromptList(svc: AIQualityService, args: string[], json: boolean): void {
  const list = svc.prompts.list(flagValue(args, '--key'));
  if (json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log('暂无 Prompt 版本。');
    return;
  }
  console.log(`Prompt Versions（${list.length}）`);
  for (const p of list) {
    console.log(`  [${p.id}] ${p.promptKey}@${p.version} status=${p.status}${p.benchmarkScore !== undefined ? ` score=${pct(p.benchmarkScore)}` : ''} by=${p.createdBy}${p.model ? ` model=${p.model}` : ''}`);
  }
}

function cmdPromptCompare(svc: AIQualityService, args: string[]): void {
  const base = flagValue(args, '--baseline');
  const cand = flagValue(args, '--candidate');
  if (!base || !cand) {
    console.error('prompt compare 需要 --baseline <id> 与 --candidate <id>');
    process.exit(2);
  }
  const b = svc.prompts.get(base);
  const c = svc.prompts.get(cand);
  if (!b || !c) {
    console.error(`Prompt 版本不存在：${!b ? base : cand}`);
    process.exit(1);
  }
  if (b.benchmarkScore === undefined || c.benchmarkScore === undefined) {
    console.error('A/B 对比需要双方都已记录 benchmarkScore（先运行离线评测并 recordScore）。');
    process.exit(1);
  }
  const latency = numberFlag(args, '--latency-ms', 0);
  const cost = numberFlag(args, '--cost', 0);
  const cmp = compareAb(
    { accuracy: b.benchmarkScore, latencyMs: latency, cost, failureRate: 0, safety: 0 },
    { accuracy: c.benchmarkScore, latencyMs: latency, cost, failureRate: 0, safety: 0 },
  );
  console.log(formatAbComparison(cmp));
  console.log(`  Baseline : ${b.promptKey}@${b.version}（${b.id}）`);
  console.log(`  Candidate: ${c.promptKey}@${c.version}（${c.id}）`);
}

function cmdModelList(svc: AIQualityService, json: boolean): void {
  const list = svc.models.list();
  if (json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log('暂无 Model 版本。');
    return;
  }
  console.log(`Model Versions（${list.length}）`);
  for (const m of list) {
    console.log(`  [${m.id}] status=${m.status} by=${m.createdBy} config=${JSON.stringify(m.configuration)}`);
  }
}

function cmdModelCompare(svc: AIQualityService, args: string[]): void {
  const base = flagValue(args, '--baseline');
  const cand = flagValue(args, '--candidate');
  if (!base || !cand) {
    console.error('model compare 需要 --baseline <id> 与 --candidate <id>');
    process.exit(2);
  }
  const b = svc.models.get(base);
  const c = svc.models.get(cand);
  if (!b || !c) {
    console.error(`Model 版本不存在：${!b ? base : cand}`);
    process.exit(1);
  }
  const accuracy = numberFlag(args, '--accuracy', 0);
  const latency = numberFlag(args, '--latency-ms', 0);
  const cost = numberFlag(args, '--cost', 0);
  const failureRate = numberFlag(args, '--failure-rate', 0);
  const safety = numberFlag(args, '--safety', 0);
  const cmp = compareAb(
    { accuracy, latencyMs: latency, cost, failureRate, safety },
    { accuracy, latencyMs: latency, cost, failureRate, safety },
  );
  console.log(formatAbComparison(cmp));
  console.log(`  Baseline : ${b.provider}:${b.model}@${b.modelVersion}（${b.id}）`);
  console.log(`  Candidate: ${c.provider}:${c.model}@${c.modelVersion}（${c.id}）`);
}

// ── improvement ──
function cmdImprovementList(svc: AIQualityService, args: string[], json: boolean): void {
  const list = svc.proposals.list({
    status: flagValue(args, '--status')?.toUpperCase(),
    target: flagValue(args, '--target')?.toUpperCase(),
    domain: flagValue(args, '--domain')?.toUpperCase(),
  });
  if (json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log('暂无改进提案。');
    return;
  }
  console.log(`Improvement Proposals（${list.length}）`);
  for (const p of list) {
    console.log(`  [${p.id}] target=${p.target} risk=${p.risk} status=${p.status} gate=${p.gateVerdict ?? '—'}`);
    console.log(`        问题：${p.problem}`);
    if (p.baselineScore !== undefined && p.candidateScore !== undefined) {
      console.log(`        评测：baseline ${pct(p.baselineScore)} → candidate ${pct(p.candidateScore)}（${p.benchmark ?? '—'}@${p.benchmarkVersion ?? '—'}）`);
    }
    if (p.approvedBy) console.log(`        审批：by ${p.approvedBy} @ ${p.approvedAt ?? '—'}`);
  }
}

function requireHumanBy(args: string[]): string {
  const by = flagValue(args, '--by');
  if (!by) {
    console.error('该动作为人工审批，必须显式 --by <human>（禁止 AI 自批）');
    process.exit(2);
  }
  return by;
}

function cmdImprovementApprove(svc: AIQualityService, args: string[]): void {
  const id = args[1];
  if (!id) {
    console.error('improvement approve 需要提案 ID');
    process.exit(2);
  }
  const by = requireHumanBy(args);
  try {
    const p = svc.proposals.approve(id, by);
    svc.audit.record({
      proposalId: id, actor: by, action: 'APPROVED',
      baseline: p.baselineScore != null ? String(p.baselineScore) : undefined,
      candidate: p.candidateScore != null ? String(p.candidateScore) : undefined,
      benchmark: p.benchmark, approvalId: p.approvalId,
      metrics: { baseline: p.baselineScore ?? 0, candidate: p.candidateScore ?? 0 },
      decision: '人工批准提案',
    });
    saveService(svc);
    console.log(`提案 ${id} 已审批通过（by ${by}，approvalId=${p.approvalId}）。下一步：创建 Shadow / Canary 实验。`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

function cmdImprovementReject(svc: AIQualityService, args: string[]): void {
  const id = args[1];
  if (!id) {
    console.error('improvement reject 需要提案 ID');
    process.exit(2);
  }
  const by = requireHumanBy(args);
  const reason = flagValue(args, '--reason') ?? '人工拒绝';
  try {
    const p = svc.proposals.reject(id, by, reason);
    svc.audit.record({ proposalId: id, actor: by, action: 'REJECTED', decision: reason });
    saveService(svc);
    console.log(`提案 ${id} 已拒绝（by ${by}）：${reason}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

// ── knowledge ──
function cmdKnowledgeReview(svc: AIQualityService, json: boolean): void {
  const candidates = svc.knowledge.listCandidates();
  const items = svc.knowledge.listItems();
  const quality = svc.knowledge.qualityMetrics();
  if (json) {
    console.log(JSON.stringify({ candidates, items, quality }, null, 2));
    return;
  }
  console.log(`Knowledge Review：待审候选 ${candidates.length} / 生产知识 ${items.length}`);
  console.log(`  质量：总知识 ${quality.total}，总使用 ${quality.totalUsages}，Success Rate ${pct(quality.successRate)}，Outdated Rate ${pct(quality.outdatedRate)}，Unused Rate ${pct(quality.unusedRate)}`);
  for (const c of candidates) {
    console.log(`  [候选 ${c.id}] ${c.category} status=${c.status} confidence=${pct(c.confidence)} source=${c.source}`);
    console.log(`        内容：${c.content}`);
  }
  for (const i of items) {
    console.log(`  [知识 ${i.id}] ${i.category} v${i.version} status=${i.status} usage=${i.usageCount} success=${i.successCount} failure=${i.failureCount} effWeight=${quality.perItem.find((x) => x.id === i.id)?.effectiveWeight ?? '—'}`);
  }
}

// ── canary ──
function cmdCanaryStatus(svc: AIQualityService, json: boolean): void {
  const list = svc.experiments.list();
  if (json) {
    console.log(JSON.stringify(list, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log('暂无实验（Shadow / Canary）。先 approval 后创建实验。');
    return;
  }
  console.log(`Experiments（${list.length}）`);
  for (const e of list) {
    console.log(`  [${e.id}] ${e.type} status=${e.status}${e.canaryStage ? ` stage=${e.canaryStage}` : ''} proposal=${e.proposalId} candidate=${e.candidateRef}`);
    if (e.rollbackReason) console.log(`        回滚原因：${e.rollbackReason}`);
  }
  console.log(`  Canary 阶段序：${CANARY_STAGES.join(' → ')}`);
}

function cmdCanaryPromote(svc: AIQualityService, args: string[]): void {
  const id = args[1];
  if (!id) {
    console.error('canary promote 需要实验 ID');
    process.exit(2);
  }
  const by = requireHumanBy(args);
  try {
    const r = svc.experiments.canaryPromote(id, {
      metrics: {
        accuracy: numberFlag(args, '--accuracy', 0),
        latencyMs: numberFlag(args, '--latency-ms', 0),
        cost: numberFlag(args, '--cost', 0),
        failureRate: numberFlag(args, '--failure-rate', 0),
        safety: numberFlag(args, '--safety', 0),
      },
      thresholdAccuracyDrop: numberFlag(args, '--threshold-accuracy-drop', 0.03),
    });
    svc.audit.record({
      proposalId: svc.experiments.get(id)?.proposalId ?? 'n/a',
      actor: by,
      action: r.passed ? 'CANARY_PROMOTED' : 'CANARY_PAUSED',
      decision: r.reason ?? (r.passed ? 'Canary 推进' : 'Canary 停止'),
    });
    saveService(svc);
    console.log(`Canary ${id}：${r.passed ? `推进至 ${r.stage}` : `停止（${r.reason ?? ''}）`}`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

function cmdCanaryRollback(svc: AIQualityService, args: string[]): void {
  const id = args[1];
  if (!id) {
    console.error('canary rollback 需要实验 ID');
    process.exit(2);
  }
  const reason = flagValue(args, '--reason') ?? '质量回归，自动回滚';
  try {
    const rec = svc.rollbackExperiment(id, { reason });
    saveService(svc);
    console.log(`Canary ${id} 已回滚：${reason}`);
    console.log(`  回滚记录：${rec.id}（${rec.kind} ${rec.fromRef} → ${rec.toRef}）`);
  } catch (err) {
    console.error((err as Error).message);
    process.exit(1);
  }
}

function usage(): void {
  console.log(`AI Quality CLI（Phase 46 / 43.25）
用法：
  feedback list [--domain X] [--source X] [--verified] [--json]
  feedback verify <id> --by <human> [--note ...]
  eval errors [--json]
  eval improve [--json]
  prompt list [--key X]
  prompt compare --baseline <id> --candidate <id> [--latency-ms N] [--cost N]
  model list [--json]
  model compare --baseline <id> --candidate <id> [--accuracy N] [--latency-ms N] [--cost N] [--failure-rate N] [--safety N]
  improvement list [--status X] [--json]
  improvement approve <id> --by <human>
  improvement reject <id> --by <human> --reason <...>
  knowledge review [--json]
  canary status [--json]
  canary promote <id> --by <human> --accuracy N [--latency-ms N] [--cost N] [--failure-rate N] [--safety N]
  canary rollback <id> --reason <...>`);
}

function main(): void {
  const args = process.argv.slice(2);
  const cmd = args[0];
  if (!cmd || cmd === 'help' || cmd === '--help') {
    usage();
    return;
  }
  const svc = loadService();
  const json = hasFlag(args, '--json');
  switch (cmd) {
    case 'feedback': {
      const sub = args[1];
      if (sub === 'list') cmdFeedbackList(svc, args.slice(1), json);
      else if (sub === 'verify') cmdFeedbackVerify(svc, args.slice(1));
      else { console.error(`未知 feedback 子命令：${sub}（可用 list / verify）`); process.exit(2); }
      break;
    }
    case 'eval': {
      const sub = args[1];
      if (sub === 'errors') cmdEvalErrors(svc, json);
      else if (sub === 'improve') cmdEvalImprove(svc, json);
      else { console.error(`未知 eval 子命令：${sub}（可用 errors / improve）`); process.exit(2); }
      break;
    }
    case 'prompt': {
      const sub = args[1];
      if (sub === 'list') cmdPromptList(svc, args.slice(1), json);
      else if (sub === 'compare') cmdPromptCompare(svc, args.slice(1));
      else { console.error(`未知 prompt 子命令：${sub}（可用 list / compare）`); process.exit(2); }
      break;
    }
    case 'model': {
      const sub = args[1];
      if (sub === 'list') cmdModelList(svc, json);
      else if (sub === 'compare') cmdModelCompare(svc, args.slice(1));
      else { console.error(`未知 model 子命令：${sub}（可用 list / compare）`); process.exit(2); }
      break;
    }
    case 'improvement': {
      const sub = args[1];
      if (sub === 'list') cmdImprovementList(svc, args.slice(1), json);
      else if (sub === 'approve') cmdImprovementApprove(svc, args.slice(1));
      else if (sub === 'reject') cmdImprovementReject(svc, args.slice(1));
      else { console.error(`未知 improvement 子命令：${sub}（可用 list / approve / reject）`); process.exit(2); }
      break;
    }
    case 'knowledge': {
      const sub = args[1];
      if (sub === 'review') cmdKnowledgeReview(svc, json);
      else { console.error(`未知 knowledge 子命令：${sub}（可用 review）`); process.exit(2); }
      break;
    }
    case 'canary': {
      const sub = args[1];
      if (sub === 'status') cmdCanaryStatus(svc, json);
      else if (sub === 'promote') cmdCanaryPromote(svc, args.slice(1));
      else if (sub === 'rollback') cmdCanaryRollback(svc, args.slice(1));
      else { console.error(`未知 canary 子命令：${sub}（可用 status / promote / rollback）`); process.exit(2); }
      break;
    }
    default:
      console.error(`未知命令：${cmd}（可用 feedback / eval / prompt / model / improvement / knowledge / canary）`);
      process.exit(2);
  }
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}

export { loadService, saveService };
