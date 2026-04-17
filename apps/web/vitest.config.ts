import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
  test: {
    environment: 'node',
    include: ['**/*.test.ts', '**/*.test.tsx'],
    // Exclude macOS AppleDouble sidecar files on the T7 external drive
    // and the usual noise. The build outputs are never tests.
    exclude: ['**/node_modules/**', '**/.next/**', '**/dist/**', '**/._*'],
    clearMocks: true,
    restoreMocks: true,
    coverage: {
      reporter: ['text', 'json-summary', 'html'],
      exclude: ['**/*.test.*', '**/types.ts', '.next/**'],
    },
  },
});
