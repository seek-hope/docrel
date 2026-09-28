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
      // (stmts 80.6, branch 74.5, funcs 79.6, lines 81.3 as of v0.3.1) —
      // ratchet UP as coverage improves; never lower without justification.
      thresholds: {
        statements: 80.6,
        branches: 74.4,
        functions: 79.6,
        lines: 81.2,
      },
    },
  },
});
