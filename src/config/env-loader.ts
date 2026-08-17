// 环境变量加载器：从 TESTFLOW_* 前缀环境变量加载配置，覆盖 environments.json
// 优先级：环境变量 > environments.json > 默认值
// 支持 JSON 格式的环境变量（TESTFLOW_EXTRA='{"poll_interval_ms":5000}'）
import type { AppConfig, EnvironmentConfig } from '../core/types.js';
import { logger } from '../utils/logger.js';

const PREFIX = 'TESTFLOW_';

/** 读取单个 TESTFLOW_* 环境变量 */
export function getEnvVar(key: string): string | undefined {
  return process.env[PREFIX + key.toUpperCase()];
}

/** 从环境变量获取目标环境名 */
export function getEnvFromEnv(): string | undefined {
  return getEnvVar('ENV');
}

/**
 * 从环境变量加载配置覆盖项，合并到 AppConfig 之上
 * 支持的 TESTFLOW_* 变量：
 *   TESTFLOW_ENV              - 默认环境
 *   TESTFLOW_COOKIE           - cookie_string（会话覆盖）
 *   TESTFLOW_PROJECT_ID       - project_id
 *   TESTFLOW_ACCOUNT          - account
 *   TESTFLOW_BASE_URL         - base_url
 *   TESTFLOW_SUBMIT_URL       - submit_url
 *   TESTFLOW_STATUS_URL       - status_url
 *   TESTFLOW_DETAIL_URL       - detail_url
 *   TESTFLOW_BILLING_URL      - billing_url
 *   TESTFLOW_CSRF_PAGE        - csrf_page
 *   TESTFLOW_EXTRA            - JSON 扩展配置（覆盖任意字段）
 *   TESTFLOW_SESSION_COOKIES_PATH - session-cookies.json 路径
 *   TESTFLOW_POLL_INTERVAL_MS - 轮询间隔（毫秒）
 */
export function loadConfigFromEnv(cfg: AppConfig): AppConfig {
  const overridden: AppConfig = { ...cfg, environments: { ...cfg.environments } };

  // 全局配置覆盖
  const sessionPath = getEnvVar('SESSION_COOKIES_PATH');
  if (sessionPath) overridden.session_cookies_path = sessionPath;

  const pollInterval = getEnvVar('POLL_INTERVAL_MS');
  if (pollInterval) overridden.poll_interval_ms = Number(pollInterval) || cfg.poll_interval_ms;

  // 遍历所有环境，应用覆盖
  for (const [envName, envCfg] of Object.entries(overridden.environments)) {
    const merged: EnvironmentConfig = { ...envCfg };

    // 标准字段覆盖（非环境特定，对所有环境生效）
    const projectId = getEnvVar('PROJECT_ID');
    const baseUrl = getEnvVar('BASE_URL');
    const account = getEnvVar('ACCOUNT');
    const submitUrl = getEnvVar('SUBMIT_URL');
    const statusUrl = getEnvVar('STATUS_URL');
    const detailUrl = getEnvVar('DETAIL_URL');
    const billingUrl = getEnvVar('BILLING_URL');
    const csrfPage = getEnvVar('CSRF_PAGE');

    if (projectId) merged.project_id = Number(projectId);
    if (baseUrl) merged.base_url = baseUrl;
    if (account) merged.account = account;
    if (submitUrl) merged.submit_url = submitUrl;
    if (statusUrl) merged.status_url = statusUrl;
    if (detailUrl) merged.detail_url = detailUrl;
    if (billingUrl) merged.billing_url = billingUrl;
    if (csrfPage) merged.csrf_page = csrfPage;

    // 环境特定覆盖：TESTFLOW_{ENVNAME}_BASE_URL 等
    const envPrefix = `${envName.toUpperCase()}_`;
    const envBaseUrl = process.env[PREFIX + envPrefix + 'BASE_URL'];
    const envProjectId = process.env[PREFIX + envPrefix + 'PROJECT_ID'];
    const envAccount = process.env[PREFIX + envPrefix + 'ACCOUNT'];
    if (envBaseUrl) merged.base_url = envBaseUrl;
    if (envProjectId) merged.project_id = Number(envProjectId);
    if (envAccount) merged.account = envAccount;

    overridden.environments[envName] = merged;
  }

  // JSON 扩展配置（覆盖任意字段）
  const extraJson = getEnvVar('EXTRA');
  if (extraJson) {
    try {
      const extra = JSON.parse(extraJson);
      // 深度合并顶层字段
      for (const [k, v] of Object.entries(extra)) {
        if (k === 'environments' && typeof v === 'object') {
          // 环境配置深度合并
          for (const [envName, envCfg] of Object.entries(v as Record<string, any>)) {
            if (overridden.environments[envName]) {
              overridden.environments[envName] = { ...overridden.environments[envName], ...envCfg };
            } else {
              overridden.environments[envName] = envCfg as EnvironmentConfig;
            }
          }
        } else {
          (overridden as any)[k] = v;
        }
      }
      logger.debug('环境变量 TESTFLOW_EXTRA 已合并到配置');
    } catch (e: any) {
      logger.warn(`TESTFLOW_EXTRA 解析失败（已忽略）：${e.message}`);
    }
  }

  // 检测是否有覆盖生效，输出调试日志
  const hasOverrides = !!(
    sessionPath || pollInterval || getEnvVar('PROJECT_ID') ||
    getEnvVar('BASE_URL') || getEnvVar('ACCOUNT') || extraJson
  );
  if (hasOverrides) {
    logger.debug('环境变量配置覆盖已生效');
  }

  return overridden;
}

/** 环境变量覆盖会话（cookie / project_id / account） */
export function applyEnvSessionOverrides(session: any): any {
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

/** 通知器配置（飞书 webhook 等） */
export function getNotifierConfig(): { enabled: boolean; webhook?: string; mentionMobiles?: string[] } {
  const webhook = getEnvVar('FEISHU_WEBHOOK');
  const mention = getEnvVar('FEISHU_MENTION');
  return {
    enabled: !!webhook,
    webhook,
    mentionMobiles: mention ? mention.split(',').map((s) => s.trim()).filter(Boolean) : [],
  };
}

/** OSS 上传配置（从环境变量读取） */
export function getOssConfig(): { endpoint: string; bucket: string; accessKeyId: string; accessKeySecret: string; baseUrl?: string } | null {
  const endpoint = getEnvVar('OSS_ENDPOINT');
  const bucket = getEnvVar('OSS_BUCKET');
  const accessKeyId = getEnvVar('OSS_ACCESS_KEY_ID');
  const accessKeySecret = getEnvVar('OSS_ACCESS_KEY_SECRET');
  const baseUrl = getEnvVar('REPORT_BASE_URL');

  if (!endpoint || !bucket || !accessKeyId || !accessKeySecret) {
    return null;
  }
  return { endpoint, bucket, accessKeyId, accessKeySecret, baseUrl };
}
