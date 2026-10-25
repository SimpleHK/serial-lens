import { describe, expect, it } from 'vitest';

import { scrollReducer, ScrollAction, ScrollState } from '../src/shared/scrollState';

describe('scrollState (UI-state seam: scroll/action events → follow/locked)', () => {
  const act = (state: ScrollState, action: ScrollAction): ScrollState => scrollReducer(state, action);

  it('starts and stays in follow while the viewport is at the bottom', () => {
    expect(act('follow', { type: 'scrolled', atBottom: true })).toBe('follow');
  });

  it('scrolling up locks the viewport (Follow stops)', () => {
    expect(act('follow', { type: 'scrolled', atBottom: false })).toBe('locked');
  });

  it('scrolling back to the bottom resumes Follow', () => {
    expect(act('locked', { type: 'scrolled', atBottom: true })).toBe('follow');
  });

  it('manual toggle switches between follow and locked in both directions', () => {
    expect(act('follow', { type: 'toggle' })).toBe('locked');
    expect(act('locked', { type: 'toggle' })).toBe('follow');
  });

  it('reset returns to follow (new session, clear)', () => {
    expect(act('locked', { type: 'reset' })).toBe('follow');
  });

  it('lock state survives scroll events that do not change bottomness', () => {
    expect(act('locked', { type: 'scrolled', atBottom: false })).toBe('locked');
    expect(act('follow', { type: 'scrolled', atBottom: true })).toBe('follow');
  });
});
