// Dry-run 模式：仅解析和校验用例定义，不执行任何 HTTP 请求
// 校验必填字段、数据文件存在性、标签格式，输出用例清单
import fs from 'node:fs';
import path from 'node:path';
import type { LoadedCase } from '../cases/loader.js';
import type { TaskDef } from './types.js';
import { logger } from '../utils/logger.js';

export interface DryRunResult {
  total: number;
  passed: number;
  failed: number;
  byFeature: Record<string, number>;
  cases: Array<{
    name: string;
    feature: string;
    scene: string;
    model_id: string;
    expected_points: string;
    tags: string;
    dataFile: string;
    valid: boolean;
    errors: string[];
  }>;
}

/** 校验单个用例定义，返回错误列表（空数组 = 通过） */
function validateCase(def: TaskDef): string[] {
  const errors: string[] = [];

  // 必填字段
  if (!def.name || typeof def.name !== 'string') {
    errors.push('name 缺失或非字符串');
  }
  if (!def.scene || typeof def.scene !== 'string') {
    errors.push('scene 缺失或非字符串');
  }
  if (def.model_id === undefined || def.model_id === null || def.model_id === '') {
    errors.push('model_id 缺失');
  }
  if (def.expected_points === undefined || def.expected_points === null) {
    errors.push('expected_points 缺失');
  } else if (typeof def.expected_points !== 'number' || def.expected_points < 0) {
    errors.push(`expected_points 非法值：${def.expected_points}（应为非负数）`);
  }

  // tags 格式校验
  if (def.tags !== undefined) {
    if (!Array.isArray(def.tags)) {
      errors.push(`tags 格式错误：应为数组，实际为 ${typeof def.tags}`);
    } else {
      for (const t of def.tags) {
        if (typeof t !== 'string') {
          errors.push(`tags 包含非字符串元素：${JSON.stringify(t)}`);
          break;
        }
      }
    }
  }

  // dataFile 存在性校验
  if (def.dataFile) {
    const dataFilePath = path.isAbsolute(def.dataFile)
      ? def.dataFile
      : path.resolve(process.cwd(), def.dataFile);
    if (!fs.existsSync(dataFilePath)) {
      errors.push(`dataFile 文件不存在：${def.dataFile}`);
    }
  }

  return errors;
}

/** 执行 dry-run 校验，输出用例清单并返回结果 */
export function runDryRun(cases: LoadedCase[]): DryRunResult {
  const result: DryRunResult = {
    total: cases.length,
    passed: 0,
    failed: 0,
    byFeature: {},
    cases: [],
  };

  for (const c of cases) {
    const errors = validateCase(c.def);
    const feature = c.feature || '(未分组)';
    const valid = errors.length === 0;

    if (valid) result.passed++;
    else result.failed++;

    result.byFeature[feature] = (result.byFeature[feature] || 0) + 1;

    result.cases.push({
      name: c.def.name || '(未命名)',
      feature,
      scene: c.def.scene || '(未设置)',
      model_id: c.def.model_id !== undefined ? String(c.def.model_id) : '(缺失)',
      expected_points: c.def.expected_points !== undefined ? String(c.def.expected_points) : '(缺失)',
      tags: Array.isArray(c.def.tags) ? c.def.tags.join(', ') : '(无)',
      dataFile: (c.def.dataFile as string) || '(无)',
      valid,
      errors,
    });
  }

  // 输出用例清单
  logger.step('========== Dry-run 校验结果 ==========');
  logger.info(`用例总数：${result.total}（通过 ${result.passed} / 失败 ${result.failed}）`);

  // 按 feature 分组统计
  logger.info('\n按功能分组：');
  for (const [feat, count] of Object.entries(result.byFeature)) {
    logger.info(`  ${feat}: ${count} 个用例`);
  }

  // 用例清单表格
  logger.info('\n用例清单：');
  logger.info('┌────┬──────────────────────┬──────────┬──────────┬──────────┬────────────┬────────┬────────┐');
  logger.info('│ #  │ 用例名称             │ 功能     │ 场景     │ 模型ID   │ 预期积分   │ 标签   │ 校验   │');
  logger.info('├────┼──────────────────────┼──────────┼──────────┼──────────┼────────────┼────────┼────────┤');
  for (let i = 0; i < result.cases.length; i++) {
    const c = result.cases[i];
    const name = c.name.length > 20 ? c.name.slice(0, 18) + '..' : c.name.padEnd(20);
    const feat = c.feature.padEnd(8);
    const scene = c.scene.length > 8 ? c.scene.slice(0, 6) + '..' : c.scene.padEnd(8);
    const model = c.model_id.padEnd(8);
    const points = c.expected_points.padEnd(10);
    const tags = c.tags.length > 6 ? c.tags.slice(0, 4) + '..' : c.tags.padEnd(6);
    const status = c.valid ? '✅ 通过' : '❌ 失败';
    logger.info(`│ ${String(i + 1).padStart(2)} │ ${name} │ ${feat} │ ${scene} │ ${model} │ ${points} │ ${tags} │ ${status} │`);
  }
  logger.info('└────┴──────────────────────┴──────────┴──────────┴──────────┴────────────┴────────┴────────┘');

  // 失败详情
  const failedCases = result.cases.filter((c) => !c.valid);
  if (failedCases.length > 0) {
    logger.warn('\n校验失败详情：');
    for (const c of failedCases) {
      logger.warn(`  ❌ ${c.name}（${c.feature}）：`);
      for (const err of c.errors) {
        logger.warn(`      - ${err}`);
      }
    }
  }

  return result;
}
