import { HostToWebview, WebviewToHost } from '../shared/protocol';
import { sanitizeTags } from '../shared/tagList';
import { PaneSession } from './paneTypes';

/**
 * The host-message router (C3): every wire message lands here, and the
 * router's ONLY job is deciding — which state changes and which actions
 * fire for each message type. It owns no DOM and no module state; both are
 * injected as an explicit context, which makes routing decisions testable
 * at node speed with a recording fake (test/hostRouter.test.ts) instead of
 * the full happy-dom webview bootstrap. main.ts stays the DOM shell: it
 * builds the context around its own state and functions and binds this
 * function to `window` 'message'.
 */
export interface HostRouterContext {
  sessions: readonly PaneSession[];
  /** The log-dir buttons of every mounted bar; 'logging' restyles them all. */
  logDirButtons: Iterable<HTMLButtonElement>;
  getFocusedId(): number | undefined;
  getPendingReplace(): { oldId: number | undefined; newId: number | undefined };
  setPendingReplace(oldId: number | undefined, newId: number | undefined): void;
  setLastPorts(ports: { path: string; description?: string }[]): void;
  setShowTimestamps(enabled: boolean): void;
  setRecentBauds(values: number[]): void;
  post(msg: WebviewToHost): void;
  sessionFor(id: number): PaneSession | undefined;
  focusedSession(): PaneSession | undefined;
  rebuildPortOptions(s: PaneSession): void;
  refreshPaneControls(s: PaneSession): void;
  updateTagButton(): void;
  appendToSession(s: PaneSession, entries: { text: string; ts?: number }[], dropCount: number): void;
  renderTimestampsControl(): void;
  recomputeOccurrences(s: PaneSession): void;
  scheduleRender(s: PaneSession): void;
  setStatus(message?: string, target?: PaneSession): void;
  clearBuffer(s: PaneSession): void;
  createSession(m: Extract<HostToWebview, { type: 'sessionCreated' }>): void;
  removeSession(id: number): void;
  restylePane(s: PaneSession): void;
  renderChips(): void;
}

type Handler<K extends HostToWebview['type']> = (
  ctx: HostRouterContext,
  m: Extract<HostToWebview, { type: K }>,
) => void;

