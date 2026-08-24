import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./tests/setup/globalSetup.js'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html', 'lcov'],
      exclude: ['node_modules', 'tests', 'dist', '*.config.*'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
    fileParallelism: false,
    testTimeout: 15000,
    hookTimeout: 30000,
    exclude: ['**/node_modules/**', 'dist', 'playwright-report', 'tests/e2e/**'],
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './server/src'),
      'react': path.resolve(__dirname, './node_modules/react'),
      'react-dom': path.resolve(__dirname, './node_modules/react-dom'),
      'exifr': path.resolve(__dirname, './node_modules/exifr'),
      'exceljs': path.resolve(__dirname, './server/node_modules/exceljs'),
    },
  },
});
