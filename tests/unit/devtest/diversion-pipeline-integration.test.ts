/**
 * 分流可测性接线集成测试
 * 验证两处「纯判定模块 → verify 流水线」接线：
 *  1. resolveVerifyContext 从飞书《分流渠道表》权威快照自动取刊例价（pricingAuthority，opt-in）；
 *  2. DiversionEligibilityProducer 把「预测分流决策」与「落库分流标记」对照产出可裁决证据。
 * 100% 离线。
 */
import { describe, it, expect } from 'vitest';
import { verify } from '../../../src/devtest/core-kernel.js';
import { resolveVerifyContext, buildAutoDiversionEligibility } from '../../../src/devtest/verify-pipeline.js';
import { collectTaskEvidence } from '../../../src/devtest/evidence-collectors.js';
import type { DiversionConfigRawCollection } from '../../../src/devtest/diversion-config-reader.js';
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

describe('autoDiversionEligibility 一键化（读 line=10 配置自动构造断言）', () => {
  const cfg: DiversionConfigRawCollection = {
    status: 'VERIFIED',
    routeMode: 'newapi',
    routeRules: {
      video: { '78': { resolutions: ['720p', '1080p'], aspect_ratios: ['16:9', 'auto'] } },
      image: { '12': { channels: [{ resolutions: ['2k'], aspect_ratios: ['1:1'] }] } },
    },
    groupRules: {},
    globalApiKeyConfigured: true,
    globalModelIds: [12],
    aliasMap: { '78': 'seedance-2.5', '12': 'pan-banana-pro' },
  };

  it('buildAutoDiversionEligibility：给 config 时从库侧规则+模型上下文自动补全 video 输入', async () => {
    const input = await buildAutoDiversionEligibility(
      {
        taskId: 1,
        modelId: 78,
        mediaType: 'video',
        autoDiversionEligibility: {
          config: cfg,
          resolution: '720p',
          aspect: '16:9',
          routeGroup: { newapi_group: 'default', usable: true },
        },
      },
      78,
    );
    expect(input?.mediaType).toBe('video');
    expect(input?.video?.isGlobalModel).toBe(false); // 78 非全量
    expect(input?.video?.alias).toBe('seedance-2.5');
    expect(input?.video?.routeRules).toBe(cfg.routeRules);
  });

  it('未给 config 且处于 VITEST → 跳过真实读库，返回 undefined（不触网）', async () => {
    const input = await buildAutoDiversionEligibility(
      { taskId: 1, modelId: 78, mediaType: 'video', autoDiversionEligibility: { resolution: '720p' } },
      78,
    );
    expect(input).toBeUndefined();
  });

  it('verify() 传 autoDiversionEligibility(config) → 自动挂载并裁决 PASS', async () => {
    const result = await verify({
      taskId: 501,
      modelId: 78,
      mediaType: 'video',
      duration: 4,
      resolution: '720p',
      dbRawCollection: dbWith({ diversion: 10 }, 10),
      autoDiversionEligibility: {
        config: cfg,
        resolution: '720p',
        aspect: '16:9',
        routeGroup: { newapi_group: 'default', usable: true },
      },
    });
    const env = result.canonicalEnvelopes?.find((e) => e.evidenceKey === 'SERVER_API:DIVERSION_ELIGIBILITY');
    expect(env).toBeDefined();
    expect(env?.observationStatus).toBe('PASS');
    expect(env?.normalizedFields.predictedDecision).toBe('NEWAPI_ORG_GROUP');
  });
});

describe('回归：磁盘自动会话不得把 fixture 调用误升为真实轮询（防 >180s poll 卡死）', () => {
  it('显式 session + dbRawCollection → 仍 real（守卫只丢弃磁盘自动发现的会话，不动显式 session）', async () => {
    const c = await resolveVerifyContext({
      taskId: 1,
      modelId: 78,
      mediaType: 'video',
      duration: 4,
      resolution: '720p',
      session: { env: 'test', base_url: 'https://x.test', cookie_string: 'c' },
      dbRawCollection: dbWith({ diversion: 10 }, 10),
    });
    expect(c.executionMode).toBe('real');
  });

  it('无显式 session + dbRawCollection fixture → offline（不轮询）', async () => {
    const c = await resolveVerifyContext({
      taskId: 1,
      modelId: 78,
      mediaType: 'video',
      duration: 4,
      resolution: '720p',
      dbRawCollection: dbWith({ diversion: 10 }, 10),
    });
    expect(c.executionMode).toBe('offline');
  });
});

