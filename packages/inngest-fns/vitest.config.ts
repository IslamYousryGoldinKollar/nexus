import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    // macOS AppleDouble sidecars on the T7 external drive break esbuild.
    exclude: ['**/node_modules/**', '**/dist/**', '**/._*'],
    passWithNoTests: true,
    clearMocks: true,
    restoreMocks: true,
  },
});
