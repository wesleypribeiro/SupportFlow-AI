import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/api/test/**/*.test.ts', 'packages/contracts/src/**/*.test.ts'],
    clearMocks: true,
    restoreMocks: true,
  },
});
