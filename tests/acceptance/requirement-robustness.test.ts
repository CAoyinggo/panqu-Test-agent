import { describe, expect, it } from 'vitest';
import { parseAcceptanceRequirement } from '../../src/acceptance/requirement-parser.js';
import { generateAcceptanceApiCases } from '../../src/acceptance/test-case-generator.js';
import { generateTestPoints } from '../../src/acceptance/test-point.js';
import { validateAcceptanceTrace } from '../../src/acceptance/traceability.js';

describe('Requirement input reliability and traceability', () => {
  it('parses mixed Chinese/English, headings, lists, code blocks and Markdown tables', () => {
    const markdown = `# Profile Update / 用户资料
### endpoint
\`\`\`http
PATCH /api/profile/{id}
\`\`\`
| 参数 | 类型 | 必填 | 范围 |
| --- | --- | --- | --- |
| nickname | string | required | 2~20 |
## Role 权限
- Admin 可以更新用户
## Acceptance Criteria
- AC-1 更新成功返回 200`;
    const requirement = parseAcceptanceRequirement(markdown, { documentId: 'mixed.md' });
    expect(requirement.apis[0]).toMatchObject({ method: 'PATCH', path: '/api/profile/{id}' });
    expect(requirement.apis[0].body[0]).toMatchObject({ name: 'nickname', minLength: 2, maxLength: 20 });
    expect(requirement.acceptanceCriteria[0].source).toMatchObject({ documentId: 'mixed.md', line: expect.any(Number) });
  });

  it('emits explicit warnings for partial or ambiguous requirements instead of silently dropping fields', () => {
    const partial = parseAcceptanceRequirement('# 简略需求\nGET /api/items\nAC-1 查询条目');
    expect(partial.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['NO_RESPONSE', 'AUTH_UNKNOWN', 'AMBIGUOUS_CRITERION']));
    const unstructured = parseAcceptanceRequirement('只是一些没有接口和验收标准的纯文本说明');
    expect(unstructured.warnings.map((warning) => warning.code)).toEqual(expect.arrayContaining(['NO_API', 'NO_ACCEPTANCE_CRITERIA']));
  });

  it('warns on duplicate AC IDs/parameters and rejects empty input', () => {
    const duplicate = parseAcceptanceRequirement('# X\nGET /x\nAC-1 返回 200\nAC-1 返回 404');
    expect(duplicate.acceptanceCriteria).toHaveLength(1);
    expect(duplicate.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REQUIREMENT_CONFLICT', blocking: true })]));
    const duplicateParameter = parseAcceptanceRequirement(`# X
GET /x
| name | type | location |
| --- | --- | --- |
| value | string | body |
| value | integer | body |
AC-1 返回 200`);
    expect(duplicateParameter.apis[0].body).toHaveLength(1);
    expect(duplicateParameter.warnings).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'REQUIREMENT_CONFLICT', blocking: true })]));
    expect(() => parseAcceptanceRequirement('  \n ')).toThrow('开发验收需求文档为空');
  });

  it('handles long documents and keeps generated trace free from orphan/duplicate references', () => {
    const notes = Array.from({ length: 2000 }, (_, index) => `背景说明 ${index}`).join('\n');
    const requirement = parseAcceptanceRequirement(`# 长需求\n${notes}\nPUT /api/items/{id}\nvalue: string required 1~10\n返回 200\nAC-1 更新成功返回 200`, { documentId: 'long.md' });
    const points = generateTestPoints(requirement);
    const cases = generateAcceptanceApiCases(requirement, points);
    expect(validateAcceptanceTrace(requirement, points, cases)).toEqual([]);

    const orphan = [{ ...cases[0], source: { ...cases[0].source!, testPointId: 'TP-NOT-FOUND' } }];
    expect(validateAcceptanceTrace(requirement, points, orphan)).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'ORPHAN_TEST_CASE' }),
    ]));
  });
});
