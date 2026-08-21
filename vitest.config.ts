import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 29.2：性能基准套件独立于默认全量回归（tests/perf，经 config/test/vitest.perf.config.ts 单独运行）
    exclude: ['**/node_modules/**', '**/dist/**', 'tests/perf/**'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage/',
      include: [
        'src/core/assertion-engine.ts',
        'src/core/assertion-operators.ts',
        'src/core/path-extractor.ts',
        'src/core/id.ts',
        'src/core/failure-category.ts',
        'src/cases/define.ts',
        'src/utils/concurrency-controller.ts',
        'src/utils/assertion-visualizer.ts',
        'src/agents/**/*.ts',
        'src/llm/**/*.ts',
        // 30.1（Phase 30）：平台层纳入覆盖率统计，与核心/智能层共用同一门禁（行/函数/语句 ≥ 80，分支 ≥ 75）
        'src/platform/**/*.ts',
      ],
      // 30.2（Phase 30）：perf-harness 由独立性能套件（tests/perf + config/test/vitest.perf.config.ts）运行，
      // 默认回归不执行它；排除避免以 0% 虚假稀释平台层覆盖率。
      exclude: ['node_modules/', 'dist/', 'tests/', 'src/platform/ops/perf-harness.ts'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
