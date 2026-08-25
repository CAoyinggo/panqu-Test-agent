// 分级彩色日志（支持 CI 模式 + JSON 行文件落盘）
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fs-utils.js';
import { getExecutionContext, type ExecutionLogContext } from '../core/execution-context.js';
import { redactSensitiveText } from '../core/redact.js';

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

const COLORS: Record<LogLevel, string> = {
  debug: '\x1b[90m', // gray
  info: '\x1b[36m', // cyan
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

let currentLevel: LogLevel = 'info';
let noColor = false;
let ciMode = false;

// 无 execution scope 时仅用于 CLI 启动/配置阶段的兼容上下文。
// 实际用例执行始终使用 AsyncLocalStorage 中的隔离副本。
const fallbackLogContext: ExecutionLogContext = {};

function currentLogContext(): ExecutionLogContext {
  return getExecutionContext()?.log ?? fallbackLogContext;
}

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

/** 关闭彩色输出（CI 模式自动启用） */
export function setNoColor(enabled: boolean): void {
  noColor = enabled;
}

/** 启用 CI 模式：关闭彩色 + 抑制 ==== 分隔线 */
export function setCiMode(enabled: boolean): void {
  ciMode = enabled;
  if (enabled) noColor = true;
}

/** 设置日志文件路径（开启 JSON 行落盘） */
export function setLogFile(filePath: string): void {
  const context = currentLogContext();
  if (context.sink) {
    context.sink.end();
    context.sink = undefined;
  }
  ensureDir(path.dirname(filePath));
  context.sink = fs.createWriteStream(filePath, { flags: 'a' });
}

/** 关闭当前 execution scope 拥有的日志文件资源（幂等）。 */
export function closeLogFile(): void {
  const context = currentLogContext();
  if (!context.sink) return;
  context.sink.end();
  context.sink = undefined;
}

/** 设置日志上下文（task/scene/trace） */
export function setLogContext(ctx: { task?: string; scene?: string; trace?: string }): void {
  Object.assign(currentLogContext(), ctx);
}

/** 设置当前用例 ID（并发模式下日志前缀隔离） */
export function setCaseId(caseId: string): void {
  currentLogContext().caseId = caseId || '';
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(currentLevel);
}

/** 写入 JSON 行到文件 */
function writeJsonLine(level: string, msg: string): void {
  const context = currentLogContext();
  if (!context.sink) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    step: redactSensitiveText(context.step || ''),
    task: redactSensitiveText(context.task || ''),
    scene: redactSensitiveText(context.scene || ''),
    trace: redactSensitiveText(context.trace || ''),
    caseId: redactSensitiveText(context.caseId || ''),
    msg: redactSensitiveText(msg),
  };
  context.sink.write(JSON.stringify(entry) + '\n');
}

function write(level: LogLevel, msg: string): void {
  if (!shouldLog(level)) return;
  const safeMessage = redactSensitiveText(msg);
  const context = currentLogContext();
  const prefix = `[${level.toUpperCase()}]`;
  const caseTag = context.caseId ? `[${context.caseId}] ` : '';
  if (noColor) {
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${caseTag}${safeMessage}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(level === 'error' ? COLORS.error + prefix + RESET + ' ' + caseTag + safeMessage : COLORS[level] + prefix + RESET + ' ' + caseTag + safeMessage);
  }
  writeJsonLine(level, safeMessage);
}

export const logger = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
  // 步骤标题。并发 scope 下附带 caseId；CI 模式下抑制 ==== / ---- 分隔线
  step: (msg: string) => {
    if (!shouldLog('info')) return;
    if (ciMode && /^(={4,}|-{4,})/.test(msg)) return;
    const context = currentLogContext();
    const safeMessage = redactSensitiveText(msg);
    context.step = safeMessage;
    const caseTag = context.caseId ? `[${context.caseId}] ` : '';
    // eslint-disable-next-line no-console
    console.log(`\n${caseTag}${safeMessage}`);
    writeJsonLine('info', safeMessage);
  },
};
