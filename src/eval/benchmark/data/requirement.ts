// Requirement Benchmark（Phase 45 / 42.3）：需求理解评测基准 v1
// 复用 Phase 18 已核验的 30 条 CURATED 需求（normal/boundary/abnormal），
// 另新增 6 条覆盖 模糊 / 缺字段 / 矛盾 / 复杂 类别 → 合计 36 条（≥30）。
// groundTruth 为独立人工核验（source=CURATED，verifiedBy=AI-Eval 基准构建），
// 评测器以确定性解析器实际输出与之比对（非循环论证）。
import type { EvaluationCase } from '../../contract.js';
import { REQUIREMENT_BENCHMARK } from '../../../../tests/evals/benchmark/requirements.js';

export interface RequirementGroundTruth {
  feature: string;
  capabilities: string[];
  inputs: string[];
  businessRules: string[];
  risks: string[];
}

export type RequirementCase = EvaluationCase<{ text: string }, RequirementGroundTruth>;

/** 将 Phase 18 基准映射为统一 EvaluationCase（source=CURATED） */
const LEGACY: RequirementCase[] = REQUIREMENT_BENCHMARK.map((b) => ({
  id: `req-${b.id}`,
  domain: 'REQUIREMENT',
  input: { text: b.text },
  groundTruth: {
    feature: b.expected.feature,
    capabilities: b.expected.capabilities,
    inputs: b.expected.inputs,
    businessRules: b.expected.businessRules,
    risks: b.expected.risks,
  },
  metadata: { feature: 'wan3', difficulty: b.kind, source: 'CURATED' },
}));

/** 新增：模糊 / 缺字段 / 矛盾 / 复杂（独立人工核验 ground truth） */
const EXTRA: RequirementCase[] = [
  {
    id: 'req-ambiguous-01',
    domain: 'REQUIREMENT',
    input: { text: '测试视频功能。' },
    groundTruth: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: [], risks: [] },
    metadata: { feature: 'wan3', difficulty: 'ambiguous', source: 'CURATED' },
  },
  {
    id: 'req-ambiguous-02',
    domain: 'REQUIREMENT',
    input: { text: '验证一下相关功能的稳定性，具体细节待定。' },
    groundTruth: { feature: 'wan3', capabilities: ['video'], inputs: [], businessRules: ['任务状态最终成功'], risks: [] },
    metadata: { feature: 'wan3', difficulty: 'ambiguous', source: 'CURATED' },
  },
  {
    id: 'req-missing-01',
    domain: 'REQUIREMENT',
    input: { text: '测试文生视频生成。' },
    groundTruth: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: [], businessRules: ['任务提交成功', '任务状态最终成功'], risks: [] },
    metadata: { feature: 'wan3', difficulty: 'missing-field', source: 'CURATED' },
  },
  {
    id: 'req-contra-01',
    domain: 'REQUIREMENT',
    input: { text: '测试文生视频积分扣除，但禁止真实扣费。' },
    groundTruth: { feature: 'wan3', capabilities: ['text-to-video', 'video'], inputs: [], businessRules: ['积分正确扣除', '禁止真实扣费'], risks: ['billing'] },
    metadata: { feature: 'wan3', difficulty: 'contradictory', source: 'CURATED' },
  },
  {
    id: 'req-contra-02',
    domain: 'REQUIREMENT',
    input: { text: '支持 0 秒与 120 秒超长视频，确保时长校验正确。' },
    groundTruth: { feature: 'wan3', capabilities: ['video'], inputs: ['duration'], businessRules: ['时长校验', '超长输入处理'], risks: ['timeout'] },
    metadata: { feature: 'wan3', difficulty: 'contradictory', source: 'CURATED' },
  },
  {
    id: 'req-complex-01',
    domain: 'REQUIREMENT',
    input: { text: '验证文生视频与图生视频混合链路：输入参考图与 2000 字提示词，覆盖 8K 分辨率 60 秒时长，要求积分扣除正确、任务最终成功、失败可重试、并发 100 稳定、超长输入处理正常。' },
    groundTruth: {
      feature: 'wan3',
      capabilities: ['text-to-video', 'image-to-video', 'video'],
      inputs: ['prompt', 'reference', 'resolution', 'duration'],
      businessRules: ['积分正确扣除', '任务提交成功', '任务状态最终成功', '重试机制正常', '并发执行正常', '超长输入处理'],
      risks: ['billing', 'concurrency', 'exception', 'timeout'],
    },
    metadata: { feature: 'wan3', difficulty: 'complex', source: 'CURATED' },
  },
];

export const REQUIREMENT_CASES: RequirementCase[] = [...LEGACY, ...EXTRA];
