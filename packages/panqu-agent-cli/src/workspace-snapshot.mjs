/**
 * Workspace 快照：把「可能含未提交修改」的 Git 工作区复制成隔离的临时快照，
 * 所有确定性检查 / Trae 分析都只发生在快照内，绝不触碰原始工作区。
 *
 * 流程（全部只读 / 快照内写）：
 *   1. mktemp 语义：fs.mkdtemp(os.tmpdir()/panqu-snapshot-)
 *   2. git worktree add --detach <snap>/wt HEAD
 *   3. git diff --binary HEAD 捕获已暂存+未暂存修改，应用到快照
 *   4. git ls-files --others --exclude-standard -z 枚举未跟踪文件，
 *      安全复制参与测试的源码（敏感/大文件/构建产物默认排除）
 */
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, existsSync, statSync, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve, sep, dirname, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyNodeModulesSafe } from './dependency-copy.mjs';

export const SNAPSHOT_PREFIX = 'panqu-snapshot-';

/** git apply 内部硬超时（毫秒）：正常大 diff 足够完成，同时保证快照步骤有界。 */
export const GIT_APPLY_TIMEOUT_MS = 30_000;

/** git apply stdout/stderr 捕获上限（字节）。 */
export const GIT_APPLY_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

/** 敏感路径段（任意层级命中即排除）。 */
const SENSITIVE_SEGMENTS = new Set([
  '.git', 'node_modules', 'coverage', 'dist', 'build',
  '.secrets', 'secrets', 'secret', 'credentials', 'tokens',
]);

const SENSITIVE_BASENAME = /^(\.env(\..*)?)$|\.(pem|key|p12|pfx|p8|ppk|jks|keystore|der)$/i;

const SENSITIVE_NAME = /(^|[-_.])(secret|credential|token|password|passwd|private[_-]?key|id_rsa|id_ed25519|id_dsa)([-_.]|$)/i;

export const DEFAULT_MAX_UNTracked_FILE_BYTES = 10 * 1024 * 1024;

function runGit(cwd, args) {
  const child = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return { ok: child.status === 0, code: child.status, stdout: child.stdout || '', stderr: child.stderr || '' };
}

/** 判断未跟踪相对路径是否应被排除。 */
export function isExcludedUntracked(relPath, { maxBytes = DEFAULT_MAX_UNTracked_FILE_BYTES } = {}) {
  const normalized = normalize(relPath);
  const segments = normalized.split(sep).filter(Boolean);
  for (const seg of segments) {
    if (SENSITIVE_SEGMENTS.has(seg)) return true;
  }
  const base = segments[segments.length - 1] || '';
  if (SENSITIVE_BASENAME.test(base)) return true;
  if (SENSITIVE_NAME.test(base)) return true;
  for (const seg of segments) {
    if (SENSITIVE_NAME.test(seg)) return true;
  }
  return false;
}

/**
 * 把 dirty patch 应用到快照 worktree。
 *
 * P0 修复（V12 事故：TTY 环境下 spawnSync({input}) 的同步 pump 让 `git apply -`
 * 永久等待 stdin，CLI 挂死且无清理）：
 *   - patch 先写入受管快照根内的 0600 临时文件，再把该文件的 fd 作为
 *     子进程 stdin 直接交给 `git apply -`；
 *   - EOF 由文件末尾结构性保证：快照 patch 步骤不再依赖父进程 stdin
 *     （TTY / pipe / 保持打开）的任何状态，也不会因同步 pump 停滞而死锁；
 *   - spawnSync timeout 兜底：超时向子进程发送 SIGTERM，快照步骤有界；
 *   - stdout/stderr 有限捕获；非零退出 / spawn 错误 / 超时一律 fail closed。
 *
 * @returns {{ ok:true } | { ok:false, code:'WORKSPACE_PATCH_FAILED'|'WORKSPACE_PATCH_TIMEOUT', reason:string }}
 */
