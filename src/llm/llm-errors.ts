// LLM 错误分类：识别失败类型并判断是否可回退（Fallback）。
// 回退原则（任务书 20.1）：Primary → Timeout/429/5xx/网络错误 → Fallback → Deterministic Fallback。
// 非可重试错误（如 400/401/403 配置或鉴权问题）直接暴露，避免掩盖真实配置错误。
import type { LLMProvider } from './types.js';

/** LLM 失败分类 */
export type LLMFailureKind = 'timeout' | 'http' | 'network' | 'unknown';

/** 结构化的 LLM 失败信息 */
export interface LLMFailure {
  kind: LLMFailureKind;
  /** HTTP 状态码（http 类型时） */
  status?: number;
  /** 原始错误消息 */
  message: string;
}

/** 从任意异常提取失败信息 */
export function classifyLLMError(e: unknown): LLMFailure {
  if (e instanceof Error) {
    const msg = e.message;
    // AbortController 中止 / 明确超时
    if (e.name === 'AbortError' || /超时|timeout|timed ?out|aborted|abort/i.test(msg)) {
      return { kind: 'timeout', message: msg };
    }
    // HTTP 状态码（OpenAICompatibleProvider 抛出 "LLM 请求失败（HTTP xxx）"）
    const m = msg.match(/HTTP\s+(\d{3})/);
    if (m) {
      return { kind: 'http', status: Number(m[1]), message: msg };
    }
    // 网络类（fetch 失败：ECONNREFUSED / ENOTFOUND / fetch failed / network）
    if (/fetch|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|连接|网络/i.test(msg)) {
      return { kind: 'network', message: msg };
    }
    return { kind: 'unknown', message: msg };
  }
  return { kind: 'unknown', message: String(e) };
}

/** 是否应触发 fallback：超时 / 408 / 429 / 5xx / 网络错误 */
export function isRetryable(failure: LLMFailure): boolean {
  if (failure.kind === 'timeout' || failure.kind === 'network') return true;
  if (failure.kind === 'http') {
    const s = failure.status ?? 0;
    return s === 408 || s === 429 || (s >= 500 && s <= 599);
  }
  return false;
}

/** 从 Provider 抛错判断是否可回退（便捷方法） */
export function shouldFallback(e: unknown): boolean {
  return isRetryable(classifyLLMError(e));
}

/** 回退事件（供观测/日志/审计） */
export interface LLMFallbackEvent {
  /** 触发回退的 Provider 名（主模型） */
  from: string;
  /** 目标 Provider 名（回退模型，或 deterministic-fallback） */
  to: string;
  failure: LLMFailure;
  /** 回退序号（1=主→备，2=备→确定性） */
  attempt: number;
}

export type LLMFallbackListener = (event: LLMFallbackEvent) => void;

/** 通用 Provider 名（观测用） */
export function providerName(p: LLMProvider): string {
  return p.name;
}
