import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compilePanquMission } from '../../src/devtest/panqu-mission-plan.js';
import { PanquHttpMissionDriver, decodePanquMissionTask } from '../../src/devtest/panqu-mission-driver.js';
import { runPanquMission, renderPanquMission } from '../../src/devtest/panqu-mission-runtime.js';
import { inventoryMissionMedia, prepareMissionReferenceClip } from '../../src/devtest/panqu-mission-media.js';
import type { PanquMissionApproval, PanquMissionCatalog, PanquMissionPlan, PanquMissionSpec } from '../../src/devtest/panqu-mission-types.js';

const exec = promisify(execFile);
const roots: string[] = []; const servers: Server[] = [];
const binary = (name: string) => (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, name)).find(file => path.isAbsolute(file) && existsSync(file));
const mediaTools = { ffprobe: binary('ffprobe')!, ffmpeg: binary('ffmpeg')! };
let clipRoot: string; let clip: Buffer;
beforeAll(async () => {
  if (!mediaTools.ffmpeg || !mediaTools.ffprobe) return;
  clipRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'panqu-mission-clip-'));
  await exec(mediaTools.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', path.join(clipRoot, 'clip.mp4')]);
  clip = await readFile(path.join(clipRoot, 'clip.mp4'));
});
afterAll(async () => { if (clipRoot) await rm(clipRoot, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const sources = ['lib/api/video.ts', 'lib/api/taskStatus.ts', 'lib/api/request.ts', 'lib/api/csrf.ts', 'lib/api/url.ts', 'components/nodes/videoNode.tsx'];
async function data() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'panqu-mission-test-')); roots.push(root);
  for (const file of sources) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'export const fixture = true;'); }
  const request = { model_id: 'fixture-model-a', 'row[selmodelsId]': 'fixture-model-a', project_id: 'project-a', 'row[workflow_node_id]': 'node-a',
    'row[extra][duration]': '1', 'row[extra][video_resolution]': 'low', 'row[type]': 'fixture-type', 'row[extra][selmodels]': 'fixture-model-a-alias', task_type: 'fixture-task', 'row[extra][cueword]': 'A red ball moves slowly.' };
  const base = { id: 'cheap', modelId: 'fixture-model-a', mode: 'text-to-video', maxMilliCredits: 100,
    parameters: { durationSeconds: 1, width: 160, height: 90, count: 1, quality: 'low' }, request };
  const catalog: PanquMissionCatalog = { schema: 'panqu.catalog.v1', profile: 'PHP_VIDEO_V1', source: 'Independent fixture quote, not a production price', expiresAt: new Date(Date.now() + 600000).toISOString(),
    projectId: 'project-a', nodeId: 'node-a', sourcePins: sources.map(file => ({ file, sha256: createHash('sha256').update('export const fixture = true;').digest('hex') })),
    variants: [base, { ...structuredClone(base), id: 'expensive', maxMilliCredits: 500 }, { ...structuredClone(base), id: 'wrong-model', modelId: 'another-model', maxMilliCredits: 1 }] };
  const spec: PanquMissionSpec = { schema: 'panqu.mission.v1', requirement: { source: 'fixture-requirement', statement: 'One decodable matching video and a task-bound debit receipt.', confirmed: true,
    modelId: 'fixture-model-a', mode: 'text-to-video', kind: 'video' }, maxMilliCredits: 1000, materials: [], proposal: { variantId: 'expensive' } };
  return { root, catalog, spec };
}

