import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
