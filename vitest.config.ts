// Panqu AI DevTest v6.0.0 Vitest Configuration
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
      include: ['src/devtest/**/*.ts'],
      exclude: ['node_modules/', 'dist/', 'tests/', 'src/devtest/assets/**'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
