// Phase 42.1：Web 前端单元 / 组件测试（Vitest + jsdom + Testing Library）
// 独立于平台回归（根 vitest.config.ts 只收 tests/**），保证 Web 快速反馈。
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    // jsdom 在 opaque origin（about:blank）下不提供 localStorage/sessionStorage，
    // 必须显式指定 url 才能启用 Web Storage（Phase 42.1 修复）。
    environmentOptions: {
      jsdom: { url: 'http://localhost:5173/' },
    },
    include: ['src/**/*.test.{ts,tsx}'],
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      reportsDirectory: '../coverage/web/',
      include: ['src/api.ts', 'src/hooks/**/*.ts', 'src/components/**/*.tsx', 'src/pages/Login.tsx', 'src/pages/RunCreate.tsx', 'src/pages/TestAssets.tsx', 'src/pages/AssetVersions.tsx', 'src/pages/RunDetail.tsx'],
    },
  },
});
