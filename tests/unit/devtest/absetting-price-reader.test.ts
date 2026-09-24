/**
 * AbsettingPriceReader 单元测试（注入执行器 · 100% 离线）
 * 覆盖：字符串价格归一化、fail-closed 脱敏、resolveAbsettingListPrice 精确匹配/歧义/收窄。
 */
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  readAbsettingPrices,
  resolveAbsettingListPrice,
  type AbsettingRow,
} from '../../../src/devtest/absetting-price-reader.js';
import type { DbScriptRunner } from '../../../src/devtest/database-evidence-producer.js';

const existingPath = fileURLToPath(import.meta.url);

describe('readAbsettingPrices (注入执行器)', () => {
  const opts = { model: 12, credPath: existingPath, scriptPath: existingPath };

  it('VERIFIED JSON → 字符串价格归一化为数字，携带 abSchema', async () => {
    const runner: DbScriptRunner = async () => ({
      stdout: JSON.stringify({
        status: 'VERIFIED',
        abSchema: 'ai_video_ab_test',
        model: 12,
        rows: [
          { model_config_id: 12, task_type: 1, resolution: 4, billing_type: 1, list_price_points: '10.00', cost_price: '0.2000' },
          { model_config_id: 12, task_type: 1, resolution: 6, billing_type: 1, list_price_points: '15.00', cost_price: '0.3000' },
        ],
      }),
    });
    const res = await readAbsettingPrices(opts, runner);
    expect(res.status).toBe('VERIFIED');
    expect(res.abSchema).toBe('ai_video_ab_test');
    expect(res.rows).toHaveLength(2);
    expect(res.rows[0].list_price_points).toBe(10); // "10.00" → 10 (number)
    expect(res.rows[1].list_price_points).toBe(15);
    expect(res.rows[0].resolution).toBe(4);
  });

  it('执行器抛错(含密码) → fail-closed 且脱敏', async () => {
    const runner: DbScriptRunner = async () => {
      throw new Error('tunnel failed password=Hunter2');
    };
    const res = await readAbsettingPrices(opts, runner);
    expect(res.status).toBe('UNVERIFIED');
    expect(res.reason).toBe('ABSETTING_READ_FAILED');
    expect(res.error || '').not.toContain('Hunter2');
    expect(res.rows).toEqual([]);
  });
});

describe('resolveAbsettingListPrice (精确码匹配)', () => {
  const rows: AbsettingRow[] = [
    { model_config_id: 78, task_type: 2, resolution: 1, billing_type: 2, list_price_points: 21, cost_price: 0.462 },
    { model_config_id: 78, task_type: 2, resolution: 2, billing_type: 2, list_price_points: 46, cost_price: 1.512 },
    // 同分辨率码但不同 task_type 且价格不同 → 歧义
    { model_config_id: 78, task_type: 2, resolution: 3, billing_type: 2, list_price_points: 115, cost_price: 3.743 },
    { model_config_id: 78, task_type: 9, resolution: 3, billing_type: 2, list_price_points: 999, cost_price: 9 },
  ];
  it('唯一匹配 → 返回价格', () => {
    expect(resolveAbsettingListPrice(rows, { resolutionCode: 1 })).toBe(21);
    expect(resolveAbsettingListPrice(rows, { resolutionCode: 2 })).toBe(46);
  });
  it('多 task_type 价格歧义 → null；用 taskType 收窄 → 命中', () => {
    expect(resolveAbsettingListPrice(rows, { resolutionCode: 3 })).toBeNull();
    expect(resolveAbsettingListPrice(rows, { resolutionCode: 3, taskType: 2 })).toBe(115);
  });
  it('无此码 → null', () => {
    expect(resolveAbsettingListPrice(rows, { resolutionCode: 99 })).toBeNull();
  });
});
