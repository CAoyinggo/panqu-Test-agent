import { access } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { DevTestOptions } from './types.js';

export interface DevTestRuntimeExtension {
  scenarioRuntime?: DevTestOptions['scenarioRuntime'];
  actorHeaders?: DevTestOptions['actorHeaders'];
  stateObserver?: DevTestOptions['stateObserver'];
  caseSnapshotObserver?: DevTestOptions['caseSnapshotObserver'];
  casePrepare?: DevTestOptions['casePrepare'];
  caseCleanup?: DevTestOptions['caseCleanup'];
  lifecyclePrepare?: DevTestOptions['lifecyclePrepare'];
  lifecycleCleanup?: DevTestOptions['lifecycleCleanup'];
}

type RuntimeFactory = (input: { root: string; environment: string }) => DevTestRuntimeExtension | Promise<DevTestRuntimeExtension>;

function validateRuntime(value: unknown): DevTestRuntimeExtension {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('DEVTEST_RUNTIME_INVALID：运行时模块必须返回对象');
  const runtime = value as DevTestRuntimeExtension;
  for (const processor of runtime.scenarioRuntime?.processors ?? []) {
    if (!processor?.name || processor.supportsAbort !== true || typeof processor.supports !== 'function'
      || typeof processor.execute !== 'function' || !Array.isArray(processor.supportedEvidenceKinds)) {
      throw new Error('DEVTEST_RUNTIME_INVALID：Processor 必须实现现有 ScenarioProcessor 契约');
    }
  }
  return runtime;
}

export async function loadDevTestRuntime(input: {
  root?: string;
  environment: string;
  moduleRef?: string;
}): Promise<DevTestRuntimeExtension> {
  if (!input.moduleRef) return {};
  const root = path.resolve(input.root ?? process.cwd());
  const file = path.resolve(root, input.moduleRef);
  if (!(file === root || file.startsWith(`${root}${path.sep}`))) {
    throw new Error('DEVTEST_RUNTIME_INVALID：运行时模块必须位于项目仓库内');
  }
  try { await access(file); } catch { throw new Error(`DEVTEST_RUNTIME_NOT_FOUND：${path.relative(root, file)}`); }
  const imported = await import(`${pathToFileURL(file).href}?devtest=${Date.now()}`) as {
    default?: DevTestRuntimeExtension | RuntimeFactory;
    createDevTestRuntime?: RuntimeFactory;
    devTestRuntime?: DevTestRuntimeExtension;
  };
  const candidate = imported.createDevTestRuntime ?? imported.default ?? imported.devTestRuntime;
  if (!candidate) throw new Error('DEVTEST_RUNTIME_INVALID：需要导出 createDevTestRuntime/default/devTestRuntime');
  const resolved = typeof candidate === 'function'
    ? await (candidate as RuntimeFactory)({ root, environment: input.environment }) : candidate;
  return validateRuntime(resolved);
}
