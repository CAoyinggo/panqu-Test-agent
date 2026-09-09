import { readFile, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import ts from 'typescript';
import { compilePanquMission, missionAssert, missionDigest, validMilliCredits } from './panqu-mission-plan.js';
import { fetchPanquMissionJson, PANQU_MISSION_REQUIRED_SOURCES, type PanquHttpMissionConfig } from './panqu-mission-driver.js';
import { resolveMissionFile } from './panqu-mission-media.js';
import { inspectPanquProject } from './panqu-project.js';
import { ensurePanquMissionDirectory, readPanquMissionJson, savePanquMissionJson, withPanquMissionLock } from './panqu-mission-runtime.js';
import type { PanquMissionIntent, PanquMissionReadAccess, PanquMissionPlan, PanquMissionCatalog, PanquMissionVariant, PanquMissionJournal, PanquMissionPreparationEvidence } from './panqu-mission-types.js';

export type PanquMissionPreparationConfig = Pick<PanquHttpMissionConfig, 'projectRoot' | 'origin' | 'profile' | 'actorRef' | 'apiBasePath' | 'headers'>;
export interface PanquMissionPreparationResult {
  schema: 'panqu.mission-preparation.v1';
  state: 'READY_FOR_APPROVAL' | 'BLOCKED' | 'EXISTING_TASK';
  nextAction: 'CONFIRM_EXACT_PLAN' | 'RESOLVE_PREPARATION_GAP' | 'RESUME_EXISTING_TASK' | 'RECONCILE_SUBMISSION' | 'REVIEW_EXISTING_RESULT';
  intentId: string;
  events: Array<{ sequence: number; stage: string; code: string }>;
  requests: { models: number; canvas: number; estimates: number; generation: 0 };
  problems: Array<{ code: string; resolution: string; sourceFile?: string; variantId?: string; field?: string }>;
  plan?: PanquMissionPlan;
  planFile?: string;
  existingPlanHash?: string;
  candidates?: Array<{ id: string; quality: string; durationSeconds: number; milliCredits: number }>;
}
interface IntentRegistry { schema: 'panqu.mission-intent-registry.v1'; intentHash: string; contextHash: string; planHash: string }
const PREPARATION_SOURCES = [...PANQU_MISSION_REQUIRED_SOURCES.NUXT_CANVAS_V1,
  'composables/admin/usePlatform.ts', 'composables/admin/usePlatform.types.ts', 'composables/billing/useEstimatedBilling.ts',
  'plugins/myFetch.ts', 'components/canvas-flow/plugins/video-node/VideoPanel.vue',
  'components/canvas-flow/plugins/video-node/video-generate-mode.ts', 'components/canvas-flow/plugins/video-node/use-video-node-platform-models.ts',
  'components/canvas-flow/plugins/shared/model-option-identity.ts'];
const MAX_CANDIDATES = 24;
const FRESHNESS_MS = 120_000;
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const own = (record: Record<string, unknown>, key: string): unknown => Object.hasOwn(record, key) ? record[key] : undefined;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const equal = (a: unknown, b: unknown) => missionDigest(a) === missionDigest(b);
class PreparationProblem extends Error {
  constructor(code: string, readonly context: { sourceFile?: string; variantId?: string; field?: string }) { super(code); }
}

/** Preserve only known error codes, never raw exception text or a remote response body. */
function problemCode(error: unknown): string {
  return error instanceof Error && /^MISSION_[A-Z_]+$/.test(error.message) ? error.message : 'MISSION_PREPARATION_UNAVAILABLE';
}

/** Zero-network readiness explains which project adapter can prepare tasks and what remains operator-owned. */
export async function inspectPanquMissionPreparation(projectRoot: string) {
  const project = await inspectPanquProject(projectRoot);
  const profile = project.host === 'NUXT_VUE_FLOW' ? 'NUXT_CANVAS_V1' : project.host === 'NEXT_XYFLOW' ? 'PHP_VIDEO_V1' : undefined;
  const result = { schema: 'panqu.mission-preparation-readiness.v1', scope: 'RELEVANT_ADAPTER_SOURCES_ONLY', host: project.host, profile,
    state: 'BLOCKED', networkRequests: 0, sourcePins: [] as PanquMissionCatalog['sourcePins'], problems: [] as Array<{ code: string; resolution: string; sourceFile?: string }>,
    broaderProjectComplete: project.complete, broaderProjectDiagnostics: project.diagnostics,
    operatorInputs: ['Confirmed logical intent and target project/node/model', 'Source-backed output pixel oracles and audio requirement',
      'Test origin and identity via environment references', 'Read/estimate-only access with Panqu-credit unit', 'Separate exact-plan generation approval'] };
  try {
    missionAssert(profile, 'MISSION_PROJECT_PROFILE_UNSUPPORTED');
    result.sourcePins = await collectSourcePins({ projectRoot, profile, origin: 'http://127.0.0.1', actorRef: 'readiness-only' });
    missionAssert(profile === 'NUXT_CANVAS_V1', 'MISSION_PHP_AUTOPLAN_CONTRACT_MISSING');
    result.state = 'ADAPTER_READY';
  } catch (error) {
    const code = problemCode(error);
    result.problems.push({ code, resolution: resolutionFor(code), ...(error instanceof PreparationProblem ? error.context : {}) });
  }
  return result;
}

/** Safe machine-readable diagnostics do not echo private responses, tokens, URLs or prompt text. */
function resolutionFor(code: string): string {
  if (code.includes('READ_ACCESS') || code.includes('ORIGIN') || code.includes('AUTH')) return 'Operator must supply a current read-only access grant, the exact test origin and existing identity through environment references.';
  if (code.includes('INTENT')) return 'Keep the original logical intent and output directory. Resume or reconcile a submitted task; do not create another intent to bypass uncertainty.';
  if (code.includes('PHP_AUTOPLAN')) return 'The inspected PHP list does not establish complete duration/price contracts. Use an operator-verified catalog until this host has a verified planner adapter.';
  if (code.includes('SOURCE')) return 'Restore/read the listed project adapter sources and review syntax or contract changes before preparation.';
  if (code.includes('REFERENCE') || code.includes('UPSTREAM') || code.includes('NODE_')) return 'This preparer supports an existing isolated text-to-video node only. Do not remove meaningful upstream inputs or references to force a plan.';
  if (code.includes('PROFILE') || code.includes('OUTPUT_ORACLE')) return 'Provide source-backed expected pixel dimensions and aspect ratio for the requested output profiles; do not infer an oracle from UI labels.';
  if (code.includes('QUOTE') || code.includes('ESTIMATE')) return 'Obtain successful current Panqu-credit estimates for every candidate. An incomplete price sweep cannot justify a cheapest-plan claim.';
  if (code.includes('CAPABILITY') || code.includes('CANDIDATE') || code.includes('MODEL')) return 'Resolve the exact model identity and explicit finite legal parameter domain. Narrow test scope explicitly if the bounded planner cannot enumerate it.';
  if (code.includes('BUDGET')) return 'The confirmed scope does not fit the budget. Increase the approved budget or explicitly change the requirement; never silently downgrade it.';
  if (code.includes('PROMPT')) return 'Use a nonempty test prompt within the model’s explicitly advertised counting rule; resolve unsupported or unknown limits.';
  return 'Resolve the preparation failure using project evidence; no generation was submitted by the preparer.';
}

/** Context excludes secrets but binds the declared actor, host profile and exact application base path. */
export function panquPreparationContextHash(config: PanquMissionPreparationConfig): string {
  return missionDigest({ origin: config.origin, profile: config.profile, actorRef: config.actorRef, apiBasePath: config.apiBasePath ?? '' });
}

/** Validate scope before any source read or network request. No read grant can approve generation. */
function validateInputs(intent: PanquMissionIntent, access: PanquMissionReadAccess, config: PanquMissionPreparationConfig, requireReadAccess = true): void {
  missionAssert(intent?.schema === 'panqu.mission-intent.v1' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(intent.intentId), 'MISSION_INTENT_ID_INVALID');
  missionAssert(Object.keys(intent).every(key => ['schema', 'intentId', 'requirement', 'projectId', 'nodeId', 'maxMilliCredits', 'outputProfiles', 'required', 'prompt', 'audio', 'proposal'].includes(key)), 'MISSION_INTENT_UNSUPPORTED_FIELD');
  missionAssert(intent.requirement?.confirmed === true && nonempty(intent.requirement.source) && nonempty(intent.requirement.statement)
    && nonempty(intent.requirement.modelId) && intent.requirement.kind === 'video' && intent.requirement.mode === 'text-to-video', 'MISSION_PREPARATION_MODE_UNSUPPORTED');
  missionAssert(/^[a-zA-Z0-9_-]{1,100}$/.test(intent.projectId) && /^[a-zA-Z0-9_-]{1,100}$/.test(intent.nodeId), 'MISSION_NODE_ID_INVALID');
  missionAssert(validMilliCredits(intent.maxMilliCredits) && typeof intent.audio === 'boolean', 'MISSION_INTENT_BUDGET_OR_AUDIO_INVALID');
  missionAssert(intent.prompt === undefined || typeof intent.prompt === 'string', 'MISSION_PROMPT_INVALID');
  missionAssert(Array.isArray(intent.outputProfiles) && intent.outputProfiles.length > 0 && intent.outputProfiles.length <= 12
    && intent.outputProfiles.every(profile => nonempty(profile.source) && nonempty(profile.quality) && /^[1-9]\d{0,3}:[1-9]\d{0,3}$/.test(profile.aspectRatio)
      && Number.isSafeInteger(profile.width) && profile.width > 0 && Number.isSafeInteger(profile.height) && profile.height > 0
      && profile.width * profile.height <= 16_777_216), 'MISSION_OUTPUT_ORACLES_REQUIRED');
  missionAssert(!intent.required || (intent.required.quality === undefined || nonempty(intent.required.quality))
    && (intent.required.durationSeconds === undefined || Number.isFinite(intent.required.durationSeconds) && intent.required.durationSeconds > 0), 'MISSION_REQUIRED_SCOPE_INVALID');
  const origin = new URL(config.origin);
  missionAssert(['http:', 'https:'].includes(origin.protocol) && origin.origin === config.origin && !origin.username && !origin.password, 'MISSION_ORIGIN_INVALID');
  missionAssert(['PHP_VIDEO_V1', 'NUXT_CANVAS_V1'].includes(config.profile) && /^[\w.-]{1,120}$/.test(config.actorRef), 'MISSION_PREPARATION_CONFIG_INVALID');
  if (!requireReadAccess) return;
  missionAssert(access?.schema === 'panqu.mission-read-access.v1' && nonempty(access.accessId) && access.scope === 'MODELS_CANVAS_ESTIMATE_ONLY'
    && access.estimateUnit === 'PANQU_CREDIT' && access.allowedOrigin === config.origin && access.projectId === intent.projectId && access.actorRef === config.actorRef
    && ['local', 'test', 'integration'].includes(access.environment) && Date.parse(access.expiresAt) > Date.now()
    && Number.isSafeInteger(access.maxEstimateRequests) && access.maxEstimateRequests > 0 && access.maxEstimateRequests <= MAX_CANDIDATES, 'MISSION_READ_ACCESS_INVALID');
  if (access.environment === 'local') missionAssert(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname), 'MISSION_LOCAL_ORIGIN_INVALID');
  missionAssert(access.environment === 'local' || Object.keys(config.headers ?? {}).length > 0, 'MISSION_AUTH_NOT_CONFIGURED');
  missionAssert(Object.entries(config.headers ?? {}).every(([key, value]) => typeof value === 'string' && !/^(host|content-type|content-length)$/i.test(key)), 'MISSION_TRANSPORT_HEADER_OVERRIDE');
}

