import { contractDependency } from '../contracts/dependency-index.js';
import type { ContractResolver } from '../contracts/resolver.js';
import type { ContractDependency } from '../contracts/types.js';

function identityTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length >= 3
    && !['api', 'model', 'enum', 'resource', 'state', 'machine'].includes(token));
}

/**
 * 把 Requirement 明确提及的 Registry identity 作为额外依赖。匹配只读取既有 ID/subject，
 * 不生成 Method/Path/Parameter，也不把模糊文本注册成新 Contract。
 */
export function discoverReferencedContractDependencies(
  markdown: string,
  resolver: ContractResolver,
): ContractDependency[] {
  const normalized = markdown.toLowerCase();
  const ids = [...new Set(resolver.registry.list().map((contract) => contract.id))];
  const dependencies: ContractDependency[] = [];
  for (const id of ids) {
    const candidates = resolver.registry.candidates({ id });
    const sample = candidates[0];
    if (!sample) continue;
    const tokens = [...new Set([...identityTokens(sample.id), ...identityTokens(sample.subject)])];
    if (!tokens.length || !tokens.every((token) => normalized.includes(token))) continue;
    const resolution = resolver.resolve({ id });
    const contract = resolution.contract ?? [...candidates]
      .sort((left, right) => right.version.localeCompare(left.version, undefined, { numeric: true }))[0];
    dependencies.push(contractDependency(contract));
  }
  return dependencies;
}
