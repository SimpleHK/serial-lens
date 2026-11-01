// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { monitorPageHtml } from '../src/webview/monitorPage';
import { rowHeightFor } from '../src/webview/rowHeight';

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

  it('refuses to start a second monitor on an already-connected port', async () => {
    fire({
      type: 'sessionCreated',
      sessionId: 20,
      kind: 'port',
      title: 'COM90',
      state: 'connected',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    fire({ type: 'ports', ports: [{ path: 'COM90' }] });
    const connectBtn = document.getElementById('connect') as HTMLButtonElement;
    const portSelect = document.getElementById('port') as HTMLSelectElement;
    // happy-dom does not auto-select the first option like a browser does,
    // so pick it explicitly before starting.
    portSelect.value = 'COM90';
    posted.length = 0;
    connectBtn.click();
    expect(posted).not.toContainEqual(expect.objectContaining({ type: 'connect' }));
  });

  it('keeps a per-pane send history navigable with the arrow keys', async () => {
    fire({
      type: 'sessionCreated',
      sessionId: 21,
      kind: 'port',
      title: 'COM91',
      state: 'connected',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    const pane = Array.from(document.querySelectorAll('.pane')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM91'),
    ) as HTMLElement;
    const input = pane.querySelector('.pane-send input') as HTMLInputElement;
    const key = (k: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: k }));

    input.value = 'led on';
    key('Enter');
    input.value = 'led off';
    key('Enter');
    expect(posted).toContainEqual(expect.objectContaining({ type: 'send', text: 'led on' }));
    expect(posted).toContainEqual(expect.objectContaining({ type: 'send', text: 'led off' }));
    expect(input.value).toBe('');

    key('ArrowUp');
    expect(input.value).toBe('led off');
    key('ArrowUp');
    expect(input.value).toBe('led on');
    key('ArrowDown');
    expect(input.value).toBe('led off');
    key('ArrowDown');
    expect(input.value).toBe('');
  });

  it('shows a state hint in an empty pane while connecting, waiting, or stopped', async () => {
    fire({
      type: 'sessionCreated',
      sessionId: 22,
      kind: 'port',
      title: 'COM92',
      state: 'connecting',
    });
    const pane = Array.from(document.querySelectorAll('.pane')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM92'),
    ) as HTMLElement;
    const hint = pane.querySelector('.pane-hint') as HTMLElement;
    expect(hint.textContent).toContain('Connecting');
    expect(hint.style.display).not.toBe('none');

    fire({ type: 'state', sessionId: 22, state: 'connected' });
    expect(hint.textContent).toContain('Waiting for data');

    fire({ type: 'append', sessionId: 22, lines: ['data arrives'], dropCount: 0 });
    await tick();
    expect(hint.style.display).toBe('none');
  });

  it('navigates find matches with F3 / Shift+F3', async () => {
    fire({
      type: 'sessionCreated',
      sessionId: 23,
      kind: 'port',
      title: 'COM93',
      state: 'connected',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    fire({
      type: 'append',
      sessionId: 23,
      lines: Array.from({ length: 30 }, (_, i) => (i % 5 === 3 ? `needle ${i}` : `filler ${i}`)),
      dropCount: 0,
    });
    await tick();
    const pane = Array.from(document.querySelectorAll('.pane')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM93'),
    ) as HTMLElement;
    (pane.querySelector('.pbtn[title^="Find"]') as HTMLButtonElement).click();
    const findInput = pane.querySelector('.find-bar input') as HTMLInputElement;
    findInput.value = 'needle';
    findInput.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250)); // find recompute debounces 150ms
    const count = pane.querySelector('.find-count') as HTMLElement;
    expect(count.textContent).toBe('1 of 6');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3' }));
    expect(count.textContent).toBe('2 of 6');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3', shiftKey: true }));
    expect(count.textContent).toBe('1 of 6');
  });
});

describe('row height contract', () => {
  it('rounds the font-derived row height to whole pixels', () => {
    // 1.5em of the 13px editor font is 19.5px: the virtualization math needs
    // an integer row height or spacers drift against real layout, which made
    // scrollbars jump and find jumps land outside the rendered window.
    expect(rowHeightFor(13)).toBe(20);
    expect(rowHeightFor(14)).toBe(21);
    expect(rowHeightFor(12)).toBe(18);
    expect(rowHeightFor(10)).toBe(16); // clamped floor
  });

  it('page CSS and the renderer agree on the same row-height variable', async () => {
    expect(monitorPageHtml({ scriptUri: 'x', cspSource: 'y' })).toContain('var(--sm-row-h');
    fire({
      type: 'sessionCreated',
      sessionId: 30,
      kind: 'port',
      title: 'COM95',
      state: 'connected',
    });
    const set = document.documentElement.style.getPropertyValue('--sm-row-h');
    expect(set).toMatch(/^1?\d+px$/);
  });
});
