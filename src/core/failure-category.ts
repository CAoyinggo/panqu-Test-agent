// 失败分类共享模型（Phase 35，DEBT-11 已解决）：跨域共享类型的唯一权威来源
// 原定义位于 agents 域 `agents/analysis/root-cause-schema.ts`，平台层（telemetry / real-run）
// 以 `import type` 引用造成「平台层 → agents 域」跨域类型反向依赖。
// 处置：上移至 core 层（最底层、可被任意域依赖），agents 域 re-export 保持兼容，
// core 成为 FailureCategory / FAILURE_CATEGORIES / isFailureCategory 的唯一权威来源。
//
// 依赖规则：core 不依赖任何域；agents / platform / autonomous 均可从 core 导入。

/** 失败分类（确定性分类器产出，作为 RCA 的类别候选） */
export type FailureCategory =
  | 'ASSERTION'          // 断言失败（期望 vs 实际不符）
  | 'TIMEOUT'            // 超时
  | 'MODEL_ERROR'        // 模型/服务错误（5xx、503、模型网关异常）
  | 'DATA_ERROR'         // 测试数据错误（数据缺失/不符合预期）
  | 'ENVIRONMENT_ERROR'  // 环境问题（环境未就绪/依赖服务未启动）
  | 'NETWORK_ERROR'      // 网络问题
  | 'AUTH_ERROR'         // 鉴权/权限问题（401/403/越权）
  | 'BILLING_ERROR'      // 计费/积分问题
  | 'CONCURRENCY_ERROR'  // 并发问题
  | 'RATE_LIMIT_ERROR'   // 限流（HTTP 429）
  | 'DEPENDENCY_ERROR'   // 依赖服务故障（上游/依赖不可用）
  | 'TEST_CODE_ERROR'    // 测试代码/断言路径错误
  | 'UNKNOWN';           // 未分类

/** 合法分类集合（与 FailureCategory 字面量一一对应） */
export const FAILURE_CATEGORIES: readonly FailureCategory[] = [
  'ASSERTION', 'TIMEOUT', 'MODEL_ERROR', 'DATA_ERROR', 'ENVIRONMENT_ERROR',
  'NETWORK_ERROR', 'AUTH_ERROR', 'BILLING_ERROR', 'CONCURRENCY_ERROR',
  'RATE_LIMIT_ERROR', 'DEPENDENCY_ERROR', 'TEST_CODE_ERROR', 'UNKNOWN',
];

/** 判断是否为合法分类（类型守卫） */
export function isFailureCategory(v: unknown): v is FailureCategory {
  return typeof v === 'string' && (FAILURE_CATEGORIES as readonly string[]).includes(v);
}
