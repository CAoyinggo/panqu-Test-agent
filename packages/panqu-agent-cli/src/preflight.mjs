/**
 * Preflight：环境与 workspace 前置检查（只读，无副作用）。
 *
 * - 本地运行时（node / npm / git）版本；
 * - traecli 存在性、版本、登录状态（不含任何凭据）；
 * - workspace 路径合法性、是否为 Git 工作区（非 Git 一律 fail closed）。
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { spawnSync } from 'node:child_process';

export async function findTraecli() {
  const probe = await runCaptured('command', ['-v', 'traecli'], {});
  if (probe.ok && probe.stdout.trim()) {
    return probe.stdout.trim().split(/\r?\n/)[0];
  }
  // 兜底：完整路径探测
  const home = process.env.HOME || '';
  const candidates = [
    resolve(home, '.local', 'bin', 'traecli'),
    resolve(home, 'bin', 'traecli'),
  ];
  for (const c of candidates) {
    try {
      if (existsSync(c) && statSync(c).isFile()) return c;
    } catch {
      /* continue */
    }
  }
  return null;
}

export async function traecliVersion(traecliPath) {
  const res = await runCaptured(traecliPath, ['--version'], {});
  if (!res.ok) return { ok: false, version: null, error: res.stderr.trim() || `traecli --version 失败(exit=${res.code})` };
  const firstLine = res.stdout.trim().split(/\r?\n/)[0] || '';
  const match = firstLine.match(/traecli\s+([^\s]+)/i);
  return { ok: true, version: match ? match[1] : firstLine, raw: res.stdout.trim() };
}

/**
 * 读取 traecli 登录状态。
 * 只返回状态枚举：'logged_in' | 'not_logged_in' | 'unknown'，绝不含任何凭据。
 */
export async function traecliLoginStatus(traecliPath) {
  const res = await runCaptured(traecliPath, ['login', 'status'], {});
  const output = `${res.stdout}\n${res.stderr}`.trim();
  if (/not logged in/i.test(output)) return { status: 'not_logged_in', raw: 'not_logged_in' };
  if (/logged in/i.test(output)) return { status: 'logged_in', raw: 'logged_in' };
  // 某些版本可能返回 JSON
  try {
    const parsed = JSON.parse(output);
    const s = String(parsed.status || parsed.loggedIn || parsed.authenticated || '').toLowerCase();
    if (s.includes('logged')) return { status: s.includes('not') ? 'not_logged_in' : 'logged_in', raw: output };
  } catch {
    /* fallthrough */
  }
  return { status: res.ok ? 'unknown' : 'unknown', raw: output };
}

/** 校验 workspace：存在、是目录、是 Git 工作区。返回 { ok } 或 { ok:false, status, reason }。 */
export async function validateWorkspace(workspacePath) {
  if (!existsSync(workspacePath)) {
    return { ok: false, status: 'BLOCKED', reason: `workspace 不存在: ${workspacePath}` };
  }
  let st;
  try {
    st = statSync(workspacePath);
  } catch {
    return { ok: false, status: 'BLOCKED', reason: `无法读取 workspace: ${workspacePath}` };
  }
  if (!st.isDirectory()) {
    return { ok: false, status: 'BLOCKED', reason: 'workspace 必须是目录' };
  }
  const git = await runCaptured('git', ['-C', workspacePath, 'rev-parse', '--is-inside-work-tree'], {});
  if (!git.ok || git.stdout.trim() !== 'true') {
    return {
      ok: false,
      status: 'BLOCKED',
      reason: '当前仅支持 Git 工作区（非 Git 项目 fail closed，不做全目录复制）',
    };
  }
  return { ok: true };
}

/** 读取 Git 上下文：head/branch/dirty。全部只读。 */
export async function gitContext(workspacePath) {
  const head = await runCaptured('git', ['-C', workspacePath, 'rev-parse', 'HEAD'], {});
  const branch = await runCaptured('git', ['-C', workspacePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {});
  const dirty = await runCaptured('git', ['-C', workspacePath, 'status', '--porcelain'], {});
  return {
    gitHead: head.ok ? head.stdout.trim() : '',
    branch: branch.ok ? branch.stdout.trim() : '',
    dirty: dirty.ok && dirty.stdout.trim().length > 0,
    basename: basename(workspacePath),
  };
}

export async function collectEnvironment(traecliPath) {
  const nodeRes = await runCaptured('node', ['--version'], {});
  const gitRes = await runCaptured('git', ['--version'], {});
  const trae = traecliPath ? await traecliVersion(traecliPath) : { ok: false, version: null };
  const login = traecliPath ? await traecliLoginStatus(traecliPath) : { status: 'unknown' };
  return {
    os: `${process.platform} ${process.arch}`,
    node: nodeRes.ok ? nodeRes.stdout.trim() : '',
    git: gitRes.ok ? gitRes.stdout.trim() : '',
    traecli_version: trae.ok ? trae.version : null,
    trae_login_status: login.status,
  };
}

/**
 * 轻量捕获命令输出。禁止 shell；参数数组。
 * 所有 Trae/命令探测都必须走这里，避免字符串拼接注入。
 * 使用同步 spawnSync：探测类调用均为短时只读命令，天然避免并发竞态。
 */
export async function runCaptured(bin, args, { timeoutMs = 15000 } = {}) {
  const child = spawnSync(bin, args, {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  return {
    ok: child.status === 0,
    code: child.status,
    signal: child.signal,
    stdout: child.stdout || '',
    stderr: child.stderr || '',
    error: child.error ? String(child.error) : null,
  };
}
