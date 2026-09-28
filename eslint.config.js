// ESLint 9 flat config for DocRelay.
// Type-aware rules are intentionally not enabled yet — they require
// typescript-eslint's project service and a clean baseline first.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'fixtures/', 'coverage/', '*.tgz'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      // The codebase uses `err: any` in catch clauses pervasively; tightening
      // this is tracked as follow-up work rather than a mass-rewrite.
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Empty catch blocks are a deliberate pattern here (best-effort cleanup).
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Zero-width spaces are used deliberately inside doc comments to write
      // literal `*/` sequences without terminating the comment.
      'no-irregular-whitespace': ['error', { skipComments: true }],
    },
  },
);
