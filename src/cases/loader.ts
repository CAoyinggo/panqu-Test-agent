// 用例加载器：统一从文件/目录加载用例定义（多功能模块化）
// 支持两种载体：*.json（直接解析）与 *.js/*.ts（TS 编译产物，动态 import，取 default 导出）
// 目录结构约定：src/cases/<feature>/<name>.ts —— 每个子文件夹 = 一个功能模块
//   --task src/cases          递归扫描全部功能模块（全量执行）
//   --task src/cases/wan3     递归扫描单个功能模块
//   --task tasks/xxx.json     单文件（向后兼容）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskDef } from '../core/types.js';

/** 加载结果：含用例名、来源文件与所属功能模块 */
export interface LoadedCase {
  name: string;
  file: string;
  feature?: string; // 所属功能模块（子文件夹名），单文件模式为空
  def: TaskDef;
}

/** 加载配置 */
export interface LoadCasesOptions {
  /** 忽略的子文件夹名（如公共目录 common/ base/），默认 ['common', 'base'] */
  ignore?: string[];
}

const DEFAULT_IGNORE = ['common', 'base', 'shared'];

function loadJsonFile(file: string): LoadedCase {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as TaskDef;
  return { name: raw.name || path.basename(file), file, def: raw };
}

async function loadModuleFile(file: string): Promise<LoadedCase> {
  const mod: any = await import(pathToFileURL(file).href);
  // 兼容 default 导出 / defineCase 命名导出 / case 命名导出
  const def: TaskDef | undefined = mod.default ?? mod.defineCase ?? mod.case;
  if (!def) throw new Error(`用例脚本缺少导出：${file}（需 default 导出）`);
  return { name: def.name || path.basename(file), file, def };
}

/** 递归收集目录下全部 *.json / *.js / *.ts（排除 *.d.ts 声明文件；跳过 _ 前缀文件与 ignore 子目录） */
function collectFiles(dir: string, ignore: Set<string>, collectRootFiles: boolean): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (ignore.has(entry.name)) continue;
      out.push(...collectFiles(full, ignore, true));
    } else if (collectRootFiles && /\.(json|js|ts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 判定目录是否为「用例根目录」：存在 define.ts/loader.ts 等基础设施文件时，
 * 只递归各功能子文件夹，跳过根级基础文件（避免把 define/loader/registry 当作用例加载）。
 */
function isCasesRoot(dir: string): boolean {
  return ['define.ts', 'define.js', 'loader.ts', 'loader.js', 'registry.ts', 'registry.js'].some(
    (f) => fs.existsSync(path.join(dir, f)),
  );
}

/** 推断文件所属功能模块：相对根目录的第一级子文件夹名 */
function inferFeature(rootAbs: string, file: string): string | undefined {
  const rel = path.relative(rootAbs, file);
  const seg = rel.split(path.sep);
  return seg.length > 1 && seg[0] !== '.' ? seg[0] : undefined;
}

/**
 * 源码路径 → dist 编译产物路径映射。
 * Node 加载源码 .ts 时，其内部 `import '../define.js'`（源码下实为 define.ts）无法解析扩展名，
 * 因此当传入 `src/` 下路径且对应 `dist/src/` 编译产物存在时，自动改从 dist 加载。
 * 若 dist 不存在（未编译），原样返回源码路径。
 */
function resolveBuildPath(p: string): string {
  const root = path.resolve(process.cwd());
  const srcMarker = path.join(root, 'src') + path.sep;
  if (p.startsWith(srcMarker)) {
    const rel = p.slice(srcMarker.length); // 如 'cases' 或 'cases/wan3'
    const distP = path.join(root, 'dist', 'src', rel);
    if (fs.existsSync(distP)) return distP;
  }
  return p;
}

/**
 * 加载用例。
 * @param arg 任务定义路径（文件或目录）。
 *   - 目录：递归收集全部子目录的 *.json/*.js/*.ts（跳过 ignore 与 _ 前缀），每个子文件夹视为一个功能模块。
 *   - 文件：单文件加载（.json / .js / .ts 均可）。
 *   - 传入 `src/` 下路径时自动映射到 `dist/src/` 编译产物（需先 `npm run build`）。
 * @returns 加载到的用例列表
 */
export async function loadCases(arg: string, opts: LoadCasesOptions = {}): Promise<LoadedCase[]> {
  const p = resolveBuildPath(path.resolve(process.cwd(), arg));
  if (!fs.existsSync(p)) throw new Error(`任务定义不存在：${p}`);

  const stat = fs.statSync(p);
  const ignore = new Set(DEFAULT_IGNORE.concat(opts.ignore || []));
  let files: string[] = [];

  let isRoot = false;
  if (stat.isDirectory()) {
    isRoot = isCasesRoot(p);
    files = collectFiles(p, ignore, !isRoot).sort();
    if (!files.length) throw new Error(`目录中未找到用例文件：${p}`);
  } else {
    files.push(p);
  }

  const out: LoadedCase[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    let c: LoadedCase;
    if (ext === '.json') c = loadJsonFile(f);
    else if (ext === '.js' || ext === '.ts') c = await loadModuleFile(f);
    else throw new Error(`不支持的用例格式：${ext}（支持 .json / .js / .ts）`);
    if (stat.isDirectory()) {
      // 根目录：以子文件夹名作为功能模块；功能子目录：直接用目录名
      c.feature = isRoot ? inferFeature(p, f) : path.basename(p);
    }
    out.push(c);
  }
  return out;
}