describe('pricingAuthority 图片安全：不误导（无匹配即不自动取价）', () => {
  it('图片模型 + pricingAuthority → customPoints/pointsPerSecond 保持未定义（回退显式 customPoints）', async () => {
    const c = await resolveVerifyContext({
      taskId: 1,
      modelId: 12,
      mediaType: 'image',
      pricingAuthority: { model: 'pan-banana-pro', resolution: '2k' },
    });
    expect(c.pointsPerSecond).toBeUndefined();
    expect(c.customPoints).toBeUndefined();
  });
});

describe('absettingPricing 接线（图片刊例价取自运行时真源 pq_absetting）', () => {
  const m12rows = [
    { model_config_id: 12, task_type: 1, resolution: 4, billing_type: 1, list_price_points: 10, cost_price: 0.2 },
    { model_config_id: 12, task_type: 1, resolution: 6, billing_type: 1, list_price_points: 15, cost_price: 0.3 },
  ];
  it('图片：absettingPricing(rows) → customPoints=按分辨率码精确取价', async () => {
    const c = await resolveVerifyContext({
      taskId: 1,
      modelId: 12,
      mediaType: 'image',
      absettingPricing: { resolutionCode: 6, taskType: 1, rows: m12rows },
    });
    expect(c.customPoints).toBe(15);
  });
  it('absettingPricing 优先于 pricingAuthority；VITEST 下无 rows 不触网（回退）', async () => {
    // 无 rows 且处于 VITEST → 不读库；无飞书匹配的图片模型 → 无权威价，customPoints 保持未定义
    const c = await resolveVerifyContext({
      taskId: 1,
      modelId: 12,
      mediaType: 'image',
      absettingPricing: { resolutionCode: 6 },
      pricingAuthority: { model: 'pan-banana-pro', resolution: '2k' },
    });
    expect(c.customPoints).toBeUndefined();
  });
});

describe('absettingPricing 支持分辨率名（自动转码，无需整数码）', () => {
  it('图片：resolution 名 4k → 自动转码6 取价 15', async () => {
    const c = await resolveVerifyContext({
      taskId: 1,
      modelId: 12,
      mediaType: 'image',
      absettingPricing: {
        resolution: '4k',
        taskType: 1,
        rows: [
          { model_config_id: 12, task_type: 1, resolution: 4, billing_type: 1, list_price_points: 10, cost_price: 0.2 },
          { model_config_id: 12, task_type: 1, resolution: 6, billing_type: 1, list_price_points: 15, cost_price: 0.3 },
        ],
      },
    });
    expect(c.customPoints).toBe(15);
  });
});

// ── dbActualDiverted 媒体感知回归：图片分流标记 extra.newapi_image ──────────────
// 落库分流标记按媒体分：视频=extra.diversion=10，图片=extra.newapi_image=1。
// evidence-collectors.ts 的 dbActualDiverted 曾只读 extra.diversion，对图片分流漏采，
// 会把「真实经网关分流的图片」误判为直连(false)，进而误报 ROUTING_PREDICTION_MISMATCH
// 并放松 isGatewayChannelRequired（假 PASS 向量）。以下用例锁死修复，且守卫视频路径不变。
describe('dbActualDiverted 媒体感知（图片 extra.newapi_image 必须计入真实分流判定）', () => {
  // 图片前台源表用 pq_aivideo_goods（视频才用 pq_aivideo_new）；不放 pq_aivideo_new 以命中图片解析分支。
  function imageDbWith(extra: Record<string, unknown>): DatabaseRawCollection {
    return {
      status: 'VERIFIED',
      taskId: '700',
      recordsFound: { pq_aivideo_goods: { id: 700, task_status: 2, extra: JSON.stringify(extra) } },
    } as unknown as DatabaseRawCollection;
  }

  async function routingFactsFor(mediaType: 'video' | 'image', extra: Record<string, unknown>, line?: number) {
    const options = {
      taskId: 700,
      modelId: mediaType === 'image' ? 1201 : 78,
      mediaType,
      terminalStatus: 'SUCCESS' as const,
      dbRawCollection: mediaType === 'image' ? imageDbWith(extra) : dbWith(extra, line),
    };
    const c = await resolveVerifyContext(options);
    // 契约预测分流（willDivert=true）：只有预测分流时 routingPredictionMismatch 才可能触发，
    // 用 spread 重建避免原地改动可能被冻结的嵌套对象。
    const ctx = {
      ...c,
      contract: {
        ...c.contract,
        routing: { ...c.contract.routing, value: { ...c.contract.routing.value, willDivert: true } },
      },
    };
    const res = await collectTaskEvidence(ctx, options as never);
    return res.routingFacts;
  }

  it('回归(核心漏洞): 图片 extra={diversion:0, newapi_image:1} → 判真实分流(true)，不再误报 ROUTING_PREDICTION_MISMATCH', async () => {
    const rf = await routingFactsFor('image', { diversion: 0, newapi_image: 1 });
    expect(rf.actualDivertedFromDb).toBe(true);
    expect(rf.routingPredictionMismatch).toBeUndefined();
  });

  it('图片 extra={newapi_image:1}（仅图片标记，无 diversion/无 line）→ 真实分流 true', async () => {
    const rf = await routingFactsFor('image', { newapi_image: 1 });
    expect(rf.actualDivertedFromDb).toBe(true);
  });

  it('图片直连 extra={newapi_image:0} → 明确直连 false；预测分流时如实标注 mismatch（含 newapi_image=0）', async () => {
    const rf = await routingFactsFor('image', { newapi_image: 0 });
    expect(rf.actualDivertedFromDb).toBe(false);
    expect(rf.routingPredictionMismatch).toBeDefined();
    expect(rf.routingPredictionMismatch).toContain('newapi_image=0');
  });

  it('守卫: 视频路径不受影响 — extra.diversion=10 → true；extra.diversion=0 → false', async () => {
    expect((await routingFactsFor('video', { diversion: 10 }, 10)).actualDivertedFromDb).toBe(true);
    expect((await routingFactsFor('video', { diversion: 0 })).actualDivertedFromDb).toBe(false);
  });
});

