// Test Design Benchmark（Phase 45 / 42.4）：测试设计评测基准 v1
// 输入：AI 生成的测试用例集；groundTruth 为独立人工核验的
//   requiredCoverageTags（功能/边界/异常覆盖必须命中）
//   criticalCaseIds（必须存在的关键用例）
//   expectedDuplicateCount（期望的重复用例对数，检验重复率）
//   expectedExecutable（是否全部可执行）
// 评测器产出 Coverage Score / Redundancy Score / Executability Score，
// 并识别 Duplicate Test / Low-value Test / Missing Critical Test。
import type { EvaluationCase } from '../../contract.js';
import type { TestCase } from '../../../agents/test-design/testcase-schema.js';

export interface TestDesignInput {
  testCases: TestCase[];
}

export interface TestDesignGroundTruth {
  requiredCoverageTags: string[];
  criticalCaseIds: string[];
  expectedDuplicateCount: number;
  expectedExecutable: boolean;
}

export type TestDesignCase = EvaluationCase<TestDesignInput, TestDesignGroundTruth>;

function tc(
  id: string,
  name: string,
  priority: string,
  tags: string[],
  opts: { steps?: number; assertions?: number } = {},
): TestCase {
  const steps = opts.steps ?? 1;
  const assertions = opts.assertions ?? 1;
  return {
    id,
    feature: 'wan3',
    name,
    priority: priority as TestCase['priority'],
    tags,
    steps: Array.from({ length: steps }, (_, i) => ({ action: `步骤${i + 1}`, input: { key: id, i } })),
    assertions: Array.from({ length: assertions }, (_, i) => ({ name: `断言${i + 1}`, target: `field${i}`, operator: 'exists' })),
  };
}

function TD(
  id: string,
  testCases: TestCase[],
  requiredCoverageTags: string[],
  criticalCaseIds: string[],
  expectedDuplicateCount: number,
  expectedExecutable: boolean,
  difficulty = 'normal',
): TestDesignCase {
  return {
    id: `td-${id}`,
    domain: 'TEST_DESIGN',
    input: { testCases },
    groundTruth: {
      requiredCoverageTags,
      criticalCaseIds,
      expectedDuplicateCount,
      expectedExecutable,
    },
    metadata: { feature: 'wan3', difficulty, source: 'CURATED' },
  };
}

