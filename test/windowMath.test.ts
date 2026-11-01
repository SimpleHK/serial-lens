import { describe, it, expect } from 'vitest';
import { computeRenderWindow } from '../src/webview/windowMath';

describe('windowMath', () => {
  const H = 20;

  it('renders nothing for an empty buffer', () => {
    expect(computeRenderWindow(0, 400, H, 0, 20)).toEqual({ first: 0, last: 0, topPx: 0, bottomPx: 0 });
  });

  it('clamps to the buffer at the top with overscan', () => {
    const w = computeRenderWindow(0, 400, H, 100, 20);
    expect(w.first).toBe(0);
    expect(w.last).toBe(Math.ceil(400 / H) + 20);
    expect(w.topPx).toBe(0);
  });

  it('keeps the window math exact for integer row heights', () => {
    // The row-height contract: first * H must land the viewport exactly.
    const w = computeRenderWindow(2000, 400, H, 10000, 20);
    expect(w.first).toBe(100 - 20);
    expect(w.topPx).toBe(w.first * H);
    expect(w.last).toBeLessThanOrEqual(10000);
    expect(w.bottomPx).toBe((10000 - w.last) * H);
  });

  it('clamps the window at the bottom of the buffer', () => {
    const w = computeRenderWindow(199800, 400, H, 10000, 20);
    expect(w.last).toBe(10000);
    expect(w.bottomPx).toBe(0);
  });

  it('handles a buffer smaller than the viewport', () => {
    const w = computeRenderWindow(0, 400, H, 5, 20);
    expect(w.first).toBe(0);
    expect(w.last).toBe(5);
    expect(w.topPx).toBe(0);
    expect(w.bottomPx).toBe(0);
  });
});
