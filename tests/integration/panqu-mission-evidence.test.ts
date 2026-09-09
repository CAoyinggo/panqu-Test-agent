import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { PanquHttpMissionDriver, type PanquHttpMissionConfig, decodePanquMissionTask } from '../../src/devtest/panqu-mission-driver.js';
import { compilePanquMission } from '../../src/devtest/panqu-mission-plan.js';
import { runPanquMission, renderPanquMission } from '../../src/devtest/panqu-mission-runtime.js';
import { acceptPanquTaskEvidence, createPanquMissionEvidence } from '../../src/devtest/panqu-mission-evidence.js';
import type { PanquMissionPlan, PanquMissionApproval, PanquMissionObservation } from '../../src/devtest/panqu-mission-types.js';

const exec = promisify(execFile);
// Fixed source-version input, independent of the wall clock; expected normalization is intentionally exact.
const FIXED_ISO = '2026-09-09T00:00:02.000Z';
const roots: string[] = []; const servers: Server[] = [];
const binary = (name: string) => (process.env.PATH ?? '').split(path.delimiter).map(dir => path.join(dir, name)).find(file => path.isAbsolute(file) && existsSync(file));
const mediaTools = { ffprobe: binary('ffprobe')!, ffmpeg: binary('ffmpeg')! };
let clipRoot: string; let clip: Buffer;
beforeAll(async () => {
  if (!mediaTools.ffmpeg || !mediaTools.ffprobe) return;
  clipRoot = await mkdtemp(path.join(await realpath(tmpdir()), 'panqu-business-evidence-clip-'));
  await exec(mediaTools.ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=10:d=1', '-c:v', 'mpeg4', '-pix_fmt', 'yuv420p', path.join(clipRoot, 'out.mp4')]);
  clip = await readFile(path.join(clipRoot, 'out.mp4'));
});
afterAll(async () => { if (clipRoot) await rm(clipRoot, { recursive: true, force: true }); });
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); })));
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

