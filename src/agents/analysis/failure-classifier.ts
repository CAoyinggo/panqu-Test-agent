// Failure Classifier：确定性失败分类器（Phase 13）
// 定位：RCA 证据链的第一环。不依赖 LLM，基于错误消息 / 超时标志 / 断言明细 / 标签
// 做规则分类，产出 category + 置信度 + 分类依据。规则命中即为「确定事实」。
import type { CaseExecutionResult } from '../execution/execution-schema.js';
import { FailureCategory } from './root-cause-schema.js';

/** 分类输入：单条失败用例（可用作 evidence 的确定性输入） */
export interface ClassifierInput {
  caseId: string;
  name?: string;
  error?: string;
  timedOut?: boolean;
  checks?: CaseExecutionResult['checks'];
  tags?: string[];
  durationMs?: number;
  /** 环境标识（如 test / preonline / prod） */
  environment?: string;
}

/** 分类结果 */
export interface ClassificationResult {
  category: FailureCategory;
  /** 置信度 0~1（规则命中高置信，兜底 UNKNOWN 低置信） */
  confidence: number;
  /** 分类依据（可读证据） */
  reasons: string[];
}

/** 规则：正则 → 分类 */
interface Rule {
  re: RegExp;
  category: FailureCategory;
  /** 命中说明 */
  note: string;
}

/** 错误消息规则（按优先级从高到低排序） */
const ERROR_RULES: Rule[] = [
  // 鉴权 / 权限
  { re: /401|403|unauthor|forbidden|权限|越权|鉴权/i, category: 'AUTH_ERROR', note: 'HTTP 401/403 或权限相关错误' },
  // 依赖服务故障（依赖/上游不可用）——须在通用 5xx/network 之前，且避免与 environment 冲突
  { re: /dependenc(?:y|ies)?|上游|依赖服务|依赖不可用|upstream|upstream service unavailable/i, category: 'DEPENDENCY_ERROR', note: '依赖/上游服务不可用' },
  // 环境上下文（显式 environment/环境 标记 → 优先于通用 5xx/billing/network）
  { re: /environment\s+(?:not ready|error|issue|timeout|dns|config|problem|failed|unavailable|dependenc)|^env\b[^:]*[:：\s].*(?:not ready|error|unavailable|timeout)|环境(?:异常|不可用|未就绪|未启动|报错)/i, category: 'ENVIRONMENT_ERROR', note: '明确的环境上下文（environment not ready/error 等）' },
  // 服务端错误（模型/网关 5xx）
  { re: /50[0-9]|5\d\d\b|503|502|504|gateway|server error|service unavailable|模型服务|model service/i, category: 'MODEL_ERROR', note: 'HTTP 5xx 或模型/网关服务错误' },
  // 限流（429）
  { re: /429|rate\s*limit|限流|too many requests|配额不足/i, category: 'RATE_LIMIT_ERROR', note: 'HTTP 429 限流或配额不足' },
  // 测试数据（须在 4xx 规则之前：data not found / 数据缺失 优先归因数据，避免被 not found 误判为路径错误）
  { re: /测试数据|fixture|mock data|数据缺失|不存在.*数据|data\s*(?:missing|not\s*found|is\s*empty|unavailable)/i, category: 'DATA_ERROR', note: '测试数据缺失/不符合预期' },
  // 客户端 4xx（400/404/422 多为测试代码/数据问题）
  { re: /400|404|422|bad request|not found|invalid request/i, category: 'TEST_CODE_ERROR', note: 'HTTP 4xx 请求或路径错误' },
  // 计费 / 积分
  { re: /billing|积分|扣费|余额|insufficient|charge/i, category: 'BILLING_ERROR', note: '计费/积分相关错误' },
  // 并发
  { re: /concurr|并发|锁|lock|conflict|409/i, category: 'CONCURRENCY_ERROR', note: '并发/锁冲突相关错误' },
  // 网络
  { re: /econnrefused|network|网络|socket|dns|timed out|timeout|超时/i, category: 'NETWORK_ERROR', note: '网络连接或超时相关错误' },
  // 环境
  { re: /environment|env|环境|未启动|not ready|unavailable.*(?:db|database)/i, category: 'ENVIRONMENT_ERROR', note: '环境未就绪或依赖服务不可用' },
];

