import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'output/'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node ESM 脚本（.mjs）由 js.configs.recommended 校验且启用 no-undef，
    // 但未声明 Node 全局（console/process/URL/Buffer 等）→ 误报 24 处 no-undef。
    // 显式注入 Node 全局，消除 `eslint .` 下的这批伪错误（.ts 由 typescript-eslint 关闭 no-undef，不受影响）。
    files: ['**/*.mjs', '**/*.cjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          disallowTypeAnnotations: false,
        },
      ],
    },
  },
);