/** Match the adapter's named route calls and supported parameter builder, ignoring comments and strings elsewhere. */
function validateSourceContract(relative: string, source: ts.SourceFile): void {
  const find = (parent: ts.Node, accept: (node: ts.Node) => boolean): ts.Node[] => {
    const found: ts.Node[] = []; const walk = (node: ts.Node) => { if (accept(node)) found.push(node); ts.forEachChild(node, walk); }; walk(parent); return found;
  };
  const named = (name: string): ts.Node => {
    const [owner, member] = name.split('.');
    const matches = find(source, node => (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) || ts.isFunctionDeclaration(node))
      && (node as ts.VariableDeclaration | ts.FunctionDeclaration).name?.getText(source) === owner);
    missionAssert(matches.length === 1, 'MISSION_SOURCE_CONTRACT_CHANGED');
    if (!member) return matches[0];
    const declaration = matches[0] as ts.VariableDeclaration;
    missionAssert(declaration.initializer && ts.isObjectLiteralExpression(declaration.initializer), 'MISSION_SOURCE_CONTRACT_CHANGED');
    const properties = declaration.initializer.properties.filter(property => property.name?.getText(source) === member);
    missionAssert(properties.length === 1, 'MISSION_SOURCE_CONTRACT_CHANGED'); return properties[0];
  };
  const route = (owner: string, expectedPath: string, method: string) => {
    const calls = find(named(owner), node => ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'myFetch') as ts.CallExpression[];
    missionAssert(calls.length === 1, 'MISSION_SOURCE_ROUTE_CONTRACT_CHANGED');
    const [url, options] = calls[0].arguments;
    const urlText = url && (ts.isStringLiteral(url) || ts.isNoSubstitutionTemplateLiteral(url)) ? url.text
      : url && ts.isTemplateExpression(url) ? url.head.text + url.templateSpans.map(span => `\${${span.expression.getText(source).replace(/\s/g, '')}}${span.literal.text}`).join('') : undefined;
    missionAssert(urlText === expectedPath && (!options || ts.isObjectLiteralExpression(options)), 'MISSION_SOURCE_ROUTE_CONTRACT_CHANGED');
    let actual = 'GET';
    if (options && ts.isObjectLiteralExpression(options)) for (const property of options.properties) {
      missionAssert(!ts.isSpreadAssignment(property), 'MISSION_SOURCE_ROUTE_CONTRACT_CHANGED');
      if (property.name?.getText(source).replace(/['"]/g, '') === 'method') {
        missionAssert(ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer), 'MISSION_SOURCE_ROUTE_CONTRACT_CHANGED');
        actual = property.initializer.text.toUpperCase();
      }
    }
    missionAssert(actual === method, 'MISSION_SOURCE_ROUTE_CONTRACT_CHANGED');
  };
  if (relative === 'composables/admin/usePlatform.ts') route('getModelsByType', '/integration-platform/models/strict/${encodeURIComponent(type)}', 'GET');
  if (relative.endsWith('/canvas-flow-api-client.ts')) {
    route('canvasFlowApi.getCanvasFlow', '/project/${projectId}/canvas-flow', 'GET');
    route('canvasFlowApi.execute', '/canvas-workflow/execute', 'POST');
  }
  if (relative.endsWith('/VideoPanel.vue')) {
    route('fetchEstimatedCost', '/integration-platform/models/estimatedBilling', 'POST');
    const keys = ['resolution', 'output_format', 'aspect_ratio', 'audio', 'duration'];
    const returns = find(named('buildVideoGenParamsForRequest'), node => ts.isReturnStatement(node) && Boolean(node.expression && ts.isObjectLiteralExpression(node.expression))) as ts.ReturnStatement[];
    missionAssert(returns.some(statement => {
      const properties = (statement.expression as ts.ObjectLiteralExpression).properties;
      return properties.length === keys.length && keys.every(key => properties.some(property => ts.isPropertyAssignment(property)
        && property.name.getText(source) === key && property.initializer.getText(source).replace(/\s/g, '') === `videoParams.${key}`));
    }), 'MISSION_SOURCE_PARAMETER_CONTRACT_CHANGED');
  }
}

