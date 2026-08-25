import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { discoverFrontendNetworkFromSource, discoverRoutesFromSource, mergeOperations } from '../api/source-scanners.js';
import type { ChangeDiscoveryResult, ChangedArtifact, ChangedArtifactKind, DiscoveredOperation } from '../types.js';

function classify(file: string, content: string): ChangedArtifactKind {
  const value = `${file}\n${content.slice(0, 5000)}`;
  if (/openapi|swagger|route|router|controller/i.test(value)) return 'ROUTE';
  if (/migration|schema\.(sql|prisma)|CREATE\s+TABLE|ALTER\s+TABLE/i.test(value)) return 'DATABASE';
  if ((/\.(tsx|jsx|vue|svelte)$/i.test(file) || /component|useState|template>/i.test(content))
    && /fetch\(|axios|<button|<form/i.test(content)) return 'UI';
  if (/enum\s+\w+|as\s+const/i.test(content)) return 'ENUM';
  if (/model|entity|interface\s+\w+|type\s+\w+/i.test(value)) return 'MODEL';
  if (/\.env|config|ya?ml|toml/i.test(file)) return 'CONFIG';
  if (/fetch\(|axios|Route::|router\.|app\.|@(Get|Post|Put|Patch|Delete)/i.test(content)) return 'API';
  return 'OTHER';
}

function symbols(content: string): string[] {
  return [...content.matchAll(/(?:class|interface|type|enum|function|const)\s+([A-Za-z_$][\w$]*)/g)]
    .map((match) => match[1]).filter((item, index, all) => all.indexOf(item) === index).slice(0, 100);
}

function fields(content: string, direction: 'request' | 'response'): string[] {
  const names = new Set<string>();
  const patterns = direction === 'request'
    ? [/req(?:uest)?\.(?:body|query|params)\.([A-Za-z_$][\w$]*)/g, /body\[['"]([^'"]+)['"]\]/g]
    : [/res(?:ponse)?\.(?:json|send)\s*\(\s*\{([\s\S]{0,1200}?)\}\s*\)/g];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (direction === 'request') names.add(match[1]);
      else for (const key of match[1].matchAll(/([A-Za-z_$][\w$]*)\s*:/g)) names.add(key[1]);
    }
  }
  return [...names];
}

function sideEffects(content: string): string[] {
  const effects: string[] = [];
  if (/\b(insert|update|delete|save|create)\s*\(/i.test(content) || /\b(INSERT|UPDATE|DELETE)\b/i.test(content)) effects.push('DATA_MUTATION');
  if (/billing|charge|payment|扣费|积分/i.test(content)) effects.push('BILLING');
  if (/queue|publish|emit|notify|webhook/i.test(content)) effects.push('MESSAGE_OR_EVENT');
  if (/upload|writeFile|putObject/i.test(content)) effects.push('FILE_OR_OBJECT_WRITE');
  if (/provider|third.?party|external/i.test(content)) effects.push('EXTERNAL_PROVIDER');
  return effects;
}

export interface ChangeDiscoveryOptions {
  root?: string;
  contents?: ReadonlyMap<string, string>;
}

export async function discoverChanges(changedFiles: readonly string[], options: ChangeDiscoveryOptions = {}): Promise<ChangeDiscoveryResult> {
  const root = options.root ?? process.cwd();
  const artifacts: ChangedArtifact[] = [];
  const warnings: string[] = [];
  const operations: DiscoveredOperation[] = [];
  for (const file of [...new Set(changedFiles)]) {
    let content = options.contents?.get(file);
    if (content === undefined) {
      try { content = await readFile(path.resolve(root, file), 'utf8'); }
      catch (error) {
        warnings.push(`CHANGE_FILE_UNREADABLE：${file}：${(error as Error).message}`);
        artifacts.push({ file, kind: 'OTHER', symbols: [], requestFields: [], responseFields: [], sideEffects: [], operations: [], contentInspected: false });
        continue;
      }
    }
    const discovered = mergeOperations([
      ...discoverRoutesFromSource(content, file),
      ...discoverFrontendNetworkFromSource(content, file),
    ]);
    const effects = sideEffects(content);
    for (const item of discovered) item.sideEffects = [...new Set([...(item.sideEffects ?? []), ...effects])];
    operations.push(...discovered);
    artifacts.push({
      file, kind: classify(file, content), symbols: symbols(content),
      requestFields: fields(content, 'request'), responseFields: fields(content, 'response'),
      sideEffects: effects, operations: discovered, contentInspected: true,
    });
  }
  return { files: artifacts, operations: mergeOperations(operations), warnings };
}
