import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseAcceptanceRequirement } from '../../../src/acceptance/requirement-parser.js';
import { appendDiscoveredContracts, discoverDevTestProject, discoverParameterContractConflicts } from '../../../src/devtest/project-discovery.js';
import { buildDevTestFeatureModel } from '../../../src/devtest/feature-model.js';

const REQUIREMENT = `# 用户资料修改页面

用户可以修改个人资料，昵称最长 20 个字符。

## Acceptance Criteria

- AC-1 修改成功后显示最新用户资料。
`;

describe('DevTest project discovery and Feature Model', () => {
  it('从唯一后端 Route 和 UI 页面建立 Requirement 映射，不猜不存在的参数', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'devtest-discovery-'));
    await writeFile(path.join(root, 'profile.tsx'), `
      export const route = { path: '/profile' };
      export function Profile(){ return <form><input name="nickname"/><button>保存</button></form> }
      export const api = { update: () => fetch('/api/profile', { method: 'PATCH' }) };
    `);
    await writeFile(path.join(root, 'routes.ts'), `router.patch('/api/profile', updateProfile);`);
    const explicit = parseAcceptanceRequirement(REQUIREMENT);
    const discovery = await discoverDevTestProject({ projectRoot: root, requirement: explicit });
    expect(discovery.mappedOperations).toEqual([
      expect.objectContaining({ method: 'PATCH', path: '/api/profile' }),
    ]);
    expect(discovery.mappedUi).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'PAGE', name: '/profile' }),
      expect.objectContaining({ kind: 'INPUT', name: 'nickname', selector: '[name="nickname"]' }),
    ]));

    const enriched = appendDiscoveredContracts(REQUIREMENT, discovery, false);
    const requirement = parseAcceptanceRequirement(enriched);
    expect(requirement.apis).toEqual([
      expect.objectContaining({ method: 'PATCH', path: '/api/profile', body: [] }),
    ]);
    const model = buildDevTestFeatureModel(requirement, discovery);
    expect(model.feature.name).toBe('用户资料修改页面');
    expect(model.resources).toContain('USER_PROFILE');
    expect(model.apis[0]).toEqual(expect.objectContaining({ path: '/api/profile', source: 'DISCOVERY' }));
    expect(model.ui.some((item) => item.kind === 'BUTTON')).toBe(true);
  });

  it('Requirement 与 OpenAPI 参数边界冲突时不自动选值', () => {
    const requirement = parseAcceptanceRequirement(`# 标签

POST /api/tags
公开接口，无需认证。

| 参数 | 位置 | 类型 | 必填 | 最大长度 |
| --- | --- | --- | --- | --- |
| name | body | string | 是 | 20 |

AC-1 name 超过 20 返回 400。
`);
    const operation = {
      id: 'api.post.tags', method: 'POST', path: '/api/tags', confidence: 0.9,
      source: [{ type: 'OPENAPI' as const, ref: 'openapi.json', confidence: 0.9 }],
      requestSchema: { content: { 'application/json': { schema: {
        type: 'object', required: ['name'], properties: { name: { type: 'string', maxLength: 200 } },
      } } } },
    };
    const conflicts = discoverParameterContractConflicts(requirement, {
      projectRoot: '.', scope: 'PROJECT_FILES', inspectedFiles: 1,
      operations: [operation], mappedOperations: [operation], ui: [], mappedUi: [], warnings: [], mappingReasons: [],
    });
    expect(conflicts).toEqual([
      expect.objectContaining({ code: 'PARAMETER_CONTRACT_CONFLICT', message: expect.stringContaining('Requirement=20 OpenAPI=200') }),
    ]);
  });
});