export const TEST_DESIGN_CASES: TestDesignCase[] = [
  // 1. 完整覆盖：功能/边界/异常均命中，全部可执行
  TD('001', [
    tc('t1', '正常生成', 'P0', ['functional']),
    tc('t2', '超长 prompt', 'P1', ['boundary']),
    tc('t3', '模型 503', 'P1', ['abnormal']),
  ], ['functional', 'boundary', 'abnormal'], ['t1', 't2', 't3'], 0, true),
  // 2. 缺边界覆盖
  TD('002', [
    tc('t1', '正常生成', 'P0', ['functional']),
    tc('t2', '模型 503', 'P1', ['abnormal']),
  ], ['functional', 'boundary', 'abnormal'], ['t1'], 0, true, 'missing-boundary'),
  // 3. 缺异常覆盖
  TD('003', [
    tc('t1', '正常生成', 'P0', ['functional']),
    tc('t2', '超长 prompt', 'P1', ['boundary']),
  ], ['functional', 'boundary', 'abnormal'], ['t1', 't2'], 0, true, 'missing-abnormal'),
  // 4. 重复用例：t2 与 t3 完全一致
  TD('004', [
    tc('t1', '正常生成', 'P0', ['functional']),
    tc('t2', '重复生成', 'P2', ['boundary']),
    tc('t3', '重复生成', 'P2', ['boundary']),
  ], ['functional', 'boundary'], ['t1'], 1, true, 'duplicate'),
  // 5. 不可执行：无断言
  TD('005', [
    tc('t1', '正常生成', 'P0', ['functional'], { assertions: 0 }),
  ], ['functional'], ['t1'], 0, false, 'non-executable'),
  // 6. 空集
  TD('006', [], ['functional'], [], 0, true, 'empty'),
  // 7. 完整 + 无重复 + 可执行
  TD('007', [
    tc('t1', '文生视频', 'P0', ['functional']),
    tc('t2', '720P 边界', 'P1', ['boundary']),
    tc('t3', '超时异常', 'P1', ['abnormal']),
  ], ['functional', 'boundary', 'abnormal'], ['t1'], 0, true),
  // 8. 关键用例缺失（critical t1 缺失）
  TD('008', [
    tc('t2', '720P 边界', 'P1', ['boundary']),
    tc('t3', '超时异常', 'P1', ['abnormal']),
  ], ['boundary', 'abnormal'], ['t1'], 0, true, 'missing-critical'),
  // 9. 多重复
  TD('009', [
    tc('t1', '正常生成', 'P0', ['functional']),
    tc('a', '重复 A', 'P2', ['boundary']),
    tc('b', '重复 A', 'P2', ['boundary']),
    tc('c', '重复 A', 'P2', ['boundary']),
  ], ['functional', 'boundary'], ['t1'], 3, true, 'multi-duplicate'),
  // 10. 混合：功能+边界覆盖，含一个重复，全部可执行
  TD('010', [
    tc('t1', '正常生成', 'P0', ['functional']),
    tc('t2', '边界 0 秒', 'P1', ['boundary']),
    tc('t3', '边界 0 秒', 'P1', ['boundary']),
    tc('t4', '异常 401', 'P1', ['abnormal']),
  ], ['functional', 'boundary', 'abnormal'], ['t1', 't4'], 1, true),
  // 11. 全 P3 低价值但覆盖需求
  TD('011', [
    tc('t1', '低价值 1', 'P3', ['functional']),
    tc('t2', '低价值 2', 'P3', ['boundary']),
  ], ['functional', 'boundary'], [], 0, true, 'low-value'),
  // 12. 部分重复 + 缺异常
  TD('012', [
    tc('t1', '正常生成', 'P0', ['functional']),
    tc('t2', '重复边界', 'P2', ['boundary']),
    tc('t3', '重复边界', 'P2', ['boundary']),
  ], ['functional', 'boundary', 'abnormal'], ['t1'], 1, true, 'mixed'),
  // 13. 完整覆盖带安全标签
  TD('013', [
    tc('t1', '越权防护', 'P0', ['functional', 'security']),
    tc('t2', 'SQL 注入', 'P1', ['boundary', 'security']),
  ], ['functional', 'boundary', 'security'], ['t1'], 0, true),
  // 14. 覆盖达标但含 1 重复
  TD('014', [
    tc('t1', '文生视频', 'P0', ['functional']),
    tc('t2', '1080P', 'P1', ['boundary']),
    tc('t3', '503 异常', 'P1', ['abnormal']),
    tc('t4', '文生视频', 'P0', ['functional']),
  ], ['functional', 'boundary', 'abnormal'], ['t1'], 1, true, 'duplicate'),
  // 15. 全部不可执行
  TD('015', [
    tc('t1', '正常生成', 'P0', ['functional'], { assertions: 0 }),
    tc('t2', '边界', 'P1', ['boundary'], { assertions: 0 }),
  ], ['functional', 'boundary'], [], 0, false, 'non-executable'),
  // 16. 覆盖 + 可执行 + 无重复
  TD('016', [
    tc('t1', '图生视频', 'P0', ['functional']),
    tc('t2', '4K 边界', 'P1', ['boundary']),
    tc('t3', '超时异常', 'P1', ['abnormal']),
    tc('t4', '并发', 'P1', ['functional', 'concurrency']),
  ], ['functional', 'boundary', 'abnormal'], ['t1', 't4'], 0, true),
  // 17. 缺功能标签
  TD('017', [
    tc('t2', '720P 边界', 'P1', ['boundary']),
  ], ['functional', 'boundary'], [], 0, true, 'missing-functional'),
  // 18. 仅一个关键用例 + 一个重复非关键
  TD('018', [
    tc('t1', '核心冒烟', 'P0', ['functional']),
    tc('a', '边缘重复', 'P3', ['boundary']),
    tc('b', '边缘重复', 'P3', ['boundary']),
  ], ['functional', 'boundary'], ['t1'], 1, true),
  // 19. 大覆盖 + 无重复
  TD('019', [
    tc('t1', '登录', 'P0', ['functional']),
    tc('t2', '鉴权分级', 'P1', ['functional', 'security']),
    tc('t3', '空密码', 'P1', ['boundary']),
    tc('t4', '限流', 'P1', ['abnormal']),
  ], ['functional', 'boundary', 'abnormal', 'security'], ['t1', 't2'], 0, true),
  // 20. 需求覆盖但关键缺失
  TD('020', [
    tc('t2', '4K 边界', 'P1', ['boundary']),
    tc('t3', '503', 'P1', ['abnormal']),
  ], ['functional', 'boundary', 'abnormal'], ['t1'], 0, true, 'missing-critical'),
  // 21. 双重复对
  TD('021', [
    tc('t1', '正常', 'P0', ['functional']),
    tc('a', '重复对1', 'P2', ['boundary']),
    tc('b', '重复对1', 'P2', ['boundary']),
    tc('c', '重复对2', 'P2', ['abnormal']),
    tc('d', '重复对2', 'P2', ['abnormal']),
  ], ['functional', 'boundary', 'abnormal'], ['t1'], 2, true, 'multi-duplicate'),
  // 22. 完整且优秀
  TD('022', [
    tc('t1', '文生视频正常', 'P0', ['functional']),
    tc('t2', '提示词长度边界', 'P1', ['boundary']),
    tc('t3', '模型服务异常', 'P1', ['abnormal']),
    tc('t4', '并发峰值', 'P0', ['functional', 'concurrency']),
  ], ['functional', 'boundary', 'abnormal', 'concurrency'], ['t1', 't4'], 0, true),
];
