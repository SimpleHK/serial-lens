// @vitest-environment happy-dom
import { describe, it, expect, beforeAll } from 'vitest';
import { bootWebview } from './webviewHarness';

/**
 * Regression tests for starting the FIRST session from the empty-state bar.
 * The empty state is a pane-shaped stub session (C1/C2): when its ▶ fires,
 * the host's sessionCreated reply retires the stub — and the stub must stay
 * retired. removeSession's "empty surface returns" hook resurrected the stub
 * DURING that retirement (sessions was momentarily empty), so one start put
 * TWO views on screen: the fresh empty bar beside the new pane. No test
 * covered the stub→pane transition because earlier tests fire sessionCreated
 * while real panes already exist, which masks the resurrection. This file
 * boots a FRESH module (see webviewHarness) and asserts right after ONE
 * lifecycle event — the intermediate state survives here.
 */

let posted: unknown[];
let tick: () => Promise<void>;
let fire: (data: unknown) => void;

const SETTINGS = { baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none' };

beforeAll(async () => {
  ({ fire, tick, posted } = await bootWebview());
});

describe('first session from the empty bar', () => {
  it('opens exactly ONE pane — the empty bar retires instead of resurrecting', async () => {
    // Fresh module: the pane-shaped empty stub is the only view on screen.
    expect(document.querySelectorAll('.pane').length).toBe(1);
    expect(document.querySelectorAll('.pane.empty').length).toBe(1);

    // The host delivers the port list; the stub's ▶ becomes usable.
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM13' }] });
    await tick();

    // The user picks the FIRST port and presses ▶ on the empty bar.
    const portSel = document.querySelector('.pane.empty .ph-port') as HTMLSelectElement;
    portSel.value = 'COM10';
    portSel.dispatchEvent(new Event('change'));
    const play = document.querySelector('.pane.empty .start-stop') as HTMLButtonElement;
    expect(play.disabled).toBe(false);
    play.click();
    expect(posted.some((m) => (m as { type: string }).type === 'connect')).toBe(true);

    // The host replies sessionCreated — the reply that resurrected the stub.
    fire({
      type: 'sessionCreated',
      sessionId: 9001,
      kind: 'port',
      title: 'COM10',
      state: 'connecting',
      settings: { ...SETTINGS },
    });
    await tick();

    // THE SYMPTOM: two views for one start — the fresh empty bar sat beside
    // the new pane. One start, one view, and no empty bar left behind.
    expect(document.querySelectorAll('.pane').length).toBe(1);
    expect(document.querySelectorAll('.pane.empty').length).toBe(0);
  });

  it('survives the full cycle: close the pane, the empty bar returns, start again', async () => {
    // Continuing from the previous pane: close it via its own ✕.
    const close = document.querySelector('.pane .pane-close') as HTMLButtonElement;
    close.click();
    await tick();
    // The empty surface returns after the last pane closes — exactly one.
    expect(document.querySelectorAll('.pane.empty').length).toBe(1);

    // Start again from that returned empty bar.
    fire({ type: 'ports', ports: [{ path: 'COM10' }, { path: 'COM13' }] });
    await tick();
    const portSel = document.querySelector('.pane.empty .ph-port') as HTMLSelectElement;
    portSel.value = 'COM10';
    portSel.dispatchEvent(new Event('change'));
    const play = document.querySelector('.pane.empty .start-stop') as HTMLButtonElement;
    play.click();
    fire({
      type: 'sessionCreated',
      sessionId: 9002,
      kind: 'port',
      title: 'COM10',
      state: 'connecting',
      settings: { ...SETTINGS },
    });
    await tick();

    // Same invariant on the second lap: one view, no resurrected empty bar.
    expect(document.querySelectorAll('.pane').length).toBe(1);
    expect(document.querySelectorAll('.pane.empty').length).toBe(0);
  });
});
