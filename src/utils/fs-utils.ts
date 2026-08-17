// 文件系统工具：目录创建/归档路径/JSON 读写
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

/** 确保目录存在（递归） */
export function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 读取 JSON 文件，返回解析结果；文件不存在/解析失败返回 null 并告警 */
export function readJson<T = any>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      logger.warn(`文件不存在：${filePath}`);
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch (e: any) {
    logger.warn(`JSON 解析失败 ${filePath}: ${e.message}`);
    return null;
  }
}

/** 写 JSON 文件（自动建目录） */
export function writeJson(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

/** 日期 YYYY-MM-DD（本地时区） */
export function todayStr(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 时间戳（报告文件名用） */
export function timestamp(): number {
  return Date.now();
}

/**
 * 计算归档目录：<outputDir>/<日期>/[<功能名>]
 * func 为空时只有日期目录；func 非空追加功能名子目录
 * 输出根目录优先使用 TESTFLOW_OUTPUT_DIR 环境变量，未设置时回退到默认路径
 */
export function outputDir(func?: string): string {
  const outputRoot = process.env.TESTFLOW_OUTPUT_DIR || '/Users/mac/agents/output';
  const base = path.join(outputRoot, todayStr());
  const f = (func || '').trim();
  const dir = f ? path.join(base, f) : base;
  ensureDir(dir);
  return dir;
}

/**
 * 计算用例级归档目录：output/<日期>/<功能名>/<caseId>/
 * 并发模式下每个用例独立子目录，避免报告文件互相覆盖。
 * caseId 为空时退化为 outputDir(func)（向后兼容串行模式）。
 */
export function caseOutputDir(func?: string, caseId?: string): string {
  if (!caseId) return outputDir(func);
  const dir = path.join(outputDir(func), caseId);
  ensureDir(dir);
  return dir;
}

/** 计算日志目录：output/<日期>/<功能名>/logs/ */
export function logsDir(func?: string): string {
  const dir = path.join(outputDir(func), 'logs');
  ensureDir(dir);
  return dir;
}

/** 计算调试目录：output/<日期>/<功能名>/debug/ */
export function debugDir(func?: string): string {
  const dir = path.join(outputDir(func), 'debug');
  ensureDir(dir);
  return dir;
}

/**
 * 计算用例级调试目录（--debug-level verbose/full 模式下使用）：
 * - 并发模式（caseId 非空）：output/<日期>/<功能名>/<caseId>/debug/
 * - 串行模式（caseId 为空）：output/<日期>/<功能名>/debug/
 */
export function caseDebugDir(func?: string, caseId?: string): string {
  const base = caseId ? caseOutputDir(func, caseId) : outputDir(func);
  const dir = path.join(base, 'debug');
  ensureDir(dir);
  return dir;
}
