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

describe('interface guidelines (a11y & polish)', () => {
  it('icon-only buttons carry an aria-label, not just a tooltip', () => {
    fire({ type: 'sessionCreated', sessionId: 90, kind: 'port', title: 'COM190', state: 'connected', settings: { ...S } });
    const pane = paneByTitle('COM190');
    const named = (b: Element) => !!((b as HTMLElement).textContent?.trim() || b.getAttribute('aria-label'));
    // every button resolves to an accessible name one way or another
    for (const b of Array.from(pane.querySelectorAll('button'))) {
      expect(named(b)).toBe(true);
    }
    // the doubled global icons are aria-named, never tooltip-only
    expect(document.querySelectorAll('.icon-btn').length).toBeGreaterThan(3);
    for (const b of Array.from(document.querySelectorAll('.icon-btn'))) {
      expect(b.getAttribute('aria-label') || '').not.toBe('');
    }
    // spot-check the pane's icon-only set explicitly
    for (const sel of ['.pane-close', '.baud-toggle', '.params-toggle', '.pbtn']) {
      const el = pane.querySelector(sel) as HTMLElement;
      expect(el.getAttribute('aria-label') || '').not.toBe('');
    }
  });

  it('uses real buttons for clickable non-text controls', () => {
    const pane = paneByTitle('COM190');
    // the pane close glyph is a button, not a span with a click handler
    expect(pane.querySelector('.pane-close')!.tagName).toBe('BUTTON');
    // menu entries are buttons so keyboard focus + Enter work
    (pane.querySelector('.baud-toggle') as HTMLButtonElement).click();
    const baudItem = pane.querySelector('.baud-menu .menu-item')!;
    expect(baudItem.tagName).toBe('BUTTON');
    document.body.dispatchEvent(new MouseEvent('click', { bubbles: true })); // close menus
    document.querySelector('.filter-toggle')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.filter-menu .menu-item')!.tagName).toBe('BUTTON');
  });

  it('polishes copy and input hints per the guidelines', () => {
    const pane = paneByTitle('COM190');
    fire({ type: 'sessionCreated', sessionId: 91, kind: 'port', title: 'COM191', state: 'connecting', settings: { ...S } });
    expect(paneByTitle('COM191').querySelector('.pane-status')!.getAttribute('aria-label')).toBe('Connecting…');
    // placeholders end with the ellipsis character, not three dots
    const sendInput = pane.querySelector('.pane-send input') as HTMLInputElement;
    expect(sendInput.placeholder.endsWith('…')).toBe(true);
    expect(sendInput.spellcheck).toBe(false);
    expect(sendInput.autocomplete).toBe('off');
    // the baud field is numeric and never autofilled
    const baud = pane.querySelector('.ph-baud') as HTMLInputElement;
    expect(baud.inputMode).toBe('numeric');
    expect(baud.autocomplete).toBe('off');
    const findInput = pane.querySelector('.find-bar input') as HTMLInputElement;
    expect(findInput.autocomplete).toBe('off');
  });

  it('async state regions announce politely; decorative strips hide from AT', () => {
    const pane = paneByTitle('COM190');
    expect(pane.querySelector('.pane-status')!.getAttribute('aria-live')).toBe('polite');
    expect(pane.querySelector('.find-count')!.getAttribute('aria-live')).toBe('polite');
    expect(pane.querySelector('.pane-hint')!.getAttribute('aria-live')).toBe('polite');
    expect(pane.querySelector('.log-marks')!.getAttribute('aria-hidden')).toBe('true');
    expect(pane.querySelector('.find-marks')!.getAttribute('aria-hidden')).toBe('true');
  });
});