/** HTTP 状态码 → 失败分类（精确映射，覆盖 400/401/403/404/408/429/5xx） */
const HTTP_STATUS_MAP: Record<number, { category: FailureCategory; note: string }> = {
  400: { category: 'TEST_CODE_ERROR', note: 'HTTP 400 请求参数错误' },
  401: { category: 'AUTH_ERROR', note: 'HTTP 401 未授权' },
  403: { category: 'AUTH_ERROR', note: 'HTTP 403 无权限' },
  404: { category: 'TEST_CODE_ERROR', note: 'HTTP 404 路径/资源不存在' },
  408: { category: 'TIMEOUT', note: 'HTTP 408 请求超时' },
  429: { category: 'RATE_LIMIT_ERROR', note: 'HTTP 429 限流' },
  500: { category: 'MODEL_ERROR', note: 'HTTP 500 服务端错误' },
  502: { category: 'MODEL_ERROR', note: 'HTTP 502 网关错误' },
  503: { category: 'MODEL_ERROR', note: 'HTTP 503 服务不可用' },
  504: { category: 'MODEL_ERROR', note: 'HTTP 504 网关超时' },
};

/** 由 HTTP 状态码精确分类（优先于关键词规则） */
function classifyByHttpStatus(error: string | undefined): ClassificationResult | null {
  if (!error) return null;
  const m = error.match(/HTTP\s+(\d{3})/i);
  if (!m) return null;
  const status = Number(m[1]);
  const hit = HTTP_STATUS_MAP[status];
  if (!hit) return null;
  return { category: hit.category, confidence: 0.95, reasons: [`错误消息含 HTTP ${status}：${hit.note}`] };
}

/** 由错误消息分类（HTTP 状态码优先，其次规则命中即事实） */
export function classifyByError(error: string | undefined): ClassificationResult | null {
  if (!error) return null;
  const byStatus = classifyByHttpStatus(error);
  if (byStatus) return byStatus;
  for (const rule of ERROR_RULES) {
    if (rule.re.test(error)) {
      return { category: rule.category, confidence: 0.9, reasons: [`错误消息匹配「${rule.note}」：${error.slice(0, 120)}`] };
    }
  }
  return null;
}

/** 由断言明细分类（存在失败断言且无更明确错误 → 断言失败） */
function classifyByChecks(checks: CaseExecutionResult['checks'] | undefined): ClassificationResult | null {
  if (!checks || checks.length === 0) return null;
  const failed = checks.filter((c) => !c.pass);
  if (failed.length === 0) return null;
  return {
    category: 'ASSERTION',
    confidence: 0.85,
    reasons: failed.slice(0, 5).map((c) => `断言「${c.name}」失败：${c.detail.slice(0, 120)}`),
  };
}

/**
 * 确定性失败分类：优先级 超时 → 错误消息规则 → 断言明细 → 标签 → 未知。
 * 规则引擎产出确定性结果（任务书第 21 节「Deterministic First」）。
 */
export function classifyFailure(input: ClassifierInput): ClassificationResult {
  const reasons: string[] = [];

  // 1. 超时
  if (input.timedOut) {
    reasons.push('执行超时（timedOut=true）');
    return { category: 'TIMEOUT', confidence: 0.95, reasons };
  }

  // 2. 错误消息规则
  const byError = classifyByError(input.error);
  if (byError) {
    reasons.push(...byError.reasons);
    return byError;
  }

  // 3. 断言明细
  const byChecks = classifyByChecks(input.checks);
  if (byChecks) {
    reasons.push(...byChecks.reasons);
    return byChecks;
  }

  // 4. 标签提示（低置信）
  if (input.tags && input.tags.length) {
    const tagSet = input.tags.map((t) => t.toLowerCase());
    if (tagSet.some((t) => t.includes('billing') || t.includes('积分'))) {
      reasons.push(`用例标签提示计费风险（${input.tags.join(',')}）`);
      return { category: 'BILLING_ERROR', confidence: 0.5, reasons };
    }
    if (tagSet.some((t) => t.includes('concurr') || t.includes('并发'))) {
      reasons.push(`用例标签提示并发风险（${input.tags.join(',')}）`);
      return { category: 'CONCURRENCY_ERROR', confidence: 0.5, reasons };
    }
  }

  // 5. 未知
  reasons.push('错误消息与断言明细均无法归类');
  return { category: 'UNKNOWN', confidence: 0.3, reasons };
}
