// 环境变量注入：TESTFLOW_* 前缀变量覆盖配置文件
// 优先级：CLI 参数 > 环境变量 > environments.json
import type { AppConfig, Session } from '../core/types.js';

const PREFIX = 'TESTFLOW_';

/** 读取单个 TESTFLOW_* 环境变量 */
export function getEnvVar(key: string): string | undefined {
  return process.env[PREFIX + key.toUpperCase()];
}

/** 从环境变量获取目标环境名 */
export function getEnvFromEnv(): string | undefined {
  return getEnvVar('ENV');
}

/** 环境变量覆盖环境配置（project_id / base_url / account 等） */
export function applyEnvToConfig(cfg: AppConfig, envName: string): AppConfig {
  const env = cfg.environments[envName];
  if (!env) return cfg;

  const overridden = { ...env };
  const projectId = getEnvVar('PROJECT_ID');
  const baseUrl = getEnvVar('BASE_URL');
  const account = getEnvVar('ACCOUNT');

  if (projectId) overridden.project_id = Number(projectId);
  if (baseUrl) overridden.base_url = baseUrl;
  if (account) overridden.account = account;

  cfg.environments[envName] = overridden;
  return cfg;
}

/** 环境变量覆盖会话（cookie / project_id / account） */
export function applyEnvSessionOverrides(session: Session): Session {
  const cookie = getEnvVar('COOKIE');
  const projectId = getEnvVar('PROJECT_ID');
  const account = getEnvVar('ACCOUNT');

  return {
    ...session,
    ...(cookie ? { cookie_string: cookie } : {}),
    ...(projectId ? { project_id: Number(projectId) } : {}),
    ...(account ? { account } : {}),
  };
}

/** 通知器配置（飞书 webhook 等，Phase 4 使用） */
export function getNotifierConfig(): { enabled: boolean; webhook?: string; mentionMobiles?: string[] } {
  const webhook = getEnvVar('FEISHU_WEBHOOK');
  const mention = getEnvVar('FEISHU_MENTION');
  return {
    enabled: !!webhook,
    webhook,
    mentionMobiles: mention ? mention.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}
