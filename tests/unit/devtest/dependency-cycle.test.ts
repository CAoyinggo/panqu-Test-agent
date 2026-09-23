import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 依赖拓扑与运行时依赖回环自动化核验套件
 *
 * 核心目标：
 * 1. 严格区分「真实运行时循环」与「纯 TypeScript 类型回环 (type-only)」
 * 2. 递归覆盖所有子目录（如 exploration/ 等）及跨目录相对路径解析
 * 3. 严格解析默认导入与具名导入混合场景，防止运行时导入被错误擦除
 * 4. 确保 src/devtest 所有模块在运行时依赖图（DAG）中回环数严格为 0
 * 5. 动态加载所有运行时模块与 dist 产物，强制要求 dist 存在，无 TDZ 异常
 * 6. 包含完备的检测器反例（Negative Tests），防止检测器自身漏检或失效
 *
 * @see docs/ARCHITECTURE_FREEZE.md
 */

export interface DependencyAnalysis {
  files: string[];
  runtimeGraph: Map<string, Set<string>>;
  fullGraph: Map<string, Set<string>>;
  typeOnlyEdges: Array<{ from: string; to: string }>;
  runtimeEdges: Array<{ from: string; to: string }>;
}

export function getAllTsFilesRecursively(dir: string, base = ''): string[] {
  let results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results = results.concat(getAllTsFilesRecursively(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      results.push(rel);
    }
  }
  return results;
}

export function getAllJsFilesRecursively(dir: string, base = ''): string[] {
  let results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const rel = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results = results.concat(getAllJsFilesRecursively(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      results.push(rel);
    }
  }
  return results;
}

export function resolveModuleSpecifier(
  sourceRelPath: string,
  modSpec: string,
  allFilesSet: Set<string>,
): string | null {
  if (!modSpec.startsWith('./') && !modSpec.startsWith('../')) {
    return null;
  }
  const sourceDir = path.posix.dirname(sourceRelPath);
  const normalized = path.posix.normalize(path.posix.join(sourceDir, modSpec.replace(/\.js$/, '')));

  if (allFilesSet.has(`${normalized}.ts`)) {
    return `${normalized}.ts`;
  }
  if (allFilesSet.has(`${normalized}/index.ts`)) {
    return `${normalized}/index.ts`;
  }
  return null;
}

