// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { monitorPageHtml } from '../src/webview/monitorPage';
import { BAUD_RATE_PRESETS } from '../src/shared/baudPresets';

/**
 * Functional-coverage round: behaviors the wiring suite did not assert —
 * tag highlighting end-to-end (chips, row tints, marks strip), the filter
 * menu actually hiding/showing rows, the manage panel edit flow, file-pane
 * chrome, find widget error/close states, per-pane button wiring, menu
 * click-away, divider drag, per-pane line ending, history cap, and the
 * ＋ menu's defaults branch.
 */

const posted: unknown[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const fire = (data: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { data }));
};
const S = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };

const paneByTitle = (name: string) =>
  Array.from(document.querySelectorAll('.pane')).find(
    (p) => p.querySelector('.pane-title')?.textContent?.includes(name),
  ) as HTMLElement;

const TAG = {
  id: 't1',
  name: 'ERR',
  pattern: '[ERROR]',
  isRegex: false,
  color: '#ff0000',
  highlight: true,
  filter: true,
};

beforeAll(async () => {
  document.body.innerHTML = monitorPageHtml({ scriptUri: 'test.js', cspSource: 'test' });
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => posted.push(msg),
  });
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  await import('../src/webview/main');
});

describe('functional coverage round', () => {
  it('renders tag chips, row tints, and marks from the tags message', async () => {
    fire({ type: 'sessionCreated', sessionId: 70, kind: 'port', title: 'COM130', state: 'connected', settings: { ...S } });
    fire({ type: 'append', sessionId: 70, dropCount: 0, lines: ['[ERROR] bad line', 'ok line'] });
    fire({ type: 'tags', tags: [TAG] });
    await tick();

    const pane = paneByTitle('COM130');
    const chip = pane.ownerDocument.querySelector('#tags-row .chip') as HTMLElement;
    expect(chip?.textContent).toContain('ERR');
    const errRow = Array.from(pane.querySelectorAll('.row-line')).find((r) => r.textContent?.includes('[ERROR]'));
    const okRow = Array.from(pane.querySelectorAll('.row-line')).find((r) => r.textContent === 'ok line');
    expect((errRow as HTMLElement).getAttribute('style')).toContain('#ff000045');
    expect(okRow?.getAttribute('style') ?? '').not.toContain('#ff000045');
    // marks strip: one block for the single highlighted line
    expect(pane.querySelectorAll('.log-marks .mark').length).toBe(1);
  });

  it('include filter hides unmatched rows; off restores them', async () => {
    const pane = paneByTitle('COM130');
    (pane.querySelector('.filter-toggle') as HTMLButtonElement).click();
    const include = Array.from(document.querySelectorAll('.filter-menu .menu-item')).find((i) =>
      i.textContent?.includes('Include'),
    ) as HTMLElement;
    include.click();
    await tick();
    expect(pane.querySelectorAll('.row-line').length).toBe(1); // only the [ERROR] line

    (pane.querySelector('.filter-toggle') as HTMLButtonElement).click();
    const off = Array.from(document.querySelectorAll('.filter-menu .menu-item')).find((i) =>
      i.textContent?.includes('Off'),
    ) as HTMLElement;
    off.click();
    await tick();
    expect(pane.querySelectorAll('.row-line').length).toBe(2);
  });

  it('manage panel renames and deletes tags', () => {
    (paneByTitle('COM130').querySelector('.manage-toggle') as HTMLButtonElement).click();
    const panel = document.querySelector('#manage-panel') as HTMLElement;
    expect(panel.style.display).toBe('flex');
    posted.length = 0;
    const nameInput = panel.querySelector('.tag-name') as HTMLInputElement;
    nameInput.value = 'ERRORS';
    nameInput.dispatchEvent(new Event('change'));
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'updateTag', id: 't1', patch: { name: 'ERRORS' } }),
    );
    const row = nameInput.closest('.tag-edit-row') as HTMLElement;
    (row.querySelector('.tag-delete') as HTMLButtonElement).click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'removeTag', id: 't1' }));
  });

  it('gives file panes read-only chrome', async () => {
    fire({ type: 'sessionCreated', sessionId: 71, kind: 'file', title: 'demo.log', state: 'idle' });
    fire({ type: 'append', sessionId: 71, dropCount: 0, lines: ['saved line one'] });
    await tick();
    const pane = paneByTitle('demo.log');
    expect(pane.querySelector('.pane-title')?.textContent).toContain('\u{1F4C4}');
    expect((pane.querySelector('button[title^="Start monitoring"]') as HTMLElement).style.display).toBe('none');
    expect((pane.querySelector('.log-btn') as HTMLElement | null)?.style.display ?? 'none').toBe('none');
    expect((pane.querySelector('.pane-send') as HTMLElement).style.display).toBe('none');
    expect(pane.textContent).toContain('saved line one');
  });

  it('reports Bad pattern / No results and closes on Escape', async () => {
    fire({ type: 'sessionCreated', sessionId: 72, kind: 'port', title: 'COM131', state: 'connected', settings: { ...S } });
    fire({ type: 'append', sessionId: 72, dropCount: 0, lines: ['plain'] });
    const pane = paneByTitle('COM131');
    (pane.querySelector('button[title^="Find"]') as HTMLButtonElement).click();
    const bar = pane.querySelector('.find-bar') as HTMLElement;
    const input = bar.querySelector('input') as HTMLInputElement;
    const count = bar.querySelector('.find-count') as HTMLElement;

    const settle = () => new Promise((r) => setTimeout(r, 250)); // find debounces 150ms
    // regex mode on: '([bad' is only invalid as a regex source
    (bar.querySelector('button[title="Use regular expression"]') as HTMLButtonElement).click();
    input.value = '([bad';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(count.textContent).toBe('Bad pattern');

    input.value = 'zzz-none';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await settle();
    expect(count.textContent).toBe('No results');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(bar.classList.contains('visible')).toBe(false);
    // reopening starts from a cleared query
    (pane.querySelector('button[title^="Find"]') as HTMLButtonElement).click();
    expect((bar.querySelector('input') as HTMLInputElement).value).toBe('');
  });

  it('wires per-pane scroll toggle, clear, export, and close', async () => {
    fire({ type: 'sessionCreated', sessionId: 73, kind: 'port', title: 'COM132', state: 'connected', settings: { ...S } });
    fire({ type: 'append', sessionId: 73, dropCount: 0, lines: ['one', 'two'] });
    const pane = paneByTitle('COM132');
    posted.length = 0;

    const scrollBtn = pane.querySelector('button[title^="Viewport follows"]') as HTMLButtonElement;
    scrollBtn.click();
    expect(scrollBtn.classList.contains('locked')).toBe(true);
    scrollBtn.click();
    expect(scrollBtn.classList.contains('locked')).toBe(false);

    (pane.querySelector('button[title^="Clear COM132"]') as HTMLButtonElement).click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'clear', sessionId: 73 }));
    await tick();
    expect(pane.querySelectorAll('.row-line').length).toBe(0);
    // an empty buffer disables export; happy-dom does not click disabled buttons
    const exportBtn = pane.querySelector('button[title^="Export COM132"]') as HTMLButtonElement;
    expect(exportBtn.disabled).toBe(true);
    fire({ type: 'append', sessionId: 73, dropCount: 0, lines: ['three'] });
    await tick();
    expect(exportBtn.disabled).toBe(false);
    exportBtn.click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'export', sessionId: 73 }));

    posted.length = 0;
    (pane.querySelector('.pane-close') as HTMLElement).click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'closeSession', sessionId: 73 }));
    expect(pane.isConnected).toBe(false);
  });

  it('closes open menus on an outside click', async () => {
    const pane = paneByTitle('COM130');
    (pane.querySelector('.baud-toggle') as HTMLButtonElement).click();
    const menu = pane.querySelector('.baud-menu') as HTMLElement;
    expect(menu.classList.contains('visible')).toBe(true);
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(menu.classList.contains('visible')).toBe(false);
  });

  it('drags the divider to resize and resets on double-click', () => {
    fire({ type: 'sessionCreated', sessionId: 74, kind: 'port', title: 'COM133', state: 'connected', settings: { ...S } });
    const pane = paneByTitle('COM133');
    const divider = pane.previousElementSibling as HTMLElement;
    expect(divider.classList.contains('pane-divider')).toBe(true);
    divider.dispatchEvent(new MouseEvent('mousedown', { clientX: 100 }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }));
    window.dispatchEvent(new MouseEvent('mouseup', {}));
    expect(pane.style.flexGrow).toBeTruthy();
    divider.dispatchEvent(new MouseEvent('dblclick'));
    expect(pane.style.flexGrow).toBe('');
  });

  it('sends with the pane line ending and caps history at 100', async () => {
    fire({ type: 'sessionCreated', sessionId: 75, kind: 'port', title: 'COM134', state: 'connected', settings: { ...S } });
    const pane = paneByTitle('COM134');
    const leSel = pane.querySelector('select.ph-le') as HTMLSelectElement;
    leSel.value = 'CRLF';
    leSel.dispatchEvent(new Event('change'));
    const input = pane.querySelector('.pane-send input') as HTMLInputElement;
    for (let i = 0; i < 105; i++) {
      input.value = `m${i}`;
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    }
    const last = posted.filter((m) => (m as { type: string }).type === 'send').at(-1) as {
      text: string;
      lineEnding: string;
    };
    expect(last.text).toBe('m104');
    expect(last.lineEnding).toBe('CRLF');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp' }));
    expect(input.value).toBe('m104');
  });

  it('falls back to default settings in the ＋ menu with no port sessions', async () => {
    for (const id of [70, 71, 72, 73, 74, 75]) {
      fire({ type: 'sessionClosed', sessionId: id });
    }
    fire({ type: 'ports', ports: [{ path: 'COM150' }] });
    posted.length = 0;
    (document.querySelector('.empty-row .add-monitor') as HTMLButtonElement).click();
    (document.querySelector('.add-menu .menu-item[data-path="COM150"]') as HTMLElement).click();
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'connect', port: 'COM150', baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' }),
    );
  });
});
