import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { inspectPanquProject, assessPanquProject } from '../../../src/devtest/panqu-project.js';
import { parseAcceptanceRequirement } from '../../../src/acceptance/requirement-parser.js';
import { runDevTest } from '../../../src/devtest/devtest-runner.js';
import { createServer, type Server } from 'node:http';

const roots: string[] = [];
const servers: Server[] = [];
const WRAPPERS = `export async function requestPHPApi(path, options = {}) {
  const { params, headers, ...requestOptions } = options;
  const response = await fetch(buildRequestUrl(path, params), { ...requestOptions, headers });
  const result = await response.json();
  if (!response.ok || result.code !== 1) throw new Error('request failed');
  return result.data;
}
export async function requestGOApi(path, options = {}) {
  const { params, headers, ...requestOptions } = options;
  const response = await fetch(buildRequestUrl(path, params), { ...requestOptions, headers });
  const result = await response.json();
  if (!response.ok || response.status !== 200) throw new Error('request failed');
  return result;
}`;

async function put(root: string, file: string, content: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}

async function fixture(host: 'react' | 'nuxt' = 'react') {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'panqu-project-'));
  roots.push(root);
  await put(root, 'package.json', JSON.stringify({ dependencies: host === 'react'
    ? { next: '16', '@xyflow/react': '12' } : { nuxt: '4', '@vue-flow/core': '1' } }));
  if (host === 'react') {
    await put(root, 'components/nodes/useAddFlowNode.ts', `import { addNodePost } from '../../lib/api/node'; export const add = addNodePost;`);
    await put(root, 'lib/api/request.ts', WRAPPERS);
    await put(root, 'lib/api/node.ts', `import { requestGOApi } from './request';
export const addNodePost = (req: unknown) => requestGOApi('/p-api/workflow/add_node', {method:'POST', body:JSON.stringify(req)});`);
    await put(root, 'lib/api/video.ts', `import { requestPHPApi } from './request';
export const getModels = () => requestPHPApi<Model[]>('/aivideo/v2/video/getPanquaivideoModels');
export const submitVideo = (formData: FormData) => requestPHPApi('/aivideo/videonew/add', { method: 'POST', body: formData });`);
  } else {
    await put(root, 'composables/canvas-flow/core/use-plugin-registry.ts', 'export const registry = new Map();');
    await put(root, 'utils/myFetchInstance.ts', 'export const myFetch = (url, options = {}) => fetch(url, options);');
    await put(root, 'components/canvas-flow/plugins/new-node/manifest.ts', `export const manifest = {kind:'media.future', capabilities:{executable:true}};`);
    await put(root, 'composables/canvas-flow/adapters/canvas-flow-api-client.ts', `import { myFetch } from '~/utils/myFetchInstance';
export const api = {save:(id:string, data:unknown) => myFetch('/canvas/save', {method:'PUT', body:data})};`);
  }
  return root;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function serve(body: unknown, status = 200) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.statusCode = request.url === '/health' ? 200 : status;
    response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body));
  });
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { requests, baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` };
}

async function execute(root: string, baseUrl: string, route: string, method = 'GET', status = 200) {
  return runDevTest({ projectRoot: root, project: 'panqu-fixture', documentId: 'panqu-fixture', mode: 'SAFE', environment: 'local',
    markdown: `# 资源查询\n## API\n${method} ${route}\n无需认证。\n返回 ${status}。\n## Acceptance Criteria\nAC-1 ${method} ${route} 返回 HTTP ${status}。\n`,
    baseUrl, discoverProject: false, outDir: path.join(root, 'devtest-results'), timeoutMs: 1000 });
}

