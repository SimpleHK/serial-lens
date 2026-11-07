import { describe, it, expect, vi } from 'vitest';
import { handleHostMessage, HostRouterContext } from '../src/webview/hostRouter';
import { PaneSession } from '../src/webview/paneTypes';
import { HostToWebview } from '../src/shared/protocol';

/**
 * Node-speed tests for the host-message router (C3): with the DOM shell
 * injected as a context, each routing DECISION — which state changes, which
 * actions fire — is asserted directly instead of through the full happy-dom
 * webview bootstrap. The pendingReplace two-phase transitions (the restart
 * flow's most delicate logic) live here.
 */

const makeCtx = (over: Partial<HostRouterContext> = {}) => {
  const sessions: PaneSession[] = [];
  const calls = {
    posted: [] as unknown[],
    removed: [] as number[],
    created: [] as unknown[],
    status: [] as unknown[],
    refreshed: [] as number[],
    rebuilt: [] as number[],
    cleared: [] as number[],
    appended: [] as unknown[],
    styled: [] as number[],
    chips: 0,
    tagButton: 0,
    timestampsRendered: 0,
    scheduled: [] as number[],
  };
  const pending = { oldId: undefined as number | undefined, newId: undefined as number | undefined };
  const ctx: HostRouterContext = {
    sessions,
    logDirButtons: [],
    getFocusedId: () => undefined,
    getPendingReplace: () => ({ ...pending }),
    setPendingReplace: (oldId, newId) => {
      pending.oldId = oldId;
      pending.newId = newId;
    },
    setLastPorts: vi.fn(),
    setShowTimestamps: vi.fn(),
    setRecentBauds: vi.fn(),
    post: (m) => calls.posted.push(m),
    sessionFor: (id) => sessions.find((s) => s.id === id),
    focusedSession: () => sessions.find((s) => s.id === 7),
    rebuildPortOptions: (s) => calls.rebuilt.push(s.id),
    refreshPaneControls: (s) => calls.refreshed.push(s.id),
    updateTagButton: () => void calls.tagButton++,
    appendToSession: (s, entries, dropCount) => calls.appended.push({ id: s.id, entries, dropCount }),
    renderTimestampsControl: () => void calls.timestampsRendered++,
    recomputeOccurrences: vi.fn(),
    scheduleRender: (s) => calls.scheduled.push(s.id),
    setStatus: (message, target) => calls.status.push({ message, target: target?.id }),
    clearBuffer: (s) => calls.cleared.push(s.id),
    createSession: (m) => calls.created.push(m),
    removeSession: (id) => {
      calls.removed.push(id);
      const i = sessions.findIndex((s) => s.id === id);
      if (i !== -1) sessions.splice(i, 1);
    },
    restylePane: (s) => calls.styled.push(s.id),
    renderChips: () => void calls.chips++,
    ...over,
  };
  return { ctx, sessions, calls, pending };
};

let nextId = 1;
const makePane = (over: Partial<PaneSession> = {}): PaneSession => ({
  id: nextId++,
  kind: 'port',
  title: `COM${nextId}`,
  state: 'connected',
  lineEnding: 'LF',
  sendCollapsed: true,
  lineStore: [],
  decisions: [],
  visibleIndexes: [],
  scroll: 'follow',
  logDesired: false,
  tags: [],
  filterMode: 'off',
  marksDirty: false,
  sendHistory: [],
  sendIndex: 0,
  sendDraft: '',
  dom: {
    root: { style: {} } as unknown as HTMLDivElement,
  } as PaneSession['dom'],
  find: {
    open: false,
    query: '',
    matchCase: false,
    wholeWord: false,
    regex: false,
    error: false,
    occurrences: [],
    current: 0,
    byLine: new Map(),
    debounce: undefined,
  },
  ...over,
});

const fire = (ctx: HostRouterContext, m: HostToWebview) => handleHostMessage(ctx, m);

