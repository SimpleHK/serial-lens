// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { bootWebview } from './webviewHarness';

/**
 * Direct-config round: the serial config bar is visible WITHOUT opening the
 * ＋ menu (the empty state carries a full start bar), rarely-used serial
 * params (data bits / parity / stop bits / line ending) collapse by default
 * behind a per-pane toggle, and the tag chips row lives under EACH pane's
 * control bar instead of one global row.
 */

let posted: unknown[];
let tick: () => Promise<void>;
let fire: (data: unknown) => void;
const S = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };

beforeAll(async () => {
  ({ fire, tick, posted } = await bootWebview());
});

const paneByTitle = (name: string) =>
  Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
    (p) =>
      !p.classList.contains('empty') && // the stub's title mirrors lastUsedPort — never match it
      p.querySelector('.pane-title')?.textContent?.includes(name),
  ) as HTMLElement;

describe('direct config bar', () => {
  it('shows a start bar with a port picker in the empty state', () => {
    fire({ type: 'ports', ports: [{ path: 'COM150', description: 'USB' }] });
    const row = document.querySelector('#panes .pane.empty') as HTMLElement;
    expect(row?.querySelector('select.ph-port'), row?.outerHTML.slice(0, 500) ?? 'ROW IS NULL').toBeTruthy();
    const start = row.querySelector('.start-stop') as HTMLButtonElement;
    expect(start).toBeTruthy();
    posted.length = 0;
    (row.querySelector('select.ph-port') as HTMLSelectElement).value = 'COM150';
    start.click();
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'connect', port: 'COM150', baudRate: 115200 }),
    );
    (row.querySelector('.pane-close') as HTMLButtonElement).click(); // restore a fresh empty surface
  });

  it('empty-state start bar: baud quick-pick and collapsible params feed the connect', () => {
    fire({ type: 'ports', ports: [{ path: 'COM151', description: 'USB' }] });
    const row = document.querySelector('#panes .pane.empty') as HTMLElement;
    (row.querySelector('select.ph-port') as HTMLSelectElement).value = 'COM151'; // pick this test's port
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
    const startBtn2 = row.querySelector('.start-stop') as HTMLButtonElement;
    startBtn2.click();
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

  it('tag chips are per pane: a push lands only on its session', async () => {
    fire({ type: 'sessionCreated', sessionId: 81, kind: 'port', title: 'COM161', state: 'connected', settings: { ...S } });
    fire({ type: 'sessionCreated', sessionId: 82, kind: 'port', title: 'COM162', state: 'connected', settings: { ...S } });
    fire({ type: 'tags', sessionId: 81, tags: [
      { id: 't1', name: 'ERROR', pattern: '[ERROR]', isRegex: false, color: '#ff0000', highlight: true, filter: true },
    ] });
    await tick();
    // COM161 shows its chip; COM162 shows nothing of it
    const p1 = paneByTitle('COM161');
    expect((p1.querySelector('.pane-tags') as HTMLElement).style.display).toBe('flex');
    expect(p1.querySelectorAll('.chip').length).toBe(1);
    const p2 = paneByTitle('COM162');
    expect((p2.querySelector('.pane-tags') as HTMLElement).style.display).toBe('none');
    expect(p2.querySelectorAll('.chip').length).toBe(0);
    // toggling H in COM161 commits COM161's list only
    posted.length = 0;
    const seg = p1.querySelector('.pane-tags .chip .seg') as HTMLElement;
    seg.click();
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'saveTags',
        sessionId: 81,
        tags: [expect.objectContaining({ id: 't1', highlight: false })],
      }),
    );
  });

  it('a tag from pane 1 does not highlight pane 2', async () => {
    fire({ type: 'tags', sessionId: 81, tags: [
      { id: 't1', name: 'ERROR', pattern: '[ERROR]', isRegex: false, color: '#ff0000', highlight: true, filter: true },
    ] });
    await tick();
    fire({ type: 'append', sessionId: 81, dropCount: 0, lines: ['[ERROR] one'] });
    fire({ type: 'append', sessionId: 82, dropCount: 0, lines: ['[ERROR] two'] });
    await tick();
    const row1 = Array.from(paneByTitle('COM161').querySelectorAll('.row-line')).find((r) =>
      r.textContent?.includes('[ERROR]'),
    ) as HTMLElement;
    const row2 = Array.from(paneByTitle('COM162').querySelectorAll('.row-line')).find((r) =>
      r.textContent?.includes('[ERROR]'),
    ) as HTMLElement;
    expect(row1.getAttribute('style')).toContain('#ff000045');
    expect(row2.getAttribute('style') ?? '').not.toContain('#ff000045');
  });

  it('the filter funnel is per pane', async () => {
    fire({ type: 'append', sessionId: 81, dropCount: 0, lines: ['[ERROR] x', 'plain y'] });
    fire({ type: 'append', sessionId: 82, dropCount: 0, lines: ['[ERROR] z', 'plain w'] });
    await tick();
    const p1 = paneByTitle('COM161');
    (p1.querySelector('.filter-toggle') as HTMLButtonElement).click();
    const include = Array.from(p1.querySelectorAll('.filter-menu .menu-item')).find((i) =>
      i.textContent?.includes('Include'),
    ) as HTMLElement;
    include.click();
    await tick();
    // the pane's own funnel shows the mode is active
    expect((p1.querySelector('.filter-toggle') as HTMLButtonElement).classList.contains('on')).toBe(true);
    expect((paneByTitle('COM162').querySelector('.filter-toggle') as HTMLButtonElement).classList.contains('on')).toBe(false);
    // COM161 collapses to its matching lines only; COM162 keeps everything
    const p1Rows = Array.from(p1.querySelectorAll('.row-line')).map((r) => r.textContent);
    expect(p1Rows.length).toBeGreaterThan(0);
    expect(p1Rows.every((t) => t?.includes('[ERROR]'))).toBe(true);
    const p2 = paneByTitle('COM162');
    const p2Rows = Array.from(p2.querySelectorAll('.row-line')).map((r) => r.textContent);
    expect(p2Rows.some((t) => t === 'plain w')).toBe(true); // unfiltered
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
    const sel = document.querySelector('.pane.empty .ph-port') as HTMLSelectElement;
    sel.value = 'COM12';
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM12' }, { path: 'COM13' }] });
    expect(sel.value).toBe('COM12'); // the refresh used to reset it to the first port
    posted.length = 0;
    (document.querySelector('.start-stop') as HTMLButtonElement).click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'connect', port: 'COM12' }));
  });

  it('unified session bar: one grouped shape for empty and connected states', () => {
    fire({ type: 'ports', ports: [{ path: 'COM151', description: 'USB' }] });
    // EMPTY state. The bar is four whole-block groups: config head (dot +
    // select + baud + params), ＋+refresh, the wide primary button, and the
    // pane actions. Groups wrap as blocks and are never squeezed.
    const row = document.querySelector('#panes .pane.empty') as HTMLElement;
    const add = row.querySelector('.add-monitor') as HTMLButtonElement;
    expect(add.disabled).toBe(true); // ＋ is for the SECOND monitor
    const bar = row.querySelector('.pane-header') as HTMLElement;
    const shape = (scope: HTMLElement) =>
      Array.from(scope.children)
        .map((c) => c.className + (c.children.length ? `[${c.children.length}]` : ''))
        .join(' | ');
    expect(shape(bar)).toBe('bar-group[6] | bar-group[2] | start-stop[1] | pbtn clear-btn[1] | bar-group[6] | global-seg[7]');
    const startEl = row.querySelector('.start-stop') as HTMLButtonElement;
    expect(startEl.querySelector('svg')).toBeTruthy(); // svg glyph, no text
    expect(startEl.textContent).toBe('');
    expect(startEl.getAttribute('aria-label')).toMatch(/^Start monitoring/);
    // wrap contract: without wrap the flex shrink squeezes the port select
    // down to its min-width and the two states render different widths
    const css = document.querySelector('style')?.textContent ?? '';
    expect(css.match(/\.start-bar \{[^}]*\}/)?.[0]).toContain('flex-wrap: wrap');
    // the bar never carries the hint; the content area does
    expect(row.querySelector('.pane-header')?.textContent ?? '').not.toContain('No monitors open');
    const hint = document.querySelector('#panes .pane.empty .pane-hint') as HTMLElement;
    expect(hint.textContent).toContain('No monitors open');
    // the pane-action icons are ALWAYS present: dead in the empty row
    const actions = Array.from(
      row.querySelectorAll('.send-toggle, .clear-btn, .log-btn, .export-btn, .scroll-btn, .find-btn, .pane-close'),
    ) as HTMLButtonElement[];
    expect(actions.length).toBe(7);
    expect(actions.every((b) => b.disabled)).toBe(true);
    const sixActions = actions.filter((b) => !b.matches('.clear-btn'));
    expect(new Set(sixActions.map((b) => b.parentElement))).toHaveLength(1); // one block
    const clearEmpty = actions.find((b) => b.matches('.clear-btn')) as HTMLButtonElement;
    expect(clearEmpty.parentElement).toBe(startEl.parentElement); // clear sits beside start/stop
    // size comes from the CSS contract (happy-dom has no layout engine)
    const cssText = document.querySelector('style')?.textContent ?? '';
    expect(cssText).toMatch(/\.pbtn\.clear-btn\s*\{[^}]*width:\s*48px/);

    // PANE state — the same shape, everything live
    fire({ type: 'sessionCreated', sessionId: 120, kind: 'port', title: 'COM195', state: 'connected', settings: { ...S } });
    fire({ type: 'append', sessionId: 120, dropCount: 0, lines: ['hello'], timestamps: [1] });
    const pane = paneByTitle('COM195');
    const play = pane.querySelector('.start-stop') as HTMLElement;
    expect(play.querySelector('svg')).toBeTruthy(); // svg glyph, no text
    expect(play.textContent).toBe('');
    expect(play.getAttribute('aria-label')).toBe('Stop monitoring COM195');
    const paneActions = Array.from(
      pane.querySelectorAll('.send-toggle, .clear-btn, .log-btn, .export-btn, .scroll-btn, .find-btn, .pane-close'),
    ) as HTMLElement[];
    expect(paneActions.every((b) => (b as HTMLButtonElement).disabled === false)).toBe(true);
    const sixPane = paneActions.filter((b) => !b.matches('.clear-btn'));
    expect(new Set(sixPane.map((b) => b.parentElement))).toHaveLength(1);
    expect(paneActions.find((b) => b.matches('.clear-btn'))).toBeTruthy();
    const paneHeader = pane.querySelector('.pane-header') as HTMLElement;
    expect(shape(paneHeader)).toBe('bar-group[6] | bar-group[2] | start-stop[1] | pbtn clear-btn[1] | bar-group[6] | global-seg[7]');
    // the global seg no longer holds ＋/refresh
    const seg = pane.querySelector('.global-seg') as HTMLElement;
    expect(seg.querySelector('.add-monitor')).toBeNull();
    expect(seg.querySelector('.refresh-btn')).toBeNull();
    (pane.querySelector('.pane-close') as HTMLButtonElement).click(); // restore the empty row
  });

  it('Ctrl+F and F3 are swallowed so the VS Code host never sees them', async () => {
    fire({ type: 'sessionCreated', sessionId: 105, kind: 'port', title: 'COM195', state: 'connected', settings: { ...S } });
    const pane = paneByTitle('COM195');
    // a window-level forwarder, exactly like VS Code's injected script
    const forwarded: KeyboardEvent[] = [];
    const forwarder = (e: KeyboardEvent) => forwarded.push(e);
    window.addEventListener('keydown', forwarder);
    const press = (init: KeyboardEventInit) => {
      document.body.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...init }));
    };
    try {
      // Ctrl+F: ours opens, and the forwarder never receives it
      press({ key: 'f', ctrlKey: true });
      expect((pane.querySelector('.find-bar') as HTMLElement).classList.contains('visible')).toBe(true);
      expect(forwarded.filter((e) => e.ctrlKey && e.key === 'f')).toHaveLength(0);
      // F3 with find open: ours navigates; the host still sees nothing
      (pane.querySelector('.find-bar input') as HTMLInputElement).value = 'ERROR';
      (pane.querySelector('.find-bar input') as HTMLInputElement).dispatchEvent(new Event('input'));
      await tick();
      posted.length = 0;
      press({ key: 'F3' });
      expect(forwarded.filter((e) => e.key === 'F3')).toHaveLength(0);
      // F3 with no pane would also be swallowed, not forwarded
      press({ key: 'F3', shiftKey: true });
      expect(forwarded.filter((e) => e.key === 'F3')).toHaveLength(0);
    } finally {
      window.removeEventListener('keydown', forwarder);
    }
    (pane.querySelector('.pane-close') as HTMLButtonElement).click(); // restore the empty row
  });

  it('empty row: funnel and tag controls are dead until a pane exists', async () => {
    // the previous test closed every pane; the empty row is up
    const row = document.querySelector('.pane.empty') as HTMLElement;
    const funnel = row.querySelector('.filter-toggle') as HTMLButtonElement;
    funnel.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const menu = row.querySelector('.filter-menu') as HTMLElement;
    expect(menu.style.display).not.toBe('block'); // no dead menu opens
    expect(funnel.disabled).toBe(true);
    // a text selection alone must not resurrect the tag button
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(row);
    sel?.removeAllRanges();
    sel?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    const tagBtn = row.querySelector('.create-tag') as HTMLButtonElement;
    expect(tagBtn.disabled).toBe(true);
  });
});