export function analyzeDependencies(
  rootDir: string | null,
  virtualFiles: Record<string, string> | null = null,
): DependencyAnalysis {
  let files: string[];
  let getCode: (file: string) => string;

  if (virtualFiles) {
    files = Object.keys(virtualFiles);
    getCode = (file) => virtualFiles[file];
  } else {
    if (!rootDir) throw new Error('Either rootDir or virtualFiles must be provided');
    files = getAllTsFilesRecursively(rootDir);
    getCode = (file) => fs.readFileSync(path.join(rootDir, file), 'utf-8');
  }

  const allFilesSet = new Set(files);
  const runtimeGraph = new Map<string, Set<string>>();
  const fullGraph = new Map<string, Set<string>>();
  const typeOnlyEdges: Array<{ from: string; to: string }> = [];
  const runtimeEdges: Array<{ from: string; to: string }> = [];

  for (const f of files) {
    runtimeGraph.set(f, new Set());
    fullGraph.set(f, new Set());
  }

  for (const f of files) {
    const code = getCode(f);
    const sourceFile = ts.createSourceFile(f, code, ts.ScriptTarget.Latest, true);

    const runtimeSet = runtimeGraph.get(f)!;
    const fullSet = fullGraph.get(f)!;

    ts.forEachChild(sourceFile, (node) => {
      if (ts.isImportDeclaration(node)) {
        const modSpec = (node.moduleSpecifier as ts.StringLiteral).text;
        const target = resolveModuleSpecifier(f, modSpec, allFilesSet);
        if (!target) return;

        fullSet.add(target);

        // 1. 无 importClause: `import "./foo.js"` 属于带副作用的运行时导入
        if (!node.importClause) {
          runtimeSet.add(target);
          runtimeEdges.push({ from: f, to: target });
          return;
        }

        // 2. 语句级 import type: `import type { Foo } from "./foo.js"`
        if (node.importClause.isTypeOnly) {
          typeOnlyEdges.push({ from: f, to: target });
          return;
        }

        // 3. 检查默认导入: `import Foo from "./foo.js"` 或 `import Foo, { type Bar } from "./foo.js"`
        // 默认导入必定属于运行时值引入
        const hasDefaultImport = !!node.importClause.name;

        // 4. 检查具名绑定
        const namedBindings = node.importClause.namedBindings;
        let hasRuntimeNamed = false;
        let hasTypeOnlyNamed = false;

        if (namedBindings) {
          if (ts.isNamespaceImport(namedBindings)) {
            // `import * as Foo from "./foo.js"` 属于运行时导入
            hasRuntimeNamed = true;
          } else if (ts.isNamedImports(namedBindings)) {
            for (const el of namedBindings.elements) {
              if (el.isTypeOnly) {
                hasTypeOnlyNamed = true;
              } else {
                hasRuntimeNamed = true;
              }
            }
          }
        }

        // 综合判定：存在默认导入或任一具名运行时导入，均必须计入运行时依赖
        if (hasDefaultImport || hasRuntimeNamed || (!namedBindings && hasDefaultImport)) {
          runtimeSet.add(target);
          runtimeEdges.push({ from: f, to: target });
        } else if (hasTypeOnlyNamed) {
          typeOnlyEdges.push({ from: f, to: target });
        }
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
        const modSpec = (node.moduleSpecifier as ts.StringLiteral).text;
        const target = resolveModuleSpecifier(f, modSpec, allFilesSet);
        if (!target) return;

        fullSet.add(target);

        // 1. 语句级 export type: `export type { Foo } from "./foo.js"`
        if (node.isTypeOnly) {
          typeOnlyEdges.push({ from: f, to: target });
          return;
        }

        // 2. 无 exportClause: `export * from "./foo.js"` 属于运行时导出
        if (!node.exportClause) {
          runtimeSet.add(target);
          runtimeEdges.push({ from: f, to: target });
          return;
        }

        // 3. 命名空间导出: `export * as foo from "./foo.js"` 属于运行时导出
        if (ts.isNamespaceExport && ts.isNamespaceExport(node.exportClause)) {
          runtimeSet.add(target);
          runtimeEdges.push({ from: f, to: target });
          return;
        }

        // 4. 具名导出
        if (ts.isNamedExports(node.exportClause)) {
          let hasRuntime = false;
          let hasTypeOnly = false;
          for (const el of node.exportClause.elements) {
            if (el.isTypeOnly) {
              hasTypeOnly = true;
            } else {
              hasRuntime = true;
            }
          }
          if (hasRuntime) {
            runtimeSet.add(target);
            runtimeEdges.push({ from: f, to: target });
          } else if (hasTypeOnly) {
            typeOnlyEdges.push({ from: f, to: target });
          }
        }
      }
    });
  }

  return { files, runtimeGraph, fullGraph, typeOnlyEdges, runtimeEdges };
}

