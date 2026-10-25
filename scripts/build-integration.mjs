import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: [
    'test/integration/index.ts',
    'test/integration/suite.ts',
    'test/integration/runTest.ts',
  ],
  outdir: 'dist/integration',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode', 'serialport', 'mocha', '@vscode/test-electron'],
  sourcemap: true,
  logLevel: 'info',
});
