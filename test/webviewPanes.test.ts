// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { monitorPageHtml } from '../src/webview/monitorPage';

/**
 * Regression tests for the split-view webview wiring. These run the REAL
 * client script (src/webview/main.ts) inside jsdom against the real page
 * markup, because the last refactor silently dropped the tag button handler
 * and the panes fought over shared virtualization spacers — neither class of
 * bug is visible to the pure-seam unit tests or to TypeScript.
 */

const posted: unknown[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

const fire = (data: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { data }));
};

const LINES = Array.from({ length: 50 }, (_, i) => `line-${i}`);

beforeAll(async () => {
  // The client script expects the webview bootstrap: markup, the VS Code API,
  // and a rAF (jsdom has none).
  document.body.innerHTML = monitorPageHtml({ scriptUri: 'test.js', cspSource: 'test' });
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => posted.push(msg),
  });
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  await import('../src/webview/main');
});

describe('split-view panes', () => {
  it('keeps each pane’s virtualization spacers inside its own log', async () => {
    fire({
      type: 'sessionCreated',
      sessionId: 1,
      kind: 'port',
      title: 'COM10',
      state: 'connecting',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    fire({ type: 'append', sessionId: 1, lines: [...LINES], dropCount: 0 });
    fire({
      type: 'sessionCreated',
      sessionId: 2,
      kind: 'port',
      title: 'COM12',
      state: 'connecting',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    fire({ type: 'append', sessionId: 2, lines: [...LINES], dropCount: 0 });
    await tick(); // let the scheduled rAF render both panes

    const logs = Array.from(document.querySelectorAll('.pane-log'));
    expect(logs.length).toBe(2);
    for (const log of logs) {
      // replaceChildren MOVES nodes: panes sharing one spacer pair steal it
      // from each other, collapsing the other pane's scrollable height.
      const spacers = log.querySelectorAll('.log-spacer');
      expect(spacers.length).toBe(2);
    }
    expect(logs[0].textContent).toContain('line-0');
    expect(logs[1].textContent).toContain('line-0');
  });

  it('adds a tag from the selected text via the tag button', async () => {
    fire({
      type: 'sessionCreated',
      sessionId: 3,
      kind: 'port',
      title: 'COM11',
      state: 'connecting',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    fire({ type: 'append', sessionId: 3, lines: ['error line one', 'plain line two'], dropCount: 0 });
    await tick();

    const pane = Array.from(document.querySelectorAll('.pane')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM11'),
    ) as HTMLElement;
    const row = pane.querySelector('.row-line') as HTMLElement;
    expect(row.textContent).toBe('error line one');
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(row);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));

    const tagBtn = document.getElementById('create-tag') as HTMLButtonElement;
    expect(tagBtn.disabled).toBe(false);
    tagBtn.click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'createTag', pattern: 'error line one' }));
  });
});
