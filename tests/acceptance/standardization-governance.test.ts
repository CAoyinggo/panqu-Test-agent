import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { TestCase } from '../../src/agents/test-design/testcase-schema.js';
import {
  checkStandardizationText,
  checkTestCaseStandardization,
  classifyStandardAsset,
  STANDARD_TEST_CAPABILITIES,
} from '../../src/acceptance/standardization-gate.js';

const standardDocuments = [
  'docs/01-测试流程SOP.md',
  'docs/02-测试用例模板.md',
  'docs/03-数据需求清单模板.md',
  'docs/04-新任务启动检查清单模板.md',
  'docs/05-项目说明模板.md',
  'docs/README.md',
  'docs/devtest.md',
  'docs/testing/testcase-v2-schema.md',
  'docs/testing/devtest-p0-business-runtime.md',
  'docs/testing/standardization-governance.md',
  'docs/testing/test-design-intelligence.md',
  'docs/prompts/dev-selftest-agent.prompt.md',
  'docs/prompts/devtest-implementation-agent.prompt.md',
  'tests/acceptance/templates/scenario.md',
] as const;

function retiredName(): string {
  return String.fromCharCode(87, 65, 78, 51);
}

describe('DevTest standardization governance', () => {
  it('标准文档和 canonical template 不包含项目、产品、固定实现、单功能模板或 Legacy Entry', () => {
    const violations = standardDocuments.flatMap((file) => checkStandardizationText({
      content: fs.readFileSync(path.resolve(file), 'utf8'), location: file,
    }));
    expect(violations).toEqual([]);
  });

  it('当前标准实现路径不包含已退出标准体系的产品名', () => {
    const files = ['src/acceptance', 'src/agents/test-design'].flatMap((root) => fs.readdirSync(root)
      .filter((file) => file.endsWith('.ts')).map((file) => path.join(root, file)));
    const leaked = files.filter((file) => fs.readFileSync(file, 'utf8').toLowerCase().includes(retiredName().toLowerCase()));
    expect(leaked).toEqual([]);
  });

  it('统一能力表只表达测试能力，不表达功能模板', () => {
    expect(STANDARD_TEST_CAPABILITIES).toEqual([
      'Functional', 'UI', 'API', 'Parameter Validation', 'Boundary', 'Exception',
      'Permission', 'Data Isolation', 'State Transition', 'Data Consistency',
      'Idempotency', 'Concurrency', 'Side Effect', 'Failure Recovery', 'Cross-Case Pollution',
    ]);
    expect(STANDARD_TEST_CAPABILITIES.every((item) => !/template|项目|产品|登录|订单|支付|上传|搜索/i.test(item))).toBe(true);
  });

  it('开发者 Prompt 与实现 Prompt 使用同一 business-first 主链且不机械全维度覆盖', () => {
    const developerPrompt = fs.readFileSync(path.resolve('docs/prompts/dev-selftest-agent.prompt.md'), 'utf8');
    const implementationPrompt = fs.readFileSync(path.resolve('docs/prompts/devtest-implementation-agent.prompt.md'), 'utf8');
    for (const prompt of [developerPrompt, implementationPrompt]) {
      expect(prompt).toContain('Business Model');
      expect(prompt).toContain('Test Strategy');
      expect(prompt).toContain('TEST_CASE_V2');
      expect(prompt).toContain('Evidence');
      expect(prompt).toContain('Report');
      expect(prompt).not.toMatch(/每个需求[^\n]*全部|固定五维|生成\s*8[~～-]20\s*条/);
    }
  });

  it('标准化违规在 Case Gate 中是 BLOCKED 输入，不是 warning', () => {
    const candidate = {
      id: 'CASE-STANDARDIZATION', feature: 'Resource', name: 'generated', priority: 'P0', tags: ['feature-specific'],
      steps: [], assertions: [], metadata: { templateClassification: 'SINGLE_FEATURE' },
    } as TestCase;
    expect(checkTestCaseStandardization(candidate)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'FEATURE_SPECIFIC_TEMPLATE' }),
    ]));
  });

  it('历史和项目资产可分类，但不能被分类成 STANDARD', () => {
    expect(classifyStandardAsset(`tests/acceptance/scenarios/${retiredName().toLowerCase()}/case.md`)).toBe('PROJECT_SPECIFIC');
    expect(classifyStandardAsset('docs/phases/phase-example-report.md')).toBe('LEGACY');
    expect(classifyStandardAsset('docs/登录测试模板.md')).toBe('SINGLE_FEATURE');
    expect(classifyStandardAsset('tests/regression.test.ts', `compatibility for ${retiredName()}`)).toBe('PROJECT_SPECIFIC');
  });

  it('Gate 对所有禁止项返回 error 级违规集合', () => {
    const violations = checkStandardizationText({
      location: 'candidate.md',
      content: `${retiredName()}\nhttps://fixed.invalid/test\naccount: qa-user\nPOST /fixed/create\nfixedField: resourceId\nhard-coded business flow: create -> approve\n登录测试模板\nproject-specific test type\ntasks/legacy.json`,
    });
    expect(new Set(violations.map((item) => item.kind))).toEqual(new Set([
      'PROJECT_OR_PRODUCT_NAME', 'FIXED_URL', 'FIXED_CREDENTIAL', 'FIXED_INTERFACE',
      'FIXED_FIELD', 'HARD_CODED_BUSINESS_FLOW', 'FEATURE_SPECIFIC_TEMPLATE',
      'PROJECT_SPECIFIC_TEST_TYPE', 'LEGACY_ENTRY',
    ]));
  });
});