/** The fixture owns its task lifecycle, asset bytes and lagging ledger independently of the runner. */
async function setup(expectedWidth = 160) {
  const root = await mkdtemp(path.join(await realpath(tmpdir()), 'panqu-business-evidence-')); roots.push(root);
  const files = ['composables/canvas-flow/adapters/canvas-flow-api-client.ts', 'composables/canvas-flow/core/use-execution-engine.ts',
    'composables/canvas-flow/types/canvas-flow.types.ts', 'utils/myFetchInstance.ts'];
  for (const file of files) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), 'export const fixture = true;'); }
  const state = { task: 'success', ledger: 'pending' as unknown, debit: 100 as unknown, refund: 0 as unknown, wrongReceipt: false, wrongRequest: false,
    ledgerStatus: 200, ledgerError: false, mediaStatus: 200, taskUnavailable: false, updatedAt: '2026-09-09T00:00:02.000Z',
    requestId: '', counts: { submit: 0, task: 0, billing: 0, media: 0 }, assetAuth: [] as Array<string | undefined> };
  const server = createServer(async (req, res) => {
    const send = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
    if (req.url === '/canvas-workflow/execute' && req.method === 'POST') {
      state.counts.submit++; const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); state.requestId = body.requestId;
      if (body.projectId !== 'project-a' || body.nodeId !== 'node-a' || body.mode !== 'node' || body.graph.nodes[0].params.model !== 'model-a') { res.statusCode = 400; send({ error: 'fixture scope rejected' }); return; }
      send({ taskId: 'canvas-task-a', status: 'submitted' }); return;
    }
    if (req.url === '/canvas-workflow/tasks/canvas-task-a' && req.method === 'GET') {
      state.counts.task++;
      if (state.taskUnavailable) { res.statusCode = 503; send({ error: 'fixture private task error' }); return; }
      send({ taskId: 'canvas-task-a', requestId: state.wrongRequest ? 'another-request' : state.requestId, projectId: 'project-a', status: state.task,
        updated_at: state.updatedAt, nodeRuns: [{ nodeId: 'node-a', nodeType: 'media.video', status: state.task,
          outputs: { out: { type: 'video', payload: { items: [{ id: 'media-result-a', url: '/asset.mp4?signature=fixture-private-signature' }] } } } }] }); return;
    }
    if (req.url === '/ledger/canvas-task-a' && req.method === 'GET') {
      state.counts.billing++; res.statusCode = state.ledgerStatus;
      send({ taskId: state.wrongReceipt ? 'provider-task-a' : 'canvas-task-a', state: state.ledger, debit: state.debit, refund: state.refund,
        ...(state.ledgerError ? { success: false, error: 'fixture private ledger error' } : {}), privateNote: 'fixture private ledger text' }); return;
    }
    if (req.url?.startsWith('/asset.mp4')) {
      state.counts.media++; state.assetAuth.push(req.headers.authorization); res.statusCode = state.mediaStatus;
      res.end(state.mediaStatus === 200 ? clip : 'fixture private storage error'); return;
    }
    res.statusCode = 404; send({ error: 'fixture endpoint not found' });
  });
  servers.push(server); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const plan = compilePanquMission({ schema: 'panqu.mission.v1', requirement: { source: 'independent test requirement', statement: 'One decoded video and final task-bound net cost.', confirmed: true, modelId: 'model-a', mode: 'text-to-video', kind: 'video' }, maxMilliCredits: 100, materials: [] },
    { schema: 'panqu.catalog.v1', profile: 'NUXT_CANVAS_V1', source: 'independent test quote', expiresAt: new Date(Date.now() + 600000).toISOString(), projectId: 'project-a', nodeId: 'node-a',
      sourcePins: files.map(file => ({ file, sha256: createHash('sha256').update('export const fixture = true;').digest('hex') })), variants: [{ id: 'one', modelId: 'model-a', mode: 'text-to-video', maxMilliCredits: 100,
        parameters: { durationSeconds: 1, width: expectedWidth, height: 90, quality: 'low', count: 1 },
        request: { projectId: 'project-a', nodeId: 'node-a', mode: 'node', graph: { nodes: [{ id: 'node-a', params: { model: 'model-a', quality: 'low', duration: 1 } }] } } }] });
  const config: PanquHttpMissionConfig = { projectRoot: root, origin, profile: 'NUXT_CANVAS_V1', actorRef: 'fixture-actor', mediaTools, assetOrigins: [origin], headers: { Authorization: 'Bearer fixture-identity-only' },
    nuxtBindings: { modelId: '/graph/nodes/0/params/model', quality: '/graph/nodes/0/params/quality', durationSeconds: '/graph/nodes/0/params/duration' },
    receipt: { source: 'Independent fixture ledger; explicit finality and gross/refund units', path: '/ledger/{taskId}', taskIdPointer: '/taskId', chargedMilliCreditsPointer: '/debit',
      settlement: { statePointer: '/state', finalValue: 'settled', pendingValues: ['pending', 'refunding'], amountMeaning: 'DEBIT_MINUS_REFUND', refundedMilliCreditsPointer: '/refund' } } };
  const approval: PanquMissionApproval = { approvalId: 'fixture-explicit-approval', planHash: plan.hash, maxMilliCredits: 100, allowedOrigin: origin, environment: 'local', expiresAt: new Date(Date.now() + 600000).toISOString(), retainTestAssets: true };
  const input = () => ({ plan, approval, driver: new PanquHttpMissionDriver(config), journalDirectory: path.join(root, 'journal'), maxPolls: 1, pollIntervalMs: 0 });
  return { root, state, plan, config, approval, input, run: () => runPanquMission(input()) };
}

