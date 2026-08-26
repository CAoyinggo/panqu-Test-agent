import { createHash } from 'node:crypto';

import type { TestCase } from '../agents/test-design/testcase-schema.js';
import type { AcceptanceRequirement } from '../acceptance/requirement-ir.js';
import type {
  DevTestDiscoveryResult,
  DevTestEnvironmentPreflight,
  DevTestMode,
  DevTestUiExecutionResult,
} from './types.js';

function relevantSelectors(markdown: string, discovery: DevTestDiscoveryResult): Array<{ name: string; selector: string }> {
  const normalized = markdown.toLowerCase();
  const aliases: Record<string, string[]> = {
    nickname: ['nickname', '昵称'], color: ['color', '颜色'], save: ['save', '保存'], submit: ['submit', '提交'],
    name: ['name', '名称'], title: ['title', '标题'], success: ['success', '成功'], error: ['error', '失败', '错误'],
  };
  const stable = discovery.mappedUi.filter((item): item is typeof item & { selector: string } => Boolean(item.selector));
  const matched = stable.filter((item) => {
    const tokens = aliases[item.name.toLowerCase()] ?? [item.name.toLowerCase()];
    return tokens.some((token) => normalized.includes(token));
  });
  return matched.map((item) => ({ name: item.name, selector: item.selector }));
}