/** Hash and parse only the adapter's relevant sources; unrelated project files are not execution proof. */
async function collectSourcePins(config: PanquMissionPreparationConfig): Promise<PanquMissionCatalog['sourcePins']> {
  const files = config.profile === 'NUXT_CANVAS_V1' ? PREPARATION_SOURCES : [...PANQU_MISSION_REQUIRED_SOURCES.PHP_VIDEO_V1, 'types/video.ts'];
  const pins: PanquMissionCatalog['sourcePins'] = [];
  for (const relative of files) {
    let source: string;
    try {
      const file = await resolveMissionFile(config.projectRoot, relative); const info = await lstat(file);
      missionAssert(info.isFile() && info.size <= 2 * 1024 * 1024, 'MISSION_SOURCE_FILE_INVALID'); source = await readFile(file, 'utf8');
    } catch { throw new PreparationProblem('MISSION_PREPARATION_SOURCE_UNAVAILABLE', { sourceFile: relative }); }
    const scripts = relative.endsWith('.vue') ? [...source.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]) : [source];
    try {
      missionAssert(scripts.length > 0 && scripts.length <= 2, 'MISSION_SOURCE_SCRIPT_INVALID');
      for (const script of scripts) {
        const parsed = ts.createSourceFile(relative, script, ts.ScriptTarget.Latest, true, relative.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
        missionAssert((parsed as ts.SourceFile & { parseDiagnostics: unknown[] }).parseDiagnostics.length === 0, 'MISSION_SOURCE_PARSE_ERROR');
        if (config.profile === 'NUXT_CANVAS_V1') validateSourceContract(relative, parsed);
      }
    } catch (error) { throw new PreparationProblem(problemCode(error), { sourceFile: relative }); }
    pins.push({ file: relative, sha256: createHash('sha256').update(source).digest('hex') });
  }
  return pins;
}

