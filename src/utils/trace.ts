// 执行追踪 ID：每次 engine.main 启动生成，注入日志与报告
import { getExecutionContext } from '../core/execution-context.js';

let fallbackTraceId = '';

/** 生成 trace-id（时间戳+短随机串，如 20260816-143052-a7b3） */
export function generateTraceId(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  fallbackTraceId = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
  return fallbackTraceId;
}

/** 获取当前 trace-id */
export function getTraceId(): string {
  return getExecutionContext()?.log.trace || fallbackTraceId;
}
