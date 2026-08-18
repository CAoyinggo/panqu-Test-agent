// 三档评测环境门控（Phase 20.8）
// Offline：始终运行（离线确定性，MockLLM，无任何网络/密钥依赖）
// Real LLM：配置真实 LLM（LLM_PROVIDER / LLM_API_KEY）或 RUN_REAL_E2E=true 时运行
// Real API：RUN_REAL_E2E=true 时运行（复用 e2e/real 的真实会话/配置）
import { REAL_ENABLED, REAL_ENV } from '../../e2e/real/real-env.js';

/** Offline 档：始终启用 */
export const OFFLINE = true;

/** Real LLM 档：配置了真实 LLM 提供方或真实环境开关 */
export const REAL_LLM_ENABLED =
  REAL_ENABLED ||
  !!(process.env.LLM_PROVIDER || process.env.LLM_API_KEY || process.env.LLM_BASE_URL);

/** Real API 档：显式 RUN_REAL_E2E=true */
export const REAL_API_ENABLED = REAL_ENABLED;

/** 当前评测档位摘要（供 report 展示） */
export function evalTiers(): { offline: boolean; realLLM: boolean; realAPI: boolean; realEnv: string } {
  return {
    offline: OFFLINE,
    realLLM: REAL_LLM_ENABLED,
    realAPI: REAL_API_ENABLED,
    realEnv: REAL_ENV,
  };
}