describe.skipIf(!mediaTools.ffmpeg || !mediaTools.ffprobe)('Panqu staged business evidence with independent HTTP and real decoded media', () => {
  it('persists successful media while settlement is pending and restarts with billing-only reads', async () => {
    const f = await setup(); const first = await f.run();
    expect(first.state).toBe('SETTLING'); expect(first.asset?.decoded).toBe(true); expect(first.chargedMilliCredits).toBeUndefined();
    expect(first.evidence?.next).toEqual({ action: 'OBSERVE_SETTLEMENT', missing: ['FINAL_SETTLEMENT'] });
    f.state.taskUnavailable = true; f.state.mediaStatus = 503; f.state.ledger = 'settled';
    const done = await f.run(); expect(done.state).toBe('PASSED'); expect(done.chargedMilliCredits).toBe(100);
    expect(f.state.counts).toEqual({ submit: 1, task: 1, billing: 2, media: 1 });
    expect(done.evidence?.requests).toEqual({ task: 1, settlement: 2, media: 1 });
    const counts = { ...f.state.counts }; await f.run(); expect(f.state.counts).toEqual(counts);
  });
  it('retains a confirmed remote failure while refund is pending, then records the actual final refund without retry', async () => {
    const f = await setup(); f.state.task = 'failed'; f.state.ledger = 'refunding';
    const waiting = await f.run(); expect(waiting.state).toBe('SETTLING'); expect(waiting.evidence?.failures).toEqual(['REMOTE_TASK_FAILED']);
    f.state.ledger = 'settled'; f.state.refund = 100;
    const result = await f.run(); expect(result.state).toBe('FAILED'); expect(result.chargedMilliCredits).toBe(0);
    expect(result.evidence?.settlement).toMatchObject({ state: 'final', debitMilliCredits: 100, refundedMilliCredits: 100, netMilliCredits: 0 });
    expect(f.state.counts).toEqual({ submit: 1, task: 1, billing: 2, media: 0 });
  });
  it('does not call failure free when a final ledger explicitly retains a charge', async () => {
    const f = await setup(); f.state.task = 'failed'; f.state.ledger = 'settled'; f.state.refund = 30;
    const result = await f.run(); expect(result.state).toBe('FAILED'); expect(result.chargedMilliCredits).toBe(70);
    expect(result.evidence?.settlement.refundedMilliCredits).toBe(30);
  });
  it('preserves task and decoded asset through a billing outage and retries only the missing receipt', async () => {
    const f = await setup(); f.state.ledgerStatus = 503;
    const first = await f.run(); expect(first.state).toBe('BLOCKED'); expect(first.asset?.decoded).toBe(true); expect(first.evidence?.task?.state).toBe('success');
    expect(first.evidence?.settlement.reason).toBe('MISSION_HTTP_REJECTED');
    f.state.ledgerStatus = 200; f.state.ledger = 'settled';
    expect((await f.run()).state).toBe('PASSED'); expect(f.state.counts).toEqual({ submit: 1, task: 1, billing: 2, media: 1 });
  });
  it('rejects an explicit billing error even when task identity, final state and amount look valid', async () => {
    const f = await setup(); f.state.ledger = 'settled'; f.state.ledgerError = true;
    const result = await f.run(); expect(result.state).toBe('BLOCKED'); expect(result.evidence?.settlement.reason).toBe('MISSION_SETTLEMENT_RESPONSE_REJECTED');
    expect(result.asset?.decoded).toBe(true); expect(result.chargedMilliCredits).toBeUndefined();
  });
  it('retains final settlement while storage is late and does not fetch the receipt again', async () => {
    const f = await setup(); f.state.ledger = 'settled'; f.state.mediaStatus = 404;
    const first = await f.run(); expect(first.state).toBe('BLOCKED'); expect(first.evidence?.settlement.state).toBe('final');
    f.state.ledgerStatus = 503; f.state.mediaStatus = 200;
    expect((await f.run()).state).toBe('PASSED'); expect(f.state.counts).toEqual({ submit: 1, task: 2, billing: 1, media: 2 });
  });
  it('retains an output mismatch while settlement lags and never replaces the failed media with a later good result', async () => {
    const f = await setup(320);
    const first = await f.run(); expect(first.state).toBe('SETTLING'); expect(first.evidence?.media.state).toBe('failed');
    expect(first.evidence?.failures).toContain('MISSION_OUTPUT_DIMENSION_OR_COUNT_MISMATCH');
    f.state.ledger = 'settled'; const done = await f.run(); expect(done.state).toBe('FAILED'); expect(done.asset?.width).toBe(160);
    expect(f.state.counts.media).toBe(1); expect(f.state.counts.submit).toBe(1);
  });
  it('rejects a receipt in a provider task namespace even when it contains a plausible amount', async () => {
    const f = await setup(); f.state.wrongReceipt = true; f.state.ledger = 'settled';
    const first = await f.run(); expect(first.state).toBe('BLOCKED'); expect(first.evidence?.conflicts).toContain('MISSION_RECEIPT_TASK_MISMATCH');
    f.state.wrongReceipt = false; const counts = { ...f.state.counts }; expect((await f.run()).state).toBe('BLOCKED'); expect(f.state.counts).toEqual(counts);
  });
  it('rejects a different request identity before accepting task, asset or billing evidence', async () => {
    const f = await setup(); f.state.wrongRequest = true;
    const result = await f.run(); expect(result.evidence?.conflicts).toContain('MISSION_TASK_REQUEST_BINDING_MISMATCH');
    expect(f.state.counts).toEqual({ submit: 1, task: 1, billing: 0, media: 0 });
  });
  it.each([true, 1, 'unknown', 'success'])('does not coerce an unrecognized settlement state %s into finality', async state => {
    const f = await setup(); f.state.ledger = state;
    const result = await f.run(); expect(result.state).toBe('BLOCKED'); expect(result.asset?.decoded).toBe(true); expect(result.chargedMilliCredits).toBeUndefined();
    expect(result.evidence?.settlement.reason).toBe('MISSION_SETTLEMENT_STATE_UNKNOWN');
  });
  it.each([-1, 101, '100', null])('rejects an invalid final refund %s instead of fabricating net zero', async refund => {
    const f = await setup(); f.state.ledger = 'settled'; f.state.refund = refund;
    const result = await f.run(); expect(result.state).toBe('BLOCKED'); expect(result.evidence?.settlement.reason).toBe('MISSION_REFUND_RECEIPT_INVALID'); expect(result.chargedMilliCredits).toBeUndefined();
  });
  it('records final budget overrun as failure without wasting an additional asset download', async () => {
    const f = await setup(); f.state.ledger = 'settled'; f.state.debit = 101;
    const result = await f.run(); expect(result.state).toBe('FAILED'); expect(result.evidence?.failures).toContain('BUDGET_OVERRUN_OBSERVED');
    expect(f.state.counts).toEqual({ submit: 1, task: 1, billing: 1, media: 0 });
  });
  it('does not repeat a successful asset verification across concurrent resume attempts', async () => {
    const f = await setup(); await f.run(); f.state.ledger = 'settled';
    const results = await Promise.allSettled([f.run(), f.run()]); expect(results.filter(r => r.status === 'rejected')).toHaveLength(1);
    expect(f.state.counts).toEqual({ submit: 1, task: 1, billing: 2, media: 1 });
  });
  it('does not put raw ledger text, signed URLs or application credentials into the durable business evidence', async () => {
    const f = await setup(); f.state.ledger = 'settled'; const result = await f.run();
    const saved = await readFile(path.join(f.root, 'journal', `${f.plan.hash}.json`), 'utf8');
    for (const privateValue of ['fixture-private-signature', 'fixture private ledger text', 'fixture-identity-only', '/asset.mp4']) expect(saved).not.toContain(privateValue);
    expect(f.state.assetAuth).toEqual([undefined]); expect(renderPanquMission(result)).toContain('Settlement fact: final');
  });
  it('enforces approval again before a billing-only resume', async () => {
    const f = await setup(); await f.run(); const counts = { ...f.state.counts }; f.approval.expiresAt = new Date(0).toISOString();
    await expect(f.run()).rejects.toThrow('MISSION_APPROVAL_EXPIRED'); expect(f.state.counts).toEqual(counts);
  });
  it('can finish an already submitted task after frontend source changes without opening a new generation path', async () => {
    const f = await setup(); await f.run();
    await writeFile(path.join(f.root, 'utils/myFetchInstance.ts'), 'changed after submission');
    f.state.ledger = 'settled'; f.state.taskUnavailable = true;
    expect((await f.run()).state).toBe('PASSED'); expect(f.state.counts).toEqual({ submit: 1, task: 1, billing: 2, media: 1 });
  });
  it('preserves a media gap and ignores an older task response before retrying the current output', async () => {
    const f = await setup(); f.state.ledger = 'settled'; f.state.mediaStatus = 404;
    await f.run(); f.state.updatedAt = '2026-09-09T00:00:01.000Z'; f.state.task = 'running'; f.state.mediaStatus = 200;
    const stale = await f.run(); expect(stale.state).toBe('BLOCKED'); expect(stale.evidence?.task?.state).toBe('success'); expect(stale.evidence?.conflicts).toEqual([]);
    expect(f.state.counts.media).toBe(1);
    f.state.updatedAt = '2026-09-09T00:00:03.000Z'; f.state.task = 'success';
    expect((await f.run()).state).toBe('PASSED'); expect(f.state.counts).toEqual({ submit: 1, task: 3, billing: 1, media: 2 });
  });
  it('persists a newer terminal contradiction and stops automatic reads until it is resolved', async () => {
    const f = await setup(); f.state.mediaStatus = 404; await f.run();
    f.state.updatedAt = '2026-09-09T00:00:03.000Z'; f.state.task = 'failed';
    const conflicted = await f.run(); expect(conflicted.evidence?.conflicts).toEqual(['MISSION_TASK_TERMINAL_CONFLICT']);
    expect(conflicted.evidence?.task?.state).toBe('success'); const counts = { ...f.state.counts };
    expect((await f.run()).state).toBe('BLOCKED'); expect(f.state.counts).toEqual(counts);
  });
  it('keeps historical terminal journals explicitly unverified rather than replaying a generation', async () => {
    const f = await setup(); f.state.ledger = 'settled'; const old = await f.run(); delete old.evidence;
    expect(renderPanquMission(old)).toContain('State: BLOCKED'); expect(renderPanquMission(old)).toContain('Historical state: PASSED');
    await writeFile(path.join(f.root, 'journal', `${f.plan.hash}.json`), JSON.stringify(old)); const counts = { ...f.state.counts };
    const result = await f.run(); expect(result.state).toBe('BLOCKED'); expect(result.events.at(-1)?.code).toBe('MISSION_LEGACY_SETTLEMENT_UNVERIFIED');
    await f.run(); expect(f.state.counts).toEqual(counts);
  });
  it('CLI resumes a pending settlement in another process using only billing evidence', async () => {
    const f = await setup(); const cli = path.resolve('dist/bin/run-devtest.js');
    const { origin: _origin, headers: _headers, projectRoot: _root, ...config } = f.config;
    for (const [file, data] of Object.entries({ 'plan.json': f.plan, 'approval.json': f.approval, 'config.json': { ...config, originEnv: 'PANQU_EVIDENCE_FIXTURE_ORIGIN', headersEnv: 'PANQU_EVIDENCE_FIXTURE_HEADERS' } })) await writeFile(path.join(f.root, file), JSON.stringify(data));
    const args = ['--plan', 'plan.json', '--config', 'config.json', '--approval', 'approval.json', '--output', 'journal'];
    const call = (command: string) => exec(process.execPath, [cli, 'mission', command, ...args], { cwd: f.root, env: { ...process.env, PANQU_EVIDENCE_FIXTURE_ORIGIN: f.config.origin, PANQU_EVIDENCE_FIXTURE_HEADERS: '{}' } });
    await expect(call('run')).rejects.toMatchObject({ code: 3, stdout: expect.stringContaining('State: SETTLING') });
    f.state.ledger = 'settled'; f.state.taskUnavailable = true;
    expect((await call('resume')).stdout).toContain('State: PASSED'); expect(f.state.counts.submit).toBe(1); expect(f.state.counts.task).toBe(1); expect(f.state.counts.media).toBe(1);
  }, 15000);
});

