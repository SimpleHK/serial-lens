import { describe, expect, it } from 'vitest';

import { RingCounter } from '../src/host/ringCounter';

describe('RingCounter (receive buffer cap: how many oldest lines to drop)', () => {
  it('reports no drops while under the cap', () => {
    const ring = new RingCounter(5);
    expect(ring.push(3)).toBe(0);
    expect(ring.size).toBe(3);
  });

  it('drops the oldest lines once the cap is exceeded', () => {
    const ring = new RingCounter(5);
    ring.push(3);
    expect(ring.push(4)).toBe(2); // 3 + 4 = 7 → oldest 2 dropped
    expect(ring.size).toBe(5);
  });

  it('stays stable at the cap', () => {
    const ring = new RingCounter(5);
    ring.push(5);
    expect(ring.push(1)).toBe(1);
    expect(ring.push(1)).toBe(1);
    expect(ring.size).toBe(5);
  });

  it('shrinking the cap drops down to the new size', () => {
    const ring = new RingCounter(10);
    ring.push(10);
    expect(ring.setCap(4)).toBe(6);
    expect(ring.size).toBe(4);
    expect(ring.push(1)).toBe(1);
    expect(ring.size).toBe(4);
  });

  it('growing the cap drops nothing', () => {
    const ring = new RingCounter(4);
    ring.push(4);
    expect(ring.setCap(9)).toBe(0);
    expect(ring.push(5)).toBe(0);
    expect(ring.size).toBe(9);
  });
});
