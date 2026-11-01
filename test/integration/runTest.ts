import * as fs from 'node:fs';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';

/**
 * Launches a real VS Code with the extension loaded and runs the suite in
 * dist/integration/suite.js inside the extension host. Prefers the locally
 * installed stable build; set VSCODE_EXECUTABLE to override; falls back to
 * letting @vscode/test-electron download its own copy.
 */
async function main(): Promise<void> {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const installed = 'C:/Users/armstrong/AppData/Local/Programs/Microsoft VS Code/Code.exe';
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE ?? (fs.existsSync(installed) ? installed : undefined);

  await runTests({
    extensionDevelopmentPath: repoRoot,
    extensionTestsPath: path.join(repoRoot, 'dist', 'integration', 'index.js'),
    vscodeExecutablePath,
    launchArgs: ['--disable-extensions'],
  });
}

main().catch((err) => {
  console.error('integration tests failed:', err);
  process.exit(1);
});
