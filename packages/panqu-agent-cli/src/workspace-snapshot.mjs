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
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename, resolve, sep, dirname, normalize } from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';

export const SNAPSHOT_PREFIX = 'panqu-snapshot-';

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
 * 创建快照。
 * @returns {{ ok:true, snapshotRoot, worktree, excluded:Array<{path,reason}> }
 *        | { ok:false, status:'BLOCKED'|'ERROR', reason }}
 */
export function createSnapshot(workspacePath, { maxUntrackedBytes = DEFAULT_MAX_UNTracked_FILE_BYTES, snapshotRoot = null } = {}) {
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
    const apply = spawnSync('git', ['apply', '--binary', '--whitespace=nowarn', '-'], {
      cwd: worktree,
      input: patch,
      encoding: 'utf8',
    });
    if (apply.status !== 0) {
      return {
        ok: false,
        status: 'BLOCKED',
        reason: `快照内应用工作区补丁失败: ${String(apply.stderr || '').trim() || '未知原因'}`,
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
