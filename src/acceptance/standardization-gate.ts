import type { TestCase } from '../agents/test-design/testcase-schema.js';

export type StandardAssetClassification = 'STANDARD' | 'PROJECT_SPECIFIC' | 'LEGACY' | 'SINGLE_FEATURE';

export type StandardizationViolationKind =
  | 'PROJECT_OR_PRODUCT_NAME'
  | 'FIXED_URL'
  | 'FIXED_CREDENTIAL'
  | 'FIXED_INTERFACE'
  | 'FIXED_FIELD'
  | 'HARD_CODED_BUSINESS_FLOW'
  | 'FEATURE_SPECIFIC_TEMPLATE'
  | 'PROJECT_SPECIFIC_TEST_TYPE'
  | 'LEGACY_ENTRY';

export interface StandardizationViolation {
  kind: StandardizationViolationKind;
  message: string;
  location?: string;
}

const retiredProductName = String.fromCharCode(87, 65, 78, 51);
const retiredProjectNames = [
  ['p', 'a', 'n', 'q', 'u', '-', 'a', 'i'].join(''),
  ['T', 'e', 's', 't', '-', 'p', 'a', 'n', 'q', 'u'].join(''),
];
const featureTemplateNames = ['登录', '订单', '支付', '上传', '搜索'];

export const STANDARD_TEST_CAPABILITIES = [
  'Functional', 'UI', 'API', 'Parameter Validation', 'Boundary', 'Exception',
  'Permission', 'Data Isolation', 'State Transition', 'Data Consistency',
  'Idempotency', 'Concurrency', 'Side Effect', 'Failure Recovery', 'Cross-Case Pollution',
] as const;

export interface StandardizationTextInput {
  content: string;
  location?: string;
  projectOrProductNames?: readonly string[];
}

export function classifyStandardAsset(assetPath: string, content = ''): StandardAssetClassification {
  const normalized = assetPath.replaceAll('\\', '/').toLowerCase();
  if (normalized.includes('/legacy/') || normalized.includes('/phases/') || normalized.includes('/reports/')
    || /(?:audit|report)-\d{4}-\d{2}-\d{2}/.test(normalized)) return 'LEGACY';
  if ([retiredProductName, ...retiredProjectNames].some((name) =>
    normalized.includes(name.toLowerCase()) || content.toLowerCase().includes(name.toLowerCase()))) {
    return 'PROJECT_SPECIFIC';
  }
  if (featureTemplateNames.some((name) => normalized.includes(name) && /模板|template/.test(normalized))) {
    return 'SINGLE_FEATURE';
  }
  return 'STANDARD';
}

/** 检查标准资产本身；Requirement 实例数据不应传给本函数。 */
export function checkStandardizationText(input: StandardizationTextInput): StandardizationViolation[] {
  const violations: StandardizationViolation[] = [];
  const add = (kind: StandardizationViolationKind, message: string): void => {
    if (!violations.some((item) => item.kind === kind && item.message === message)) {
      violations.push({ kind, message, location: input.location });
    }
  };
  const names = [retiredProductName, ...retiredProjectNames, ...(input.projectOrProductNames ?? [])]
    .filter(Boolean);
  for (const name of names) {
    if (input.content.toLowerCase().includes(name.toLowerCase())) {
      add('PROJECT_OR_PRODUCT_NAME', `标准资产包含项目或产品名：${name}`);
    }
  }
  if (/https?:\/\/(?![{$<])/i.test(input.content)) add('FIXED_URL', '标准资产包含固定 URL');
  if (/(?:cookie|csrf(?:[_ -]?token)?|password|token|username|account|账号)\s*[:=]\s*(?![{$<])/i.test(input.content)) {
    add('FIXED_CREDENTIAL', '标准资产包含固定凭据、Cookie 或 CSRF 值');
  }
  if (/\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[a-z0-9]/i.test(input.content)) {
    add('FIXED_INTERFACE', '标准资产包含固定 Method + Path');
  }
  if (/(?:tasks\/[^\s`]+\.json|dist\/bin\/run-test|npm\s+run\s+run-test)/i.test(input.content)) {
    add('LEGACY_ENTRY', '标准资产引用 Legacy 执行入口');
  }
  if (featureTemplateNames.some((name) => new RegExp(`${name}[^\\n]{0,12}(?:测试)?模板`, 'i').test(input.content))) {
    add('FEATURE_SPECIFIC_TEMPLATE', '标准资产包含单功能模板');
  }
  if (/(?:project|product|feature)[-_ ]specific\s+(?:test\s+)?type/i.test(input.content)) {
    add('PROJECT_SPECIFIC_TEST_TYPE', '标准资产声明项目或功能专属 Test Type');
  }
  if (/(?:hard[-_ ]coded\s+business\s+flow|固定业务流程\s*[:=])/i.test(input.content)) {
    add('HARD_CODED_BUSINESS_FLOW', '标准资产声明固定业务流程');
  }
  if (/(?:fixed[-_ ]?field|固定字段)\s*[:=]\s*(?![{$<])/i.test(input.content)) {
    add('FIXED_FIELD', '标准资产声明固定业务字段');
  }
  return violations;
}

/** Case 只检查生成器元数据；Requirement 派生的业务词和接口不能被误报为模板泄漏。 */
export function checkTestCaseStandardization(testCase: TestCase): StandardizationViolation[] {
  const violations: StandardizationViolation[] = [];
  const metadata = testCase.metadata ?? {};
  const marker = String(metadata.templateClassification ?? metadata.templateKind ?? '').toUpperCase();
  if (['PROJECT_SPECIFIC', 'SINGLE_FEATURE', 'LEGACY'].includes(marker)) violations.push({
    kind: marker === 'LEGACY' ? 'LEGACY_ENTRY' : marker === 'SINGLE_FEATURE'
      ? 'FEATURE_SPECIFIC_TEMPLATE' : 'PROJECT_SPECIFIC_TEST_TYPE',
    message: `Case 来源不是通用标准模板：${marker}`,
  });
  const leakedTag = testCase.tags.find((tag) => /^(?:project|product|feature)-specific|^legacy-entry$/i.test(tag));
  if (leakedTag) violations.push({
    kind: /^legacy/i.test(leakedTag) ? 'LEGACY_ENTRY' : 'PROJECT_SPECIFIC_TEST_TYPE',
    message: `Case 包含非标准生成标记：${leakedTag}`,
  });
  return violations;
}
