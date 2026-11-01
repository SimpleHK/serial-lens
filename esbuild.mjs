import * as esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  platform: 'node',
  target: 'node18',
  external: ['vscode', 'serialport'],
  sourcemap: true,
  logLevel: 'info',
};

const builds = [
  {
    // Extension host bundle (CommonJS, required by VS Code's loader).
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    format: 'cjs',
  },
  {
    // Webview client bundle (self-executing IIFE, loaded via <script src>).
    entryPoints: ['src/webview/main.ts'],
    outfile: 'dist/media/main.js',
    format: 'iife',
  },
];

if (watch) {
  const contexts = await Promise.all(builds.map((b) => esbuild.context({ ...common, ...b })));
  await Promise.all(contexts.map((c) => c.watch()));
  console.log('watching for changes...');
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
}
