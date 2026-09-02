/**
 * 项目发现：包管理器检测 + package.json 脚本发现 + 检查规划。
 *
 * - 多种互相冲突的 lockfile → BLOCKED
 * - 没有受支持 manifest（package.json）→ BLOCKED
 * - 只接受白名单脚本名（typecheck / lint / test / build）
 * - 缺失脚本记为 SKIPPED，绝不伪造成功
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const SUPPORTED_SCRIPT_NAMES = ['typecheck', 'lint', 'test', 'build'];

export function detectPackageManager(snapshotPath) {
  const has = (name) => existsSync(join(snapshotPath, name));
  const pnpm = has('pnpm-lock.yaml');
  const yarn = has('yarn.lock');
  const npm = has('package-lock.json');
  const hasManifest = has('package.json');

  if (!hasManifest) {
    return { ok: false, status: 'BLOCKED', manager: null, reason: '没有受支持的 manifest（package.json），fail closed' };
  }
  const found = [];
  if (pnpm) found.push('pnpm');
  if (yarn) found.push('yarn');
  if (npm) found.push('npm');

  if (found.length > 1) {
    return {
      ok: false,
      status: 'BLOCKED',
      manager: null,
      reason: `检测到多个互相冲突的 lockfile（${found.join(', ')}），fail closed`,
    };
  }
  if (found.length === 1) {
    return { ok: true, status: 'READY', manager: found[0], hasLockfile: true };
  }
  // 无 lockfile：退回 npm（最常见），并注明。
  return { ok: true, status: 'READY', manager: 'npm', hasLockfile: false };
}

export function readPackageJson(snapshotPath) {
  const p = join(snapshotPath, 'package.json');
  if (!existsSync(p)) return { ok: false, reason: 'package.json 不存在' };
  try {
    const raw = readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return { ok: false, reason: 'package.json 不是合法对象' };
    }
    return { ok: true, data };
  } catch (err) {
    return { ok: false, reason: `package.json 解析失败: ${String(err)}` };
  }
}

export function hasDependencyDeclared(pkgJson) {
  const deps = pkgJson.dependencies || {};
  const devDeps = pkgJson.devDependencies || {};
  return Object.keys(deps).length > 0 || Object.keys(devDeps).length > 0;
}

export function hasNodeModules(snapshotPath) {
  try {
    return existsSync(join(snapshotPath, 'node_modules')) && statSync(join(snapshotPath, 'node_modules')).isDirectory();
  } catch {
    return false;
  }
}

/** 依赖已声明但（快照内）无 node_modules 时的阻塞原因；否则返回 null（fail closed）。 */
export function dependencyBlockReason(depsDeclared, nodeModulesPresent) {
  if (depsDeclared && !nodeModulesPresent) {
    return '依赖已声明但 node_modules 缺失；请先人工安装依赖（npm install / npm ci / pnpm install / yarn install），本工具不自动安装';
  }
  return null;
}

/**
 * 规划检查。
 * @param requested 白名单内的 check 名数组
 * @param pkgScripts package.json.scripts（对象）
 * @returns Array<{name, scriptName, status:'RUNNABLE'|'SKIPPED', reason?}>
 */
export function planChecks(requested, pkgScripts) {
  const scripts = pkgScripts && typeof pkgScripts === 'object' ? pkgScripts : {};
  const plan = [];
  for (const name of requested) {
    const script = typeof scripts[name] === 'string' && scripts[name].trim() ? scripts[name].trim() : null;
    if (script === null) {
      plan.push({ name, scriptName: null, status: 'SKIPPED', reason: `package.json 中不存在脚本 "${name}"` });
    } else {
      plan.push({ name, scriptName: name, status: 'RUNNABLE' });
    }
  }
  return plan;
}