describe('Panqu source-grounded project adapter', () => {
  it('blocks a GET substituted for a mutating call before even environment probing', async () => {
    const root = await fixture(); const server = await serve({ code: 1 });
    const result = await execute(root, server.baseUrl, '/aivideo/videonew/add');
    expect(server.requests).toEqual([]);
    expect(result.projectAssessment?.blockers.some(blocker => blocker.code === 'PANQU_METHOD_CONFLICT')).toBe(true);
    expect(result.deliveryCoverage.cases).toMatchObject({ executed: 0, passed: 0, verified: 0 });
  });

  it('blocks multipart plans before all network and lifecycle work', async () => {
    const root = await fixture(); const server = await serve({ code: 1 });
    const result = await execute(root, server.baseUrl, '/aivideo/videonew/add', 'POST');
    expect(server.requests).toEqual([]);
    expect(result.projectAssessment?.blockers.some(blocker => blocker.code === 'PANQU_FORM_DATA_UNSUPPORTED')).toBe(true);
  });

  it.each([1, 0, '1'])('uses independent HTTP evidence for PHP code %s without promoting transport-only success', async code => {
    const root = await fixture(); const server = await serve({ code, data: [] });
    const result = await execute(root, server.baseUrl, '/aivideo/v2/video/getPanquaivideoModels');
    expect(server.requests.length).toBeGreaterThan(0);
    const execution = result.pipeline.report.executions[0];
    expect(execution.evidence.response?.body).toEqual({ code, data: [] });
    expect(execution.status, JSON.stringify({ assessment: result.projectAssessment, execution })).toBe(code === 1 ? 'PASS' : 'BLOCKED');
    if (code !== 1) {
      expect(result.deliveryCoverage.cases).toMatchObject({ passed: 0, verified: 0 });
      expect(result.problems.some(problem => problem.failureClass === 'PRODUCT_BUG')).toBe(false);
    }
  });

  it.each([200, 201])('keeps GO raw-response protocol separate from PHP for HTTP %s', async status => {
    const root = await fixture(); const server = await serve({ items: [] }, status);
    await put(root, 'lib/api/query.ts', `import {requestGOApi} from './request'; export const list=()=>requestGOApi('/go/resources');`);
    const result = await execute(root, server.baseUrl, '/go/resources', 'GET', status);
    expect(result.pipeline.report.executions[0].status).toBe(status === 200 ? 'PASS' : 'BLOCKED');
  });

  it('does not claim the default GET when the wrapper substitutes dynamic options', async () => {
    const root = await fixture();
    await put(root, 'lib/api/request.ts', `export const requestPHPApi=(path, options={}) => fetch(path, otherOptions);`);
    const context = await inspectPanquProject(root);
    expect(context.actions.find(action => action.symbol === 'getModels')).toMatchObject({ methodBasis: 'UNRESOLVED' });
  });

  it('recognizes structure, typed wrappers and differing PHP/GO protocols without project-name assumptions', async () => {
    const context = await inspectPanquProject(await fixture());
    expect(context.host).toBe('NEXT_XYFLOW');
    expect(context.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ symbol: 'getModels', method: 'GET', responseProtocol: 'PHP_CODE_1', body: 'NONE' }),
      expect.objectContaining({ symbol: 'submitVideo', method: 'POST', body: 'FORM_DATA' }),
      expect.objectContaining({ symbol: 'addNodePost', method: 'POST', responseProtocol: 'GO_HTTP_200', body: 'JSON' }),
    ]));
    expect(context.provenance).toBe('SOURCE_OBSERVATION_ONLY');
    expect(context.actions.every(action => action.source.line > 0 && action.source.sha256.length === 64)).toBe(true);
  });

  it('finds new Nuxt node kinds and follows imported aliases instead of hardcoded model names', async () => {
    const root = await fixture('nuxt');
    await put(root, 'composables/canvas-flow/extra.ts', `import { myFetch as send } from '~/utils/myFetchInstance';
export const remove = () => send('/canvas/future', {method:'DELETE'});`);
    const context = await inspectPanquProject(root);
    expect(context.host).toBe('NUXT_VUE_FLOW');
    expect(context.nodes.map(node => node.kind)).toContain('media.future');
    expect(context.actions.some(action => action.symbol === 'remove' && action.method === 'DELETE')).toBe(true);
  });

  it('does not turn commented calls, shadowed identifiers, dynamic methods or spreads into executable GETs', async () => {
    const root = await fixture();
    await put(root, 'lib/api/dynamic.ts', `import { requestPHPApi } from './request';
// requestPHPApi('/not-real', {method:'POST'})
const text = "requestPHPApi('/also-not-real')";
export const dynamic = (method: string) => requestPHPApi('/dynamic', {method});
export const spread = (options: unknown) => requestPHPApi('/spread', {...options});
export const shadow = (requestPHPApi: Function) => requestPHPApi('/shadow');`);
    const context = await inspectPanquProject(root);
    expect(context.actions.some(action => ['/not-real', '/also-not-real', '/shadow'].includes(action.path ?? ''))).toBe(false);
    expect(context.actions.filter(action => ['/dynamic', '/spread'].includes(action.path ?? ''))
      .every(action => action.method === undefined && action.unresolved.length > 0)).toBe(true);
  });

  it('blocks wrong HTTP methods and FormData substitution without rewriting requirements', async () => {
    const context = await inspectPanquProject(await fixture());
    const wrong = parseAcceptanceRequirement('# 视频\nGET /aivideo/videonew/add\n无需认证\n返回 200\nAC-1 提交成功。');
    expect(assessPanquProject(context, wrong).blockers.some(item => item.code === 'PANQU_METHOD_CONFLICT')).toBe(true);
    const right = parseAcceptanceRequirement('# 视频\nPOST /aivideo/videonew/add\n无需认证\n返回 200\nAC-1 提交成功。');
    expect(assessPanquProject(context, right).blockers.some(item => item.code === 'PANQU_FORM_DATA_UNSUPPORTED')).toBe(true);
    expect(wrong.apis[0].method).toBe('GET');
  });

  it('maps changed helpers through imports to candidate regressions and never reports them as executed', async () => {
    const root = await fixture();
    await put(root, 'test/node.test.ts', `import { add } from '../components/nodes/useAddFlowNode'; import assert from 'node:assert'; assert.ok(add);`);
    const context = await inspectPanquProject(root, { changedFiles: ['lib/api/request.ts'] });
    expect(context.affectedFiles).toEqual(expect.arrayContaining(['lib/api/node.ts', 'components/nodes/useAddFlowNode.ts', 'test/node.test.ts']));
    expect(context.regressionCandidates).toContainEqual(expect.objectContaining({ file: 'test/node.test.ts', status: 'NOT_EXECUTED' }));
  });

  it('keeps discovered local regressions visible in the report without executing repository code', async () => {
    const root = await fixture();
    await put(root, 'test/node.test.ts', `import { add } from '../components/nodes/useAddFlowNode'; throw new Error('Repository test must not be auto-executed');`);
    const result = await runDevTest({ projectRoot: root, project: 'panqu-fixture', mode: 'DRY_RUN',
      markdown: '# 视频模型列表\nGET /aivideo/v2/video/getPanquaivideoModels\n无需认证。\n返回 200。\nAC-1 列表返回 HTTP 200。',
      discoverProject: false, outDir: path.join(root, 'devtest-results') });
    const report = await readFile(result.artifacts.developerSelfTestReportMd, 'utf8');
    const gaps = report.split('## 6. 未覆盖项与回归建议')[1].split('## 7. 发布判定')[0];
    expect(gaps).toContain('本地代码测试候选：test/node.test.ts');
    expect(gaps).toContain('NOT_EXECUTED');
    expect(gaps).toContain('不得用页面 PASS 替代');
    expect(result.deliveryCoverage.cases.executed).toBe(0);
  });

  it('treats syntax errors and scan limits as explicit incomplete evidence', async () => {
    const root = await fixture();
    await put(root, 'lib/api/broken.ts', 'export const broken = ( ;');
    const context = await inspectPanquProject(root);
    expect(context.complete).toBe(false);
    expect(context.diagnostics.some(item => item.code === 'PANQU_SOURCE_PARSE_ERROR')).toBe(true);
    const bounded = await inspectPanquProject(root, { maxFiles: 2 });
    expect(bounded.complete).toBe(false);
    expect(bounded.diagnostics.some(item => item.code === 'PANQU_SCAN_LIMIT')).toBe(true);
  });

  it('does not read symlinks outside the project or mistake installed test tooling for business source', async () => {
    const root = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'panqu-external-')); roots.push(outside);
    await put(outside, 'secret.ts', `export const secret = 'never-copy-source-secret';`);
    await symlink(path.join(outside, 'secret.ts'), path.join(root, 'lib/api/escape.ts'));
    await put(root, '.trae/devtest-runtime/fake.ts', `fetch('/fake-tool-route')`);
    const context = await inspectPanquProject(root);
    expect(context.sources.some(item => item.file.startsWith('.trae/') || item.file.endsWith('escape.ts'))).toBe(false);
    expect(JSON.stringify(context)).not.toContain('never-copy-source-secret');
    expect(context.diagnostics.some(item => item.code === 'PANQU_SOURCE_SYMLINK')).toBe(true);
  });

  it('changes the project fingerprint on Vue-only changes', async () => {
    const root = await fixture('nuxt');
    await put(root, 'components/canvas-flow/Panel.vue', '<script setup lang="ts">const flag = false;</script>');
    const before = await inspectPanquProject(root);
    await put(root, 'components/canvas-flow/Panel.vue', '<script setup lang="ts">const flag = true;</script>');
    expect((await inspectPanquProject(root)).fingerprint).not.toBe(before.fingerprint);
  });

  it('does not activate Panqu rules for unrelated repositories', async () => {
    const root = await mkdtemp(path.join(await realpath(tmpdir()), 'panqu-unrelated-')); roots.push(root);
    await put(root, 'package.json', '{"dependencies":{"next":"16"}}');
    expect((await inspectPanquProject(root)).host).toBe('UNKNOWN');
  });
});
