import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      reportsDirectory: 'coverage/',
      include: [
        'src/core/assertion-engine.ts',
        'src/core/assertion-operators.ts',
        'src/core/path-extractor.ts',
        'src/cases/define.ts',
        'src/utils/concurrency-controller.ts',
        'src/utils/assertion-visualizer.ts',
        'src/agents/**/*.ts',
        'src/llm/**/*.ts',
      ],
      exclude: ['node_modules/', 'dist/', 'tests/'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 75,
        statements: 80,
      },
    },
  },
});
