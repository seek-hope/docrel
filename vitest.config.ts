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
      // (stmts 65.9, branch 57.1, funcs 75.6, lines 68.7 as of v0.3.1) —
      // ratchet UP as coverage improves; never lower without justification.
      thresholds: {
        statements: 65,
        branches: 57,
        functions: 75,
        lines: 68,
      },
    },
  },
});