/** Strict endpoint availability is not a free-form model-name search; ambiguous aliases are rejected. */
function selectModel(body: unknown, modelId: string): Record<string, unknown> {
  missionAssert(Array.isArray(body) && body.length <= 1000, 'MISSION_MODEL_LIST_PROTOCOL_INVALID');
  const matches = body.map(object).filter(model => (nonempty(model.alias) ? model.alias.trim() : model.name) === modelId);
  missionAssert(matches.length === 1, 'MISSION_MODEL_IDENTITY_AMBIGUOUS_OR_MISSING');
  const model = matches[0];
  missionAssert((model.enabled === undefined || model.enabled === true) && !model.disabled_reason && Array.isArray(model.types) && model.types.every(nonempty) && model.types.includes('video_generate')
    && Number.isSafeInteger(model.panqu_selmodels_id) && Number(model.panqu_selmodels_id) > 0 && nonempty(model.name), 'MISSION_MODEL_DISABLED_OR_UNBOUND');
  missionAssert(own(object(model.capabilities), 'video_generate') && typeof own(object(model.capabilities), 'video_generate') === 'object'
    && !Array.isArray(own(object(model.capabilities), 'video_generate')), 'MISSION_CAPABILITY_MISSING');
  return { name: model.name, alias: nonempty(model.alias) ? model.alias.trim() : model.name, panqu_selmodels_id: model.panqu_selmodels_id,
    enabled: model.enabled, types: model.types, capability: object(model.capabilities).video_generate };
}

/** Design content is version-bound. Runtime outputs never become a substitute for saved design inputs. */
function canvasHash(body: unknown): string {
  const canvas = object(body);
  missionAssert(Array.isArray(canvas.flowNodes) && canvas.flowNodes.length <= 1000 && Array.isArray(canvas.flowEdges) && canvas.flowEdges.length <= 4000
    && Number.isSafeInteger(canvas.flowVersion) && Number(canvas.flowVersion) >= 0, 'MISSION_CANVAS_PROTOCOL_INVALID');
  return missionDigest({ version: canvas.flowVersion, nodes: canvas.flowNodes, edges: canvas.flowEdges });
}

/** Only isolated generation nodes can be reduced to one-node execution without losing upstream semantics. */
function selectNode(body: unknown, nodeId: string): Record<string, unknown> {
  canvasHash(body); const canvas = object(body); const nodes = (canvas.flowNodes as unknown[]).map(object).filter(node => node.id === nodeId);
  missionAssert(nodes.length === 1 && nodes[0].type === 'media.video' && !nodes[0].parentNode, 'MISSION_NODE_UNSUPPORTED');
  missionAssert(!(canvas.flowEdges as unknown[]).map(object).some(edge => edge.target === nodeId), 'MISSION_UPSTREAM_INPUTS_REQUIRE_ADAPTER');
  const node = nodes[0]; const data = object(node.data); const position = object(node.position);
  missionAssert(Number.isFinite(position.x) && Number.isFinite(position.y) && data.mode === 'generate' && data.videoGenerateMode === 'text_to_video', 'MISSION_NODE_MODE_UNSUPPORTED');
  for (const key of ['referenceImageUrls', 'referenceVideoUrls', 'referenceAudioUrls']) missionAssert(data[key] === undefined || Array.isArray(data[key]) && data[key].length === 0, 'MISSION_REFERENCE_INPUTS_REQUIRE_ADAPTER');
  const emptyRecord = (value: unknown) => value === undefined || value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0;
  missionAssert(emptyRecord(data.paramBindings) && emptyRecord(data.video_metadata_summary), 'MISSION_REFERENCE_INPUTS_REQUIRE_ADAPTER');
  missionAssert(data.videoGenParams === undefined || data.videoGenParams && typeof data.videoGenParams === 'object' && !Array.isArray(data.videoGenParams), 'MISSION_NODE_PARAMS_UNSUPPORTED');
  const gen = object(data.videoGenParams);
  missionAssert(Object.keys(gen).every(key => ['resolution', 'duration', 'aspect_ratio', 'audio', 'output_format', 'target_folder_id'].includes(key)), 'MISSION_NODE_PARAMS_UNSUPPORTED');
  missionAssert(gen.target_folder_id === undefined || Number.isSafeInteger(gen.target_folder_id) && Number(gen.target_folder_id) >= 0, 'MISSION_NODE_TARGET_FOLDER_INVALID');
  for (const key of ['flowInitialRuntimeSnapshot', 'flowRuntimeSnapshot']) {
    const runtime = object(canvas[key]);
    missionAssert(!['submitted', 'running'].includes(String(runtime.taskStatus)), 'MISSION_NODE_ALREADY_RUNNING');
  }
  return node;
}

/** Per-resolution maps retain their conditional domains; they are never flattened into a Cartesian product. */
function atQuality(value: unknown, quality: string): unknown {
  return Array.isArray(value) || typeof value === 'number' || value === undefined ? value : own(object(value), quality);
}

