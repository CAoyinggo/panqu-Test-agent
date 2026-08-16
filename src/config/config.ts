// 配置管理：加载 environments.json + 环境合并 + schema 校验 + 运行时参数覆盖
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, EnvironmentConfig } from '../core/types.js';
import { logger } from '../utils/logger.js';

// 环境文件定位：兼容源码运行（src/）与编译产物（dist/）
function resolveConfigPath(): string {
  const candidates = [
    path.join(import.meta.dirname, 'environments.json'), // dist/src/config 或 src/config
    path.join(import.meta.dirname, '../../environments.json'),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

const CONFIG_PATH = resolveConfigPath();

/** CLI 运行时参数（用于覆盖配置默认值） */
export interface CliArgs {
  task?: string | null;
  env?: string | null;
  func?: string | null;
  reporter?: string | null;
  help?: boolean;
  ci?: boolean;
  timeout?: number | null;
  debug?: boolean;
  grep?: string | null;
  filter?: string | null;
  scene?: string | null;
}

/** schema 校验错误：缺失字段/未知环境 */
function validate(cfg: AppConfig, envName?: string): void {
  const errors: string[] = [];
  if (!cfg.default_env) errors.push('缺少 default_env');
  if (!cfg.session_cookies_path) errors.push('缺少 session_cookies_path');
  if (!cfg.environments || Object.keys(cfg.environments).length === 0) errors.push('environments 为空');
  for (const [name, env] of Object.entries(cfg.environments)) {
    if (!env.base_url) errors.push(`环境 ${name} 缺少 base_url`);
    if (!env.submit_url) errors.push(`环境 ${name} 缺少 submit_url`);
    if (!env.status_url) errors.push(`环境 ${name} 缺少 status_url`);
    if (!env.detail_url) errors.push(`环境 ${name} 缺少 detail_url`);
    if (!env.billing_url) errors.push(`环境 ${name} 缺少 billing_url`);
    if (!env.csrf_page) errors.push(`环境 ${name} 缺少 csrf_page`);
    if (typeof env.project_id !== 'number') errors.push(`环境 ${name} 缺少 project_id`);
  }
  if (envName && !cfg.environments[envName]) errors.push(`未知环境：${envName}（可选 ${Object.keys(cfg.environments).join(', ')}）`);
  if (errors.length) {
    throw new Error('配置校验失败：\n  ' + errors.join('\n  '));
  }
}

/** 加载并校验配置，返回合并后的 AppConfig */
export function loadConfig(envOverride?: string | null): AppConfig {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
  const cfg = JSON.parse(raw) as AppConfig;
  const envName = envOverride || cfg.default_env;
  validate(cfg, envName);
  logger.debug(`配置已加载：default_env=${cfg.default_env}, session=${cfg.session_cookies_path}`);
  return cfg;
}

/** 获取指定环境配置（带校验） */
export function getEnvironment(cfg: AppConfig, envName: string): EnvironmentConfig {
  const env = cfg.environments[envName];
  if (!env) throw new Error(`未知环境：${envName}`);
  return env;
}

/** 解析 CLI 参数（薄封装，支持 --task/--env/--func/--reporter/--ci/--timeout/--debug/--grep/--filter/--scene/--help） */
export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { task: null, env: null, func: null, reporter: null, help: false, ci: false, timeout: null, debug: false, grep: null, filter: null, scene: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') args.task = argv[++i] ?? null;
    else if (a === '--env') args.env = argv[++i] ?? null;
    else if (a === '--func') args.func = argv[++i] ?? null;
    else if (a === '--reporter') args.reporter = argv[++i] ?? null;
    else if (a === '--ci') args.ci = true;
    else if (a === '--timeout') args.timeout = Number(argv[++i]) || null;
    else if (a === '--debug') args.debug = true;
    else if (a === '--grep') args.grep = argv[++i] ?? null;
    else if (a === '--filter') args.filter = argv[++i] ?? null;
    else if (a === '--scene') args.scene = argv[++i] ?? null;
    else if (a === '--help') args.help = true;
  }
  return args;
}
