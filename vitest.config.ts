import { defineConfig } from 'vitest/config';

const shared = {
  environment: 'node' as const,
  pool: 'forks' as const,
  execArgv: ['--disable-warning=ExperimentalWarning'],
};

export default defineConfig({
  test: {
    projects: [
      { test: { ...shared, name: 'unit', include: ['packages/*/test/**/*.test.ts', 'apps/server/test/unit/**/*.test.ts'], testTimeout: 30_000 } },
      { test: { ...shared, name: 'templates', include: ['apps/server/test/templates/**/*.test.ts'], testTimeout: 90_000, hookTimeout: 60_000 } },
      { test: { ...shared, name: 'perf', include: ['apps/server/test/perf/**/*.test.ts'], testTimeout: 300_000 } },
    ],
  },
});