type Fault = 'none' | 'pending' | 'lost-submit' | 'foreign-task' | 'bad-media' | 'empty-asset' | 'overrun' | 'remote-failure';
async function service(fault: Fault = 'none') {
  const counts = { submit: 0, observe: 0, asset: 0, csrf: 0 }; const received: Array<Record<string, string>> = []; const assetHeaders: unknown[] = [];
  const server = createServer(async (request, response) => {
    const send = (body: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(body)); };
    if (request.url === '/ajax/refreshtoken') { counts.csrf++; send({ data: { __token__: 'fixture-only-csrf' } }); return; }
    if (request.url === '/aivideo/videonew/add') {
      counts.submit++;
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      const form = await new Request('http://fixture.invalid', { method: 'POST', headers: { 'content-type': request.headers['content-type']! }, body: Buffer.concat(parts) }).formData();
      const fields: Record<string, string> = {}; form.forEach((value, key) => { fields[key] = String(value); }); received.push(fields);
      if (fault === 'lost-submit') { request.socket.destroy(); return; }
      // Independent endpoint contract, never reads the mission spec, plan or expected assertions.
      if (form.get('model_id') !== 'fixture-model-a' || form.get('__token__') !== 'fixture-only-csrf') { send({ code: 0 }); return; }
      send({ code: 1, data: { id: 'task-a' } }); return;
    }
    if (request.url === '/aivideo/v2/task_status/apiGetStatus') {
      counts.observe++;
      send({ code: 1, data: [{ id: fault === 'foreign-task' ? 'task-other' : 'task-a', status: { id: 'task-a',
        task_status: fault === 'remote-failure' ? 4 : fault === 'pending' && counts.observe === 1 ? 2 : 3, progress: 50,
        video_url: fault === 'empty-asset' ? undefined : '/asset.mp4' } }] }); return;
    }
    if (request.url === '/billing/task-a') { send({ taskId: 'task-a', milliCredits: fault === 'overrun' ? 900 : 100 }); return; }
    if (request.url === '/canvas-workflow/execute') {
      counts.submit++;
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString());
      if (body.mode !== 'node' || body.nodeId !== 'node-a' || body.projectId !== 'project-a' || !/^[a-f0-9]{64}$/.test(body.requestId)) { response.statusCode = 400; response.end(); return; }
      send({ taskId: 'task-a', status: 'submitted' }); return;
    }
    if (request.url === '/canvas-workflow/tasks/task-a') {
      counts.observe++;
      send({ taskId: 'task-a', projectId: 'project-a', status: 'success', nodeRuns: [{ nodeId: 'node-a', status: 'success', outputs: { out: { type: 'video', payload: { items: [{ url: '/asset.mp4' }] } } } }] }); return;
    }
    if (request.url === '/asset.mp4') { counts.asset++; assetHeaders.push(request.headers.authorization); response.end(fault === 'bad-media' ? '<html>not a video</html>' : clip); return; }
    response.statusCode = 404; response.end();
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as { port: number }).port}`, counts, received, assetHeaders };
}
function runtime(root: string, plan: PanquMissionPlan, origin: string, receipt = true) {
  const approval: PanquMissionApproval = { approvalId: 'fixture-operator-approved', planHash: plan.hash, maxMilliCredits: 1000,
    environment: 'local', allowedOrigin: origin, retainTestAssets: true, expiresAt: new Date(Date.now() + 600000).toISOString() };
  const driver = new PanquHttpMissionDriver({ projectRoot: root, origin, actorRef: 'fixture-actor', profile: 'PHP_VIDEO_V1', assetOrigins: [origin], mediaTools,
    headers: { Authorization: 'Bearer fixture-only-value' }, receipt: receipt ? { source: 'Independent fixture task ledger', path: '/billing/{taskId}', taskIdPointer: '/taskId', chargedMilliCreditsPointer: '/milliCredits' } : undefined });
  return { plan, approval, driver, journalDirectory: path.join(root, 'journal'), maxPolls: 1, pollIntervalMs: 0 };
}

describe('Panqu deterministic mission planning', () => {
  it('prepares a bounded test prompt without asking the model to invent input constraints', async () => {
    const { spec, catalog } = await data(); catalog.variants[0].request['row[extra][cueword]'] = '';
    expect(() => compilePanquMission(spec, catalog)).toThrow('MISSION_PROMPT_CONSTRAINTS_REQUIRED');
    catalog.promptConstraints = { source: 'fixture explicit code-point bounds', minCodePoints: 10, maxCodePoints: 100 };
    const plan = compilePanquMission(spec, catalog); expect(plan.decisions.some(item => item.code === 'TEST_PROMPT_PREPARED')).toBe(true);
    expect(String(plan.variant.request['row[extra][cueword]']).length).toBeGreaterThanOrEqual(10);
  });
  it('corrects an expensive weak-model proposal without changing the tested model', async () => {
    const { spec, catalog } = await data(); const plan = compilePanquMission(spec, catalog);
    expect(plan.variant.id).toBe('cheap'); expect(plan.variant.maxMilliCredits).toBe(100);
    expect(plan.decisions.some(item => item.code === 'MODEL_PROPOSAL_CORRECTED')).toBe(true);
    expect(spec.proposal?.variantId).toBe('expensive');
  });
  it('does not downgrade an explicitly required variant to fit the budget', async () => {
    const { spec, catalog } = await data(); spec.requirement.requiredVariantId = 'expensive'; spec.maxMilliCredits = 100;
    expect(() => compilePanquMission(spec, catalog)).toThrow('MISSION_BUDGET_INSUFFICIENT_NO_DOWNGRADE');
  });
  it.each([NaN, -1, 1.5, '100'])('rejects unknown or coerced quote costs: %s', async cost => {
    const { spec, catalog } = await data(); catalog.variants[0].maxMilliCredits = cost as number;
    expect(() => compilePanquMission(spec, catalog)).toThrow('MISSION_QUOTE_COST_UNKNOWN');
  });
  it('rejects expired capability/price evidence', async () => {
    const { spec, catalog } = await data(); catalog.expiresAt = new Date(0).toISOString();
    expect(() => compilePanquMission(spec, catalog)).toThrow('MISSION_QUOTE_EXPIRED');
  });
  it('hash-binds exact payload types, media and constraints rather than accepting model PASS claims', async () => {
    const { spec, catalog } = await data(); const before = compilePanquMission(spec, catalog);
    catalog.variants[0].request.extra = 'changed'; expect(compilePanquMission(spec, catalog).hash).not.toBe(before.hash);
  });
  it('rejects a supplied prompt without a known Nuxt node binding instead of silently dropping it', async () => {
    const { spec, catalog } = await data(); catalog.profile = 'NUXT_CANVAS_V1'; spec.prompt = 'Do not ignore this requirement';
    expect(() => compilePanquMission(spec, catalog)).toThrow('MISSION_NUXT_PROMPT_BINDING_REQUIRED');
  });
});

describe.skipIf(!mediaTools.ffmpeg || !mediaTools.ffprobe)('Panqu missions with independent real HTTP and decoded media', () => {
  it('runs the shipped CLI in separate processes and reopens the durable result without another submission', async () => {
    const { root, spec, catalog } = await data(); const server = await service();
    const cli = path.resolve('dist/bin/run-devtest.js');
    await writeFile(path.join(root, 'spec.json'), JSON.stringify(spec)); await writeFile(path.join(root, 'catalog.json'), JSON.stringify(catalog));
    const execute = (args: string[]) => exec(process.execPath, [cli, 'mission', ...args], { cwd: root,
      env: { ...process.env, PANQU_FIXTURE_ORIGIN: server.origin, PANQU_FIXTURE_HEADERS: '{}' } });
    const planned = JSON.parse((await execute(['plan', '--spec', 'spec.json', '--catalog', 'catalog.json', '--output', 'journal'])).stdout);
    expect(planned.plan_file_base).toBe('SUPPLIED_OUTPUT_DIRECTORY'); expect(path.isAbsolute(planned.plan_file)).toBe(false);
    const planFile = path.join(root, 'journal', planned.plan_file);
    const plan = JSON.parse(await readFile(planFile, 'utf8')) as PanquMissionPlan;
    const input = runtime(root, plan, server.origin);
    await writeFile(path.join(root, 'approval.json'), JSON.stringify(input.approval));
    await writeFile(path.join(root, 'config.json'), JSON.stringify({ originEnv: 'PANQU_FIXTURE_ORIGIN', headersEnv: 'PANQU_FIXTURE_HEADERS',
      actorRef: 'fixture-actor', profile: 'PHP_VIDEO_V1', mediaTools, assetOrigins: [server.origin],
      receipt: { source: 'fixture task ledger', path: '/billing/{taskId}', taskIdPointer: '/taskId', chargedMilliCreditsPointer: '/milliCredits' } }));
    const args = ['--plan', planFile, '--config', 'config.json', '--approval', 'approval.json', '--output', 'journal'];
    expect((await execute(['run', ...args])).stdout).toContain('State: PASSED');
    const counts = { ...server.counts };
    expect((await execute(['resume', ...args])).stdout).toContain('State: PASSED');
    expect((await execute(['status', '--plan', planFile, '--output', 'journal'])).stdout).toContain('Observed debit: 0.1');
    expect(server.counts).toEqual(counts); expect(server.counts.submit).toBe(1);
  });
  it('rechecks an approval that expires during local preflight before making any network call', async () => {
    const { root, spec, catalog } = await data(); const server = await service(); const input = runtime(root, compilePanquMission(spec, catalog), server.origin);
    input.driver.preflight = async () => { input.approval.expiresAt = new Date(0).toISOString(); };
    await expect(runPanquMission(input)).rejects.toThrow('MISSION_APPROVAL_EXPIRED');
    expect(server.counts).toEqual({ submit: 0, observe: 0, asset: 0, csrf: 0 });
  });
  it('executes the separate Nuxt JSON task protocol through the same persistent mission controller', async () => {
    const { root, spec, catalog } = await data(); const server = await service(); catalog.profile = 'NUXT_CANVAS_V1';
    const paths = ['composables/canvas-flow/adapters/canvas-flow-api-client.ts', 'composables/canvas-flow/core/use-execution-engine.ts', 'composables/canvas-flow/types/canvas-flow.types.ts', 'utils/myFetchInstance.ts'];
    for (const file of paths) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'fixture Nuxt binding'); }
    catalog.sourcePins = paths.map(file => ({ file, sha256: createHash('sha256').update('fixture Nuxt binding').digest('hex') }));
    catalog.variants[0].request = { projectId: 'project-a', nodeId: 'node-a', mode: 'node', graph: { nodes: [{ id: 'node-a', params: { modelId: 'fixture-model-a', durationSeconds: 1, quality: 'low' } }] } };
    const plan = compilePanquMission(spec, catalog); const input = runtime(root, plan, server.origin);
    input.driver = new PanquHttpMissionDriver({ projectRoot: root, origin: server.origin, actorRef: 'fixture-actor', profile: 'NUXT_CANVAS_V1', mediaTools, assetOrigins: [server.origin],
      nuxtBindings: { modelId: '/graph/nodes/0/params/modelId', durationSeconds: '/graph/nodes/0/params/durationSeconds', quality: '/graph/nodes/0/params/quality' },
      receipt: { source: 'fixture task-bound ledger', path: '/billing/{taskId}', taskIdPointer: '/taskId', chargedMilliCreditsPointer: '/milliCredits' } });
    expect((await runPanquMission(input)).state).toBe('PASSED'); expect(server.counts).toMatchObject({ submit: 1, observe: 1, csrf: 0 });
  });
  it('creates and decodes its own bounded reference video without touching existing files', async () => {
    const { root } = await data(); await writeFile(path.join(root, 'original.txt'), 'preserve me');
    const result = await prepareMissionReferenceClip(root, { source: 'fixture material constraints', width: 160, height: 90, durationSeconds: 1, codec: 'mpeg4', maxBytes: 100000 }, mediaTools);
    expect(result.material).toMatchObject({ kind: 'video', width: 160, height: 90, durationSeconds: 1, codec: 'mpeg4' });
    expect(await readFile(path.join(root, 'original.txt'), 'utf8')).toBe('preserve me');
  });
  it('submits actual multipart, verifies a real video and debit, and replays with zero new requests', async () => {
    const { root, spec, catalog } = await data(); const server = await service(); const plan = compilePanquMission(spec, catalog); const input = runtime(root, plan, server.origin);
    const journal = await runPanquMission(input);
    expect(journal.state, renderPanquMission(journal)).toBe('PASSED'); expect(journal.asset).toMatchObject({ width: 160, height: 90, kind: 'video', decoded: true });
    expect(journal.chargedMilliCredits).toBe(100); expect(server.received[0]['row[extra][duration]']).toBe('1');
    expect(server.assetHeaders).toEqual([undefined]); expect(JSON.stringify(journal)).not.toContain('fixture-only');
    const counts = { ...server.counts }; expect(await runPanquMission(input)).toEqual(journal); expect(server.counts).toEqual(counts);
  });
  it('resumes a pending task from persisted state with only one generation submission', async () => {
    const { root, spec, catalog } = await data(); const server = await service('pending'); const input = runtime(root, compilePanquMission(spec, catalog), server.origin);
    expect((await runPanquMission(input)).state).toBe('POLLING');
    const restartedDriver = runtime(root, input.plan, server.origin);
    expect((await runPanquMission(restartedDriver)).state).toBe('PASSED'); expect(server.counts.submit).toBe(1); expect(server.counts.observe).toBe(2);
  });
  it('does not retry or release reserved credits after the server accepts but drops the submit response', async () => {
    const { root, spec, catalog } = await data(); const server = await service('lost-submit'); const input = runtime(root, compilePanquMission(spec, catalog), server.origin);
    const result = await runPanquMission(input); expect(result).toMatchObject({ state: 'SUBMISSION_UNKNOWN', reservedMilliCredits: 100, nextAction: 'RECONCILE_SUBMISSION' });
    await runPanquMission(input); expect(server.counts.submit).toBe(1); expect(server.counts.observe).toBe(0);
  });
  it.each(['foreign-task', 'bad-media', 'empty-asset'] as const)('rejects apparent success with %s evidence', async fault => {
    const { root, spec, catalog } = await data(); const server = await service(fault);
    const result = await runPanquMission(runtime(root, compilePanquMission(spec, catalog), server.origin));
    expect(result.state, renderPanquMission(result)).toBe('BLOCKED'); expect(server.counts.submit).toBe(1);
  });
  it('keeps a valid video unverified when task-bound billing evidence is unavailable', async () => {
    const { root, spec, catalog } = await data(); const server = await service();
    const result = await runPanquMission(runtime(root, compilePanquMission(spec, catalog), server.origin, false));
    expect(result.state).toBe('BLOCKED'); expect(result.asset?.decoded).toBe(true); expect(result.chargedMilliCredits).toBeUndefined();
    expect(result.events.at(-1)?.code).toBe('BILLING_EVIDENCE_MISSING');
  });
  it.each(['overrun', 'remote-failure'] as const)('stops on %s without trying another model or submission', async fault => {
    const { root, spec, catalog } = await data(); const server = await service(fault);
    const result = await runPanquMission(runtime(root, compilePanquMission(spec, catalog), server.origin));
    expect(result.state).toBe('FAILED'); expect(server.counts.submit).toBe(1); expect(server.counts.asset).toBe(0);
  });
  it('records actual media when decoded dimensions contradict the approved variant', async () => {
    const { root, spec, catalog } = await data(); catalog.variants[0].parameters.width = 320; const server = await service();
    const result = await runPanquMission(runtime(root, compilePanquMission(spec, catalog), server.origin));
    expect(result.state).toBe('FAILED'); expect(result.asset?.width).toBe(160);
  });
  it('has zero network side effects on plan, source or approval conflicts', async () => {
    const { root, spec, catalog } = await data(); const server = await service(); const input = runtime(root, compilePanquMission(spec, catalog), server.origin);
    await expect(runPanquMission({ ...input, approval: { ...input.approval, planHash: '0'.repeat(64) } })).rejects.toThrow('MISSION_EXACT_APPROVAL_REQUIRED');
    input.plan.variant.request.injected = 'changed'; await expect(runPanquMission(input)).rejects.toThrow('MISSION_PLAN_TAMPERED');
    input.plan = compilePanquMission(spec, catalog); await writeFile(path.join(root, sources[0]), 'changed');
    await expect(runPanquMission(input)).rejects.toThrow('MISSION_SOURCE_CHANGED');
    expect(server.counts).toEqual({ submit: 0, observe: 0, asset: 0, csrf: 0 });
  });
  it('locks concurrent attempts so only one can submit', async () => {
    const { root, spec, catalog } = await data(); const server = await service(); const input = runtime(root, compilePanquMission(spec, catalog), server.origin);
    const results = await Promise.allSettled([runPanquMission(input), runPanquMission(input)]);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1); expect(server.counts.submit).toBe(1);
  });
  it('recovers a demonstrably dead owner without repeating an interrupted submission', async () => {
    const { root, spec, catalog } = await data(); const server = await service('pending'); const input = runtime(root, compilePanquMission(spec, catalog), server.origin);
    const result = await runPanquMission(input); result.state = 'SUBMITTING'; delete result.taskId;
    const file = path.join(input.journalDirectory, `${input.plan.hash}.json`); await writeFile(file, JSON.stringify(result));
    await writeFile(`${file}.lock`, JSON.stringify({ pid: 2147483647, host: hostname(), planHash: input.plan.hash }));
    expect((await runPanquMission({ ...input, recoverDeadLock: true })).state).toBe('SUBMISSION_UNKNOWN'); expect(server.counts.submit).toBe(1);
  });
  it('inspects designated media content and exposes disguised or symlinked files', async () => {
    const { root } = await data(); const folder = path.join(root, 'materials'); await mkdir(folder);
    await writeFile(path.join(folder, 'valid.mp4'), clip); await writeFile(path.join(folder, 'disguised.mp4'), 'not a video');
    await symlink(path.join(root, sources[0]), path.join(folder, 'escape.mp4'));
    const result = await inventoryMissionMedia(folder, mediaTools);
    expect(result.materials).toHaveLength(1); expect(result.materials[0]).toMatchObject({ file: 'valid.mp4', width: 160, height: 90, durationSeconds: 1 });
    expect(result.rejected.map(item => item.code)).toEqual(expect.arrayContaining(['MISSION_MEDIA_UNDECODABLE', 'MISSION_MATERIAL_SYMLINK']));
  });
});

describe('Nuxt canvas task protocol is not the PHP protocol', () => {
  it('requires task, project, node and output identity before success', () => {
    const body = { taskId: 'task-a', projectId: 'project-a', status: 'success', nodeRuns: [{ nodeId: 'node-a', status: 'success', outputs: { video: { type: 'video', payload: { items: [{ url: '/video.mp4' }] } } } }] };
    expect(decodePanquMissionTask('NUXT_CANVAS_V1', body, 'task-a', 'project-a', 'node-a', 'video')).toMatchObject({ state: 'success', assetUrl: '/video.mp4' });
    expect(() => decodePanquMissionTask('NUXT_CANVAS_V1', body, 'task-a', 'project-other', 'node-a', 'video')).toThrow('MISSION_FOREIGN_TASK_REJECTED');
    expect(decodePanquMissionTask('NUXT_CANVAS_V1', body, 'task-a', 'project-a', 'other-node', 'video').state).toBe('unknown');
  });
});
