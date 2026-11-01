import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LineBatcher } from '../src/host/lineBatcher';

describe('LineBatcher', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('buffers small adds and flushes after the window', () => {
    const delivered: string[][] = [];
    const b = new LineBatcher<string>((lines) => delivered.push(lines), { flushAfterMs: 16 });

    b.add(['a', 'b']);
    expect(delivered).toEqual([]);

    vi.advanceTimersByTime(16);
    expect(delivered).toEqual([['a', 'b']]);
  });

  it('flushes immediately when the buffer reaches maxItems', () => {
    const delivered: string[][] = [];
    const b = new LineBatcher<string>((lines) => delivered.push(lines), { maxItems: 4 });

    b.add(['a', 'b']);
    expect(delivered).toEqual([]);

    b.add(['c', 'd']);
    expect(delivered).toEqual([['a', 'b', 'c', 'd']]);
  });

  it('flushNow delivers immediately', () => {
    const delivered: string[][] = [];
    const b = new LineBatcher<string>((lines) => delivered.push(lines), { flushAfterMs: 1000 });

    b.add(['x']);
    b.flushNow();
    expect(delivered).toEqual([['x']]);

    vi.advanceTimersByTime(2000);
    expect(delivered).toEqual([['x']]); // timer was cancelled, no double delivery
  });

  it('dispose delivers whatever is still buffered', () => {
    const delivered: string[][] = [];
    const b = new LineBatcher<string>((lines) => delivered.push(lines), { flushAfterMs: 1000 });

    b.add(['late']);
    b.dispose();
    expect(delivered).toEqual([['late']]);
  });

  it('ignores empty adds', () => {
    const delivered: string[][] = [];
    const b = new LineBatcher<string>((lines) => delivered.push(lines));

    b.add([]);
    vi.advanceTimersByTime(1000);
    expect(delivered).toEqual([]);
  });
});
