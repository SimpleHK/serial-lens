import { describe, it, expect } from 'vitest';
import { formatLineText } from '../src/shared/lineText';

describe('lineText', () => {
  it('passes raw text through when timestamps are off', () => {
    expect(formatLineText({ text: 'hello', ts: 1700000000000 }, false)).toBe('hello');
  });

  it('prefixes the receive timestamp when on', () => {
    // formatTimestamp renders local receive time, like the console does
    const out = formatLineText({ text: 'hello', ts: new Date(2026, 0, 2, 3, 4, 5, 6).getTime() }, true);
    expect(out).toBe('[03:04:05.006] hello');
  });

  it('stays raw when the entry has no timestamp (export matches display)', () => {
    expect(formatLineText({ text: 'hello' }, true)).toBe('hello');
  });
});
