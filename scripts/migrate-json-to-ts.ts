#!/usr/bin/env node
// 存量 JSON 用例 → 类型安全 TS 用例 迁移脚本（幂等）
// ---------------------------------------------------------------------------
// 用法：
//   node scripts/migrate-json-to-ts.ts                     # 读 tasks/*.json → 输出 src/cases/tasks/*.ts（跳过已有）
//   node scripts/migrate-json-to-ts.ts --dir tasks --out src/cases/tasks --force
//   node scripts/migrate-json-to-ts.ts --dry-run           # 只打印将要生成的文件内容，不写入
//   node scripts/migrate-json-to-ts.ts --camel             # 对非 TaskDef 已知键做 snake_case → camelCase
//
// 设计约束：
//   1. 幂等：目标 .ts 已存在且未加 --force 时跳过，重复运行不会重复生成。
//   2. 保留字段：引擎按 TaskDef 键名读取（name/model_id/task_type/extra/...），
//      这些键名一律原样保留；请求体（extra 等）内容原样保留。
//      仅当开启 --camel 时，对「非 TaskDef 已知键」的顶层键做 snake→camel。
//   3. 不推断动态值：Date.now() 等一律不生成，保留 JSON 中的硬编码字符串。
//   4. 生成的 .ts 头部包含 /* eslint-disable */ 与 @ts-ignore 注释模板。
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ── 引擎 TaskDef 已知键：保证兼容性，永不转换/映射 ──
const TASKDEF_KEYS = new Set([
  'name', 'scene', 'scene_detail', 'type', 'model_id', 'model_name',
  'task_type', 'task_id', 'selmodelsId', 'extra', 'expected_points',
  'uploads', 'manual_cases',
]);

// ── CLI 参数解析 ──
interface CliOpts {
  dir: string;
  out: string;
  force: boolean;
  dryRun: boolean;
  camel: boolean;
}

function parseArgs(argv: string[]): CliOpts {
  const o: CliOpts = { dir: 'tasks', out: 'src/cases/tasks', force: false, dryRun: false, camel: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dir') o.dir = argv[++i] ?? o.dir;
    else if (a === '--out') o.out = argv[++i] ?? o.out;
    else if (a === '--force') o.force = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--camel') o.camel = true;
    else if (a === '--help') {
      console.log(`用法：
  node scripts/migrate-json-to-ts.ts [--dir <JSON目录>] [--out <TS输出目录>] [--force] [--dry-run] [--camel]
  --dir       JSON 用例目录，默认 tasks
  --out       TS 输出目录，默认 src/cases/tasks
  --force     覆盖已存在的 .ts（默认跳过，保证幂等）
  --dry-run   只打印将生成的文件内容，不写入
  --camel     对非 TaskDef 已知键做 snake_case → camelCase（请求体内容始终原样）`);
      process.exit(0);
    }
  }
  return o;
}

// ── 工具函数 ──
function toCamel(s: string): string {
  return s.replace(/_+([a-zA-Z0-9])/g, (_, c) => c.toUpperCase());
}

/** 合法标识符原样输出，否则加引号 */
function serializeKey(k: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

/** 字符串字面量：优先单引号（贴近参考文件风格），转义反斜杠/单引号/换行 */
function serializeString(s: string): string {
  const escaped = s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r/g, '\\r').replace(/\n/g, '\\n').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return "'" + escaped + "'";
}

/** JSON 值 → 缩进友好的 TS 字面量 */
function serializeValue(v: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  const padIn = '  '.repeat(indent + 1);
  if (v === null) return 'null';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return serializeString(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return '[]';
    const items = v.map((x) => serializeValue(x, indent + 1));
    // 全部为单行标量时紧凑输出
    if (v.every((x) => x === null || ['string', 'number', 'boolean'].includes(typeof x))) {
      return '[' + v.map((x) => serializeValue(x, 0)).join(', ') + ']';
    }
    return '[\n' + items.map((x) => padIn + x).join(',\n') + '\n' + pad + ']';
  }
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return '{}';
    const lines = entries.map(([k, val]) => `${padIn}${serializeKey(k)}: ${serializeValue(val, indent + 1)}`);
    return '{\n' + lines.join(',\n') + '\n' + pad + '}';
  }
  return JSON.stringify(v);
}

/** 计算从输出目录到 src/cases/define.ts 的相对 import 路径（ESM 需 .js 后缀） */
function computeDefineImport(outAbs: string): string {
  const defineAbs = path.join(ROOT, 'src', 'cases', 'define.ts');
  let rel = path.relative(outAbs, defineAbs).replace(/\\/g, '/');
  rel = rel.replace(/\.ts$/, '.js');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

/** 生成单个 TS 用例文件内容 */
function buildTsContent(json: Record<string, unknown>, camel: boolean, outAbs: string): string {
  const entries = Object.entries(json);
  const lines: string[] = [];
  for (const [k, v] of entries) {
    const key = camel && !TASKDEF_KEYS.has(k) ? toCamel(k) : k;
    lines.push(`  ${serializeKey(key)}: ${serializeValue(v, 1)}`);
  }
  return [
    '/* eslint-disable */',
    '// 由 scripts/migrate-json-to-ts.ts 自动生成（幂等；源 JSON 见 tasks/ 对应文件）',
    '// @ts-ignore // 若因未导入类型导致报错，可取消本行注释（按需启用）',
    "import { defineCase } from '" + computeDefineImport(outAbs) + "';",
    '',
    'export default defineCase({',
    lines.join(',\n'),
    '});',
    '',
  ].join('\n');
}

// ── 主流程 ──
async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  const srcDir = path.resolve(ROOT, opts.dir);
  const outAbs = path.resolve(ROOT, opts.out);
  if (!fs.existsSync(srcDir)) {
    console.error(`[migrate] JSON 目录不存在：${srcDir}`);
    process.exit(1);
  }
  fs.mkdirSync(outAbs, { recursive: true });

  const files = fs
    .readdirSync(srcDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .sort();

  if (!files.length) {
    console.warn(`[migrate] 目录 ${srcDir} 下没有可迁移的 .json 文件（跳过 _ 前缀模板）`);
    process.exit(0);
  }

  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const f of files) {
    const jsonPath = path.join(srcDir, f);
    const tsName = f.replace(/\.json$/, '.ts');
    const tsPath = path.join(outAbs, tsName);

    if (fs.existsSync(tsPath) && !opts.force) {
      console.log(`[migrate] 跳过（已存在，幂等）：${tsName}`);
      skipped++;
      continue;
    }

    try {
      const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
      const content = buildTsContent(raw, opts.camel, outAbs);
      if (opts.dryRun) {
        console.log(`\n===== 将生成：${tsName} =====\n${content}`);
      } else {
        fs.writeFileSync(tsPath, content, 'utf-8');
        console.log(`[migrate] 已生成：${tsName}`);
      }
      converted++;
    } catch (e: any) {
      console.error(`[migrate] 失败：${f} - ${e.message}`);
      failed++;
    }
  }

  console.log(`\n[migrate] 完成：转换 ${converted} 个，跳过 ${skipped} 个，失败 ${failed} 个${opts.dryRun ? '（dry-run，未写入）' : ''}`);
  console.log(`[migrate] 输出目录：${outAbs}`);
}

main().catch((e) => {
  console.error('[migrate] 异常：', e);
  process.exit(1);
});
