import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';

const fixture = fs.readFileSync(
  fileURLToPath(new URL('./fixtures/user-profile.md', import.meta.url)),
  'utf8',
);

describe('Acceptance Requirement IR', () => {
  it('保留 Markdown 表格中的 API、参数约束、角色、租户、AC 与来源行', () => {
    const requirement = parseAcceptanceRequirement(fixture, { documentId: 'user-profile.md' });

    expect(requirement.title).toBe('用户资料修改');
    expect(requirement.pages.map((page) => page.path)).toContain('/profile');
    expect(requirement.apis).toHaveLength(1);
    expect(requirement.apis[0]).toMatchObject({ method: 'PUT', path: '/api/users/{id}' });

    const nickname = requirement.apis[0].body.find((parameter) => parameter.name === 'nickname');
    expect(nickname).toMatchObject({ type: 'string', required: true, nullable: false, minLength: 2, maxLength: 20 });
    const age = requirement.apis[0].body.find((parameter) => parameter.name === 'age');
    expect(age).toMatchObject({ type: 'integer', required: false, nullable: false, min: 1, max: 100 });
    expect(requirement.apis[0].headers.find((parameter) => parameter.name === 'Authorization')?.required).toBe(true);
    expect(requirement.apis[0].responses.map((response) => response.status)).toEqual([200, 400, 401, 403, 404]);

    expect(requirement.actors.map((actor) => actor.id)).toEqual(['user-a', 'user-b', 'admin', 'tenant-b-user']);
    expect(requirement.actors.find((actor) => actor.id === 'admin')).toMatchObject({ role: 'ADMIN', tenantId: 'tenant-a' });
    expect(requirement.isolationRules[0]).toMatchObject({ dimension: 'TENANT', expected: 'DENY' });
    expect(requirement.businessRules[0].description).toContain('返回更新后的用户资料');
    expect(requirement.acceptanceCriteria.map((criterion) => criterion.criterionId)).toEqual([
      'AC-1', 'AC-2', 'AC-3', 'AC-4', 'AC-5', 'AC-6', 'AC-7',
    ]);
    expect(requirement.acceptanceCriteria[1].source).toMatchObject({
      documentId: 'user-profile.md', section: 'Acceptance Criteria', line: expect.any(Number),
    });
  });

  it('支持 prose API 与参数约束，不依赖固定表格模板', () => {
    const requirement = parseAcceptanceRequirement(`# 更新资料\n## API\nPATCH /api/profile/{id}\nnickname: string required 2~20\n## Acceptance Criteria\nAC-1 合法昵称更新成功`);
    expect(requirement.apis[0]).toMatchObject({ method: 'PATCH', path: '/api/profile/{id}' });
    expect(requirement.apis[0].body[0]).toMatchObject({ name: 'nickname', minLength: 2, maxLength: 20 });
    expect(requirement.apis[0].pathParams[0]).toMatchObject({ name: 'id', location: 'path', required: true });
  });

  it('不把 AC 中引用的操作当成 ApiSpec，并显式报告无法归属的参数', () => {
    const requirement = parseAcceptanceRequirement(`# 多接口
GET /users/{id}
GET /users/{id}/status

| name | type | location | required |
| --- | --- | --- | --- |
| locale | string | query | yes |

AC-1 DELETE /users/{id} 删除成功返回 204`);

    expect(requirement.apis.map((api) => `${api.method} ${api.path}`)).toEqual([
      'GET /users/{id}', 'GET /users/{id}/status',
    ]);
    expect(requirement.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PARAMETER_WITHOUT_API_CONTEXT', stage: 'PARSER' }),
    ]));
  });

  it('把受保护字段更新返回 422 识别为 DENY，不制造 ALLOW/DENY 假冲突', () => {
    const requirement = parseAcceptanceRequirement(`# Profile protection
## Acceptance Criteria
AC-1 包含 role、tenantId 或 projectId 任一受保护字段的资料更新返回 HTTP 422。
AC-2 整个更新原子拒绝，displayName、role、tenantId、projectId、revision 和 canonicalDigest 均保持不变。`);

    expect(requirement.permissions).toHaveLength(2);
    expect(requirement.permissions.every((permission) => permission.effect === 'DENY')).toBe(true);
    expect(requirement.warnings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'REQUIREMENT_CONFLICT' }),
    ]));
    expect(requirement.factLedger.filter((fact) => fact.status === 'BLOCKED')).toEqual([]);
  });
});
