// 分级彩色日志（支持 CI 模式 + JSON 行文件落盘）
import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fs-utils.js';

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

// 文件日志状态
let logStream: fs.WriteStream | null = null;
let logContext: { task?: string; scene?: string; trace?: string } = {};
let currentStep = '';
let currentCaseId = '';

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
  if (logStream) {
    logStream.end();
    logStream = null;
  }
  ensureDir(path.dirname(filePath));
  logStream = fs.createWriteStream(filePath, { flags: 'a' });
}

/** 设置日志上下文（task/scene/trace） */
export function setLogContext(ctx: { task?: string; scene?: string; trace?: string }): void {
  logContext = ctx;
}

/** 设置当前用例 ID（并发模式下日志前缀隔离） */
export function setCaseId(caseId: string): void {
  currentCaseId = caseId || '';
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(currentLevel);
}

/** 写入 JSON 行到文件 */
function writeJsonLine(level: string, msg: string): void {
  if (!logStream) return;
  const entry = {
    ts: new Date().toISOString(),
    level,
    step: currentStep,
    task: logContext.task || '',
    scene: logContext.scene || '',
    trace: logContext.trace || '',
    caseId: currentCaseId || '',
    msg,
  };
  logStream.write(JSON.stringify(entry) + '\n');
}

function write(level: LogLevel, msg: string): void {
  if (!shouldLog(level)) return;
  const prefix = `[${level.toUpperCase()}]`;
  const caseTag = currentCaseId ? `[${currentCaseId}] ` : '';
  if (noColor) {
    // eslint-disable-next-line no-console
    console.log(`${prefix} ${caseTag}${msg}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(level === 'error' ? COLORS.error + prefix + RESET + ' ' + caseTag + msg : COLORS[level] + prefix + RESET + ' ' + caseTag + msg);
  }
  writeJsonLine(level, msg);
}

export const logger = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
  // 步骤标题（无前缀）。CI 模式下抑制 ==== / ---- 分隔线
  step: (msg: string) => {
    if (!shouldLog('info')) return;
    if (ciMode && /^(={4,}|-{4,})/.test(msg)) return;
    currentStep = msg;
    // eslint-disable-next-line no-console
    console.log('\n' + msg);
    writeJsonLine('info', msg);
  },
};
