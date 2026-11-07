import * as fs from 'node:fs';
import * as path from 'node:path';
import { runTests } from '@vscode/test-electron';
import { SerialPort } from 'serialport';

/**
 * Launches a real VS Code with the extension loaded and runs the suite in
 * dist/integration/suite.js inside the extension host. Prefers the locally
 * installed stable build; set VSCODE_EXECUTABLE to override; falls back to
 * letting @vscode/test-electron download its own copy.
 */

const INSTALLED = 'C:/Users/armstrong/AppData/Local/Programs/Microsoft VS Code/Code.exe';
const PAIR = ['COM10', 'COM11']; // the com0com pair the suite drives

/**
 * Fails FAST when the com0com pair is unavailable. Six opaque
 * "Access denied" failures after a full VS Code launch used to be the only
 * signal; a live monitor session or feeder holding the pair is a
 * precondition, so name it before anything starts.
 */
async function assertPairOpenable(): Promise<void> {
  for (const p of PAIR) {
    const err = await new Promise<Error | null>((resolve) => {
      let sp: SerialPort;
      try {
        sp = new SerialPort({ path: p, baudRate: 9600 }, (e) => {
          resolve(e ?? null);
          sp.close();
        });
      } catch (e) {
        resolve(e as Error);
      }
    });
    if (err) {
      throw new Error(
        `Port preflight: ${p} could not be opened (${err.message}). ` +
          'The integration suite needs the COM10/COM11 com0com pair free — ' +
          'close any live monitor session or run `npm run stop:feeder`, then retry.',
      );
    }
  }
}

/**
 * The installed build can be wedged by a stale vscode-updating mutex after
 * an InnoSetup update ("Code is currently being updated" at launch); the
 * `updating_version` marker file is the tell. A stale marker skips the
 * installed build in favor of the newest archive @vscode/test-electron
 * already downloaded, or no path at all (fresh download).
 */
function findCachedArchive(): string | undefined {
  const cacheDir = path.join(__dirname, '..', '..', '.vscode-test');
  try {
    const archives = fs
      .readdirSync(cacheDir)
      .filter((d) => d.startsWith('vscode-win32'))
      .sort()
      .reverse();
    for (const dir of archives) {
      const exe = path.join(cacheDir, dir, 'Code.exe');
      if (fs.existsSync(exe)) {
        return exe;
      }
    }
  } catch {
    // no cache dir — fall through to the download
  }
  return undefined;
}

function resolveExecutable(): string | undefined {
  const override = process.env.VSCODE_EXECUTABLE;
  if (override) {
    return override;
  }
  if (!fs.existsSync(INSTALLED)) {
    return undefined;
  }
  const marker = path.join(path.dirname(INSTALLED), 'updating_version');
  if (fs.existsSync(marker)) {
    const cached = findCachedArchive();
    console.warn(`[runTest] ${marker} exists — skipping the installed build (stale update marker wedges the launch).`);
    console.warn(cached ? `[runTest] Using cached archive: ${cached}` : '[runTest] No cached archive — @vscode/test-electron will download its own copy.');
    return cached;
  }
  return INSTALLED;
}

async function main(): Promise<void> {
  await assertPairOpenable();
  await runTests({
    extensionDevelopmentPath: path.resolve(__dirname, '..', '..'),
    extensionTestsPath: path.join(__dirname, '..', '..', 'dist', 'integration', 'index.js'),
    vscodeExecutablePath: resolveExecutable(),
    launchArgs: ['--disable-extensions'],
  });
}

main().catch((err) => {
  console.error('integration tests failed:', err);
  process.exit(1);
});