describe('port switching & control placement', () => {
  it('stopped pane lists every port, restarts on the selected one', async () => {
    fire({ type: 'ports', ports: [{ path: 'COM10', description: 'USB' }, { path: 'COM12', description: 'pair' }] });
    fire({ type: 'sessionCreated', sessionId: 95, kind: 'port', title: 'COM10', state: 'connected', settings: { ...S } });
    const pane = paneByTitle('COM10');
    const sel = pane.querySelector('.ph-port') as HTMLSelectElement;
    expect(sel.options.length).toBe(2); // built from the known port list, not one option
    fire({ type: 'state', sessionId: 95, state: 'idle' });
    await tick();
    expect(sel.disabled).toBe(false); // stop to change
    posted.length = 0;
    sel.value = 'COM12';
    sel.dispatchEvent(new Event('click')); // keeps the list fresh, like the start bar
    expect(posted).toContainEqual(expect.objectContaining({ type: 'refreshPorts' }));
    const play = Array.from(pane.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label')?.startsWith('Start monitoring'),
    ) as HTMLButtonElement;
    play.click(); // ▶ restarts on the pick
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'connect', port: 'COM12', baudRate: 115200 }),
    );
  });

  it('global controls stay adjacent to the pane controls, not far right', () => {
    const css = document.querySelector('style')?.textContent ?? '';
    const rule = css.match(/\.global-seg \{[^}]*\}/)?.[0] ?? '';
    expect(rule).not.toContain('margin-left: auto');
    // the empty-state override keeps its no-divider form
    const emptyRule = css.match(/\.empty-row \.global-seg \{[^}]*\}/)?.[0] ?? '';
    expect(emptyRule).toContain('border-left: none');
  });

  it('connected pane allows picking another port and moves live', () => {
    fire({ type: 'ports', ports: [{ path: 'COM96', description: 'USB' }, { path: 'COM12', description: 'pair' }] });
    fire({ type: 'sessionCreated', sessionId: 96, kind: 'port', title: 'COM96', state: 'connected', settings: { ...S } });
    const pane = paneByTitle('COM96');
    const sel = pane.querySelector('.ph-port') as HTMLSelectElement;
    expect(sel.disabled).toBe(false); // connected: picking moves the pane
    posted.length = 0;
    sel.value = 'COM12';
    sel.dispatchEvent(new Event('change'));
    expect(posted).toContainEqual(expect.objectContaining({ type: 'connect', port: 'COM12', baudRate: 115200 }));
    // re-picking the pane's own port is a no-op
    posted.length = 0;
    sel.value = 'COM10';
    sel.dispatchEvent(new Event('change'));
    expect(posted).toEqual([]);
  });

  it('connecting pane locks the picker, with a visible disabled state', () => {
    fire({ type: 'sessionCreated', sessionId: 97, kind: 'port', title: 'COM170', state: 'connecting', settings: { ...S } });
    const pane = paneByTitle('COM170');
    const sel = pane.querySelector('.ph-port') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
    const css = document.querySelector('style')?.textContent ?? '';
    expect(css).toMatch(/\.ph-ctl:disabled/); // the lock must be visible
  });

  it('a no-change port refresh must not rebuild the pickers (popup survives)', () => {
    fire({ type: 'ports', ports: [{ path: 'COM96', description: 'USB' }, { path: 'COM12', description: 'pair' }] });
    const pane = paneByTitle('COM96');
    const sel = pane.querySelector('.ph-port') as HTMLSelectElement;
    sel.value = 'COM12';
    const firstOption = sel.options[0];
    // the click-triggered refreshPorts reply lands while the popup is open —
    // rebuilding the options here would slam the popup shut mid-pick
    fire({ type: 'ports', ports: [{ path: 'COM96', description: 'USB' }, { path: 'COM12', description: 'pair' }] });
    expect(sel.options[0]).toBe(firstOption); // same <option> nodes: nothing rebuilt
    expect(sel.value).toBe('COM12');
    // a genuinely different list still lands
    fire({ type: 'ports', ports: [{ path: 'COM96' }, { path: 'COM12' }, { path: 'COM99' }] });
    expect(sel.options.length).toBe(3);
    expect(sel.value).toBe('COM12');
  });

  it('start bar keeps the picked port across a refresh', () => {
    for (const btn of Array.from(document.querySelectorAll('.pane-close'))) {
      (btn as HTMLButtonElement).click(); // back to the empty state
    }
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM12' }, { path: 'COM13' }] });
    const sel = document.querySelector('.start-port') as HTMLSelectElement;
    sel.value = 'COM12';
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM12' }, { path: 'COM13' }] });
    expect(sel.value).toBe('COM12'); // the refresh used to reset it to the first port
    posted.length = 0;
    (document.querySelector('.start-btn') as HTMLButtonElement).click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'connect', port: 'COM12' }));
  });
});
