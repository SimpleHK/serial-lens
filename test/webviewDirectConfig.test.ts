// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { monitorPageHtml } from '../src/webview/monitorPage';

/**
 * Direct-config round: the serial config bar is visible WITHOUT opening the
 * ＋ menu (the empty state carries a full start bar), rarely-used serial
 * params (data bits / parity / stop bits / line ending) collapse by default
 * behind a per-pane toggle, and the tag chips row lives under EACH pane's
 * control bar instead of one global row.
 */

const posted: unknown[] = [];
const tick = () => new Promise((resolve) => setTimeout(resolve, 20));
const fire = (data: unknown) => {
  window.dispatchEvent(new MessageEvent('message', { data }));
};
const S = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };

beforeAll(async () => {
  document.body.innerHTML = monitorPageHtml({ scriptUri: 'test.js', cspSource: 'test' });
  (globalThis as { acquireVsCodeApi?: unknown }).acquireVsCodeApi = () => ({
    postMessage: (msg: unknown) => posted.push(msg),
  });
  (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame = (cb: (t: number) => void) =>
    setTimeout(() => cb(0), 0) as unknown as number;
  await import('../src/webview/main');
});

const paneByTitle = (name: string) =>
  Array.from(document.querySelectorAll('.pane')).find(
    (p) => p.querySelector('.pane-title')?.textContent?.includes(name),
  ) as HTMLElement;

describe('direct config bar', () => {
  it('shows a start bar with a port picker in the empty state', () => {
    fire({ type: 'ports', ports: [{ path: 'COM150', description: 'USB' }] });
    const row = document.querySelector('#panes .empty-row') as HTMLElement;
    expect(row.querySelector('select.start-port')).toBeTruthy();
    const start = row.querySelector('.start-btn') as HTMLButtonElement;
    expect(start).toBeTruthy();
    posted.length = 0;
    (row.querySelector('select.start-port') as HTMLSelectElement).value = 'COM150';
    start.click();
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'connect', port: 'COM150', baudRate: 115200 }),
    );
  });

  it('empty-state start bar: baud quick-pick and collapsible params feed the connect', () => {
    fire({ type: 'ports', ports: [{ path: 'COM151', description: 'USB' }] });
    const row = document.querySelector('#panes .empty-row') as HTMLElement;
    // baud keeps a visible quick-pick menu, like the pane bar
    const baudToggle = row.querySelector('.baud-toggle') as HTMLButtonElement;
    const menu = row.querySelector('.baud-menu') as HTMLElement;
    expect(baudToggle).toBeTruthy();
    baudToggle.click();
    expect(menu.classList.contains('visible')).toBe(true);
    const preset = Array.from(menu.querySelectorAll('.menu-item')).find(
      (e) => e.textContent === '9600',
    ) as HTMLElement;
    preset.click();
    expect((row.querySelector('.ph-baud') as HTMLInputElement).value).toBe('9600');
    // data bits / parity / stop bits / line ending collapse behind the ☰ toggle
    const paramsToggle = row.querySelector('.params-toggle') as HTMLButtonElement;
    const params = row.querySelector('.pane-params') as HTMLElement;
    expect(paramsToggle).toBeTruthy();
    expect(params.style.display).toBe('none');
    paramsToggle.click();
    expect(params.style.display).toBe('flex');
    // the chosen values flow into the connect message
    posted.length = 0;
    (row.querySelector('select.ph-db') as HTMLSelectElement).value = '7';
    (row.querySelector('select.ph-parity') as HTMLSelectElement).value = 'even';
    (row.querySelector('select.ph-sb') as HTMLSelectElement).value = '2';
    (row.querySelector('select.ph-le') as HTMLSelectElement).value = 'CRLF';
    (row.querySelector('.start-btn') as HTMLButtonElement).click();
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'connect',
        port: 'COM151',
        baudRate: 9600,
        dataBits: 7,
        parity: 'even',
        stopBits: 2,
        lineEnding: 'CRLF',
      }),
    );
  });

  it('collapses data bits / parity / stop bits / line ending behind a toggle', () => {
    fire({
      type: 'sessionCreated',
      sessionId: 80,
      kind: 'port',
      title: 'COM160',
      state: 'connected',
      settings: { ...S },
    });
    const pane = paneByTitle('COM160');
    const params = pane.querySelector('.pane-params') as HTMLElement;
    expect(params).toBeTruthy();
    expect(params.style.display).toBe('none'); // collapsed by default
    // the selects still exist and stay wired inside the collapsed container
    expect(params.querySelector('select.ph-db')).toBeTruthy();
    expect(params.querySelector('select.ph-le')).toBeTruthy();
    const toggle = pane.querySelector('.params-toggle') as HTMLButtonElement;
    toggle.click();
    expect(params.style.display).toBe('flex');
  });

  it('duplicates the tag chips row under every pane bar', async () => {
    fire({ type: 'sessionCreated', sessionId: 81, kind: 'port', title: 'COM161', state: 'connected', settings: { ...S } });
    fire({ type: 'tags', tags: [
      { id: 't1', name: 'ERROR', pattern: '[ERROR]', isRegex: false, color: '#ff0000', highlight: true, filter: true },
    ] });
    await tick();
    const panes = Array.from(document.querySelectorAll('.pane'));
    expect(panes.length).toBeGreaterThan(1);
    for (const pane of panes) {
      const row = pane.querySelector('.pane-tags') as HTMLElement;
      expect(row.style.display).toBe('flex'); // below the control bar
      expect(row.querySelectorAll('.chip').length).toBe(1);
    }
    // toggling H from one pane's copy affects the global tag
    posted.length = 0;
    const seg = paneByTitle('COM161').querySelector('.pane-tags .chip .seg') as HTMLElement;
    seg.click();
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'updateTag', id: 't1', patch: { highlight: false } }),
    );
  });
});
