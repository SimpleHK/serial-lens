import { defineConfig } from 'vitest/config';

export default defineConfig({
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
