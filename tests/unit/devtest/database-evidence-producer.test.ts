/**
 * DatabaseEvidenceProducer & Database Verify Pipeline Unit Tests
 *
 * 验证数据库只读取证适配器：
 * 1. 凭据路径定位与脱敏；
 * 2. 数据库记录至 ScoreLogEntry[] 映射（含重试调度批次 task_id 隔离）；
 * 3. DatabaseEvidenceProducer 产出的证据信封合法性与规范校验；
 * 4. verify 流水线离线物理取证集成（成功任务扣费与失败任务全额退款场景）；
 * 5. 零网络依赖，100% 离线运行，遵循 docs/ARCHITECTURE_FREEZE.md。
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import {
  DatabaseEvidenceProducer,
  mapDbScoreLogsToScoreLogEntries,
  resolveDatabaseCredentialsPath,
  queryDatabasePhysicalFacts,
  resolveFrontendTaskRecord,
  imageSourceToFrontendTable,
  IMAGE_SOURCE_VALUES,
  sanitizeErrorMessage,
  type DatabaseRawCollection,
  type DbScriptRunner,
} from '../../../src/devtest/database-evidence-producer.js';
import { validateEvidenceEnvelope } from '../../../src/devtest/canonical-protocol.js';
import { verify } from '../../../src/devtest/core-kernel.js';

describe('DatabaseEvidenceProducer (Tier 1/2 Database Physical Evidence)', () => {
  const mockTask239467Raw: DatabaseRawCollection = {
    status: 'VERIFIED',
    taskId: '239467',
    userId: null,
    recordsFound: {
      pq_aivideo_new: {
        id: 239467,
        project_id: 365,
        name: 'RH_devtest_1789903960577',
        model_id: 78,
        extra: JSON.stringify({
          selmodelsName: 'Seedance-2.5',
          selmodelsId: '78',
          points: 84,
          diversion: 10,
          deduct_points: 84,
        }),
        task_status: 2,
        video_url: '/video/20260920/18010_239467_1789904340.mp4',
        progress: 100,
      },
      pq_volcengine_ai_task: {
        id: 18010,
        source_id: 239467,
        task_id: 'vad_1876848469306372',
        status: 3,
      },
      pq_score_log: [
        {
          id: 19912,
          userid: 503,
          task_id: 18010,
          source_id: 239467,
          score: 84.0,
          type: 2,
          remark: '',
          createtime: '2026-09-20 19:32:40',
        },
      ],
    },
  };

  const mockTask238059Raw: DatabaseRawCollection = {
    status: 'VERIFIED',
    taskId: '238059',
    userId: null,
    recordsFound: {
      pq_aivideo_new: {
        id: 238059,
        project_id: 267,
        name: '子凭母贵-第1集-0411',
        model_id: 16,
        extra: JSON.stringify({
          selmodelsName: 'seedance2.0-Fast',
          selmodelsId: '16',
          diversion: 0,
          deduct_points: 48,
        }),
        task_status: 3,
        err: '[{"error":"code=OutputVideoSensitiveContentDetected.PolicyViolation"}]',
        progress: -1,
      },
      pq_volcengine_ai_task: {
        id: 18284,
        source_id: 238059,
        task_id: 'cgt-20260924114216-h6qdp',
        status: 4,
      },
      pq_score_log: [
        {
          id: 20283,
          userid: 370,
          task_id: 18284,
          source_id: 238059,
          score: 48.0,
          type: 1, // 退款
          remark: '',
          createtime: '2026-09-24 11:45:00',
        },
        {
          id: 20282,
          userid: 370,
          task_id: 18284,
          source_id: 238059,
          score: 48.0,
          type: 2, // 预扣
          remark: '',
          createtime: '2026-09-24 11:42:16',
        },
        // 历史早前旧批次 (task_id 10766)
        {
          id: 11525,
          userid: 370,
          task_id: 10766,
          source_id: 238059,
          score: 48.0,
          type: 2,
          remark: '',
          createtime: '2026-07-15 10:29:59',
        },
      ],
    },
  };

  describe('resolveDatabaseCredentialsPath', () => {
    it('显式提供不存在路径时返回 fallback 或 undefined', () => {
      const res = resolveDatabaseCredentialsPath('/non-existent/path/cred.json');
      // 当显式路径不存在时，尝试候选路径或返回 undefined
      if (res) {
        expect(res).toContain('db-credentials.json');
      } else {
        expect(res).toBeUndefined();
      }
    });
  });

  describe('mapDbScoreLogsToScoreLogEntries', () => {
    it('空数组输入返回空数组', () => {
      const res = mapDbScoreLogsToScoreLogEntries([]);
      expect(res).toEqual([]);
    });

    it('单次执行成功流水正确映射为扣费记录', () => {
      const logs = mockTask239467Raw.recordsFound.pq_score_log!;
      const entries = mapDbScoreLogsToScoreLogEntries(logs, 239467, 18010);
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe('19912');
      expect(entries[0].task_id).toBe(239467);
      expect(entries[0].type).toBe(2);
      expect(entries[0].score).toBe(84.0);
    });

    it('重试多批次流水能够依据 backendTaskId (18284) 精确隔离出本轮扣费与退款', () => {
      const logs = mockTask238059Raw.recordsFound.pq_score_log!;
      const entries = mapDbScoreLogsToScoreLogEntries(logs, 238059, 18284);
      expect(entries).toHaveLength(2);
      expect(entries.map((e) => e.id)).toEqual(['20283', '20282']);
      expect(entries[0].type).toBe(1); // 退款
      expect(entries[0].score).toBe(48.0);
      expect(entries[1].type).toBe(2); // 预扣
      expect(entries[1].score).toBe(48.0);
    });
  });

  describe('DatabaseEvidenceProducer 信封规范与校验', () => {
    const producer = new DatabaseEvidenceProducer();

    it('产生合法且符合规范的两个证据信封', async () => {
      const context = {
        testId: 'test-db-envelope-1',
        environment: 'test',
        subjectType: 'task',
        subjectId: 239467,
        taskId: 239467,
        modelId: 78,
        mediaType: 'video' as const,
        capturedAt: '2026-09-24T12:00:00.000Z',
      };

      const envelopes = await producer.produce(mockTask239467Raw, context);
      expect(envelopes).toHaveLength(2);

      const taskEnv = envelopes.find((e) => e.evidenceKey === 'SERVER_API:DB_TASK_RECORD');
      expect(taskEnv).toBeDefined();
      expect(taskEnv!.observationStatus).toBe('PASS');
      expect(taskEnv!.sourceType).toBe('SERVER_API');
      expect(taskEnv!.provenance).toContain('DATABASE_PHYSICAL_RECORD');
      expect(taskEnv!.normalizedFields.taskFound).toBe(true);
      expect(taskEnv!.normalizedFields.backendId).toBe(18010);
      expect(taskEnv!.normalizedFields.diversion).toBe(10);
      expect(taskEnv!.normalizedFields.deductPoints).toBe(84);

      const billingEnv = envelopes.find((e) => e.evidenceKey === 'BILLING_LEDGER:DB_SCORE_LOGS');
      expect(billingEnv).toBeDefined();
      expect(billingEnv!.observationStatus).toBe('PASS');
      expect(billingEnv!.sourceType).toBe('BILLING_LEDGER');
      expect(billingEnv!.normalizedFields.logCount).toBe(1);
      expect(billingEnv!.normalizedFields.totalPreDeduct).toBe(84);

      // 强校验：每一个信封必须 100% 通过 Canonical Evidence Envelope 规范校验
      for (const env of envelopes) {
        const validation = validateEvidenceEnvelope(env);
        expect(validation.valid).toBe(true);
        expect(validation.errors).toHaveLength(0);
      }
    });

    it('当数据库记录缺失时 fail-closed 返回 UNVERIFIED 信封', async () => {
      const emptyRaw: DatabaseRawCollection = {
        status: 'UNVERIFIED',
        taskId: '999999',
        reason: 'NO_RECORD_FOUND',
        error: '数据库未找到任务记录',
        recordsFound: {},
      };

      const context = {
        testId: 'test-db-envelope-missing',
        environment: 'test',
        subjectType: 'task',
        subjectId: 999999,
        taskId: 999999,
        capturedAt: '2026-09-24T12:00:00.000Z',
      };

      const envelopes = await producer.produce(emptyRaw, context);
      expect(envelopes).toHaveLength(2);

      const taskEnv = envelopes.find((e) => e.evidenceKey === 'SERVER_API:DB_TASK_RECORD');
      expect(taskEnv!.observationStatus).toBe('UNVERIFIED');
      expect(taskEnv!.collectionStatus).toBe('COLLECTION_FAILED');

      const billingEnv = envelopes.find((e) => e.evidenceKey === 'BILLING_LEDGER:DB_SCORE_LOGS');
      expect(billingEnv!.observationStatus).toBe('UNVERIFIED');
      expect(billingEnv!.collectionStatus).toBe('MISSING');

      for (const env of envelopes) {
        const validation = validateEvidenceEnvelope(env);
        expect(validation.valid).toBe(true);
      }
    });
  });

  describe('verify 流水线离线物理取证集成', () => {
    it('成功任务 239467: 自动从 dbRawCollection 获取 extra 与流水，通过账务核对', async () => {
      const result = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: 'video',
        duration: 4,
        resolution: '480p',
        pointsPerSecond: 21,
        expectedPoints: 84,
        dbRawCollection: mockTask239467Raw,
      });

      expect(result.dbEvidence).toBeDefined();
      expect(result.dbEvidence?.status).toBe('VERIFIED');
      expect(result.evidence.task.status).toBe('PASS');
      expect(result.evidence.billing.status).toBe('PASS');
      expect(result.billing?.preDeductedPoints).toBe(84);
      expect(result.billing?.netDeductedPoints).toBe(84);
      expect(result.billingAudit).toBe('AUDITED');
      expect(result.evidence.invariants.antiDoubleBilling).toBe(true);

      // 验证 Canonical Evidence Envelopes 中自动注入了 DatabaseEvidenceProducer 的信封
      const dbTaskEnv = result.canonicalEnvelopes?.find((e) => e.evidenceKey === 'SERVER_API:DB_TASK_RECORD');
      expect(dbTaskEnv).toBeDefined();
      expect(dbTaskEnv?.observationStatus).toBe('PASS');

      const dbScoreEnv = result.canonicalEnvelopes?.find((e) => e.evidenceKey === 'BILLING_LEDGER:DB_SCORE_LOGS');
      expect(dbScoreEnv).toBeDefined();
      expect(dbScoreEnv?.observationStatus).toBe('PASS');
    });

    it('异步失败任务 238059: 自动核对失败终态与退款流水，验证净扣归零和退款幂等', async () => {
      const result = await verify({
        taskId: 238059,
        modelId: 16,
        mediaType: 'video',
        duration: 4,
        resolution: '480p',
        pointsPerSecond: 12,
        expectedPoints: 48,
        dbRawCollection: mockTask238059Raw,
      });

      expect(result.dbEvidence).toBeDefined();
      expect(result.evidence.task.status).toBe('FAIL'); // 敏感内容策略拦截
      expect(result.evidence.billing.status).toBe('PASS'); // 账务对账通过（预扣48，退款48）
      expect(result.billing?.preDeductedPoints).toBe(48);
      expect(result.billing?.refundedPoints).toBe(48);
      expect(result.billing?.netDeductedPoints).toBe(0);
      expect(result.evidence.invariants.netChargeZero).toBe(true);
      expect(result.evidence.invariants.refundIdempotency).toBe(true);
      expect(result.evidence.invariants.antiDoubleBilling).toBe(true);
    });

    it('当明确指定 dbVerify: false 时，流水线不执行数据库取证', async () => {
      const result = await verify({
        taskId: 239467,
        modelId: 78,
        mediaType: 'video',
        dbVerify: false,
      });

      expect(result.dbEvidence).toBeUndefined();
    });
  });
});

describe('sanitizeErrorMessage (凭据脱敏 · 纯函数, 零 I/O)', () => {
  it('抹除 password / secret / key 等键值', () => {
    expect(sanitizeErrorMessage('connect failed password=abc123')).not.toContain('abc123');
    expect(sanitizeErrorMessage('secret: topsecret')).not.toContain('topsecret');
  });

  it('抹除 URL 内联账号密码', () => {
    expect(sanitizeErrorMessage('mysql://root:p4ss@db.host/x')).toContain('***:***@');
  });

  it('空输入安全返回空串', () => {
    expect(sanitizeErrorMessage('')).toBe('');
  });
});
describe('queryDatabasePhysicalFacts (注入假执行器 · 100% 离线覆盖 I/O 编排)', () => {
  // 用测试文件自身路径充当"存在的文件"，让凭据/脚本解析确定性通过，
  // 从而完全不依赖真实 db-credentials.json 或数据库即可测到成功/失败编排分支
  const existingPath = fileURLToPath(import.meta.url);

  it('执行器返回成功 JSON → 解析为 VERIFIED 并补全 credPath/queriedAt', async () => {
    const okRunner: DbScriptRunner = async () => ({
      stdout: JSON.stringify({
        status: 'VERIFIED',
        taskId: '239467',
        recordsFound: { pq_aivideo_new: { id: 239467, task_status: 2 } },
      }),
    });
    const res = await queryDatabasePhysicalFacts(
      { taskId: 239467, credPath: existingPath, scriptPath: existingPath },
      okRunner,
    );
    expect(res.status).toBe('VERIFIED');
    expect(res.recordsFound.pq_aivideo_new).toBeDefined();
    expect(res.queriedAt).toBeTruthy();
    expect(res.credPath).toBe(existingPath);
  });

  it('执行器抛错 → fail-closed 为 UNVERIFIED，且错误信息已脱敏(不泄露密码)', async () => {
    const failRunner: DbScriptRunner = async () => {
      throw new Error('tunnel connect failed password=SuperSecret123');
    };
    const res = await queryDatabasePhysicalFacts(
      { taskId: 1, credPath: existingPath, scriptPath: existingPath },
      failRunner,
    );
    expect(res.status).toBe('UNVERIFIED');
    expect(res.reason).toBe('DB_QUERY_FAILED');
    expect(res.error || '').not.toContain('SuperSecret123');
  });

  it('imageSource 指定 → 透传 --image-source 参数给取证脚本', async () => {
    let capturedArgs: string[] = [];
    const captureRunner: DbScriptRunner = async (_file, args) => {
      capturedArgs = args;
      return { stdout: JSON.stringify({ status: 'UNVERIFIED', recordsFound: {} }) };
    };
    await queryDatabasePhysicalFacts(
      { taskId: 5, credPath: existingPath, scriptPath: existingPath, mediaType: 'image', imageSource: 'character' },
      captureRunner,
    );
    const idx = capturedArgs.indexOf('--image-source');
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(capturedArgs[idx + 1]).toBe('character');
  });

  it('未指定 imageSource → 绝不注入 --image-source（默认零改变）', async () => {
    let capturedArgs: string[] = [];
    const captureRunner: DbScriptRunner = async (_file, args) => {
      capturedArgs = args;
      return { stdout: JSON.stringify({ status: 'UNVERIFIED', recordsFound: {} }) };
    };
    await queryDatabasePhysicalFacts(
      { taskId: 5, credPath: existingPath, scriptPath: existingPath, mediaType: 'image' },
      captureRunner,
    );
    expect(capturedArgs).not.toContain('--image-source');
  });
});

describe('resolveFrontendTaskRecord (图片四源表 id 重叠消歧 · 纯函数, 零 I/O)', () => {
  it('imageSourceToFrontendTable / IMAGE_SOURCE_VALUES 契约稳定', () => {
    expect(IMAGE_SOURCE_VALUES).toEqual(['goods', 'character', 'scene', 'fusion']);
    expect(imageSourceToFrontendTable('character')).toBe('pq_aivideo_character');
    expect(imageSourceToFrontendTable('fusion')).toBe('pq_aivideo_fusion');
  });

  it('无 preferredTable：视频源表 pq_aivideo_new 优先命中', () => {
    const rf = { pq_aivideo_new: { id: 1 }, pq_aivideo_goods: { id: 1 } } as DatabaseRawCollection['recordsFound'];
    expect(resolveFrontendTaskRecord(rf)).toEqual({ record: { id: 1 }, table: 'pq_aivideo_new' });
  });

  it('无 preferredTable：仅图片表时按 goods→character→scene→fusion 顺序首命中(既有行为)', () => {
    const rf = {
      pq_aivideo_character: { id: 7 },
      pq_aivideo_scene: { id: 7 },
    } as DatabaseRawCollection['recordsFound'];
    expect(resolveFrontendTaskRecord(rf)).toEqual({ record: { id: 7 }, table: 'pq_aivideo_character' });
  });

  it('指定 preferredTable：id 重叠时精确命中该表, 绝不落到顺序首命中的错误任务', () => {
    // goods 与 character 同 id=7 但属不同任务；operator 指明 character 必须落 character。
    const rf = {
      pq_aivideo_goods: { id: 7, task_status: 2 },
      pq_aivideo_character: { id: 7, task_status: 3 },
    } as DatabaseRawCollection['recordsFound'];
    const out = resolveFrontendTaskRecord(rf, 'pq_aivideo_character');
    expect(out.table).toBe('pq_aivideo_character');
    expect((out.record as Record<string, unknown>).task_status).toBe(3);
  });

  it('指定 preferredTable 但该表无记录 → 返回空(fail-closed), 不静默回退其他表', () => {
    const rf = { pq_aivideo_goods: { id: 7 } } as DatabaseRawCollection['recordsFound'];
    expect(resolveFrontendTaskRecord(rf, 'pq_aivideo_character')).toEqual({});
  });

  it('recordsFound 缺失 → 返回空对象', () => {
    expect(resolveFrontendTaskRecord(undefined)).toEqual({});
    expect(resolveFrontendTaskRecord(undefined, 'pq_aivideo_goods')).toEqual({});
  });
});
