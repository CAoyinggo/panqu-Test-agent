// Defect Benchmark（Phase 45 / 42.8）：缺陷质量评测基准 v1
// 输入：失败场景 + 已有缺陷签名（重复检测）；
// groundTruth 为独立人工核验的 category / severity / priority / 是否重复。
// 评测器运行 分类→RCA→缺陷草稿 全链路（buildDefectFromRca）比对，
// 并检查 可复现性 / 完整性 / 关联用例 / 重复创建（AI 反复创建同一 Bug 的防护）。
import type { EvaluationCase } from '../../contract.js';

export interface DefectInput {
  caseId: string;
  name: string;
  error: string;
  timedOut?: boolean;
  checks?: Array<{ name: string; pass: boolean; detail: string }>;
  /** 已有缺陷签名（category:rootCauseKey），用于重复检测 */
  existingDefects?: string[];
}

export interface DefectGroundTruth {
  expectedCategory: string;
  expectedSeverity: string;
  expectedPriority: string;
  /** 该失败是否应被识别为「既有已知问题的重复」 */
  expectedDuplicate: boolean;
}

export type DefectCase = EvaluationCase<DefectInput, DefectGroundTruth>;

/** 缺陷严重度契约（与 defect-agent CATEGORY_SEVERITY 一致，CURATED） */
const SEVERITY: Record<string, { severity: string; priority: string }> = {
  AUTH_ERROR: { severity: 'P1', priority: 'HIGH' },
  BILLING_ERROR: { severity: 'P1', priority: 'HIGH' },
  MODEL_ERROR: { severity: 'P1', priority: 'HIGH' },
  CONCURRENCY_ERROR: { severity: 'P2', priority: 'MEDIUM' },
  TIMEOUT: { severity: 'P2', priority: 'MEDIUM' },
  ASSERTION: { severity: 'P2', priority: 'MEDIUM' },
  DATA_ERROR: { severity: 'P2', priority: 'MEDIUM' },
  ENVIRONMENT_ERROR: { severity: 'P3', priority: 'LOW' },
  NETWORK_ERROR: { severity: 'P3', priority: 'LOW' },
  TEST_CODE_ERROR: { severity: 'P3', priority: 'LOW' },
};

const DEFAULT_SEV = { severity: 'P2', priority: 'MEDIUM' };

function D(
  id: string,
  input: DefectInput,
  expectedCategory: string,
  expectedDuplicate = false,
  difficulty = 'normal',
): DefectCase {
  const sev = SEVERITY[expectedCategory] ?? DEFAULT_SEV;
  return {
    id: `defect-${id}`,
    domain: 'DEFECT',
    input,
    groundTruth: {
      expectedCategory,
      expectedSeverity: sev.severity,
      expectedPriority: sev.priority,
      expectedDuplicate,
    },
    metadata: { feature: 'wan3', difficulty, source: 'CURATED' },
  };
}

const checks = (name: string, detail: string): Array<{ name: string; pass: boolean; detail: string }> => [
  { name, pass: false, detail },
];

