import { readFile, mkdtemp, open, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { missionAssert, missionDigest } from './panqu-mission-plan.js';
import { inspectMissionMedia, resolveMissionFile, type PanquMediaTools } from './panqu-mission-media.js';
import type { PanquMissionApproval, PanquMissionDriver, PanquMissionObservation, PanquMissionPlan, PanquMissionProfile, PanquMissionAssetEvidence, PanquMissionSettlement } from './panqu-mission-types.js';

/** Operator-owned configuration. It is not accepted as a model proposal or through the read-only MCP. */
export interface PanquHttpMissionConfig {
  projectRoot: string;
  origin: string;
  profile: PanquMissionProfile;
  actorRef: string;
  apiBasePath?: string;
  assetOrigins: string[];
  mediaTools: PanquMediaTools;
  /** Credentials exist only in memory and are never forwarded to asset origins. */
  headers?: Record<string, string>;
  materialsRoot?: string;
  /** Nuxt node parameters vary by plugin. Operator-verified JSON pointers are mandatory. */
  nuxtBindings?: { modelId: string; durationSeconds?: string; quality: string };
  /** Optional independently documented task-bound billing receipt; amounts must be integer milli-credits. */
  receipt?: {
    source: string; path: string; taskIdPointer: string; chargedMilliCreditsPointer: string;
    /** Finality and amount meaning must come from a verified billing contract, never a guessed status. */
    settlement?: {
      statePointer: string; finalValue: string | number | boolean; pendingValues: Array<string | number | boolean>;
      amountMeaning: 'FINAL_NET_DEBIT' | 'DEBIT_MINUS_REFUND'; refundedMilliCreditsPointer?: string;
    };
  };
}
export const PANQU_MISSION_REQUIRED_SOURCES: Record<PanquMissionProfile, string[]> = {
  PHP_VIDEO_V1: ['lib/api/video.ts', 'lib/api/taskStatus.ts', 'lib/api/request.ts', 'lib/api/csrf.ts', 'lib/api/url.ts', 'components/nodes/videoNode.tsx'],
  NUXT_CANVAS_V1: ['composables/canvas-flow/adapters/canvas-flow-api-client.ts', 'composables/canvas-flow/core/use-execution-engine.ts', 'composables/canvas-flow/types/canvas-flow.types.ts', 'utils/myFetchInstance.ts'],
};
/** Shared bounded transport; callers choose only their fixed application routes, never model URLs. */
export async function fetchPanquMissionJson(config: Pick<PanquHttpMissionConfig, 'origin' | 'apiBasePath' | 'headers'>,
  route: string, method: 'GET' | 'POST', body: BodyInit | undefined, signal: AbortSignal, json = false): Promise<unknown> {
  missionAssert(route.startsWith('/') && !route.startsWith('//') && !route.includes('\\') && !route.includes('#') && !route.includes('..'), 'MISSION_ROUTE_INVALID');
  const prefix = config.apiBasePath ?? '';
  missionAssert(prefix === '' || /^\/[a-zA-Z0-9_/-]+$/.test(prefix) && !prefix.includes('..') && !prefix.startsWith('//'), 'MISSION_BASE_PATH_INVALID');
  const response = await fetch(new URL(`${prefix.replace(/\/$/, '')}${route}`, config.origin), { method, body, redirect: 'error', signal,
    headers: { ...config.headers, ...(json ? { 'Content-Type': 'application/json' } : {}) } });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(response.status === 401 ? 'MISSION_HTTP_AUTH_REQUIRED' : response.status === 403 ? 'MISSION_HTTP_ACCESS_DENIED' : 'MISSION_HTTP_REJECTED');
  }
  const reader = response.body.getReader(); const buffers: Uint8Array[] = []; let size = 0;
  try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; missionAssert(size <= 2 * 1024 * 1024, 'MISSION_RESPONSE_TOO_LARGE'); buffers.push(next.value); } }
  finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(buffers).toString('utf8')); } catch { throw new Error('MISSION_RESPONSE_NOT_JSON'); }
}
/** Safe JSON pointer traversal; no evaluation or prototype access. */
function pointer(value: unknown, expression: string): unknown {
  missionAssert(expression.startsWith('/'), 'MISSION_JSON_POINTER_INVALID');
  for (const encoded of expression.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    missionAssert(!['__proto__', 'prototype', 'constructor'].includes(key), 'MISSION_JSON_POINTER_INVALID');
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}
function object(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

/** Require an explicit finality/amount contract before spending; JSON pointer syntax alone is not business proof. */
function validateSettlementContract(receipt: PanquHttpMissionConfig['receipt']): void {
  missionAssert(receipt?.settlement, 'MISSION_SETTLEMENT_CONTRACT_MISSING');
  const contract = receipt.settlement;
  const scalar = (value: unknown) => typeof value === 'boolean' || typeof value === 'string' && value.length > 0
    || typeof value === 'number' && Number.isFinite(value);
  const validPointer = (value: unknown) => typeof value === 'string' && value.startsWith('/') && value.length < 500
    && value.slice(1).split('/').every(key => key.length > 0 && !['__proto__', 'prototype', 'constructor'].includes(key.replace(/~1/g, '/').replace(/~0/g, '~')));
  missionAssert(receipt.source.trim() && receipt.path.startsWith('/') && !receipt.path.startsWith('//')
    && !receipt.path.includes('..') && !receipt.path.includes('\\') && !receipt.path.includes('#')
    && receipt.path.split('{taskId}').length === 2 && validPointer(receipt.taskIdPointer)
    && validPointer(receipt.chargedMilliCreditsPointer) && validPointer(contract.statePointer)
    && new Set([receipt.taskIdPointer, receipt.chargedMilliCreditsPointer, contract.statePointer]).size === 3
    && scalar(contract.finalValue) && Array.isArray(contract.pendingValues) && contract.pendingValues.length <= 16
    && contract.pendingValues.every(scalar) && !contract.pendingValues.includes(contract.finalValue)
    && ['FINAL_NET_DEBIT', 'DEBIT_MINUS_REFUND'].includes(contract.amountMeaning), 'MISSION_SETTLEMENT_CONTRACT_INVALID');
  if (contract.amountMeaning === 'DEBIT_MINUS_REFUND') missionAssert(validPointer(contract.refundedMilliCreditsPointer)
    && ![receipt.taskIdPointer, receipt.chargedMilliCreditsPointer, contract.statePointer].includes(contract.refundedMilliCreditsPointer!), 'MISSION_REFUND_BINDING_REQUIRED');
  else missionAssert(contract.refundedMilliCreditsPointer === undefined, 'MISSION_SETTLEMENT_AMOUNT_MEANING_CONFLICT');
}

/** Public decoders make host differences testable independently from transport. */
export function decodePanquMissionTask(profile: PanquMissionProfile, body: unknown, taskId: string, projectId: string, nodeId: string, kind: 'image' | 'video'): PanquMissionObservation {
  const root = object(body);
  if (profile === 'PHP_VIDEO_V1') {
    missionAssert(root.code === 1 && Array.isArray(root.data), 'MISSION_PHP_PROTOCOL_REJECTED');
    const matching = root.data.map(object).filter(item => String(item.id) === taskId);
    missionAssert(matching.length === 1, 'MISSION_FOREIGN_TASK_REJECTED');
    const status = object(matching[0].status);
    missionAssert(status.id === undefined || String(status.id) === taskId, 'MISSION_FOREIGN_TASK_REJECTED');
    const url = status.video_url ?? status.url;
    const success = status.task_status === 3 || status.task_status === 2 && status.progress === 100 && typeof url === 'string' && url.length > 0;
    return { taskId, state: status.task_status === 4 ? 'failed' : success ? 'success' : status.task_status === 1 ? 'pending' : status.task_status === 2 ? 'running' : 'unknown',
      progress: typeof status.progress === 'number' ? status.progress : undefined, assetUrl: typeof url === 'string' ? url : undefined };
  }
  missionAssert(root.taskId === taskId && root.projectId === projectId, 'MISSION_FOREIGN_TASK_REJECTED');
  const nodes = Array.isArray(root.nodeRuns) ? root.nodeRuns.map(object).filter(node => node.nodeId === nodeId) : [];
  const outputs: string[] = [];
  if (nodes.length === 1) for (const packet of Object.values(object(nodes[0].outputs)).map(object)) {
    if (packet.type !== kind) continue;
    const payload = object(packet.payload);
    if (Array.isArray(payload.items)) for (const item of payload.items.map(object)) if (typeof item.url === 'string') outputs.push(item.url);
  }
  missionAssert(outputs.length <= 1, 'MISSION_OUTPUT_COUNT_MISMATCH');
  if (root.updated_at !== undefined) missionAssert(typeof root.updated_at === 'string' && Number.isFinite(Date.parse(root.updated_at)), 'MISSION_TASK_VERSION_INVALID');
  return { taskId, projectId, requestId: typeof root.requestId === 'string' ? root.requestId : undefined,
    nodeId: nodes.length === 1 ? nodeId : undefined, updatedAt: root.updated_at as string | undefined,
    state: root.status === 'failed' || root.status === 'cancelled' ? 'failed'
    : root.status === 'success' && nodes.length === 1 && nodes[0].status === 'success' ? 'success'
      : root.status === 'submitted' ? 'pending' : root.status === 'running' ? 'running' : 'unknown', assetUrl: outputs[0] };
}

/** Fixed Panqu protocols, bounded fetches, no redirects, no credential forwarding and no submission retry. */
export class PanquHttpMissionDriver implements PanquMissionDriver {
  readonly identity: string;
  readonly origin: string;
  readonly profile: PanquMissionProfile;
  private readonly config: PanquHttpMissionConfig;
  constructor(config: PanquHttpMissionConfig) {
    this.config = structuredClone(config); this.origin = config.origin; this.profile = config.profile;
    this.identity = missionDigest({ ...config, headers: undefined, mediaTools: undefined, materialsRoot: undefined });
  }
  private async json(route: string, method: 'GET' | 'POST', body: BodyInit | undefined, signal: AbortSignal, json = false): Promise<unknown> {
    return fetchPanquMissionJson(this.config, route, method, body, signal, json);
  }
  async preflight(plan: PanquMissionPlan, approval: PanquMissionApproval, context?: { resumeOnly: boolean }): Promise<void> {
    missionAssert(plan.profile === this.profile && this.config.actorRef.trim() && approval.allowedOrigin === this.origin, 'MISSION_DRIVER_CONFIG_INVALID');
    missionAssert(approval.environment === 'local' || Object.keys(this.config.headers ?? {}).length > 0, 'MISSION_AUTH_NOT_CONFIGURED');
    missionAssert(!Object.keys(this.config.headers ?? {}).some(key => /^(host|content-type|content-length)$/i.test(key)), 'MISSION_TRANSPORT_HEADER_OVERRIDE');
    // Once submission is durable, fixed task/billing reads do not depend on old prompt/media/quote or frontend source files.
    // Origin, identity, approval and driver configuration remain bound by the runtime; this path cannot submit.
    if (context?.resumeOnly) {
      if (this.config.receipt?.settlement) validateSettlementContract(this.config.receipt);
      return;
    }
    missionAssert(plan.variant.parameters.count === 1, 'MISSION_BATCH_OUTPUT_NOT_SUPPORTED');
    for (const source of PANQU_MISSION_REQUIRED_SOURCES[this.profile]) missionAssert(plan.sourcePins.some(pin => pin.file === source), 'MISSION_REQUIRED_SOURCE_PIN_MISSING');
    for (const pin of plan.sourcePins) {
      const file = await resolveMissionFile(this.config.projectRoot, pin.file);
      missionAssert(createHash('sha256').update(await readFile(file)).digest('hex') === pin.sha256, 'MISSION_SOURCE_CHANGED');
    }
    for (const material of plan.materials) {
      missionAssert(this.config.materialsRoot, 'MISSION_MATERIAL_ROOT_REQUIRED');
      const file = await resolveMissionFile(this.config.materialsRoot, material.file);
      missionAssert(createHash('sha256').update(await readFile(file)).digest('hex') === material.sha256, 'MISSION_MATERIAL_CHANGED');
    }
    // Both inspected frontends reference uploaded asset objects, not arbitrary local files.
    // Do not invent an upload endpoint or quietly drop an approved reference.
    missionAssert(plan.materials.length === 0, 'MISSION_REFERENCE_UPLOAD_ADAPTER_REQUIRED');
    const request = plan.variant.request;
    if (this.profile === 'PHP_VIDEO_V1') {
      missionAssert(plan.requirement.kind === 'video' && Object.values(request).every(value => typeof value === 'string'), 'MISSION_PHP_FORM_INVALID');
      missionAssert(request.model_id === plan.requirement.modelId && request['row[selmodelsId]'] === plan.requirement.modelId
        && request.project_id === plan.projectId && request['row[workflow_node_id]'] === plan.nodeId, 'MISSION_SUBMISSION_IDENTITY_MISMATCH');
      missionAssert(request['row[extra][duration]'] === String(plan.variant.parameters.durationSeconds)
        && request['row[extra][video_resolution]'] === plan.variant.parameters.quality.toLowerCase(), 'MISSION_SUBMISSION_PARAMETERS_MISMATCH');
      for (const field of ['row[type]', 'row[extra][selmodels]', 'task_type', 'row[extra][cueword]']) missionAssert(typeof request[field] === 'string' && request[field], 'MISSION_REQUIRED_FORM_FIELD_MISSING');
    } else {
      missionAssert(request.projectId === plan.projectId && request.nodeId === plan.nodeId && request.mode === 'node' && request.nodeIds === undefined, 'MISSION_SUBMISSION_SCOPE_MISMATCH');
      const binding = plan.variant.preparation ? { modelId: '/graph/nodes/0/data/model', durationSeconds: '/graph/nodes/0/data/videoGenParams/duration', quality: '/graph/nodes/0/data/videoGenParams/resolution' }
        : this.config.nuxtBindings; missionAssert(binding, 'MISSION_NUXT_PARAMETER_BINDINGS_REQUIRED');
      missionAssert(pointer(request, binding.modelId) === plan.requirement.modelId && pointer(request, binding.quality) === plan.variant.parameters.quality, 'MISSION_SUBMISSION_PARAMETERS_MISMATCH');
      if (plan.variant.parameters.durationSeconds !== undefined) missionAssert(binding.durationSeconds && pointer(request, binding.durationSeconds) === plan.variant.parameters.durationSeconds, 'MISSION_SUBMISSION_PARAMETERS_MISMATCH');
    }
    if (this.config.receipt) missionAssert(this.config.receipt.source.trim() && this.config.receipt.path.includes('{taskId}'), 'MISSION_RECEIPT_BINDING_INVALID');
    validateSettlementContract(this.config.receipt);
  }
  async revalidate(plan: PanquMissionPlan, signal: AbortSignal): Promise<void> {
    if (!plan.variant.preparation) return;
    const { revalidatePreparedPanquMission } = await import('./panqu-mission-prepare.js');
    await revalidatePreparedPanquMission(plan, this.config, signal);
  }
  async submit(plan: PanquMissionPlan, signal: AbortSignal): Promise<{ taskId: string }> {
    if (this.profile === 'PHP_VIDEO_V1') {
      const tokenResponse = object(await this.json('/ajax/refreshtoken', 'GET', undefined, signal));
      const data = object(tokenResponse.data); const token = data.__token__ ?? data.token ?? tokenResponse.__token__ ?? tokenResponse.token;
      missionAssert(typeof token === 'string' && token.length > 0, 'MISSION_CSRF_UNAVAILABLE');
      missionAssert(Date.parse(plan.quote.expiresAt) > Date.now() && !signal.aborted, 'MISSION_QUOTE_EXPIRED');
      const form = new FormData(); for (const [key, value] of Object.entries(plan.variant.request)) form.set(key, value as string); form.set('__token__', token);
      const response = object(await this.json('/aivideo/videonew/add', 'POST', form, signal));
      missionAssert(response.code === 1, 'MISSION_PHP_PROTOCOL_REJECTED');
      const taskId = object(response.data).id; missionAssert(typeof taskId === 'string' || typeof taskId === 'number', 'MISSION_TASK_ID_INVALID');
      return { taskId: String(taskId) };
    }
    const response = object(await this.json('/canvas-workflow/execute', 'POST', JSON.stringify({ ...plan.variant.request, requestId: plan.hash }), signal, true));
    missionAssert(typeof response.taskId === 'string' && response.status === 'submitted', 'MISSION_NUXT_SUBMISSION_INVALID');
    return { taskId: response.taskId };
  }
  async observe(taskId: string, plan: PanquMissionPlan, signal: AbortSignal): Promise<PanquMissionObservation> {
    let body;
    if (this.profile === 'PHP_VIDEO_V1') {
      const form = new FormData(); form.set('type', 'video'); form.set('ids', taskId);
      body = await this.json('/aivideo/v2/task_status/apiGetStatus', 'POST', form, signal);
    } else body = await this.json(`/canvas-workflow/tasks/${encodeURIComponent(taskId)}`, 'GET', undefined, signal);
    const observation = decodePanquMissionTask(this.profile, body, taskId, plan.projectId, plan.nodeId, plan.requirement.kind);
    if (plan.variant.preparation) missionAssert(observation.requestId === plan.hash && observation.nodeId === plan.nodeId, 'MISSION_TASK_REQUEST_BINDING_MISMATCH');
    else if (observation.requestId !== undefined) missionAssert(observation.requestId === plan.hash, 'MISSION_TASK_REQUEST_BINDING_MISMATCH');
    return observation;
  }
  /** Billing identity stays in the submitted task namespace; a media/provider ID is never guessed as equivalent. */
  async observeSettlement(taskId: string, _plan: PanquMissionPlan, signal: AbortSignal): Promise<PanquMissionSettlement> {
    const config = this.config.receipt;
    if (!config) return { taskId, state: 'unknown', reason: 'BILLING_EVIDENCE_MISSING' };
    const contract = config.settlement;
    if (!contract) return { taskId, state: 'unknown', reason: 'MISSION_SETTLEMENT_CONTRACT_MISSING' };
    validateSettlementContract(config);
    const receipt = await this.json(config.path.replace('{taskId}', encodeURIComponent(taskId)), 'GET', undefined, signal);
    const root = object(receipt);
    missionAssert(root.success !== false && root.ok !== false && !root.error, 'MISSION_SETTLEMENT_RESPONSE_REJECTED');
    missionAssert(String(pointer(receipt, config.taskIdPointer)) === taskId, 'MISSION_RECEIPT_TASK_MISMATCH');
    const state = pointer(receipt, contract.statePointer);
    if (contract.pendingValues.some(value => value === state)) return { taskId, state: 'pending' };
    if (state !== contract.finalValue) return { taskId, state: 'unknown', reason: 'MISSION_SETTLEMENT_STATE_UNKNOWN' };
    const debit = pointer(receipt, config.chargedMilliCreditsPointer);
    missionAssert(typeof debit === 'number' && Number.isSafeInteger(debit) && debit >= 0, 'MISSION_CHARGE_RECEIPT_INVALID');
    let refunded: number | undefined;
    if (contract.amountMeaning === 'DEBIT_MINUS_REFUND') {
      missionAssert(typeof contract.refundedMilliCreditsPointer === 'string', 'MISSION_REFUND_BINDING_REQUIRED');
      const refund = pointer(receipt, contract.refundedMilliCreditsPointer);
      missionAssert(typeof refund === 'number' && Number.isSafeInteger(refund) && refund >= 0 && refund <= debit, 'MISSION_REFUND_RECEIPT_INVALID');
      refunded = refund;
    }
    const amounts = contract.amountMeaning === 'DEBIT_MINUS_REFUND'
      ? { debitMilliCredits: debit, refundedMilliCredits: refunded!, netMilliCredits: debit - refunded! } : { netMilliCredits: debit };
    return { taskId, state: 'final', ...amounts, evidenceHash: missionDigest({ taskId, state, source: config.source, ...amounts }) };
  }
  async verifyAsset(observation: PanquMissionObservation, plan: PanquMissionPlan, signal: AbortSignal): Promise<PanquMissionAssetEvidence> {
    missionAssert(observation.assetUrl, 'MISSION_SUCCESS_WITHOUT_ASSET');
    const url = new URL(observation.assetUrl, this.origin);
    missionAssert(['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && this.config.assetOrigins.includes(url.origin), 'MISSION_ASSET_ORIGIN_NOT_APPROVED');
    // No application cookies or tokens cross into asset fetches. Signed URLs remain transient in memory.
    const response = await fetch(url, { redirect: 'error', signal });
    missionAssert(response.ok && response.body, 'MISSION_ASSET_UNAVAILABLE');
    const directory = await mkdtemp(path.join(tmpdir(), 'panqu-mission-asset-')); const file = path.join(directory, 'asset.bin');
    const handle = await open(file, 'wx', 0o600); let bytes = 0;
    try {
      const reader = response.body.getReader();
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; missionAssert(bytes <= 50 * 1024 * 1024, 'MISSION_ASSET_TOO_LARGE'); await handle.writeFile(next.value); } }
      finally { await reader.cancel().catch(() => {}); await handle.close(); }
      const media = await inspectMissionMedia(file, this.config.mediaTools, { maxDurationSeconds: Math.max(1, plan.variant.parameters.durationSeconds ?? 1) + 1 });
      missionAssert(media.kind !== 'audio' && media.width && media.height, 'MISSION_ASSET_TYPE_MISMATCH');
      return { sha256: media.sha256, bytes: media.bytes, kind: media.kind, width: media.width, height: media.height, durationSeconds: media.durationSeconds, decoded: true };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
}
