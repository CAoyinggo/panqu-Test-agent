import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { preparePanquMission, inspectPanquMissionPreparation, panquQuoteMilliCredits, type PanquMissionPreparationConfig } from '../../src/devtest/panqu-mission-prepare.js';
import { PanquHttpMissionDriver } from '../../src/devtest/panqu-mission-driver.js';
import { revalidatePreparedPanquMission } from '../../src/devtest/panqu-mission-prepare.js';
import { runPanquMission } from '../../src/devtest/panqu-mission-runtime.js';
import type { PanquMissionIntent, PanquMissionReadAccess, PanquMissionPlan } from '../../src/devtest/panqu-mission-types.js';

const exec = promisify(execFile);
const roots: string[] = []; const servers: Server[] = [];
const sources = ['composables/canvas-flow/adapters/canvas-flow-api-client.ts', 'composables/canvas-flow/core/use-execution-engine.ts',
  'composables/canvas-flow/types/canvas-flow.types.ts', 'utils/myFetchInstance.ts', 'composables/admin/usePlatform.ts',
  'composables/admin/usePlatform.types.ts', 'composables/billing/useEstimatedBilling.ts', 'plugins/myFetch.ts',
  'components/canvas-flow/plugins/video-node/VideoPanel.vue', 'components/canvas-flow/plugins/video-node/video-generate-mode.ts',
  'components/canvas-flow/plugins/video-node/use-video-node-platform-models.ts', 'components/canvas-flow/plugins/shared/model-option-identity.ts'];
