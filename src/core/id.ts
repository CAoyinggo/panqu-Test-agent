// 共享碰撞安全 ID 生成（Phase 29.3）
// 修复：原各模块用 `Date.now().toString(36) + Math.random().toString(36).slice(...)`
// 组合生成 ID，在高吞吐（容量基线发现 500k ops/s 级写入）下会碰撞，
// 导致 Repository.create 抛「实体已存在」。改用 crypto.randomUUID（128 bit 熵）消除碰撞。
import { randomUUID } from 'node:crypto';

/** 生成碰撞安全 ID：<prefix>-<timestamp36>-<uuid hex 32>（保留时间前缀便于排序/溯源） */
export function generateId(prefix = 'id'): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().replace(/-/g, '')}`;
}
