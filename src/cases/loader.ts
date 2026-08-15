// 用例加载器：统一从文件/目录加载用例定义
// 支持两种载体：*.json（直接解析）与 *.js（TS 编译产物，动态 import，取 default 导出）
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { TaskDef } from '../core/types.js';

/** 加载结果：含用例名与来源文件 */
export interface LoadedCase {
  name: string;
  file: string;
  def: TaskDef;
}

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

/**
 * 加载用例。
 * @param arg 任务定义路径（文件或目录）。目录会递归同层收集 *.json 与 *.js（跳过 _ 前缀）。
 * @returns 加载到的用例列表（单文件通常为 1 个）
 */
export async function loadCases(arg: string): Promise<LoadedCase[]> {
  const p = path.resolve(process.cwd(), arg);
  if (!fs.existsSync(p)) throw new Error(`任务定义不存在：${p}`);

  const stat = fs.statSync(p);
  const files: string[] = [];
  if (stat.isDirectory()) {
    files.push(
      ...fs
        .readdirSync(p)
        .filter((f) => /\.(json|js)$/.test(f) && !f.startsWith('_'))
        .sort()
        .map((f) => path.join(p, f)),
    );
    if (!files.length) throw new Error(`目录中未找到用例文件：${p}`);
  } else {
    files.push(p);
  }

  const out: LoadedCase[] = [];
  for (const f of files) {
    const ext = path.extname(f).toLowerCase();
    if (ext === '.json') out.push(loadJsonFile(f));
    else if (ext === '.js') out.push(await loadModuleFile(f));
    else throw new Error(`不支持的用例格式：${ext}（支持 .json / .js）`);
  }
  return out;
}