const binary = (name: string) => (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, name)).find(file => path.isAbsolute(file) && existsSync(file));
const mediaTools = { ffmpeg: binary('ffmpeg')!, ffprobe: binary('ffprobe')! };
let clipRoot: string; let clip: Buffer;
beforeAll(async () => {
  if (!mediaTools.ffmpeg || !mediaTools.ffprobe) return;
  clipRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'panqu-preparation-clip-'));
  await exec(mediaTools.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=160x90:r=10:d=1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', path.join(clipRoot, 'clip.mp4')]);
  clip = await readFile(path.join(clipRoot, 'clip.mp4'));
});
afterAll(async () => { if (clipRoot) await rm(clipRoot, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** Independent application fixture: endpoint contracts and prices never read the planner's assertions. */
async function setup() {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'panqu-preparation-test-')); roots.push(root);
  for (const file of sources) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    const source = file.endsWith('/usePlatform.ts') ? 'export const getModelsByType = (type: string) => myFetch(`/integration-platform/models/strict/${encodeURIComponent(type)}`);'
      : file.endsWith('/canvas-flow-api-client.ts') ? 'export const canvasFlowApi = { execute: (data: unknown) => myFetch("/canvas-workflow/execute", {method:"POST",body:data}), getCanvasFlow: (projectId: string) => myFetch(`/project/${projectId}/canvas-flow`) };'
        : file.endsWith('.vue') ? '<script setup lang="ts">function fetchEstimatedCost(){return myFetch("/integration-platform/models/estimatedBilling", {method:"POST",body:{params:{}}});} function buildVideoGenParamsForRequest(){return {resolution:videoParams.resolution,output_format:videoParams.output_format,aspect_ratio:videoParams.aspect_ratio,audio:videoParams.audio,duration:videoParams.duration};}</script>'
          : 'export const fixture = true;';
    await writeFile(path.join(root, file), source);
  }
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ dependencies: { nuxt: 'fixture', '@vue-flow/core': 'fixture' } }));
  await writeFile(path.join(root, 'composables/canvas-flow/core/use-plugin-registry.ts'), 'export const fixture = true;');
  const model = { name: 'provider-video', alias: 'fixture.alias', panqu_selmodels_id: 7, enabled: true, types: ['video_generate'],
    capabilities: { video_generate: { output_resolutions: ['low', 'high'], aspect_ratio_allowed: ['16:9'],
      duration_options: { low: [1, 2], high: [2] }, output_audio: false, output_formats: ['mp4'], default_output_format: 'mp4',
      prompt_length_limit: { max: 100, count_mode: 'unicode' } } } };
  const canvas = { flowVersion: 5, updated_at: '2026-09-09T00:00:00.000Z', flowEdges: [] as Array<Record<string, unknown>>,
    flowNodes: [{ id: 'node-a', type: 'media.video', position: { x: 12, y: 24 }, data: { mode: 'generate', videoGenerateMode: 'text_to_video',
      prompt: 'A small red ball moves slowly.', model: 'fixture.alias', videoGenParams: { resolution: 'high', duration: 2, aspect_ratio: '16:9', audio: false, output_format: 'mp4' },
      referenceImageUrls: [] as string[] } }] };
  const state = { models: [model], canvas, prices: { 'low:1': 0.1, 'low:2': 0.2, 'high:2': 0.4 } as Record<string, number>,
    quoteFaultAt: 0, quoteErrorBody: false, quoteConflict: false, wrongQuoteModel: false, dropSubmit: false, pending: false, quoteHook: undefined as undefined | (() => Promise<void>),
    modelDelayMs: 0, counters: { models: 0, canvas: 0, estimates: 0, submit: 0, observe: 0, asset: 0 },
    quoteParams: [] as Array<Record<string, unknown>>, submissions: [] as Array<Record<string, unknown>> };
  const server = createServer(async (request, response) => {
    const send = (data: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(data)); };
    if (request.url === '/integration-platform/models/strict/video_generate' && request.method === 'GET') {
      state.counters.models++; if (state.modelDelayMs) await new Promise(resolve => setTimeout(resolve, state.modelDelayMs)); send(state.models); return;
    }
    if (request.url === '/project/project-a/canvas-flow' && request.method === 'GET') { state.counters.canvas++; send(state.canvas); return; }
    if (request.url === '/aivideo/v2/video/getPanquaivideoModels') { state.counters.models++; send({ code: 1, data: [{ id: 7, wssp: true, resolution: ['720p'] }] }); return; }
    if (request.url === '/integration-platform/models/estimatedBilling' && request.method === 'POST') {
      state.counters.estimates++;
      const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      const params = JSON.parse(Buffer.concat(parts).toString()).params; state.quoteParams.push(params);
      if (state.quoteHook) await state.quoteHook();
      if (state.quoteFaultAt === state.counters.estimates) { response.statusCode = 503; send({ message: 'fixture private raw error must not leak' }); return; }
      const key = `${params.resolution}:${params.duration}`;
      if (params.model !== 'fixture.alias' || !(key in state.prices) || params.videoGenerateMode !== 'text_to_video' || params.audio !== false) {
        response.statusCode = 400; send({ error: 'invalid fixture estimate contract' }); return;
      }
      send({ code: 1, data: state.quoteErrorBody ? { success: false, amount: 0.1, error: 'fixture private raw error must not leak' }
        : { amount: String(state.prices[key]), estimatedPower: state.quoteConflict ? 999 : state.prices[key],
          ...(state.wrongQuoteModel ? { calculation: { platformModelDiscount: { model: { name: 'other-provider-model' } } } } : {}) } }); return;
    }
    if (request.url === '/canvas-workflow/execute' && request.method === 'POST') {
      state.counters.submit++; const parts: Buffer[] = []; for await (const part of request) parts.push(Buffer.from(part));
      const body = JSON.parse(Buffer.concat(parts).toString()); state.submissions.push(body);
      if (state.dropSubmit) { request.socket.destroy(); return; }
      if (body.mode !== 'node' || body.nodeId !== 'node-a' || body.projectId !== 'project-a' || body.graph.nodes.length !== 1
        || body.graph.nodes[0].data.model !== 'fixture.alias' || body.graph.nodes[0].data.panqu_selmodels_id !== 7 || body.graph.version !== 5) {
        response.statusCode = 400; send({ error: 'invalid independent execute contract' }); return;
      }
      send({ taskId: 'task-a', status: 'submitted' }); return;
    }
    if (request.url === '/canvas-workflow/tasks/task-a') {
      state.counters.observe++; send({ taskId: 'task-a', projectId: 'project-a', status: state.pending ? 'running' : 'success',
        nodeRuns: [{ nodeId: 'node-a', status: 'success', outputs: { out: { type: 'video', payload: { items: [{ url: '/asset.mp4' }] } } } }] }); return;
    }
    if (request.url === '/billing/task-a') { send({ taskId: 'task-a', milliCredits: 100 }); return; }
    if (request.url === '/asset.mp4') { state.counters.asset++; response.end(clip); return; }
    response.statusCode = 404; response.end();
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const intent: PanquMissionIntent = { schema: 'panqu.mission-intent.v1', intentId: 'fixture-intent',
    requirement: { source: 'independent fixture requirement', statement: 'One structurally matching video; this is not a business acceptance rule.', confirmed: true,
      modelId: 'fixture.alias', mode: 'text-to-video', kind: 'video' }, projectId: 'project-a', nodeId: 'node-a', maxMilliCredits: 1000, audio: false,
    outputProfiles: [{ source: 'fixture confirmed low output oracle', quality: 'low', aspectRatio: '16:9', width: 160, height: 90 },
      { source: 'fixture confirmed high output oracle', quality: 'high', aspectRatio: '16:9', width: 320, height: 180 }] };
  const config: PanquMissionPreparationConfig = { projectRoot: root, origin, profile: 'NUXT_CANVAS_V1', actorRef: 'fixture-actor', headers: { Authorization: 'Bearer fixture-read-identity' } };
  const access: PanquMissionReadAccess = { schema: 'panqu.mission-read-access.v1', accessId: 'fixture-read-only', allowedOrigin: origin,
    projectId: 'project-a', environment: 'local', actorRef: 'fixture-actor', expiresAt: new Date(Date.now() + 600000).toISOString(),
    scope: 'MODELS_CANVAS_ESTIMATE_ONLY', estimateUnit: 'PANQU_CREDIT', maxEstimateRequests: 24 };
  const input = { intent, config, access, directory: path.join(root, 'journal') };
  const run = (plan: PanquMissionPlan) => runPanquMission({ plan, approval: { approvalId: 'fixture-generation-approval', planHash: plan.hash, maxMilliCredits: 1000,
    allowedOrigin: origin, environment: 'local', expiresAt: new Date(Date.now() + 600000).toISOString(), retainTestAssets: true }, journalDirectory: input.directory,
    driver: new PanquHttpMissionDriver({ ...config, mediaTools, assetOrigins: [origin], receipt: { source: 'fixture task-bound ledger', path: '/billing/{taskId}', taskIdPointer: '/taskId', chargedMilliCreditsPointer: '/milliCredits' } }),
    maxPolls: 1, pollIntervalMs: 0 });
  return { root, state, input, run };
}

