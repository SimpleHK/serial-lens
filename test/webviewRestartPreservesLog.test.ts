// @vitest-environment happy-dom
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { bootWebview } from './webviewHarness';

/**
 * Restarting a port (■ then ▶) must KEEP the pane's log. Field report: the
 * buffer was wiped on restart. The walk below drives the exact user path —
 * stop, wait for the idle hop, start again — and pins the log across it.
 * Related semantics that must keep holding: a live baud reconnect keeps the
 * buffer (reconnect message, same session), and so does a restart that
 * changes the port or the serial parameters.
 */

let posted: unknown[];
let tick: () => Promise<void>;
let fire: (data: unknown) => void;

const S = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };

beforeAll(async () => {
  ({ fire, tick, posted } = await bootWebview());
});

afterEach(async () => {
  for (let guard = 0; guard < 12; guard++) {
    const closer = document.querySelector('.pane:not(.empty) .pane-close') as HTMLElement | null;
    if (!closer) break;
    closer.click();
  }
  await tick();
  posted.length = 0;
});

const rows = () => document.querySelectorAll('.pane:not(.empty) .row-line').length;
const paneCount = () => document.querySelectorAll('.pane:not(.empty)').length;
const lastPost = (type: string) =>
  [...posted].reverse().find((m) => (m as { type: string }).type === type) as
    | Record<string, unknown>
    | undefined;

describe('restart keeps the log', () => {
  it('■ then ▶ on the same pane preserves the buffered lines', async () => {
    fire({ type: 'ports', ports: [{ path: 'COM10' }] });
    fire({ type: 'sessionCreated', sessionId: 1, kind: 'port', title: 'COM10', state: 'connected', settings: { ...S } });
    await tick();
    fire({ type: 'append', sessionId: 1, dropCount: 0, lines: ['log line one', 'log line two', 'log line three'] });
    await tick();
    expect(rows()).toBeGreaterThan(0);

    // ■ stop: the host tears the connection down and reports idle.
    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    expect(lastPost('disconnect')).toEqual({ type: 'disconnect', sessionId: 1 });
    fire({ type: 'state', sessionId: 1, state: 'idle' });
    await tick();
    expect(rows()).toBeGreaterThan(0); // the log survives the stop

    // ▶ start again: same pane, same port, same settings.
    (document.querySelector('.pane:not(.empty) .start-stop') as HTMLButtonElement).click();
    const connect = lastPost('connect');
    expect(connect?.port).toBe('COM10');
    // The host opens a NEW session for the restart; the webview must carry
    // the old pane's log across the swap.
    const oldRows = rows();
    fire({ type: 'sessionCreated', sessionId: 2, kind: 'port', title: 'COM10', state: 'connecting', settings: { ...S } });
    fire({ type: 'state', sessionId: 2, state: 'connected' });
    await tick();

    expect(paneCount()).toBe(1); // the swap happened
    expect(rows()).toBe(oldRows); // THE SYMPTOM: the log must survive it
    expect(document.querySelector('.pane:not(.empty) .row-line')?.textContent).toContain('log line one');
  });

  it('a restart that CHANGES the port keeps the log too', async () => {
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM12' }] });
    fire({ type: 'sessionCreated', sessionId: 10, kind: 'port', title: 'COM10', state: 'connected', settings: { ...S } });
    await tick();
    fire({ type: 'append', sessionId: 10, dropCount: 0, lines: ['before port switch'] });
    await tick();
    const oldRows = rows();

    // Pick COM12 on the picker (live pane move → restart flow).
    const sel = document.querySelector('.pane:not(.empty) .ph-port') as HTMLSelectElement;
    sel.value = 'COM12';
    sel.dispatchEvent(new Event('change'));
    expect(lastPost('connect')?.port).toBe('COM12');
    fire({ type: 'sessionCreated', sessionId: 11, kind: 'port', title: 'COM12', state: 'connecting', settings: { ...S } });
    fire({ type: 'state', sessionId: 11, state: 'connected' });
    await tick();

    expect(paneCount()).toBe(1);
    expect(rows()).toBe(oldRows);
  });
});
