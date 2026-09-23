import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/fixtures/isolation/**/*.fixture.ts'],
    environment: 'node',
  },
});
