/**
 * agent provenance 数据模型与计算。
 *
 * 以「当前已安装 agent 包的 npm resolved Git 信息」为 Git 安装 provenance 的主要可信来源：
 *   - git 安装（npm 元数据含完整 40 位 resolved SHA）→ VERIFIED；
 *   - 本地源码 checkout（agent 自身 Git 仓库 HEAD）→ local-checkout / DECLARED；
 *   - 本地 tgz / 无可靠来源 → local-package / UNKNOWN。
 *
 * 绝不用 `--workspace` 被测目录的 HEAD 填 agent provenance。
 */
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const PROVENANCE_STATUS = ['VERIFIED', 'DECLARED', 'UNKNOWN', 'MISMATCH'];

const SHA40 = /^[0-9a-f]{40}$/;

/**
 * 从 npm 安装元数据 / 环境变量读取 resolved Git 来源（只读自身安装上下文）。
 * 返回 { spec, commit } 或 null。不扫描用户主目录、不读凭据。
 */
export function readResolvedSource(pkgDir, startDir = null) {
  // 1) 环境变量（npm 在部分安装/生命周期场景注入）
  if (typeof process.env.npm_package_resolved === 'string') {
    const parsed = parseGitResolved(process.env.npm_package_resolved);
    if (parsed) return parsed;
  }

  // 2) 向上查找 node_modules/.package-lock.json / package-lock.json（有界，限制在安装上下文）
  let dir = startDir ? resolve(startDir) : resolve(pkgDir);
  for (let i = 0; i < 8; i += 1) {
    for (const name of ['node_modules/.package-lock.json', 'package-lock.json']) {
      const lockPath = join(dir, name);
      try {
        if (!existsSync(lockPath)) continue;
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        const found = scanLockForResolved(lock);
        if (found) return found;
      } catch {
        continue;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** 从 npm lock 结构中提取首个 git 类型 resolved。 */
function scanLockForResolved(lock) {
  const packages = (lock && lock.packages) || {};
  for (const key of Object.keys(packages)) {
    const rec = packages[key] || {};
    if (typeof rec.resolved === 'string') {
      const parsed = parseGitResolved(rec.resolved);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** 解析 "git+...#<40hex>" / "git+ssh://...#<40hex>"。返回 { spec, commit } 或 null。 */
export function parseGitResolved(value) {
  if (typeof value !== 'string') return null;
  const hash = value.indexOf('#');
  if (hash === -1) return null;
  const commit = value.slice(hash + 1).trim();
  if (!SHA40.test(commit)) return null;
  const spec = value.slice(0, hash);
  if (!/^git\+/.test(spec) && !/^git@|\.git$|^ssh:|^https?:\/\//.test(spec)) return null;
  return { spec, commit };
}

/** 脱敏 source spec：移除 userinfo（用户名/密码/Token）、query、fragment。 */
export function sanitizeSourceSpec(spec) {
  if (typeof spec !== 'string') return spec;
  const noFragment = spec.split('#')[0];
  const m = noFragment.match(/^(git\+)(.+)$/);
  const prefix = m ? m[1] : '';
  const core = m ? m[2] : noFragment;
  try {
    // 归一化 scp-like：git@host:path -> ssh://git@host/path
    const normalized = core.replace(/^git@([^:]+):/, 'ssh://git@$1/');
    const url = new URL(normalized.startsWith('git@') ? `ssh://${normalized}` : normalized);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return prefix + url.toString().replace(/\/$/, '');
  } catch {
    // 无法解析为 URL：保守去掉 # 之后与 //userinfo@
    let s = noFragment;
    s = s.replace(/\/\/[^@/]+@/, '//');
    return prefix + s;
  }
}

/** 从 agent 自身目录的 Git 仓库读取 HEAD（40 位 hex），绝不读取 --workspace。 */
export function readAgentGitHead(pkgDir) {
  try {
    const head = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return SHA40.test(head) ? head : null;
  } catch {
    return null;
  }
}

/**
 * 计算 provenance。
 * @param {{ agentVersion:string, distributionSource:string, pkgDir:string }} input
 */
export function computeProvenance({ agentVersion, distributionSource, pkgDir }) {
  const resolved = readResolvedSource(pkgDir);

  if (resolved && resolved.commit) {
    // Git 安装：以 npm resolved SHA 为可信来源
    return {
      source: sanitizeSourceSpec(resolved.spec),
      source_spec: 'git',
      source_commit_or_tag: resolved.commit,
      provenance_status: 'VERIFIED',
      provenance_detail: null,
      version: agentVersion,
    };
  }

  const agentHead = readAgentGitHead(pkgDir);
  if (agentHead) {
    // 本地源码 checkout：agent 自身 Git 仓库 HEAD（声明但未经安装元数据交叉验证）
    return {
      source: 'local-checkout',
      source_spec: 'local-checkout',
      source_commit_or_tag: agentHead,
      provenance_status: 'DECLARED',
      provenance_detail: null,
      version: agentVersion,
    };
  }

  // 本地 tgz / 无可靠来源
  return {
    source: 'local-package',
    source_spec: 'local-package',
    source_commit_or_tag: null,
    provenance_status: 'UNKNOWN',
    provenance_detail: null,
    version: agentVersion,
  };
}