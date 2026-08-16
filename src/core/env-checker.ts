// 环境一致性检测：快照对比，感知计费单价/积分/配置变更
// - snapshot(): 采集当前环境状态（积分/模型/配置）
// - compare(baseline, current): 对比两个快照，返回 EnvDiff
// - saveBaseline() / loadBaseline(): 基线持久化到 output 目录
// - assertEnvConsistency(): 生成断言结果
import type { EnvSnapshot, EnvDiff, CheckResult, AppConfig } from './types.js';
import type { Billing } from '../integrations/billing.js';
import { writeJson, outputDir } from '../utils/fs-utils.js';
import { logger } from '../utils/logger.js';
import fs from 'node:fs';
import path from 'node:path';

/** 采集当前环境快照 */
export async function snapshot(
  env: string,
  cfg: AppConfig,
  billing: Billing,
): Promise<EnvSnapshot> {
  const envCfg = cfg.environments[env];
  const summary = await billing.summary();
  const top = await billing.modelTop();

  // 从 modelTop 提取模型列表
  const models: Array<{ id: string | number; name: string; price?: number }> = [];
  if (top && top.items) {
    for (const item of top.items) {
      models.push({
        id: item.id ?? item.model_id ?? '',
        name: item.name ?? item.model_name ?? '',
        price: item.points != null ? Number(item.points) : undefined,
      });
    }
  }

  return {
    timestamp: new Date().toISOString(),
    env,
    availablePoints: Number(summary.available_points) || 0,
    consumed7d: Number(summary.consumed_7d) || 0,
    models,
    config: {
      base_url: envCfg.base_url,
      project_id: envCfg.project_id,
      account: envCfg.account || '',
    },
  };
}

/**
 * 对比两个环境快照，返回差异
 * 检测维度：积分余额、近 7 天消耗、模型列表、配置变更
 */
export function compare(baseline: EnvSnapshot, current: EnvSnapshot): EnvDiff {
  const changes: EnvDiff['changes'] = [];

  // 1. 积分余额骤变（下降超过 50% 或差额 > 500）
  const pointsDiff = current.availablePoints - baseline.availablePoints;
  const pointsDropThreshold = Math.max(baseline.availablePoints * 0.5, 500);
  if (Math.abs(pointsDiff) > pointsDropThreshold) {
    changes.push({
      field: '积分余额',
      before: String(baseline.availablePoints),
      after: String(current.availablePoints),
      severity: pointsDiff < 0 ? 'error' : 'info',
    });
  }

  // 2. 近 7 天消耗异常（增长超过 50%）
  const consumedGrowth = baseline.consumed7d > 0
    ? (current.consumed7d - baseline.consumed7d) / baseline.consumed7d
    : 0;
  if (consumedGrowth > 0.5) {
    changes.push({
      field: '近7天消耗',
      before: String(baseline.consumed7d),
      after: String(current.consumed7d),
      severity: 'warning',
    });
  }

  // 3. 模型列表变更（新增或移除模型）
  const baselineModelIds = new Set(baseline.models.map((m) => String(m.id)));
  const currentModelIds = new Set(current.models.map((m) => String(m.id)));
  const removed = baseline.models.filter((m) => !currentModelIds.has(String(m.id)));
  const added = current.models.filter((m) => !baselineModelIds.has(String(m.id)));
  if (removed.length > 0) {
    changes.push({
      field: '模型下线',
      before: removed.map((m) => `${m.name}(${m.id})`).join(', '),
      after: '已下线',
      severity: 'error',
    });
  }
  if (added.length > 0) {
    changes.push({
      field: '模型新增',
      before: '不存在',
      after: added.map((m) => `${m.name}(${m.id})`).join(', '),
      severity: 'info',
    });
  }

  // 4. 模型单价变更
  for (const bm of baseline.models) {
    const cm = current.models.find((m) => String(m.id) === String(bm.id) && m.price != null && bm.price != null);
    if (cm && bm.price != null && cm.price !== bm.price) {
      changes.push({
        field: `模型单价[${bm.name}]`,
        before: String(bm.price),
        after: String(cm.price),
        severity: 'warning',
      });
    }
  }

  // 5. 环境配置变更（base_url / project_id / account）
  if (baseline.config.base_url !== current.config.base_url) {
    changes.push({
      field: 'base_url',
      before: baseline.config.base_url,
      after: current.config.base_url,
      severity: 'error',
    });
  }
  if (baseline.config.project_id !== current.config.project_id) {
    changes.push({
      field: 'project_id',
      before: String(baseline.config.project_id),
      after: String(current.config.project_id),
      severity: 'error',
    });
  }
  if (baseline.config.account !== current.config.account) {
    changes.push({
      field: 'account',
      before: baseline.config.account,
      after: current.config.account,
      severity: 'warning',
    });
  }

  return {
    changed: changes.length > 0,
    changes,
  };
}

/** 保存环境基线快照到 output 目录 */
export function saveBaseline(snapshot: EnvSnapshot, func?: string): string {
  const dir = outputDir(func);
  const file = path.join(dir, 'env-baseline.json');
  writeJson(file, snapshot);
  logger.info(`环境基线已保存：${file}`);
  return file;
}

/** 加载环境基线快照（如不存在返回 null） */
export function loadBaseline(func?: string): EnvSnapshot | null {
  const dir = outputDir(func);
  const file = path.join(dir, 'env-baseline.json');
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf-8');
    return JSON.parse(raw) as EnvSnapshot;
  } catch {
    logger.warn(`环境基线文件解析失败：${file}`);
    return null;
  }
}

/**
 * 环境一致性断言：将 EnvDiff 转换为 CheckResult[]
 * - 有 error 级别变更 → 断言失败
 * - 有 warning 级别变更 → 断言通过但标记警告
 * - 无变更 → 断言通过
 */
export function assertEnvConsistency(diff: EnvDiff): CheckResult[] {
  if (!diff.changed) {
    return [{
      name: '环境一致性',
      pass: true,
      detail: '环境与基线一致，无变更',
      level: 'P2',
    }];
  }

  const hasError = diff.changes.some((c) => c.severity === 'error');
  const hasWarning = diff.changes.some((c) => c.severity === 'warning');
  const details = diff.changes
    .map((c) => `${c.severity === 'error' ? '⚠' : 'ℹ'} ${c.field}: ${c.before} → ${c.after}`)
    .join('；');

  return [{
    name: '环境一致性',
    pass: !hasError,
    detail: `检测到 ${diff.changes.length} 项变更：${details}`,
    level: hasError ? 'P0' : hasWarning ? 'P1' : 'P2',
  }];
}