// ── #1 图片分流网关证据「采集」端到端（离线，形状取自真实只读取证 character#4519）──────────
// 只读取证真源(2026-09-26)确认：图片分流(newapi_image=1,line=10)在 pq_newapi_task_log 有两类落库——
//   (a) 正渠道履约: channel_id>0（如 Pan-IE#5/gpt-image-2、Pan-GE#26/gemini-3-pro-image，SUCCESS）；
//   (b) image-sync: channel_id=0/provider=image-sync（无正上游渠道）。
// 网关采集器媒体无关：给到 (a) 的网关日志即构造可信只读快照(provenance=API_READONLY_COLLECTOR)并要求+核验
// 网关渠道；(b) 无正渠道则不强制（避免无证据地把图片分流恒判 UNVERIFIED）。以下用真实形状离线锁死两路径。
describe('图片分流网关证据端到端（采集器媒体无关 · 真实 character#4519 形状）', () => {
  // 真实正渠道分流图片任务：pq_aivideo_character(extra.newapi_image=1) + volc.line=10 + pq_newapi_task_log。
  function imageDivertDb(newapiLog: Record<string, unknown> | undefined): DatabaseRawCollection {
    return {
      status: 'VERIFIED',
      taskId: '4519',
      recordsFound: {
        pq_aivideo_character: {
          id: 4519,
          task_status: 2,
          extra: JSON.stringify({
            newapi_image: 1,
            selmodelsId: 57,
            selmodelsName: 'Pan Image 2 低价版',
            newapi_model: 'pan-image-2',
            serviceline: 'k',
            resolution: '1K',
          }),
        },
        pq_volcengine_ai_task: {
          id: 18316,
          source_id: 4519,
          line: 10,
          status: 3,
          extra: JSON.stringify({ newapi_log_id: 999 }),
        },
        ...(newapiLog ? { pq_newapi_task_log: newapiLog } : {}),
      },
    } as unknown as DatabaseRawCollection;
  }
  async function facts(db: DatabaseRawCollection) {
    const options = {
      taskId: 4519,
      modelId: 57,
      mediaType: 'image' as const,
      terminalStatus: 'SUCCESS' as const,
      dbRawCollection: db,
    };
    const c = await resolveVerifyContext(options);
    const cx = {
      ...c,
      contract: {
        ...c.contract,
        routing: { ...c.contract.routing, value: { ...c.contract.routing.value, willDivert: true } },
      },
    };
    return (await collectTaskEvidence(cx, options as never)).routingFacts;
  }

  it('(a) 正渠道 channel_id=5/Pan-IE/gpt-image-2/SUCCESS → 网关渠道要求且核验通过(SOURCE_REAL_GATEWAY)', async () => {
    const rf = await facts(
      imageDivertDb({
        id: 999,
        channel_id: 5,
        provider_code: 'Pan-IE',
        upstream_model_name: 'gpt-image-2',
        status: 'SUCCESS',
        newapi_group: '',
      }),
    );
    expect(rf.actualDivertedFromDb).toBe(true);
    expect(rf.isGatewayChannelRequired).toBe(true); // 图片 + 存在可信快照 → 媒体无关地要求核验
    expect(rf.isGatewayChannelVerified).toBe(true);
    expect(rf.hasRealGatewaySnapshot).toBe(true);
    expect(rf.gatewayChannelEvidence).toBe('SOURCE_REAL_GATEWAY');
    expect(rf.gatewaySnapshotSource).toBe('DB_NEWAPI_TASK_LOG');
    expect(rf.routingPredictionMismatch).toBeUndefined();
  });

  it('(b) image-sync channel_id=0 → 仍判真实分流(true)，但无正渠道快照即不强制网关渠道（诚实边界）', async () => {
    const rf = await facts(
      imageDivertDb({
        id: 999,
        channel_id: 0,
        provider_code: 'image-sync',
        upstream_model_name: '',
        status: 'SUCCESS',
      }),
    );
    expect(rf.actualDivertedFromDb).toBe(true); // newapi_image=1 / line=10 仍判真实分流
    expect(rf.isGatewayChannelRequired).toBe(false); // channel_id=0 → 快照 undefined → 不无证据地强制
    expect(rf.gatewaySnapshotSource).toBeUndefined();
    expect(rf.routingPredictionMismatch).toBeUndefined(); // 未直连，不误报 mismatch
  });

  it('无网关日志(仅 newapi_image=1) → 分流检测 true；图片无快照时不强制网关渠道', async () => {
    const rf = await facts(imageDivertDb(undefined));
    expect(rf.actualDivertedFromDb).toBe(true);
    expect(rf.isGatewayChannelRequired).toBe(false);
  });
});