function explicitValues(markdown: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const match of markdown.matchAll(/\b([A-Za-z_][\w-]*)\s*(?:=|改为|设为)\s*["'`]([^"'`]+)["'`]/gi)) {
    values.set(match[1].toLowerCase(), match[2]);
  }
  return values;
}

function pagePath(requirement: AcceptanceRequirement, discovery: DevTestDiscoveryResult): string | undefined {
  const explicit = [...new Set(requirement.pages.map((item) => item.path).filter(Boolean))];
  if (explicit.length === 1) return explicit[0];
  const discovered = [...new Set(discovery.mappedUi.filter((item) => item.kind === 'PAGE' && item.name.startsWith('/')).map((item) => item.name))];
  return discovered.length === 1 ? discovered[0] : undefined;
}

export async function executeDevTestUiCases(input: {
  testCases: readonly TestCase[];
  requirement: AcceptanceRequirement;
  discovery: DevTestDiscoveryResult;
  environment: DevTestEnvironmentPreflight;
  mode: DevTestMode;
  allowActions?: boolean;
  signal?: AbortSignal;
}): Promise<DevTestUiExecutionResult[]> {
  const uiCases = input.testCases.filter((testCase) => testCase.testType === 'UI');
  if (!uiCases.length) return [];
  const terminal = (status: 'BLOCKED' | 'NOT_EXECUTED', error: string, classification: DevTestUiExecutionResult['classification']) =>
    uiCases.map((testCase): DevTestUiExecutionResult => ({
      caseId: testCase.id, status, executed: false, processorInvoked: false, steps: [], assertions: [], evidence: [], error, classification,
    }));
  if (input.mode === 'DRY_RUN') return terminal('NOT_EXECUTED', 'DRY_RUN：Browser 未执行', 'UNSUPPORTED');
  if (input.environment.checks.browser !== 'READY') return terminal('BLOCKED', 'BROWSER_UNAVAILABLE：Playwright Chromium 无法启动', 'ENVIRONMENT_ISSUE');
  if (!input.environment.selectedBaseUrl) return terminal('BLOCKED', 'ENVIRONMENT_UNAVAILABLE：UI 没有唯一 Base URL', 'ENVIRONMENT_ISSUE');
  const path = pagePath(input.requirement, input.discovery);
  if (!path) return terminal('BLOCKED', 'UI_URL_UNKNOWN：Requirement 与源码没有唯一页面 URL 映射', 'CONTRACT_ISSUE');

  let playwright: typeof import('playwright');
  try { playwright = await import('playwright'); }
  catch { return terminal('BLOCKED', 'BROWSER_PROCESSOR_UNAVAILABLE：Playwright 未安装', 'UNSUPPORTED'); }
  const results: DevTestUiExecutionResult[] = [];
  let browser: Awaited<ReturnType<typeof playwright.chromium.launch>>;
  try { browser = await playwright.chromium.launch({ headless: true }); }
  catch (error) { return terminal('BLOCKED', `BROWSER_LAUNCH_FAILED：${(error as Error).message}`, 'ENVIRONMENT_ISSUE'); }
  try {
    for (const testCase of uiCases) {
      const linkedFactIds = new Set(testCase.source?.factIds ?? []);
      const linkedFacts = input.requirement.factLedger.filter((fact) => linkedFactIds.has(fact.id));
      const acIds = new Set(testCase.source?.acceptanceCriteriaIds ?? []);
      const supportingUiFacts = input.requirement.factLedger.filter((fact) => fact.category === 'UI'
        && fact.provenance !== 'INFERRED' && fact.provenance !== 'UNKNOWN'
        && fact.entityRefs.items.some((ref) => ref.type === 'ACCEPTANCE_CRITERION' && acIds.has(ref.id)));
      const contractFacts = [...new Set([...linkedFacts, ...supportingUiFacts])];
      const contractSafe = linkedFacts.length > 0 && testCase.source?.sourceType !== 'HEURISTIC'
        && contractFacts.every((fact) => fact.epistemicType === 'FACT'
          && fact.provenance !== 'INFERRED' && fact.provenance !== 'UNKNOWN'
          && fact.canonical.normalizationStatus === 'COMPLETE');
      if (!contractSafe || !testCase.design?.expectedOutcome || !(testCase.evidenceRequirements?.length)) {
        results.push({ caseId: testCase.id, status: 'BLOCKED', executed: false, processorInvoked: false,
          executionContractReady: false, steps: [], assertions: [], evidence: [],
          error: 'UI_EXECUTION_CONTRACT_INCOMPLETE：缺少显式 Fact、确定 Expected 或 Evidence Plan',
          classification: 'CONTRACT_ISSUE' });
        continue;
      }
      const caseContract = contractFacts
        .map((fact) => fact.statement).concat(testCase.design?.actions ?? [], testCase.design?.expectedOutcome ?? '').join(' ');
      const selectors = relevantSelectors(caseContract, input.discovery);
      if (!selectors.length) {
        results.push({ caseId: testCase.id, status: 'BLOCKED', executed: false, processorInvoked: false,
          executionContractReady: false, steps: [], assertions: [], evidence: [], error: 'UI_LOCATOR_UNAVAILABLE：该 Case 没有 Requirement 绑定的稳定 Locator',
          classification: 'CONTRACT_ISSUE' });
        continue;
      }
      const requiresAction = /(?:点击|click).{0,30}(?:保存|提交|save|submit)|(?:保存|提交|save|submit)后/i.test(caseContract);
      const button = selectors.find((item) => /save|submit|保存|提交/i.test(item.name));
      const expectedState = selectors.find((item) => /success|error|成功|失败|错误/i.test(item.name));
      if (requiresAction && !input.allowActions) {
        results.push({ caseId: testCase.id, status: 'BLOCKED', executed: false, processorInvoked: false,
          executionContractReady: true, steps: [], assertions: [], evidence: [], error: 'UI_ACTION_SAFETY_BLOCKED：写交互缺少 Sandbox/Cleanup 与显式确认',
          classification: 'UNSUPPORTED' });
        continue;
      }
      if (requiresAction && (!button || !expectedState)) {
        results.push({ caseId: testCase.id, status: 'BLOCKED', executed: false, processorInvoked: false,
          executionContractReady: false, steps: [], assertions: [], evidence: [], error: 'UI_ACTION_CONTRACT_INCOMPLETE：该 Case 缺少稳定 Action 或 Expected State Locator',
          classification: 'CONTRACT_ISSUE' });
        continue;
      }
      const values = explicitValues(caseContract);
      const url = new URL(path, input.environment.selectedBaseUrl).href;
      const network: Array<{ method: string; url: string; status: number }> = [];
      let page: Awaited<ReturnType<typeof browser.newPage>> | undefined;
      try {
        page = await browser.newPage();
        page.on('response', (response) => {
          if (response.url().startsWith(input.environment.selectedBaseUrl!)) {
            network.push({ method: response.request().method(), url: response.url(), status: response.status() });
          }
        });
        if (input.signal?.aborted) throw input.signal.reason;
        const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 10_000 });
        if (!navigation) throw new Error('UI_NAVIGATION_NO_RESPONSE');
        if (navigation.status() >= 500) throw new Error(`UI_NAVIGATION_HTTP_${navigation.status()}`);
        const assertions: DevTestUiExecutionResult['assertions'] = [];
        const actionSteps: string[] = [];
        if (requiresAction) {
          for (const item of selectors) {
            const value = values.get(item.name.toLowerCase());
            if (value === undefined) continue;
            const locator = page.locator(item.selector);
            const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
            if (tagName === 'select') await locator.selectOption(value);
            else await locator.fill(value);
            actionSteps.push(`${tagName === 'select' ? 'SELECT' : 'INPUT'} ${item.selector} = ${JSON.stringify(value)}`);
            const actualValue = await locator.inputValue();
            assertions.push({ selector: item.selector, expected: value, actual: actualValue,
              pass: actualValue === value, kind: 'VALUE_EQUALS', factIds: [...linkedFactIds] });
          }
          await page.locator(button!.selector).click();
          actionSteps.push(`CLICK ${button!.selector}`);
        }
        for (const item of selectors) {
          const count = await page.locator(item.selector).count();
          const visible = count > 0 && await page.locator(item.selector).first().isVisible();
          assertions.push({ selector: item.selector, expected: `${item.name} element is visible`, actual: `count=${count}, visible=${visible}`,
            pass: count > 0 && visible, kind: 'VISIBLE', factIds: [...linkedFactIds] });
        }
        const screenshot = await page.screenshot({ type: 'png', fullPage: false });
        const failed = assertions.some((assertion) => !assertion.pass);
        results.push({
          caseId: testCase.id, status: failed ? 'FAIL' : 'PASS', executed: true, processorInvoked: true,
          executionContractReady: true, url,
          steps: [`OPEN ${url}`, ...actionSteps, ...selectors.map((item) => `ASSERT ${item.selector} exists`)], assertions,
          evidence: [
            { kind: 'PAGE', value: { url, status: navigation.status(), title: await page.title() } },
            { kind: 'NETWORK', value: network.slice(0, 50) },
            { kind: 'DOM', value: (await page.locator('body').innerText()).slice(0, 2000) },
            { kind: 'SCREENSHOT', value: { sha256: createHash('sha256').update(screenshot).digest('hex'), bytes: screenshot.length } },
          ],
          error: failed ? 'UI_ASSERTION_FAILED：Requirement 绑定元素不存在' : undefined,
          // 产品归因只能由统一 Oracle + Evidence-first Classification 完成。
          classification: undefined,
        });
      } catch (error) {
        results.push({
          caseId: testCase.id, status: 'BLOCKED', executed: false, processorInvoked: true, url,
          executionContractReady: true, steps: [`OPEN ${url}`], assertions: [], evidence: [{ kind: 'NETWORK', value: network }],
          error: `UI_ENVIRONMENT_ERROR：${(error as Error).message}`, classification: 'ENVIRONMENT_ISSUE',
        });
      } finally { if (page) await page.close(); }
    }
  } finally { await browser.close(); }
  return results;
}