const handlers: { [K in HostToWebview['type']]?: Handler<K> } = {
  ports: (ctx, m) => {
    ctx.setLastPorts(m.ports);
    for (const s of ctx.sessions) {
      if (s.kind === 'port') {
        ctx.rebuildPortOptions(s);
        ctx.refreshPaneControls(s); // re-derive play/clear disabled state from the new port list
      }
    }
    ctx.updateTagButton();
  },

  state: (ctx, m) => {
    const s = ctx.sessionFor(m.sessionId);
    if (!s) {
      return;
    }
    s.state = m.state;
    s.message = m.message;
    const pending = ctx.getPendingReplace();
    if (m.state === 'connected' && pending.newId === m.sessionId && pending.oldId !== undefined) {
      // The pane's ▶ restart went live: close the pane it replaces and
      // reveal the replacement in the slot it occupied.
      const replacedId = pending.oldId;
      ctx.setPendingReplace(undefined, undefined);
      ctx.post({ type: 'closeSession', sessionId: replacedId });
      ctx.removeSession(replacedId);
      s.dom.root.style.display = '';
    }
    ctx.refreshPaneControls(s);
    if (s.id === ctx.getFocusedId()) {
      ctx.setStatus();
    }
  },

  append: (ctx, m) => {
    const s = ctx.sessionFor(m.sessionId);
    if (s) {
      ctx.appendToSession(s, m.lines.map((text: string, i: number) => ({ text, ts: m.timestamps?.[i] })), m.dropCount);
    }
  },

  timestamps: (ctx, m) => {
    ctx.setShowTimestamps(m.enabled);
    ctx.renderTimestampsControl();
    for (const s of ctx.sessions) {
      s.marksDirty = true;
      ctx.scheduleRender(s);
      if (s.find.open) {
        ctx.recomputeOccurrences(s);
      }
    }
  },

  logging: (ctx, m) => {
    const s = ctx.sessionFor(m.sessionId);
    if (!s) {
      return;
    }
    s.logDesired = Boolean(m.desired);
    s.logFile = m.fileName;
    s.logDirectory = m.directory;
    for (const btn of ctx.logDirButtons) {
      btn.classList.toggle('logging', Boolean(m.directory));
      btn.title = m.directory
        ? `Logging each session into ${m.directory} — right-click to clear`
        : 'Choose a log directory: every logged session writes a new .log file (right-click to clear)';
    }
    ctx.refreshPaneControls(s);
  },

  recentBauds: (ctx, m) => {
    ctx.setRecentBauds(m.values); // baud menus render from this when opened
  },

  exportRequest: (ctx, m) => {
    const s = ctx.sessionFor(m.sessionId);
    if (s) {
      ctx.post({ type: 'exportData', sessionId: s.id, entries: s.lineStore });
    }
  },

  status: (ctx, m) => {
    ctx.setStatus(m.message);
  },

  clear: (ctx) => {
    // API-triggered clear targets the focused pane; pane buttons send their
    // own message with a sessionId.
    const f = ctx.focusedSession();
    if (f) {
      if (f.kind === 'port') {
        ctx.post({ type: 'clear', sessionId: f.id });
      }
      ctx.clearBuffer(f);
    }
  },

  lineEnding: (ctx, m) => {
    // The public API set a line ending for the session it just started.
    const s = ctx.sessionFor(m.sessionId);
    if (s && s.kind === 'port') {
      s.lineEnding = m.value;
      if (s.dom.leSel) {
        s.dom.leSel.value = m.value;
      }
    }
  },

  tags: (ctx, m) => {
    const ts = ctx.sessions.find((x) => x.id === m.sessionId);
    if (ts) {
      ts.tags = sanitizeTags(m.tags);
      ctx.restylePane(ts);
      ctx.renderChips();
    }
  },

  sessionCreated: (ctx, m) => {
    const pending = ctx.getPendingReplace();
    if (pending.oldId !== undefined && pending.newId === undefined) {
      ctx.setPendingReplace(pending.oldId, m.sessionId); // bind the created session to the restart request
    }
    ctx.createSession(m);
  },

  sessionFailed: (ctx, m) => {
    const pending = ctx.getPendingReplace();
    if (pending.newId === m.sessionId) {
      // The restart's open failed: keep the old pane and its buffer, and
      // snap its picker back to the port it is actually still on.
      const old = pending.oldId !== undefined ? ctx.sessions.find((x) => x.id === pending.oldId) : undefined;
      if (old?.dom.portSelect) {
        old.dom.portSelect.value = old.title;
      }
      ctx.setPendingReplace(undefined, undefined);
    }
    const wasFocused = ctx.getFocusedId() === m.sessionId;
    ctx.removeSession(m.sessionId);
    // After ANY failure, re-derive every surviving pane's control state —
    // a picker disabled during a transient 'connecting' window must never
    // stay stuck once the failure is reported.
    for (const p of ctx.sessions) {
      if (p.kind === 'port') {
        ctx.refreshPaneControls(p);
      }
    }
    if (wasFocused || ctx.getFocusedId() === undefined) {
      // The failed session is gone; surface the reason on a SURVIVING
      // pane's content-area hint instead of dropping it.
      const target = ctx.focusedSession() ?? ctx.sessions.find((x) => x.kind === 'port');
      if (target) {
        ctx.setStatus(m.message, target);
      } else {
        const empty = ctx.sessions.find((x) => x.isEmpty);
        if (empty) {
          ctx.setStatus(m.message, empty); // the empty surface's hint carries it
        }
      }
    }
  },

  sessionClosed: (ctx, m) => {
    ctx.removeSession(m.sessionId);
  },
};

export function handleHostMessage(ctx: HostRouterContext, m: HostToWebview): void {
  const h = handlers[m.type] as ((ctx: HostRouterContext, m: HostToWebview) => void) | undefined;
  if (h) {
    h(ctx, m);
  }
}
