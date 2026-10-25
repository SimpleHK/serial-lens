import { describe, expect, it } from 'vitest';

import { matchLine, matchLines } from '../src/shared/tagMatching';
import { Tag } from '../src/shared/tag';

const tag = (over: Partial<Tag>): Tag => ({
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
    expect(d).toEqual({ visible: true, highlightColor: '#ff0000' });
  });

  it('does not highlight non-matching lines', () => {
    const d = matchLine('all good here', [tag({ pattern: 'ERROR' })], 'off');
    expect(d).toEqual({ visible: true, highlightColor: undefined });
  });

  it('supports regex mode', () => {
    const d = matchLine('temp=24.7C', [tag({ pattern: /temp=\d+(\.\d+)?C/.source, isRegex: true })], 'off');
    expect(d.highlightColor).toBe('#ff0000');
  });

  it('ignores disabled tags entirely', () => {
    const d = matchLine('has ERROR inside', [tag({ pattern: 'ERROR', enabled: false })], 'off');
    expect(d).toEqual({ visible: true, highlightColor: undefined });
  });

  it('first enabled matching tag wins (precedence by tag order)', () => {
    const tags = [
      tag({ name: 'later', pattern: 'ERROR', color: '#00ff00' }),
      tag({ name: 'earlier', pattern: 'ERR', color: '#0000ff' }),
    ];
    const d = matchLine('ERROR', tags, 'off');
    expect(d.highlightColor).toBe('#00ff00'); // earlier in the list wins, not the shorter pattern
  });

  it('treats an invalid regex as non-matching instead of throwing', () => {
    const d = matchLine('anything', [tag({ pattern: '([unclosed', isRegex: true })], 'off');
    expect(d).toEqual({ visible: true, highlightColor: undefined });
  });

  it('substring matching is case-sensitive and literal', () => {
    expect(matchLine('ERROR', [tag({ pattern: 'error' })], 'off').highlightColor).toBeUndefined();
    expect(matchLine('a.c', [tag({ pattern: 'a.c', isRegex: false })], 'off').highlightColor).toBe('#ff0000');
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
      { visible: true, highlightColor: '#ff0000' },
      { visible: false, highlightColor: undefined },
      { visible: true, highlightColor: '#ff0000' },
    ]);
  });

  it('empty tag list leaves everything visible and unhighlighted', () => {
    expect(matchLines(['a', 'b'], [], 'include')).toEqual([
      { visible: false, highlightColor: undefined },
      { visible: false, highlightColor: undefined },
    ]);
  });
});
