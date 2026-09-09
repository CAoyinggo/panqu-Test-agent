import { createHash } from 'node:crypto';
import type { PanquMissionCatalog, PanquMissionPlan, PanquMissionSpec, PanquMissionVariant } from './panqu-mission-types.js';

/** Stable hashing binds exact types, order-sensitive arrays, source, payload, assets and cost. */
export function missionDigest(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item && typeof item === 'object' ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)])) : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}
export function missionAssert(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
export const validMilliCredits = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

/** Catalogs come from the operator/project adapter. Proposals never supply catalog prices or legal combinations. */
export function compilePanquMission(spec: PanquMissionSpec, catalog: PanquMissionCatalog, now = Date.now()): PanquMissionPlan {
  missionAssert(spec?.schema === 'panqu.mission.v1' && catalog?.schema === 'panqu.catalog.v1', 'MISSION_SCHEMA_INVALID');
  const requirement = spec.requirement;
  missionAssert(requirement?.confirmed === true && nonempty(requirement.source) && nonempty(requirement.statement)
    && nonempty(requirement.modelId) && nonempty(requirement.mode) && ['image', 'video'].includes(requirement.kind), 'MISSION_REQUIREMENT_UNCONFIRMED');
  missionAssert(validMilliCredits(spec.maxMilliCredits), 'MISSION_BUDGET_INVALID');
  missionAssert(spec.prompt === undefined || typeof spec.prompt === 'string', 'MISSION_PROMPT_INVALID');
  missionAssert(catalog.profile !== 'NUXT_CANVAS_V1' || spec.prompt === undefined, 'MISSION_NUXT_PROMPT_BINDING_REQUIRED');
  missionAssert(['PHP_VIDEO_V1', 'NUXT_CANVAS_V1'].includes(catalog.profile) && nonempty(catalog.projectId) && nonempty(catalog.nodeId), 'MISSION_PROJECT_BINDING_INVALID');
  missionAssert(nonempty(catalog.source) && Number.isFinite(Date.parse(catalog.expiresAt)) && Date.parse(catalog.expiresAt) > now, 'MISSION_QUOTE_EXPIRED_OR_UNVERIFIED');
  missionAssert(Array.isArray(catalog.sourcePins) && catalog.sourcePins.length > 0 && catalog.sourcePins.every(pin => nonempty(pin.file) && /^[a-f0-9]{64}$/.test(pin.sha256)), 'MISSION_SOURCE_PINS_REQUIRED');
  missionAssert(Array.isArray(catalog.variants) && catalog.variants.length > 0 && catalog.variants.length <= 256, 'MISSION_CATALOG_INVALID');
  const ids = new Set<string>();
  for (const variant of catalog.variants) {
    missionAssert(nonempty(variant.id) && !ids.has(variant.id) && nonempty(variant.modelId) && nonempty(variant.mode), 'MISSION_VARIANT_ID_INVALID'); ids.add(variant.id);
    missionAssert(validMilliCredits(variant.maxMilliCredits), 'MISSION_QUOTE_COST_UNKNOWN');
    const params = variant.parameters;
    missionAssert(params && Number.isSafeInteger(params.width) && params.width > 0 && Number.isSafeInteger(params.height) && params.height > 0
      && Number.isSafeInteger(params.count) && params.count > 0 && nonempty(params.quality)
      && (params.durationSeconds === undefined || Number.isFinite(params.durationSeconds) && params.durationSeconds > 0), 'MISSION_PARAMETERS_INVALID');
    missionAssert(variant.request && typeof variant.request === 'object' && !Array.isArray(variant.request), 'MISSION_PAYLOAD_MISSING');
    // Credentials must be injected by the trusted runtime, never catalog/spec/model text.
    missionAssert(!/(?:"(?:authorization|cookie|password|__token__|access_token|api_key|secret)"\s*:)/i.test(JSON.stringify(variant.request)), 'MISSION_INLINE_CREDENTIALS_FORBIDDEN');
  }
  missionAssert(Array.isArray(spec.materials) && spec.materials.length <= 32 && spec.materials.every(material => nonempty(material.file)
    && /^[a-f0-9]{64}$/.test(material.sha256) && Number.isSafeInteger(material.bytes) && material.bytes > 0), 'MISSION_MATERIAL_MANIFEST_INVALID');
  const eligible = catalog.variants.filter(variant => variant.modelId === requirement.modelId && variant.mode === requirement.mode
    && (!requirement.requiredVariantId || variant.id === requirement.requiredVariantId)
    && (requirement.kind !== 'video' || variant.parameters.durationSeconds !== undefined));
  missionAssert(eligible.length, 'MISSION_NO_LEGAL_VARIANT_FOR_REQUIREMENT');
  const order = (a: PanquMissionVariant, b: PanquMissionVariant) => a.maxMilliCredits - b.maxMilliCredits
    || a.parameters.count - b.parameters.count || (a.parameters.durationSeconds ?? 0) - (b.parameters.durationSeconds ?? 0)
    || a.parameters.width * a.parameters.height - b.parameters.width * b.parameters.height || a.id.localeCompare(b.id);
  const variant = structuredClone([...eligible].sort(order)[0]);
  missionAssert(variant.maxMilliCredits <= spec.maxMilliCredits, 'MISSION_BUDGET_INSUFFICIENT_NO_DOWNGRADE');
  const decisions: PanquMissionPlan['decisions'] = [{ code: 'MINIMUM_VERIFIED_COST', detail: `Selected ${variant.id} from ${eligible.length} legal candidates; reserved ${variant.maxMilliCredits} milli-credits.` }];
  if (catalog.profile === 'PHP_VIDEO_V1' && (spec.prompt !== undefined || !variant.request['row[extra][cueword]'])) {
    const limits = catalog.promptConstraints;
    missionAssert(limits && nonempty(limits.source) && Number.isSafeInteger(limits.minCodePoints) && Number.isSafeInteger(limits.maxCodePoints)
      && limits.minCodePoints >= 1 && limits.maxCodePoints >= limits.minCodePoints && limits.maxCodePoints <= 8192, 'MISSION_PROMPT_CONSTRAINTS_REQUIRED');
    const seed = 'A red ball rolls slowly on a plain grey floor. Fixed camera. ';
    const prompt = spec.prompt ?? seed.repeat(Math.ceil(limits.minCodePoints / seed.length) + 1).slice(0, Math.min(limits.maxCodePoints, Math.max(seed.length, limits.minCodePoints)));
    const count = [...prompt].length;
    missionAssert(count >= limits.minCodePoints && count <= limits.maxCodePoints, 'MISSION_PROMPT_OUTSIDE_CONFIRMED_LIMITS');
    variant.request['row[extra][cueword]'] = prompt; variant.request['row[extra][cueword_html]'] = prompt;
    decisions.push({ code: spec.prompt === undefined ? 'TEST_PROMPT_PREPARED' : 'SUPPLIED_PROMPT_VALIDATED', detail: `Prepared ${count} code points within the explicitly supplied prompt bounds.` });
  }
  if (spec.proposal?.variantId && spec.proposal.variantId !== variant.id) decisions.push({ code: 'MODEL_PROPOSAL_CORRECTED', detail: 'The proposed variant was not the minimum-cost legal selection for the confirmed requirement.' });
  if (requirement.requiredVariantId) decisions.push({ code: 'REQUIREMENT_PRESERVED', detail: 'The specifically required boundary/quality variant was not downgraded.' });
  const data = JSON.parse(JSON.stringify({ schema: 'panqu.mission-plan.v1', requirement, profile: catalog.profile, projectId: catalog.projectId, nodeId: catalog.nodeId,
    sourcePins: catalog.sourcePins, quote: { source: catalog.source, expiresAt: catalog.expiresAt, catalogHash: missionDigest(catalog) },
    variant, maxMilliCredits: spec.maxMilliCredits, materials: spec.materials, decisions })) as Omit<PanquMissionPlan, 'hash'>;
  return { ...data, hash: missionDigest(data) };
}

/** Public execution cannot trust a caller-mutated plan object or newly supplied model verdict. */
export function verifyMissionPlan(plan: PanquMissionPlan): void {
  const { hash, ...data } = plan;
  missionAssert(plan.schema === 'panqu.mission-plan.v1' && hash === missionDigest(data), 'MISSION_PLAN_TAMPERED');
}
