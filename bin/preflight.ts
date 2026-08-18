#!/usr/bin/env node
// Agent Preflight（Phase 20.8）：上线前环境自检
// 检查项：
//   1. Node 版本 ≥ 20.11
//   2. 构建产物存在（dist/bin/run-agent.js 等）
//   3. 配置可加载（test / preonline 环境校验通过）
//   4. 敏感信息检查（API Key / 密钥硬编码扫描，跳过 node_modules/dist）
//   5. 输出目录可写（TESTFLOW_OUTPUT_DIR 或默认）
//   6. 生产环境策略（production 默认关闭）
// 用法：node dist/bin/preflight.js [--json]
// 退出码：0 全部通过；1 存在阻断项（WARN 不阻断）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../src/config/config.js';
import {
  describeEnvironmentPolicy,
  guardProductionAction,
} from '../src/config/environment-policy.js';
import { ensureDir } from '../src/utils/fs-utils.js';

interface CheckResult {
  name: string;
  ok: boolean;
  level: 'PASS' | 'WARN' | 'BLOCK';
  detail: string;
}

// 编译后位于 dist/bin/preflight.js：dirname(..) = dist，需再上溯一级到项目根
const SELF_DIR = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.basename(SELF_DIR) === 'bin' && path.basename(path.dirname(SELF_DIR)) === 'dist'
  ? path.resolve(SELF_DIR, '..', '..')
  : path.resolve(SELF_DIR, '..');
const MIN_NODE = { major: 20, minor: 11 };

function checkNodeVersion(): CheckResult {
  const [major, minor] = process.versions.node.split('.').map(Number);
  const ok = major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
  return {
    name: 'Node 版本',
    ok,
    level: ok ? 'PASS' : 'BLOCK',
    detail: `${process.versions.node}（要求 ≥ ${MIN_NODE.major}.${MIN_NODE.minor}）`,
  };
}

function checkBuild(): CheckResult {
  const required = ['dist/bin/run-agent.js', 'dist/bin/run-test.js'];
  const missing = required.filter((p) => !fs.existsSync(path.join(ROOT, p)));
  const ok = missing.length === 0;
  return {
    name: '构建产物',
    ok,
    level: ok ? 'PASS' : 'BLOCK',
    detail: missing.length ? `缺失：${missing.join('、')}（请先 npm run build）` : 'dist 产物完整',
  };
}

function checkConfig(): CheckResult {
  const errors: string[] = [];
  for (const env of ['test', 'preonline']) {
    try {
      loadConfig(env);
    } catch (e) {
      errors.push(`${env}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  const ok = errors.length === 0;
  return {
    name: '环境配置',
    ok,
    level: ok ? 'PASS' : 'BLOCK',
    detail: ok ? 'test / preonline 配置加载校验通过' : errors.join('；'),
  };
}

/** 敏感信息扫描：跳过 node_modules / dist / .git / output / package-lock */
const SECRET_PATTERNS = [
  /api[_-]?key\s*[:=]\s*["'][A-Za-z0-9_\-]{16,}["']/i,
  /\bAKIA[0-9A-Z]{16}\b/, // AWS Access Key
  /\bsk-[A-Za-z0-9]{20,}\b/, // OpenAI 风格 key
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];
const SECRET_SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'output', 'coverage', 'security-reports', '.trae']);

function scanSecrets(dir: string, hits: string[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (!SECRET_SKIP_DIRS.has(e.name)) scanSecrets(path.join(dir, e.name), hits);
      continue;
    }
    if (!/\.(ts|js|mjs|tsx|json|sh|yml|yaml|toml|env)$/.test(e.name)) continue;
    const file = path.join(dir, e.name);
    try {
      const content = fs.readFileSync(file, 'utf-8');
      for (const p of SECRET_PATTERNS) {
        if (p.test(content)) {
          hits.push(`${path.relative(ROOT, file)} 命中 ${p}`);
          break;
        }
      }
    } catch {
      // 忽略不可读文件
    }
  }
}

function checkSecrets(): CheckResult {
  const hits: string[] = [];
  for (const dir of ['src', 'bin', 'scripts', 'config', 'tasks', 'tests']) {
    const p = path.join(ROOT, dir);
    if (fs.existsSync(p)) scanSecrets(p, hits);
  }
  const ok = hits.length === 0;
  return {
    name: '敏感信息扫描',
    ok,
    level: ok ? 'PASS' : 'BLOCK',
    detail: ok ? '未发现硬编码密钥/API Key' : hits.slice(0, 5).join('；'),
  };
}

function checkOutputDir(): CheckResult {
  const dir = process.env.TESTFLOW_OUTPUT_DIR || path.join(ROOT, 'output');
  try {
    ensureDir(dir);
    const probe = path.join(dir, `.preflight-${Date.now()}`);
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
    return { name: '输出目录', ok: true, level: 'PASS', detail: `${dir} 可写` };
  } catch (e) {
    return { name: '输出目录', ok: false, level: 'WARN', detail: `${dir} 不可写：${(e as Error).message}` };
  }
}

function checkProductionPolicy(): CheckResult {
  const policy = describeEnvironmentPolicy();
  const prod = guardProductionAction('production', 'read-only');
  const ok = !policy.productionEnabled;
  return {
    name: '生产环境策略',
    ok: true, // 仅为提示，不阻断
    level: ok ? 'PASS' : 'WARN',
    detail: ok
      ? `production 默认关闭（危险动作：${policy.forbidden.slice(0, 3).join('、')} 等）`
      : 'TESTFLOW_ALLOW_PRODUCTION=true 已设置（高风险，请确认意图）',
  };
}

export function runPreflight(): CheckResult[] {
  return [
    checkNodeVersion(),
    checkBuild(),
    checkConfig(),
    checkSecrets(),
    checkOutputDir(),
    checkProductionPolicy(),
  ];
}

const isMain = !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const results = runPreflight();
  const blocks = results.filter((r) => !r.ok && r.level === 'BLOCK');
  const warns = results.filter((r) => !r.ok && r.level === 'WARN');
  const json = process.argv.includes('--json');

  if (json) {
    console.log(JSON.stringify({ ok: blocks.length === 0, checks: results, summary: `PASS ${results.length - blocks.length - warns.length} / WARN ${warns.length} / BLOCK ${blocks.length}` }, null, 2));
  } else {
    console.log('════════ Agent Preflight ════════');
    for (const r of results) {
      const icon = r.level === 'PASS' ? '✅' : r.level === 'WARN' ? '⚠️' : '❌';
      console.log(`  ${icon} [${r.level}] ${r.name}：${r.detail}`);
    }
    console.log(`结果：PASS ${results.length - blocks.length - warns.length} / WARN ${warns.length} / BLOCK ${blocks.length}`);
    console.log('══════════════════════════════');
  }
  process.exit(blocks.length ? 1 : 0);
}