describe('Panqu live task preparation without model-authored catalogs', () => {
  it('provides useful source readiness without needing an environment or issuing any network request', async () => {
    const { root, state } = await setup(); const result = await inspectPanquMissionPreparation(root);
    expect(result.state, JSON.stringify(result.problems)).toBe('ADAPTER_READY'); expect(result.profile).toBe('NUXT_CANVAS_V1');
    expect(result.sourcePins).toHaveLength(sources.length); expect(Object.values(state.counters).every(value => value === 0)).toBe(true);
  });
  it('reads the actual node and conditional capabilities, prices every candidate and persists the cheapest plan without submitting', async () => {
    const { state, input } = await setup(); const original = structuredClone(state.canvas); input.intent.proposal = { variantId: 'expensive-model-suggestion' };
    const result = await preparePanquMission(input);
    expect(result.state, JSON.stringify(result.problems)).toBe('READY_FOR_APPROVAL'); expect(result.requests).toEqual({ models: 1, canvas: 1, estimates: 3, generation: 0 });
    expect(result.plan?.variant.parameters).toMatchObject({ quality: 'low', durationSeconds: 1 }); expect(result.plan?.variant.maxMilliCredits).toBe(100);
    expect(result.plan?.decisions.some(decision => decision.code === 'MODEL_PROPOSAL_CORRECTED')).toBe(true);
    expect(state.quoteParams.map(params => `${params.resolution}:${params.duration}`)).toEqual(['low:1', 'low:2', 'high:2']);
    expect(state.canvas).toEqual(original); expect(state.counters.submit).toBe(0);
    expect(JSON.parse(await readFile(path.join(input.directory, result.planFile!), 'utf8')).hash).toBe(result.plan?.hash);
    expect(JSON.stringify(result)).not.toContain('fixture-read-identity'); expect(result.plan?.sourcePins).toHaveLength(sources.length);
  });
  it('chooses a cheaper longer duration from prices instead of assuming shortest duration is cheapest', async () => {
    const { state, input } = await setup(); state.prices['low:2'] = 0.05;
    const result = await preparePanquMission(input); expect(result.plan?.variant.parameters.durationSeconds).toBe(2); expect(result.plan?.variant.maxMilliCredits).toBe(50);
  });
  it('preserves an explicitly required high profile instead of fitting the budget by downgrading', async () => {
    const { state, input } = await setup(); input.intent.required = { quality: 'high' }; input.intent.maxMilliCredits = 100;
    const result = await preparePanquMission(input); expect(result.problems[0].code).toBe('MISSION_BUDGET_INSUFFICIENT_NO_DOWNGRADE'); expect(result.plan).toBeUndefined();
    expect(state.quoteParams.map(params => params.resolution)).toEqual(['high']); expect(state.counters.submit).toBe(0);
  });
  it('requires a finite explicit duration domain and never invents a step or samples away candidates', async () => {
    const { state, input } = await setup(); const cap = state.models[0].capabilities.video_generate as Record<string, unknown>;
    delete cap.duration_options; cap.duration_range = [1, 10];
    const result = await preparePanquMission(input); expect(result.problems[0].code).toBe('MISSION_CAPABILITY_FINITE_DURATION_REQUIRED'); expect(state.counters.estimates).toBe(0);
  });
  it('supports a confirmed fixed boundary within a larger step-based domain without truncating it', async () => {
    const { state, input } = await setup(); const cap = state.models[0].capabilities.video_generate as Record<string, unknown>;
    delete cap.duration_options; cap.duration_range = [1, 120]; cap.duration_step = 1;
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_CANDIDATE_LIMIT_REQUIRES_SCOPE');
    input.intent.required = { quality: 'low', durationSeconds: 2 };
    expect((await preparePanquMission(input)).plan?.variant.parameters.durationSeconds).toBe(2);
  });
  it.each(['expired', 'wrong-origin', 'generation-scope', 'unknown-unit'] as const)('rejects %s read permission before network', async fault => {
    const { state, input } = await setup();
    if (fault === 'expired') input.access.expiresAt = new Date(0).toISOString();
    if (fault === 'wrong-origin') input.access.allowedOrigin = 'http://127.0.0.1:1';
    if (fault === 'generation-scope') input.access.scope = 'ALLOW_GENERATION' as never;
    if (fault === 'unknown-unit') input.access.estimateUnit = 'USD' as never;
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_READ_ACCESS_INVALID'); expect(Object.values(state.counters).every(value => value === 0)).toBe(true);
  });
  it('rejects malformed relevant source before requests and records a source-specific gap', async () => {
    const { root, state, input } = await setup(); await writeFile(path.join(root, sources[0]), 'export const =');
    expect((await preparePanquMission(input)).problems[0]).toMatchObject({ code: 'MISSION_SOURCE_PARSE_ERROR', sourceFile: sources[0] }); expect(state.counters.models).toBe(0);
  });
  it('does not label a partial price sweep cheapest or produce an executable plan', async () => {
    const { state, input } = await setup(); state.quoteFaultAt = 2;
    const result = await preparePanquMission(input); expect(result.state).toBe('BLOCKED'); expect(result.plan).toBeUndefined(); expect(state.counters.estimates).toBe(2);
    expect(result.problems[0].variantId).toMatch(/^video-/); expect(result.problems[0].field).toBe('estimatedBilling.params');
    expect((await readdir(input.directory)).some(file => file.endsWith('.plan.json'))).toBe(false); expect(JSON.stringify(result)).not.toContain('fixture private raw error');
  });
  it.each(['error', 'conflict'] as const)('rejects a numeric-looking %s price response', async fault => {
    const { state, input } = await setup(); state.quoteErrorBody = fault === 'error'; state.quoteConflict = fault === 'conflict';
    const result = await preparePanquMission(input); expect(result.state).toBe('BLOCKED'); expect(result.plan).toBeUndefined(); expect(state.counters.submit).toBe(0);
  });
  it('rejects an estimator response that explicitly belongs to another model', async () => {
    const { state, input } = await setup(); state.wrongQuoteModel = true;
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_QUOTE_MODEL_MISMATCH'); expect(state.counters.submit).toBe(0);
  });
  it('checks the entire candidate request budget before issuing any estimate POST', async () => {
    const { state, input } = await setup(); input.access.maxEstimateRequests = 2;
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_ESTIMATE_REQUEST_BUDGET_EXCEEDED'); expect(state.counters.estimates).toBe(0);
  });
  it.each(['references', 'upstream'] as const)('refuses to drop meaningful %s from the existing node', async fault => {
    const { state, input } = await setup();
    if (fault === 'references') state.canvas.flowNodes[0].data.referenceImageUrls = ['https://fixture.invalid/reference.png'];
    else state.canvas.flowEdges.push({ source: 'upstream', target: 'node-a' });
    const result = await preparePanquMission(input); expect(result.state).toBe('BLOCKED'); expect(state.counters.estimates).toBe(0);
  });
  it('rejects duplicate aliases and never resolves identity from a display name', async () => {
    const { state, input } = await setup(); state.models.push(structuredClone(state.models[0]));
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_MODEL_IDENTITY_AMBIGUOUS_OR_MISSING'); expect(state.counters.canvas).toBe(0);
  });
  it('does not infer pixel dimensions from quality labels when the explicit output oracle is missing', async () => {
    const { state, input } = await setup(); input.intent.outputProfiles = [];
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_OUTPUT_ORACLES_REQUIRED'); expect(state.counters.models).toBe(0);
  });
  it('detects source changes during price collection before saving a plan', async () => {
    const { root, state, input } = await setup(); const original = await readFile(path.join(root, sources[0]), 'utf8');
    state.quoteHook = async () => { await writeFile(path.join(root, sources[0]), `${original}\n// changed while quoting`); };
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_SOURCE_CHANGED_DURING_PREPARATION'); expect(state.counters.submit).toBe(0);
  });
  it('does not follow a changed source route merely because the old route remains in a comment', async () => {
    const { root, state, input } = await setup(); const file = path.join(root, sources[0]);
    const source = await readFile(file, 'utf8'); await writeFile(file, source.replace('/canvas-workflow/execute', '/canvas-workflow/execute-new') + '\n// /canvas-workflow/execute');
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_SOURCE_ROUTE_CONTRACT_CHANGED'); expect(state.counters.models).toBe(0);
  });
  it('does not ignore extra intent fields that might carry an omitted requirement', async () => {
    const { state, input } = await setup(); Object.assign(input.intent, { referenceVideos: ['fixture-only.mp4'] });
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_INTENT_UNSUPPORTED_FIELD'); expect(state.counters.models).toBe(0);
  });
  it('does not interpret malformed input bindings as an empty safe node', async () => {
    const { state, input } = await setup(); Object.assign(state.canvas.flowNodes[0].data, { paramBindings: ['upstream-input'] });
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_REFERENCE_INPUTS_REQUIRE_ADAPTER'); expect(state.counters.estimates).toBe(0);
  });
  it('checks explicit pixel limits from capabilities in addition to the output oracle', async () => {
    const { state, input } = await setup(); Object.assign(state.models[0].capabilities.video_generate, { width_height_range: [16, 200] });
    expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_OUTPUT_PROFILE_NOT_SUPPORTED'); expect(state.counters.estimates).toBe(0);
  });
  it('cannot reprice one payload while executing a different prompt or hide a cheaper candidate', async () => {
    const { input } = await setup(); const prepared = await preparePanquMission(input);
    const payload = structuredClone(prepared.plan!);
    (payload.variant.request.graph as { nodes: Array<{ data: { prompt: string } }> }).nodes[0].data.prompt = 'Different unquoted prompt';
    await expect(revalidatePreparedPanquMission(payload, input.config, AbortSignal.timeout(5000))).rejects.toThrow('MISSION_PREPARATION_PAYLOAD_MISMATCH');
    const incomplete = structuredClone(prepared.plan!); incomplete.variant.preparation!.quotes.pop();
    await expect(revalidatePreparedPanquMission(incomplete, input.config, AbortSignal.timeout(5000))).rejects.toThrow('MISSION_PREPARATION_QUOTE_SCOPE_MISMATCH');
  });
  it('serializes concurrent preparations under the logical intent rather than duplicating price sweeps', async () => {
    const { state, input } = await setup(); state.modelDelayMs = 20;
    const results = await Promise.all([preparePanquMission(input), preparePanquMission(input)]);
    expect(results.map(result => result.state).sort()).toEqual(['BLOCKED', 'READY_FOR_APPROVAL']); expect(state.counters.models).toBe(1); expect(state.counters.estimates).toBe(3);
  });
  it('reports the exact PHP planner gap instead of reusing Nuxt prices or duration assumptions', async () => {
    const { root, state, input } = await setup(); input.config.profile = 'PHP_VIDEO_V1';
    for (const file of ['lib/api/video.ts', 'lib/api/taskStatus.ts', 'lib/api/request.ts', 'lib/api/csrf.ts', 'lib/api/url.ts', 'components/nodes/videoNode.tsx', 'types/video.ts']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'export const fixture = true;');
    }
    const result = await preparePanquMission(input); expect(result.problems[0].code).toBe('MISSION_PHP_AUTOPLAN_CONTRACT_MISSING'); expect(state.counters.models).toBe(1); expect(state.counters.estimates).toBe(0);
  });
});