describe('Panqu finality and source-version evidence guards', () => {
  it.each(['missing', 'overlap', 'refund-pointer', 'amount-meaning', 'receipt-route'] as const)('blocks %s settlement configuration before any business network request', async fault => {
    const f = await setup();
    if (fault === 'missing') delete f.config.receipt!.settlement;
    if (fault === 'overlap') f.config.receipt!.settlement!.pendingValues.push('settled');
    if (fault === 'refund-pointer') delete f.config.receipt!.settlement!.refundedMilliCreditsPointer;
    if (fault === 'amount-meaning') f.config.receipt!.settlement!.amountMeaning = 'FINAL_NET_DEBIT';
    if (fault === 'receipt-route') f.config.receipt!.path = 'https://not-a-trusted-origin.invalid/{taskId}';
    await expect(f.run()).rejects.toThrow(/MISSION_(SETTLEMENT|REFUND)/); expect(Object.values(f.state.counts).every(count => count === 0)).toBe(true);
  });
  it('ignores a source-versioned stale running state after terminal success without erasing known facts', async () => {
    const f = await setup(); const evidence = createPanquMissionEvidence('canvas-task-a');
    const observed: PanquMissionObservation = { taskId: 'canvas-task-a', projectId: 'project-a', requestId: f.plan.hash, nodeId: 'node-a', state: 'success', updatedAt: '2026-09-09T00:00:02Z' };
    expect(acceptPanquTaskEvidence(evidence, observed, f.plan)).toBe(true);
    expect(acceptPanquTaskEvidence(evidence, { ...observed, state: 'running', updatedAt: '2026-09-09T00:00:01Z' }, f.plan)).toBe(false);
    expect(evidence.task?.state).toBe('success'); expect(evidence.conflicts).toEqual([]);
  });
  it.each(['failed', 'running'] as const)('keeps a newer contradictory %s state as conflict instead of silently overwriting success', async state => {
    const f = await setup(); const evidence = createPanquMissionEvidence('canvas-task-a'); const observed: PanquMissionObservation = { taskId: 'canvas-task-a', state: 'success', updatedAt: '2026-09-09T00:00:02Z' };
    acceptPanquTaskEvidence(evidence, observed, f.plan); expect(acceptPanquTaskEvidence(evidence, { ...observed, state, updatedAt: '2026-09-09T00:00:03Z' }, f.plan)).toBe(false);
    expect(evidence.conflicts).toEqual(['MISSION_TASK_TERMINAL_CONFLICT']); expect(evidence.task?.state).toBe('success');
  });
  it('rejects same-version conflicting observations', async () => {
    const f = await setup(); const evidence = createPanquMissionEvidence('canvas-task-a'); const observed: PanquMissionObservation = { taskId: 'canvas-task-a', state: 'pending', updatedAt: '2026-09-09T00:00:02Z' };
    acceptPanquTaskEvidence(evidence, observed, f.plan); expect(acceptPanquTaskEvidence(evidence, { ...observed, state: 'success' }, f.plan)).toBe(false);
    expect(evidence.conflicts).toEqual(['MISSION_TASK_VERSION_CONFLICT']);
  });
  it('does not invent a version when the protocol has no source timestamp', () => {
    expect(decodePanquMissionTask('PHP_VIDEO_V1', { code: 1, data: [{ id: '12', status: { task_status: 4 } }] }, '12', 'p', 'n', 'video').updatedAt).toBeUndefined();
  });
  it('normalizes equivalent source timestamps before testing same-version conflicts', async () => {
    const f = await setup(); const evidence = createPanquMissionEvidence('canvas-task-a');
    acceptPanquTaskEvidence(evidence, { taskId: 'canvas-task-a', state: 'pending', updatedAt: '2026-09-09T08:00:02+08:00' }, f.plan);
    expect(acceptPanquTaskEvidence(evidence, { taskId: 'canvas-task-a', state: 'success', updatedAt: '2026-09-09T00:00:02Z' }, f.plan)).toBe(false);
    expect(evidence.task?.updatedAt).toBe(FIXED_ISO); expect(evidence.conflicts).toContain('MISSION_TASK_VERSION_CONFLICT');
  });
  it('blocks a custom driver without a separate settlement adapter before generation', async () => {
    const f = await setup(); const { driver, ...input } = f.input();
    await expect(runPanquMission({ ...input, driver: { identity: driver.identity, origin: driver.origin, profile: driver.profile,
      preflight: driver.preflight.bind(driver), submit: driver.submit.bind(driver), observe: driver.observe.bind(driver), verifyAsset: driver.verifyAsset.bind(driver) } })).rejects.toThrow('MISSION_SETTLEMENT_ADAPTER_MISSING');
    expect(Object.values(f.state.counts).every(count => count === 0)).toBe(true);
  });
  it('rejects malformed source timestamps before accepting task or settlement facts', () => {
    expect(() => decodePanquMissionTask('NUXT_CANVAS_V1', { taskId: 't', projectId: 'p', status: 'running', updated_at: 'not-a-source-time' }, 't', 'p', 'n', 'video')).toThrow('MISSION_TASK_VERSION_INVALID');
  });
});
