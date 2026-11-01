// Webview preview server: serves the REAL page + REAL client bundle in a
// plain browser with a stubbed VS Code API, so the UI can be driven and
// screenshotted without launching the extension host.
//
//   node scripts/webview-preview.mjs [port]     (default 8231)
//
// The page exposes:
//   __host(msg)            — fire a host→webview message (sessionCreated, append, ...)
//   __posted               — every webview→host postMessage, oldest first
// The stub script is injected before the bundle and the CSP is relaxed to
// 'unsafe-inline' scripts for this preview only.
import * as http from 'node:http';
import * as esbuild from 'esbuild';

const port = Number(process.argv[2]) || 8231;

const bundleMain = async () =>
  (
    await esbuild.build({
      entryPoints: ['src/webview/main.ts'],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
      write: false,
      logLevel: 'silent',
    })
  ).outputFiles[0].text;

const pageHtml = async () => {
  const mod = await esbuild.build({
    stdin: {
      contents: `import { monitorPageHtml } from './monitorPage.ts'; globalThis.__monitorPageHtml = monitorPageHtml;`,
      resolveDir: 'src/webview',
      sourcefile: 'page-entry.ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    logLevel: 'silent',
  });
  // eslint-disable-next-line no-new-func
  new Function(mod.outputFiles[0].text)();
  const html = globalThis.__monitorPageHtml({ scriptUri: '/main.js', cspSource: 'self' });
  return html
    .replace('script-src self', "script-src 'self' 'unsafe-inline'")
    .replace(
      '<script src="/main.js"></script>',
      `<style>
/* VS Code Dark Modern fallbacks so the preview reads like the real webview. */
:root {
  --vscode-foreground: #cccccc; --vscode-descriptionForeground: #9d9d9d;
  --vscode-editor-background: #1f1f1f; --vscode-editor-foreground: #cccccc;
  --vscode-editor-font-family: Consolas, 'Courier New', monospace; --vscode-editor-font-size: 13px;
  --vscode-panel-border: #2b2b2b; --vscode-toolbar-hoverBackground: #2a2d2e;
  --vscode-dropdown-background: #2a2a2a; --vscode-dropdown-foreground: #cccccc; --vscode-dropdown-border: #3c3c3c;
  --vscode-input-background: #2a2a2a; --vscode-input-foreground: #cccccc; --vscode-input-border: #3c3c3c;
  --vscode-focusBorder: #0078d4; --vscode-charts-green: #89d185; --vscode-charts-yellow: #ddb100; --vscode-charts-red: #f14c4c;
  --vscode-button-background: #0078d4; --vscode-button-foreground: #ffffff;
  --vscode-button-secondaryBackground: #313131; --vscode-button-secondaryForeground: #cccccc;
  --vscode-editorWidget-background: #202020; --vscode-editorWidget-foreground: #cccccc; --vscode-editorWidget-border: #454545;
  --vscode-list-hoverBackground: #2a2d2e; --vscode-inputOption-activeBackground: #313131;
  --vscode-errorForeground: #f14c4c; color-scheme: dark;
}
</style>
<script>
window.__posted = [];
window.acquireVsCodeApi = () => ({
  postMessage: (m) => { window.__posted.push(m); },
  getState: () => undefined,
  setState: () => undefined,
});
window.__host = (msg) => window.dispatchEvent(new MessageEvent('message', { data: msg }));
</script>
<script src="/main.js"></script>`,
    );
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.url === '/main.js') {
      const body = await bundleMain();
      res.writeHead(200, { 'content-type': 'text/javascript' });
      res.end(body);
      return;
    }
    const body = await pageHtml();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  } catch (err) {
    console.error(err);
    try {
      res.writeHead(500);
      res.end(String(err && err.stack ? err.stack : err));
    } catch {
      /* headers already sent */
    }
  }
});

server.listen(port, () => {
  console.log(`webview preview: http://localhost:${port}/  (Ctrl-C to stop)`);
});
