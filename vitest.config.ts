import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    // Unit tests for the extension-host layer run against this mock instead
    // of the real 'vscode' module (dialogs/config/events are adjustable).
    alias: {
      vscode: fileURLToPath(new URL('./test/vscodeMock.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**'],
      // The webview app (main.ts) is measured through the happy-dom suite;
      // the extension host (extension.ts) is measured by the integration
      // suite in the real VS Code host, which the coverage runner cannot
      // instrument — see the functional coverage matrix in the PR/issue.
      all: true,
    },
  },
});
