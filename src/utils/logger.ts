// 分级彩色日志
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

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS.indexOf(level) >= LEVELS.indexOf(currentLevel);
}

function write(level: LogLevel, msg: string): void {
  if (!shouldLog(level)) return;
  const prefix = `[${level.toUpperCase()}]`;
  // eslint-disable-next-line no-console
  console.log(level === 'error' ? COLORS.error + prefix + RESET + ' ' + msg : COLORS[level] + prefix + RESET + ' ' + msg);
}

export const logger = {
  debug: (msg: string) => write('debug', msg),
  info: (msg: string) => write('info', msg),
  warn: (msg: string) => write('warn', msg),
  error: (msg: string) => write('error', msg),
  // 步骤标题（无前缀）
  step: (msg: string) => {
    if (!shouldLog('info')) return;
    // eslint-disable-next-line no-console
    console.log('\n' + msg);
  },
};