/** Enumerate an explicit finite duration domain. Missing steps or oversized sweeps require narrower scope. */
function durations(capability: Record<string, unknown>, quality: string, fixed?: number): number[] {
  const options = atQuality(capability.duration_options, quality); const range = atQuality(capability.duration_range, quality);
  const step = atQuality(capability.duration_step, quality);
  const valid = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 120;
  if (range !== undefined) missionAssert(Array.isArray(range) && range.length === 2 && range.every(valid) && range[0] <= range[1], 'MISSION_CAPABILITY_DURATION_RANGE_INVALID');
  if (step !== undefined) missionAssert(valid(step), 'MISSION_CAPABILITY_DURATION_STEP_INVALID');
  let values: number[];
  if (options !== undefined) {
    missionAssert(Array.isArray(options) && options.length > 0 && options.length <= 120 && options.every(valid), 'MISSION_CAPABILITY_DURATION_OPTIONS_INVALID');
    values = [...new Set(options as number[])];
    if (range) missionAssert(values.every(value => value >= (range as number[])[0] && value <= (range as number[])[1]), 'MISSION_CAPABILITY_DURATION_CONFLICT');
  } else {
    missionAssert(range && typeof step === 'number', 'MISSION_CAPABILITY_FINITE_DURATION_REQUIRED');
    const [min, max] = range as number[];
    if (fixed !== undefined) {
      missionAssert(valid(fixed) && fixed >= min && fixed <= max && Math.abs((fixed - min) / step - Math.round((fixed - min) / step)) < 1e-9, 'MISSION_REQUIRED_DURATION_UNSUPPORTED');
      return [fixed];
    }
    const count = Math.floor((max - min) / step + 1e-9) + 1;
    missionAssert(count > 0 && count <= MAX_CANDIDATES, 'MISSION_CANDIDATE_LIMIT_REQUIRES_SCOPE');
    values = Array.from({ length: count }, (_, index) => Number((min + index * step).toPrecision(12)));
  }
  if (fixed !== undefined) { missionAssert(values.includes(fixed), 'MISSION_REQUIRED_DURATION_UNSUPPORTED'); return [fixed]; }
  missionAssert(values.length <= MAX_CANDIDATES, 'MISSION_CANDIDATE_LIMIT_REQUIRES_SCOPE'); return values.sort((a, b) => a - b);
}

/** Convert an observed decimal quote conservatively without binary-float truncation or currency guessing. */
export function panquQuoteMilliCredits(body: unknown): number {
  const amounts: number[] = [];
  const convert = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined;
    missionAssert(typeof value === 'number' && Number.isFinite(value) || typeof value === 'string', 'MISSION_QUOTE_AMOUNT_INVALID');
    const text = String(value).trim(); missionAssert(/^\d+(?:\.\d{1,9})?$/.test(text), 'MISSION_QUOTE_AMOUNT_INVALID');
    const [whole, fraction = ''] = text.split('.');
    const milli = BigInt(whole) * 1000n + BigInt((fraction + '000').slice(0, 3)) + (/[1-9]/.test(fraction.slice(3)) ? 1n : 0n);
    missionAssert(milli <= BigInt(Number.MAX_SAFE_INTEGER), 'MISSION_QUOTE_AMOUNT_INVALID'); return Number(milli);
  };
  const visit = (value: unknown, depth: number) => {
    missionAssert(depth <= 4, 'MISSION_QUOTE_PROTOCOL_INVALID');
    if (typeof value === 'number' || typeof value === 'string') { amounts.push(convert(value)!); return; }
    const record = object(value);
    missionAssert(record.success !== false && record.ok !== false && !record.error
      && (record.code === undefined || record.code === 0 || record.code === 1), 'MISSION_QUOTE_REJECTED');
    for (const key of ['amount', 'estimatedPower', 'estimated_power']) { const amount = convert(record[key]); if (amount !== undefined) amounts.push(amount); }
    if (record.data !== undefined && record.data !== null) visit(record.data, depth + 1);
  };
  visit(body, 0); missionAssert(amounts.length > 0 && amounts.every(amount => amount === amounts[0]), 'MISSION_QUOTE_MISSING_OR_CONFLICTING'); return amounts[0];
}

/** If the estimator explicitly echoes model identity, contradictory identity cannot be used as a quote. */
function validateQuoteModel(body: unknown, model: Record<string, unknown>, depth = 0): void {
  missionAssert(depth <= 4, 'MISSION_QUOTE_PROTOCOL_INVALID');
  const record = object(body); const discount = object(object(record.calculation).platformModelDiscount);
  if (discount.model !== undefined) {
    const echoed = object(discount.model);
    if (typeof discount.model === 'string') missionAssert([model.alias, model.name].includes(discount.model), 'MISSION_QUOTE_MODEL_MISMATCH');
    else {
      missionAssert(nonempty(echoed.name) && echoed.name === model.name, 'MISSION_QUOTE_MODEL_MISMATCH');
      if (echoed.alias !== undefined) missionAssert(echoed.alias === model.alias, 'MISSION_QUOTE_MODEL_MISMATCH');
      if (echoed.panqu_selmodels_id !== undefined) missionAssert(echoed.panqu_selmodels_id === model.panqu_selmodels_id, 'MISSION_QUOTE_MODEL_MISMATCH');
    }
  }
  if (record.data !== undefined && record.data !== null) validateQuoteModel(record.data, model, depth + 1);
}

