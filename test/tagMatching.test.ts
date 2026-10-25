import { describe, expect, it } from 'vitest';

import { matchLine, matchLines } from '../src/shared/tagMatching';
import { Tag } from '../src/shared/tag';

const tag = (over: Partial<Tag>): Tag => ({
  id: 't1',
  name: 't',
  pattern: 'x',
  isRegex: false,
  color: '#ff0000',
  enabled: true,
  ...over,
});

describe('tagMatching (matching seam: lines + tags + filter mode → decisions)', () => {
  it('highlights lines matching an enabled substring tag', () => {
    const d = matchLine('sensor read [ERROR] boom', [tag({ pattern: 'ERROR' })], 'off');
    expect(d).toEqual({ visible: true, highlightColors: ['#ff0000'] });
  });

  it('does not highlight non-matching lines', () => {
    const d = matchLine('all good here', [tag({ pattern: 'ERROR' })], 'off');
    expect(d).toEqual({ visible: true, highlightColors: [] });
  });

  it('supports regex mode', () => {
    const d = matchLine('temp=24.7C', [tag({ pattern: /temp=\d+(\.\d+)?C/.source, isRegex: true })], 'off');
    expect(d.highlightColors).toEqual(['#ff0000']);
  });

  it('ignores disabled tags entirely', () => {
    const d = matchLine('has ERROR inside', [tag({ pattern: 'ERROR', enabled: false })], 'off');
    expect(d).toEqual({ visible: true, highlightColors: [] });
  });

  it('collects every enabled matching tag in tag order (no masking)', () => {
    const tags = [
      tag({ id: '1', pattern: 'ERROR', color: '#00ff00' }),
      tag({ id: '2', pattern: 'ERR', color: '#0000ff' }),
      tag({ id: '3', pattern: 'RO', color: '#ff00ff', enabled: false }),
    ];
    const d = matchLine('ERROR', tags, 'off');
    expect(d.highlightColors).toEqual(['#00ff00', '#0000ff']);
  });

  it('treats an invalid regex as non-matching instead of throwing', () => {
    const d = matchLine('anything', [tag({ pattern: '([unclosed', isRegex: true })], 'off');
    expect(d).toEqual({ visible: true, highlightColors: [] });
  });

  it('substring matching is case-sensitive and literal', () => {
    expect(matchLine('ERROR', [tag({ pattern: 'error' })], 'off').highlightColors).toEqual([]);
    expect(matchLine('a.c', [tag({ pattern: 'a.c', isRegex: false })], 'off').highlightColors).toEqual(['#ff0000']);
  });

  it('filter mode include shows only matching lines', () => {
    const tags = [tag({ pattern: 'ERROR' })];
    expect(matchLine('has ERROR', tags, 'include').visible).toBe(true);
    expect(matchLine('nothing here', tags, 'include').visible).toBe(false);
  });

  it('filter mode exclude hides matching lines', () => {
    const tags = [tag({ pattern: 'ERROR' })];
    expect(matchLine('has ERROR', tags, 'exclude').visible).toBe(false);
    expect(matchLine('nothing here', tags, 'exclude').visible).toBe(true);
  });

  it('disabled tags do not drive the filter either', () => {
    const tags = [tag({ pattern: 'ERROR', enabled: false })];
    expect(matchLine('has ERROR', tags, 'include').visible).toBe(false);
    expect(matchLine('has ERROR', tags, 'exclude').visible).toBe(true);
  });

  it('matchLines maps decisions per line', () => {
    const out = matchLines(['ERROR a', 'fine', 'ERROR b'], [tag({ pattern: 'ERROR' })], 'include');
    expect(out).toEqual([
      { visible: true, highlightColors: ['#ff0000'] },
      { visible: false, highlightColors: [] },
      { visible: true, highlightColors: ['#ff0000'] },
    ]);
  });

  it('empty tag list leaves everything unhighlighted', () => {
    expect(matchLines(['a', 'b'], [], 'include')).toEqual([
      { visible: false, highlightColors: [] },
      { visible: false, highlightColors: [] },
    ]);
  });
});
