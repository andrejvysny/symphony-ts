import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/*.tsbuildinfo',
      // Preact client has its own tsconfig + vite build (browser/JSX); validated by build + playwright.
      'apps/*/client/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Node demo/util scripts (.mjs) run under Node directly — expose Node globals.
    files: ['scripts/**/*.mjs'],
    languageOptions: { globals: { process: 'readonly' } },
  },
);
