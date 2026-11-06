// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { monitorPageHtml } from '../src/webview/monitorPage';
import { rowHeightFor } from '../src/webview/rowHeight';
import { BAUD_RATE_PRESETS } from '../src/shared/baudPresets';

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

    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
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

    const tagBtn = document.querySelector('.create-tag') as HTMLButtonElement;
    expect(tagBtn.disabled).toBe(false);
    tagBtn.click();
    // the tag lands on THIS pane's chips row and is persisted for its session
    const chips = pane.querySelector('.pane-tags') as HTMLElement;
    expect(chips.textContent).toContain('error line one');
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'saveTags',
        tags: [expect.objectContaining({ pattern: 'error line one', name: 'error line one' })],
      }),
    );
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
    const addBtn = document.querySelector('.add-monitor') as HTMLButtonElement;
    expect(addBtn).toBeTruthy();
    addBtn.click();
    console.log('DBG add disabled:', addBtn.disabled, '| menus:', document.querySelectorAll('.add-menu').length,
      '| first menu display:', (document.querySelector('.add-menu') as HTMLElement)?.style.display,
      '| items:', document.querySelectorAll('.add-menu .menu-item').length);
    // Variant B: ＋ opens a port menu; picking one starts a monitor.
    const item = document.querySelector('.add-menu .menu-item[data-path="COM90"]') as HTMLElement;
    expect(item).toBeTruthy();
    posted.length = 0;
    item.click();
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
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
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
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
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
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
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

