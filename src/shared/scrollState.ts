/**
 * UI-state seam: pure reducer from scroll/action events to the Follow/locked
 * display state (Scroll Lock). Data keeps flowing in both states; only the
 * viewport behaves differently. The webview consumes this; the host never
 * needs it.
 */
export type ScrollState = 'follow' | 'locked';

export type ScrollAction =
  | { type: 'scrolled'; atBottom: boolean }
  | { type: 'toggle' }
  | { type: 'reset' };

export function scrollReducer(state: ScrollState, action: ScrollAction): ScrollState {
  switch (action.type) {
    case 'scrolled':
      return action.atBottom ? 'follow' : 'locked';
    case 'toggle':
      return state === 'follow' ? 'locked' : 'follow';
    case 'reset':
      return 'follow';
  }
}
