// Agent Evaluation Benchmark：RCA 根因分类基准（Phase 18）
// 30 条失败场景：10 历史真实缺陷 + 10 环境异常 + 10 模型异常。
// expected.category 为确定性分类器（failure-classifier）应产出的 ground truth。
export interface BenchmarkFailure {
  id: string;
  kind: 'historical' | 'environment' | 'model';
  caseId: string;
  name: string;
  error: string;
  timedOut?: boolean;
  checks?: Array<{ name: string; pass: boolean; detail: string }>;
  expectedCategory: string;
}

export const FAILURE_BENCHMARK: BenchmarkFailure[] = [
  // ── 10 历史真实缺陷 ──
  { id: 'hist-001', kind: 'historical', caseId: 'wan3-101', name: '文生视频 1080P 生成失败', error: 'HTTP 503 Service Unavailable', expectedCategory: 'MODEL_ERROR' },
  { id: 'hist-002', kind: 'historical', caseId: 'wan3-102', name: '积分扣费异常', error: 'billing charge failed: insufficient balance', expectedCategory: 'BILLING_ERROR' },
  { id: 'hist-003', kind: 'historical', caseId: 'wan3-103', name: '鉴权失败', error: 'HTTP 401 Unauthorized', expectedCategory: 'AUTH_ERROR' },
  { id: 'hist-004', kind: 'historical', caseId: 'wan3-104', name: '并发生成冲突', error: 'concurrency conflict on task lock', expectedCategory: 'CONCURRENCY_ERROR' },
  { id: 'hist-005', kind: 'historical', caseId: 'wan3-105', name: '网络抖动', error: 'ECONNREFUSED connection refused', expectedCategory: 'NETWORK_ERROR' },
  { id: 'hist-006', kind: 'historical', caseId: 'wan3-106', name: '视频 URL 断言失败', error: '断言 data.result.video.url 为空', checks: [{ name: '视频 URL 存在', pass: false, detail: 'expected data.result.video.url, got undefined' }], expectedCategory: 'ASSERTION' },
  { id: 'hist-007', kind: 'historical', caseId: 'wan3-107', name: '生成任务超时', error: 'task timed out after 60s', timedOut: true, expectedCategory: 'TIMEOUT' },
  { id: 'hist-008', kind: 'historical', caseId: 'wan3-108', name: '测试数据缺失', error: '测试数据不存在：prompt fixture missing', expectedCategory: 'DATA_ERROR' },
  { id: 'hist-009', kind: 'historical', caseId: 'wan3-109', name: '模型网关 502', error: 'HTTP 502 Bad Gateway from model gateway', expectedCategory: 'MODEL_ERROR' },
  { id: 'hist-010', kind: 'historical', caseId: 'wan3-110', name: '请求 404 路径错误', error: 'HTTP 404 Not Found on /api/v1/task', expectedCategory: 'TEST_CODE_ERROR' },

  // ── 10 环境异常 ──
  { id: 'env-001', kind: 'environment', caseId: 'wan3-201', name: '依赖服务未启动', error: 'environment not ready: billing service unavailable', expectedCategory: 'ENVIRONMENT_ERROR' },
  { id: 'env-002', kind: 'environment', caseId: 'wan3-202', name: '数据库不可用', error: 'database unavailable in environment', expectedCategory: 'ENVIRONMENT_ERROR' },
  { id: 'env-003', kind: 'environment', caseId: 'wan3-203', name: '测试环境配置错误', error: 'environment config missing: env=test', expectedCategory: 'ENVIRONMENT_ERROR' },
  { id: 'env-004', kind: 'environment', caseId: 'wan3-204', name: '缓存服务未就绪', error: 'environment not ready: cache service', expectedCategory: 'ENVIRONMENT_ERROR' },
  { id: 'env-005', kind: 'environment', caseId: 'wan3-205', name: '消息队列不可用', error: 'environment error: mq unavailable', expectedCategory: 'ENVIRONMENT_ERROR' },
  { id: 'env-006', kind: 'environment', caseId: 'wan3-206', name: '文件存储未挂载', error: 'env not ready: object storage', expectedCategory: 'ENVIRONMENT_ERROR' },
  { id: 'env-007', kind: 'environment', caseId: 'wan3-207', name: '网关环境异常', error: 'environment issue: api gateway 502', expectedCategory: 'ENVIRONMENT_ERROR' },
  { id: 'env-008', kind: 'environment', caseId: 'wan3-208', name: '依赖服务连接超时', error: 'environment timeout: downstream service', expectedCategory: 'ENVIRONMENT_ERROR' },
  { id: 'env-009', kind: 'environment', caseId: 'wan3-209', name: '测试数据环境隔离失败', error: 'environment error: fixture isolation failed', expectedCategory: 'ENVIRONMENT_ERROR' },
  { id: 'env-010', kind: 'environment', caseId: 'wan3-210', name: 'DNS 解析失败', error: 'environment dns resolution failed', expectedCategory: 'ENVIRONMENT_ERROR' },

  // ── 10 模型异常 ──
  { id: 'model-001', kind: 'model', caseId: 'wan3-301', name: '模型服务 503', error: 'HTTP 503 model service unavailable', expectedCategory: 'MODEL_ERROR' },
  { id: 'model-002', kind: 'model', caseId: 'wan3-302', name: '模型网关 504', error: 'HTTP 504 Gateway Timeout from model', expectedCategory: 'MODEL_ERROR' },
  { id: 'model-003', kind: 'model', caseId: 'wan3-303', name: '模型推理超时', error: 'model inference timed out: 503', expectedCategory: 'MODEL_ERROR' },
  { id: 'model-004', kind: 'model', caseId: 'wan3-304', name: '模型 500', error: 'HTTP 500 Internal Server Error model', expectedCategory: 'MODEL_ERROR' },
  { id: 'model-005', kind: 'model', caseId: 'wan3-305', name: '模型队列满', error: 'model service queue full, 503', expectedCategory: 'MODEL_ERROR' },
  { id: 'model-006', kind: 'model', caseId: 'wan3-306', name: '模型服务熔断', error: 'model service circuit breaker 502', expectedCategory: 'MODEL_ERROR' },
  { id: 'model-007', kind: 'model', caseId: 'wan3-307', name: '模型网关限流', error: 'model gateway rate limited 503', expectedCategory: 'MODEL_ERROR' },
  { id: 'model-008', kind: 'model', caseId: 'wan3-308', name: '模型服务不可达', error: 'model service unreachable 502', expectedCategory: 'MODEL_ERROR' },
  { id: 'model-009', kind: 'model', caseId: 'wan3-309', name: '模型参数错误 500', error: 'model 500 invalid parameters', expectedCategory: 'MODEL_ERROR' },
  { id: 'model-010', kind: 'model', caseId: 'wan3-310', name: '模型网关超时', error: 'model gateway timeout 504', expectedCategory: 'MODEL_ERROR' },
];