/** Immutable plan files cannot overwrite a user-edited or symlinked artifact with the same name. */
async function savePreparedPlan(file: string, plan: PanquMissionPlan): Promise<void> {
  const content = JSON.stringify(plan, null, 2);
  try { await writeFile(file, content, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    missionAssert(equal(await readPanquMissionJson(file), plan), 'MISSION_PLAN_FILE_CONFLICT');
  }
}

/** Build executable payloads from source-backed fields, not model-authored JSON pointers or raw commands. */
function candidates(intent: PanquMissionIntent, model: Record<string, unknown>, canvasBody: unknown, observedAt: string): Array<{ variant: PanquMissionVariant; params: Record<string, unknown> }> {
  const node = selectNode(canvasBody, intent.nodeId); const data = object(node.data); const saved = object(data.videoGenParams); const cap = object(model.capability);
  const prompt = intent.prompt ?? data.prompt;
  missionAssert(nonempty(prompt) && [...prompt].length <= 8192, 'MISSION_PROMPT_REQUIRED');
  if (cap.prompt_length_limit !== undefined) {
    const limit = object(cap.prompt_length_limit);
    missionAssert(Number.isSafeInteger(limit.max) && Number(limit.max) > 0 && ['unicode', 'non_ascii_weighted'].includes(String(limit.count_mode)), 'MISSION_PROMPT_COUNTING_RULE_REQUIRED');
    const length = [...prompt].reduce((sum, point) => sum + (limit.count_mode === 'non_ascii_weighted' && point.codePointAt(0)! > 127 ? 2 : 1), 0);
    missionAssert(length <= Number(limit.max), 'MISSION_PROMPT_OUTSIDE_CONFIRMED_LIMITS');
  }
  missionAssert(!intent.audio || cap.output_audio === true, 'MISSION_CAPABILITY_AUDIO_UNSUPPORTED');
  missionAssert(Array.isArray(cap.output_resolutions) && cap.output_resolutions.length > 0 && cap.output_resolutions.every(nonempty), 'MISSION_CAPABILITY_RESOLUTIONS_REQUIRED');
  missionAssert(Array.isArray(cap.aspect_ratio_allowed) && cap.aspect_ratio_allowed.length > 0 && cap.aspect_ratio_allowed.every(nonempty), 'MISSION_CAPABILITY_ASPECT_RATIOS_REQUIRED');
  const profiles = intent.outputProfiles.filter(profile => intent.required?.quality === undefined || profile.quality === intent.required.quality);
  missionAssert(profiles.length > 0, 'MISSION_REQUIRED_PROFILE_UNAVAILABLE');
  const results: Array<{ variant: PanquMissionVariant; params: Record<string, unknown> }> = []; const ids = new Set<string>();
  for (const profile of profiles) {
    missionAssert((cap.output_resolutions as unknown[]).includes(profile.quality) && (cap.aspect_ratio_allowed as unknown[]).includes(profile.aspectRatio), 'MISSION_OUTPUT_PROFILE_NOT_SUPPORTED');
    const [numerator, denominator] = profile.aspectRatio.split(':').map(Number);
    missionAssert(profile.width * denominator === profile.height * numerator, 'MISSION_OUTPUT_ORACLE_ASPECT_CONFLICT');
    if (cap.width_height_range !== undefined) {
      const range = cap.width_height_range;
      missionAssert(Array.isArray(range) && range.length === 2 && range.every(value => Number.isFinite(value) && value > 0) && range[0] <= range[1], 'MISSION_CAPABILITY_SIZE_RANGE_INVALID');
      missionAssert([profile.width, profile.height].every(value => value >= range[0] && value <= range[1]), 'MISSION_OUTPUT_PROFILE_NOT_SUPPORTED');
    }
    if (cap.aspect_ratio_range !== undefined) {
      const range = cap.aspect_ratio_range;
      missionAssert(Array.isArray(range) && range.length === 2 && range.every(value => Number.isFinite(value) && value > 0) && range[0] <= range[1], 'MISSION_CAPABILITY_ASPECT_RANGE_INVALID');
      missionAssert(numerator / denominator >= range[0] && numerator / denominator <= range[1], 'MISSION_OUTPUT_PROFILE_NOT_SUPPORTED');
    }
    const route = own(object(cap.resolution_routes), profile.quality);
    missionAssert(route === undefined || object(route).mode === 'native' && object(route).generation_resolution === profile.quality, 'MISSION_CAPABILITY_UPSCALE_ADAPTER_REQUIRED');
    const format = saved.output_format ?? cap.default_output_format;
    if (format !== undefined) missionAssert(nonempty(format) && Array.isArray(cap.output_formats) && cap.output_formats.includes(format), 'MISSION_CAPABILITY_OUTPUT_FORMAT_UNVERIFIED');
    for (const duration of durations(cap, profile.quality, intent.required?.durationSeconds)) {
      const parameters = { quality: profile.quality, durationSeconds: duration, width: profile.width, height: profile.height, count: 1 };
      const id = `video-${missionDigest({ parameters, aspectRatio: profile.aspectRatio }).slice(0, 16)}`;
      missionAssert(!ids.has(id), 'MISSION_OUTPUT_PROFILES_DUPLICATE'); ids.add(id);
      const gen = { resolution: profile.quality, duration, aspect_ratio: profile.aspectRatio, audio: intent.audio,
        ...(format === undefined ? {} : { output_format: format }), ...(saved.target_folder_id === undefined ? {} : { target_folder_id: saved.target_folder_id }) };
      const cleanData = { mode: 'generate', source: 'generate', pathCommitted: 'generate', model: model.alias, panqu_selmodels_id: model.panqu_selmodels_id,
        prompt, videoGenParams: gen, videoGenerateMode: 'text_to_video', paramBindings: {}, referenceImageUrls: [], referenceVideoUrls: [], video_metadata_summary: {}, referenceAudioUrls: [] };
      const request = { projectId: intent.projectId, nodeId: intent.nodeId, mode: 'node', graph: { canvasId: intent.projectId, version: object(canvasBody).flowVersion,
        nodes: [{ id: intent.nodeId, type: 'media.video', position: node.position, data: cleanData }], edges: [], outputs: {},
        updatedAt: observedAt } };
      const params = { model: model.alias, prompt, ...gen, videoGenerateMode: 'text_to_video', referenceImageUrls: [], referenceVideoUrls: [], video_metadata_summary: {}, referenceAudioUrls: [] };
      results.push({ variant: { id, modelId: intent.requirement.modelId, mode: intent.requirement.mode, parameters, request, maxMilliCredits: 0 }, params });
    }
  }
  missionAssert(results.length > 0 && results.length <= MAX_CANDIDATES, 'MISSION_CANDIDATE_LIMIT_REQUIRES_SCOPE'); return results;
}

/** The execution-side freshness check uses the same fixed protocols and never performs a generation. */
export async function revalidatePreparedPanquMission(plan: PanquMissionPlan, config: PanquMissionPreparationConfig, signal: AbortSignal): Promise<void> {
  const evidence = plan.variant.preparation;
  missionAssert(evidence?.schema === 'panqu.nuxt-video-preparation.v1' && evidence.contextHash === panquPreparationContextHash(config)
    && evidence.origin === config.origin && evidence.actorRef === config.actorRef && evidence.apiBasePath === (config.apiBasePath ?? '')
    && Array.isArray(evidence.quotes) && evidence.quotes.length > 0 && evidence.quotes.length <= MAX_CANDIDATES, 'MISSION_PREPARATION_BINDING_INVALID');
  validateInputs(evidence.intent, undefined as unknown as PanquMissionReadAccess, config, false);
  missionAssert(evidence.intentId === evidence.intent.intentId && evidence.intentHash === missionDigest(evidence.intent)
    && equal(evidence.intent.requirement, plan.requirement) && evidence.intent.projectId === plan.projectId && evidence.intent.nodeId === plan.nodeId
    && evidence.intent.maxMilliCredits === plan.maxMilliCredits && Number.isFinite(Date.parse(evidence.observedAt))
    && Date.parse(plan.quote.expiresAt) <= Date.parse(evidence.observedAt) + FRESHNESS_MS, 'MISSION_PREPARATION_INTENT_BINDING_INVALID');
  const models = await fetchPanquMissionJson(config, '/integration-platform/models/strict/video_generate', 'GET', undefined, signal);
  const model = selectModel(models, plan.requirement.modelId);
  missionAssert(missionDigest(model) === evidence.modelHash, 'MISSION_LIVE_MODEL_CHANGED');
  const canvas = await fetchPanquMissionJson(config, `/project/${encodeURIComponent(plan.projectId)}/canvas-flow`, 'GET', undefined, signal);
  selectNode(canvas, plan.nodeId); missionAssert(canvasHash(canvas) === evidence.canvasHash, 'MISSION_LIVE_CANVAS_CHANGED');
  const expected = candidates(evidence.intent, model, canvas, evidence.observedAt);
  missionAssert(expected.length === evidence.quotes.length && expected.every((option, index) => evidence.quotes[index].variantId === option.variant.id
    && equal(evidence.quotes[index].params, option.params)), 'MISSION_PREPARATION_QUOTE_SCOPE_MISMATCH');
  const expectedSelection = expected.find(option => option.variant.id === plan.variant.id);
  missionAssert(expectedSelection && equal(expectedSelection.variant.request, plan.variant.request)
    && equal(expectedSelection.variant.parameters, plan.variant.parameters), 'MISSION_PREPARATION_PAYLOAD_MISMATCH');
  for (const quote of evidence.quotes) {
    missionAssert(object(quote.params).model === plan.requirement.modelId && validMilliCredits(quote.milliCredits), 'MISSION_PREPARATION_QUOTE_BINDING_INVALID');
    const current = await fetchPanquMissionJson(config, '/integration-platform/models/estimatedBilling', 'POST', JSON.stringify({ params: quote.params }), signal, true);
    validateQuoteModel(current, model);
    missionAssert(panquQuoteMilliCredits(current) === quote.milliCredits, 'MISSION_LIVE_QUOTE_CHANGED');
  }
  const selected = evidence.quotes.filter(quote => quote.variantId === plan.variant.id);
  missionAssert(selected.length === 1 && selected[0].milliCredits === plan.variant.maxMilliCredits, 'MISSION_PREPARATION_QUOTE_BINDING_INVALID');
  const eligible = evidence.quotes.filter(quote => !plan.requirement.requiredVariantId || quote.variantId === plan.requirement.requiredVariantId);
  missionAssert(eligible.length > 0 && eligible.every(quote => quote.milliCredits >= selected[0].milliCredits), 'MISSION_PREPARATION_NOT_MINIMUM_COST');
}

/** Prepare a durable, permission-separated intent. Re-entry after any submission returns the original task. */
export async function preparePanquMission(input: { intent: PanquMissionIntent; access: PanquMissionReadAccess; config: PanquMissionPreparationConfig;
  directory: string; recoverDeadLock?: boolean; signal?: AbortSignal }): Promise<PanquMissionPreparationResult> {
  const intent = structuredClone(input.intent); const config = structuredClone(input.config); const access = structuredClone(input.access);
  const result: PanquMissionPreparationResult = { schema: 'panqu.mission-preparation.v1', state: 'BLOCKED', nextAction: 'RESOLVE_PREPARATION_GAP',
    intentId: intent?.intentId, events: [], requests: { models: 0, canvas: 0, estimates: 0, generation: 0 }, problems: [] };
  const mark = (stage: string, code: string) => result.events.push({ sequence: result.events.length + 1, stage, code });
  try {
    validateInputs(intent, access, config, false); mark('VALIDATE_SCOPE', 'INTENT_SCOPE_VALIDATED');
    const directory = await ensurePanquMissionDirectory(input.directory); const registryFile = path.join(directory, `intent-${intent.intentId}.json`);
    return await withPanquMissionLock(`${registryFile}.lock`, intent.intentId, input.recoverDeadLock === true, async () => {
      const intentHash = missionDigest(intent); const contextHash = panquPreparationContextHash(config);
      let registry: IntentRegistry | undefined;
      try { registry = await readPanquMissionJson<IntentRegistry>(registryFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (registry) {
        missionAssert(registry.schema === 'panqu.mission-intent-registry.v1' && registry.intentHash === intentHash && registry.contextHash === contextHash
          && /^[a-f0-9]{64}$/.test(registry.planHash), 'MISSION_INTENT_CHANGED');
        let journal: PanquMissionJournal | undefined;
        try { journal = await readPanquMissionJson<PanquMissionJournal>(path.join(directory, `${registry.planHash}.json`)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        if (journal) {
          missionAssert(journal.schema === 'panqu.mission-journal.v1' && journal.planHash === registry.planHash
            && Number.isSafeInteger(journal.submissionAttempts) && journal.submissionAttempts >= 0 && journal.submissionAttempts <= 1, 'MISSION_INTENT_JOURNAL_INVALID');
          if (journal.submissionAttempts > 0) {
            result.state = 'EXISTING_TASK'; result.existingPlanHash = registry.planHash; result.planFile = `${registry.planHash}.plan.json`;
            result.nextAction = ['SUBMITTING', 'SUBMISSION_UNKNOWN'].includes(journal.state) ? 'RECONCILE_SUBMISSION'
              : ['PASSED', 'FAILED'].includes(journal.state) ? 'REVIEW_EXISTING_RESULT' : 'RESUME_EXISTING_TASK';
            mark('RECOVER_INTENT', 'EXISTING_SUBMISSION_REUSED'); return result;
          }
        }
      }
      validateInputs(intent, access, config); mark('VALIDATE_ACCESS', 'READ_ONLY_ACCESS_VERIFIED');
      const sourcePins = await collectSourcePins(config); mark('READ_PROJECT', 'ADAPTER_SOURCES_PINNED');
      const expires = Math.min(Date.now() + 60_000, Date.parse(access.expiresAt));
      missionAssert(expires > Date.now(), 'MISSION_READ_ACCESS_EXPIRED');
      const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, expires - Date.now())), ...(input.signal ? [input.signal] : [])]);
      const observedAt = new Date().toISOString();
      result.requests.models++;
      if (config.profile === 'PHP_VIDEO_V1') {
        const body = object(await fetchPanquMissionJson(config, '/aivideo/v2/video/getPanquaivideoModels', 'GET', undefined, signal));
        missionAssert(body.code === 1 && Array.isArray(body.data), 'MISSION_MODEL_LIST_PROTOCOL_INVALID');
        mark('READ_MODELS', 'PHP_MODEL_LIST_OBSERVED'); throw new Error('MISSION_PHP_AUTOPLAN_CONTRACT_MISSING');
      }
      const models = await fetchPanquMissionJson(config, '/integration-platform/models/strict/video_generate', 'GET', undefined, signal);
      const model = selectModel(models, intent.requirement.modelId); mark('READ_MODELS', 'TARGET_MODEL_AND_CAPABILITY_BOUND');
      result.requests.canvas++;
      const canvas = await fetchPanquMissionJson(config, `/project/${encodeURIComponent(intent.projectId)}/canvas-flow`, 'GET', undefined, signal);
      const options = candidates(intent, model, canvas, observedAt); mark('EXPAND_PARAMETERS', 'COMPLETE_FINITE_DOMAIN_COMPILED');
      missionAssert(options.length <= access.maxEstimateRequests, 'MISSION_ESTIMATE_REQUEST_BUDGET_EXCEEDED');
      const quotes: PanquMissionPreparationEvidence['quotes'] = [];
      for (const option of options) {
        missionAssert(!signal.aborted && Date.parse(access.expiresAt) > Date.now(), 'MISSION_READ_ACCESS_EXPIRED'); result.requests.estimates++;
        try {
          const body = await fetchPanquMissionJson(config, '/integration-platform/models/estimatedBilling', 'POST', JSON.stringify({ params: option.params }), signal, true);
          validateQuoteModel(body, model);
          option.variant.maxMilliCredits = panquQuoteMilliCredits(body);
        } catch (error) { throw new PreparationProblem(problemCode(error), { variantId: option.variant.id, field: 'estimatedBilling.params' }); }
        quotes.push({ variantId: option.variant.id, params: option.params, milliCredits: option.variant.maxMilliCredits }); mark('ESTIMATE_CANDIDATE', option.variant.id);
      }
      missionAssert(equal(sourcePins, await collectSourcePins(config)), 'MISSION_SOURCE_CHANGED_DURING_PREPARATION');
      const evidence: PanquMissionPreparationEvidence = { schema: 'panqu.nuxt-video-preparation.v1', intentId: intent.intentId, intentHash, intent, contextHash,
        origin: config.origin, actorRef: config.actorRef, apiBasePath: config.apiBasePath ?? '', observedAt, modelHash: missionDigest(model), canvasHash: canvasHash(canvas), quotes };
      for (const option of options) option.variant.preparation = evidence;
      const catalog: PanquMissionCatalog = { schema: 'panqu.catalog.v1', profile: config.profile, projectId: intent.projectId, nodeId: intent.nodeId, sourcePins,
        source: 'Live strict video_generate capability and Panqu-credit estimatedBilling; estimate is not a debit receipt or server hard cap.',
        expiresAt: new Date(Math.min(Date.parse(observedAt) + FRESHNESS_MS, Date.parse(access.expiresAt))).toISOString(), variants: options.map(option => option.variant) };
      const plan = compilePanquMission({ schema: 'panqu.mission.v1', requirement: intent.requirement, maxMilliCredits: intent.maxMilliCredits,
        proposal: intent.proposal, materials: [] }, catalog);
      missionAssert(Date.parse(access.expiresAt) > Date.now() && !signal.aborted, 'MISSION_READ_ACCESS_EXPIRED');
      result.state = 'READY_FOR_APPROVAL'; result.nextAction = 'CONFIRM_EXACT_PLAN'; result.plan = plan; result.planFile = `${plan.hash}.plan.json`;
      result.candidates = options.map(option => ({ id: option.variant.id, quality: option.variant.parameters.quality,
        durationSeconds: option.variant.parameters.durationSeconds!, milliCredits: option.variant.maxMilliCredits }));
      await savePreparedPlan(path.join(directory, result.planFile), plan);
      await savePanquMissionJson(registryFile, { schema: 'panqu.mission-intent-registry.v1', intentHash, contextHash, planHash: plan.hash });
      mark('COMPILE_PLAN', 'LOWEST_COMPLETE_QUOTE_SELECTED_AWAITING_APPROVAL'); return result;
    });
  } catch (error) {
    const code = problemCode(error);
    result.state = 'BLOCKED'; result.nextAction = 'RESOLVE_PREPARATION_GAP'; delete result.plan; delete result.planFile;
    result.problems.push({ code, resolution: resolutionFor(code), ...(error instanceof PreparationProblem ? error.context : {}) }); mark('STOP', code); return result;
  }
}