// ── #2 FP-005 证伪：真实任务 239541 计费口径正确（净扣 120 == 刊例 120），非超扣 ──────────────
// 只读取证真源(2026-09-26)：pq_aivideo_new.model_id=15(seedance-2.0)、720p、4s；pq_score_log 单条
// type=2 score=120、无退款；网关 line=10/channel_id=4/databao/doubao-seedance-2.0/SUCCESS。
// 目录解析器 seedance-2.0@720p=30/s ×4s=120 → netDeducted(120)==expected(120) → 计费 PASS、overCharged=false。
// report-template.md 的「预期45/净扣120/超扣75」为示例占位数字，绝非 239541 真实事实——本用例锁死证伪，防再污染。
describe('FP-005 证伪：真实 239541 计费正确(120==120)，verify() 不得误判超扣', () => {
  const db239541: DatabaseRawCollection = {
    status: 'VERIFIED',
    taskId: '239541',
    recordsFound: {
      pq_aivideo_new: {
        id: 239541,
        task_status: 2,
        status: 1,
        extra: JSON.stringify({
          selmodelsId: '15',
          selmodelsName: 'seedance-2.0',
          video_duration: '4',
          video_resolution: '720p',
          diversion: 10,
          points: 120,
          deduct_points: 120,
          newapi_model: 'seedance-2.0',
          newapi_group: 'default',
        }),
      },
      pq_volcengine_ai_task: {
        id: 18316,
        source_id: 239541,
        line: 10,
        status: 3,
        extra: JSON.stringify({ newapi_log_id: 895 }),
      },
      pq_newapi_task_log: {
        id: 895,
        channel_id: 4,
        provider_code: 'databao',
        upstream_model_name: 'doubao-seedance-2.0',
        status: 'SUCCESS',
        newapi_group: 'default',
      },
      pq_score_log: [
        {
          id: 20310,
          userid: 345,
          task_id: 18316,
          source_id: 239541,
          score: 120,
          type: 2,
          remark: '',
          createtime: '2026-09-24 15:39:11',
        },
      ],
    },
  } as unknown as DatabaseRawCollection;

  it('verify(model 15/720p/4s + 真实 239541 DB) → expected=120, net=120, billing PASS, overCharged=false, 非 FAIL', async () => {
    const result = await verify({
      taskId: 239541,
      modelId: 15,
      mediaType: 'video',
      duration: 4,
      resolution: '720p',
      terminalStatus: 'SUCCESS',
      dbRawCollection: db239541,
    });
    expect(result.evidence.billing.expectedPoints).toBe(120); // 目录 30/s ×4s，绝非示例中的 45
    expect(result.evidence.billing.netDeductedPoints).toBe(120);
    expect(result.evidence.billing.status).toBe('PASS');
    expect(result.billing?.overCharged).toBe(false);
    expect(result.verdict).not.toBe('FAIL'); // 无幻影超扣 → 计费不制造假 FAIL
  });
});
