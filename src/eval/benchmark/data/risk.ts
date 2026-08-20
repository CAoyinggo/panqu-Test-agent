// Risk Benchmark（Phase 45 / 42.5）：风险评估评测基准 v1
// 输入：需求文本 + 带标签用例 + 环境；groundTruth 为独立人工核验的
//   expectedCategories（必须识别的风险类别，Recall 基数）
//   criticalCategories（P0 等价：必须识别且必须高优——漏判即 Critical Miss）
// 评测器运行确定性风险分析（analyzeRisks）比对，允许诚实命中/漏判（非循环论证）。
import type { EvaluationCase } from '../../contract.js';
import type { TestCase } from '../../../agents/test-design/testcase-schema.js';

export interface RiskInput {
  text: string;
  testCases: TestCase[];
  environment?: string;
}

export interface RiskGroundTruth {
  expectedCategories: string[];
  criticalCategories: string[];
}

export type RiskCase = EvaluationCase<RiskInput, RiskGroundTruth>;

/** 紧凑构造带标签用例 */
function tc(id: string, priority: string, tags: string[], assertions: string[] = []): TestCase {
  return {
    id,
    feature: 'wan3',
    name: id,
    priority: priority as TestCase['priority'],
    tags,
    steps: [{ action: 'submit' }],
    assertions: assertions.map((target) => ({ name: `校验 ${target}`, target, operator: 'exists' })),
  };
}

const R = (id: string, text: string, testCases: TestCase[], environment: string | undefined, expectedCategories: string[], criticalCategories: string[] = [], difficulty = 'normal'): RiskCase => ({
  id: `risk-${id}`,
  domain: 'RISK',
  input: { text, testCases, environment },
  groundTruth: { expectedCategories, criticalCategories },
  metadata: { feature: 'wan3', environment, difficulty, source: 'CURATED' },
});

export const RISK_CASES: RiskCase[] = [
  R('001', '测试文生视频并发 100 稳定性', [tc('c1', 'P0', ['concurrency'])], 'test', ['concurrency', 'dependency'], ['concurrency']),
  R('002', '验证视频生成积分扣除正确', [tc('c1', 'P1', [], ['billing'])], 'test', ['billing', 'dependency'], ['billing']),
  R('003', '测试越权与数据隔离', [tc('c1', 'P0', ['security'])], 'test', ['security', 'dependency'], ['security']),
  R('004', '边界值 0 秒与 120 秒时长', [tc('c1', 'P2', ['boundary'])], 'test', ['boundary', 'dependency'], []),
  R('005', '生产环境全量回归', [tc('c1', 'P0', [])], 'prod', ['environment', 'dependency'], ['environment']),
  R('006', '超时处理链路验证', [tc('c1', 'P1', [], ['timeout'])], 'test', ['timeout', 'dependency'], []),
  R('007', '失败重试机制验证', [tc('c1', 'P1', [])], 'test', ['retry', 'dependency'], []),
  R('008', '依赖模型服务与积分服务', [tc('c1', 'P0', ['dependency'])], 'test', ['dependency', 'billing'], ['billing']),
  R('009', '异常输入脏数据防护', [tc('c1', 'P2', ['invalid-input'])], 'test', ['data', 'dependency'], []),
  R('010', '完整计费+并发+安全回归', [tc('c1', 'P0', ['concurrency', 'security'], ['billing'])], 'test', ['concurrency', 'security', 'billing', 'dependency'], ['concurrency', 'security', 'billing']),
  R('011', '余额不足拒绝场景', [tc('c1', 'P1', [], ['billing'])], 'test', ['billing', 'dependency'], ['billing']),
  R('012', '预发布环境验证', [tc('c1', 'P0', [])], 'preonline', ['environment', 'dependency'], []),
  R('013', '提示词注入安全验证', [tc('c1', 'P0', ['security'])], 'test', ['security', 'dependency'], ['security']),
  R('014', '模型服务故障重试', [tc('c1', 'P1', [], ['timeout'])], 'test', ['retry', 'dependency'], []),
  R('015', '8K 分辨率边界', [tc('c1', 'P2', ['boundary'])], 'test', ['boundary', 'dependency'], []),
  R('016', '空 prompt 处理', [tc('c1', 'P3', ['invalid-input'])], 'test', ['data', 'dependency'], []),
  R('017', '多业务高并发峰值', [tc('c1', 'P0', ['concurrency'])], 'test', ['concurrency', 'dependency'], ['concurrency']),
  R('018', '文件上传越权', [tc('c1', 'P1', ['security'])], 'test', ['security', 'dependency'], ['security']),
  R('019', '扣费幂等验证', [tc('c1', 'P1', [], ['billing'])], 'test', ['billing', 'dependency'], ['billing']),
  R('020', '环境依赖未就绪场景', [tc('c1', 'P0', [])], 'test', ['dependency'], []),
  R('021', '全链路含模型+积分+素材依赖', [tc('c1', 'P0', ['dependency'], ['billing'])], 'test', ['dependency', 'billing'], ['billing']),
  R('022', 'SQL 注入边界用例', [tc('c1', 'P2', ['invalid-input', 'boundary'])], 'test', ['data', 'boundary', 'dependency'], []),
  R('023', '超长输入 2000 字', [tc('c1', 'P2', ['boundary'])], 'test', ['boundary', 'dependency'], []),
  R('024', '鉴权分级校验', [tc('c1', 'P1', ['security'])], 'test', ['security', 'dependency'], ['security']),
  R('025', '计费并发叠加场景', [tc('c1', 'P0', ['concurrency'], ['billing'])], 'test', ['concurrency', 'billing', 'dependency'], ['concurrency', 'billing']),
  R('026', '并发超限 1000', [tc('c1', 'P0', ['concurrency'])], 'test', ['concurrency', 'dependency'], ['concurrency']),
  R('027', '对象存储不可用', [tc('c1', 'P1', ['dependency'])], 'test', ['dependency'], []),
  R('028', '内容安全审核用例', [tc('c1', 'P1', ['security'])], 'test', ['security', 'dependency'], ['security']),
  R('029', '阶梯单价校验', [tc('c1', 'P2', [], ['billing'])], 'test', ['billing', 'dependency'], ['billing']),
  R('030', '数据一致性校验', [tc('c1', 'P2', ['invalid-input'])], 'test', ['data', 'dependency'], []),
  R('031', '模型变更回归', [tc('c1', 'P0', ['dependency'])], 'test', ['dependency'], []),
  R('032', '综合：支付+安全+并发+边界全量', [tc('c1', 'P0', ['concurrency', 'security', 'boundary'], ['billing'])], 'test', ['concurrency', 'security', 'billing', 'boundary', 'dependency'], ['concurrency', 'security', 'billing']),
];