export function findCyclesInGraph(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const visited = new Set<string>();
  const stack: string[] = [];

  function dfs(node: string) {
    const idx = stack.indexOf(node);
    if (idx !== -1) {
      cycles.push(stack.slice(idx).concat(node));
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    for (const nxt of graph.get(node) || []) {
      dfs(nxt);
    }
    stack.pop();
  }

  for (const node of graph.keys()) {
    visited.clear();
    dfs(node);
  }
  return cycles;
}

describe('DevTest Dependency Graph & Runtime Cycle Verification', () => {
  const srcDevtestDir = path.resolve(__dirname, '../../../src/devtest');
  const distDevtestDir = path.resolve(__dirname, '../../../dist/src/devtest');
  const analysis = analyzeDependencies(srcDevtestDir);

  describe('1. 静态 AST 依赖图分析与递归回环检测', () => {
    it('[Cycle-AST-1] 递归扫描必须覆盖 src/devtest 及其全部子目录（如 exploration/ 等）', () => {
      expect(analysis.files.length).toBeGreaterThanOrEqual(28);
      expect(analysis.files).toContain('core-kernel.ts');
      expect(analysis.files).toContain('legacy-protocol-mappers.ts');
      expect(analysis.files).toContain('exploration/runner.ts');
      expect(analysis.files).toContain('exploration/state-graph.ts');
    });

    it('[Cycle-AST-2] 运行时依赖图必须为有向无环图 (DAG)，运行时回环数必须严格为 0', () => {
      const runtimeCycles = findCyclesInGraph(analysis.runtimeGraph);
      expect(runtimeCycles).toHaveLength(0);
      expect(runtimeCycles).toEqual([]);
    });

    it('[Cycle-AST-3] 若全依赖图中存在回环，每个回环必须包含纯类型导入/导出（绝非运行时回环）', () => {
      const fullCycles = findCyclesInGraph(analysis.fullGraph);

      // 验证每个全图回环中，至少存在一条边是纯类型导入/导出，确保在编译后被完全擦除
      for (const cycle of fullCycles) {
        let hasTypeOnlyEdge = false;
        for (let i = 0; i < cycle.length - 1; i++) {
          const from = cycle[i];
          const to = cycle[i + 1];
          const isTypeOnly = analysis.typeOnlyEdges.some((e) => e.from === from && e.to === to);
          if (isTypeOnly) {
            hasTypeOnlyEdge = true;
            break;
          }
        }
        expect(hasTypeOnlyEdge).toBe(true);
      }
    });
  });

  describe('2. 针对历史报告中提及的疑似循环依赖进行精确断言', () => {
    it('[Cycle-Regression-1] billing.ts 严禁反向依赖 core-kernel.ts（无论运行时还是类型）', () => {
      const billingDeps = analysis.fullGraph.get('billing.ts') || new Set();
      expect(billingDeps.has('core-kernel.ts')).toBe(false);
    });

    it('[Cycle-Regression-2] canonical-protocol.ts 严禁反向依赖 legacy-protocol-mappers.ts 或 core-kernel.ts', () => {
      const canonicalDeps = analysis.fullGraph.get('canonical-protocol.ts') || new Set();
      expect(canonicalDeps.has('legacy-protocol-mappers.ts')).toBe(false);
      expect(canonicalDeps.has('core-kernel.ts')).toBe(false);
    });

    it('[Cycle-Regression-3] legacy-protocol-mappers.ts 严禁对 core-kernel.ts 产生运行时依赖', () => {
      const runtimeDeps = analysis.runtimeGraph.get('legacy-protocol-mappers.ts') || new Set();
      expect(runtimeDeps.has('core-kernel.ts')).toBe(false); // 运行时无依赖！
    });

    it('[Cycle-Regression-4] canonical-verdict-engine.ts 严禁依赖 core-kernel.ts 或 legacy-protocol-mappers.ts', () => {
      const verdictDeps = analysis.fullGraph.get('canonical-verdict-engine.ts') || new Set();
      expect(verdictDeps.has('core-kernel.ts')).toBe(false);
      expect(verdictDeps.has('legacy-protocol-mappers.ts')).toBe(false);
    });

    it('[Cycle-Regression-5] execution-ports.ts 严禁依赖 core-kernel.ts', () => {
      const portsDeps = analysis.fullGraph.get('execution-ports.ts') || new Set();
      expect(portsDeps.has('core-kernel.ts')).toBe(false);
    });
  });

  describe('3. 动态运行时模块加载验证 (TDZ / 初始化无死锁检测)', () => {
    it('[Cycle-Runtime-1] src/devtest 下所有模块（含子目录）可被动态加载，无 TDZ 或未初始化异常', async () => {
      for (const file of analysis.files) {
        const modulePath = path.join(srcDevtestDir, file);
        const mod = await import(/* @vite-ignore */ modulePath);
        expect(mod).toBeDefined();
        expect(typeof mod).toBe('object');
      }
    });

    it('[Cycle-Runtime-2] dist 产物目录必须真实存在且递归加载所有 .js 模块，禁止静默跳过', async () => {
      // 满足不变量：未执行检查不得计为通过
      expect(fs.existsSync(distDevtestDir)).toBe(true);

      const distFiles = getAllJsFilesRecursively(distDevtestDir);
      expect(distFiles.length).toBeGreaterThanOrEqual(28);

      for (const file of distFiles) {
        const modulePath = path.join(distDevtestDir, file);
        const mod = await import(/* @vite-ignore */ modulePath);
        expect(mod).toBeDefined();
      }
    });
  });

  describe('4. 共享类型治理契约防劣化保护', () => {
    it('[Cycle-Invariants-1] types.ts 仅作为契约类型导出与桥接，不引入任何运行时循环', () => {
      const runtimeDeps = analysis.runtimeGraph.get('types.ts') || new Set();
      for (const dep of runtimeDeps) {
        const depRuntimeEdges = analysis.runtimeGraph.get(dep) || new Set();
        expect(depRuntimeEdges.has('types.ts')).toBe(false);
      }
    });

    it('[Cycle-Invariants-2] core-kernel.ts 导出 4 大动作出入参类型，公共 API 契约保持完整', async () => {
      const coreKernel = await import('../../../src/devtest/core-kernel.js');
      expect(typeof coreKernel.probe).toBe('function');
      expect(typeof coreKernel.plan).toBe('function');
      expect(typeof coreKernel.execute).toBe('function');
      expect(typeof coreKernel.verify).toBe('function');
      expect(typeof coreKernel.executeCanonical).toBe('function');
    });
  });

  describe('5. 检测器自身反例与边界条件测试 (Detector Negative Tests & Edge Cases)', () => {
    it('[Detector-Negative-1] 子目录跨层级运行时回环反例：检测器必须准确捕获，严禁漏检', () => {
      const virtualFiles: Record<string, string> = {
        'root-a.ts': `import { subB } from './sub/sub-b.js'; export const rootA = subB + 1;`,
        'sub/sub-b.ts': `import { rootA } from '../root-a.js'; export const subB = rootA + 1;`,
      };
      const result = analyzeDependencies(null, virtualFiles);
      const cycles = findCyclesInGraph(result.runtimeGraph);

      expect(cycles.length).toBeGreaterThan(0);
      const hasExpectedCycle = cycles.some(
        (c) =>
          (c[0] === 'root-a.ts' && c[1] === 'sub/sub-b.ts' && c[2] === 'root-a.ts') ||
          (c[0] === 'sub/sub-b.ts' && c[1] === 'root-a.ts' && c[2] === 'sub/sub-b.ts'),
      );
      expect(hasExpectedCycle).toBe(true);
    });

    it('[Detector-Negative-2] 混合默认导入与类型导入反例：检测器必须识别默认导入的运行时依赖，严禁错误擦除', () => {
      const virtualFiles: Record<string, string> = {
        'service-a.ts': `import DefaultB, { type TypeB } from './service-b.js'; export const valA = DefaultB;`,
        'service-b.ts': `import { valA } from './service-a.js'; export default 100; export type TypeB = string;`,
      };
      const result = analyzeDependencies(null, virtualFiles);
      const cycles = findCyclesInGraph(result.runtimeGraph);

      expect(cycles.length).toBeGreaterThan(0);
      const hasExpectedCycle = cycles.some(
        (c) =>
          (c[0] === 'service-a.ts' && c[1] === 'service-b.ts' && c[2] === 'service-a.ts') ||
          (c[0] === 'service-b.ts' && c[1] === 'service-a.ts' && c[2] === 'service-b.ts'),
      );
      expect(hasExpectedCycle).toBe(true);
    });

    it('[Detector-Negative-3] 纯类型双向回环反例：检测器必须判定运行时回环为 0，且全图回环全为类型边', () => {
      const virtualFiles: Record<string, string> = {
        'types-a.ts': `import type { TypeB } from './types-b.js'; export type TypeA = TypeB & { a: number };`,
        'types-b.ts': `import type { TypeA } from './types-a.js'; export type TypeB = { b: string };`,
      };
      const result = analyzeDependencies(null, virtualFiles);
      const runtimeCycles = findCyclesInGraph(result.runtimeGraph);
      const fullCycles = findCyclesInGraph(result.fullGraph);

      expect(runtimeCycles).toHaveLength(0);
      expect(fullCycles.length).toBeGreaterThan(0);
      for (const cycle of fullCycles) {
        let hasTypeOnly = false;
        for (let i = 0; i < cycle.length - 1; i++) {
          if (result.typeOnlyEdges.some((e) => e.from === cycle[i] && e.to === cycle[i + 1])) {
            hasTypeOnly = true;
            break;
          }
        }
        expect(hasTypeOnly).toBe(true);
      }
    });

    it('[Detector-Negative-4] 导出全部 (export * from) 运行时回环反例：检测器必须准确捕获', () => {
      const virtualFiles: Record<string, string> = {
        'barrel-a.ts': `export * from './barrel-b.js';`,
        'barrel-b.ts': `import { foo } from './barrel-a.js'; export const bar = foo;`,
      };
      const result = analyzeDependencies(null, virtualFiles);
      const cycles = findCyclesInGraph(result.runtimeGraph);

      expect(cycles.length).toBeGreaterThan(0);
    });
  });
});
