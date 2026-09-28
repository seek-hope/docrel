import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  {
    ignores: ['dist/', 'node_modules/', 'fixtures/', 'coverage/', '*.tgz'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // The codebase uses `err: any` in catch clauses pervasively; tightening
      // this is tracked as follow-up work rather than a mass-rewrite.
      '@typescript-eslint/no-explicit-any': 'off',
      // Consistent with no-explicit-any being off: the no-unsafe-* family
      // reports hundreds of hits on the same catch-any and JSON.parse
      // patterns without changing the risk picture.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-enum-comparison': 'off',
      // Most async-without-await signatures here are contractual: MCP SDK
      // tool handlers, SymbolExtractor interface methods, health-check
      // callbacks typed as returning Promises, and exported APIs whose
      // Promise shape is part of their contract. The rule cannot see
      // interface conformance, so it produces only false positives here.
      '@typescript-eslint/require-await': 'off',
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
