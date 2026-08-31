/**
 * Trae 内置模型分析器。
 *
 * 只通过本机已登录的 `traecli exec` 调用 Trae 模型：
 *   -C <快照> --sandbox read-only --ephemeral --output-schema <schema> --output-last-message <json> --json
 *
 * 约束：
 *  - 不配置外部模型、不读取/传递任何 API Key；
 *  - 禁止 --yolo / danger-full-access / bypass_permissions；
 *  - 模型只做分析，不修改文件、不自行运行构建/测试、不发起 API 请求；
 *  - 调用失败时状态只能是 BLOCKED 或 ERROR，绝不伪造 PASSED；
 *  - 捕获输出与最终 JSON 都经过脱敏后才进入报告。
 */
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawn } from 'node:child_process';
import { redactText, redactObjectDeep } from './redact.mjs';

export const DEFAULT_MODEL_TIMEOUT_MS = 300000;

function createCappedBuffer(maxBytes) {
  let chunks = [];
  let total = 0;
  let overflow = 0;
  return {
    push(buf) {
      const size = buf.length;
      total += size;
      if (total <= maxBytes) chunks.push(buf);
      else {
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
  setTimeout(() => {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* ignore */
    }
  }, 2000).unref();
}

/**
 * 组装模型提示词（模板 + 上下文）。
 * @param {string} template 模板文本（prompts/panqu-local-validator.md）
 * @param {object} context 注入字段
 */
export function composePrompt(template, context) {
  let out = template;
  for (const [key, value] of Object.entries(context)) {
    const token = `{{${key}}}`;
    const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    out = out.split(token).join(text);
  }
  return out;
}

/**
 * 运行 Trae 分析（带有限重试）。
 * 对「调用失败 / 超时 / 结构化输出无效或为空」做最多 maxAttempts 次尝试；
 * 全部失败仍 fail-closed 返回 ERROR，绝不伪造 PASSED。
 * @returns {{status:'PASSED'|'BLOCKED'|'ERROR', data?:object, reason?:string,
 *            command:Array<string>, exitCode:number|null, signal:string|null,
 *            durationMs:number, stdout:string, stderr:string, attempts:number}}
 */
export async function runTraeAnalysis(opts) {
  const {
    snapshotPath,
    promptTemplate,
    schemaPath,
    outputJsonPath,
    traecliPath,
    loginStatus,
    timeoutMs = DEFAULT_MODEL_TIMEOUT_MS,
    maxOutputBytes = 300 * 1024,
    extraArgs = [],
    maxAttempts = 2,
  } = opts;

  if (!traecliPath) {
    return {
      status: 'BLOCKED',
      reason: 'traecli 未安装，无法调用 Trae 内置模型（安装并登录后重试）',
      command: [],
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      attempts: 0,
    };
  }
  if (loginStatus !== 'logged_in') {
    return {
      status: 'BLOCKED',
      reason: `traecli 未登录（login status=${loginStatus}），需用户手动完成企业账号登录后重试`,
      command: [],
      exitCode: null,
      signal: null,
      durationMs: 0,
      stdout: '',
      stderr: '',
      attempts: 0,
    };
  }

  // 确保输出文件父目录存在
  mkdirSync(dirname(outputJsonPath), { recursive: true });

  const args = [
    'exec',
    '-C', snapshotPath,
    '--sandbox', 'read-only',
    '--ephemeral',
    '--output-schema', schemaPath,
    '--output-last-message', outputJsonPath,
    '--json',
    ...extraArgs,
  ];

  /** 单次尝试：spawn traecli → 校验结构化输出。 */
  async function attempt() {
    const startedAt = Date.now();
    const out = createCappedBuffer(maxOutputBytes);
    const err = createCappedBuffer(maxOutputBytes);

    const result = await new Promise((resolvePromise) => {
      let child;
      try {
        child = spawn(traecliPath, args, {
          shell: false,
          detached: process.platform !== 'win32',
          env: { ...process.env },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (e) {
        return resolvePromise({ ok: false, reason: `spawn traecli 失败: ${String(e)}`, exitCode: null, signal: null, timedOut: false });
      }

      child.stdout.on('data', (d) => out.push(d));
      child.stderr.on('data', (d) => err.push(d));
      child.stdin.end(promptTemplate); // 模板即最终 prompt

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
        resolvePromise({ ok: false, reason: `traecli 进程错误: ${String(e)}`, exitCode: null, signal: null, timedOut: false });
      });

      child.on('close', (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolvePromise({ ok: code === 0, reason: '', exitCode: code, signal, timedOut });
      });
    });

    const durationMs = Date.now() - startedAt;
    const stdoutRedacted = redactText(out.text());
    const stderrRedacted = redactText(err.text());

    if (result.timedOut) {
      return { status: 'ERROR', reason: `Trae 分析超过超时时间 ${timeoutMs}ms，已终止进程组`, exitCode: result.exitCode, signal: result.signal, durationMs, stdout: stdoutRedacted, stderr: stderrRedacted };
    }
    if (!result.ok) {
      return { status: 'ERROR', reason: result.reason || `traecli exec 失败(exit=${result.exitCode} signal=${result.signal ?? '-'})`, exitCode: result.exitCode, signal: result.signal, durationMs, stdout: stdoutRedacted, stderr: stderrRedacted };
    }

    // 读取模型结构化输出
    let data;
    try {
      const raw = readFileSync(outputJsonPath, 'utf8');
      data = JSON.parse(raw);
    } catch (e) {
      return { status: 'ERROR', reason: `未能读取模型结构化输出（${outputJsonPath}）: ${String(e)}`, exitCode: result.exitCode, signal: result.signal, durationMs, stdout: stdoutRedacted, stderr: stderrRedacted };
    }

    const missing = requiredAnalysisFields().filter((f) => data[f] === undefined || data[f] === null);
    if (missing.length > 0) {
      return { status: 'ERROR', reason: `模型输出缺少必要字段: ${missing.join(', ')}`, exitCode: result.exitCode, signal: result.signal, durationMs, stdout: stdoutRedacted, stderr: stderrRedacted };
    }

    return {
      status: 'PASSED',
      data: redactObjectDeep(data),
      reason: '',
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs,
      stdout: stdoutRedacted,
      stderr: stderrRedacted,
    };
  }

  let lastError = null;
  let attempts = 0;
  let lastResult = null;
  for (let i = 0; i < maxAttempts; i += 1) {
    attempts += 1;
    // eslint-disable-next-line no-await-in-loop
    lastResult = await attempt();
    if (lastResult.status === 'PASSED') break;
    lastError = lastResult;
  }

  if (lastResult.status === 'PASSED') {
    return { ...lastResult, command: args, attempts };
  }

  const retryNote = attempts > 1 ? `（已重试 ${attempts - 1} 次，仍失败）` : '';
  return {
    status: 'ERROR',
    reason: `${lastError.reason || 'Trae 分析失败'}${retryNote}`,
    command: args,
    exitCode: lastError.exitCode,
    signal: lastError.signal,
    durationMs: lastError.durationMs,
    stdout: lastError.stdout,
    stderr: lastError.stderr,
    attempts,
  };
}

export function requiredAnalysisFields() {
  return ['architecture_summary', 'changed_areas', 'risks', 'recommended_checks', 'execution_evidence', 'unverified_content'];
}
