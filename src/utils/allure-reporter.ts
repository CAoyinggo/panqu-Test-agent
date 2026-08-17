// Allure 结果 JSON 生成器：按 Allure 规范生成原始结果文件，供 allure-commandline 生成 HTML 报告
// 不依赖 allure-js-commons，直接使用 crypto.randomUUID() + 原生 JSON
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ExecutionSummary, CaseResult } from './exit-code.js';
import { ensureDir } from './fs-utils.js';
import { logger } from './logger.js';

/** Allure 结果生成选项 */
export interface AllureOptions {
  /** 输出根目录（如 output/<日期>/<功能名>/） */
  outputDir: string;
  /** 执行环境标签 */
  env?: string;
}

/** Allure status 枚举 */
type AllureStatus = 'passed' | 'failed' | 'broken' | 'skipped';

/** Allure label 结构 */
interface AllureLabel {
  name: string;
  value: string;
}

/** Allure statusDetails 结构 */
interface AllureStatusDetails {
  message?: string;
  trace?: string;
}

/** Allure 单条结果 JSON 结构 */
interface AllureResult {
  uuid: string;
  name: string;
  status: AllureStatus;
  statusDetails: AllureStatusDetails;
  stage: string;
  start: number;
  stop: number;
  labels: AllureLabel[];
  attachments?: Array<{ name: string; type: string; source: string }>;
  parameters?: Array<{ name: string; value: string }>;
}

/**
 * 将用例优先级映射到 Allure severity 标签。
 * P0 → blocker, P1 → critical, P2 → normal, P3 → minor
 * 未匹配时默认 normal。
 */
export function mapPriorityToSeverity(priority: string | undefined): string {
  if (!priority) return 'normal';
  const p = priority.toUpperCase();
  const map: Record<string, string> = {
    P0: 'blocker',
    P1: 'critical',
    P2: 'normal',
    P3: 'minor',
  };
  return map[p] || 'normal';
}

/** 从用例 tags 中提取优先级标签 */
function extractPriority(tags?: string[]): string | undefined {
  if (!tags || tags.length === 0) return undefined;
  const pTag = tags.find((t) => /^p[0-3]$/i.test(t));
  return pTag;
}

/** 将 CaseResult 转换为 Allure status */
function toAllureStatus(c: CaseResult): AllureStatus {
  if (c.timedOut) return 'broken';
  if (c.pending) return 'skipped';
  return c.pass ? 'passed' : 'failed';
}

/**
 * 生成 Allure 结果 JSON 文件到 <outputDir>/allure-results/ 目录。
 *
 * 每个用例生成一个 <uuid>-result.json，包含：
 * - name: 用例名
 * - status: passed/failed/broken/skipped
 * - statusDetails: 失败原因和堆栈
 * - stage: finished
 * - start/stop: 时间戳（毫秒）
 * - labels: suite, severity, feature, story, env
 *
 * @returns 生成的文件路径列表，失败时返回空数组
 */
export function generateAllureResults(
  summary: ExecutionSummary,
  cases: CaseResult[],
  options: AllureOptions,
): string[] {
  const { outputDir: outDir, env = 'test' } = options;
  const resultsDir = path.join(outDir, 'allure-results');
  const files: string[] = [];

  try {
    ensureDir(resultsDir);
    const now = Date.now();

    for (const c of cases) {
      const uuid = crypto.randomUUID();
      const status = toAllureStatus(c);
      const duration = c.durationMs || 0;
      const start = now - duration;
      const stop = now;

      const priority = extractPriority(c.tags);
      const severity = mapPriorityToSeverity(priority);
      const feature = c.feature || 'default';

      const labels: AllureLabel[] = [
        { name: 'suite', value: feature },
        { name: 'severity', value: severity },
        { name: 'feature', value: feature },
        { name: 'story', value: c.name },
        { name: 'env', value: env },
      ];

      if (priority) {
        labels.push({ name: 'tag', value: priority });
      }

      if (c.scene) {
        labels.push({ name: 'parentSuite', value: c.scene });
      }

      const statusDetails: AllureStatusDetails = {};
      if (status === 'failed' || status === 'broken') {
        statusDetails.message = c.error || (c.timedOut ? '执行超时' : '用例执行失败');
        if (c.stack) {
          statusDetails.trace = c.stack;
        }
      }

      const result: AllureResult = {
        uuid,
        name: c.name,
        status,
        statusDetails,
        stage: 'finished',
        start,
        stop,
        labels,
      };

      // 添加通过率参数（便于 Allure 报告展示）
      if (c.passRate !== undefined) {
        result.parameters = [{ name: 'passRate', value: `${c.passRate}%` }];
      }

      const filePath = path.join(resultsDir, `${uuid}-result.json`);
      fs.writeFileSync(filePath, JSON.stringify(result, null, 2), 'utf-8');
      files.push(filePath);
    }

    logger.info(`Allure 结果已生成：${files.length} 个文件 → ${resultsDir}`);
    return files;
  } catch (e: any) {
    logger.warn(`Allure 结果生成失败（已降级跳过）：${e.message}`);
    return [];
  }
}
