/**
 * 确定性检查执行器（typecheck / lint / test / build）。
 *
 * 安全约束：
 *  - spawn 一律 shell:false，参数数组，禁止自由格式 shell 命令；
 *  - 只允许 `npm run <白名单脚本>` / `pnpm run …` / `yarn run …`；
 *  - cwd = 临时快照，绝不触碰原始工作区；
 *  - 超时终止整个进程组；stdout/stderr 字节上限；保存真实 exitCode/signal/duration；
 *  - 不自动执行 npm install / npm ci；
 *  - 依赖已声明但 node_modules 缺失 → BLOCKED 并给出人工准备依赖的建议。
 */

import { spawn } from 'node:child_process';
import { join } from 'node:path';

export const CHECK_STATUS = ['PASSED', 'FAILED', 'SKIPPED', 'BLOCKED', 'TIMEOUT', 'ERROR'];

export const DEFAULT_MAX_OUTPUT_BYTES = 200 * 1024; // 200KB per stream

function managerRunArgs(manager, scriptName) {
  switch (manager) {
    case 'pnpm': return ['pnpm', 'run', scriptName];
    case 'yarn': return ['yarn', 'run', scriptName];
    case 'npm':
    default: return ['npm', 'run', scriptName];
  }
}

/** 有限缓冲：只保留前 maxBytes，溢出只计数不丢弃（避免子进程写满管道阻塞）。 */
function createCappedBuffer(maxBytes) {
  let chunks = [];
  let total = 0;
  let overflow = 0;
  return {
    push(buf) {
      const size = buf.length;
      total += size;
      if (total <= maxBytes) {
        chunks.push(buf);
      } else {
        const remaining = maxBytes - (total - size);
        if (remaining > 0) chunks.push(buf.subarray(0, remaining));
        overflow += size - Math.max(0, Math.min(size, remaining));
      }
    },
    text() {
      return Buffer.concat(chunks).toString('utf8');
    },
    truncated() {
      return overflow > 0;
    },
  };
}

/**
 * 运行单个检查。
 * @param {{name, scriptName, cwd, manager, timeoutMs, maxOutputBytes, blocked?:string, env?:object}} opts
 * @returns {{name, status, exitCode, signal, durationMs, stdout, stderr, stdoutTruncated, stderrTruncated, summary}}
 */
export function runCheck(opts) {
  const {
    name,
    scriptName,
    cwd,
    manager,
    timeoutMs,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    blocked = null,
    env = {},
  } = opts;

  if (blocked) {
    return {
      name,
      status: 'BLOCKED',
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      summary: blocked,
    };
  }

  const command = managerRunArgs(manager, scriptName);
  const startedAt = Date.now();
  const out = createCappedBuffer(maxOutputBytes);
  const err = createCappedBuffer(maxOutputBytes);

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        shell: false,
        detached: process.platform !== 'win32',
        env: { ...process.env, ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (spawnErr) {
      return resolve({
        name,
        status: 'ERROR',
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: `spawn 失败: ${String(spawnErr)}`,
        stdoutTruncated: false,
        stderrTruncated: false,
        summary: `无法启动进程: ${String(spawnErr)}`,
      });
    }

    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));

    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      killProcessGroup(child);
    }, timeoutMs);

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        name,
        status: 'ERROR',
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout: out.text(),
        stderr: `${err.text()}\n[spawn error: ${String(e)}]`,
        stdoutTruncated: out.truncated(),
        stderrTruncated: err.truncated(),
        summary: `进程启动/运行错误: ${String(e)}`,
      });
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;
      let status;
      if (timedOut) status = 'TIMEOUT';
      else if (code === 0) status = 'PASSED';
      else status = 'FAILED';
      resolve({
        name,
        status,
        exitCode: code,
        signal,
        durationMs,
        stdout: out.text(),
        stderr: err.text(),
        stdoutTruncated: out.truncated(),
        stderrTruncated: err.truncated(),
        summary: status === 'TIMEOUT'
          ? `超过超时时间 ${timeoutMs}ms，已终止进程组`
          : `exit=${code} signal=${signal ?? '-'} duration=${durationMs}ms`,
      });
    });
  });
}

function killProcessGroup(child) {
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    try {
      child.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  // 宽限期后强制 SIGKILL 整个进程组
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }, 2000).unref();
}

/** 包管理器二进制展示形式（报告用，仅白名单解析后的展示形式）。 */
export function commandDisplay(manager, scriptName) {
  return `${manager} run ${scriptName}`;
}
