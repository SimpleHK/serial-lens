import { monitorPageHtml } from '../src/webview/monitorPage';

export interface WebviewHarness {
  fire(data: unknown): void;
  tick(): Promise<void>;
  /** Messages the webview posted to the host, in order. */
  posted: unknown[];
}

/**
 * Boots the REAL client script (src/webview/main.ts) against the real page
 * markup — the shared bootstrap for every webview suite. One harness per
 * test FILE: vitest gives each file its own module registry, so a file that
 * boots alone starts from the pane-shaped empty stub, the state the user
 * actually starts from (coding-standards law: single-event transition
 * tests). happy-dom has no rAF and no VS Code API; both are shimmed here.
 * The page's test.js script URI never loads (happy-dom blocks script
 * loading) — the DOMException it prints on stderr is expected noise.
 */
export async function bootWebview(): Promise<WebviewHarness> {
  const posted: unknown[] = [];
  document.body.innerHTML = monitorPageHtml({ scriptUri: 'test.js', cspSource: 'test' });
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => posted.push(msg),
  });
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  await import('../src/webview/main');
  return {
    fire: (data) => window.dispatchEvent(new MessageEvent('message', { data })),
    tick: () => new Promise((resolve) => setTimeout(resolve, 20)),
    posted,
  };
}
