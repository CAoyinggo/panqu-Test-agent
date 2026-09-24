/**
 * 分流可测性接线集成测试
 * 验证两处「纯判定模块 → verify 流水线」接线：
 *  1. resolveVerifyContext 从飞书《分流渠道表》权威快照自动取刊例价（pricingAuthority，opt-in）；
 *  2. DiversionEligibilityProducer 把「预测分流决策」与「落库分流标记」对照产出可裁决证据。
 * 100% 离线。
 */
import { describe, it, expect } from 'vitest';
import { verify } from '../../../src/devtest/core-kernel.js';
import { resolveVerifyContext } from '../../../src/devtest/verify-pipeline.js';
import {
  DiversionEligibilityProducer,
  type DiversionEligibilityInput,
} from '../../../src/devtest/diversion-eligibility-producer.js';
import { validateEvidenceEnvelope } from '../../../src/devtest/canonical-protocol.js';
import type { DatabaseRawCollection } from '../../../src/devtest/database-evidence-producer.js';

const routeRules = { video: { '78': { resolutions: ['720p'], aspect_ratios: ['16:9'] } } };
const ctx = {
  testId: 't-div',
  environment: 'test',
  subjectType: 'task',
  subjectId: 500,
  taskId: 500,
  capturedAt: '2026-09-24T12:00:00.000Z',
};

function dbWith(extra: Record<string, unknown>, line?: number): DatabaseRawCollection {
  return {
    status: 'VERIFIED',
    taskId: '500',
    recordsFound: {
      pq_aivideo_new: { id: 500, extra: JSON.stringify(extra) },
      pq_volcengine_ai_task: line !== undefined ? { id: 9, source_id: 500, line } : { id: 9, source_id: 500 },
    },
  } as unknown as DatabaseRawCollection;
}

describe('pricingAuthority 接线 (resolveVerifyContext 自动取刊例价)', () => {
  it('视频：Seedance2.0@720p → pointsPerSecond=30，expectedPoints=30×duration', async () => {
    const c = await resolveVerifyContext({
      taskId: 1,
      modelId: 16,
      mediaType: 'video',
      duration: 4,
      resolution: '720p',
      pricingAuthority: { model: 'Seedance2.0', resolution: '720p' },
    });
    expect(c.pointsPerSecond).toBe(30);
    expect(c.expectedPoints).toBe(120);
  });

  it('调用方显式 pointsPerSecond 优先于权威表', async () => {
    const c = await resolveVerifyContext({
      taskId: 1,
      modelId: 16,
      mediaType: 'video',
      duration: 4,
      resolution: '720p',
      pointsPerSecond: 99,
      pricingAuthority: { model: 'Seedance2.0', resolution: '720p' },
    });
    expect(c.pointsPerSecond).toBe(99);
  });

  it('表中无此组合时静默回退（不抛错）', async () => {
    const c = await resolveVerifyContext({
      taskId: 1,
      modelId: 16,
      mediaType: 'video',
      duration: 4,
      resolution: '720p',
      pricingAuthority: { model: 'NoSuchModel', resolution: '720p' },
    });
    expect(c.pointsPerSecond).toBeUndefined();
  });
});

// APPEND_PRODUCER_TESTS

describe('DiversionEligibilityProducer (预测 vs 落库分流标记)', () => {
  const predictDivert: DiversionEligibilityInput = {
    mediaType: 'video',
    video: {
      routeMode: 'newapi',
      eligible: true,
      modelId: 78,
      isGlobalModel: true, // 全量→跳过分辨率/画面比例，命中 line 10
      alias: 'seedance-2.0',
      hasGlobalApiKey: true,
      resolution: '720p',
      aspect: '16:9',
      routeRules,
    },
  };

  it('预测分流 + 落库已分流(diversion=10,line=10) → PASS，信封合规', () => {
    const producer = new DiversionEligibilityProducer(predictDivert, dbWith({ diversion: 10 }, 10));
    const envs = producer.produce({}, ctx);
    expect(envs).toHaveLength(1);
    const e = envs[0];
    expect(e.evidenceKey).toBe('SERVER_API:DIVERSION_ELIGIBILITY');
    expect(e.observationStatus).toBe('PASS');
    expect(e.normalizedFields.predictedLine).toBe(10);
    expect(e.normalizedFields.observedDiverted).toBe(true);
    expect(e.normalizedFields.matched).toBe(true);
    expect(validateEvidenceEnvelope(e).valid).toBe(true);
  });

  it('预测分流 + 落库未分流(diversion=0) → FAIL（暴露路由与预期不符）', () => {
    const producer = new DiversionEligibilityProducer(predictDivert, dbWith({ diversion: 0 }));
    const e = producer.produce({}, ctx)[0];
    expect(e.observationStatus).toBe('FAIL');
    expect(e.normalizedFields.matched).toBe(false);
  });

  it('无落库对照 → UNVERIFIED（只有预测，不臆断）', () => {
    const producer = new DiversionEligibilityProducer(predictDivert, undefined);
    const e = producer.produce({}, ctx)[0];
    expect(e.observationStatus).toBe('UNVERIFIED');
    expect(e.normalizedFields.hasObserved).toBe(false);
  });

  it('图片：预测分流 + 落库 newapi_image=1 → PASS', () => {
    const input: DiversionEligibilityInput = {
      mediaType: 'image',
      image: {
        selmodelsId: 1201,
        isGlobalModel: true,
        alias: 'gemini-3-pro-image',
        hasGlobalApiKey: true,
        serviceline: 'r',
        resolution: '2k',
        aspect: '1:1',
        routeRules: { image: { '1201': { channels: [{ resolutions: ['2K'], aspect_ratios: ['1:1'] }] } } },
      },
    };
    const producer = new DiversionEligibilityProducer(input, dbWith({ newapi_image: 1 }));
    const e = producer.produce({}, ctx)[0];
    expect(e.normalizedFields.predictedDecision).toBe('NEWAPI_IMAGE_GLOBAL');
    expect(e.observationStatus).toBe('PASS');
  });

  it('无输入 → 不产证据（opt-in）', () => {
    const producer = new DiversionEligibilityProducer(undefined, undefined);
    expect(producer.produce({}, ctx)).toHaveLength(0);
  });
});

describe('verify() 集成：diversionEligibility 自动挂载 producer', () => {
  it('传入 diversionEligibility 时结果含 SERVER_API:DIVERSION_ELIGIBILITY 信封', async () => {
    const result = await verify({
      taskId: 500,
      modelId: 16,
      mediaType: 'video',
      duration: 4,
      resolution: '720p',
      dbRawCollection: dbWith({ diversion: 10, deduct_points: 120 }, 10),
      diversionEligibility: {
        mediaType: 'video',
        video: {
          routeMode: 'newapi',
          eligible: true,
          modelId: 78,
          isGlobalModel: true,
          alias: 'seedance-2.0',
          hasGlobalApiKey: true,
          resolution: '720p',
          aspect: '16:9',
          routeRules,
        },
      },
    });
    const env = result.canonicalEnvelopes?.find((e) => e.evidenceKey === 'SERVER_API:DIVERSION_ELIGIBILITY');
    expect(env).toBeDefined();
    expect(env?.observationStatus).toBe('PASS');
  });
});