describe('Panqu quote decimal conversion', () => {
  it.each([[0.1, 100], ['0.0001', 1], ['1.123456', 1124], [0, 0]])('rounds %s upward to %s milli-credits', (value, expected) => {
    expect(panquQuoteMilliCredits({ code: 1, data: { amount: value } })).toBe(expected);
  });
  it.each([-1, NaN, Infinity, 'unknown', '1e9'])('rejects invalid or ambiguous amount %s', value => {
    expect(() => panquQuoteMilliCredits(value)).toThrow('MISSION_QUOTE_AMOUNT_INVALID');
  });
});

describe.skipIf(!mediaTools.ffmpeg || !mediaTools.ffprobe)('Prepared missions with real transport and decoded output', () => {
  it('runs from automatically prepared payloads, refreshes every quote and verifies the same task and media', async () => {
    const { state, input, run } = await setup(); const prepared = await preparePanquMission(input);
    const journal = await run(prepared.plan!); expect(journal.state).toBe('PASSED'); expect(journal.asset?.decoded).toBe(true);
    expect(state.counters.estimates).toBe(6); expect(state.counters.submit).toBe(1);
    const before = { ...state.counters }; const again = await preparePanquMission(input);
    expect(again.nextAction).toBe('REVIEW_EXISTING_RESULT'); expect(again.existingPlanHash).toBe(prepared.plan?.hash); expect(state.counters).toEqual(before);
  });
  it.each(['model', 'canvas', 'unselected-price'] as const)('blocks a changed %s before generation, even with an old exact approval', async fault => {
    const { state, input, run } = await setup(); const prepared = await preparePanquMission(input);
    if (fault === 'model') state.models[0].enabled = false;
    if (fault === 'canvas') state.canvas.flowVersion++;
    if (fault === 'unselected-price') state.prices['high:2'] = 0.01;
    const journal = await run(prepared.plan!); expect(journal.state).toBe('BLOCKED'); expect(journal.submissionAttempts).toBe(0); expect(state.counters.submit).toBe(0);
  });
  it('supersedes an unsubmitted plan atomically and rejects its old approval before network', async () => {
    const { state, input, run } = await setup(); const old = await preparePanquMission(input); state.prices['low:1'] = 0.11;
    const current = await preparePanquMission(input); expect(current.plan?.hash).not.toBe(old.plan?.hash);
    const before = { ...state.counters }; await expect(run(old.plan!)).rejects.toThrow('MISSION_INTENT_PLAN_SUPERSEDED'); expect(state.counters).toEqual(before);
  });
  it.each(['pending', 'lost-submit'] as const)('re-entry after %s returns the existing task without another discovery or generation', async fault => {
    const { state, input, run } = await setup(); state.pending = fault === 'pending'; state.dropSubmit = fault === 'lost-submit';
    const prepared = await preparePanquMission(input); await run(prepared.plan!); const before = { ...state.counters };
    const result = await preparePanquMission(input); expect(result.state).toBe('EXISTING_TASK');
    expect(result.nextAction).toBe(fault === 'pending' ? 'RESUME_EXISTING_TASK' : 'RECONCILE_SUBMISSION'); expect(state.counters).toEqual(before); expect(state.counters.submit).toBe(1);
  });
  it('can recover existing task identity after the separate read grant expires without renewing read access', async () => {
    const { state, input, run } = await setup(); state.pending = true; const prepared = await preparePanquMission(input); await run(prepared.plan!);
    input.access.expiresAt = new Date(0).toISOString(); const before = { ...state.counters };
    expect((await preparePanquMission(input)).nextAction).toBe('RESUME_EXISTING_TASK'); expect(state.counters).toEqual(before);
  });
  it('blocks a refresh racing an active run under the same intent lock', async () => {
    const { state, input, run } = await setup(); const prepared = await preparePanquMission(input);
    let announce!: () => void; let release!: () => void;
    const entered = new Promise<void>(resolve => { announce = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
    state.quoteHook = async () => { announce(); await gate; };
    const active = run(prepared.plan!); await entered;
    try { expect((await preparePanquMission(input)).problems[0].code).toBe('MISSION_RUN_IN_PROGRESS'); }
    finally { release(); }
    expect((await active).state).toBe('PASSED'); expect(state.counters.submit).toBe(1);
  });
  it('ships a CLI that prepares and runs without any operator-authored catalog, payload or JSON pointer', async () => {
    const { root, state, input } = await setup();
    await writeFile(path.join(root, 'intent.json'), JSON.stringify(input.intent)); await writeFile(path.join(root, 'access.json'), JSON.stringify(input.access));
    await writeFile(path.join(root, 'runtime.json'), JSON.stringify({ profile: 'NUXT_CANVAS_V1', actorRef: 'fixture-actor', originEnv: 'PANQU_PREPARE_ORIGIN', headersEnv: 'PANQU_PREPARE_HEADERS',
      mediaTools, assetOrigins: [input.config.origin], receipt: { source: 'fixture task ledger', path: '/billing/{taskId}', taskIdPointer: '/taskId', chargedMilliCreditsPointer: '/milliCredits' } }));
    const cli = path.resolve('dist/bin/run-devtest.js');
    const command = (args: string[]) => exec(process.execPath, [cli, 'mission', ...args], { cwd: root, env: { ...process.env, PANQU_PREPARE_ORIGIN: input.config.origin, PANQU_PREPARE_HEADERS: '{}' } });
    const output = JSON.parse((await command(['prepare', '--intent', 'intent.json', '--access', 'access.json', '--config', 'runtime.json', '--output', 'journal'])).stdout);
    expect(output.state).toBe('READY_FOR_APPROVAL'); expect(output.plan).toBeUndefined(); expect(state.counters.submit).toBe(0);
    await writeFile(path.join(root, 'approval.json'), JSON.stringify({ approvalId: 'fixture-explicit-generation', planHash: output.planHash, maxMilliCredits: 1000,
      allowedOrigin: input.config.origin, environment: 'local', expiresAt: input.access.expiresAt, retainTestAssets: true }));
    expect((await command(['run', '--plan', path.join('journal', output.planFile), '--config', 'runtime.json', '--approval', 'approval.json', '--output', 'journal'])).stdout).toContain('State: PASSED');
    expect(state.counters.submit).toBe(1);
  });
});