function applyWorkspacePatch(worktree, patch, snapshotRoot, timeoutMs) {
  const patchPath = join(snapshotRoot, 'workspace.patch');
  let patchWriteFd = -1;
  let patchReadFd = -1;
  try {
    patchWriteFd = openSync(patchPath, 'w', 0o600);
    writeSync(patchWriteFd, Buffer.from(patch, 'utf8'));
  } finally {
    if (patchWriteFd >= 0) closeSync(patchWriteFd);
  }

  try {
    patchReadFd = openSync(patchPath, 'r');
    const apply = spawnSync('git', ['apply', '--binary', '--whitespace=nowarn', '-'], {
      cwd: worktree,
      // 子进程 stdin = patch 文件 fd（EOF 由文件末尾保证），stdout/stderr = 独立 pipe
      stdio: [patchReadFd, 'pipe', 'pipe'],
      shell: false,
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
      maxBuffer: GIT_APPLY_MAX_OUTPUT_BYTES,
      encoding: 'utf8',
    });

    if (apply.error && apply.error.code === 'ETIMEDOUT') {
      return {
        ok: false,
        code: 'WORKSPACE_PATCH_TIMEOUT',
        reason: `WORKSPACE_PATCH_TIMEOUT: git apply 超过 ${timeoutMs}ms，已发送 SIGTERM 终止`,
      };
    }
    if (apply.error) {
      return {
        ok: false,
        code: 'WORKSPACE_PATCH_FAILED',
        reason: `WORKSPACE_PATCH_FAILED: spawn git apply 失败: ${String(apply.error)}`,
      };
    }
    if (apply.status !== 0) {
      const detail = String(apply.stderr || apply.stdout || '').trim() || '未知原因';
      return {
        ok: false,
        code: 'WORKSPACE_PATCH_FAILED',
        reason: `WORKSPACE_PATCH_FAILED: 快照内应用工作区补丁失败(exit=${apply.status} signal=${apply.signal ?? '-'}): ${detail}`,
      };
    }
    return { ok: true };
  } finally {
    if (patchReadFd >= 0) closeSync(patchReadFd);
    try {
      unlinkSync(patchPath);
    } catch {
      /* patch 文件清理失败不影响结果判定 */
    }
  }
}

/**
 * 创建快照。
 * @param {object} [options]
 * @param {number} [options.maxUntrackedBytes] 未跟踪文件大小上限
 * @param {string|null} [options.snapshotRoot] 指定快照根（默认 mkdtemp）
 * @param {number} [options.gitApplyTimeoutMs] git apply 硬超时（仅内部/测试注入，不暴露 CLI 参数）
 * @returns {{ ok:true, snapshotRoot, worktree, excluded:Array<{path,reason}> }
 *        | { ok:false, status:'BLOCKED'|'ERROR', reason }}
 */
export function createSnapshot(workspacePath, { maxUntrackedBytes = DEFAULT_MAX_UNTracked_FILE_BYTES, snapshotRoot = null, gitApplyTimeoutMs = GIT_APPLY_TIMEOUT_MS } = {}) {
  const root = snapshotRoot || mkdtempSync(join(tmpdir(), SNAPSHOT_PREFIX));
  const worktree = join(root, 'wt');

  // 1) detached worktree @ HEAD
  const add = runGit(workspacePath, ['worktree', 'add', '--detach', worktree, 'HEAD']);
  if (!add.ok) {
    return { ok: false, status: 'BLOCKED', reason: `无法创建隔离 worktree: ${add.stderr.trim() || add.stdout.trim()}` };
  }

  // 2) 捕获已暂存+未暂存修改，应用到快照
  const diff = runGit(workspacePath, ['diff', '--binary', 'HEAD']);
  const patch = diff.stdout;
  if (patch && patch.trim().length > 0) {
    const applied = applyWorkspacePatch(worktree, patch, root, gitApplyTimeoutMs);
    if (!applied.ok) {
      // 失败即清理本次已创建的部分快照（worktree remove + 受管快照根删除），不留残留
      cleanupSnapshot({ snapshotRoot: root, worktree, workspacePath });
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `快照内应用工作区补丁失败: ${applied.reason}`,
      };
    }
  }

  // 3) 未跟踪文件：枚举 + 过滤 + 安全复制
  const ls = runGit(workspacePath, ['ls-files', '--others', '--exclude-standard', '-z']);
  const excluded = [];
  if (ls.ok && ls.stdout.length > 0) {
    const untracked = ls.stdout.split('\0').filter((p) => p.length > 0);
    for (const rel of untracked) {
      const reason = isExcludedUntracked(rel, { maxBytes: maxUntrackedBytes }) ? 'sensitive_or_artifact' : null;
      if (reason === 'sensitive_or_artifact') {
        // 细粒度原因
        let detail = '排除规则命中';
        const base = basename(rel);
        if (SENSITIVE_BASENAME.test(base)) detail = '敏感文件（.env/私钥/证书）';
        else if (SENSITIVE_NAME.test(base)) detail = '敏感文件名（secret/token/credential 等）';
        else detail = '排除目录（.git/node_modules/coverage/dist/build）或超大小';
        excluded.push({ path: rel, reason: detail });
        continue;
      }
      const src = resolve(workspacePath, rel);
      const dst = resolve(worktree, rel);
      if (!isWithin(dst, worktree)) {
        excluded.push({ path: rel, reason: '路径逃逸，拒绝复制' });
        continue;
      }
      let st;
      try {
        st = statSync(src);
      } catch {
        excluded.push({ path: rel, reason: '读取失败，跳过' });
        continue;
      }
      if (!st.isFile()) {
        excluded.push({ path: rel, reason: '非普通文件（symlink/设备），跳过' });
        continue;
      }
      if (st.size > maxUntrackedBytes) {
        excluded.push({ path: rel, reason: `超过大小上限 ${maxUntrackedBytes} 字节` });
        continue;
      }
      try {
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(src, dst);
      } catch (err) {
        excluded.push({ path: rel, reason: `复制失败: ${String(err)}` });
      }
    }
  }

  // 4) 隔离复用被测项目已安装的 node_modules：安全依赖复制（普通文件递归复制 + symlink 安全映射 + 二次验证）。
  //    任何不安全/逃逸链接或特殊文件 → 整块拒绝，不提供 node_modules，下游按「依赖缺失」fail closed。
  const srcNodeModules = join(workspacePath, 'node_modules');
  if (existsSync(srcNodeModules)) {
    copyNodeModulesSafe({
      srcNodeModules,
      workspaceRoot: workspacePath,
      snapshotRoot: worktree,
    });
  }

  const head = runGit(worktree, ['rev-parse', 'HEAD']);
  return {
    ok: true,
    snapshotRoot: root,
    worktree,
    workspacePath,
    gitHeadSnapshot: head.ok ? head.stdout.trim() : '',
    excluded,
  };
}

