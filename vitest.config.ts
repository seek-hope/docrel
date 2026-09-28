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
      // (stmts 69.2, branch 61.3, funcs 77.1, lines 72.0 as of v0.3.1) —
      // ratchet UP as coverage improves; never lower without justification.
      thresholds: {
        statements: 69,
        branches: 61,
        functions: 77,
        lines: 71,
      },
    },
  },
});
