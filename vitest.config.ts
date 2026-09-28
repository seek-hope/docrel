import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/version.ts'],
      // Baseline thresholds pinned just below the measured level
      // (stmts 54.2, branch 44.9, funcs 62.5, lines 57.1 as of v0.3.1) —
      // ratchet UP as coverage improves; never lower without justification.
      thresholds: {
        statements: 54,
        branches: 44,
        functions: 62,
        lines: 57,
      },
    },
  },
});