describe('hostRouter (routing decisions, node speed)', () => {
  it('ports: refreshes every PORT pane, skips file panes, re-derives the tag button', () => {
    const { ctx, sessions, calls } = makeCtx();
    sessions.push(makePane({ id: 1, kind: 'port' }), makePane({ id: 2, kind: 'file' }));
    fire(ctx, { type: 'ports', ports: [{ path: 'COM10' }] });
    expect(calls.rebuilt).toEqual([1]);
    expect(calls.refreshed).toEqual([1]);
    expect(calls.tagButton).toBe(1);
    expect(ctx.setLastPorts).toHaveBeenCalledWith([{ path: 'COM10' }]);
  });

  it('state connected completing a restart: closes the replaced pane and reveals the replacement', () => {
    const { ctx, sessions, calls, pending } = makeCtx();
    const oldPane = makePane({ id: 7 });
    const replacement = makePane({ id: 8 });
    sessions.push(replacement);
    ctx.setPendingReplace(7, 8);
    fire(ctx, { type: 'state', sessionId: 8, state: 'connected' });
    // The old HOST session is closed (releases the port), the old pane is
    // removed, the replacement is revealed, and the slots are cleared.
    expect(calls.posted).toContainEqual({ type: 'closeSession', sessionId: 7 });
    expect(calls.removed).toEqual([7]);
    expect(replacement.dom.root.style.display).toBe('');
    expect(pending).toEqual({ oldId: undefined, newId: undefined });
    expect(calls.refreshed).toEqual([8]);
  });

  it('state connected WITHOUT a pending restart touches no lifecycle', () => {
    const { ctx, sessions, calls } = makeCtx();
    const pane = makePane({ id: 5 });
    sessions.push(pane);
    fire(ctx, { type: 'state', sessionId: 5, state: 'connected' });
    expect(calls.posted).toEqual([]);
    expect(calls.removed).toEqual([]);
  });

  it('sessionCreated while a restart is in flight binds the new session id', () => {
    const { ctx, calls, pending } = makeCtx();
    ctx.setPendingReplace(7, undefined);
    fire(ctx, { type: 'sessionCreated', sessionId: 9, kind: 'port', title: 'COM10', state: 'connecting' });
    expect(pending).toEqual({ oldId: 7, newId: 9 });
    expect(calls.created).toHaveLength(1);
  });

  it('sessionFailed on the replacement: snaps the old picker back and clears the slots', () => {
    const { ctx, sessions, calls, pending } = makeCtx();
    const oldPane = makePane({ id: 7, title: 'COM10' });
    (oldPane.dom as { portSelect?: { value: string } }).portSelect = { value: 'COM11' };
    sessions.push(oldPane);
    ctx.setPendingReplace(7, 9);
    (ctx as { getFocusedId(): number | undefined }).getFocusedId = () => 9;
    fire(ctx, { type: 'sessionFailed', sessionId: 9, message: 'could not open' });
    expect((oldPane.dom as { portSelect: { value: string } }).portSelect.value).toBe('COM10');
    expect(pending).toEqual({ oldId: undefined, newId: undefined });
    expect(calls.removed).toEqual([9]);
    expect(calls.refreshed).toEqual([7]); // surviving panes re-derive control state
    // The failure surfaces on the surviving pane's hint, never dropped.
    expect(calls.status).toEqual([{ message: 'could not open', target: 7 }]);
  });

  it('sessionFailed for an unknown session still clears stuck pickers via refresh', () => {
    const { ctx, sessions, calls } = makeCtx();
    sessions.push(makePane({ id: 3 }));
    fire(ctx, { type: 'sessionFailed', sessionId: 99, message: 'gone' });
    expect(calls.refreshed).toEqual([3]);
  });

  it('append maps positional timestamps onto entries', () => {
    const { ctx, sessions, calls } = makeCtx();
    const pane = makePane({ id: 4 });
    sessions.push(pane);
    fire(ctx, { type: 'append', sessionId: 4, lines: ['a', 'b'], timestamps: [1, 2], dropCount: 0 });
    expect(calls.appended).toEqual([{ id: 4, entries: [{ text: 'a', ts: 1 }, { text: 'b', ts: 2 }], dropCount: 0 }]);
  });

  it('timestamps: flips the display flag and re-renders every pane', () => {
    const { ctx, sessions, calls } = makeCtx();
    const finder = makePane({ id: 6 });
    finder.find.open = true;
    sessions.push(makePane({ id: 5 }), finder);
    fire(ctx, { type: 'timestamps', enabled: true });
    expect(ctx.setShowTimestamps).toHaveBeenCalledWith(true);
    expect(calls.timestampsRendered).toBe(1);
    expect(calls.scheduled).toEqual([5, 6]);
    expect(sessions.every((s) => s.marksDirty)).toBe(true);
  });

  it('logging updates the session and restyles every log-dir button', () => {
    const { ctx, sessions, calls } = makeCtx();
    const btn = { classList: { toggle: vi.fn() }, title: '' } as unknown as HTMLButtonElement;
    const withButtons = makeCtx({ logDirButtons: [btn] });
    const pane = makePane({ id: 5 });
    withButtons.sessions.push(pane);
    fire(withButtons.ctx, {
      type: 'logging', sessionId: 5, active: true, desired: true, fileName: 'a.log', directory: 'D:/logs',
    });
    expect(pane.logDesired).toBe(true);
    expect(pane.logDirectory).toBe('D:/logs');
    expect(btn.classList.toggle).toHaveBeenCalledWith('logging', true);
    expect(btn.title).toContain('D:/logs');
    expect(calls.refreshed).toEqual([]); // withButtons has its own recorder
    expect(withButtons.calls.refreshed).toEqual([5]);
  });

  it('clear targets the focused port pane: host clear + local buffer drop', () => {
    const { ctx, sessions, calls } = makeCtx();
    const pane = makePane({ id: 7 });
    sessions.push(pane);
    fire(ctx, { type: 'clear' });
    expect(calls.posted).toEqual([{ type: 'clear', sessionId: 7 }]);
    expect(calls.cleared).toEqual([7]);
  });

  it('lineEnding applies to the port pane and its select', () => {
    const { ctx, sessions } = makeCtx();
    const pane = makePane({ id: 5 });
    (pane.dom as { leSel?: { value: string } }).leSel = { value: 'LF' };
    sessions.push(pane);
    fire(ctx, { type: 'lineEnding', sessionId: 5, value: 'CRLF' });
    expect(pane.lineEnding).toBe('CRLF');
    expect((pane.dom as { leSel: { value: string } }).leSel.value).toBe('CRLF');
  });

  it('tags sanitize, restyle the pane, and re-render chips', () => {
    const { ctx, sessions, calls } = makeCtx();
    const pane = makePane({ id: 5 });
    sessions.push(pane);
    fire(ctx, { type: 'tags', sessionId: 5, tags: [{ id: 'x', name: 'E', pattern: 'E', isRegex: false, color: '#ffffff', highlight: true, filter: true }] });
    expect(pane.tags).toHaveLength(1);
    expect(calls.styled).toEqual([5]);
    expect(calls.chips).toBe(1);
  });

  it('exportRequest answers with the buffered entries', () => {
    const { ctx, sessions, calls } = makeCtx();
    const pane = makePane({ id: 5, lineStore: [{ text: 'x' }] });
    sessions.push(pane);
    fire(ctx, { type: 'exportRequest', sessionId: 5 });
    expect(calls.posted).toEqual([{ type: 'exportData', sessionId: 5, entries: [{ text: 'x' }] }]);
  });

  it('unknown session ids are routed harmlessly (no throw, no actions)', () => {
    const { ctx, sessions, calls } = makeCtx();
    fire(ctx, { type: 'append', sessionId: 404, lines: ['x'], dropCount: 0 });
    fire(ctx, { type: 'state', sessionId: 404, state: 'connected' });
    expect(calls.appended).toEqual([]);
    expect(calls.posted).toEqual([]);
  });
});