describe('per-pane config and doubled controls', () => {
  it('drops Monitor Mode and the global Start button from the page', () => {
    const html = monitorPageHtml({ scriptUri: 'x', cspSource: 'y' });
    expect(html).not.toContain('Monitor Mode');
    expect(html).not.toContain('Start Monitoring');
  });

  it('keeps the port picker usable while connected; params stay editable', async () => {
    fire({
      type: 'sessionCreated',
      sessionId: 40,
      kind: 'port',
      title: 'COM96',
      state: 'connected',
      settings: { baudRate: 9600, dataBits: 7, stopBits: 1, parity: 'even' },
    });
    fire({ type: 'ports', ports: [{ path: 'COM96' }, { path: 'COM97' }] });
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM96'),
    ) as HTMLElement;
    const port = pane.querySelector('select.ph-port') as HTMLSelectElement;
    expect(port).toBeTruthy();
    expect(port.value).toBe('COM96');
    expect(port.disabled).toBe(false); // the picker stays open: picking = live move
    expect(port.options.length).toBe(2); // full list, not just the current port
    const baud = pane.querySelector('input.ph-baud') as HTMLInputElement;
    expect(baud.value).toBe('9600');
    expect(baud.disabled).toBe(false); // params stay editable while connected
  });

  it('auto-reconnects with the new settings when params change while connected', async () => {
    fire({
      type: 'sessionCreated',
      sessionId: 43,
      kind: 'port',
      title: 'COM100',
      state: 'connected',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM100'),
    ) as HTMLElement;
    posted.length = 0;
    const baud = pane.querySelector('input.ph-baud') as HTMLInputElement;
    baud.value = '9600';
    baud.dispatchEvent(new Event('change'));
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'reconnect',
        sessionId: 43,
        settings: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'none' },
      }),
    );
    // a parity edit also reconnects
    posted.length = 0;
    const parity = pane.querySelector('select.ph-parity') as HTMLSelectElement;
    parity.value = 'even';
    parity.dispatchEvent(new Event('change'));
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'reconnect',
        sessionId: 43,
        settings: { baudRate: 9600, dataBits: 8, stopBits: 1, parity: 'even' },
      }),
    );
  });

  it('adds a monitor through the ＋ port menu, cloning the newest pane\u2019s settings', async () => {
    // Clean slate so the clone source is deterministic.
    for (const id of [1, 2, 3, 20, 21, 22, 23, 30, 40, 41, 42, 43]) {
      fire({ type: 'sessionClosed', sessionId: id });
    }
    fire({
      type: 'sessionCreated',
      sessionId: 44,
      kind: 'port',
      title: 'COM101',
      state: 'connected',
      settings: { baudRate: 19200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    fire({ type: 'ports', ports: [{ path: 'COM97' }, { path: 'COM101' }] });
    const paneAdd = Array.from(document.querySelectorAll('.pane:not(.empty) .add-monitor')).at(-1) as HTMLButtonElement;
    paneAdd.click();
    const item = paneAdd.parentElement?.querySelector('.add-menu .menu-item[data-path="COM97"]') as HTMLElement;
    expect(item).toBeTruthy();
    posted.length = 0;
    item.click();
    // A new monitor clones the newest pane's settings so sibling panes start
    // on the same device family.
    expect(posted).toContainEqual(
      expect.objectContaining({ type: 'connect', port: 'COM97', baudRate: 19200, dataBits: 8, stopBits: 1, parity: 'none' }),
    );
  });

  it('collapses the send bar by default and toggles it per pane', async () => {
    fire({
      type: 'sessionCreated',
      sessionId: 41,
      kind: 'port',
      title: 'COM98',
      state: 'connected',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM98'),
    ) as HTMLElement;
    const sendRow = pane.querySelector('.pane-send') as HTMLElement;
    expect(sendRow.style.display).toBe('none');
    const toggle = Array.from(pane.querySelectorAll('.pbtn')).find(
      (b) => b.getAttribute('title') === 'Show the send bar',
    ) as HTMLButtonElement;
    expect(toggle).toBeTruthy();
    toggle.click();
    expect(sendRow.style.display).toBe('flex');
  });

  it('doubles every control across panes instead of moving one segment', async () => {
    const S = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };
    fire({ type: 'sessionCreated', sessionId: 45, kind: 'port', title: 'COM102', state: 'connected', settings: { ...S } });
    fire({ type: 'sessionCreated', sessionId: 46, kind: 'port', title: 'COM103', state: 'connected', settings: { ...S } });
    // EVERY pane carries its OWN global controls (add/refresh/filter/...),
    // whatever other panes are already open.
    const panes = Array.from(document.querySelectorAll('.pane:not(.empty)'));
    expect(panes.length).toBeGreaterThan(1);
    for (const pane of panes) {
      expect(pane.querySelectorAll('.global-seg').length).toBe(1);
      expect(pane.querySelectorAll('.add-monitor').length).toBe(1);
    }
    expect(document.querySelectorAll('.pane .add-monitor').length).toBe(panes.length);
    // the filter control is a funnel glyph, labeled for a11y and tests
    const filter = document.querySelector('.pane .filter-toggle[aria-label="Filter"]') as HTMLElement;
    expect(filter).toBeTruthy();
    expect(filter.querySelector('svg')).toBeTruthy();
    // focusing either pane must NOT re-parent anything
    const before = panes.map((p) => p.querySelector('.global-seg'));
    (panes[0] as HTMLElement).click();
    const after = panes.map((p) => p.querySelector('.global-seg'));
    expect(after[0]).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
  });

  it('renders bigger controls than the previous 22/26px set', () => {
    const html = monitorPageHtml({ scriptUri: 'x', cspSource: 'y' });
    expect(html).toMatch(/\.pbtn\s*\{[^}]*width:\s*28px/);
    expect(html).toMatch(/\.icon-btn\s*\{[^}]*width:\s*32px/);
  });

  it('keeps a full controls row in the empty state', async () => {
    for (const id of [1, 2, 3, 20, 21, 22, 23, 30, 40, 41, 42, 43, 44, 45, 46]) {
      fire({ type: 'sessionClosed', sessionId: id });
    }
    expect(document.querySelectorAll('.pane:not(.empty)').length).toBe(0);
    const row = document.querySelector('#panes .pane.empty') as HTMLElement;
    expect(row).toBeTruthy();
    expect(row.querySelector('.add-monitor')).toBeTruthy();
    expect((row.querySelector('.add-monitor') as HTMLButtonElement).disabled).toBe(true); // ＋ = second monitor
    expect(row.querySelector('.global-seg')).toBeTruthy();
    expect((document.querySelector('#panes .pane.empty .pane-hint') as HTMLElement).textContent).toContain('No monitors open');
  });

  it('replaces a stopped pane only after the restart connects', async () => {
    // Two-phase restart: ▶ on a stopped pane opens a NEW session; the old
    // pane survives until the new one goes live.
    fire({ type: 'sessionCreated', sessionId: 60, kind: 'port', title: 'COM120', state: 'idle' });
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM120'),
    ) as HTMLElement;
    posted.length = 0;
    (pane.querySelector('button[title="Start monitoring COM120"]') as HTMLButtonElement).click();
    expect(posted).toContainEqual(expect.objectContaining({ type: 'connect', port: 'COM120' }));
    expect(document.querySelectorAll('.pane:not(.empty)').length).toBe(1); // old pane still there

    fire({
      type: 'sessionCreated',
      sessionId: 61,
      kind: 'port',
      title: 'COM120',
      state: 'connecting',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    expect(document.querySelectorAll('.pane:not(.empty)').length).toBe(2); // both in the DOM until connected
    // …but the replacement stays HIDDEN and sits in the old pane's slot —
    // no second view flashes while the restart is in flight (and the new
    // pane takes the old pane's exact position, not the strip end).
    const oldRoot = pane;
    const newRoot = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p !== oldRoot,
    ) as HTMLElement;
    expect(newRoot.style.display).toBe('none');
    expect(oldRoot.compareDocumentPosition(newRoot) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
    fire({ type: 'state', sessionId: 61, state: 'connected', path: 'COM120' });
    expect(posted).toContainEqual(expect.objectContaining({ type: 'closeSession', sessionId: 60 }));
    fire({ type: 'sessionClosed', sessionId: 60 });
    const remaining = Array.from(document.querySelectorAll('.pane .pane-title')).map((t) => t.textContent);
    expect(remaining.filter((x) => x?.includes('COM120')).length).toBe(1);
    const shown = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM120'),
    ) as HTMLElement;
    expect(shown.style.display).not.toBe('none'); // revealed in place
  });

  it('a rapid second ▶ on a restarting pane does not stack sessions', async () => {
    fire({ type: 'sessionCreated', sessionId: 62, kind: 'port', title: 'COM121', state: 'idle' });
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM121'),
    ) as HTMLElement;
    const play = pane.querySelector('button[title="Start monitoring COM121"]') as HTMLButtonElement;
    posted.length = 0;
    play.click();
    play.click(); // still idle (the state message has not landed) — must be swallowed
    play.click();
    expect(posted.filter((m) => (m as { type: string }).type === 'connect')).toHaveLength(1);
  });

  it('closing the old pane mid-restart reveals the replacement (no stranded port)', async () => {
    // LEAK guard: hiding the replacement during the hop + closing the old
    // pane used to strand an INVISIBLE pane holding a serial port forever.
    fire({ type: 'sessionCreated', sessionId: 160, kind: 'port', title: 'COM130', state: 'connected', settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' } });
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM130'),
    ) as HTMLElement;
    (pane.querySelector('button[title="Stop monitoring COM130"]') as HTMLButtonElement).click();
    fire({ type: 'state', sessionId: 160, state: 'idle' }); // the host confirms the stop
    (pane.querySelector('button[title="Start monitoring COM130"]') as HTMLButtonElement).click();
    fire({
      type: 'sessionCreated',
      sessionId: 161,
      kind: 'port',
      title: 'COM130',
      state: 'connecting',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    // the user closes the old pane while the restart is still in flight
    (pane.querySelector('.pane-close') as HTMLButtonElement).click();
    const surviving = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM130'),
    ) as HTMLElement;
    expect(surviving).toBeTruthy();
    expect(surviving.style.display).not.toBe('none'); // revealed, never stranded
    // when the replacement connects, the takeover still releases the OLD port
    posted.length = 0;
    fire({ type: 'state', sessionId: 161, state: 'connected', path: 'COM130' });
    expect(posted).toContainEqual(expect.objectContaining({ type: 'closeSession', sessionId: 160 }));
  });

  it('keeps the old pane when a restart fails, immune to later connects', async () => {
    // REGRESSION guard: a failed restart must not strand the replace request,
    // letting an unrelated session close the old pane later.
    fire({ type: 'sessionCreated', sessionId: 62, kind: 'port', title: 'COM122', state: 'idle' });
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM122'),
    ) as HTMLElement;
    posted.length = 0;
    (pane.querySelector('button[title="Start monitoring COM122"]') as HTMLButtonElement).click();
    fire({
      type: 'sessionCreated',
      sessionId: 63,
      kind: 'port',
      title: 'COM122',
      state: 'connecting',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    fire({ type: 'sessionFailed', sessionId: 63, message: 'Could not open COM122' });
    expect(pane.isConnected).toBe(true); // failed open keeps the old pane

    // an unrelated session connecting afterwards must NOT close it
    fire({ type: 'sessionCreated', sessionId: 64, kind: 'port', title: 'COM123', state: 'connecting' });
    fire({ type: 'state', sessionId: 64, state: 'connected', path: 'COM123' });
    expect(posted).not.toContainEqual(expect.objectContaining({ type: 'closeSession', sessionId: 62 }));
    expect(pane.isConnected).toBe(true);
  });

  it('gives baud a visible quick-pick with recents and presets', async () => {
    // REGRESSION: the quick-pick was once swapped for a bare native datalist,
    // leaving a single-option invisible picker with no affordance.
    fire({
      type: 'sessionCreated',
      sessionId: 50,
      kind: 'port',
      title: 'COM110',
      state: 'connected',
      settings: { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' },
    });
    fire({ type: 'recentBauds', values: [9600] });
    const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
      (p) => p.querySelector('.pane-title')?.textContent?.includes('COM110'),
    ) as HTMLElement;
    posted.length = 0;
    (pane.querySelector('.baud-toggle') as HTMLButtonElement).click();
    const items = Array.from(pane.querySelectorAll('.baud-menu .menu-item')) as HTMLElement[];
    const labels = items.map((i) => i.textContent ?? '');
    // recents first, then the full preset list
    expect(labels[0]).toContain('9600');
    for (const preset of BAUD_RATE_PRESETS) {
      expect(labels.some((l) => l.includes(String(preset)))).toBe(true);
    }
    // 9600 is both a recent and a preset: deduped, so one entry per rate
    expect(labels.length).toBe(BAUD_RATE_PRESETS.length);
    // picking an item fills the input and closes the menu
    const target = items.find((i) => (i.textContent ?? '').includes('921600')) as HTMLElement;
    target.click();
    expect((pane.querySelector('input.ph-baud') as HTMLInputElement).value).toBe('921600');
    expect(pane.querySelector('.baud-menu')?.classList.contains('visible')).toBe(false);
  });

  it('renders the funnel as an inline svg, not a masked data uri', () => {
    // REGRESSION: a CSS mask url(data:image/svg+xml) was silently blocked by
    // the webview CSP (default-src 'none'), leaving the filter icon blank.
    const filter = document.querySelector('.filter-toggle[aria-label="Filter"]') as HTMLElement;
    expect(filter.querySelector('svg')).toBeTruthy();
    expect(monitorPageHtml({ scriptUri: 'x', cspSource: 'y' })).not.toMatch(/mask:\s*url/);
  });

  it('iconizes the pane status with transient messages falling back', async () => {
    vi.useFakeTimers();
    try {
      fire({
        type: 'sessionCreated',
        sessionId: 51,
        kind: 'port',
        title: 'COM111',
        state: 'connecting',
      });
      const pane = Array.from(document.querySelectorAll('.pane:not(.empty)')).find(
        (p) => p.querySelector('.pane-title')?.textContent?.includes('COM111'),
      ) as HTMLElement;
      const status = pane.querySelector('.pane-status') as HTMLElement;
      fire({ type: 'state', sessionId: 51, state: 'connected' });
      // the iconized status is gone (the bar's dot carries the state); the
      // accessible name still announces it
      expect(status.querySelector('.status-icon')).toBeNull();
      expect(status.getAttribute('aria-label')).toBe('Connected');
      expect(status.title).toContain('Connected');

      // a transient message surfaces in the CONTENT area (the pane hint),
      // never as text inside the bar
      fire({ type: 'status', message: 'Exported 12 lines to x.log' });
      const hint = pane.querySelector('.pane-hint') as HTMLElement;
      expect(hint.style.display).toBe('flex');
      expect(hint.textContent).toContain('Exported 12 lines to x.log');
      expect(status.textContent).toBe('');
      vi.advanceTimersByTime(4100);
      expect(hint.textContent).not.toContain('Exported 12 lines');
      expect(status.getAttribute('aria-label')).toBe('Connected');
    } finally {
      vi.useRealTimers();
    }
  });
});