function isWithin(child, parent) {
  const rel = resolve(child);
  const par = resolve(parent);
  return rel === par || rel.startsWith(par + sep);
}

/** 校验路径是否为「本工具创建的」快照根，防止误删用户目录。 */
export function isManagedSnapshotRoot(path) {
  const abs = resolve(path);
  const tmp = resolve(tmpdir());
  if (!abs.startsWith(tmp + sep)) return false;
  return basename(abs).startsWith(SNAPSHOT_PREFIX);
}

/**
 * 清理快照。仅清理本次创建且经过路径验证的临时目录。
 * worktree 通过 `git -C <原仓库> worktree remove`（精准），根目录由 basename 前缀校验后删除。
 */
export function cleanupSnapshot({ snapshotRoot, worktree, workspacePath }) {
  const steps = [];
  const errors = [];

  if (worktree) {
    const wtAbs = resolve(worktree);
    if (wtAbs === join(resolve(snapshotRoot), 'wt')) {
      // git worktree remove 必须在原仓库上下文内执行（快照根本身不是仓库）
      const repoDir = workspacePath ? resolve(workspacePath) : resolve(snapshotRoot);
      const rm = runGit(repoDir, ['worktree', 'remove', '--force', wtAbs]);
      if (rm.ok) steps.push('git worktree remove --force <snapshot>/wt');
      else {
        // git worktree remove 失败时记录错误，但不要递归删除用户目录
        errors.push(`git worktree remove 失败: ${rm.stderr.trim()}`);
      }
      // 兜底 prune：清理失效的 worktree 注册（§八.2），best-effort
      runGit(repoDir, ['worktree', 'prune']);
    } else {
      errors.push('worktree 路径与快照根不匹配，跳过清理');
    }
  }

  if (snapshotRoot) {
    if (isManagedSnapshotRoot(snapshotRoot)) {
      try {
        rmSync(snapshotRoot, { recursive: true, force: true });
        steps.push(`rm -rf ${snapshotRoot}（已校验为受管快照根）`);
      } catch (err) {
        errors.push(`删除快照根失败: ${String(err)}`);
      }
    } else {
      errors.push('快照根不在受管前缀下，拒绝删除');
    }
  }

  return { cleaned: steps, errors };
}

/** 生成报告用的快照 ID（短随机，用于报告内引用）。 */
export function snapshotId() {
  return `snap-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
}
