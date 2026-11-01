import { describe, it, expect } from 'vitest';
import { buildFindRegex, scanOccurrences, stepIndex } from '../src/webview/findCore';

describe('findCore', () => {
  it('builds case-insensitive literal matchers by default', () => {
    const re = buildFindRegex({ query: 'a.c', matchCase: false, wholeWord: false, regex: false });
    expect(re).toBeDefined();
    expect(re!.test('A.C')).toBe(true);
    expect(re!.test('abc')).toBe(false); // '.' escaped: 'a.c' is a literal
  });

  it('escapes regex metacharacters in literal mode', () => {
    const re = buildFindRegex({ query: '[a](b){1}', matchCase: true, wholeWord: false, regex: false });
    expect(re).toBeDefined();
    expect(re!.test('x[a](b){1}y')).toBe(true);
    expect(re!.test('ab')).toBe(false);
  });

  it('honors match case and whole word', () => {
    const ci = buildFindRegex({ query: 'Log', matchCase: false, wholeWord: false, regex: false });
    expect(ci!.test('LOGENTRY')).toBe(true);
    const cs = buildFindRegex({ query: 'Log', matchCase: true, wholeWord: false, regex: false });
    expect(cs!.test('LOGENTRY')).toBe(false);
    const ww = buildFindRegex({ query: 'Log', matchCase: true, wholeWord: true, regex: false });
    expect(ww!.test('Log entry')).toBe(true);
    expect(ww!.test('LogEntry')).toBe(false);
  });

  it('passes regex mode through and reports invalid patterns', () => {
    expect(buildFindRegex({ query: 'e+r+', matchCase: false, wholeWord: false, regex: true })).toBeDefined();
    expect(buildFindRegex({ query: '([unclosed', matchCase: false, wholeWord: false, regex: true })).toBeUndefined();
  });

  it('scans only visible lines and records rendered-text offsets', () => {
    const re = buildFindRegex({ query: 'err', matchCase: false, wholeWord: false, regex: false })!;
    const visibleIndexes = [0, 2, 5];
    const textFor = (i: number) => (i === 0 ? '[x] ERR one' : i === 2 ? 'no match' : 'err err');
    const occ = scanOccurrences(re, visibleIndexes, textFor);
    expect(occ).toEqual([
      { lineIndex: 0, start: 4, end: 7 },
      { lineIndex: 5, start: 0, end: 3 },
      { lineIndex: 5, start: 4, end: 7 },
    ]);
  });

  it('guards against zero-length regex matches', () => {
    const re = buildFindRegex({ query: 'a*', matchCase: false, wholeWord: false, regex: true })!;
    const occ = scanOccurrences(re, [0], () => 'bbb');
    expect(occ).toEqual([]);
  });

  it('wraps navigation indexes in both directions', () => {
    expect(stepIndex(0, 3, 1)).toBe(1);
    expect(stepIndex(2, 3, 1)).toBe(0);
    expect(stepIndex(0, 3, -1)).toBe(2);
  });
});
