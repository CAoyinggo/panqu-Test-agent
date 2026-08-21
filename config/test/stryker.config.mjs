// Stryker Mutation Testing 配置（Phase 32 / DEBT-07）
// 目标：对平台 Critical 决策逻辑（生产安全 / RBAC / 审批中心 / Run 状态机）建立变异测试
// 与变异分数门禁（mutationScore gate）。
// 运行：
//   npm run mutation:test   —— 全量变异测试 + 门禁（分数 < break 即失败）
//   npx stryker run --dryRunOnly   —— 仅校验测试环境可用（不生成变异）
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  $schema: '../../node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  testRunner: 'vitest',
  vitest: {
    // related 模式：每个变异只运行与该源文件相关的测试，显著缩短变异测试时长
    related: true,
  },
  coverageAnalysis: 'perTest',
  // 变异目标集：平台 Critical 决策/安全逻辑（P0）。生产代码，不含测试文件。
  mutate: [
    'src/platform/security/index.ts',
    'src/platform/rbac/rbac.ts',
    'src/platform/rbac/platform-gate.ts',
    'src/platform/rbac/access-chain.ts',
    'src/platform/approval-center/approval-center.ts',
    'src/platform/approval-center/approval-schema.ts',
    'src/platform/runs/run-schema.ts',
  ],
  // 排除对测试无意义的字符串字面量变异（不产生有效防护信号）
  mutator: {
    excludedMutations: ['StringLiteral'],
  },
  concurrency: 4,
  timeoutMS: 15000,
  timeoutFactor: 2,
  reporters: ['clear-text', 'progress', 'html'],
  htmlReporter: {
    fileName: 'reports/mutation/mutation.html',
  },
  jsonReporter: {
    fileName: 'reports/mutation/mutation.json',
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
  // 变异分数门禁：high=80 / low=70 / break=60（分数 < break 时构建失败）
  thresholds: { high: 80, low: 70, break: 60 },
};
export default config;