export const DEFECT_CASES: DefectCase[] = [
  D('001', { caseId: 'wan3-701', name: '模型服务 503', error: 'HTTP 503 Service Unavailable', checks: checks('视频生成', '503') }, 'MODEL_ERROR'),
  D('002', { caseId: 'wan3-702', name: '积分扣费异常', error: 'billing charge failed: insufficient balance', checks: checks('扣费', 'insufficient balance') }, 'BILLING_ERROR'),
  D('003', { caseId: 'wan3-703', name: '鉴权失败', error: 'HTTP 401 Unauthorized', checks: checks('鉴权', '401') }, 'AUTH_ERROR'),
  D('004', { caseId: 'wan3-704', name: '并发锁冲突', error: 'concurrency conflict on task lock', checks: checks('并发', 'lock conflict') }, 'CONCURRENCY_ERROR'),
  D('005', { caseId: 'wan3-705', name: '视频 URL 断言失败', error: '断言 data.result.video.url 为空', checks: checks('视频 URL', 'expected url, got undefined') }, 'ASSERTION'),
  D('006', { caseId: 'wan3-706', name: '任务超时', error: 'task timed out after 60s', timedOut: true, checks: checks('完成', 'timeout') }, 'TIMEOUT'),
  D('007', { caseId: 'wan3-707', name: '测试数据缺失', error: '测试数据不存在：prompt fixture missing', checks: checks('fixture', 'missing') }, 'DATA_ERROR'),
  D('008', { caseId: 'wan3-708', name: '依赖服务未启动', error: 'environment not ready: billing service unavailable', checks: checks('依赖', 'not ready') }, 'ENVIRONMENT_ERROR'),
  D('009', { caseId: 'wan3-709', name: '网络拒绝', error: 'ECONNREFUSED connection refused', checks: checks('网络', 'refused') }, 'NETWORK_ERROR'),
  D('010', { caseId: 'wan3-710', name: '请求 404 路径错误', error: 'HTTP 404 Not Found on /api/v1/task', checks: checks('路径', '404') }, 'TEST_CODE_ERROR'),
  D('011', { caseId: 'wan3-711', name: '模型网关 502', error: 'HTTP 502 Bad Gateway from model gateway', checks: checks('网关', '502') }, 'MODEL_ERROR'),
  D('012', { caseId: 'wan3-712', name: '模型推理超时', error: 'model inference timed out: 503', checks: checks('推理', '503') }, 'MODEL_ERROR'),
  D('013', { caseId: 'wan3-713', name: '依赖服务 500', error: 'HTTP 500 from dependency payment service', checks: checks('支付', '500') }, 'DEPENDENCY_ERROR'),
  D('014', { caseId: 'wan3-714', name: '限流 429', error: 'HTTP 429 rate limited', checks: checks('限流', '429') }, 'RATE_LIMIT_ERROR'),
  D('015', { caseId: 'wan3-715', name: '未知崩溃', error: 'Segmentation fault in worker' }, 'UNKNOWN'),
  D('016', { caseId: 'wan3-716', name: '模型服务 503（重复）', error: 'HTTP 503 Service Unavailable', checks: checks('视频生成', '503'), existingDefects: ['MODEL_ERROR:service unavailable'] }, 'MODEL_ERROR', true),
  D('017', { caseId: 'wan3-717', name: '积分扣费异常（重复）', error: 'billing charge failed: insufficient balance', checks: checks('扣费', 'insufficient balance'), existingDefects: ['BILLING_ERROR:insufficient balance'] }, 'BILLING_ERROR', true),
  D('018', { caseId: 'wan3-718', name: '鉴权失败（重复）', error: 'HTTP 401 Unauthorized', checks: checks('鉴权', '401'), existingDefects: ['AUTH_ERROR:401'] }, 'AUTH_ERROR', true),
  D('019', { caseId: 'wan3-719', name: '模型网关 502（重复）', error: 'HTTP 502 Bad Gateway from model gateway', checks: checks('网关', '502'), existingDefects: ['MODEL_ERROR:bad gateway'] }, 'MODEL_ERROR', true),
  D('020', { caseId: 'wan3-720', name: '新的数据缺失', error: '测试数据不存在：prompt fixture missing', checks: checks('fixture', 'missing') }, 'DATA_ERROR'),
  D('021', { caseId: 'wan3-721', name: '新的并发冲突', error: 'concurrency conflict on task lock', checks: checks('并发', 'lock conflict') }, 'CONCURRENCY_ERROR'),
  D('022', { caseId: 'wan3-722', name: '新的网络拒绝', error: 'ECONNREFUSED connection refused', checks: checks('网络', 'refused') }, 'NETWORK_ERROR'),
  D('023', { caseId: 'wan3-723', name: '新的 404', error: 'HTTP 404 Not Found on /api/v1/task', checks: checks('路径', '404') }, 'TEST_CODE_ERROR'),
  D('024', { caseId: 'wan3-724', name: '模型服务 502', error: 'HTTP 502 Bad Gateway from model gateway', checks: checks('网关', '502') }, 'MODEL_ERROR'),
  D('025', { caseId: 'wan3-725', name: '数据字段断言失败', error: '断言 data.charge.amount 应为数字', checks: checks('金额', 'expected number, got string') }, 'ASSERTION'),
  D('026', { caseId: 'wan3-726', name: '依赖不可用', error: 'dependency payment service unavailable', checks: checks('支付', 'unavailable') }, 'DEPENDENCY_ERROR'),
  D('027', { caseId: 'wan3-727', name: '环境配置缺失', error: 'environment config missing: env=test', checks: checks('配置', 'missing') }, 'ENVIRONMENT_ERROR'),
  D('028', { caseId: 'wan3-728', name: '积分扣费异常（新签名）', error: 'billing charge failed: duplicate charge', checks: checks('扣费', 'duplicate charge') }, 'BILLING_ERROR'),
  D('029', { caseId: 'wan3-729', name: '鉴权 403', error: 'HTTP 403 Forbidden', checks: checks('权限', '403') }, 'AUTH_ERROR'),
  D('030', { caseId: 'wan3-730', name: '模型服务 503（再重复）', error: 'HTTP 503 model service unavailable', checks: checks('视频生成', '503'), existingDefects: ['MODEL_ERROR:service unavailable'] }, 'MODEL_ERROR', true),
];
