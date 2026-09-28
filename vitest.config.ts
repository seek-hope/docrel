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
      // (stmts 75.3, branch 68.0, funcs 79.2, lines 77.6 as of v0.3.1) —
      // ratchet UP as coverage improves; never lower without justification.
      thresholds: {
        statements: 75,
        branches: 67.5,
        functions: 79,
        lines: 77.2,
      },
    },
  },
});
